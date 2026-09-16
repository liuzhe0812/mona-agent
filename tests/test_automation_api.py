from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

import mona.agent.user_config as user_config_module
import mona.api.server as server_module
import mona.computer_use.runtime as runtime_module
from mona.agent.user_config import AgentUserConfig
from mona.api.server import create_app


class FakeComputerManager:
    def __init__(self) -> None:
        self.executable = None
        self.connection_error = None
        self.start_install = AsyncMock()
        self.cancel_install = AsyncMock()
        self.refresh_health = AsyncMock()
        self.grant_permissions = AsyncMock()
        self.mcp_config = MagicMock(return_value=object())

    def set_connection_result(self, error: str | None) -> None:
        self.connection_error = error

    def status(self, *, enabled: bool) -> dict:
        return {
            "enabled": enabled,
            "state": (
                "disabled"
                if not enabled
                else (
                    "not_installed"
                    if self.executable is None
                    else ("error" if self.connection_error else "available")
                )
            ),
            "supported": True,
            "version": "0.23.2",
            "downloadBytes": 100,
            "installed": self.executable is not None,
            "job": None,
        }


@pytest_asyncio.fixture
async def automation_client(monkeypatch: pytest.MonkeyPatch):
    manager = FakeComputerManager()
    permission = {"computer": False}

    monkeypatch.setattr(
        server_module,
        "_computer_use_permission_enabled",
        lambda _agent_id="mona": permission["computer"],
    )
    monkeypatch.setattr(
        server_module,
        "_browser_automation_permission_enabled",
        lambda: True,
    )
    monkeypatch.setattr(runtime_module, "get_cua_driver_manager", lambda: manager)
    monkeypatch.setattr(server_module, "_start_computer_activation_watch", MagicMock())

    agent_loop = SimpleNamespace(
        _mcp_servers={},
        _mcp_stacks={},
        add_mcp_server=AsyncMock(return_value={"ok": True}),
        remove_mcp_server=AsyncMock(return_value={"ok": True}),
    )
    app = create_app(agent_loop)
    app.on_startup.clear()
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        yield client, manager, permission, agent_loop
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_automation_status_reports_browser_and_computer_defaults(automation_client) -> None:
    client, _manager, _settings, _agent_loop = automation_client

    response = await client.get("/api/automation/status")

    assert response.status == 200
    payload = await response.json()
    assert payload["browserAutomationEnabled"] is True
    assert payload["computerUse"]["state"] == "disabled"


@pytest.mark.asyncio
async def test_partner_automation_status_uses_the_partner_permission_without_main_mcp_mutation(
    automation_client,
) -> None:
    client, manager, permission, agent_loop = automation_client
    permission["computer"] = True
    manager.executable = object()
    manager.refresh_health.return_value = {"state": "available"}

    response = await client.get("/api/automation/status?agent_id=com.mona.musician")

    assert response.status == 200
    assert (await response.json())["computerUse"]["enabled"] is True
    agent_loop.add_mcp_server.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.asyncio
async def test_first_computer_enable_starts_download(automation_client) -> None:
    client, manager, permission, _agent_loop = automation_client
    permission["computer"] = True

    response = await client.post("/api/automation/computer", json={"enabled": True})

    assert response.status == 202
    manager.start_install.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_computer_disable_removes_runtime_server(automation_client) -> None:
    client, _manager, permission, agent_loop = automation_client
    from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME

    agent_loop._mcp_servers[BUILTIN_COMPUTER_SERVER_NAME] = object()

    response = await client.post("/api/automation/computer", json={"enabled": False})

    assert response.status == 200
    assert permission["computer"] is False
    agent_loop.remove_mcp_server.assert_awaited_once_with(BUILTIN_COMPUTER_SERVER_NAME)


