#!/usr/bin/env python3
"""Interactively bootstrap long-lived FxA/IP-Protection credentials.

Flow:
1) Pass Fastly challenge on accounts.firefox.com (POW + vision captcha)
2) Sign in with email/password
3) Read and submit the 6-digit email code interactively when requested
4) Exchange session -> OAuth access token (profile + vpn scopes)
5) Activate Guardian only when status explicitly reports not registered (404)
6) Fetch an initial ProxyPass, destroy the short-lived OAuth token, and save
   only the FxA session material required by refresh_tokens.py

Usage:
  . .venv/bin/activate
  python login_and_bootstrap.py --email you@example.com

The password and email verification code are read from the terminal. They are
not accepted through command-line options or environment variables.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import itertools
import json
import os
import re
import string
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import requests
from fxa.core import Session as FxSession, StretchedPassword
from fxa.oauth import Client as OAuthClient

from renewal_credentials import atomic_write_text, write_renewal_credentials
from refresh_state import record_refresh_state, refresh_lock
from refresh_tokens import (
    ProxyPassValidationError,
    ROTATE_BEFORE_SECONDS,
    _retry_after_seconds,
    bounded_fxa_api_client,
    guardian_request,
    validate_proxy_pass_jwt,
)

ROOT = Path(__file__).resolve().parent
TOKENS = ROOT / "tokens"
DATA = ROOT / "data"
LOGS = ROOT / "logs"
for p in (TOKENS, DATA, LOGS):
    p.mkdir(exist_ok=True)

# Progress channel for the Chrome extension's browser-login flow: the local
# bridge launches this script and polls the JSON heartbeat instead of reading
# the child's console output.
HEARTBEAT_FILE = TOKENS / "bootstrap_status.json"
CANCEL_EVENT_FILE = TOKENS / "bootstrap_cancel.event"
# Extension-driven mode: the popup collects email/password/captcha answers with
# Chrome's own IME (the console mangles CJK input) and the bridge writes them to
# this one-shot file; the answer is consumed and the file deleted immediately.
# Secrets live in memory only; nothing here touches argv, logs, or the console.
INPUT_FILE = TOKENS / "bootstrap_input.json"
INPUT_POLL_SECONDS = 0.3
INPUT_WAIT_CREDENTIALS_SECONDS = 90.0
INPUT_WAIT_SECONDS = 300.0
# Mozilla's confirmation mail can take minutes to arrive, so the code prompt
# waits far longer than the captcha prompt does.
CODE_WAIT_SECONDS = 900.0
HEARTBEAT_REFRESH_SECONDS = 5.0


class _Tee:
    """Mirror writes to a log file; the bridge runs this without a console.

    sys.stdout can be None in a windowless child, so every write is guarded and
    the original stream (when present) still receives the text.
    """

    def __init__(self, *streams: Any) -> None:
        self._streams = [s for s in streams if s is not None]

    def write(self, data: str) -> int:
        for stream in self._streams:
            try:
                stream.write(data)
            except Exception:
                pass
        return len(data)

    def flush(self) -> None:
        for stream in self._streams:
            try:
                stream.flush()
            except Exception:
                pass

    def isatty(self) -> bool:
        return False


def read_input_file() -> dict[str, Any] | None:
    try:
        data = json.loads(INPUT_FILE.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    try:
        INPUT_FILE.unlink()
    except OSError:
        pass
    return data if isinstance(data, dict) else None


def wait_for_popup_input(kind: str, detail: str, *, seq: int = 0, captcha_b64: str | None = None) -> str:
    """Wait until the popup submits the requested value; keep heartbeat fresh.

    kind is "credentials" (email+password dict), "email_code", or "captcha".
    Returns the value string; for credentials returns the whole payload dict.
    The heartbeat is refreshed on every cycle so the bridge never sees a stale
    window; captcha_b64 must be re-sent on every refresh or the popup would
    lose the image after the first heartbeat overwrite.
    """
    deadline = time.time() + (
        INPUT_WAIT_CREDENTIALS_SECONDS if kind == "credentials"
        else (CODE_WAIT_SECONDS if kind in {"email_code", "totp_code"} else INPUT_WAIT_SECONDS)
    )
    while time.time() < deadline:
        raise_if_cancelled()
        payload = read_input_file()
        if payload is not None:
            if kind == "credentials":
                if payload.get("kind") == "credentials":
                    email = str(payload.get("email") or "").strip()
                    password = str(payload.get("password") or "")
                    if email and password:
                        return {"email": email, "password": password}
            elif payload.get("kind") == kind and payload.get("seq") == seq:
                value = str(payload.get("value") or "").strip()
                if value:
                    return value
        write_heartbeat(
            "waiting" if kind != "credentials" else "starting",
            detail,
            need=(None if kind == "credentials" else kind),
            need_seq=(seq if kind != "credentials" else None),
            captcha_b64=(captcha_b64 if kind == "captcha" else None),
        )
        time.sleep(INPUT_POLL_SECONDS)
    raise RuntimeError(f"等待弹窗输入超时（{kind}）。")


def write_heartbeat(
    stage: str,
    detail: str = "",
    success: bool | None = None,
    *,
    keep_terminal: bool = False,
    need: str | None = None,
    need_seq: int | None = None,
    captcha_b64: str | None = None,
) -> None:
    """Publish sanitized progress; never write tokens or passwords here."""
    if keep_terminal:
        try:
            existing = json.loads(HEARTBEAT_FILE.read_text(encoding="utf-8"))
            if isinstance(existing, dict) and existing.get("stage") in {"done", "failed"}:
                return
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            pass
    payload = {
        "stage": stage,
        "detail": detail,
        "success": success,
        "need": need,
        "need_seq": need_seq,
        "captcha_b64": captcha_b64,
        "updated_at": time.time(),
    }
    try:
        atomic_write_text(HEARTBEAT_FILE, json.dumps(payload, ensure_ascii=False) + "\n")
    except OSError:
        pass


def raise_if_cancelled() -> None:
    """Consume the bridge's cancel request and abort the interactive flow."""
    try:
        CANCEL_EVENT_FILE.unlink()
    except FileNotFoundError:
        return
    except OSError:
        return
    write_heartbeat("failed", "登录已被用户取消。", False)
    raise RuntimeError("cancelled by user")


