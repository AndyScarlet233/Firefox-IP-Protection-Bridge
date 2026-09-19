#!/usr/bin/env python3
"""Native Messaging bridge for Chrome -> firefox-ip-protection-pool.

This bridge deliberately never sends Firefox Account secrets to the extension.
It only reports sanitized state and launches the local SOCKS5 listener.
"""
from __future__ import annotations

import json
import concurrent.futures
import os
import re
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

HOST_NAME = "org.firefox_ip_protection.chrome_bridge"
BRIDGE_VERSION = "0.9.1"
SOCKS_HOST = "127.0.0.1"
SOCKS_PORT = 1090
SCHEMA = "firefox-ip-protection-renewal-credentials-v1"
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")


def app_root() -> Path:
    # PyInstaller one-file executables keep sys.executable at the installed exe.
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


ROOT = app_root()
PROJECT_ROOT = ROOT.parent
UPSTREAM = ROOT / "firefox-ip-protection-pool"
SYSTEM_PYTHON_FILE = ROOT / "system_python.txt"
PACKAGES_DIR = ROOT / "packages"
LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
POOL_LOG = LOG_DIR / "ipp-pool.log"
EXITS_JSON = UPSTREAM / "export" / "exits.json"
LATENCY_CACHE_FILE = ROOT / "node-latency-cache.json"
# Long caches keep a browser restart from re-fetching the server list and
# re-probing every country before the tunnel can come up.
LOCATION_CACHE_SECONDS = 21600
LATENCY_CACHE_SECONDS = 21600
LATENCY_PROBE_TIMEOUT = 1.25
MAX_PROBE_NODES = 24
# Keep several ranked exits behind the aggregate listener. The pool rotates
# through them when the first exit is temporarily unhealthy instead of
# pinning every browser request to one stale backend.
MAX_FAST_BACKENDS = 5
SOCKS_PROBE_HOST = "example.com"
SOCKS_PROBE_PORT = 80
SOCKS_PROBE_TARGETS = (
    ("example.com", 80),
    ("www.mozilla.org", 443),
    ("www.cloudflare.com", 443),
)
SOCKS_PROBE_TIMEOUT = 4.0
# Token renewal can legitimately take up to the helper's 100-second budget
# before the pool creates its first listener.
STARTUP_TIMEOUT_SECONDS = 140.0
STATUS_PROBE_TTL_SECONDS = 5.0
# Local HTTP rotator (127.0.0.1:8080). The refresh helper routes its
# Mozilla calls through it while the tunnel is up, so Guardian's region
# check sees the eligible exit IP instead of the local network egress.
HTTP_ROTATOR_PORT = 8080
# Guardian 451 windows come and go within minutes; retry token-not-ready
# starts inside this budget (keeps the extension's 150s start timeout safe).
STARTUP_RETRY_DEADLINE_SECONDS = 115.0
STARTUP_RETRY_DELAY_SECONDS = 10.0
# A new attempt needs enough budget for one helper round trip to complete and
# log its result; otherwise it gets killed mid-flight and classification loses
# its evidence.
STARTUP_MIN_ATTEMPT_BUDGET_SECONDS = 30.0


