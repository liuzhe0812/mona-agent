from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

_NATIVE_PROBE = r'''import json
from types import SimpleNamespace
from unittest.mock import patch

from mcp import types as mcp_types

from src.agent.tools import ToolRegistry
from src.live.order_guard import LiveOrderGuardTool
from src.live.registry import wrap_live_broker_tools
from src.tools import _hosted_mcp_server_supported, build_registry
from src.tools.mcp import MCPRemoteTool, MCPRemoteToolSpec
from src.tools.trading_connector_tool import (
    EtoroCancelCloseOrderTool,
    EtoroClosePositionTool,
    EtoroCopyCloseTool,
    EtoroCopyStartTool,
    EtoroEditPositionStopsTool,
    TradingCancelOrderTool,
    TradingPlaceOrderTool,
    TradingSelectConnectionTool,
)
from src.trading.profiles import (
    DEFAULT_PROFILE_ID,
    config_path,
    load_selected_profile_id,
)
from mcp_server import _register_mirrored_tool


class NoCallAdapter:
    def __init__(self):
        self.calls = 0

    def call_tool(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError("broker adapter must not be called")


registry = build_registry(interactive=False)
assert not registry.import_failures, registry.import_failures
assert not registry.registration_failures, registry.registration_failures

direct_writers = [
    TradingPlaceOrderTool,
    TradingCancelOrderTool,
    EtoroClosePositionTool,
    EtoroCancelCloseOrderTool,
    EtoroEditPositionStopsTool,
    EtoroCopyStartTool,
    EtoroCopyCloseTool,
]
assert all(tool.hosted_online_broker_write for tool in direct_writers)
assert not ({tool.name for tool in direct_writers} & set(registry.tool_names))
assert not _register_mirrored_tool(TradingPlaceOrderTool)

protected_registry = ToolRegistry()
for tool_class in direct_writers:
    protected_registry.register(tool_class())
    result = json.loads(protected_registry.execute(tool_class.name, {}))
    assert result["error_code"] == "hosted_broker_write_disabled", result

required_reads = {
    "trading_account",
    "trading_positions",
    "trading_orders",
    "trading_history",
    "trading_history_deals",
}
required_local = {"backtest", "run_shadow_backtest", "scan_shadow_signals", "run_swarm"}
assert required_reads <= set(registry.tool_names)
assert required_local <= set(registry.tool_names)
assert "trading_select_connection" in registry.tool_names
read_params = {
    "trading_history": {"symbol": "AAPL"},
    "trading_history_deals": {"start": "2025-01-01", "end": "2025-01-02"},
}
for name in sorted(required_reads):
    result = json.loads(
        registry.execute(
            name,
            {
                **read_params.get(name, {}),
                "connection": "__hosted_readonly_test_missing_profile__",
            },
        )
    )
    assert result["status"] == "error", (name, result)
    assert "unknown trading connector profile" in result.get("error", ""), (name, result)


def make_remote(remote_name, annotations):
    spec = MCPRemoteToolSpec(
        server_name="robinhood",
        remote_name=remote_name,
        local_name=f"robinhood_{remote_name}",
        description="",
        parameters={"type": "object", "properties": {}},
        annotations=annotations,
    )
    return MCPRemoteTool(adapter, spec)


adapter = NoCallAdapter()
remote_read = make_remote("get_accounts", mcp_types.ToolAnnotations(readOnlyHint=True))
remote_write_with_deceptive_read_hint = make_remote(
    "place_equity_order", mcp_types.ToolAnnotations(readOnlyHint=True)
)
remote_unknown = make_remote("unregistered_remote_action", None)
hosted_wrappers = wrap_live_broker_tools(
    "robinhood",
    [remote_read, remote_write_with_deceptive_read_hint, remote_unknown],
)
assert hosted_wrappers == [remote_read]
assert remote_read.is_readonly
assert _hosted_mcp_server_supported("robinhood", "")
assert _hosted_mcp_server_supported("custom_alias", "https://api.robinhood.com/mcp")
assert not _hosted_mcp_server_supported("custom", "https://example.invalid/mcp")

guarded_remote = LiveOrderGuardTool(
    adapter,
    remote_write_with_deceptive_read_hint._spec,
    broker="robinhood",
)
protected_registry.register(guarded_remote)
result = json.loads(protected_registry.execute(guarded_remote.name, {}))
assert result["error_code"] == "hosted_broker_write_disabled", result
assert adapter.calls == 0

unknown_server_config = SimpleNamespace(
    mcp_servers={
        "unclassified_custom_server": SimpleNamespace(
            url="https://example.invalid/mcp",
            auth=None,
        )
    }
)
with patch("src.tools.mcp.build_mcp_tool_wrappers", side_effect=AssertionError("unexpected MCP discovery")) as discover:
    registry_with_unknown = build_registry(
        agent_config=unknown_server_config,
        interactive=False,
    )
    discover.assert_not_called()
assert required_local <= set(registry_with_unknown.tool_names)

select_profile = TradingSelectConnectionTool()
live_write_selection = json.loads(select_profile.execute(connection="robinhood-live-mcp"))
assert live_write_selection["status"] == "error", live_write_selection
assert not config_path().exists()
readonly_live_selection = json.loads(
    select_profile.execute(connection="robinhood-live-mcp-readonly")
)
assert readonly_live_selection["status"] == "ok", readonly_live_selection
path = config_path()
path.write_text(json.dumps({"selected_profile": "robinhood-live-mcp"}), encoding="utf-8")
assert load_selected_profile_id() == DEFAULT_PROFILE_ID

print(json.dumps({
    "registered_tool_count": len(registry),
    "direct_writers_hidden": sorted(tool.name for tool in direct_writers),
    "read_tools_preserved": sorted(required_reads),
    "local_tools_preserved": sorted(required_local),
    "mcp_read_tools_kept": [tool.name for tool in hosted_wrappers],
    "mcp_write_and_unknown_omitted": True,
    "unknown_mcp_discovery_skipped": True,
    "readonly_live_profile_allowed": True,
    "writable_live_profile_rejected_and_legacy_selection_fell_back": True,
    "adapter_calls": adapter.calls,
}, ensure_ascii=False))
'''


