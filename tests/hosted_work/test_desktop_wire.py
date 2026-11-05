"""Real websocket contracts using a declared executor fixture, not a production model."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import os
from pathlib import Path

import pytest
from aiohttp import WSMsgType, WSServerHandshakeError, web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.desktop_store import DesktopStore, request_id
from mona.hosted_work.desktop_wire import SOCKET_PATH, DesktopWire
from mona.hosted_work.service import WorkService
from mona.hosted_work.store import WorkStore, encoded
from mona.hosted_work.tenant_files import TenantFiles
from mona.hosted_work.tenant_office import TenantOffice
from mona.office.api import OFFICE_MANAGER_KEY

ALICE, BOB = "a" * 64, "b" * 64


class AuthFixture:
    def __init__(self):
        self.tokens = {"token-a": ALICE, "token-a-new": ALICE, "token-b": BOB}

    async def identity(self, token):
        if token not in self.tokens:
            raise WorkError("login_required", "请重新登录。", 401)
        return self.tokens[token]


class ExecutorFixture:
    """Only protocol timing/results are fixtures; WorkService and its store run normally."""
    def __init__(self):
        self.service = self.wire = None
        self.release = asyncio.Event()
        self.running = {}
        self.calls = []
        self.mode = "completed"

    def cancel(self, owner, rid):
        event = self.running.get((owner, rid))
        if event:
            event.set()

    async def execute(self, payload, emit):
        self.calls.append(payload)
        owner, rid = payload["owner"], payload["run_id"]
        stopped = self.running[(owner, rid)] = asyncio.Event()
        for kind, data in (("progress", {"message": "fixture progress", "tools": ["fixture_tool"]}),
                           ("delta", {"text": "fixture answer"})):
            await emit(kind, data)
            await self.wire.on_run_event(owner, self.service.store.run(owner, rid), kind, data)
        waits = [asyncio.create_task(self.release.wait()), asyncio.create_task(stopped.wait())]
        try:
            await asyncio.wait(waits, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in waits:
                task.cancel()
            await asyncio.gather(*waits, return_exceptions=True)
            self.running.pop((owner, rid), None)
        status = "cancelled" if stopped.is_set() else self.mode
        if status == "completed":
            await emit("history", {"messages": [*payload["history"], {"role": "assistant", "content": "fixture answer"}]})
        return {"status": status, "content": "fixture answer" if status == "completed" else "",
                "message": "fixture stopped" if status == "cancelled" else "fixture unknown",
                "workspace_saved": status != "unknown", "usage": {"prompt_tokens": 1, "completion_tokens": 2}}


class HookedService(WorkService):
    async def _drive(self, owner, token, run, engine):
        await super()._drive(owner, token, run, engine)
        current = self.store.run(owner, run["id"])
        await self.wire.on_run_finish(owner, current, current["result"])


class AttachmentsFixture:
    def __init__(self, service, state):
        self.service, self.state = service, state

    def prepare_attachments(self, owner, sid, frame):
        ids = []
        for path in frame.get("doc_paths", []):
            record = self.state.get(owner, "upload:" + path)
            if not record:
                raise WorkError("not_found", "未找到附件。", 404)
            actual = self.state.files._path(self.state.files.root(owner), path)
            assert actual.read_bytes() == b"attachment fixture"
            file_id = request_id(path, "attachment")
            self.service.store.add_file(owner, sid, file_id, {
                "path": path[len("/workspace/"):], "name": record["name"],
                "size": record["size"], "sha256": record["sha256"],
            })
            ids.append(file_id)
        return ids


async def make_client(tmp_path, *, attachments=False):
    state_root = tmp_path / "state"
    if os.name == "nt":
        state_root = Path("\\\\?\\" + str(state_root))
    state_root.mkdir(parents=True)
    config = HostedWorkConfig(state_dir=str(state_root), public_origin="https://mona-ai.cn",
        models={"qwen": {"label": "Fixture model", "model": "fixture-model"}})
    store = WorkStore(state_root / "work.sqlite3", config)
    auth, executor = AuthFixture(), ExecutorFixture()
    service = HookedService(config, store, auth, executor)
    files = TenantFiles(config, store.session)
    state = DesktopStore(service, files)
    controller = AttachmentsFixture(service, state) if attachments else None
    wire = service.wire = DesktopWire(service, state, controller)
    executor.service, executor.wire = service, wire

    @web.middleware
    async def errors(request, handler):
        try:
            return await handler(request)
        except WorkError as exc:
            return web.json_response({"error": exc.code}, status=exc.status)

    app = web.Application(middlewares=[errors])
    app.router.add_get(SOCKET_PATH, wire.handle_socket)

    async def cleanup(_app):
        await service.close()
        await wire.close()
        state.close()
        store.close()

    app.on_cleanup.append(cleanup)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, wire, executor, state


async def connect(client, wire, *, owner=ALICE, token="token-a", client_id="client-a"):
    ticket = wire.issue_ticket(owner, token, client_id)["ticket"]
    socket = await client.ws_connect(SOCKET_PATH + "?ticket=" + ticket + "&client_id=" + client_id,
                                    headers={"Origin": "https://mona-ai.cn"})
    ready = await socket.receive_json()
    assert ready["event"] == "ready" and ready["client_id"] == client_id
    return socket, ticket


async def receive(socket, name, predicate=lambda frame: True):
    async with asyncio.timeout(3):
        while True:
            frame = await socket.receive_json()
            if frame.get("event") == name and predicate(frame):
                return frame


async def new_chat(socket, rid="chat-request"):
    await socket.send_json({"type": "new_chat", "request_id": rid})
    return (await receive(socket, "attached"))["chat_id"]


async def test_messages_use_real_service_and_are_idempotent_across_reconnection(tmp_path):
    client, wire, executor, state = await make_client(tmp_path)
    async with client:
        socket, _ = await connect(client, wire)
        sid = await new_chat(socket)
        assert await new_chat(socket) == sid
        frame = {"type": "message", "chat_id": sid, "input_id": "message-one", "task_id": "task_ui_question", "content": "fixture question"}
        await socket.send_json(frame)
        assert (await receive(socket, "message_accepted"))["input_id"] == "message-one"
        run = await receive(socket, "goal_status", lambda item: item.get("status") == "running")
        assert run["turn_id"] and run["input_id"] == "message-one"
        assert (await receive(socket, "delta"))["task_id"] == "task_ui_question"
        await socket.close()

        resumed, _ = await connect(client, wire)
        await resumed.send_json({"type": "attach", "chat_id": sid})
        await receive(resumed, "attached")
        assert (await receive(resumed, "goal_status"))["turn_id"] == run["turn_id"]
        await resumed.send_json(frame)
        await receive(resumed, "message_accepted")
        assert len(executor.calls) == 1
        executor.release.set()
        ending = await receive(resumed, "turn_end")
        assert ending["task_id"] == "task_ui_question" and ending["turn_id"] == run["turn_id"]
        task = wire.service.tasks.get((ALICE, run["turn_id"]))
        if task:
            await task
        history = state.history(ALICE, sid)["messages"]
        assert sum(message.get("role") == "user" for message in history) == 1
        assert sum(message.get("role") == "assistant" and message.get("content") == "fixture answer" for message in history) == 1
        assert "token-a" not in encoded(state.get(ALICE, "run:" + run["turn_id"]))
        await resumed.send_json({**frame, "content": "changed"})
        rejected = await receive(resumed, "error")
        assert rejected["code"] == "request_conflict" and rejected["message_rejected"]
        assert len(executor.calls) == 1


async def test_stop_requires_exact_owner_chat_and_confirmed_executor_end(tmp_path):
    client, wire, executor, _ = await make_client(tmp_path)
    async with client:
        alice, _ = await connect(client, wire)
        sid = await new_chat(alice)
        await alice.send_json({"type": "message", "chat_id": sid, "input_id": "stop-message", "content": "wait"})
        running = await receive(alice, "goal_status", lambda frame: frame.get("status") == "running")
        await receive(alice, "delta")
        bob, _ = await connect(client, wire, owner=BOB, token="token-b", client_id="client-b")
        await bob.send_json({"type": "attach", "chat_id": sid})
        assert (await receive(bob, "error"))["code"] == "not_found"
        await bob.send_json({"type": "stop_work_turn", "chat_id": sid, "expected_turn_id": running["turn_id"], "request_id": "stop-b"})
        assert not (await receive(bob, "work_turn_stop_result"))["ok"]
        assert not executor.release.is_set()
        await alice.send_json({"type": "stop_work_turn", "chat_id": sid, "expected_turn_id": running["turn_id"], "request_id": "stop-a"})
        stopped = await receive(alice, "work_turn_stop_result")
        assert stopped["ok"] and stopped["turn_id"] == running["turn_id"] and stopped["outcome"] == "stopped"
        assert wire.service.store.run(ALICE, running["turn_id"])["status"] == "cancelled"


async def test_single_use_tickets_and_auth_rechecked_before_each_frame(tmp_path):
    client, wire, executor, _ = await make_client(tmp_path)
    async with client:
        socket, ticket = await connect(client, wire)
        with pytest.raises(WSServerHandshakeError) as credential_url:
            await client.ws_connect(SOCKET_PATH + "?ticket=" + ticket + "&token=not-allowed")
        assert credential_url.value.status == 400
        with pytest.raises(WSServerHandshakeError) as reused:
            await client.ws_connect(SOCKET_PATH + "?ticket=" + ticket + "&client_id=client-a")
        assert reused.value.status == 401
        wire.service.auth.tokens.pop("token-a")
        await socket.send_json({"type": "new_chat", "request_id": "revoked"})
        assert (await socket.receive()).type in {WSMsgType.CLOSE, WSMsgType.CLOSED}
        assert socket.close_code == 1008 and not executor.calls
        assert wire.service.store.list_sessions(ALICE) == []


async def test_uploads_are_real_scoped_files_and_unsupported_uploads_fail(tmp_path):
    client, wire, executor, state = await make_client(tmp_path, attachments=True)
    async with client:
        socket, _ = await connect(client, wire)
        data_url = "data:text/plain;base64," + base64.b64encode(b"attachment fixture").decode()
        await socket.send_json({"type": "doc_upload", "chat_id": "ephemeral:composer", "files": [{"name": "a.txt", "data_url": data_url}]})
        uploaded = await receive(socket, "doc_upload_result")
        assert uploaded["ok"]
        path = uploaded["files"][0]["path"]
        assert state.files._path(state.files.root(ALICE), path).read_bytes() == b"attachment fixture"
        assert state.get(ALICE, "upload:" + path)["scope"] == "ephemeral:composer"
        assert wire.service.store.list_sessions(ALICE) == []
        await socket.send_json({"type": "doc_upload", "chat_id": "ephemeral:composer", "files": [{"name": "bad.txt", "local_path": str(tmp_path / "secret")} ]})
        assert not (await receive(socket, "doc_upload_result"))["ok"]
        sid = await new_chat(socket)
        await socket.send_json({"type": "message", "chat_id": sid, "input_id": "with-file", "content": "read attachment", "doc_paths": [path]})
        await receive(socket, "message_accepted")
        await receive(socket, "delta")
        assert executor.calls[0]["attachments"][0]["sha256"] == state.get(ALICE, "upload:" + path)["sha256"]
        executor.release.set()
        await receive(socket, "turn_end")
        bob, _ = await connect(client, wire, owner=BOB, token="token-b", client_id="client-b")
        bob_sid = await new_chat(bob)
        await bob.send_json({"type": "message", "chat_id": bob_sid, "input_id": "stolen-file", "content": "read", "doc_paths": [path]})
        assert (await receive(bob, "error"))["code"] == "not_found"
        wire.controller = None
        await socket.send_json({"type": "doc_upload", "chat_id": sid, "files": [{"name": "a.txt", "data_url": data_url}]})
        assert not (await receive(socket, "doc_upload_result"))["ok"]
        assert len(executor.calls) == 1


async def test_unknown_result_is_not_reported_as_success_and_platform_requests_are_scoped(tmp_path):
    client, wire, executor, state = await make_client(tmp_path)
    async with client:
        socket, _ = await connect(client, wire)
        sid = await new_chat(socket)
        pending = asyncio.create_task(wire.request_platform(ALICE, sid, {"event": "canvas_command"}))
        request = await receive(socket, "canvas_command")
        await socket.send_json({"type": "canvas_result", "chat_id": sid, "request_id": request["request_id"], "ok": True})
        assert (await pending)["ok"]
        executor.mode = "unknown"
        await socket.send_json({"type": "message", "chat_id": sid, "input_id": "unknown", "content": "fixture unknown"})
        await receive(socket, "delta")
        executor.release.set()
        unknown = await receive(socket, "goal_status", lambda frame: frame.get("turn_state") == "unknown")
        run = wire.service.store.run(ALICE, unknown["turn_id"])
        assert run["status"] == "unknown"
        await wire.on_run_finish(ALICE, run, {"content": "forged success", "status": "completed"})
        assert not any(record.get("text") == "forged success" or record.get("event") == "turn_end"
                       for record, _ in state.records(ALICE, sid))


async def test_platform_http_result_is_owner_bound_and_idempotent(tmp_path):
    client, wire, _, state = await make_client(tmp_path)
    async with client:
        socket, _ = await connect(client, wire)
        sid = await new_chat(socket)
        pending = asyncio.create_task(wire.request_platform(ALICE, sid, {
            "event": "hosted_platform_event", "name": "canvas-agent-request", "request_id": "canvas-request",
        }))
        await receive(socket, "hosted_platform_event")
        assert wire.platform_pending(ALICE, "canvas-request")
        assert not wire.platform_pending(BOB, "canvas-request")
        result = {"ok": True, "requestId": "canvas-request", "revision": 2}
        with pytest.raises(WorkError) as foreign:
            wire.platform_result(BOB, "canvas-request", result)
        assert foreign.value.status == 404
        assert wire.platform_result(ALICE, "canvas-request", result) == {"ok": True}
        assert await pending == result
        assert not wire.platform_pending(ALICE, "canvas-request")
        assert wire.platform_result(ALICE, "canvas-request", dict(reversed(list(result.items())))) == {"ok": True}
        with pytest.raises(WorkError) as changed:
            wire.platform_result(ALICE, "canvas-request", {**result, "revision": 3})
        assert changed.value.status == 409
        with pytest.raises(WorkError) as replay:
            await wire.request_platform(ALICE, sid, {"event": "hosted_platform_event", "request_id": "canvas-request"})
        assert replay.value.status == 409
        state.delete(ALICE, sid)
        with pytest.raises(WorkError) as deleted:
            wire.platform_result(ALICE, "canvas-request", result)
        assert deleted.value.status == 404


async def test_office_desktop_frame_is_controlled_and_persisted_once(tmp_path):
    client, wire, executor, state = await make_client(tmp_path)
    async with client:
        socket, _ = await connect(client, wire)
        sid = await new_chat(socket)
        await socket.send_json({"type": "message", "chat_id": sid, "input_id": "office-event", "content": "create doc"})
        running = await receive(socket, "goal_status", lambda frame: frame.get("status") == "running")
        await receive(socket, "delta")
        run = wire.service.store.run(ALICE, running["turn_id"])
        event = {"event": "message", "kind": "progress", "text": "fixture Office session", "agent_ui": {
            "kind": "office_session", "data": {"session": {
                "sessionId": "office_fixture", "displayName": "Fixture.docx", "type": "docs",
                "workingPath": "/workspace/.office/office_fixture/working.docx",
                "version": {"editorEpoch": "fixture", "modelRevision": 0},
            }},
        }}
        wire.service.store.event(ALICE, run["id"], "desktop", event)
        await wire.on_run_event(ALICE, run, "desktop", event)
        opened = await receive(socket, "message", lambda frame: frame.get("agent_ui", {}).get("kind") == "office_session")
        assert opened["agent_ui"]["data"]["session"]["sessionId"] == "office_fixture"
        await wire.on_run_event(ALICE, run, "desktop", event)
        assert sum(record.get("agent_ui", {}).get("kind") == "office_session" for record, _ in state.records(ALICE, sid)) == 1
        invalid = {"event": "runtime_model_updated", "model_name": "forged"}
        wire.service.store.event(ALICE, run["id"], "desktop", invalid)
        with pytest.raises(WorkError) as rejected:
            await wire.on_run_event(ALICE, run, "desktop", invalid)
        assert rejected.value.code == "protocol_error"
        executor.release.set()
        await receive(socket, "turn_end")


async def test_widget_is_account_scoped_and_replayed_without_reexecution(tmp_path):
    client, wire, executor, state = await make_client(tmp_path)
    async with client:
        alice, _ = await connect(client, wire)
        sid = await new_chat(alice)
        bob, _ = await connect(client, wire, owner=BOB, token="token-b", client_id="client-b")
        await new_chat(bob, "bob-chat")
        await receive(bob, "session_updated")
        await bob.send_json({"type": "attach", "chat_id": sid})
        assert (await receive(bob, "error"))["code"] == "not_found"

        frame = {"type": "message", "chat_id": sid, "input_id": "widget-message",
                 "task_id": "task_widget_ui", "content": "draw a graph"}
        await alice.send_json(frame)
        await receive(alice, "message_accepted")
        running = await receive(alice, "goal_status", lambda item: item.get("status") == "running")
        await receive(alice, "delta")
        rid = running["turn_id"]
        run = wire.service.store.run(ALICE, rid)
        widget = {"id": "call_widget", "title": "实际图形", "code": '<svg viewBox="0 0 680 80"><text x="10" y="30">图形内容</text></svg>',
                  "loadingMessages": ["正在绘制"], "status": "complete"}

        # Only a durable event belonging to the active run can become a UI event.
        with pytest.raises(WorkError) as undurable:
            await wire.on_run_event(ALICE, run, "widget", widget)
        assert undurable.value.code == "protocol_error"
        wire.service.store.event(ALICE, rid, "widget", widget)
        await wire.on_run_event(ALICE, run, "widget", widget)
        shown = await receive(alice, "widget")
        assert shown == {"event": "widget", "chat_id": sid, "widget": widget, "author_id": "mona",
                         "task_id": "task_widget_ui", "turn_id": rid, "input_id": "widget-message"}
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(bob.receive_json(), timeout=0.1)
        with pytest.raises(WorkError) as foreign:
            state.history(BOB, sid)
        assert foreign.value.status == 404

        # Duplicate event delivery and reconnect must not create another widget or rerun the task.
        await wire.on_run_event(ALICE, run, "widget", widget)
        await alice.close()
        resumed, _ = await connect(client, wire)
        await resumed.send_json({"type": "attach", "chat_id": sid})
        await receive(resumed, "attached")
        assert (await receive(resumed, "goal_status"))["turn_id"] == rid
        await resumed.send_json(frame)
        await receive(resumed, "message_accepted")
        assert len(executor.calls) == 1
        executor.release.set()
        await receive(resumed, "turn_end")
        widgets = [item for item in state.history(ALICE, sid)["messages"] if item.get("kind") == "widget"]
        assert len(widgets) == 1
        assert widgets[0]["id"] == "widget:task_widget_ui:call_widget"
        assert widgets[0]["taskId"] == "task_widget_ui" and widgets[0]["widget"] == widget
        assert len(executor.calls) == 1


async def test_widget_rejects_unsafe_or_invalid_events_and_sanitizes_errors(tmp_path):
    client, wire, executor, state = await make_client(tmp_path)
    async with client:
        socket, _ = await connect(client, wire)
        sid = await new_chat(socket)
        await socket.send_json({"type": "message", "chat_id": sid, "input_id": "widget-errors", "content": "draw"})
        running = await receive(socket, "goal_status", lambda item: item.get("status") == "running")
        await receive(socket, "delta")
        run = wire.service.store.run(ALICE, running["turn_id"])
        valid = {"id": "call_widget", "title": "图形", "code": '<svg viewBox="0 0 680 80"></svg>',
                 "loadingMessages": ["正在绘制"], "status": "complete"}
        invalid_events = [
            {**valid, "code": '<script src="https://untrusted.example/script.js"></script>'},
            {**valid, "code": '<svg viewBox="0 0 10 10"></svg>'},
            {**valid, "id": []},
            {**valid, "status": []},
            {**valid, "loadingMessages": "正在绘制"},
            {**valid, "status": "streaming"},
        ]
        for event in invalid_events:
            wire.service.store.event(ALICE, run["id"], "widget", event)
            with pytest.raises(WorkError) as rejected:
                await wire.on_run_event(ALICE, run, "widget", event)
            assert rejected.value.code == "protocol_error"
        assert not any(record.get("event") == "widget" for record, _ in state.records(ALICE, sid))

        error = {**valid, "status": "error", "code": "private invalid content", "error": "private details"}
        wire.service.store.event(ALICE, run["id"], "widget", error)
        await wire.on_run_event(ALICE, run, "widget", error)
        shown = await receive(socket, "widget")
        assert shown["widget"] == {**{key: value for key, value in valid.items() if key not in {"code", "status"}},
                                   "code": "", "status": "error", "error": "图形暂时无法展示，请让 Mona 调整后重试。"}
        assert "private" not in encoded(shown)
        executor.release.set()
        await receive(socket, "turn_end")


async def test_finish_cards_only_use_verified_artifacts_from_this_run(tmp_path):
    client, wire, executor, state = await make_client(tmp_path)
    async with client:
        socket, _ = await connect(client, wire)
        sid = await new_chat(socket)
        await socket.send_json({"type": "message", "chat_id": sid, "input_id": "delivery", "content": "fixture delivery"})
        running = await receive(socket, "goal_status", lambda frame: frame.get("status") == "running")
        await receive(socket, "delta")
        rid = running["turn_id"]
        content = b"verified artifact fixture"
        (state.files.root(ALICE) / "result.txt").write_bytes(content)
        file = {"path": "/workspace/result.txt", "absolute_path": "/workspace/result.txt", "name": "result.txt",
                "size": len(content), "size_human": "25 B", "mime": "text/plain",
                "sha256": hashlib.sha256(content).hexdigest()}
        state.set(ALICE, "artifact_index:" + sid, [
            {"path": "result.txt", "task_id": rid, "delivered": True, "file": file},
            {"path": "other.txt", "task_id": "another-run", "delivered": True, "file": {**file, "name": "wrong"}},
            {"path": "draft.txt", "task_id": rid, "delivered": False, "file": {**file, "name": "draft"}},
        ])
        executor.release.set()
        delivered = await receive(socket, "deliver_files")
        assert delivered["files"] == [{**file, "path": "result.txt"}]
        await receive(socket, "turn_end")
        run = wire.service.store.run(ALICE, rid)
        await wire.on_run_finish(ALICE, run, run["result"])
        assert sum(record.get("event") == "deliver_files" for record, _ in state.records(ALICE, sid)) == 1


async def test_office_delivery_validates_real_account_file_bytes(tmp_path):
    client, wire, executor, state = await make_client(tmp_path)
    async with client:
        socket, _ = await connect(client, wire)
        sid = await new_chat(socket)
        await socket.send_json({"type": "message", "chat_id": sid, "input_id": "office-deliver", "content": "fixture office"})
        running = await receive(socket, "goal_status", lambda frame: frame.get("status") == "running")
        await receive(socket, "delta")
        run = wire.service.store.run(ALICE, running["turn_id"])
        raw = b"Office export fixture"
        target = state.files.root(ALICE) / "export.docx"
        target.write_bytes(raw)
        event = {"event": "deliver_files", "files": [{"path": "export.docx", "absolute_path": "/workspace/export.docx",
                 "name": "export.docx", "size": len(raw), "mime": "application/octet-stream"}]}
        wire.service.store.event(ALICE, run["id"], "desktop", event)
        await wire.on_run_event(ALICE, run, "desktop", event)
        delivered = await receive(socket, "deliver_files")
        digest = hashlib.sha256(raw).hexdigest()
        assert delivered["files"][0]["sha256"] == digest
        invalid = {"event": "deliver_files", "files": [{**event["files"][0], "sha256": "0" * 64}]}
        wire.service.store.event(ALICE, run["id"], "desktop", invalid)
        with pytest.raises(WorkError) as changed:
            await wire.on_run_event(ALICE, run, "desktop", invalid)
        assert changed.value.code == "file_changed"
        executor.release.set()
        await receive(socket, "turn_end")


async def test_attach_restores_real_office_sessions_without_executing_any_run(tmp_path):
    client, wire, executor, state = await make_client(tmp_path)
    async with client:
        socket, _ = await connect(client, wire)
        sid = await new_chat(socket)
        office = TenantOffice(wire.service.config, authorize_session=state.session,
                             identity=wire.service.auth.identity, workspace_for_owner=state.files.root)
        context = await office._context(ALICE, sid)
        created = context.app[OFFICE_MANAGER_KEY].create_session(
            owner_session_key="websocket:" + sid, document_type="docs", workspace_root=context.workspace,
        )

        class RestoreController:
            async def restore_editors(self, owner, chat):
                return await office.list_states(owner, chat)

        wire.controller = RestoreController()
        await socket.close()
        await office.close()
        resumed, _ = await connect(client, wire)
        await resumed.send_json({"type": "attach", "chat_id": sid})
        restored = await receive(resumed, "attached")
        document = restored["office_sessions"][0]
        assert document["sessionId"] == created.session_id
        assert document["workingPath"] == f"/workspace/.office/{created.session_id}/working.docx"
        assert not executor.calls
        assert wire.service.store.session_detail(ALICE, sid)["runs"] == []
        await office.close()