FX_CLIENT_ID = "5882386c6d801776"
SCOPES = "profile https://identity.mozilla.com/apps/vpn"
GUARDIAN = "https://vpn.mozilla.org"
ALPH = string.ascii_letters + string.digits


def safe_page_location(url: str) -> str:
    parsed = urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


def prompt_email_code() -> str:
    """Ask the extension popup for the 6-digit email verification code."""
    for attempt in range(3):
        code = wait_for_popup_input(
            "email_code",
            "请输入 Mozilla 发送到你邮箱的 6 位验证码。",
            seq=_CHALLENGE_SEQ["n"] + attempt + 1,
        )
        code = re.sub(r"\D", "", code)[:6]
        if len(code) == 6:
            _CHALLENGE_SEQ["n"] = _CHALLENGE_SEQ["n"] + attempt + 1
            return code
        write_heartbeat("waiting", "验证码必须是 6 位数字，请重新输入。")
    raise RuntimeError("no valid 6-digit email code was provided")


def cleanup_legacy_credential_cache(*, remove_browser_storage: bool = False) -> None:
    """Remove obsolete credentials without destroying pre-bootstrap recovery data."""
    legacy_files = (
        TOKENS / "fxa_token.txt",
        TOKENS / "session.json",
        TOKENS / "email_code.txt",
        DATA / "fxa_pending_code.json",
        DATA / "fxa_after_code.json",
        DATA / "fxa_logged_in.json",
        LOGS / "bootstrap_after_password.png",
        LOGS / "bootstrap_after_code.png",
    )
    if remove_browser_storage:
        # Old versions used this full browser storage dump as a credential
        # fallback.  Keep it until a new renewable session has been published
        # successfully, then remove it without ever reading it.
        legacy_files += (DATA / "ff_storage.json",)
    for path in legacy_files:
        try:
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            print(f"[!] could not remove obsolete private cache: {path.name}", file=sys.stderr)
    for path in TOKENS.glob(".bootstrap-captcha-*.jpg"):
        try:
            path.unlink()
        except OSError:
            pass


def solve_pow(base: str, target: str) -> str:
    target = target.lower()
    for a, b in itertools.product(ALPH, repeat=2):
        if hashlib.sha256((base + a + b).encode()).hexdigest() == target:
            return a + b
    raise RuntimeError("pow not found")