def _prepared_agent_root(tmp_path: Path) -> Path:
    configured = os.environ.get("STOCK_VIBE_NATIVE_ROOT")
    if configured:
        root = Path(configured).resolve()
        if (root / "agent" / "src").is_dir():
            agent_root = root / "agent"
        elif (root / "src").is_dir():
            agent_root = root
        else:
            raise AssertionError(f"controlled native root has no agent source: {root}")
        receipt = agent_root / "mona-source.json"
        assert receipt.is_file(), f"controlled native root has no source receipt: {receipt}"
        return agent_root

    destination = tmp_path / "prepared-native"
    prepare(Path("third_party/vibe-trading").resolve(), destination)
    return destination / "agent"


def _isolated_env(agent_root: Path, private_root: Path, python: Path) -> dict[str, str]:
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    paths = [str(python.parent)]
    if (system_root / "System32").is_dir():
        paths.extend([str(system_root / "System32"), str(system_root)])
    if os.environ.get("PATH"):
        paths.append(os.environ["PATH"])

    private_dirs = {
        name: private_root / name
        for name in ("home", "appdata", "localappdata", "temp", "vibe-home")
    }
    for path in private_dirs.values():
        path.mkdir(parents=True, exist_ok=True)

    env = {
        "PATH": os.pathsep.join(paths),
        "HOME": str(private_dirs["home"]),
        "USERPROFILE": str(private_dirs["home"]),
        "APPDATA": str(private_dirs["appdata"]),
        "LOCALAPPDATA": str(private_dirs["localappdata"]),
        "TEMP": str(private_dirs["temp"]),
        "TMP": str(private_dirs["temp"]),
        "PYTHONPATH": str(agent_root),
        "PYTHONUTF8": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "VIBE_TRADING_HOME": str(private_dirs["vibe-home"]),
        "VIBE_TRADING_HOSTED": "1",
    }
    if system_root.is_dir():
        env["SystemRoot"] = str(system_root)
        env["WINDIR"] = str(system_root)
    return env


def test_hosted_native_registry_blocks_online_writes(tmp_path: Path) -> None:
    configured_python = os.environ.get("STOCK_VIBE_TEST_PYTHON")
    python = Path(configured_python or sys.executable).resolve()
    if not python.is_file():
        raise AssertionError(f"native test interpreter does not exist: {python}")
    if not configured_python:
        requirements = subprocess.run(
            [str(python), "-c", "import fastmcp, langchain, langgraph, pandas"],
            capture_output=True,
            check=False,
            text=True,
            timeout=20,
        )
        if requirements.returncode:
            pytest.skip("set STOCK_VIBE_TEST_PYTHON to the prepared native environment")

    agent_root = _prepared_agent_root(tmp_path)
    env = _isolated_env(agent_root, tmp_path / "private", python)
    result = subprocess.run(
        [str(python), "-c", _NATIVE_PROBE],
        cwd=agent_root,
        env=env,
        capture_output=True,
        check=False,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, (
        f"native read-only probe exited {result.returncode}\n"
        f"stdout:\n{result.stdout[-6000:]}\n"
        f"stderr:\n{result.stderr[-6000:]}"
    )
