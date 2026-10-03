from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
_HOST_PATH = ROOT / "host" / "native_host.py"
_BACKGROUND_PATH = ROOT / "extension" / "background.js"


spec = importlib.util.spec_from_file_location("native_host_under_test", _HOST_PATH)
assert spec is not None and spec.loader is not None
native_host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native_host)


class FakeSocket:
    """Small in-memory socket double; it never opens a real connection."""

    def __init__(self, incoming: bytes, recv_chunk: int = 2) -> None:
        self.incoming = bytearray(incoming)
        self.recv_chunk = recv_chunk
        self.sent: list[bytes] = []
        self.timeouts: list[float] = []
        self.closed = False

    def __enter__(self) -> "FakeSocket":
        return self

    def __exit__(self, *_args: object) -> None:
        self.closed = True

    def settimeout(self, value: float) -> None:
        self.timeouts.append(value)

    def sendall(self, data: bytes) -> None:
        self.sent.append(data)

    def recv(self, size: int) -> bytes:
        if not self.incoming:
            return b""
        count = min(size, self.recv_chunk, len(self.incoming))
        result = bytes(self.incoming[:count])
        del self.incoming[:count]
        return result


class SocksReadinessTests(unittest.TestCase):
    def test_probe_performs_handshake_and_connect_without_network(self) -> None:
        # SOCKS5 success reply with a domain address, deliberately fragmented.
        reply = b"\x05\x00" + b"\x05\x00\x00\x03" + bytes([11]) + b"example.com" + b"\x00\x50"
        fake = FakeSocket(reply, recv_chunk=1)
        with patch.object(native_host.socket, "create_connection", return_value=fake) as connect:
            native_host.socks5_connect_probe("127.0.0.1", 1090)

        connect.assert_called_once_with(("127.0.0.1", 1090), timeout=native_host.SOCKS_PROBE_TIMEOUT)
        self.assertEqual(fake.timeouts, [native_host.SOCKS_PROBE_TIMEOUT])
        self.assertEqual(fake.sent[0], b"\x05\x01\x00")
        self.assertEqual(fake.sent[1], b"\x05\x01\x00\x03\x0bexample.com\x00\x50")
        self.assertTrue(fake.closed)

    def test_probe_rejects_failed_upstream_connect(self) -> None:
        fake = FakeSocket(b"\x05\x00\x05\x01\x00\x01\x7f\x00\x00\x01\x00\x50")
        with patch.object(native_host.socket, "create_connection", return_value=fake):
            with self.assertRaisesRegex(OSError, r"upstream CONNECT failed \(code 1\)"):
                native_host.socks5_connect_probe("127.0.0.1", 1090)

    def test_wait_for_port_requires_socks_readiness_not_tcp_only(self) -> None:
        proc = Mock()
        proc.poll.return_value = None
        with (
            patch.object(native_host, "port_open", side_effect=[True, True]),
            patch.object(native_host, "socks5_connect_probe", side_effect=[OSError("not ready"), None]) as probe,
            patch.object(native_host.time, "monotonic", side_effect=[0.0, 0.1, 0.2]),
            patch.object(native_host.time, "sleep"),
        ):
            self.assertTrue(native_host.wait_for_port("127.0.0.1", 1090, proc, timeout=1.0))
        self.assertEqual(probe.call_count, 2)

    def test_status_reports_probe_health_separately_from_tcp_liveness(self) -> None:
        manager = native_host.PoolManager()
        proc = Mock()
        proc.poll.return_value = None
        manager.proc = proc
        with (
            patch.object(native_host, "port_open", return_value=True),
            patch.object(native_host, "socks5_connect_probe", side_effect=OSError("upstream unavailable")),
            patch.object(manager, "credentials_present", return_value=False),
        ):
            status = manager.status()
        self.assertTrue(status["running"])
        self.assertTrue(status["portOpen"])
        self.assertFalse(status["healthy"])

    def test_probe_falls_back_when_one_target_is_blocked(self) -> None:
        with patch.object(native_host, "socks5_connect_probe", side_effect=[OSError("blocked"), None]) as probe:
            native_host.socks5_connect_probe_any("127.0.0.1", 1090)
        self.assertEqual(probe.call_count, 2)
        self.assertEqual(probe.call_args_list[0].args[2:], ("example.com", 80))

    def test_credentials_present_requires_a_loadable_bundle(self) -> None:
        manager = native_host.PoolManager()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tokens = root / "tokens"
            tokens.mkdir()
            with patch.object(native_host, "UPSTREAM", root):
                (tokens / "session_token.txt").write_text("only-token", encoding="utf-8")
                self.assertFalse(manager.credentials_present())
                (tokens / "renewal_credentials.json").write_text(
                    json.dumps({
                        "schema": 1,
                        "email": "user@example.com",
                        "uid": "a" * 32,
                        "session_token": "b" * 64,
                    }),
                    encoding="utf-8",
                )
                self.assertTrue(manager.credentials_present())
                (tokens / "renewal_credentials.json").write_text("{}", encoding="utf-8")
                self.assertFalse(manager.credentials_present())


class StalePacReconciliationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = _BACKGROUND_PATH.read_text(encoding="utf-8")

    def test_disabled_state_clears_stale_pac_during_status(self) -> None:
        self.assertIn("if (!state.enabled)", self.source)
        self.assertIn("clearChromeProxy()", self.source)

    def test_enabled_state_requires_helper_health_and_extension_owned_pac(self) -> None:
        self.assertIn("helper.healthy === undefined", self.source)
        self.assertIn("helper.running === true && helperHealthy && proxyOwnedByUs", self.source)
        self.assertIn("await failOpenNow(reason, { stopNative: true });", self.source)
        self.assertIn("recovered = true;", self.source)

    def test_start_installs_pac_only_after_readiness_status(self) -> None:
        start = self.source.index("async function startVpnNow")
        status = self.source.index('nativeRequest("status", {}, 15000)', start)
        apply = self.source.index("await applyChromeProxy(nextState);", start)
        self.assertLess(status, apply)
        self.assertIn("status.healthy === true", self.source[status:apply])

    def test_proxy_changes_wait_for_chrome_to_settle(self) -> None:
        self.assertIn("waitForProxyCondition", self.source)
        self.assertIn("Chrome 代理设置未及时生效", self.source)
        self.assertIn("waitForNativePortRelease", self.source)

    def test_dynamic_route_rules_are_replaced_atomically(self) -> None:
        self.assertIn("removeRuleIds: [DNS_PREFETCH_RULE_ID]", self.source)
        self.assertIn("removeRuleIds:[REGION_HEADER_RULE_ID]", self.source)

    def test_ippure_api_hosts_follow_allowlist_route(self) -> None:
        for domain in ("api.ippure.com", "ipinfo.io", "v6.ipinfo.io", "ipapi.co", "myip.ipip.net"):
            self.assertIn(f'"{domain}"', self.source)
        self.assertIn('host.slice(-(d.length + 1))', self.source)


class PopupTransitionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = (ROOT / "extension" / "popup.js").read_text(encoding="utf-8")

    def test_initial_status_and_first_click_show_pending_state(self) -> None:
        self.assertIn('connectionTransition = "loading";', self.source)
        self.assertIn('connectionTransition = next ? "connecting" : "disconnecting";', self.source)
        self.assertIn('connectionCard.classList.toggle("pending", pending);', self.source)
        self.assertIn('power.textContent = loading', self.source)


if __name__ == "__main__":
    unittest.main()
