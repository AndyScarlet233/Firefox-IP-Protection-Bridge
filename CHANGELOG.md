# Changelog

## 1.1.0

### Added

- **In-app browser login: credentials without a desktop Firefox.** The popup now
  collects the Mozilla account email and password in a small form and drives a
  headless Playwright Firefox through `accounts.firefox.com`. The Fastly
  human-check, the image captcha and the 6-digit email confirmation code are all
  presented and answered inside the popup, so no console window and no local
  Firefox installation are involved. Afterwards the stored session renews itself
  over plain HTTP; Firefox never has to run again.
- **Sign-in confirmation for new devices.** Mozilla marks every session created
  from an unrecognised browser as unverified, and exchanging such a session for
  an OAuth token fails with `errno 138`. The flow now probes
  `GET /session/status` and, when confirmation is required, asks for the emailed
  6-digit code and confirms the session with `POST /session/verify_code`
  (`POST /session/verify/totp` for TOTP accounts). A code already typed on the
  accounts page is reused instead of being requested twice.
- **Command audit log** at `runtime/logs/bridge.log` and a login transcript at
  `runtime/logs/bootstrap-login.log`. Both record command names, outcomes and
  non-secret error text only; passwords and verification codes never reach them.
  "Clicked the button and nothing happened" is now diagnosable.
- Brave's Native Messaging registry key
  (`HKCU\Software\BraveSoftware\Brave\NativeMessagingHosts`) is registered
  alongside Chrome, Edge and Chromium.
- The optional browser-login dependency (Playwright plus its Firefox build,
  about 80 MB into `runtime/pw-browsers`) is installed by the setup script.
  A failure there disables only the browser-login button.

### Fixed

- **Fastly answered a valid challenge POST with an empty HTTP 400**, which killed
  the login silently and left the user staring at an inert page. The challenge
  cycle now retries as a whole, and each retry discards the previous challenge
  token, whose reuse guarantees another empty 400.
- **The captcha image disappeared while waiting.** The heartbeat is refreshed
  while the flow waits for input, and the refresh used to overwrite
  `captcha_b64` with null, so a slow human check lost the image. The image is now
  re-sent with every refresh.
- **Login messages were invisible.** Notices render at the top of the popup, which
  is scrolled out of view while the user works in the settings block; every
  login-related message now also appears inline under the form. Validation errors
  are reported as the user types, and the challenge area scrolls into view and
  takes focus when it appears.
- **The email confirmation code could not be typed at all.** The console input
  path used raw keyboard polling, which bypasses the Windows IME and produced
  mojibake for CJK input, and the password prompt used `getpass`, which does not
  echo. Both were replaced by the in-popup form.
- The stale-extension case now reports itself. A `bootstrap_login` request
  without credentials is answered with an explicit "reload the extension"
  message instead of a silent failure.
- `INSTALL-OR-REPAIR.ps1` is written as UTF-8 with a BOM; without it Windows
  PowerShell 5.1 read the file as ANSI and failed to parse the Chinese strings.

## 1.0.6

### Fixed

- **Per-site VPN toggle was inert.** `SITE_FAMILY_ALIASES` folds
  `www.google.com` and `gemini.google.com` into `google.com`, but rule removal
  compared a canonicalized host against the raw stored rule, so the rule was
  never deleted and the reinstalled PAC was byte-identical. Removal now strips
  every spelling that folds onto the same managed domain.
- **The popup switch disagreed with the PAC.** The switch was computed from the
  raw stored list while the PAC matched the canonicalized + site-family-expanded
  domains. The popup now asks the background (`routeFor`) so both sides share one
  decision function.
- **Advertised exit country could drift.** `--countries` filtering was correct,
  but Mozilla's "CatchAll Anycast" exit is filed under a rollout country while
  egressing from whichever Fastly POP answers, so a selected `US` could hand out
  an `NL` exit. `ipp_pool.py` gained `--exclude-hosts` (a real exclusion, not a
  sort) and the bridge now drops country-unpinned anycast backends.
- **Popup could become permanently unresponsive.** `refreshStatus()` disabled
  every control before awaiting an untimed `locations` request, so one slow
  native-host round trip left the whole panel dead with no visible cause. Added a
  12-second deadline plus a watchdog, and `send()` now retries once when the MV3
  service worker is still waking.
- **Stale commands poisoned the UI.** An unknown message type was written into
  `lastError` and surfaced as a red banner. It is now answered without persisting
  state, and the rejected type is named for diagnosis.
- **Hostile rule input could create bogus entries.** The WHATWG URL parser turns
  arbitrary text into punycode hostnames, so pasted prose became several fake
  rules. Domain shape is now validated before storage, and non-domain lines are
  skipped.

### Added

- Rule copy/import for migrating between browsers and Chrome profiles, which do
  not sync `chrome.storage.local`. Export fills a textarea as well as the
  clipboard, so it still works when clipboard access is denied. Import merges
  and never overwrites existing rules.
- A quiet one-line credential freshness hint under "Mozilla account", derived
  from the sanitized renewal state (no secret material).

## 1.0.3 (working package sync)

- Surfaced the real failure behind "proxy exited early": Guardian applies
  region checks to the client IP and intermittently answers HTTP 451, which
  the bridge previously misclassified as a protocol error.
- Classified HTTP 451 as `service_restricted`, kept server-side cooldowns,
  and mapped it to an accurate, actionable popup message (no misleading
  "re-import credentials" advice).
- Routed FxA OAuth and Guardian renewals through an eligible egress:
  `IPP_REFRESH_PROXY` env var, `tokens/refresh_proxy.txt`, the pool's own
  local HTTP rotator (127.0.0.1:8080, now started by the bridge), then direct.
  While the tunnel is up, renewals therefore use the eligible exit IP and no
  longer depend on the local network route.
- Retried token-not-ready bootstraps inside a 115-second budget (bounded by
  the extension's 150-second start timeout), with unbuffered pool logs and
  cumulative failure classification from the sanitized renewal state.
- Relaxed the pool's locked-exit filter so Mozilla gradual-rollout regions
  are selectable (`--include-locked`; quarantined exits stay excluded).
- Extended the serverlist and latency caches to reduce startup work, and
  synced the extension to the 1.0.3 working package (serialized lifecycle
  queue, pending UI states, cached region list, concurrent popup requests).

## 1.0.0-public

- Published a sanitized, source-first repository for the Chromium extension.
- Fixed the quota request path to use the same GET token-endpoint flow as Firefox.
- Prevented the repair script from registering a source-only Python interpreter as
  a Native Messaging host; source checkouts now require a built runtime binary.
- Kept the loadable `extension/` tree and fixed extension ID from the working
  move-safe package; added the declared `management` permission required by its
  existing self-uninstall call.
- Included the native bridge and the audited upstream source needed for review.
- Excluded account credentials, JWTs, logs, caches, network snapshots, Python caches,
  prebuilt runtimes, platform binaries and the original upload archive.
- Added public-repository security, privacy, dependency and CI documentation.

## 1.0.0 (working package)

- Extension version locked to 1.0.0.
- Native host cleanup covers Chrome, Edge and Chromium registrations.
- Cleanup restores the browser proxy to DIRECT before removing local components.
