# Building the bridge

The public repository intentionally does not contain the installed Windows
runtime. The original working package mixed a PyInstaller executable, a private
Python environment, downloaded node data, machine-specific paths, logs and
Firefox credentials. Reusing that directory as a public release would be unsafe
and would not be reproducible.

## Why the bridge has to be frozen at all

Chrome's Native Messaging manifest points at one executable binary and provides
no `args` field. Registering `python.exe` with the script path in a field Chrome
ignores makes Chrome start Python without the host script, which surfaces as a
native messaging communication error. The Python source therefore has to become
a single `.exe` before it can be registered.

The frozen binary is a thin protocol shim. It speaks the length-prefixed JSON
framing on stdio and then shells out to the interpreter recorded in
`system_python.txt` to run the pool, the renewal job and the browser login. Both
halves are required: Python alone leaves Chrome with nothing to launch, and the
executable alone cannot run the pool.

## Building

`.github/workflows/build-bridge.yml` runs on a `windows-latest` runner. It
installs PyInstaller, builds from `tools/bridge-rebuild/vpn_bridge_host.spec`,
runs `scripts/smoke_native_host.py` against the result, and writes
`bridge-build.json`. Pushing a `v*` tag attaches the executable and the manifest
to the GitHub Release; a manual run from the Actions tab produces the same files
as a build artifact.

The smoke test is not decorative. A frozen binary can compile cleanly and still
die at startup on a missing hidden import or a path that only resolves in a
source checkout, so the workflow opens a pipe to the executable and exchanges
two real commands over it. Every read runs under a watchdog that kills a host
that stops answering, so a hang fails the step instead of stalling the job.

To build the same artifact locally:

```powershell
python -m pip install "pyinstaller>=6.0"
python -m PyInstaller --noconfirm --clean --distpath dist --workpath build tools/bridge-rebuild/vpn_bridge_host.spec
python scripts/smoke_native_host.py dist/vpn_bridge_host.exe
python scripts/write_bridge_build_manifest.py dist/vpn_bridge_host.exe --out dist/bridge-build.json
```

## What the manifest records, and why line endings matter

`bridge-build.json` carries `bridgeVersion` plus the SHA-256 of
`host/native_host.py` and of the executable. The setup script refuses to
register a bridge whose recorded hashes do not match the files on disk, which is
what stops a rebuilt executable from being paired with a stale source tree.

`.gitattributes` pins text files to LF for that reason. Git for Windows defaults
to `core.autocrlf=true`, so without it the same commit checks out as CRLF on
Windows and LF elsewhere, and the two produce different source hashes for
identical content.

## What a release build still has to add

The workflow produces the executable. A complete, installable distribution needs
more than that, and none of it is automated yet:

1. Pin the upstream backend to an immutable commit and record the source hash.
2. Provide the Python dependencies from
   `vendor/firefox-ip-protection-pool/requirements.txt` in the runtime's
   `packages` directory, and a supported 64-bit Python for the pool to run under.
3. Provide Playwright and its Firefox build for the in-app browser login
   (`vendor/firefox-ip-protection-pool/requirements-bootstrap.txt`, roughly 80 MB
   into the runtime's `pw-browsers` directory). Installing them is optional at
   runtime: without them only the browser-login button is unavailable, and every
   other feature keeps working. The login script launches Firefox on purpose,
   because Fastly flags headless Chromium fingerprints far more often.
4. Generate the Native Messaging manifest at install time with the actual runtime
   path and the fixed extension ID, and write `system_python.txt` for the
   interpreter that was found.
5. Keep credentials in a per-user private directory; never copy them from the
   source tree or include them in logs, diagnostics or artifacts.
6. Register only the browser chosen by the user and restore only settings owned
   by the extension. It must not reset global WinHTTP proxy state or terminate
   unrelated processes by image name.
7. Run the public-tree audit, a binary secret scan, dependency/license review,
   SBOM generation and clean Windows smoke tests before signing an artifact.

`scripts/install-or-repair.ps1` registers a host that has already been placed in
the runtime directory; it deliberately does not assemble one, so it stops with a
pointer to this document when the runtime is missing.
