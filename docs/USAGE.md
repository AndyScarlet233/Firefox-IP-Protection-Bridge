# Using the sanitized source checkout

This document is the full usage walkthrough. It assumes the extension is loaded
and a Native Messaging host has been built and registered as described in
[`BUILD.md`](BUILD.md).

The unpacked extension can be loaded without placing any credentials in this
repository:

1. Open the browser's extensions page.
2. Enable developer mode.
3. Choose **Load unpacked** and select this checkout's `extension/` directory.
4. If a compatible Native Messaging host is already registered for the same
   extension ID, the bridge can continue to be used. Otherwise only the UI is
   available until a separately built and audited host is installed.

Never copy a private `runtime/` directory, a Firefox profile export, a token
file, or an installed `vpn_bridge_host.exe` into the checkout. Keep those files
outside Git and use the source/release process described in [`BUILD.md`](BUILD.md).

## What works without a host

The popup renders and its settings persist, but nothing that needs the account or
the local proxy can work. Concretely, without a registered host you cannot obtain
credentials, cannot turn the VPN on, and cannot query usage. Treat the extension
alone as a UI preview.

## Getting credentials

The bridge needs a Mozilla account session with Firefox IP Protection
eligibility. There are two ways to give it one.

### Browser login (recommended — no Firefox required)

This path drives a bundled headless Playwright Firefox through
`accounts.firefox.com` and keeps every prompt inside the popup. No desktop
Firefox installation is needed, and Firefox does not have to run again afterwards.

**Before you start:** the local runtime must contain Playwright and its Firefox
build. A release package's setup script installs them (roughly 80 MB into the
runtime's `pw-browsers` directory); in a source checkout you install them
yourself. If they are missing, the popup disables the browser-login button and
tells you to re-run the setup script. Every other feature keeps working.

1. **Open the form.** Open the extension popup, expand 设置 (Settings), and click
   **浏览器登录** (Browser Login). A form with an email field and a password field
   appears inside the popup, directly under the Mozilla account row.

2. **Enter your credentials.** Type your Mozilla account email and password into
   that form. These are Chromium's own `<input>` elements, so Windows input-method
   editors — including Chinese, Japanese, and Korean IMEs — behave normally.
   Earlier builds collected these in a console window, which mangled CJK input;
   that path is gone. The password field is not persisted anywhere by the popup.

3. **Submit.** Click 开始登录 (Start login). The popup collapses the form, changes
   the button to 登录中…点击取消 (Signing in… click to cancel), and starts polling
   the host for progress every three seconds.

4. **The human check runs in the background.** The bridge launches a headless
   Playwright Firefox and passes the Fastly human check on its own. The popup
   shows 正在后台通过网站人机检查，请稍候… (Passing the site's human check in the
   background…). There is no visible browser window at any point — the popup is
   the only UI.

5. **Answer the image captcha if one appears.** When Fastly asks for one, the
   captcha image is displayed in the popup with the hint 请输入图片中的字符 (Enter
   the characters in the image). Type the characters and submit. A wrong answer
   automatically fetches a fresh image, and the challenge area scrolls into view
   and takes focus when it appears. Each image carries a sequence number, so a
   stale answer can never be applied to a newer image.

6. **Confirm the new device.** Mozilla marks a session created from an
   unrecognised browser as unverified, and exchanging an unverified session for an
   OAuth token fails. The flow therefore probes `GET /session/status` and, when
   confirmation is required, asks you for the code:
   - **Email confirmation (usual case).** Mozilla mails a 6-digit code. The popup
     shows 请输入 Mozilla 发送到邮箱的 6 位验证码 (Enter the 6-digit code Mozilla
     emailed you) and a six-digit input field. The code can take several minutes
     to arrive; the flow waits up to 15 minutes for it.
   - **Two-step verification with a TOTP app.** The popup instead shows
     请输入验证器应用中的 6 位动态验证码 (Enter the 6-digit code from your
     authenticator app). The code is confirmed through `POST /session/verify/totp`
     rather than `POST /session/verify_code`.
   - If you already typed the same code on the accounts page, the flow reuses it
     instead of asking you for it twice.

7. **Wait for the exchange.** The popup shows 正在交换登录凭据… (Exchanging login
   credentials…) while the session is converted into renewable credentials. On
   success it reports 登录成功，凭据已保存，之后会自动续期 (Signed in; credentials
   saved and will renew automatically). The Mozilla account row then shows the
   masked account address.

8. **First-time accounts are activated automatically.** If the account has never
   used IP Protection, the flow creates the Guardian registration itself. You do
   not have to enable the feature in Firefox first.

After a successful login, credentials renew over plain HTTP (PyFxA) with no
browser involved. Firefox never needs to run again.

**Cancelling.** While a flow is running, the same button reads
登录中…点击取消. Clicking it cancels the flow and reports 登录已被用户取消 (Login
cancelled by the user). The popup also stops polling after 15 minutes, so a stuck
flow is reported as a failure rather than an endless wait; the host independently
treats a heartbeat older than 120 seconds as a dead child process.

**If it fails.** Read `runtime\logs\bootstrap-login.log` for the full transcript
of the login child process. Passwords and verification codes never appear there.
The current login flow captures no screenshots; the `bootstrap_after_*.png` entries
in the cleanup list only remove leftovers from older builds.

### Import from Firefox (optional alternative)

Use this on a machine that already has desktop Firefox installed and signed in to
an eligible account. It needs Firefox; browser login does not.

1. Enable Firefox's built-in IP Protection once in Firefox, so that the profile
   holds a usable signed-in record.
