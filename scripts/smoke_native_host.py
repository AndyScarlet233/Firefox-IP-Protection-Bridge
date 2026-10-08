#!/usr/bin/env python3
"""Smoke-test a built Native Messaging bridge over the real stdio protocol.

Chrome talks to a native host by writing a 4-byte little-endian length followed
by UTF-8 JSON on stdin and reading the same framing back on stdout. This script
reproduces that framing against the built executable, because a frozen binary
can compile successfully and still die at startup (a missing hidden import, a
path assumption that only holds in a source checkout). Talking to it is the
cheapest way to prove the artifact actually works.

Every read is bounded by a watchdog thread that kills the host at the deadline,
so a hung binary fails the step instead of stalling the whole job.

Usage:  python scripts/smoke_native_host.py path/to/vpn_bridge_host.exe
Exit code 0 means the host answered a status command correctly.
"""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

TIMEOUT_SECONDS = 90.0
MAX_MESSAGE_BYTES = 1024 * 1024


class SmokeFailure(Exception):
    """A check failed; the message is already user-facing."""


def send(proc: subprocess.Popen, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    assert proc.stdin is not None
    proc.stdin.write(struct.pack("=I", len(body)))
    proc.stdin.write(body)
    proc.stdin.flush()


def receive(proc: subprocess.Popen, timeout: float) -> dict:
    """Read one framed message, killing the host if it does not arrive in time."""
    outcome: dict[str, object] = {}

    def read_message() -> None:
        try:
            assert proc.stdout is not None
            header = proc.stdout.read(4)
            if len(header) != 4:
                outcome["error"] = "the host closed its output without replying"
                return
            (size,) = struct.unpack("=I", header)
            if not 0 < size <= MAX_MESSAGE_BYTES:
                outcome["error"] = f"implausible message size {size}"
                return
            body = proc.stdout.read(size)
            if len(body) != size:
                outcome["error"] = "the host sent a truncated message"
                return
            outcome["payload"] = json.loads(body.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - surfaced verbatim below
            outcome["error"] = f"{type(exc).__name__}: {exc}"

    reader = threading.Thread(target=read_message, daemon=True)
    reader.start()
    reader.join(timeout)
    if reader.is_alive():
        proc.kill()
        raise SmokeFailure(f"the host did not reply within {timeout:.0f}s")
    if "error" in outcome:
        raise SmokeFailure(str(outcome["error"]))
    payload = outcome.get("payload")
    if not isinstance(payload, dict):
        raise SmokeFailure(f"reply is not a JSON object: {payload!r}")
    return payload


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: smoke_native_host.py <path to vpn_bridge_host.exe>", file=sys.stderr)
        return 2
    exe = Path(sys.argv[1]).resolve()
    if not exe.is_file():
        print(f"FAIL  not a file: {exe}", file=sys.stderr)
        return 2

    proc = subprocess.Popen(
        [str(exe)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        send(proc, {"id": 1, "command": "status"})
        response = receive(proc, TIMEOUT_SECONDS)
        if response.get("ok") is not True:
            raise SmokeFailure(f"status returned ok=false: {response.get('error')!r}")
        status = response.get("status")
        if not isinstance(status, dict):
            raise SmokeFailure(f"status payload missing: {response!r}")
        version = status.get("bridgeVersion")
        if not isinstance(version, str) or not version:
            raise SmokeFailure(f"bridgeVersion missing from status: {status!r}")

        # A second command proves the host keeps serving after its first reply
        # instead of exiting once Chrome would have sent a follow-up.
        send(proc, {"id": 2, "command": "bootstrap_status"})
        second = receive(proc, TIMEOUT_SECONDS)
        if second.get("ok") is not True or "bootstrap" not in second:
            raise SmokeFailure(f"bootstrap_status did not answer correctly: {second!r}")
    except SmokeFailure as failure:
        proc.kill()
        stderr = b""
        try:
            stderr = proc.stderr.read() or b""
        except Exception:  # noqa: BLE001
            pass
        print(f"FAIL  {failure}", file=sys.stderr)
        text = stderr.decode("utf-8", "replace").strip()
        if text:
            print(f"--- host stderr ---\n{text[-1500:]}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        proc.kill()
        print(f"FAIL  transport error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    try:
        proc.stdin.close()
    except Exception:  # noqa: BLE001
        pass
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()

    print(f"PASS  bridge {version} answered status and bootstrap_status over stdio")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