@pytest.mark.asyncio
async def test_computer_retry_clears_stale_connection_error(automation_client) -> None:
    client, manager, permission, agent_loop = automation_client
    from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME

    manager.executable = object()
    permission["computer"] = True
    manager.connection_error = "previous connection failed"
    manager.refresh_health.return_value = {
        **manager.status(enabled=True),
        "state": "available",
        "error": None,
    }

    response = await client.post("/api/automation/computer", json={"enabled": True})

    assert response.status == 200
    assert manager.connection_error is None
    manager.refresh_health.assert_awaited_once_with(force=True)
    agent_loop.add_mcp_server.assert_awaited_once_with(
        BUILTIN_COMPUTER_SERVER_NAME,
        manager.mcp_config.return_value,
    )


@pytest.mark.asyncio
async def test_computer_runtime_cannot_enable_before_agent_permission(automation_client) -> None:
    client, manager, permission, _agent_loop = automation_client

    response = await client.post("/api/automation/computer", json={"enabled": True})

    assert permission["computer"] is False
    assert response.status == 409
    manager.start_install.assert_not_awaited()


@pytest.mark.asyncio
async def test_legacy_automation_switches_migrate_to_agent_permissions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = AgentUserConfig(
        revision=2,
        granted_tools=["browser_open", "read_file"],
    )
    save = MagicMock(return_value=config)
    write_legacy = AsyncMock()
    refresh = MagicMock()
    monkeypatch.setattr(
        server_module,
        "_automation_settings",
        AsyncMock(
            return_value={
                "browserAutomationEnabled": False,
                "computerUseEnabled": True,
            }
        ),
    )
    monkeypatch.setattr(server_module, "_set_automation_settings", write_legacy)
    monkeypatch.setattr(user_config_module, "load_agent_user_config", lambda _agent_id: config)
    monkeypatch.setattr(user_config_module, "save_agent_user_config", save)
    app = {
        "agent_loop": SimpleNamespace(
            tools=SimpleNamespace(tool_names=["browser_open", "read_file"]),
            _refresh_mona_user_config=refresh,
        )
    }

    await server_module._migrate_legacy_automation_permissions(app)

    update = save.call_args.args[1]
    granted = set(update["granted_tools"])
    assert "browser_open" not in granted
    assert set(runtime_module.COMPUTER_PERMISSION_TOOL_NAMES) <= granted
    refresh.assert_called_once_with()
    write_legacy.assert_awaited_once_with(
        browserAutomationEnabled=True,
        computerUseEnabled=False,
    )


@pytest.mark.asyncio
async def test_low_level_automation_permissions_migrate_to_facades(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = AgentUserConfig(
        revision=3,
        granted_tools=[
            "browser_read",
            "browser_click",
            "computer_get_desktop_state",
            "computer_click",
            "read_file",
        ],
    )
    save = MagicMock(return_value=config)
    write_legacy = AsyncMock()
    monkeypatch.setattr(
        server_module,
        "_automation_settings",
        AsyncMock(
            return_value={
                "browserAutomationEnabled": True,
                "computerUseEnabled": False,
            }
        ),
    )
    monkeypatch.setattr(server_module, "_set_automation_settings", write_legacy)
    monkeypatch.setattr(user_config_module, "load_agent_user_config", lambda _agent_id: config)
    monkeypatch.setattr(user_config_module, "save_agent_user_config", save)
    refresh = MagicMock()
    app = {
        "agent_loop": SimpleNamespace(
            tools=SimpleNamespace(tool_names=[]),
            _refresh_mona_user_config=refresh,
        )
    }

    await server_module._migrate_legacy_automation_permissions(app)

    granted = set(save.call_args.args[1]["granted_tools"])
    assert {"browser_observe", "browser_act"} <= granted
    assert set(runtime_module.COMPUTER_PERMISSION_TOOL_NAMES) <= granted
    assert "browser_read" not in granted
    assert "computer_click" not in granted
    refresh.assert_called_once_with()
    write_legacy.assert_not_awaited()