2. Open the extension popup, expand 设置 (Settings), and click **从 Firefox 导入**
   (Import from Firefox).
3. The native host scans the local Firefox profiles and selects the most recently
   modified verified `signedInUser.json` record.

Credentials obtained this way renew like any other. The import step itself needs
desktop Firefox to be installed.

## Using the VPN

### Turning it on and off

Click 开启 VPN (Turn on VPN). Before installing the PAC script, the extension
verifies a real SOCKS5 handshake and CONNECT against the local helper, so a helper
that is not actually healthy is never advertised as connected. When the connection
succeeds, the popup reports 已连接 (Connected) and, if you left the region on the
recommendation, names the region it resolved to.

Turning the VPN off clears this extension's Chromium proxy setting, stops the
SOCKS5 process, and disconnects the native host. The host is kept alive only for
the duration of an active connection; it is not a background service.

### Choosing an exit region

Click the location button under the switch to pick a country, or leave it on
推荐（自动）(Recommended, automatic).

The recommendation is ranked by measured latency and excludes shared anycast
exits. A shared anycast exit carries a rollout country in its record but egresses
from whichever Fastly POP answers, so selecting one country could hand you an exit
in another. Excluding them is what makes the region shown in the UI the region you
actually get.

### Splitting traffic per site

Choose the mode in 设置 (Settings):

- **白名单 (Allowlist)** — only the sites in the list use the VPN; everything else
  stays direct.
- **黑名单 (Blacklist)** — everything uses the VPN except the sites in the list.

Add domains in the list field and click 添加 (Add). Domain shape is validated
before storage, so pasted prose is rejected instead of being turned into bogus
rules. The switch next to the address bar shows the current page's state and asks
the background for the routing decision, so the switch and the installed PAC
script always agree.

Use 导出 (Export) and 导入 (Import) to move rules between browsers or Chrome
profiles, which do not sync `chrome.storage.local`. Export also fills a textarea,
so it still works when clipboard access is denied. Import merges and never
overwrites existing rules.

### Privacy controls

All three toggles are in 设置 (Settings):

- **WebRTC 防泄漏 (WebRTC leak protection)** — stops WebRTC from revealing the real
  IP around the proxy. It can stay enabled while the VPN is off.
- **DNS 预解析防护 (DNS prefetch protection)** — disables DNS prefetch only for
  pages that actually use the VPN. Directly connected pages keep Chromium's normal
  prefetch and preconnect behaviour.
- **区域隐私保护 (Region privacy protection)** — aligns language, time zone, and
  reported location with the exit region, and masks CJK font probing. It applies
  only to sites that use the VPN; explicitly exempted sites keep the browser's
  native environment.

### Checking usage

In 设置 (Settings), under 本月用量 (This month's usage), click 查询 (Query) to see
the plan, data used, data remaining, and the reset time. The figures are computed
by Mozilla's server. A short-lived OAuth access token is minted for the query and
destroyed immediately afterwards; it is not written to disk.

### Uninstalling

- **删除本地组件 (Delete local components)** removes the local runtime: the private
  Python packages, credentials, logs, native helper, and the Native Messaging
  registry entries. The extension stays loaded.
- **完整卸载 (Full uninstall)** runs the same cleanup and then removes the
  extension itself.
- Deleting the whole project folder removes every local program and data file
  belonging to this project. One harmless registry pointer may remain; it points
  at a file that no longer exists and can be deleted by hand.

Chromium provides no extension-uninstall hook that can run a local program, so
removing the extension straight from `chrome://extensions` cannot reliably ask the
helper to clean up afterwards. Prefer **完整卸载** inside the popup.

Do not delete the `tokens` directory to repair a problem. Credentials live there
and are preserved across repairs.

## Troubleshooting

### A button does nothing

The popup, the MV3 service worker, and the native host are three separate
processes, so silence has several possible causes:

1. Check `runtime\logs\bridge.log`. Every Native Messaging command and its outcome
   is recorded there. If your click never appears, the request never reached the
   host.
2. If the log shows the command but the popup stayed inert, the loaded extension is
   probably stale: reload it from the browser's extensions page.
3. If the log reports that the extension is too old for browser login, the loaded
   build predates 1.1.0. Reload the extension.

### The browser-login button is disabled

Playwright or its Firefox build is missing from the local runtime. Only browser
login is affected. Use **从 Firefox 导入** in the meantime, or re-run the setup
script to install the missing components.

### ERR_PROXY_CONNECTION_FAILED

Chromium reached the configured local proxy, but the local SOCKS5 helper was
stopped or could not complete an upstream CONNECT. The extension fails open,
serializes proxy-changing operations, and reconciles a dead helper when the popup
opens. After an update, re-run the setup script, reload the extension, open the
popup once, and refresh any affected page before reconnecting.

A `LISTEN` on `127.0.0.1:1090` is the live proxy check. Do not delete the `tokens`
directory to repair this error.

### Credentials stopped working

If Mozilla invalidated the session — a password change is the usual cause — run
**浏览器登录** once more. The popup shows a one-line credential freshness hint
derived from sanitized renewal state; it never contains secret material.

### Where the logs are

| Log | Contents |
|---|---|
| `runtime\logs\bridge.log` | Every Native Messaging command, its outcome, and non-secret error text. |
| `runtime\logs\ipp-pool.log` | Output of the upstream pool process. |
| `runtime\logs\bootstrap-login.log` | Full transcript of the browser-login child process. |

These files live in the separately installed local runtime, not in this
repository. None of them contains passwords or verification codes.