# Sequence number for popup challenges; each request must be answered with the
# matching seq so a stale captcha answer cannot be applied to a new image.
_CHALLENGE_SEQ = {"n": 0}
# The sign-in confirmation code entered on the accounts page is the same
# time-based code the auth server expects for the API session, so remembering it
# avoids asking the user for the identical code twice.
_LAST_EMAIL_CODE: str | None = None


def session_is_verified(session) -> bool | None:
    """Ask the auth server whether this session still needs confirmation.

    Returns True/False, or None when the probe itself failed (in which case the
    caller falls back to the flags in the login response).
    """
    try:
        status = session.apiclient.get("/session/status", auth=session._auth)
    except Exception as exc:
        print(f"[!] session/status probe failed ({type(exc).__name__})")
        return None
    if not isinstance(status, dict):
        return None
    details = status.get("details")
    if isinstance(details, dict) and isinstance(details.get("sessionVerified"), bool):
        return bool(details["sessionVerified"])
    if status.get("state") == "verified":
        return True
    return None


def _confirm_session_once(session, endpoint: str, code: str) -> None:
    session.apiclient.post(endpoint, {"code": code}, auth=session._auth)


def ensure_session_verified(session, session_json: dict) -> None:
    """Complete the extra step a login from a new device requires.

    Every login from an unrecognised browser produces a session that is not yet
    verified; OAuth authorization then fails with a ClientError ("Unverified
    session"). Mozilla mails a 6-digit code (or, with 2FA enabled, expects a TOTP
    code) that confirms the session via POST /session/verify_code.
    """
    state = session_is_verified(session)
    if state is True:
        print("[*] session already verified")
        return
    if state is None:
        flag = session_json.get("sessionVerified")
        if flag is None:
            flag = session_json.get("verified")
        if flag is True:
            return
    method = str(session_json.get("verificationMethod") or "")
    is_totp = method == "totp-2fa"
    endpoint = "/session/verify/totp" if is_totp else "/session/verify_code"
    print(f"[*] session needs confirmation (method={method or 'email-2fa'})")
    write_heartbeat("waiting", "Mozilla 要求确认本次登录，正在等待验证码…")

    # Reuse the code already typed on the accounts page when it applies: it is
    # the same time-based code, so asking for it twice would be pure friction.
    if not is_totp and _LAST_EMAIL_CODE:
        try:
            _confirm_session_once(session, endpoint, _LAST_EMAIL_CODE)
            if session_is_verified(session) is True:
                print("[*] session confirmed with the page code")
                write_heartbeat("waiting", "登录已确认，正在换取凭据…")
                return
        except Exception as exc:
            print(f"[!] page code rejected for the API session ({type(exc).__name__})")

    last_error: Exception | None = None
    for _ in range(3):
        _CHALLENGE_SEQ["n"] += 1
        code = wait_for_popup_input(
            "totp_code" if is_totp else "email_code",
            "请输入验证器应用中的 6 位动态验证码。" if is_totp
            else "Mozilla 要求确认本次登录：请输入发送到邮箱的 6 位验证码。",
            seq=_CHALLENGE_SEQ["n"],
        )
        code = re.sub(r"\D", "", code)[:6]
        if len(code) != 6:
            write_heartbeat("waiting", "验证码必须是 6 位数字，请重新输入。")
            continue
        try:
            _confirm_session_once(session, endpoint, code)
        except Exception as exc:
            last_error = exc
            print(f"[!] session confirmation rejected ({type(exc).__name__})")
            write_heartbeat("waiting", "验证码未通过，请重新输入。")
            continue
        if session_is_verified(session) is True:
            write_heartbeat("waiting", "登录已确认，正在换取凭据…")
            return
        last_error = RuntimeError("验证码已提交但会话仍未验证")
    raise RuntimeError(f"登录确认失败：{last_error or '验证码未通过'}")


def popup_captcha(img: bytes) -> str:
    """Show the Fastly captcha in the extension popup and wait for the answer."""
    _CHALLENGE_SEQ["n"] += 1
    seq = _CHALLENGE_SEQ["n"]
    b64 = base64.b64encode(img).decode()
    answer = wait_for_popup_input(
        "captcha",
        "请输入图片中的验证码字符。",
        seq=seq,
        captcha_b64=b64,
    )
    answer = re.sub(r"[^A-Za-z0-9]", "", answer)
    if not answer:
        raise RuntimeError("CAPTCHA answer cannot be empty")
    return answer


