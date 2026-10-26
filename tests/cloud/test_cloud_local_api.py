"""Real Gateway cloud routes and coordinator with isolated cloud/native boundaries."""
import asyncio
import json
import secrets

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from test_cloud_coordinator import add_conversation
from test_cloud_coordinator import desktops as desktops

from mona.cloud import api


@pytest_asyncio.fixture
async def local_api(desktops, monkeypatch):
    _, create = desktops
    coordinator, boundary = create("local-api")
    await coordinator.pause()
    app = web.Application()
    app["agent_loop"] = coordinator.loop
    app[api.RUNTIME_KEY] = coordinator
    monkeypatch.setattr(api, "get_config_path", lambda: coordinator.preferences.path)
    token = secrets.token_hex(32)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", token)
    api.register_cloud_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        yield client, coordinator, boundary, {"X-Mona-Token": token}
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_unauthorized_calls_never_reach_account_or_setup(local_api):
    client, coordinator, boundary, _ = local_api
    for path in ["status", "prepare", "enable", "pause", "resume", "sync"]:
        response = await (client.get("/api/cloud-sync/" + path) if path == "status"
                          else client.post("/api/cloud-sync/" + path, json={}))
        assert response.status == 401
        assert response.headers.get("Cache-Control") == "no-store"
    assert boundary.calls == [] and coordinator.draft is None


@pytest.mark.asyncio
async def test_status_is_read_only_and_does_not_expose_native_credentials(local_api):
    client, coordinator, boundary, headers = local_api
    response = await client.get("/api/cloud-sync/status", headers=headers)
    data = await response.json()
    assert response.status == 200 and response.headers["Cache-Control"] == "no-store"
    assert data["enabled"] is False and data["available"] is True
    assert boundary.binding not in json.dumps(data)
    assert boundary.server.space is None
    assert not coordinator.preferences.read().enabled


@pytest.mark.asyncio
async def test_request_body_stream_is_read_completely_before_enabling(local_api):
    client, coordinator, boundary, headers = local_api
    session = add_conversation(coordinator)
    result = await client.post("/api/cloud-sync/prepare", headers=headers, json={})
    draft = await result.json()
    assert "recovery" not in draft and boundary.server.space is None
    payload = json.dumps({"draft_id": draft["draft_id"], "session_keys": [session.key], "confirmed": True}).encode()
    async def stream():
        for start in range(0, len(payload), 7):
            yield payload[start:start + 7]
            await asyncio.sleep(0)
    response = await client.post("/api/cloud-sync/enable", headers={**headers, "Content-Type": "application/json"}, data=stream())
    assert response.status == 200, await response.text()
    assert (await response.json())["enabled"] is True
    assert coordinator.preferences.read().enabled
    paused = await client.post("/api/cloud-sync/pause", headers=headers, json={})
    assert paused.status == 200 and not coordinator.preferences.read().enabled


@pytest.mark.asyncio
async def test_code_scope_extra_authority_and_large_body_are_rejected(local_api):
    client, coordinator, boundary, headers = local_api
    cases = [("scope", {"session_keys": ["development:dev_1"]}),
             ("prepare", {"account_id": "other-account"}),
             ("enable", {"draft_id": "x" * 32, "confirmed": True}),
             ("scope", {"session_keys": ["websocket:../outside"]})]
    for path, payload in cases:
        response = await client.post("/api/cloud-sync/" + path, headers=headers, json=payload)
        assert response.status == 400
    oversized = await client.post("/api/cloud-sync/prepare", headers=headers, data=b"x" * (512 * 1024 + 1))
    assert oversized.status == 400
    assert coordinator.draft is None and boundary.calls == []


@pytest.mark.asyncio
async def test_file_open_rejects_untrusted_or_code_scope_before_account_access(local_api):
    client, _, boundary, headers = local_api
    payload = {"path": "/data/cloud/" + "a" * 32 + "/" + "b" * 64 + "/file.txt"}
    denied = await client.post("/api/cloud-sync/ensure-file", json=payload)
    assert denied.status == 401
    for change in ({"session_key": "development:one"}, {"path": "../file.txt"}, {"account_id": "other"}):
        invalid = await client.post("/api/cloud-sync/ensure-file", json={**payload, **change}, headers=headers)
        assert invalid.status == 400
    assert boundary.calls == []


@pytest.mark.asyncio
async def test_sync_disabled_is_not_reported_as_scheduled(local_api):
    client, _, _, headers = local_api
    response = await client.post("/api/cloud-sync/sync", headers=headers, json={})
    assert response.status == 409
    assert (await response.json())["error"]["code"] == "sync_disabled"


@pytest.mark.asyncio
async def test_operations_credentials_require_explicit_host_scope_and_default_off(local_api):
    client, coordinator, _, headers = local_api
    assert not coordinator.preferences.read().sync_operations
    assert not coordinator.preferences.read().sync_operations_credentials
    draft = await (await client.post("/api/cloud-sync/prepare", headers=headers, json={})).json()
    payload = {"draft_id": draft["draft_id"], "confirmed": True,
               "sync_operations_credentials": True}
    rejected = await client.post("/api/cloud-sync/enable", headers=headers, json=payload)
    assert rejected.status == 409
    assert (await rejected.json())["error"]["code"] == "invalid_scope"
    accepted = await client.post("/api/cloud-sync/enable", headers=headers,
                                 json={**payload, "sync_operations": True})
    assert accepted.status == 200
    status = await (await client.get("/api/cloud-sync/status", headers=headers)).json()
    assert status["sync_operations"] is True and status["sync_operations_credentials"] is True
    changed = await client.post("/api/cloud-sync/scope", headers=headers,
                                json={"sync_operations": False})
    assert changed.status == 200
    assert coordinator.preferences.read().sync_operations_credentials is False


@pytest.mark.asyncio
async def test_resume_requires_local_auth_and_does_not_grant_upload(local_api):
    from mona.cloud.crypto import VaultCipher

    client, coordinator, boundary, headers = local_api
    cipher = VaultCipher.generate()
    boundary.server.control("POST", "/space", {"vault_id": cipher.vault_id,
        "key_check": cipher.key_check(), "recovery": cipher.recovery_text()})
    response = await client.post("/api/cloud-sync/resume", headers=headers, json={})
    assert response.status == 200 and (await response.json())["enabled"] is True
    assert coordinator.preferences.read().upload_enabled is False
    assert not boundary.server.uploads and not boundary.server.versions


@pytest.mark.asyncio
async def test_bad_recovery_not_echoed_in_error(local_api):
    client, _, _, headers = local_api
    value = "SYNTHETIC_BAD_RECOVERY_DO_NOT_ECHO"
    response = await client.post("/api/cloud-sync/prepare", headers=headers, json={"recovery": value})
    assert response.status == 409
    assert value not in await response.text()
    assert response.headers["Cache-Control"] == "no-store"
