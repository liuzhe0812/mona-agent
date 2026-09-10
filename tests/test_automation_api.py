from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

import mona.api.server as server_module
import mona.computer_use.runtime as runtime_module
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
    settings = {
        "browserAutomationEnabled": True,
        "computerUseEnabled": False,
    }

    async def read_settings() -> dict[str, bool]:
        return dict(settings)

    async def write_settings(**updates: bool) -> dict[str, bool]:
        settings.update(updates)
        return dict(settings)

    monkeypatch.setattr(server_module, "_automation_settings", read_settings)
    monkeypatch.setattr(server_module, "_set_automation_settings", write_settings)
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
        yield client, manager, settings, agent_loop
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
async def test_browser_automation_toggle_persists(automation_client) -> None:
    client, _manager, settings, _agent_loop = automation_client

    response = await client.post("/api/automation/browser", json={"enabled": False})

    assert response.status == 200
    assert settings["browserAutomationEnabled"] is False


@pytest.mark.asyncio
async def test_first_computer_enable_starts_download(automation_client) -> None:
    client, manager, settings, _agent_loop = automation_client

    response = await client.post("/api/automation/computer", json={"enabled": True})

    assert response.status == 202
    assert settings["computerUseEnabled"] is True
    manager.start_install.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_computer_disable_removes_runtime_server(automation_client) -> None:
    client, _manager, settings, agent_loop = automation_client
    from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME

    settings["computerUseEnabled"] = True
    agent_loop._mcp_servers[BUILTIN_COMPUTER_SERVER_NAME] = object()

    response = await client.post("/api/automation/computer", json={"enabled": False})

    assert response.status == 200
    assert settings["computerUseEnabled"] is False
    agent_loop.remove_mcp_server.assert_awaited_once_with(BUILTIN_COMPUTER_SERVER_NAME)


@pytest.mark.asyncio
async def test_computer_retry_clears_stale_connection_error(automation_client) -> None:
    client, manager, _settings, agent_loop = automation_client
    from mona.agent.tools.mcp import BUILTIN_COMPUTER_SERVER_NAME

    manager.executable = object()
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
