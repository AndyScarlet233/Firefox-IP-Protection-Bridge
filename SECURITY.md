# Security policy

## Scope

This project is an unofficial prototype that reads a user's own Firefox IP
Protection session state through a local native host. It is not a Mozilla,
Google or Fastly product.

## Do not publish credentials

Never commit or paste any of the following into an issue, pull request, log or
support message:

- Firefox Account session or renewal credentials;
- ProxyPass JWTs, OAuth access tokens or cookies;
- proxy listener passwords or API keys;
- browser profile exports, screenshots or local installation logs.

The public tree intentionally excludes `runtime/`, token files, generated data,
logs, archives and binaries. The repository's audit script and CI check enforce
those exclusions, but a clean review is still required before every release.

If a credential was ever placed in a shared archive or repository, assume it is
compromised: revoke the Firefox session, rotate related credentials, remove all
copies and inspect the complete Git history. Deleting the current file alone is
not sufficient after a push.

## How the browser-login password is handled

Since 1.1.0 the popup can sign in to a Mozilla account directly, which means an
account password briefly exists on the machine. The design keeps its exposure as
small as the flow allows:

- The password is typed into Chromium's own input fields and travels in-process
  (`chrome.runtime.sendMessage` → service worker → `sendNativeMessage` → local
  native host). It is not sent anywhere by the extension itself.
- The host hands it to the login child process through a single-use file in the
  local runtime's token directory. That file is written with an owner-only ACL
  (inherited permissions removed, so other local accounts cannot read it) and the
  Windows hidden attribute, and the child deletes it immediately on read.
- It is never passed as a command-line argument, never written to a log, never
  written to `chrome.storage`, and never written to the progress heartbeat file.
- The emailed confirmation code, the TOTP code, and the captcha answer use the
  same one-shot file and the same deletion-on-read rule.
- The resulting session token stays in the local runtime and is never returned to
  the extension.

Full details are in [`PRIVACY.md`](PRIVACY.md). If you find a path where any of
the above does not hold — a log line, an argument, an error message, or a
temporary file that survives — treat it as a security issue and report it
privately rather than opening a public issue with a reproduction that contains
real account data.

## Reporting

Please report security issues privately to the repository owner rather than
including secret material in a public issue. Redact tokens and use a synthetic
example when reproducing a problem.

**Never paste credentials into an issue, pull request, log, or support message.**
That includes account passwords, verification codes, session or renewal
credentials, ProxyPass JWTs, OAuth access tokens, cookies, and browser profile
exports. When a report needs to show what went wrong, replace every one of those
values with an obvious placeholder such as `REDACTED` or `user@example.com`.

## Release requirements

A Windows runtime or installer must be built separately from this source tree,
scanned for secrets, supplied with complete third-party notices, and reviewed
for its Native Messaging registry and proxy-cleanup side effects before it is
published as a release artifact.