def vision_captcha(img: bytes) -> str:
    # 视觉模型 API 配置与供应商无关：VISION_API_BASE_URL / VISION_API_KEY /
    # VISION_MODEL。任何提供标准 /v1/chat/completions 接口（消息内容含
    # image_url）的视觉模型网关均可接入。未配置时走扩展弹窗人工识别。
    api_base = os.environ.get("VISION_API_BASE_URL", "").rstrip("/")
    api_key = os.environ.get("VISION_API_KEY")
    model = os.environ.get("VISION_MODEL")
    if not api_base or not api_key:
        return popup_captcha(img)
    if not model:
        raise RuntimeError("VISION_MODEL is required when using a vision API")
    b64 = base64.b64encode(img).decode()
    # 标准 chat/completions 视觉调用：/v1/chat/completions + image_url
    # 数据 URL。BASE_URL 兼容带或不带 /v1 前缀的两种网关写法。
    base = api_base.rstrip("/")
    endpoint = base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"
    r = requests.post(
        endpoint,
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "temperature": 0,
            "max_tokens": 32,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "Read CAPTCHA characters exactly. Return only characters, no spaces.",
                        },
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                        },
                    ],
                }
            ],
        },
        timeout=60,
    )
    if r.status_code != 200:
        detail = (r.text or "")[:200]
        raise RuntimeError(f"vision API returned HTTP {r.status_code}: {detail}")
    try:
        text = r.json()["choices"][0]["message"]["content"]
    except (KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"vision API returned an unexpected response: {r.text[:200]}") from exc
    return re.sub(r"[^A-Za-z0-9]", "", text.strip())


def pass_fastly_and_login(page, email: str, password: str) -> None:
    state = {"prefix": None, "ch": None}
    raise_if_cancelled()
    write_heartbeat("browser", "正在打开浏览器并通过网站人机检查…")

    def on_response(resp):
        if "fst-post-back" in resp.url:
            m = re.search(r"(/_fs-ch-[^/]+)", resp.url)
            if m:
                state["prefix"] = m.group(1)
            try:
                state["ch"] = resp.json()
            except Exception:
                pass

    page.on("response", on_response)
    # Fastly's edge intermittently answers a valid challenge POST with an
    # empty 400; a single attempt used to leave the login page unreachable
    # (the "entered password, nothing happens" report). Retry the whole
    # challenge cycle, re-showing the captcha when the edge asks again.
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            _pass_fastly_once(page, state, email)
            break
        except RuntimeError as exc:
            if "cancelled by user" in str(exc):
                raise
            last_error = exc
            print(f"[*] challenge attempt {attempt + 1} failed: {exc}; reloading")
            write_heartbeat("browser", "人机检查未通过，正在重试…")
            page.wait_for_timeout(2500)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
    else:
        raise RuntimeError(f"人机检查多次失败：{last_error}")

    page.reload(wait_until="domcontentloaded")
    page.wait_for_timeout(3000)
    raise_if_cancelled()
    write_heartbeat("waiting", "正在填写账号信息…")
    page.locator('input[name="email"], input[type="email"]').first.fill(email)
    page.locator('button[type="submit"]').first.click()
    page.wait_for_timeout(3000)
    raise_if_cancelled()
    page.locator('input[type="password"]').first.fill(password)
    page.locator('button[type="submit"]').first.click()
    page.wait_for_timeout(6000)
    print("[*] after password:", safe_page_location(page.url))


