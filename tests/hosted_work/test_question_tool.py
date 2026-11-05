"""Hosted question transport exercises the actual desktop question tool."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from io import BytesIO
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image

from mona.agent.tools.ask_user import AskUserQuestionTool
from mona.agent.tools.context import RequestContext
from mona.agent.tools.deliver_file import DELIVER_FILES_PENDING_META
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, owner_key
from mona.hosted_work.question_tool import build_question_tool

OWNER, SID, RID = owner_key("71"), "a" * 32, "b" * 32
TOKEN = "synthetic-account-token"
QUESTIONS = [{"id": "style", "question": "请选择风格", "options": [{"label": "商务"}, {"label": "杂志"}]}]
ANSWERS = [{"id": "style", "selected": ["商务"]}]


def config(**changes):
    value = HostedWorkConfig(public_origin="https://mona-ai.cn", bind_host="127.0.0.1")
    # Production schema validates this setting; tiny values let timeout tests finish promptly.
    return value.model_copy(update={"question_timeout_seconds": 2, **changes})


def payload():
    return {"owner": OWNER, "session_id": SID, "run_id": RID, "account_token": TOKEN}


def image_bytes(kind):
    output = BytesIO()
    Image.new("RGB", (3, 2), (120, 40, 60)).save(output, format=kind)
    return output.getvalue()


def entry(path, raw, mime):
    return {"path": path, "name": path.rsplit("/", 1)[-1], "size": len(raw), "mime": mime,
            "sha256": hashlib.sha256(raw).hexdigest()}


class Sandbox:
    def __init__(self, files=None):
        self.files, self.calls = files or {}, []

    async def file(self, request):
        self.calls.append(request)
        path = request["path"]
        raw = self.files[path]
        return {"path": path, "name": path.rsplit("/", 1)[-1], "size": len(raw),
                "sha256": hashlib.sha256(raw).hexdigest(), "data": base64.b64encode(raw).decode()}


def install_transport(monkeypatch, handler):
    import mona.hosted_work.question_tool as module

    original = httpx.AsyncClient
    configurations = []

    def client(**kwargs):
        configurations.append(kwargs)
        return original(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(module.httpx, "AsyncClient", client)
    return configurations


def response(value, status=200):
    return httpx.Response(status, json={"result": value})


@pytest.mark.asyncio
async def test_shared_question_long_poll_reuses_one_identity_and_secure_transport(monkeypatch):
    requests = []
    async def handler(request):
        requests.append(request)
        return response({"status": "pending"} if len(requests) == 1 else {"status": "answered", "answers": ANSWERS})

    settings = install_transport(monkeypatch, handler)
    events = []
    async def emit(kind, value):
        events.append((kind, value))

    tool = build_question_tool(config(), payload(), Sandbox(), emit, [])
    assert isinstance(tool, AskUserQuestionTool) and tool.exclusive and tool.system_managed
    assert tool.available_in_context() and tool.parameters == AskUserQuestionTool.parameters
    assert json.loads(await tool.execute(QUESTIONS)) == {"answers": ANSWERS}
    assert len(requests) == 2 and not events
    bodies = [json.loads(request.content) for request in requests]
    assert bodies[0] == bodies[1]
    assert bodies[0]["command"] == "user_question" and len(bodies[0]["args"]["ask_id"]) == 32
    assert bodies[0]["session_id"] == SID and bodies[0]["run_id"] == RID
    assert bodies[0]["args"]["questions"][0]["id"] == "style"
    for request in requests:
        assert str(request.url) == "http://127.0.0.1:17175/api/work/desktop/internal/tool"
        assert request.headers["Authorization"] == "Bearer " + TOKEN
        assert request.headers["Host"] == "mona-ai.cn" and request.headers["Origin"] == "https://mona-ai.cn"
        assert TOKEN not in request.content.decode()
    assert all(item == {"trust_env": False, "follow_redirects": False, "timeout": 35} for item in settings)
    assert tool.remote.ask_id.get() is None


@pytest.mark.asyncio
async def test_preview_retries_same_payload_and_preserves_non_image_delivery(monkeypatch):
    png, jpg, webp = image_bytes("PNG"), image_bytes("JPEG"), image_bytes("WEBP")
    values = {"a.png": png, "b.jpg": jpg, "c.webp": webp}
    pending = [entry("a.png", png, "image/png"), entry("b.jpg", jpg, "image/jpeg"),
               entry("c.webp", webp, "image/webp"), entry("report.pdf", b"pdf", "application/pdf")]
    requests = []
    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        if body["command"] == "question_preview":
            if sum(row["command"] == "question_preview" for row in requests) == 1:
                raise httpx.ReadTimeout("synthetic transport failure", request=request)
            return response({"ok": True})
        return response({"status": "answered", "answers": ANSWERS})

    install_transport(monkeypatch, handler)
    sandbox = Sandbox(values)
    events = []
    async def emit(kind, value):
        events.append((kind, value))

    tool = build_question_tool(config(), payload(), sandbox, emit, pending)
    assert json.loads(await tool.execute(QUESTIONS)) == {"answers": ANSWERS}
    assert [body["command"] for body in requests] == ["question_preview", "question_preview", "user_question"]
    assert requests[0] == requests[1]
    assert requests[0]["args"]["ask_id"] == requests[-1]["args"]["ask_id"]
    preview = requests[0]["args"]["files"]
    assert [file["mime"] for file in preview] == ["image/png", "image/jpeg", "image/webp"]
    for file in preview:
        raw = base64.b64decode(file["data"], validate=True)
        assert raw == values[file["name"]] and hashlib.sha256(raw).hexdigest() == file["sha256"]
    assert [request["path"] for request in sandbox.calls] == ["a.png", "b.jpg", "c.webp"]
    assert pending == [entry("report.pdf", b"pdf", "application/pdf")] and not events
    assert tool._context.get().metadata[DELIVER_FILES_PENDING_META] is pending


@pytest.mark.asyncio
async def test_lost_question_response_retries_the_same_ask_without_republishing_preview(monkeypatch):
    requests = []
    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        if len(requests) == 1:
            raise httpx.ReadTimeout("synthetic private failure", request=request)
        return response({"status": "answered", "answers": ANSWERS})

    install_transport(monkeypatch, handler)
    async def emit(_kind, _value):
        pass
    tool = build_question_tool(config(), payload(), Sandbox(), emit, [])
    assert json.loads(await tool.execute(QUESTIONS)) == {"answers": ANSWERS}
    assert len(requests) == 2 and requests[0] == requests[1]


@pytest.mark.asyncio
async def test_invalid_kwargs_and_wrong_context_do_not_send_or_clear_pending(monkeypatch):
    requests = []
    async def handler(request):
        requests.append(request)
        return response({"status": "answered", "answers": ANSWERS})

    install_transport(monkeypatch, handler)
    pending = [entry("a.png", image_bytes("PNG"), "image/png")]
    async def emit(_kind, _value):
        pass
    tool = build_question_tool(config(), payload(), Sandbox(), emit, pending)
    assert (await tool.execute(QUESTIONS, unknown="bad")).startswith("Error:")
    assert len(pending) == 1 and not requests
    with pytest.raises(WorkError):
        tool.set_context(RequestContext(channel="websocket", chat_id="c" * 32))
    assert tool.available_in_context() and tool.remote.ask_id.get() is None


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["traversal", "digest", "size", "mime", "unsupported"])
async def test_invalid_preview_is_rejected_without_sending_question_or_clearing_files(monkeypatch, change):
    raw = image_bytes("PNG")
    item = entry("a.png", raw, "image/png")
    if change == "traversal":
        item["path"] = "../a.png"
    elif change == "digest":
        item["sha256"] = "0" * 64
    elif change == "size":
        item["size"] += 1
    elif change == "mime":
        item["mime"] = "image/jpeg"
    else:
        item["mime"] = "image/gif"
    pending, requests = [item], []
    async def handler(request):
        requests.append(request)
        return response({"ok": True})
    install_transport(monkeypatch, handler)
    async def emit(_kind, _value):
        pass

    tool = build_question_tool(config(), payload(), Sandbox({"a.png": raw}), emit, pending)
    with pytest.raises(WorkError):
        await tool.execute(QUESTIONS)
    assert pending == [item] and not requests and tool.remote.ask_id.get() is None


@pytest.mark.asyncio
async def test_preview_total_limit_is_checked_before_posting(monkeypatch):
    raw = image_bytes("PNG")
    pending = [entry("a.png", raw, "image/png"), entry("b.png", raw, "image/png")]
    requests = []
    async def handler(request):
        requests.append(request)
        return response({"ok": True})
    install_transport(monkeypatch, handler)
    async def emit(_kind, _value):
        pass

    tool = build_question_tool(config(max_history_bytes=len(raw)), payload(), Sandbox({"a.png": raw, "b.png": raw}), emit, pending)
    with pytest.raises(WorkError) as invalid:
        await tool.execute(QUESTIONS)
    assert invalid.value.code == "file_limit" and len(pending) == 2 and not requests


@pytest.mark.asyncio
@pytest.mark.parametrize("reply", [
    {"status": "cancelled", "answers": []},
    {"status": "answered", "answers": []},
    {"status": "answered", "answers": [{"id": "style", "selected": ["未提供的选项"]}]},
    {"status": "answered", "answers": [{"id": "style", "selected": ["商务", "杂志"]}]},
])
async def test_cancelled_or_malformed_answer_stops_without_default_selection(monkeypatch, reply):
    requests = []
    async def handler(request):
        requests.append(json.loads(request.content))
        return response(reply)
    install_transport(monkeypatch, handler)
    events = []
    async def emit(kind, value):
        events.append((kind, value))
    tool = build_question_tool(config(), payload(), Sandbox(), emit, [])
    with pytest.raises(asyncio.CancelledError):
        await tool.execute(QUESTIONS)
    assert len(requests) == 1 and events and TOKEN not in json.dumps(events, ensure_ascii=False)
    assert tool.remote.ask_id.get() is None


@pytest.mark.asyncio
async def test_question_timeout_stops_the_turn_without_fabricating_an_answer(monkeypatch):
    requests = []
    async def handler(request):
        requests.append(json.loads(request.content))
        await asyncio.sleep(0.2)
        return response({"status": "pending"})
    install_transport(monkeypatch, handler)
    events = []
    async def emit(kind, value):
        events.append((kind, value))
    tool = build_question_tool(config(question_timeout_seconds=0.02), payload(), Sandbox(), emit, [])
    with pytest.raises(asyncio.CancelledError):
        await tool.execute(QUESTIONS)
    assert len(requests) == 1 and any("超时" in value.get("message", "") for _, value in events)
    assert tool.remote.ask_id.get() is None


@pytest.mark.asyncio
async def test_immediate_pending_replies_still_honor_timeout(monkeypatch):
    requests = []
    async def handler(request):
        requests.append(json.loads(request.content))
        return response({"status": "pending"})
    install_transport(monkeypatch, handler)
    async def emit(_kind, _value):
        pass
    tool = build_question_tool(config(question_timeout_seconds=0.02), payload(), Sandbox(), emit, [])
    with pytest.raises(asyncio.CancelledError):
        await tool.execute(QUESTIONS)
    assert len(requests) == 1 and tool.remote.ask_id.get() is None


@pytest.mark.asyncio
async def test_unconfirmed_preview_stops_after_bounded_idempotent_attempts_and_keeps_pending(monkeypatch):
    raw = image_bytes("PNG")
    item, requests = entry("a.png", raw, "image/png"), []
    async def handler(request):
        requests.append(json.loads(request.content))
        raise httpx.ReadTimeout("synthetic-token-must-not-leak", request=request)
    install_transport(monkeypatch, handler)
    events = []
    async def emit(kind, value):
        events.append((kind, value))
    pending = [item]
    tool = build_question_tool(config(), payload(), Sandbox({"a.png": raw}), emit, pending)
    with pytest.raises(asyncio.CancelledError):
        await tool.execute(QUESTIONS)
    assert len(requests) == 3 and all(body == requests[0] for body in requests)
    assert all(body["command"] == "question_preview" for body in requests)
    assert pending == [item] and "synthetic-token-must-not-leak" not in json.dumps(events)


def test_invalid_factory_identity_and_non_list_pending_are_rejected():
    async def emit(_kind, _value):
        pass
    for changed in ({"owner": "../foreign"}, {"session_id": "bad"}, {"account_token": "bad token"}):
        with pytest.raises(WorkError):
            build_question_tool(config(), {**payload(), **changed}, Sandbox(), emit, [])
    with pytest.raises(WorkError):
        build_question_tool(config(), payload(), Sandbox(), emit, SimpleNamespace())
