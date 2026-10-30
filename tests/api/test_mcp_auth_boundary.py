import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from aiohttp.test_utils import TestClient, TestServer

from mona.api import server
from mona.materials.auth import SERVICES_TOKEN_HEADER, get_services_token


@pytest.mark.parametrize("origin,authenticated,status", [
    (None, False, 401),
    ("http://localhost:1420", False, 401),
    ("https://untrusted.example", False, 403),
    ("https://untrusted.example", True, 403),
    ("http://localhost:1420", True, 201),
    (None, True, 201),
])
async def test_mcp_configuration_requires_local_auth(tmp_path, monkeypatch, origin, authenticated, status):
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    loop = SimpleNamespace(_mcp_servers={}, add_mcp_server=AsyncMock(return_value={"ok": True}))
    saved = Mock()
    monkeypatch.setattr(server, "_schedule_computer_use_startup", AsyncMock())
    monkeypatch.setattr(server, "_cancel_computer_use_startup", AsyncMock())
    monkeypatch.setattr("mona.config.loader.load_config", lambda: SimpleNamespace(
        tools=SimpleNamespace(mcp_servers={}),
    ))
    monkeypatch.setattr("mona.config.loader.save_config", saved)
    headers = {"Content-Type": "text/plain"}
    if origin:
        headers["Origin"] = origin
    if authenticated:
        headers[SERVICES_TOKEN_HEADER] = get_services_token()
    async with TestClient(TestServer(server.create_app(loop))) as client:
        response = await client.post("/api/mcp/servers", data=json.dumps({
            "name": "audit-fixture", "command": "not-executed", "args": [],
        }), headers=headers)
        assert response.status == status
        assert saved.call_count == (1 if status == 201 else 0)
        assert loop.add_mcp_server.await_count == (1 if status == 201 else 0)


async def test_health_and_preflight_remain_available(tmp_path, monkeypatch):
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(server, "_schedule_computer_use_startup", AsyncMock())
    monkeypatch.setattr(server, "_cancel_computer_use_startup", AsyncMock())
    async with TestClient(TestServer(server.create_app(None))) as client:
        assert (await client.get("/health")).status == 200
        response = await client.options("/api/mcp/servers", headers={"Origin": "http://localhost:1420"})
        assert response.status == 204
        assert response.headers["Access-Control-Allow-Origin"] == "http://localhost:1420"
