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
        models={"fixture": {"label": "Synthetic fixture model", "model": "never-called-production-model"}})
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