def _pass_fastly_once(page, state: dict, email: str) -> None:
    # A stale challenge token from the previous attempt guarantees an empty
    # 400 from the edge; only a fresh challenge from this page load is valid.
    state["ch"] = None
    state["prefix"] = None
    page.goto("https://accounts.firefox.com/", wait_until="domcontentloaded", timeout=120000)
    page.wait_for_timeout(3000)
    ch = state["ch"]
    for _ in range(8):
        if not ch:
            page.wait_for_timeout(500)
            ch = state["ch"]
        if not ch:
            break
        if ch.get("status") == "success":
            break
        answers = []
        captcha = None
        for c in ch.get("ch") or []:
            ty, data = c.get("ty"), c.get("data") or {}
            if ty == "pow":
                ans = solve_pow(data["base"], data["hash"])
                answers.append(
                    {
                        "ty": "pow",
                        "base": data["base"],
                        "answer": ans,
                        "hmac": data.get("hmac"),
                        "expires": data.get("expires"),
                    }
                )
            elif ty == "clientmetrics":
                answers.append({"ty": "clientmetrics", "client_data": "{}", "error_trace": None})
            elif ty == "captcha":
                captcha = data.get("image_b64")
        if captcha:
            raw = base64.b64decode(captcha.split(",", 1)[1])
            guess = vision_captcha(raw)
            print("[*] captcha answer obtained")
            answers.append({"ty": "captcha", "answer": guess})
        url = f"https://accounts.firefox.com{state['prefix']}/fst-post-back"
        r = page.request.post(
            url,
            data=json.dumps({"token": ch["tok"], "data": answers}),
            headers={"content-type": "application/json", "accept": "application/json"},
        )
        # The edge sometimes answers with an empty body or HTML challenge page;
        # a raw .json() there killed the whole login after the captcha step.
        try:
            res = r.json()
        except Exception:
            print(f"[*] challenge post {r.status} non-JSON ({(r.text() or '')[:120]!r})")
            raise RuntimeError(f"challenge post returned HTTP {r.status} with a non-JSON body")
        print("[*] challenge post", r.status, res.get("status"), [c.get("ty") for c in res.get("ch") or []])
        if res.get("status") == "success":
            break
        ch = res


def submit_email_code(page, code: str) -> None:
    code = re.sub(r"\D", "", code)[:6]
    if len(code) != 6:
        raise ValueError("code must be 6 digits")
    write_heartbeat("waiting", "正在提交邮件验证码…")
    filled = False
    for sel in [
        'input[name="code"]',
        'input[inputmode="numeric"]',
        'input[maxlength="6"]',
        'input[type="tel"]',
        'input[type="text"]',
    ]:
        if page.locator(sel).count() and page.locator(sel).first.is_visible():
            page.fill(sel, code)
            filled = True
            break
    if not filled and page.locator('input[maxlength="1"]').count() >= 6:
        for i, ch in enumerate(code):
            page.locator('input[maxlength="1"]').nth(i).fill(ch)
        filled = True
    if not filled:
        raise RuntimeError("cannot find code input; are we on signin_token_code page?")
    for sel in [
        'button[type="submit"]',
        'button:has-text("Confirm")',
        'button:has-text("Continue")',
        'button:has-text("Submit")',
    ]:
        if page.locator(sel).count() and page.locator(sel).first.is_visible():
            page.click(sel)
            break
    page.wait_for_timeout(8000)
    print("[*] after code:", safe_page_location(page.url))


def api_login_with_page(page, email: str, password: str) -> dict:
    # FxA API 反自动化：带浏览器/自动化 UA（如 Playwright 或 Firefox UA）的
    # account/* 请求会被 Fastly 边缘层以 406 拒绝；requests 默认 UA 可放行。
    # credentials/status 是低风险查询（无 UA 限制），但 account/login 要求
    # 请求携带浏览器会话 cookie（Fastly CAPTCHA 通过的凭证），因此从
    # Playwright context 复制 cookie 再走 requests，两者缺一不可。
    cookie_jar = {c["name"]: c["value"] for c in page.context.cookies()}
    hdrs = {
        "content-type": "application/json",
        "accept": "application/json",
    }
    cr = requests.post(
        "https://api.accounts.firefox.com/v1/account/credentials/status",
        data=json.dumps({"email": email}),
        headers=hdrs,
        cookies=cookie_jar,
        timeout=30,
    )
    print("[*] credentials/status", cr.status_code)
    salt = None
    if cr.status_code == 200:
        try:
            status_data = cr.json()
        except Exception as exc:
            raise RuntimeError("credentials/status returned invalid JSON") from exc
        salt = status_data.get("clientSalt") if isinstance(status_data, dict) else None
    if not salt:
        raise RuntimeError("credentials/status did not return a clientSalt; refusing stale fallback")
    sp = StretchedPassword(2, email, salt, password, None)
    lr = requests.post(
        "https://api.accounts.firefox.com/v1/account/login",
        data=json.dumps({"email": email, "authPW": sp.get_auth_pw_v2(), "reason": "login"}),
        headers={
            **hdrs,
            "origin": "https://accounts.firefox.com",
            "referer": "https://accounts.firefox.com/",
        },
        cookies=cookie_jar,
        timeout=30,
    )
    print("[*] account/login", lr.status_code)
    if lr.status_code != 200:
        # maybe already logged in via UI and session cookies exist; still need sessionToken
        raise RuntimeError(f"account/login failed: HTTP {lr.status_code}")
    data = lr.json()
    if not isinstance(data, dict):
        raise RuntimeError("account/login returned an invalid response")
    data.setdefault("email", email)
    return data


