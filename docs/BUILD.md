# Build and release boundary

The public repository intentionally does not contain the installed Windows
runtime. The original working package mixed a PyInstaller executable, a private
Python environment, downloaded node data, machine-specific paths, logs and
Firefox credentials. Reusing that directory as a public release would be unsafe
and would not be reproducible.

## What a future release build must do

1. Pin the upstream backend to an immutable commit and record the source hash.
2. Build a fresh 64-bit Windows runtime from reviewed source with a supported
   Python/uv version and a dependency lock or hashes. Besides the Python
   dependencies in `requirements.txt`, a release build must also provide
   Playwright and its Firefox browser build (declared in
   `vendor/firefox-ip-protection-pool/requirements-bootstrap.txt`, roughly 80 MB
   into the runtime's `pw-browsers` directory). They are what the in-app browser
   login drives, and the login script launches Firefox on purpose because Fastly
   flags headless Chromium fingerprints far more often. Installing them is
   optional at runtime: without them only the browser-login button is
   unavailable, and every other feature keeps working.
3. Generate the Native Messaging manifest at install time with the actual
   runtime path and the fixed extension ID.
4. Keep credentials in a per-user private directory; never copy them from the
   source tree or include them in logs, diagnostics or artifacts.
5. Register only the browser chosen by the user and restore only settings owned
   by the extension. It must not reset global WinHTTP proxy state or terminate
   unrelated processes by image name.
6. Run the public-tree audit, a binary secret scan, dependency/license review,
   SBOM generation and clean Windows smoke tests before signing an artifact.

Until those steps are implemented and reviewed, this repository should be used
for source review and loading the unpacked extension only. Do not advertise it
as a standalone VPN installer.

The repair script intentionally refuses a source-only checkout. Chrome's
Native Messaging manifest points to one executable binary; it does not provide
an `args` field for launching `python native_host.py`. Registering `python.exe`
with an ignored `args` field makes Chrome start Python without the host script,
which results in a native messaging communication error.
