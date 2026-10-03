# Changelog

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
