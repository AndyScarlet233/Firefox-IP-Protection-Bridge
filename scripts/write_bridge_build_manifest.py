#!/usr/bin/env python3
"""Write bridge-build.json for a freshly frozen bridge.

The Windows setup script refuses to register a bridge whose recorded hashes do
not match the files on disk, which is what stops a rebuilt executable from being
paired with a stale source tree. This produces that manifest from the two files
that actually matter: host/native_host.py and the frozen executable.

Usage:
  python scripts/write_bridge_build_manifest.py <exe> [--out bridge-build.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE = REPO_ROOT / "host" / "native_host.py"
VERSION_RE = re.compile(r'^BRIDGE_VERSION\s*=\s*"([^"]+)"', re.MULTILINE)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", help="path to the frozen vpn_bridge_host.exe")
    parser.add_argument("--out", default="bridge-build.json", help="manifest to write")
    args = parser.parse_args()

    exe = Path(args.executable).resolve()
    if not exe.is_file():
        print(f"FAIL  executable not found: {exe}", file=sys.stderr)
        return 1
    if not SOURCE.is_file():
        print(f"FAIL  source not found: {SOURCE}", file=sys.stderr)
        return 1

    match = VERSION_RE.search(SOURCE.read_text(encoding="utf-8"))
    if not match:
        print("FAIL  BRIDGE_VERSION not found in host/native_host.py", file=sys.stderr)
        return 1
    version = match.group(1)

    manifest = {
        "bridgeVersion": version,
        "source": "native_host.py",
        "sourceSha256": sha256(SOURCE),
        "executable": exe.name,
        "executableSha256": sha256(exe),
    }
    out = Path(args.out)
    out.write_text(json.dumps(manifest, indent=4) + "\n", encoding="utf-8")
    print(f"wrote {out} for bridge {version} ({exe.name}, {exe.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
