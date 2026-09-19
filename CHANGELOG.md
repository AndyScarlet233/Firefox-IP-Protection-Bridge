# Changelog

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