def persist_bootstrap_credentials(
    *,
    session_token: str,
    email: str,
    uid: str,
    proxy_pass: str,
    expires_at: float,
    http_status: int,
    token_dir: Path | None = None,
) -> None:
    """Publish a new renewable session without racing the refresh helper."""
    # Wait only at publication time.  The interactive browser flow does not
    # hold the lock, but any old helper must finish before this new session and
    # success state become visible.  The renewal credential record is one
    # atomic file; ProxyPass and refresh state are then published in order
    # while the same cross-process lock excludes every other writer.
    destination = TOKENS if token_dir is None else token_dir
    with refresh_lock(destination, blocking=True):
        write_renewal_credentials(
            destination,
            email=email,
            uid=uid,
            session_token=session_token,
        )
        atomic_write_text(destination / "proxy_pass.jwt", proxy_pass + "\n")
        # A successful interactive login supersedes proxy authorization
        # failures associated with the former session.  Remove only the
        # non-secret digest marker; a restarted TokenStore will then accept
        # the freshly bootstrapped pass even if Guardian reissued the same JWT.
        try:
            (destination / "rejected_proxy_pass.sha256").unlink()
        except FileNotFoundError:
            pass
        record_refresh_state(
            destination / "refresh_state.json",
            "success",
            http_status=http_status,
            proxy_pass_expires_at=expires_at,
        )
        for legacy_name in ("session_token.txt", "account_meta.json"):
            try:
                (destination / legacy_name).unlink()
            except FileNotFoundError:
                pass


