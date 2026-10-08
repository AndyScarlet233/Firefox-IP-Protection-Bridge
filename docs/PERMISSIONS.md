# Permission review

The extension's Manifest V3 permissions are intentionally recorded here because
this is a high-trust browser component. The table below is kept in sync with
`extension/manifest.json`; if the two ever disagree, the manifest is the source of
truth and this document is the bug.

Declared in `permissions`:

| Permission | Use in this project |
|---|---|
| `proxy` | Install a route-scoped PAC script and restore DIRECT on stop/failure. |
| `storage` | Store routing and preference settings. |
| `nativeMessaging` | Talk to the local bridge; the bridge owns credential handling. |
| `activeTab` | Read the active tab hostname for a site-specific route rule. |
| `privacy` | Apply or clear WebRTC and legacy network privacy settings. |
| `declarativeNetRequestWithHostAccess` | Add route-scoped DNS prefetch response-header rules and the region-shield header rule. |
| `contentSettings` | Block precise geolocation while region protection is active. |
| `scripting` | Run the page diagnostic in the active HTTP(S) tab and push the region configuration into open tabs. |
| `management` | Complete the user-confirmed self-uninstall flow. |
| `alarms` | Drive the periodic VPN health check that reconciles a dead helper. |

Declared in `host_permissions`:

| Host access | Use in this project |
|---|---|
| `<all_urls>` | Apply route and optional region-shield behaviour to web pages. |

## Notes

- `contentSettings` is used for `location` only: region protection sets
  `location` to `block` and clears it again when protection is switched off.
- `scripting` is used with `chrome.tabs.query`, which is why the active-tab
  hostname is read through `activeTab` rather than through a broad `tabs`
  permission. No `tabs` permission is requested.
- `alarms` schedules a one-minute periodic check so a helper that died without
  clearing the proxy can be reconciled instead of leaving the browser pointed at
  a dead listener.

## Content scripts

The two content scripts run at document start in all frames. One stays in an
isolated world and one patches selected page-visible locale, time-zone and font
APIs in the main world. This design can affect web compatibility and should be
reviewed as carefully as any other extension with main-world code.