def _create_kill_on_close_job_for_process(proc: subprocess.Popen[Any]):
    """Best-effort Windows Job Object: child dies automatically when this host exits."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
        JobObjectExtendedLimitInformation = 9

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_uint64), ("WriteOperationCount", ctypes.c_uint64),
                ("OtherOperationCount", ctypes.c_uint64), ("ReadTransferCount", ctypes.c_uint64),
                ("WriteTransferCount", ctypes.c_uint64), ("OtherTransferCount", ctypes.c_uint64),
            ]
        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]
        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
            kernel32.CloseHandle(job)
            return None
        process_handle = wintypes.HANDLE(int(proc._handle))
        if not kernel32.AssignProcessToJobObject(job, process_handle):
            kernel32.CloseHandle(job)
            return None
        return job
    except Exception:
        return None


def _close_job_handle(job) -> None:
    if os.name != "nt" or not job:
        return
    try:
        import ctypes
        ctypes.WinDLL("kernel32", use_last_error=True).CloseHandle(job)
    except Exception:
        pass


def system_python_path() -> Path:
    try:
        raw = SYSTEM_PYTHON_FILE.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise BridgeError("未记录系统 Python 路径，请重新运行 install.cmd。") from exc
    path = Path(raw)
    if not path.is_file():
        raise BridgeError("系统 Python 已被移动或卸载，请重新运行 install.cmd。")
    return path


def upstream_env() -> dict[str, str]:
    env = os.environ.copy()
    paths = [str(PACKAGES_DIR), str(UPSTREAM)]
    existing = env.get("PYTHONPATH", "").strip()
    if existing:
        paths.append(existing)
    env["PYTHONPATH"] = os.pathsep.join(paths)
    # Keep the VPN runtime isolated from arbitrary user-site packages while still
    # allowing our explicit runtime\packages directory through PYTHONPATH.
    env["PYTHONNOUSERSITE"] = "1"
    return env


class BridgeError(RuntimeError):
    pass


class PoolManager:
    def __init__(self) -> None:
        self.proc: subprocess.Popen[Any] | None = None
        self._job_handle = None
        self.country = "REC"
        self.resolved_country = ""
        self.lock = threading.RLock()
        # End-to-end SOCKS5 probes cost a full round trip through the tunnel.
        # Cache the verdict briefly so popup opens and post-start checks do not
        # repeat it back to back.
        self._last_probe_ok = False
        self._last_probe_ts = 0.0

    def prerequisites(self) -> None:
        if not UPSTREAM.joinpath("ipp_pool.py").is_file():
            raise BridgeError("未找到 firefox-ip-protection-pool；请重新运行 install.cmd。")
        if not PACKAGES_DIR.is_dir():
            raise BridgeError("未找到 VPN 运行依赖；请重新运行 install.cmd。")
        system_python_path()

    def run_tool(
        self,
        *args: str,
        timeout: float = 90,
        input_text: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        self.prerequisites()
        try:
            return subprocess.run(
                [str(system_python_path()), str(UPSTREAM / args[0]), *args[1:]],
                cwd=UPSTREAM,
                input=input_text,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=timeout,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                env=upstream_env(),
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise BridgeError("后台操作超时。") from exc
        except OSError as exc:
            raise BridgeError("无法启动本地后台程序。") from exc

    def sync(self) -> str:
        # --include-locked keeps rollout-locked countries in exits.json so the
        # region picker can offer them; _node_usable() decides what counts as
        # available.
        result = self.run_tool("ipp_pool.py", "sync", "--include-locked", timeout=90)
        if result.returncode != 0:
            raise BridgeError(safe_tail(result.stderr or result.stdout, 500) or "节点同步失败。")
        return safe_tail(result.stdout, 800)

    def _load_exit_nodes(self) -> list[dict[str, Any]]:
        try:
            raw = json.loads(EXITS_JSON.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BridgeError("无法读取可用地区列表。") from exc
        if not isinstance(raw, list):
            raise BridgeError("可用地区列表格式无效。")
        return [node for node in raw if isinstance(node, dict)]

    @staticmethod
    def _node_usable(node: dict[str, Any]) -> bool:
        # `locked` is Mozilla's gradual-rollout flag, not a technical outage:
        # locked exits use the same Fastly MASQUE infrastructure and the same
        # per-account JWT as unlocked ones, so expose them as available too.
        # Quarantined servers are real removals and stay excluded.
        return (
            not bool(node.get("quarantined"))
            and bool(node.get("supported", True))
            and str(node.get("protocol") or "connect").lower() == "connect"
            and bool(str(node.get("hostname") or "").strip())
        )

    def _read_latency_cache(self) -> dict[str, dict[str, float]]:
        try:
            data = json.loads(LATENCY_CACHE_FILE.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return {}
        if not isinstance(data, dict):
            return {}
        clean: dict[str, dict[str, float]] = {}
        for key, value in data.items():
            if not isinstance(value, dict):
                continue
            try:
                ts = float(value.get("ts") or 0)
                ms = float(value.get("ms"))
            except (TypeError, ValueError):
                continue
            if ts > 0 and ms >= 0:
                clean[str(key)] = {"ts": ts, "ms": ms}
        return clean

    def _write_latency_cache(self, cache: dict[str, dict[str, float]]) -> None:
        try:
            LATENCY_CACHE_FILE.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        except OSError:
            pass

    @staticmethod
    def _node_key(node: dict[str, Any]) -> str:
        host = str(node.get("hostname") or "").strip().lower()
        try:
            port = int(node.get("port") or 443)
        except (TypeError, ValueError):
            port = 443
        return f"{host}:{port}"

    @staticmethod
    def _probe_node_latency(node: dict[str, Any]) -> float:
        host = str(node.get("hostname") or "").strip()
        try:
            port = int(node.get("port") or 443)
        except (TypeError, ValueError):
            return 999999.0
        started = time.perf_counter()
        try:
            with socket.create_connection((host, port), timeout=LATENCY_PROBE_TIMEOUT) as sock:
                try:
                    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                except OSError:
                    pass
            return (time.perf_counter() - started) * 1000.0
        except OSError:
            return 999999.0

    def _rank_nodes(self, country: str, nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        candidates = [
            node for node in nodes
            if self._node_usable(node) and str(node.get("country") or "").upper() == country
        ]
        # One hostname can appear more than once in Remote Settings; only benchmark it once.
        unique: dict[str, dict[str, Any]] = {}
        for node in candidates:
            unique.setdefault(self._node_key(node), node)
        candidates = list(unique.values())
        if not candidates:
            return []

        # Cap first-run probe fan-out, while keeping deterministic coverage of the list.
        candidates.sort(key=lambda n: self._node_key(n))
        if len(candidates) > MAX_PROBE_NODES:
            step = len(candidates) / MAX_PROBE_NODES
            candidates = [candidates[min(len(candidates) - 1, int(i * step))] for i in range(MAX_PROBE_NODES)]

        now = time.time()
        cache = self._read_latency_cache()
        missing: list[dict[str, Any]] = []
        scores: dict[str, float] = {}
        for node in candidates:
            key = self._node_key(node)
            cached = cache.get(key)
            if cached and now - float(cached.get("ts") or 0) < LATENCY_CACHE_SECONDS:
                scores[key] = float(cached.get("ms") or 999999.0)
            else:
                missing.append(node)

        if missing:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(16, len(missing))) as executor:
                future_map = {executor.submit(self._probe_node_latency, node): node for node in missing}
                for future, node in [(future, future_map[future]) for future in future_map]:
                    key = self._node_key(node)
                    try:
                        ms = float(future.result(timeout=LATENCY_PROBE_TIMEOUT + 1.0))
                    except Exception:
                        ms = 999999.0
                    scores[key] = ms
                    cache[key] = {"ts": now, "ms": ms}
            self._write_latency_cache(cache)

        return sorted(candidates, key=lambda node: (scores.get(self._node_key(node), 999999.0), self._node_key(node)))

    def _choose_recommended_country(self, nodes: list[dict[str, Any]]) -> str:
        by_country: dict[str, list[dict[str, Any]]] = {}
        for node in nodes:
            if not self._node_usable(node):
                continue
            code = str(node.get("country") or "").upper()
            if COUNTRY_RE.fullmatch(code) and code != "REC":
                by_country.setdefault(code, []).append(node)
        if not by_country:
            raise BridgeError("当前没有可用的 Firefox IP 保护地区，请稍后再试。")

        # Probe one representative per country in parallel. Cached samples make subsequent starts instant.
        reps = [sorted(group, key=lambda n: self._node_key(n))[0] for group in by_country.values()]
        now = time.time()
        cache = self._read_latency_cache()
        scores: dict[str, float] = {}
        missing: list[dict[str, Any]] = []
        for node in reps:
            key = self._node_key(node)
            cached = cache.get(key)
            if cached and now - float(cached.get("ts") or 0) < LATENCY_CACHE_SECONDS:
                scores[key] = float(cached.get("ms") or 999999.0)
            else:
                missing.append(node)
        if missing:
            with concurrent.futures.ThreadPoolExecutor(max_workers=min(24, len(missing))) as executor:
                futures = {executor.submit(self._probe_node_latency, node): node for node in missing}
                for future, node in [(future, futures[future]) for future in futures]:
                    key = self._node_key(node)
                    try:
                        ms = float(future.result(timeout=LATENCY_PROBE_TIMEOUT + 1.0))
                    except Exception:
                        ms = 999999.0
                    scores[key] = ms
                    cache[key] = {"ts": now, "ms": ms}
            self._write_latency_cache(cache)
        ranked = sorted(reps, key=lambda node: (scores.get(self._node_key(node), 999999.0), str(node.get("country") or "")))
        best = ranked[0]
        if scores.get(self._node_key(best), 999999.0) >= 999999.0:
            # Network probing may be blocked; fall back to the country with the largest healthy pool.
            return max(by_country, key=lambda code: len(by_country[code]))
        return str(best.get("country") or "").upper()

    def locations(self, force: bool = False) -> list[dict[str, Any]]:
        self.prerequisites()
        try:
            stale = force or not EXITS_JSON.is_file() or (time.time() - EXITS_JSON.stat().st_mtime > LOCATION_CACHE_SECONDS)
        except OSError:
            stale = True
        if stale:
            self.sync()
        raw = self._load_exit_nodes()
        grouped: dict[str, dict[str, Any]] = {}
        for node in raw:
            code = str(node.get("country") or "").upper()
            if not COUNTRY_RE.fullmatch(code) or code == "REC":
                continue
            entry = grouped.setdefault(code, {"code": code, "name": str(node.get("country_name") or code), "count": 0, "available": False})
            usable = self._node_usable(node)
            if usable:
                entry["count"] += 1
                entry["available"] = True
        return sorted(grouped.values(), key=lambda item: (not item["available"], item["code"]))

    def _resolve_country(self, requested: str) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
        locations = self.locations(force=False)
        nodes = self._load_exit_nodes()
        available = [item for item in locations if item.get("available") and int(item.get("count") or 0) > 0]
        if not available:
            raise BridgeError("当前没有可用的 Firefox IP 保护地区，请稍后再试。")
        resolved = self._choose_recommended_country(nodes) if requested == "REC" else requested
        if not any(item.get("code") == resolved for item in available):
            raise BridgeError(f"{resolved} 当前没有可用节点，请选择标记为可用的地区。")
        ranked = self._rank_nodes(resolved, nodes)
        if not ranked:
            raise BridgeError("所选地区当前没有可用节点，请换一个地区。")
        return resolved, locations, ranked

    @staticmethod
    def _credential_values_valid(email: Any, uid: Any, session_token: Any) -> bool:
        return (
            isinstance(email, str)
            and len(email) <= 320
            and re.fullmatch(r"[^\s@]+@[^\s@]+", email) is not None
            and isinstance(uid, str)
            and 0 < len(uid) <= 256
            and not any(ch.isspace() for ch in uid)
            and isinstance(session_token, str)
            and 0 < len(session_token) <= 4096
            and not any(ch.isspace() for ch in session_token)
        )

    def credentials_present(self) -> bool:
        """Return true only when refresh_tokens.py can load a real credential bundle."""
        tokens = UPSTREAM / "tokens"
        if not tokens.is_dir():
            return False
        canonical = tokens / "renewal_credentials.json"
        if canonical.is_file():
            try:
                if canonical.stat().st_size > 16 * 1024:
                    return False
                data = json.loads(canonical.read_text(encoding="utf-8"))
                return (
                    isinstance(data, dict)
                    and data.get("schema") == 1
                    and self._credential_values_valid(
                        data.get("email"), data.get("uid"), data.get("session_token")
                    )
                )
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                return False

        metadata_path = tokens / "account_meta.json"
        session_path = tokens / "session_token.txt"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            session_token = session_path.read_text(encoding="utf-8").strip()
            return (
                isinstance(metadata, dict)
                and self._credential_values_valid(
                    metadata.get("email"), metadata.get("uid"), session_token
                )
            )
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return False

    def start(self, country: str) -> dict[str, Any]:
        with self.lock:
            self.prerequisites()
            country = normalize_country(country)
            self.stop()
            if port_open(SOCKS_HOST, SOCKS_PORT):
                raise BridgeError("本地 SOCKS5 端口 1090 已被其他程序占用，请关闭冲突的代理后重试。")
            # The server list is cached by locations(); avoid a forced network sync on every toggle.
            self.locations(force=False)

            if not self.credentials_present():
                raise BridgeError("尚未导入 Firefox 登录凭据。请先点击“从 Firefox 导入”。")

            resolved_country, _, ranked_nodes = self._resolve_country(country)
            preferred_hosts = [str(node.get("hostname") or "").strip().lower() for node in ranked_nodes[:MAX_FAST_BACKENDS]]
            cmd = [
                str(system_python_path()),
                str(UPSTREAM / "ipp_pool.py"),
                "run",
                "--rotator", f"{SOCKS_HOST}:{SOCKS_PORT}",
                "--http-rotator", f"{SOCKS_HOST}:{HTTP_ROTATOR_PORT}",
                "--rotate-mode", "rr",
                "--countries", resolved_country,
                "--limit", str(MAX_FAST_BACKENDS),
                "--no-http",
                "--include-locked",
            ]
            child_env = upstream_env()
            child_env["IPP_PREFERRED_HOSTS"] = ",".join(preferred_hosts)
            # The pool's stdout is redirected to a file; without this the
            # child block-buffers its output and a killed attempt loses the
            # "[!] token not ready" lines that failure classification needs.
            child_env["PYTHONUNBUFFERED"] = "1"
            # Do not set IPP_STICKY_PRIMARY here. The aggregate rotator must
            # advance to the next ranked exit after a transient backend error;
            # pinning the first three exits makes a single bad rollout look
            # like a dead local proxy.

            POOL_LOG.parent.mkdir(parents=True, exist_ok=True)
            # A Guardian 451 means the current network egress is temporarily
            # ineligible; those windows come and go within minutes. Retry the
            # bootstrap inside a time budget instead of failing after one hit.
            retry_deadline = time.monotonic() + STARTUP_RETRY_DEADLINE_SECONDS
            attempt = 0
            # Cumulative classification evidence across attempts: the final
            # attempt can be killed mid-flight with an empty log, so the last
            # snapshot alone must not decide the reported failure reason.
            restricted_seen = False
            token_not_ready_seen = False
            while True:
                attempt += 1
                try:
                    POOL_LOG.write_text("", encoding="utf-8")
                except OSError:
                    pass
                log_handle = open(POOL_LOG, "a", encoding="utf-8", buffering=1)
                try:
                    self.proc = subprocess.Popen(
                        cmd,
                        cwd=UPSTREAM,
                        stdin=subprocess.DEVNULL,
                        stdout=log_handle,
                        stderr=subprocess.STDOUT,
                        text=True,
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                        env=child_env,
                    )
                    self._job_handle = _create_kill_on_close_job_for_process(self.proc)
                except OSError as exc:
                    log_handle.close()
                    self.proc = None
                    raise BridgeError("无法启动 Firefox IP 保护本地代理。") from exc
                finally:
                    try:
                        log_handle.close()
                    except Exception:
                        pass

                self.country = country
                self.resolved_country = resolved_country
                wait_timeout = STARTUP_TIMEOUT_SECONDS if attempt == 1 else max(
                    1.0, min(STARTUP_TIMEOUT_SECONDS, retry_deadline - time.monotonic())
                )
                if wait_for_port(SOCKS_HOST, SOCKS_PORT, self.proc, timeout=wait_timeout):
                    break

                code = self.proc.poll() if self.proc else None
                tail = read_log_tail(POOL_LOG, 900)
                self.stop()
                lowered = tail.lower()
                if "no listeners started" in lowered or "exported 0 nodes" in lowered:
                    raise BridgeError("所选地区当前没有可用节点，请换一个地区。")

                state_result, state_status, state_retry_at = refresh_state_summary()
                restricted_seen = restricted_seen or bool(
                    state_status == 451
                    or state_result == "service_restricted"
                    or "http 451" in lowered
                    or "http=451" in lowered
                    or "service_restricted" in lowered
                )
                token_not_ready_seen = token_not_ready_seen or bool(
                    "token not ready" in lowered
                    or "backoff" in lowered
                    or restricted_seen
                    or state_result in {"service_restricted", "transient_error", "protocol_error", "rate_limited"}
                )
                remaining_budget = retry_deadline - time.monotonic()
                # A persisted cooldown longer than the remaining budget makes
                # further retries pure waiting; likewise a new attempt needs a
                # minimum budget or it will be killed before producing evidence.
                cooldown_fits = not isinstance(state_retry_at, float) or (
                    state_retry_at - time.time() <= remaining_budget
                )
                can_retry = (
                    token_not_ready_seen
                    and remaining_budget >= STARTUP_MIN_ATTEMPT_BUDGET_SECONDS
                    and cooldown_fits
                )
                if can_retry:
                    time.sleep(min(STARTUP_RETRY_DELAY_SECONDS, max(0.0, remaining_budget)))
                    if port_open(SOCKS_HOST, SOCKS_PORT):
                        raise BridgeError("本地 SOCKS5 端口 1090 已被其他程序占用，请关闭冲突的代理后重试。")
                    continue
                if restricted_seen:
                    raise BridgeError(
                        "Mozilla 拒绝了当前网络出口的令牌请求（HTTP 451，与账户无关）。"
                        "通常是当前网络出口暂时不在支持地区：请稍后重试；隧道建立后续期会自动改走出口。"
                        "如反复出现，可将可用的 HTTP 代理写入 runtime 的 tokens/refresh_proxy.txt。"
                    )
                if token_not_ready_seen:
                    raise BridgeError(
                        "Mozilla 凭据刷新暂时失败（网络出口不可达或处于冷却期）。请稍后重试；"
                        "如反复出现，请检查本机网络，或将可用的 HTTP 代理写入 runtime 的 tokens/refresh_proxy.txt。"
                    )
                if code is not None:
                    raise BridgeError(f"代理进程提前退出（code {code}）。请刷新地区列表后重试。")
                raise BridgeError("本地 SOCKS5 代理未能完成上游连接，请稍后重试。")

            # wait_for_port() already completed a successful end-to-end probe;
            # let the cached verdict satisfy the immediate status check.
            self._last_probe_ok = True
            self._last_probe_ts = time.time()

            return {
                "running": True, "country": country, "resolvedCountry": resolved_country, "port": SOCKS_PORT,
                "preferredHost": preferred_hosts[0] if preferred_hosts else "",
                "backendCount": min(MAX_FAST_BACKENDS, len(ranked_nodes)),
            }

    def stop(self) -> None:
        with self.lock:
            proc = self.proc
            job = self._job_handle
            self.proc = None
            self._job_handle = None
            try:
                if proc and proc.poll() is None:
                    try:
                        proc.terminate()
                        proc.wait(timeout=6)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        try:
                            proc.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            pass
                    except OSError:
                        pass
            finally:
                _close_job_handle(job)
                self._last_probe_ok = False
                self._last_probe_ts = 0.0

    def status(self) -> dict[str, Any]:
        with self.lock:
            port_is_open = port_open(SOCKS_HOST, SOCKS_PORT)
            running = bool(self.proc and self.proc.poll() is None and port_is_open)
            healthy = False
            if running:
                now = time.time()
                if now - self._last_probe_ts >= STATUS_PROBE_TTL_SECONDS:
                    try:
                        socks5_connect_probe_any(SOCKS_HOST, SOCKS_PORT)
                        self._last_probe_ok = True
                    except OSError:
                        self._last_probe_ok = False
                    self._last_probe_ts = now
                healthy = self._last_probe_ok
            else:
                self._last_probe_ok = False
                self._last_probe_ts = 0.0
            return {
                "available": UPSTREAM.joinpath("ipp_pool.py").is_file() and PACKAGES_DIR.is_dir() and SYSTEM_PYTHON_FILE.is_file(),
                "running": running,
                "healthy": healthy,
                "portOpen": port_is_open,
                "credentials": self.credentials_present(),
                "country": self.country,
                "resolvedCountry": self.resolved_country,
                "port": SOCKS_PORT,
                "installRoot": str(PROJECT_ROOT),
                "bridgeVersion": BRIDGE_VERSION,
            }

    def usage(self) -> str:
        result = self.run_tool("ipp_pool.py", "usage", timeout=85)
        text = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
        if result.returncode != 0:
            raise BridgeError(safe_tail(text, 700) or "配额查询失败。")
        return sanitize_usage(text)

    def import_firefox(self) -> str:
        profile, account = find_firefox_account()
        bundle = {
            "schema": SCHEMA,
            "email": account["email"],
            "uid": account["uid"].lower(),
            "session_token": account["sessionToken"].lower(),
        }
        payload = json.dumps(bundle, separators=(",", ":"))
        result = self.run_tool("import_credentials.py", "-", timeout=130, input_text=payload)
        if result.returncode != 0:
            detail = safe_tail(result.stderr or result.stdout, 650)
            raise BridgeError(detail or "Firefox 凭据导入或 ProxyPass 验证失败。")
        return f"已从 Firefox 配置 {profile.name} 导入：{mask_email(account['email'])}"


manager = PoolManager()



def _ps_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def prepare_cleanup(mode: str) -> str:
    if os.name != "nt":
        raise BridgeError("自动清理目前仅支持 Windows。")
    if mode not in {"local", "full"}:
        raise BridgeError("清理模式无效。")

    manager.stop()
    token = uuid.uuid4().hex
    temp_dir = Path(tempfile.gettempdir())
    script_path = temp_dir / f"ffip-cleanup-{token}.ps1"
    cancel_path = temp_dir / f"ffip-cleanup-{token}.cancel"
    target = ROOT if mode == "local" else PROJECT_ROOT
    reg_key = rf"HKCU\Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}"

    lines = [
        '$ErrorActionPreference = "SilentlyContinue"',
        'Start-Sleep -Seconds 7',
        f'$cancel = {_ps_quote(str(cancel_path))}',
        'if (Test-Path -LiteralPath $cancel) {',
        '  Remove-Item -LiteralPath $cancel -Force',
        '  Remove-Item -LiteralPath $PSCommandPath -Force',
        '  exit 0',
        '}',
        f'& reg.exe delete {_ps_quote(reg_key)} /f | Out-Null',
        f'$target = {_ps_quote(str(target))}',
        'for ($i = 0; $i -lt 12; $i++) {',
        '  if (-not (Test-Path -LiteralPath $target)) { break }',
        '  Remove-Item -LiteralPath $target -Recurse -Force',
        '  if (-not (Test-Path -LiteralPath $target)) { break }',
        '  Start-Sleep -Milliseconds 750',
        '}',
        'Remove-Item -LiteralPath $PSCommandPath -Force',
    ]
    script_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0)
    try:
        subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script_path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
            close_fds=True,
        )
    except OSError as exc:
        try:
            script_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise BridgeError("无法启动本地清理程序。") from exc
    return token


def cancel_cleanup(token: Any) -> None:
    token = str(token or "")
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        raise BridgeError("清理令牌无效。")
    cancel_path = Path(tempfile.gettempdir()) / f"ffip-cleanup-{token}.cancel"
    cancel_path.write_text("cancel", encoding="ascii")


def open_install_folder() -> None:
    if os.name != "nt":
        raise BridgeError("打开文件夹目前仅支持 Windows。")
    try:
        subprocess.Popen(
            ["explorer.exe", str(PROJECT_ROOT)],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        raise BridgeError("无法打开安装文件夹。") from exc

def normalize_country(value: Any) -> str:
    value = str(value or "REC").strip().upper()
    if value == "REC":
        return value
    if not COUNTRY_RE.fullmatch(value):
        raise BridgeError("位置代码无效。")
    return value


def firefox_profiles_root() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise BridgeError("无法定位 Windows Firefox 配置目录。")
    return Path(appdata) / "Mozilla" / "Firefox" / "Profiles"


def validate_account(obj: Any) -> dict[str, Any] | None:
    if not isinstance(obj, dict) or obj.get("version") != 1:
        return None
    account = obj.get("accountData")
    if not isinstance(account, dict) or account.get("verified") is not True:
        return None
    email = account.get("email")
    uid = account.get("uid")
    token = account.get("sessionToken")
    device = account.get("device")
    if not isinstance(email, str) or len(email) > 320 or not re.fullmatch(r"[^\s@]+@[^\s@]+", email):
        return None
    if not isinstance(uid, str) or not re.fullmatch(r"[0-9a-fA-F]{32}", uid):
        return None
    if not isinstance(token, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", token):
        return None
    if not isinstance(device, dict) or not isinstance(device.get("id"), str) or len(device["id"]) < 16:
        return None
    return account


def find_firefox_account() -> tuple[Path, dict[str, Any]]:
    root = firefox_profiles_root()
    if not root.is_dir():
        raise BridgeError("没有找到 Firefox Profiles。请先安装并登录桌面 Firefox。")

    candidates: list[tuple[float, Path, dict[str, Any]]] = []
    for profile in root.iterdir():
        signed = profile / "signedInUser.json"
        if not signed.is_file():
            continue
        try:
            if signed.stat().st_size > 1024 * 1024:
                continue
            data = json.loads(signed.read_text(encoding="utf-8"))
            account = validate_account(data)
            if account:
                candidates.append((signed.stat().st_mtime, profile, account))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue

    if not candidates:
        raise BridgeError(
            "未找到可续期的 Firefox 登录状态。请在 Firefox 登录 Mozilla 账户、完成 VPN 首次启用后再试。"
        )

    # Prefer the most recently touched verified profile; never return the token to Chrome.
    _, profile, account = max(candidates, key=lambda item: item[0])
    return profile, account


def mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    if len(local) <= 2:
        local = local[:1] + "*"
    else:
        local = local[0] + "*" * min(5, len(local) - 2) + local[-1]
    return f"{local}@{domain}"


def _format_quota_bytes(value: object) -> str:
    try:
        amount = max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return "未知"
    if amount >= 1_000_000_000:
        return f"{amount / 1_000_000_000:.2f} GB"
    if amount >= 1_000_000:
        return f"{amount / 1_000_000:.1f} MB"
    if amount >= 1_000:
        return f"{amount / 1_000:.1f} KB"
    return f"{amount} B"


def _format_quota_reset(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return "未知"
    if raw.endswith("Z"):
        raw = raw[:-1] + " UTC"
    return raw.replace("T", " ", 1)


def sanitize_usage(text: str) -> str:
    # Remove anything that accidentally resembles a JWT or FxA session token.
    text = re.sub(r"\b[0-9a-fA-F]{64}\b", "[secret]", text)
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "[jwt]", text)
    stripped = text.strip()
    try:
        payload = json.loads(stripped)
    except (json.JSONDecodeError, TypeError, ValueError):
        payload = None
    if isinstance(payload, dict):
        if payload.get("unlimited") is True:
            return "本月流量：不限量"
        limit = payload.get("limit")
        remaining = payload.get("remaining")
        if isinstance(limit, int) and not isinstance(limit, bool) and isinstance(remaining, int) and not isinstance(remaining, bool):
            used = max(0, limit - remaining)
            result = (
                f"套餐 {_format_quota_bytes(limit)} · "
                f"已使用 {_format_quota_bytes(used)} · "
                f"剩余 {_format_quota_bytes(remaining)}"
            )
            if payload.get("reset"):
                result += f" · 重置 {_format_quota_reset(payload.get('reset'))}"
            return safe_tail(result, 900)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return safe_tail(" · ".join(lines), 900) or "Mozilla 未返回可读的配额信息。"


def safe_tail(text: str, max_chars: int) -> str:
    text = re.sub(r"\b[0-9a-fA-F]{64}\b", "[secret]", text or "")
    text = re.sub(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b", "[jwt]", text)
    text = " ".join(text.split())
    if len(text) > max_chars:
        text = "…" + text[-max_chars:]
    return text


def read_log_tail(path: Path, max_chars: int) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return safe_tail(text, max_chars)


def refresh_state_summary() -> tuple[str | None, int | None, float | None]:
    """Read the sanitized renewal state (result, http_status, next_attempt_at).

    The state file deliberately contains no secret material, and a killed
    pool loses its buffered stdout — the persisted state is the reliable
    signal for classifying a failed bootstrap.
    """
    path = UPSTREAM / "tokens" / "refresh_state.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None, None, None
    if not isinstance(data, dict):
        return None, None, None
    result = data.get("result")
    status = data.get("http_status")
    retry_at = data.get("next_attempt_at")
    return (
        str(result) if isinstance(result, str) else None,
        int(status) if isinstance(status, int) and 100 <= status <= 599 else None,
        float(retry_at) if isinstance(retry_at, (int, float)) else None,
    )


def port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.35):
            return True
    except OSError:
        return False


def _recv_exact_socket(sock: socket.socket, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise OSError("SOCKS5 listener closed during readiness probe")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def socks5_connect_probe(
    host: str,
    port: int,
    target_host: str = SOCKS_PROBE_HOST,
    target_port: int = SOCKS_PROBE_PORT,
) -> None:
    """Verify the aggregate listener can complete a real upstream CONNECT."""
    target = str(target_host).encode("idna")
    if not target or len(target) > 255 or not 1 <= int(target_port) <= 65535:
        raise OSError("invalid SOCKS5 readiness target")
    with socket.create_connection((host, port), timeout=SOCKS_PROBE_TIMEOUT) as client:
        client.settimeout(SOCKS_PROBE_TIMEOUT)
        client.sendall(b"\x05\x01\x00")
        if _recv_exact_socket(client, 2) != b"\x05\x00":
            raise OSError("SOCKS5 listener rejected unauthenticated handshake")
        client.sendall(
            b"\x05\x01\x00\x03"
            + bytes([len(target)])
            + target
            + struct.pack("!H", int(target_port))
        )
        reply = _recv_exact_socket(client, 4)
        if reply[0] != 5 or reply[1] != 0:
            raise OSError(f"SOCKS5 upstream CONNECT failed (code {reply[1] if reply else 'unknown'})")
        atyp = reply[3]
        if atyp == 1:
            _recv_exact_socket(client, 4)
        elif atyp == 3:
            length = _recv_exact_socket(client, 1)[0]
            _recv_exact_socket(client, length)
        elif atyp == 4:
            _recv_exact_socket(client, 16)
        else:
            raise OSError("SOCKS5 listener returned an invalid address type")
        _recv_exact_socket(client, 2)


def socks5_connect_probe_any(host: str, port: int) -> None:
    """Try independent public targets so one blocked destination is not fatal."""
    last_error: OSError | None = None
    for target_host, target_port in SOCKS_PROBE_TARGETS:
        try:
            socks5_connect_probe(host, port, target_host, target_port)
            return
        except OSError as exc:
            last_error = exc
    raise OSError(f"SOCKS5 upstream probes failed: {last_error or 'unknown error'}")


def wait_for_port(host: str, port: int, proc: subprocess.Popen[Any] | None, timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc and proc.poll() is not None:
            return False
        if port_open(host, port):
            try:
                socks5_connect_probe_any(host, port)
            except OSError:
                pass
            else:
                return True
        time.sleep(0.25)
    return False


def read_native_message() -> dict[str, Any] | None:
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        return None
    if len(raw_len) != 4:
        raise EOFError("Truncated native message header")
    length = struct.unpack("=I", raw_len)[0]
    if length <= 0 or length > 1024 * 1024:
        raise BridgeError("Native message size is invalid")
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise EOFError("Truncated native message")
    obj = json.loads(payload.decode("utf-8"))
    if not isinstance(obj, dict):
        raise BridgeError("Native message must be an object")
    return obj


def write_native_message(obj: dict[str, Any]) -> None:
    payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def handle(message: dict[str, Any]) -> dict[str, Any]:
    command = str(message.get("command") or "")
    if command == "status":
        return {"status": manager.status()}
    if command == "sync":
        return {"detail": manager.sync()}
    if command == "start":
        return manager.start(message.get("country", "REC"))
    if command == "stop":
        manager.stop()
        return {"running": False}
    if command == "usage":
        return {"usage": manager.usage()}
    if command == "locations":
        return {"locations": manager.locations(force=False)}
    if command == "import_firefox":
        return {"accountLabel": manager.import_firefox()}
    if command == "open_folder":
        open_install_folder()
        return {"opened": True}
    if command == "prepare_cleanup":
        return {"cleanupToken": prepare_cleanup(str(message.get("mode") or ""))}
    if command == "cancel_cleanup":
        cancel_cleanup(message.get("token"))
        return {"cancelled": True}
    raise BridgeError("未知的本地桥接命令。")


def configure_windows_binary_stdio() -> None:
    if os.name != "nt":
        return
    try:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    except Exception:
        pass


def main() -> int:
    configure_windows_binary_stdio()
    try:
        while True:
            try:
                message = read_native_message()
            except EOFError:
                break
            if message is None:
                break
            response: dict[str, Any] = {"id": message.get("id"), "ok": True}
            try:
                response.update(handle(message))
            except BridgeError as exc:
                response.update({"ok": False, "error": str(exc)})
            except Exception as exc:
                # Do not serialize arbitrary reprs that might contain secret material.
                response.update({"ok": False, "error": f"本地桥接发生 {type(exc).__name__}。"})
            write_native_message(response)
    finally:
        manager.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