def oauth_and_proxy_pass(session_json: dict) -> None:
    session_token = session_json.get("sessionToken") or ""
    email = session_json.get("email") or ""
    uid = session_json.get("uid") or ""
    if not email or not uid or not session_token:
        raise RuntimeError("account/login response is missing email, uid, or sessionToken")
    write_heartbeat("exchanging", "登录成功，正在换取 VPN 访问凭据…")
    server = "https://api.accounts.firefox.com/v1"
    apiclient = bounded_fxa_api_client(server)
    sp = StretchedPassword(1, email, None, "x", None)

    class DummyClient:
        def __init__(self):
            self.apiclient = apiclient
            self.server_url = server

    session = FxSession(
        DummyClient(),
        email,
        sp.v1,
        uid,
        session_token,
        verified=session_json.get("verified", True),
        auth_timestamp=int(time.time() * 1000),
    )
    # A login from a new browser always needs sign-in confirmation before the
    # session can be exchanged for an OAuth token.
    ensure_session_verified(session, session_json)
    access = None
    oauth_client = None
    last_err = None
    # Use the same current Firefox Desktop client as refresh_tokens.py so a
    # bootstrap success is meaningful for subsequent unattended renewal.
    for client_id in (FX_CLIENT_ID,):
        try:
            oauth_server = "https://oauth.accounts.firefox.com/v1"
            oauth = OAuthClient(client_id=client_id, server_url=oauth_server)
            oauth.apiclient = bounded_fxa_api_client(oauth_server)
            access = oauth.authorize_token(session, scope=SCOPES, client_id=client_id)
            oauth_client = oauth
            print(f"[+] oauth access granted via client {client_id}")
            break
        except Exception as e:
            last_err = e
            print(f"[!] oauth {client_id} failed ({type(e).__name__})")
    if not access:
        kind = type(last_err).__name__ if last_err is not None else "unknown error"
        raise RuntimeError(f"oauth failed ({kind})")

    try:
        headers = {
            "Authorization": f"Bearer {access}",
            "Accept": "application/json",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "User-Agent": "firefox-ip-protection-pool/1.0",
        }
        st = guardian_request("GET", "/api/v1/fpn/status", headers=headers, label="fpn/status")
        print("[*] fpn/status", f"HTTP {st.status_code}")
        if st.status_code == 401:
            raise RuntimeError("Guardian authentication rejected the OAuth token (HTTP 401)")
        if st.status_code == 403:
            raise RuntimeError("this Firefox Account is not eligible for IP Protection (HTTP 403)")
        if st.status_code == 429 or 500 <= st.status_code <= 599:
            retry_after = _retry_after_seconds(st.headers.get("Retry-After"))
            suffix = (
                f"; retry after {retry_after:g}s"
                if st.status_code == 429 and retry_after is not None
                else ""
            )
            raise RuntimeError(f"fpn/status failed: HTTP {st.status_code}{suffix}")
        if st.status_code == 404:
            ar = guardian_request("POST", "/api/v1/fpn/activate", headers=headers, label="fpn/activate")
            print("[*] fpn/activate", f"HTTP {ar.status_code}")
            if ar.status_code == 401:
                raise RuntimeError("Guardian authentication failed during activation (HTTP 401)")
            if ar.status_code == 403:
                raise RuntimeError("this Firefox Account is not eligible for activation (HTTP 403)")
            if not 200 <= ar.status_code < 300:
                retry_after = _retry_after_seconds(ar.headers.get("Retry-After"))
                suffix = (
                    f"; retry after {retry_after:g}s"
                    if ar.status_code == 429 and retry_after is not None
                    else ""
                )
                raise RuntimeError(f"fpn/activate failed: HTTP {ar.status_code}{suffix}")
        elif not 200 <= st.status_code < 300:
            raise RuntimeError(f"fpn/status failed: HTTP {st.status_code}")

        tr = guardian_request("GET", "/api/v1/fpn/token", headers=headers, label="fpn/token")
        print("[*] fpn/token", f"HTTP {tr.status_code}")
        if tr.status_code == 401:
            raise RuntimeError("Guardian authentication rejected the OAuth token (HTTP 401)")
        if tr.status_code == 403:
            raise RuntimeError("this Firefox Account is not eligible for a ProxyPass (HTTP 403)")
        if tr.status_code == 404:
            raise RuntimeError("Guardian registration is unavailable after activation (HTTP 404)")
        if not 200 <= tr.status_code < 300:
            retry_after = _retry_after_seconds(tr.headers.get("Retry-After"))
            suffix = (
                f"; retry after {retry_after:g}s"
                if tr.status_code == 429 and retry_after is not None
                else ""
            )
            raise RuntimeError(f"proxy pass failed: HTTP {tr.status_code}{suffix}")
        try:
            token_response = tr.json()
        except requests.exceptions.JSONDecodeError as exc:
            raise RuntimeError("fpn/token returned invalid JSON") from exc
        tok = token_response.get("token") if isinstance(token_response, dict) else None
        if not isinstance(tok, str) or not tok:
            raise RuntimeError("fpn/token response has no token field")
        try:
            claims = validate_proxy_pass_jwt(tok, min_ttl=ROTATE_BEFORE_SECONDS)
        except ProxyPassValidationError as exc:
            raise RuntimeError(f"rejected ProxyPass JWT: {exc}") from exc

        # Publish only the long-lived session inputs plus the initial,
        # replaceable ProxyPass cache.  The short-lived OAuth access token is
        # never written.  Publication also supersedes an old session's
        # persisted cooldown under the same lock used by the helper.
        persist_bootstrap_credentials(
            session_token=session_token,
            email=email,
            uid=uid,
            proxy_pass=tok,
            expires_at=float(claims["exp"]),
            http_status=tr.status_code,
        )
        print("[+] saved long-lived session credentials and initial ProxyPass")
    finally:
        if oauth_client is not None and access:
            try:
                oauth_client.destroy_token(access)
                print("[+] destroyed temporary OAuth access token")
            except Exception as exc:
                print(
                    f"[!] could not destroy temporary OAuth token ({type(exc).__name__}); it was not saved",
                    file=sys.stderr,
                )
            access = None


