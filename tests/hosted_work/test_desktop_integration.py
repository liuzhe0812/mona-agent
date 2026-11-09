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


async def test_delete_waits_for_own_completed_run_cleanup(integrated):
    client, service, _saved = integrated
    service.store.finish(OWNER, RID, "completed", {"workspace_saved": True})
    # An unrelated account may have the same session and run IDs.
    service.store.create_session(OTHER, NewSession(request_id=SID))
    service.store.create_run(OTHER, SID, NewTurn(request_id=RID, model_id="local", text="other account"))
    own_done, other_done = asyncio.Event(), asyncio.Event()
    own_task = asyncio.create_task(own_done.wait())
    other_task = asyncio.create_task(other_done.wait())
    service.tasks.update({(OWNER, RID): own_task, (OTHER, RID): other_task})
    request = asyncio.create_task(client.get(BASE + f"/api/sessions/websocket:{SID}/delete", headers=HEADERS))
    try:
        # The request must wait for the exact completed run's cleanup.
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(request), 0.05)
        assert not own_task.done() and not other_task.done()
        own_done.set()
        response = await asyncio.wait_for(request, 1)
        assert response.status == 200
        assert (await client.get(BASE + f"/api/sessions/websocket:{SID}/webui-thread", headers=HEADERS)).status == 404
        assert service.store.run(OTHER, RID)["status"] == "running" and not other_task.done()
    finally:
        own_done.set()
        other_done.set()
        request.cancel()
        await asyncio.gather(request, own_task, other_task, return_exceptions=True)
        service.tasks.pop((OWNER, RID), None)
        service.tasks.pop((OTHER, RID), None)


@pytest.mark.parametrize("status", ["running", "cancelling", "unknown"])
async def test_delete_rejects_active_or_unknown_run_without_waiting(integrated, status):
    client, service, _saved = integrated
    if status == "cancelling":
        service.store.cancelling(OWNER, RID)
    elif status == "unknown":
        service.store.finish(OWNER, RID, "unknown", {"workspace_saved": False})
    cleanup = asyncio.create_task(asyncio.Event().wait())
    service.tasks[(OWNER, RID)] = cleanup
    try:
        response = await asyncio.wait_for(
            client.get(BASE + f"/api/sessions/websocket:{SID}/delete", headers=HEADERS), 0.5,
        )
        assert response.status == 409 and (await response.json())["code"] == "user_busy"
        assert not cleanup.done() and service.desktop.state.session(OWNER, SID)
    finally:
        cleanup.cancel()
        await asyncio.gather(cleanup, return_exceptions=True)
        service.tasks.pop((OWNER, RID), None)


async def test_delete_cleanup_timeout_does_not_cancel_task(integrated, monkeypatch):
    client, service, _saved = integrated
    service.store.finish(OWNER, RID, "completed", {"workspace_saved": True})
    monkeypatch.setattr("mona.hosted_work.desktop_api._DELETE_CLEANUP_WAIT_SECONDS", 0.02)
    cleanup = asyncio.create_task(asyncio.Event().wait())
    service.tasks[(OWNER, RID)] = cleanup
    try:
        response = await client.get(BASE + f"/api/sessions/websocket:{SID}/delete", headers=HEADERS)
        assert response.status == 409 and (await response.json())["code"] == "user_busy"
        assert not cleanup.done() and service.desktop.state.session(OWNER, SID)
    finally:
        cleanup.cancel()
        await asyncio.gather(cleanup, return_exceptions=True)
        service.tasks.pop((OWNER, RID), None)


async def test_delete_after_cleanup_still_blocks_unconfirmed_billing(integrated):
    client, service, _saved = integrated
    service.store.billing_begin(OWNER, RID, "3" * 32)
    service.store.billing_update(OWNER, RID, "uncertain")
    service.store.finish(OWNER, RID, "completed", {"workspace_saved": True})
    cleanup = asyncio.create_task(asyncio.sleep(0))
    service.tasks[(OWNER, RID)] = cleanup
    try:
        response = await client.get(BASE + f"/api/sessions/websocket:{SID}/delete", headers=HEADERS)
        assert response.status == 409 and (await response.json())["code"] == "billing_pending"
        assert service.desktop.state.session(OWNER, SID)
        assert service.store.db.execute("SELECT stage FROM billing_journal WHERE owner=? AND run_id=?",
                                        (OWNER, RID)).fetchone()[0] == "uncertain"
    finally:
        cleanup.cancel()
        await asyncio.gather(cleanup, return_exceptions=True)
        service.tasks.pop((OWNER, RID), None)
