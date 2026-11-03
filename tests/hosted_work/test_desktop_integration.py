"""Exercise the real HTTP/WS adapters without a model or host execution fallback."""
from __future__ import annotations

import asyncio

import pytest
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import NewSession, NewTurn, WorkError
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore

OWNER, OTHER = "a" * 64, "b" * 64
SID, RID = "1" * 32, "2" * 32
BASE = "/api/work/desktop"
HEADERS = {"Authorization": "Bearer local-account", "Origin": "https://mona.example"}


class Auth:
    async def identity(self, token):
        if token not in {"local-account", "other-account"}:
            raise WorkError("login_required", "登录已失效。", 401)
        return OWNER if token == "local-account" else OTHER


class Executor:
    def cancel(self, *_args):
        raise AssertionError("Deleting history must not discard an active execution")


@pytest.fixture
async def integrated(tmp_path):
    config = HostedWorkConfig(enabled=True, state_dir=str(tmp_path), public_origin="https://mona.example",
        models={"local": HostedWorkModel(label="Local contract", model="local-contract")})
    store = WorkStore(tmp_path / "sessions.sqlite3", config)
    store.create_session(OWNER, NewSession(request_id=SID))
    service = WorkService(config, store, Auth(), Executor())
    client = TestClient(TestServer(create_app(service)))
    await client.start_server()
    response = await client.get(BASE + "/api/settings", headers=HEADERS)
    assert response.status == 200
    desktop = service.desktop
    saved = desktop.files.invoke(OWNER, "workspace_canvas_save", {"workspaceRoot": "/workspace", "canvas": {
        "version": 1, "id": "canvas-local", "kind": "mindmap", "title": "本地画布", "originChatId": SID,
        "createdAt": "2026-11-03T00:00:00Z", "updatedAt": "2026-11-03T00:00:00Z", "contentMarkdown": "# 本地画布"}})
    store.create_run(OWNER, SID, NewTurn(request_id=RID, model_id="local", text="编辑当前画布"))
    yield client, service, saved
    await client.close()
    store.close()


def tool(saved, **args):
    return {"run_id": RID, "session_id": SID, "command": "canvas_agent_request", "args": {
        "requestId": "edit-local", "canvasId": "canvas-local", "path": saved["path"], "action": "apply", **args}}


async def test_live_canvas_receipt_is_account_scoped_and_never_replayed(integrated):
    client, service, saved = integrated
    ticket = await client.post(BASE + "/socket-ticket", headers=HEADERS, json={"client_id": "local-client"})
    socket = await client.ws_connect(BASE + "/ws?ticket=" + (await ticket.json())["ticket"],
                                     headers={"Origin": HEADERS["Origin"]})
    await socket.receive_json()
    await socket.send_json({"type": "attach", "chat_id": SID})
    while (await socket.receive_json()).get("event") != "attached":
        pass
    pending = asyncio.create_task(client.post(BASE + "/internal/tool", headers=HEADERS, json=tool(saved)))
    async with asyncio.timeout(2):
        event = await socket.receive_json()
        while event.get("event") != "hosted_platform_event":
            event = await socket.receive_json()
    assert event["name"] == "canvas-agent-request" and event["payload"]["canvasId"] == "canvas-local"
    receipt = {"command": "canvas_agent_respond", "args": {"requestId": "edit-local", "result": {"ok": True, "version": 3}}}
    foreign = await client.post(BASE + "/platform/invoke", headers={**HEADERS, "Authorization": "Bearer other-account"}, json=receipt)
    assert foreign.status == 404
    response = await client.post(BASE + "/platform/invoke", headers=HEADERS, json=receipt)
    assert response.status == 200
    result = await pending
    assert (await result.json())["result"] == {"ok": True, "version": 3}
    repeated = await client.post(BASE + "/internal/tool", headers=HEADERS, json=tool(saved))
    assert repeated.status == 409
    await socket.close()


async def test_missing_editor_reports_uncertain_apply_and_active_history_is_kept(integrated):
    client, service, saved = integrated
    response = await client.post(BASE + "/internal/tool", headers=HEADERS, json=tool(saved, timeoutMs=1))
    result = (await response.json())["result"]
    assert response.status == 200 and result["ok"] is False and result["status"] == "outcome_unknown"
    retry = await client.post(BASE + "/internal/tool", headers=HEADERS, json=tool(saved, timeoutMs=1))
    assert retry.status == 409
    refused = await client.get(BASE + f"/api/sessions/websocket:{SID}/delete", headers=HEADERS)
    assert refused.status == 409
    assert service.desktop.state.session(OWNER, SID)["id"] == SID
    service.store.finish(OWNER, RID, "completed", {"workspace_saved": True})
    stopped = await client.post(BASE + "/internal/tool", headers=HEADERS, json=tool(saved))
    assert stopped.status == 409
    deleted = await client.get(BASE + f"/api/sessions/websocket:{SID}/delete", headers=HEADERS)
    assert deleted.status == 200
    missing = await client.get(BASE + f"/api/sessions/websocket:{SID}/webui-thread", headers=HEADERS)
    assert missing.status == 404
