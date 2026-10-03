from __future__ import annotations

import importlib.util
import tempfile
import unittest
import unittest.mock
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
_STATE_PATH = ROOT / "runtime" / "firefox-ip-protection-pool" / "refresh_state.py"

spec = importlib.util.spec_from_file_location("refresh_state_under_test", _STATE_PATH)
assert spec is not None and spec.loader is not None
refresh_state = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh_state)


class DescribeRefreshProxyTests(unittest.TestCase):
    def test_direct_label(self) -> None:
        self.assertEqual(refresh_state.describe_refresh_proxy(None), "direct")
        self.assertEqual(refresh_state.describe_refresh_proxy(""), "direct")

    def test_credentials_are_stripped(self) -> None:
        label = refresh_state.describe_refresh_proxy("http://user:secret@127.0.0.1:7890")
        self.assertNotIn("secret", label)
        self.assertIn("127.0.0.1:7890", label)


class ResolveRefreshProxyTests(unittest.TestCase):
    def setUp(self) -> None:
        self._env_patch = patch.dict(refresh_state.os.environ, {}, clear=False)
        self._env_patch.start()
        self.addCleanup(self._env_patch.stop)
        refresh_state.os.environ.pop("IPP_REFRESH_PROXY", None)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tokens = Path(self._tmp.name) / "tokens"
        tokens.mkdir()
        proxy_file = tokens / "refresh_proxy.txt"
        self.proxy_file = proxy_file
        patcher = patch.object(refresh_state, "REFRESH_PROXY_FILE", proxy_file)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_env_var_wins(self) -> None:
        self.proxy_file.write_text("http://127.0.0.1:9999\n", encoding="utf-8")
        refresh_state.os.environ["IPP_REFRESH_PROXY"] = "http://127.0.0.1:7890"
        self.assertEqual(refresh_state.resolve_refresh_proxy(), "http://127.0.0.1:7890")

    def test_config_file_is_used_without_env(self) -> None:
        self.proxy_file.write_text('  "http://127.0.0.1:7897"  \n', encoding="utf-8")
        self.assertEqual(refresh_state.resolve_refresh_proxy(), "http://127.0.0.1:7897")

    def test_unsupported_scheme_is_ignored(self) -> None:
        self.proxy_file.write_text("socks5://127.0.0.1:1080\n", encoding="utf-8")

        def closed_port(*_args, **_kwargs):
            raise OSError("closed")

        with patch.object(refresh_state.socket, "create_connection", side_effect=closed_port):
            self.assertIsNone(refresh_state.resolve_refresh_proxy())

    def test_rotator_is_used_when_listening(self) -> None:
        connection = unittest.mock.MagicMock()
        with patch.object(refresh_state.socket, "create_connection", return_value=connection):
            self.assertEqual(refresh_state.resolve_refresh_proxy(), "http://127.0.0.1:8080")

    def test_direct_fallback(self) -> None:
        def closed_port(*_args, **_kwargs):
            raise OSError("closed")

        with patch.object(refresh_state.socket, "create_connection", side_effect=closed_port):
            self.assertIsNone(refresh_state.resolve_refresh_proxy())


if __name__ == "__main__":
    unittest.main()
