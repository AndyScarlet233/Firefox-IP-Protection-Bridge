# Firefox IP Protection Bridge for Chromium

**English** | [中文](README.zh-CN.md)

An **unofficial** Chromium extension (Chrome, Edge, Brave) that lets a Mozilla
account with Firefox IP Protection eligibility use that service from a Chromium
browser, through a local Native Messaging + SOCKS5 bridge.

This project is not made, supported, or endorsed by Mozilla, Google, Fastly, or
any other party named in this document. See [Disclaimer](#disclaimer).

> **This repository is source-only.** It deliberately contains no credentials,
> no installed runtime, and no binaries. A working install therefore needs a
> locally built runtime in addition to the extension; see
> [Install](#install).

## What it does

Firefox IP Protection is a Mozilla VPN feature that routes browser traffic
through Fastly-operated exits. This bridge reuses an eligible account's session
from a Chromium browser:

- The extension owns the browser side: the on/off switch, region selection, and
  per-site routing.
- A local Native Messaging host owns the account side: it obtains and renews the
  session credentials and runs a local SOCKS5 listener.
- Chromium is pointed at that listener through a route-scoped PAC script, so only
  the traffic you route through the VPN is affected.

The raw account session token is never handed back to the extension page or to
`chrome.storage`; it stays in the separately installed local runtime.

## Features

### Credentials

- **Browser login (1.1.0, recommended).** Sign in to your Mozilla account from
  inside the extension popup. No desktop Firefox installation is needed, and
  Firefox never has to run again afterwards.
- **Import from Firefox (optional alternative).** Read the signed-in account from
  a local Firefox profile. This path requires desktop Firefox to be installed and
  already signed in.
- **Automatic renewal.** After either path succeeds, credentials renew over plain
  HTTP in the background. A Guardian registration is created automatically the
  first time an account uses IP Protection.

### Routing

- One-click VPN on/off.
- Choose an exit region, or let the bridge recommend one. The recommendation is
  ranked by measured latency and skips shared anycast exits whose egress country
  is not pinned, so the region the UI reports is the region you actually get.
- Two per-site split-tunnelling modes, applied through a route-scoped PAC script:
  - **Allowlist** — only the sites you list go through the VPN; everything else
    stays direct.
  - **Blacklist** — everything goes through the VPN except the sites you list.
- A per-site switch for the page you are currently on.
- Rule export/import, for moving rules between browsers and Chrome profiles
  (`chrome.storage.local` does not sync).

### Privacy controls

- **WebRTC leak protection** — stops WebRTC from revealing the real IP around the
  proxy. It can stay on while the VPN is off.
- **DNS prefetch protection, scoped to the route** — disables DNS prefetch only
  for pages that actually use the VPN; directly connected pages keep Chromium's
  normal prefetch and preconnect behaviour.
- **Region privacy protection** — aligns language, time zone, and reported
  location with the exit region, and masks CJK font probing. It applies only to
  sites that use the VPN.

### Account

- Query the current plan, data used, data remaining, and the reset time.

### Operations

- **Move-safe install.** Local components live at a fixed per-user location
  (`%LOCALAPPDATA%\FirefoxChromeVPNBridge`), so the unpacked extension folder can
  be moved or renamed without breaking Native Messaging.
- **Command audit log** at `runtime\logs\bridge.log` and a login transcript at
  `runtime\logs\bootstrap-login.log`. Both record command names, outcomes, and
  non-secret error text only — never passwords or verification codes.

## Requirements

- **Windows 64-bit.** The native host is Windows-only.
- **A Chromium browser** version 120 or later (Chrome, Edge, or Brave).
- **Python 3.14, 64-bit, already installed** — for a source checkout you must
  provide it; the packaged setup script looks for an existing installation, does
  not modify `PATH`, does not create a Windows service, and does not create a
  startup item.
- **An eligible Mozilla account** with Firefox IP Protection access. Eligibility
  and terms of service are between you and Mozilla.
- **Optional, for browser login only:** Playwright and its Firefox build
  (roughly 80 MB). A release package's setup script installs these into the local
  runtime automatically; in a source checkout you install them yourself. If they
  are missing, only the browser-login button is unavailable — every other feature
  still works, and the setup script can be re-run later to add them.

## Install

There are two ways to end up with a working install. Both start from the same
code; they differ only in who builds the runtime.

### Option 1 — a release package (if one is published)

If this project publishes a release package, download it and follow the
instructions shipped inside it. Such a package includes a prebuilt runtime and a
setup script that copies the runtime to the fixed per-user location, installs the
optional browser-login dependencies, and registers the Native Messaging host.
This repository does not contain that package, and no release is asserted to
exist.

### Option 2 — from this source checkout

This repository is intended for source review and for loading the unpacked
extension. Building the runtime is a separate, reviewed step described in
[`docs/BUILD.md`](docs/BUILD.md).

1. **Build the runtime.** Follow [`docs/BUILD.md`](docs/BUILD.md). The repair
   script refuses to run against a source-only checkout: Chrome's Native
   Messaging manifest points at a single executable, so a built
   `runtime\vpn_bridge_host.exe` must exist first.
2. **Register the Native Messaging host.** Run `INSTALL-OR-REPAIR.cmd` in the
   repository root, or `scripts/install-or-repair.ps1` directly from PowerShell.
   This writes the host manifest next to the built executable and registers it
   for Chrome, Edge, Chromium, and Brave under `HKCU`. It stops stale host
   processes first. If the runtime is missing, the script stops and points you
   back to `docs/BUILD.md`.
3. **Load the extension.** Open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked**, and select this repository's `extension` directory.
4. **Get credentials.** Open the popup, expand 设置 (Settings), and either click
   **浏览器登录** (Browser Login) or, on a machine that already has Firefox signed
   in, **从 Firefox 导入** (Import from Firefox). See
   [Getting credentials](#getting-credentials).
5. **Connect.** Click 开启 VPN (Turn on VPN), pick a region or leave the
   recommendation, and browse.

> **Loading only the extension does not give you a VPN.** Without a registered
> native host, the popup renders but the connection controls cannot work: the
> extension has no way to obtain credentials or to start the local proxy. Treat
> the extension alone as a UI preview.

If you move the extension folder later, the Native Messaging registration keeps
working, because it points at the fixed per-user runtime location rather than at
the folder you loaded the extension from.

### What the install puts on the machine

Almost everything stays together under one per-user directory,
`%LOCALAPPDATA%\FirefoxChromeVPNBridge`, which holds the runtime, the helper
executable, the Python packages, the downloaded Playwright browser, the logs, and
the credentials. Outside it, the install creates one per-user Native Messaging
registry entry per browser:

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\org.firefox_ip_protection.chrome_bridge
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\org.firefox_ip_protection.chrome_bridge
HKCU\Software\Chromium\NativeMessagingHosts\org.firefox_ip_protection.chrome_bridge
HKCU\Software\BraveSoftware\Brave\NativeMessagingHosts\org.firefox_ip_protection.chrome_bridge
```

## Getting credentials

You need one of the two paths below. Browser login is the recommended one and is
the only path that does not need Firefox.

### Path A — browser login (recommended, no Firefox required)

1. Open the extension popup and expand 设置 (Settings).
2. Click **浏览器登录** (Browser Login). A small form appears inside the popup.
3. Enter your Mozilla account **email** and **password** in that form. These are
   Chromium's own input fields, so input-method editors (including CJK IMEs) work
   normally. Submit.
4. The local bridge opens `accounts.firefox.com` in a bundled **headless
   Playwright Firefox** and passes the Fastly human check on its own. This happens
   in the background; there is no visible browser window.
5. **If an image captcha appears**, the image is displayed in the popup. Type the
   characters you see and submit. A wrong answer automatically fetches a fresh
   image. The challenge area scrolls into view and takes focus when it appears.
6. **Mozilla usually asks you to confirm the new device.** It emails a 6-digit
   code; the popup asks you to enter it. If the account has two-step verification
   with a TOTP app, the popup asks for the authenticator code instead.
7. On success the popup reports that the credentials are saved and will renew
   automatically. A Guardian registration is created automatically if this
   account has not used IP Protection before.

After this, credentials renew over plain HTTP (PyFxA) with no browser involved.

If Mozilla ever invalidates the session — for example after you change your
account password — run the browser login once more.

### Path B — import from Firefox (optional)

Use this on a machine that already has desktop Firefox installed and signed in to
an eligible account:

1. Enable Firefox's built-in IP Protection once in Firefox, so the profile holds
   a usable signed-in record.
2. Open the extension popup, expand 设置 (Settings), and click **从 Firefox 导入**
   (Import from Firefox).
3. The host scans the local Firefox profiles and selects the most recently
   modified verified record.

This path needs desktop Firefox to stay installed for the import. Credentials
obtained this way renew like any other; the browser-login path is the one that
removes the Firefox dependency entirely.

## Using the VPN

### Turning it on and off

Click 开启 VPN (Turn on VPN). The extension verifies a real SOCKS5
handshake/CONNECT before installing the PAC script, so a helper that is not
actually healthy is not advertised as connected. Turning the VPN off clears this
extension's Chromium proxy setting, stops the SOCKS5 process, and disconnects the
native host. The host is kept alive only for the duration of an active VPN
connection; it is not a background service.

### Choosing an exit region

Click the location button to pick a country, or leave it on 推荐（自动）
(Recommended, automatic). The recommendation is ranked by measured latency and
excludes shared anycast exits, whose egress country is decided upstream — that is
why a region you select is the region you get. When you connect with the
recommendation, the popup tells you which region it resolved to.

### Splitting traffic per site

Choose the mode in 设置 (Settings):

- **白名单 (Allowlist)** — only listed sites use the VPN; everything else stays
  direct.
- **黑名单 (Blacklist)** — everything uses the VPN except listed sites.

Add domains in the list field. Domain shape is validated before storage, so
pasted prose is rejected rather than turned into bogus rules. The switch next to
the address bar reflects the current page and asks the background for the routing
decision, so the switch and the PAC script never disagree. Use 导出 (Export) and
导入 (Import) to move rules between browsers or profiles; import merges and never
overwrites existing rules.

### Privacy controls

All three are in 设置 (Settings) and are described in
[Features](#privacy-controls). WebRTC leak protection and DNS prefetch
protection are scoped so that directly connected pages are left alone.

### Checking usage

Click 查询 (Query) under 本月用量 (This month's usage) to see the plan, data
used, data remaining, and the reset time. The figures come from Mozilla's server.

### Uninstalling

- **删除本地组件 (Delete local components)** in the popup removes the local
  runtime: the private Python packages, credentials, logs, native helper, and the
  Native Messaging registry entries. The extension stays loaded.
- **完整卸载 (Full uninstall)** in the popup runs the same cleanup and then
  removes the extension itself.
- Deleting the whole project folder removes every local program and data file
  belonging to this project. One harmless registry pointer may remain; it points
  at a file that no longer exists and can be deleted by hand.

Chromium offers no extension-uninstall hook that can run a local program, so
removing the extension straight from `chrome://extensions` cannot reliably ask the
helper to clean itself up afterwards. Prefer **完整卸载** inside the popup.

Do **not** delete the `tokens` directory to fix a problem. Credentials live there
and are preserved across repairs.

## Privacy and security summary

- Credentials are stored only in the separately installed local runtime, never in
  this repository, and never in the extension page or `chrome.storage`.
- The raw session token is not returned to the extension.
- Logs record command names, outcomes, and non-secret error text only.
- The bridge talks to Mozilla Firefox Account / Guardian endpoints and the
  Firefox Remote Settings endpoint used by the upstream pool. Proxied traffic
  goes through the selected Fastly-operated exits.
- This project does **not** promise anonymity, complete VPN coverage, or
  protection against a malicious browser, operating system, extension, upstream
  service, or compromised build artifact.

Read [`PRIVACY.md`](PRIVACY.md) for the full data flow, including exactly how the
browser-login password is handled, and [`SECURITY.md`](SECURITY.md) for the
reporting policy. [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) records every
browser permission and why it exists.

## Troubleshooting

### I clicked a button and nothing happened

The popup, the service worker, and the native host are three separate processes,
so a silent failure has several possible causes:

1. Check `runtime\logs\bridge.log`. Every Native Messaging command and its
   outcome is recorded there. If your click never appears in the log, the request
   never reached the host.
2. If the log shows a command but the popup stayed inert, the extension is
   probably stale: open `chrome://extensions` and click **Reload** for the
   unpacked `extension` directory.
3. If the log says the extension is too old for browser login, the loaded
   extension build predates 1.1.0. Reload it.
4. Open the popup once more. If it reports that direct mode was restored, refresh
   the affected page.

### The browser-login button is disabled or reports missing components

The optional Playwright dependency is not installed in the local runtime. Only
browser login is affected; use **从 Firefox 导入** (Import from Firefox) in the
meantime, or re-run the setup script to install the missing components.

### ERR_PROXY_CONNECTION_FAILED

Chromium reached the configured local proxy, but the local SOCKS5 helper was
stopped or could not complete an upstream CONNECT. The extension now fails open
and reconciles a dead helper when the popup opens, but after an update:

1. Re-run `INSTALL-OR-REPAIR.cmd` as the same Windows user.
2. In `chrome://extensions`, click **Reload** for the unpacked `extension`
   directory.
3. Open the popup once. If it reports that direct mode was restored, refresh the
   affected page.
4. Reconnect only after the popup reports a healthy helper.

A `LISTEN` on `127.0.0.1:1090` is the live proxy check. Do not delete the
`tokens` directory to repair this error.

### The login flow stops responding

The popup stops polling after 15 minutes so a stuck flow cannot poll forever, and
the host treats a heartbeat older than 120 seconds as a dead child. Both cases are
reported as a failure rather than an endless wait. Click **浏览器登录** again to
retry; clicking it while a flow is running cancels that flow.

### Credentials stopped working

If Mozilla invalidated the session (a password change is the usual cause), run
**浏览器登录** once more. The popup shows a one-line credential freshness hint
derived from sanitized renewal state.

### Where the logs are

| Log | Contents |
|---|---|
| `runtime\logs\bridge.log` | Every Native Messaging command, its outcome, and non-secret error text. |
| `runtime\logs\ipp-pool.log` | Output of the upstream pool process. |
| `runtime\logs\bootstrap-login.log` | Full transcript of the browser-login child process. |

These files live in the separately installed local runtime, not in this
repository, and all three sit in the same `runtime\logs\` directory. None of them
contains passwords or verification codes. The current login flow captures no
screenshots; the `bootstrap_after_*.png` filenames that appear in the cleanup list
only remove leftovers from older builds.

## Project layout

```text
extension/                          Manifest V3 extension source (load unpacked)
host/native_host.py                 Native Messaging bridge source
vendor/firefox-ip-protection-pool/  Upstream-derived backend compatibility source
scripts/audit_public_tree.py        Pre-release sanitisation audit
scripts/install-or-repair.ps1       Native Messaging registration for a built runtime
config/                             Example Native Messaging host manifest
docs/                               Usage, build, and permission documentation
```

- [`docs/USAGE.md`](docs/USAGE.md) — full usage walkthrough
- [`docs/BUILD.md`](docs/BUILD.md) — build and release boundary
- [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) — permission review
- [`PRIVACY.md`](PRIVACY.md) — privacy and data flow
- [`SECURITY.md`](SECURITY.md) — security policy
- [`THIRD_PARTY.md`](THIRD_PARTY.md) — third-party notices
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## License and third parties

This project is released under the MIT License; see [`LICENSE`](LICENSE).

The `vendor/firefox-ip-protection-pool/` directory contains upstream-derived
backend code under its own MIT license. Python dependencies (`requests`, `PyFxA`,
and the optional `playwright`) are not vendored here. Firefox, Mozilla, Firefox IP
Protection, Fastly, and related marks are referenced only to describe
interoperability. See [`THIRD_PARTY.md`](THIRD_PARTY.md) for the complete notices
and the release-artifact rule.

## Disclaimer

This is an unofficial prototype. It is not affiliated with, endorsed by, or
supported by Mozilla, Google, Fastly, or the upstream project author. You are
responsible for confirming that your account is eligible, that your use complies
with the applicable terms of service, and that it complies with the law where you
are. The upstream compatibility project is still downloaded from its `main`
branch in this prototype; a hardened release should pin and audit a specific
upstream commit or archive hash.

## Status

This remains a prototype. The source, manifest, and native-message framing can be
reviewed here, but the complete Windows Chromium + Native Messaging + Mozilla
Guardian/Fastly path still requires real Windows and real-account testing.
