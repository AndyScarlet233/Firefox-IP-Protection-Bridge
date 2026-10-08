# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the Native Messaging bridge.

Chrome starts a native host by executable path and offers no way to pass
arguments, so `host/native_host.py` has to be frozen into a single executable
before it can be registered. Built by `.github/workflows/build-bridge.yml` on a
tag and by `scripts/build-bridge.ps1` locally; both produce the same artifact.

`console=True` is deliberate. The host speaks its protocol on stdin/stdout, and
a windowed build would give it no usable standard handles. The frozen host runs
with CREATE_NO_WINDOW when it is launched from the extension, so no console is
ever shown to the user.
"""

from pathlib import Path

# SPECPATH is the directory holding this spec file (tools/bridge-rebuild), so the
# repository root is two levels up regardless of where the build is invoked from.
REPO_ROOT = Path(SPECPATH).resolve().parents[1]
SOURCE = REPO_ROOT / "host" / "native_host.py"

if not SOURCE.is_file():
    raise SystemExit(f"native host source not found: {SOURCE}")

a = Analysis(
    [str(SOURCE)],
    pathex=[str(REPO_ROOT)],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="vpn_bridge_host",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
