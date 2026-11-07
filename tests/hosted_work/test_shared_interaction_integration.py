"""Real local HTTP/WS/store integration with synthetic identity and model execution.

These tests never launch a production executor, read provider credentials or establish
production availability. The desktop question tool and its loopback RPC remain real.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import random
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.desktop_api import PREFIX
from mona.hosted_work.image_billing_journal import ImageBillingJournal
from mona.hosted_work.question_tool import build_question_tool
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore

ALICE, BOB = "a" * 64, "b" * 64
SID_A, SID_B, RID = "1" * 32, "2" * 32, "3" * 32
ORIGIN = "https://integration.example.invalid"
TOKENS = {"synthetic-alice-token": ALICE, "synthetic-bob-token": BOB}
QUESTIONS = [{"id": "style", "question": "请选择样张风格", "options": [{"label": "商务"}, {"label": "杂志"}]}]
ANSWERS = [{"id": "style", "selected": ["商务"]}]


class SyntheticAuth:
    async def identity(self, token):
        if token not in TOKENS:
            raise WorkError("login_required", "测试登录已失效。", 401)
        return TOKENS[token]


class WaitingModelExecutor:
    """Replace only ProcessExecutor; a real run stays active until explicitly released."""

    def __init__(self):
        self.started, self.release = asyncio.Event(), asyncio.Event()
        self.calls, self.cancelled = [], []
        self.emit = None

    async def execute(self, payload, emit):
        self.calls.append(payload)
        self.emit = emit
        await emit("progress", {"message": "测试模型等待中"})
        self.started.set()
        await self.release.wait()
        return {"status": "cancelled" if self.cancelled else "completed", "content": "测试执行已结束。",
                "message": "本轮已停止。" if self.cancelled else "", "workspace_saved": True}

    def cancel(self, owner, rid):
        self.cancelled.append((owner, rid))
        self.release.set()


class SandboxImageBytes:
    """A declared sandbox edge; the real preview RPC must stage these bytes itself."""

    def __init__(self, raw):
        self.raw, self.calls = raw, []

    async def file(self, request):
        assert request == {"action": "download", "path": "samples/style.png"}
        self.calls.append(request)
        return {"path": request["path"], "name": "style.png", "size": len(self.raw),
                "sha256": hashlib.sha256(self.raw).hexdigest(), "data": base64.b64encode(self.raw).decode()}


def headers(account="alice"):
    return {"Authorization": "Bearer synthetic-" + account + "-token", "Origin": ORIGIN}


def image_headers(account="alice", sid=SID_A):
    return {**headers(account), "X-Mona-Session-Key": "websocket:" + sid}


async def receive(socket, event, predicate=lambda frame: True):
    async with asyncio.timeout(5):
        while True:
            frame = await socket.receive_json()
            if frame.get("event") == event and predicate(frame):
                return frame


async def connect(environment, account="alice", *, attach=True):
    response = await environment.client.post(PREFIX + "/socket-ticket", headers=headers(account),
                                             json={"client_id": "integration-" + account})
    assert response.status == 200
    ticket = (await response.json())["ticket"]
    socket = await environment.client.ws_connect(PREFIX + "/ws", headers={"Origin": ORIGIN},
        params={"ticket": ticket, "client_id": "integration-" + account})
    await receive(socket, "ready")
    if attach:
        sid = SID_A if account == "alice" else SID_B
        await socket.send_json({"type": "attach", "chat_id": sid})
        await receive(socket, "attached")
    return socket


@pytest.fixture
async def environment(tmp_path):
    root = tmp_path / "hosted"
    if os.name == "nt":
        root = Path("\\\\?\\" + str(root))
    root.mkdir()
    config = HostedWorkConfig(state_dir=str(root), public_origin=ORIGIN, bind_host="127.0.0.1",
        models={"fixture": {"label": "Synthetic fixture model", "model": "never-called-production-model",
                            "billing_mode": "free"}})
    store = WorkStore(root / "work.sqlite3", config)
    executor = WaitingModelExecutor()
    service = WorkService(config, store, SyntheticAuth(), executor)
    client = TestClient(TestServer(create_app(service)))
    await client.start_server()
    # Match the actual ephemeral loopback listener used by the real RunRPC client.
    config.port = client.server.port
    tasks = []
    try:
        for account, sid in (("alice", SID_A), ("bob", SID_B)):
            response = await client.post("/api/work/sessions", headers=headers(account), json={"request_id": sid})
            assert response.status == 201
        response = await client.get(PREFIX + "/api/settings", headers=headers())
        assert response.status == 200 and service.desktop is not None
        response = await client.post(f"/api/work/sessions/{SID_A}/runs", headers=headers(),
            json={"request_id": RID, "model_id": "fixture", "text": "测试提问交互"})
        assert response.status == 202
        await asyncio.wait_for(executor.started.wait(), 5)
        yield SimpleNamespace(client=client, service=service, executor=executor, api=service.desktop, tasks=tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        executor.release.set()
        await client.close()
        store.close()


def start_question(environment, pending=None, sandbox=None):
    tool = build_question_tool(environment.service.config, environment.executor.calls[0],
                               sandbox, environment.executor.emit, pending if pending is not None else [])
    task = asyncio.create_task(tool.execute(questions=QUESTIONS))
    environment.tasks.append(task)
    return task


async def test_image_control_uses_run_capability_after_website_session_expires(environment):
    from mona.config.schema import HostedWorkImageSettings
    from mona.hosted_work.image_control import ImageControl

    e = environment
    e.service.image_control = ImageControl(e.service.config, e.service.store)
    settings = HostedWorkImageSettings(enabled=True, model="gpt-image-test", billing_mode="free")
    capability = e.service.image_control.bind(ALICE, SID_A, RID, settings, "synthetic-alice-token")
    operation, fingerprint = "4" * 32, "5" * 64
    body = {"owner": ALICE, "session_id": SID_A, "run_id": RID, "command": "image_begin",
            "args": {"capability": "wrong", "operation": operation, "fingerprint": fingerprint}}
    denied = await e.client.post("/api/work/internal/image", headers={"Origin": ORIGIN}, json=body)
    assert denied.status == 403
    body["args"]["capability"] = capability
    accepted = await e.client.post("/api/work/internal/image", headers={"Origin": ORIGIN}, json=body)
    assert accepted.status == 200 and (await accepted.json())["result"]["status"] == "reserved"
    body["command"] = "image_dispatch"
    body["args"].pop("fingerprint")
    dispatched = await e.client.post("/api/work/internal/image", headers={"Origin": ORIGIN}, json=body)
    assert dispatched.status == 200 and (await dispatched.json())["result"]["status"] == "running"
    original = e.service.auth.identity
    async def expired(_token):
        raise WorkError("login_required", "测试登录已失效。", 401)
    e.service.auth.identity = expired
    try:
        body["command"] = "image_uncertain"
        body["args"]["usage_missing"] = True
        finished = await e.client.post("/api/work/internal/image", headers={"Origin": ORIGIN}, json=body)
        assert finished.status == 200
    finally:
        e.service.auth.identity = original
    body["owner"] = BOB
    assert (await e.client.post("/api/work/internal/image", headers={"Origin": ORIGIN}, json=body)).status == 403


async def test_generated_image_real_local_transport_billing_and_private_preview(environment):
    """Synthetic provider/wallet; real Work RPC, journal, preview and browser protocol."""
    from mona.config.schema import HostedWorkImagePrice, HostedWorkImageSettings
    from mona.hosted_work.image_control import ImageControl
    from mona.hosted_work.image_coordinator import ImageCoordinator
    from mona.hosted_work.image_runtime import _CALL_ID, ImageRuntime
    from mona.providers.image_generation import GeneratedImageResponse

    e = environment
    output = BytesIO()
    Image.new("RGB", (4, 4), "red").save(output, format="PNG")
    raw = output.getvalue()
    calls, charges, files = [], [], {}
    class Billing:
        async def reserve_image(self, operation, _token, _settings):
            charges.append("reserve")
            return {"run_id": operation, "status": "reserved", "reserved_units": 4}
        async def dispatch(self, operation):
            charges.append("dispatch")
            return {"run_id": operation, "status": "running"}
        async def settle_image(self, operation, _settings, receipt):
            assert receipt == {"sha256": hashlib.sha256(raw).hexdigest(), "image_count": 1}
            charges.append("settle")
            return {"run_id": operation, "status": "settled", "actual_units": 4}
    class Provider:
        async def generate(self, **_kwargs):
            calls.append("generate")
            return GeneratedImageResponse(images=["data:image/png;base64," + base64.b64encode(raw).decode()],
                                          content="", raw={"status": "completed"})
    class Sandbox:
        async def file(self, request):
            path = request["path"]
            if request["action"] == "upload":
                files[path] = base64.b64decode(request["data"], validate=True)
            data = files[path]
            return {"path": path, "name": Path(path).name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                    "data": base64.b64encode(data).decode()}
    async def deliver(_path):
        return None
    settings = HostedWorkImageSettings(enabled=True, model="gpt-6.1-sol",
                                      price=HostedWorkImagePrice(amount_per_image="0.000004"))
    billing = Billing()
    control = e.service.image_control = ImageControl(e.service.config, e.service.store, billing_factory=lambda _: billing)
    e.service.image_coordinator = ImageCoordinator(e.service.config, control, e.api,
                                                    provider_factory=lambda *_: Provider())
    capability = control.bind(ALICE, SID_A, RID, settings, "synthetic-alice-token")
    runtime = ImageRuntime(e.service.config, {"owner": ALICE, "session_id": SID_A, "run_id": RID,
        "hosted_image": {"settings": settings.model_dump(), "capability": capability}}, Sandbox(),
        SimpleNamespace(deliver_file=deliver))
    alice = await connect(e)
    token = _CALL_ID.set("integration-image-call")
    try:
        result = json.loads(await runtime.tool().execute(prompt="a red square"))
        assert result["ok"] is True and calls == ["generate"] and charges == ["reserve", "dispatch", "settle"]
        event = await receive(alice, "deliver_files", lambda frame: bool(frame.get("media_urls")))
        path = urlsplit(event["media_urls"][0]["url"]).path
        ok = await e.client.get(path, headers=image_headers())
        assert ok.status == 200 and await ok.read() == raw
        assert (await e.client.get(path)).status == 401
        assert (await e.client.get(path, headers=image_headers("bob", SID_B))).status == 404
        again = json.loads(await runtime.tool().execute(prompt="a red square"))
        assert again["ok"] is False and calls == ["generate"] and charges == ["reserve", "dispatch", "settle"]
    finally:
        _CALL_ID.reset(token)
        await runtime.close()
        await alice.close()


async def test_real_question_preview_reconnect_answer_and_fresh_media_tickets(environment):
    e = environment
    alice = await connect(e)
    await receive(alice, "user_questions", lambda frame: frame["requests"] == [])
    output = BytesIO()
    Image.new("RGB", (5, 3), (80, 40, 120)).save(output, format="PNG")
    raw = output.getvalue()
    digest = hashlib.sha256(raw).hexdigest()
    sandbox = SandboxImageBytes(raw)
    pending = [{"path": "samples/style.png", "name": "style.png", "mime": "image/png",
                "size": len(raw), "sha256": digest}]
    answer = start_question(e, pending, sandbox)
    preview = await receive(alice, "deliver_files", lambda frame: frame.get("presentation") == "question_preview")
    question = (await receive(alice, "user_questions", lambda frame: bool(frame["requests"])))["requests"][0]
    assert not answer.done() and pending == []
    assert sandbox.calls == [{"action": "download", "path": "samples/style.png"}]
    assert preview["inline_media"] is True and len(preview["files"]) == len(preview["media_urls"]) == 1
    staged = Path(e.service.config.state_dir) / "users" / ALICE / "previews" / SID_A / RID / (digest + ".png")
    assert staged.read_bytes() == raw
    assert not list(e.api.files.root(ALICE).glob("**/*.png"))
    ticket_url = preview["media_urls"][0]["url"]
    ticket_path = urlsplit(ticket_url).path
    image = await e.client.get(ticket_path)
    assert image.status == 200 and image.content_type == "image/png" and await image.read() == raw
    assert (await e.client.get(ticket_path, headers=headers("bob"))).status == 404

    # Reattach to the same pending request, rather than creating another tool call.
    await alice.close()
    alice = await connect(e)
    restored = await receive(alice, "user_questions", lambda frame: bool(frame["requests"]))
    assert restored["requests"] == [question] and len(e.executor.calls) == 1
    bob = await connect(e, "bob")
    for sid in (SID_A, SID_B):
        await bob.send_json({"type": "answer_user_question", "chat_id": sid, "request_id": "foreign-" + sid,
                             "question_id": question["request_id"], "answers": ANSWERS})
        rejected = await receive(bob, "answer_user_question_result")
        assert rejected["ok"] is False and rejected["code"] == "not_found"
        assert not answer.done()
    denied = await e.client.post(PREFIX + "/internal/tool", headers=headers("bob"), json={
        "run_id": RID, "session_id": SID_A, "command": "user_question", "args": {"ask_id": "forged", "questions": QUESTIONS}})
    assert denied.status == 404 and not answer.done()

    await alice.send_json({"type": "answer_user_question", "chat_id": SID_A, "request_id": "answer-style",
                          "question_id": question["request_id"], "answers": ANSWERS})
    assert (await receive(alice, "answer_user_question_result"))["ok"] is True
    assert json.loads(await asyncio.wait_for(answer, 5)) == {"answers": ANSWERS}
    assert e.api.questions.snapshot(ALICE, SID_A) == []

    # Persist stable paths only; refreshing signs new short-lived URLs from staged bytes.
    persisted = json.dumps(e.api.state.records(ALICE, SID_A), ensure_ascii=False)
    metadata = json.dumps([dict(row) for row in e.api.state.db(ALICE).execute("SELECT * FROM metadata")])
    for token in (*TOKENS, ticket_path.rsplit("/", 1)[1]):
        assert token not in persisted + metadata
    assert "/media/" not in persisted and "media_urls" not in persisted
    ticket = ticket_path.rsplit("/", 1)[1]
    e.api._file_tickets[ticket] = replace(e.api._file_tickets[ticket], expires=0)
    assert (await e.client.get(ticket_path)).status == 401
    history_path = PREFIX + f"/api/sessions/websocket:{SID_A}/webui-thread"
    first = await e.client.get(history_path, headers=headers())
    assert first.status == 200
    history = await first.json()
    card = next(item for item in history["messages"] if item.get("deliveredFiles"))
    fresh_url = card["media"][0]["url"]
    assert fresh_url != ticket_url
    fresh_image = await e.client.get(urlsplit(fresh_url).path)
    assert fresh_image.status == 200 and await fresh_image.read() == raw
    again = await (await e.client.get(history_path, headers=headers())).json()
    again_card = next(item for item in again["messages"] if item.get("deliveredFiles"))
    assert again_card["media"][0]["url"] != fresh_url
    assert again["pagination"]["revision"] == history["pagination"]["revision"]
    assert (await e.client.get(history_path, headers=headers("bob"))).status == 404
    e.executor.release.set()
    await receive(alice, "turn_end")
    assert e.service.store.run(ALICE, RID)["status"] == "completed" and len(e.executor.calls) == 1


def stage_image(e, operation, item, *, settled=False, free=False):
    journal = ImageBillingJournal(e.service.store)
    units = 0 if free else 4
    journal.create(ALICE, RID, operation, "f" * 64, {"amount_per_image": "0" if free else "0.000004"}, units,
                   operation_id=operation, billing_mode="free" if free else "wallet")
    journal.claim(ALICE, operation, "reserve")
    journal.reserved(ALICE, operation, units)
    journal.claim(ALICE, operation, "dispatch")
    journal.running(ALICE, operation)
    files = e.api.previews._prepare_generated_result(ALICE, SID_A, RID, operation, [item])
    journal.record_image_result(ALICE, operation, {"sha256": item["sha256"], "image_count": 1})
    record = {"event": "deliver_files", "inline_media": True, "task_id": RID, "turn_id": RID,
              "input_id": None, "files": files}
    e.api.state.append(ALICE, SID_A, record, f"run:{RID}:generated-preview:{operation}")
    if settled:
        journal.claim(ALICE, operation, "settle")
        journal.settled(ALICE, operation, units)
    return journal, files[0]


def synthetic_image(color=(80, 40, 120)):
    output = BytesIO()
    Image.new("RGB", (5, 3), color).save(output, format="PNG")
    raw = output.getvalue()
    return raw, {"name": "same.png", "mime": "image/png", "size": len(raw),
                 "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()}


async def test_pending_generated_image_is_hidden_until_settled_and_restored_after_refresh(environment):
    e = environment
    raw, item = synthetic_image()
    operation = "4" * 32
    journal, file = stage_image(e, operation, item)
    path = file["path"]
    history_path = PREFIX + f"/api/sessions/websocket:{SID_A}/webui-thread"
    preview_path = PREFIX + "/api/file-preview"
    query = {"scope": "shared", "session_key": "websocket:" + SID_A, "path": path}
    pending = await e.client.get(preview_path, headers=headers(), params=query)
    assert pending.status == 409
    with pytest.raises(WorkError) as blocked:
        e.api.media_url(ALICE, "synthetic-alice-token", SID_A, path)
    assert blocked.value.code == "billing_pending"
    history = await (await e.client.get(history_path, headers=headers())).json()
    assert path not in json.dumps(history, ensure_ascii=False)
    assert not any(frame for frame in e.api.wire._peers if frame.owner != ALICE)
    journal.claim(ALICE, operation, "settle")
    journal.settled(ALICE, operation, 4)
    preview = await e.client.get(preview_path, headers=headers(), params=query)
    assert preview.status == 200 and await preview.read() == raw
    ticket_url = e.api.media_url(ALICE, "synthetic-alice-token", SID_A, path)
    ticket_path = urlsplit(ticket_url).path
    assert (await e.client.get(ticket_path)).status == 401
    assert (await e.client.get(ticket_path, headers=headers())).status == 404
    assert (await e.client.get(ticket_path, headers=image_headers("bob"))).status == 404
    assert (await e.client.get(ticket_path, headers=image_headers(sid=SID_B))).status == 404
    allowed = await e.client.get(ticket_path, headers=image_headers())
    assert allowed.status == 200 and await allowed.read() == raw
    ticket = ticket_path.rsplit("/", 1)[1]
    e.api._file_tickets[ticket] = replace(e.api._file_tickets[ticket], expires=0)
    assert (await e.client.get(ticket_path, headers=image_headers())).status == 401
    e.executor.release.set()
    await asyncio.wait_for(e.service.tasks[ALICE, RID], 3)
    history = await (await e.client.get(history_path, headers=headers())).json()
    card = next(message for message in history["messages"] if message.get("deliveredFiles"))
    restored_path = urlsplit(card["media"][0]["url"]).path
    assert restored_path != ticket_path
    restored = await e.client.get(restored_path, headers=image_headers())
    assert restored.status == 200 and await restored.read() == raw
    assert (await e.client.get(history_path, headers=headers("bob"))).status == 404
    assert len(e.executor.calls) == 1


async def test_ticket_and_history_recheck_image_receipt_and_settlement(environment):
    e = environment
    raw, item = synthetic_image()
    operation = "8" * 32
    _, file = stage_image(e, operation, item, settled=True)
    path = file["path"]
    ticket_path = urlsplit(e.api.media_url(ALICE, "synthetic-alice-token", SID_A, path)).path
    assert await (await e.client.get(ticket_path, headers=image_headers())).read() == raw

    e.service.store.db.execute("UPDATE image_billing_journal SET stage='uncertain' WHERE operation_id=?", (operation,))
    assert (await e.client.get(ticket_path, headers=image_headers())).status == 409
    e.service.store.db.execute("UPDATE image_billing_journal SET stage='settled',image_result=? WHERE operation_id=?",
                               (json.dumps({"sha256": "0" * 64, "image_count": 1}), operation))
    assert (await e.client.get(ticket_path, headers=image_headers())).status == 404
    history_path = PREFIX + f"/api/sessions/websocket:{SID_A}/webui-thread"
    history = await (await e.client.get(history_path, headers=headers())).json()
    assert path not in json.dumps(history, ensure_ascii=False)


async def test_admin_zero_price_image_is_available_after_confirmed_completion(environment):
    e = environment
    raw, item = synthetic_image()
    _, file = stage_image(e, "9" * 32, item, settled=True, free=True)
    ticket_path = urlsplit(e.api.media_url(ALICE, "synthetic-alice-token", SID_A, file["path"])).path
    response = await e.client.get(ticket_path, headers=image_headers())
    assert response.status == 200 and await response.read() == raw


async def test_generated_preview_public_rpc_is_closed_and_large_parent_staging_is_bounded(environment):
    e = environment
    raw, item = synthetic_image()
    operation = "5" * 32
    body = {"run_id": RID, "session_id": SID_A, "command": "generated_preview",
            "args": {"delivery_id": operation, "files": [item]}}
    assert (await e.client.post(PREFIX + "/internal/tool", headers=headers(), json=body)).status == 400
    assert e.api.state.get(ALICE, e.api.previews._request_key(SID_A, RID, operation, generated=True)) is None
    e.service.config.max_file_bytes = 262144
    e.service.config.max_history_bytes = 65536
    output = BytesIO()
    Image.frombytes("RGB", (290, 290), random.Random(8).randbytes(290 * 290 * 3)).save(output, format="PNG")
    raw = output.getvalue()
    assert e.service.config.max_history_bytes < len(raw) < e.service.config.max_file_bytes
    item = {"name": "large.png", "mime": "image/png", "size": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()}
    _, record = stage_image(e, operation, item)
    assert e.api.previews.read(ALICE, SID_A, record["path"])[1] == raw
    with pytest.raises(WorkError):
        e.api.media_url(ALICE, "synthetic-alice-token", SID_A, record["path"])


async def test_identical_image_bytes_from_distinct_settled_operations_survive_history_replay(environment):
    e = environment
    raw, item = synthetic_image()
    _, first = stage_image(e, "6" * 32, item, settled=True)
    _, second = stage_image(e, "7" * 32, item, settled=True)
    assert first["path"] != second["path"] and first["name"] != second["name"]
    e.executor.release.set()
    await asyncio.wait_for(e.service.tasks[ALICE, RID], 3)
    history_path = PREFIX + f"/api/sessions/websocket:{SID_A}/webui-thread"
    history = await (await e.client.get(history_path, headers=headers())).json()
    result = next(message for message in history["messages"] if message.get("deliveredFiles"))
    assert len(result["deliveredFiles"]) == len(result["media"]) == 2
    urls = [urlsplit(media["url"]).path for media in result["media"]]
    restored = await asyncio.gather(*(e.client.get(url, headers=image_headers()) for url in urls))
    assert [await response.read() for response in restored] == [raw, raw]


async def test_real_stop_cancels_pending_http_question_without_fabricating_answer(environment):
    e = environment
    socket = await connect(e)
    await receive(socket, "user_questions", lambda frame: frame["requests"] == [])
    answer = start_question(e)
    question = (await receive(socket, "user_questions", lambda frame: bool(frame["requests"])))["requests"][0]
    assert not answer.done()
    await socket.send_json({"type": "stop_work_turn", "chat_id": SID_A,
                            "request_id": "stop-question", "expected_turn_id": RID})
    stopped = await receive(socket, "work_turn_stop_result")
    assert stopped["ok"] is True and stopped["outcome"] == "stopped"
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(answer, 5)
    assert e.api.questions.snapshot(ALICE, SID_A) == []
    assert e.service.store.run(ALICE, RID)["status"] == "cancelled"
    assert e.executor.cancelled == [(ALICE, RID)]
    await socket.send_json({"type": "answer_user_question", "chat_id": SID_A, "request_id": "late-answer",
                            "question_id": question["request_id"], "answers": ANSWERS})
    rejected = await receive(socket, "answer_user_question_result")
    assert rejected["ok"] is False and rejected["code"] == "not_found"
    resumed = await connect(e)
    assert (await receive(resumed, "user_questions"))["requests"] == []
    assert len(e.executor.calls) == 1