def main() -> int:
    global _LAST_EMAIL_CODE
    ap = argparse.ArgumentParser(
        description="Save the FxA session required for automatic ProxyPass renewal"
    )
    ap.add_argument("--email", help="Firefox Account email (extension mode prompts in the popup)")
    args = ap.parse_args()

    # Announce liveness as early as possible so the extension's status poll can
    # tell "flow is up, waiting for popup input" apart from a silently dead child.
    write_heartbeat("starting", "正在等待在扩展弹窗中提交账号信息…", keep_terminal=True)

    try:
        credentials = wait_for_popup_input("credentials", "请在扩展弹窗中填写邮箱和密码。")
    except RuntimeError as exc:
        print(f"[!] {exc}", file=sys.stderr)
        detail = "未在限定时间内提交账号信息，登录已退出。" if "超时" in str(exc) else str(exc)
        write_heartbeat("failed", detail, False, keep_terminal=True)
        return 2
    email = str(credentials.get("email") or "").strip()
    password = str(credentials.get("password") or "")
    if not email or not password:
        write_heartbeat("failed", "账号信息不完整，登录已退出。", False, keep_terminal=True)
        return 2

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(
            "[!] Playwright is required; install requirements-bootstrap.txt first",
            file=sys.stderr,
        )
        write_heartbeat("failed", "浏览器登录组件未安装，请重新运行 INSTALL-OR-REPAIR.cmd。", False, keep_terminal=True)
        return 2

    with sync_playwright() as p:
        # Headless on purpose: the popup is now the only UI, and a visible
        # browser window would fight Chrome for focus during the flow.
        browser = p.firefox.launch(headless=True)
        try:
            context = browser.new_context(viewport={"width": 1280, "height": 900}, locale="en-US")
            page = context.new_page()
            pass_fastly_and_login(page, email, password)

            if "signin_token_code" in page.url or "confirmation code" in page.inner_text("body").lower():
                code = prompt_email_code()
                submit_email_code(page, code)
                # The same time-based code confirms the API session later.
                _LAST_EMAIL_CODE = code

            try:
                session_json = api_login_with_page(page, email, password)
            except Exception as exc:
                print(f"[!] API login after verification failed ({type(exc).__name__})", file=sys.stderr)
                write_heartbeat("failed", "网站登录校验失败，请重试。", False, keep_terminal=True)
                return 4
        finally:
            password = ""
            browser.close()

    try:
        oauth_and_proxy_pass(session_json)
    except RuntimeError as exc:
        print(f"[!] bootstrap token exchange failed: {exc}", file=sys.stderr)
        write_heartbeat("failed", f"换取凭据失败：{exc}", False, keep_terminal=True)
        return 1
    except Exception as exc:
        print(f"[!] bootstrap token exchange failed ({type(exc).__name__})", file=sys.stderr)
        write_heartbeat("failed", f"换取凭据失败（{type(exc).__name__}）。", False, keep_terminal=True)
        return 1
    cleanup_legacy_credential_cache(remove_browser_storage=True)
    print("[*] bootstrap complete. Next:")
    print("    python refresh_tokens.py --force")
    print("    python ipp_pool.py token-status")
    print("    python ipp_pool.py run")
    write_heartbeat("done", "登录完成，凭据已保存，之后会自动续期。", True, keep_terminal=True)
    return 0


if __name__ == "__main__":
    # The bridge starts this without a console, so stdout can be None and a
    # failed login would otherwise leave no trace. Mirror everything into the
    # runtime log; the password never reaches it (it is only ever read from the
    # input file and never printed).
    _log_handle = None
    try:
        _log_path = ROOT.parent / "logs" / "bootstrap-login.log"
        _log_path.parent.mkdir(parents=True, exist_ok=True)
        if _log_path.exists() and _log_path.stat().st_size > 1024 * 1024:
            _log_path.write_text("", encoding="utf-8")
        _log_handle = open(_log_path, "a", encoding="utf-8", buffering=1)
        sys.stdout = _Tee(sys.stdout, _log_handle)
        sys.stderr = _Tee(sys.stderr, _log_handle)
        print(f"[*] bootstrap start {time.strftime('%Y-%m-%d %H:%M:%S')}")
    except OSError:
        _log_handle = None
    try:
        exit_code = main()
    except KeyboardInterrupt:
        write_heartbeat("failed", "登录已被用户取消。", False, keep_terminal=True)
        exit_code = 130
    except Exception as exc:
        print(f"[!] bootstrap failed ({type(exc).__name__})", file=sys.stderr)
        stage_detail = str(exc)
        if stage_detail == "cancelled by user":
            exit_code = 130
        else:
            # Mask anything that could resemble a token; keep the message readable.
            stage_detail = safe_tail(stage_detail, 200) or f"bootstrap failed ({type(exc).__name__})"
            write_heartbeat("failed", f"登录未完成：{stage_detail}", False, keep_terminal=True)
            exit_code = 1
    finally:
        if _log_handle is not None:
            try:
                sys.stdout = sys.__stdout__
                sys.stderr = sys.__stderr__
                _log_handle.close()
            except Exception:
                pass
    raise SystemExit(exit_code)
