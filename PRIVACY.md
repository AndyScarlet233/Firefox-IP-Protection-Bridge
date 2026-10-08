# Privacy and data flow

This prototype has no analytics or telemetry code in the published source. It
still handles sensitive data because it is a local VPN bridge.

## Data handled locally

- The extension stores routing and preference settings in Chrome extension
  storage.
- The popup reads the active HTTP(S) tab hostname to show and edit a route rule.
- The native host scans the local Firefox profiles and, when the user explicitly
  chooses **从 Firefox 导入**, selects the most recently modified verified
  `signedInUser.json` record.
- Renewal credentials, short-lived proxy authorization material, node metadata,
  and operational state are written under the separately installed local runtime.
  They are not part of this repository.

## Browser login: how the credentials are handled

Since 1.1.0 the popup can sign in to a Mozilla account directly, so no desktop
Firefox installation is required. That path handles an account password, so its
data flow is documented explicitly.

1. **Entry.** The popup renders an email field and a password field. These are
   Chromium's own input elements; the popup does not persist them, and they never
   reach `chrome.storage`.
2. **Transport.** The values travel in-process:
   `chrome.runtime.sendMessage` → the MV3 service worker → `sendNativeMessage` →
   the local native host. Nothing leaves the machine at this stage.
3. **One-shot handoff file.** The host writes the payload to a single-use file in
   the local runtime's token directory (`bootstrap_input.json`). That file is
   created with an owner-only ACL — inherited permissions are removed, so other
   local accounts cannot read it — and marked with the Windows hidden attribute.
   The login child process reads it and **deletes it immediately**, before acting
   on its contents.
4. **What the password never touches.** It is not passed as a command-line
   argument, not written to any log, not written to `chrome.storage`, and not
   written to the progress file described below. The login script's own comment
   states the intent plainly: secrets live in memory only.
5. **Verification answers use the same channel.** The emailed 6-digit confirmation
   code, the TOTP code, and the image-captcha answer are written to the same
   single-use file and deleted on read. Each challenge carries a sequence number,
   so an answer meant for one captcha image cannot be applied to a newer one.
6. **Progress file.** The host publishes sanitized progress in
   `tokens\bootstrap_status.json` so the popup can mirror the flow. It contains
   the current stage, a human-readable detail string, a success flag, which input
   the flow is waiting for, the challenge sequence number, and — while an image
   captcha is pending — the captcha image itself. It contains **no keys, no
   tokens, no password, and no verification code**. The captcha image is the only
   piece of challenge data that is written there, and it is re-sent on every
   heartbeat refresh so a slow human check does not lose the image.
7. **Cancellation.** A cancel request is a marker file (`bootstrap_cancel.event`)
   that carries no data. It is removed as soon as the flow stops, so a stale
   marker cannot kill a later attempt.
8. **Result.** On success, renewable session credentials are written to the local
   runtime's token directory. The session token stays there; it is never returned
   to the extension page or to `chrome.storage`. The popup only ever receives a
   masked account label.
9. **Renewal.** Afterwards, credentials renew over plain HTTP through PyFxA. No
   browser is involved, and Firefox does not need to run again.

The temporary captcha images that the flow writes are deleted when the flow
finishes, and any leftover files matching that pattern are removed on the next
run. The flow captures no screenshots of the login session.

## Network destinations

The bridge communicates with Mozilla Firefox Account/Guardian endpoints and the
Firefox Remote Settings endpoint used by the upstream pool. Proxied browser
traffic is forwarded through the selected and potentially rotated Firefox IP
Protection/Fastly exits.

The browser-login flow additionally contacts `accounts.firefox.com` through the
bundled headless Playwright Firefox, including the Fastly human check and the
sign-in confirmation endpoints. Review the upstream service terms and eligibility
requirements before use; whether your account may use this service, and under
which terms, is between you and Mozilla.

## Logs

Three logs are written under the separately installed local runtime, not in this
repository, and all three live in the same `runtime\logs\` directory:

- `runtime\logs\bridge.log` — the command audit log. It records each Native
  Messaging command name, its outcome, and non-secret error text. It exists so
  that "I clicked the button and nothing happened" is diagnosable. It is truncated
  once it exceeds 512 KB.
- `runtime\logs\ipp-pool.log` — the output of the upstream pool process.
- `runtime\logs\bootstrap-login.log` — the transcript of the browser-login child
  process, mirrored by the script itself because the child runs without a console.
  It is truncated once it exceeds 1 MB.

None of them contains passwords or verification codes. The login script never
prints the password: it is only ever read from the one-shot input file.

**The current login flow captures no screenshots.** Older builds saved login-step
screenshots such as `bootstrap_after_password.png`; the cleanup routine still
lists those filenames, but only in order to delete leftovers from those older
builds. No code path in the current version writes an image of the login session.

## Browser permissions

The Manifest V3 extension requests `proxy`, `storage`, `nativeMessaging`,
`activeTab`, `privacy`, `declarativeNetRequestWithHostAccess`, `contentSettings`,
`scripting`, `management`, `alarms` and all-URL host access.
They are used to control route-scoped proxy/DNS/WebRTC settings, communicate
with the local bridge, inspect the active page, drive the periodic health check,
and apply the optional region privacy shim. The content scripts run at document
start in isolated and main worlds, which is a high-trust design and should be
reviewed before installation. See [`docs/PERMISSIONS.md`](docs/PERMISSIONS.md) for
the per-permission breakdown.

## What this project does not promise

The source does not promise anonymity, complete VPN coverage, or protection
against a malicious browser, operating system, extension, upstream service, or
compromised build artifact.
