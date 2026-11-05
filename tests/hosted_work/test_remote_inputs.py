"""Run-bound steering must retry receipts without replaying inputs."""
import asyncio
import base64
import hashlib
import json
from types import SimpleNamespace

import httpx
import pytest

from mona.agent.tools.capabilities import (
    activate_capabilities,
    bind_capability_context,
    tool_enabled_by_capability,
)
from mona.agent.tools.context import RequestContext
from mona.hosted_work.remote_inputs import RemoteInputs
from mona.hosted_work.steering_attachments import sandbox_target
from tests.hosted_work.test_question_tool import (
    RID,
    SID,
    TOKEN,
    config,
    install_transport,
    payload,
    response,
)


def state(value, **changes):
    return {"chat_id": SID, "turn_id": RID, "input_id": value, "state": "consumed", **changes}


@pytest.mark.asyncio
async def test_poll_and_ack_retry_same_id_and_return_once(monkeypatch):
    requests, events = [], []
    attempts = {"input_poll": 0, "input_ack": 0}

    async def handler(request):
        body = json.loads(request.content)
        requests.append((body, request))
        command = body["command"]
        attempts[command] += 1
        if attempts[command] == 1:
            raise httpx.ReadTimeout("private transport " + TOKEN, request=request)
        if command == "input_poll":
            inputs = [{"input_id": "one", "content": "追加说明"}] if attempts["input_ack"] < 2 else []
            return response({"request_id": body["args"]["request_id"], "inputs": inputs})
        return response({"states": [state("one")]})

    settings = install_transport(monkeypatch, handler)
    async def emit(kind, value):
        events.append((kind, value))

    remote = RemoteInputs(config(), payload(), emit)
    result = await remote.poll(limit=99)
    assert result == [{"role": "user", "id": "one", "content": "追加说明", "source_kind": "steering"}]
    assert [body["command"] for body, _ in requests] == ["input_poll", "input_poll", "input_ack", "input_ack"]
    bodies = [body for body, _ in requests]
    assert bodies[0] == bodies[1] and bodies[2] == bodies[3]
    request_id = bodies[0]["args"]["request_id"]
    assert len(request_id) == 32 and bodies[0]["args"]["limit"] == 3
    assert bodies[2]["args"] == {"request_id": request_id}
    assert all(body["run_id"] == RID and body["session_id"] == SID for body in bodies)
    assert all(request.headers["Authorization"] == "Bearer " + TOKEN for _, request in requests)
    assert all(TOKEN not in json.dumps(body) for body in bodies)
    assert all(value == {"trust_env": False, "follow_redirects": False, "timeout": 35} for value in settings)
    assert not events
    assert await remote.poll(limit=1) == []
    assert requests[-1][0]["args"]["request_id"] != request_id


@pytest.mark.asyncio
@pytest.mark.parametrize("wrong_state", [
    {"state": "accepted"}, {"chat_id": "c" * 32}, {"turn_id": "d" * 32}, {"input_id": "other"},
    {"input_id": ["invalid"]},
])
async def test_invalid_ack_stops_and_cannot_send_or_dispatch_again(monkeypatch, wrong_state):
    requests, events = [], []

    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        if body["command"] == "input_poll":
            return response({"request_id": body["args"]["request_id"],
                             "inputs": [{"input_id": "one", "content": "不能重复"}]})
        return response({"states": [state("one", **wrong_state)]})

    install_transport(monkeypatch, handler)
    async def emit(kind, value):
        events.append((kind, value))

    remote = RemoteInputs(config(), payload(), emit)
    with pytest.raises(asyncio.CancelledError):
        await remote.poll()
    assert [body["command"] for body in requests] == ["input_poll", "input_ack"]
    with pytest.raises(asyncio.CancelledError):
        await remote.poll()
    assert len(requests) == 2 and any("无法确认" in value.get("message", "") for _, value in events)
    assert TOKEN not in json.dumps(events, ensure_ascii=False)


@pytest.mark.asyncio
@pytest.mark.parametrize("items", [
    [{"input_id": "same", "content": "a"}, {"input_id": "same", "content": "b"}],
    [{"input_id": "bad\n", "content": "a"}],
    [{"input_id": "one", "content": "\ud800"}],
    [{"input_id": "one", "content": "x" * 50001}],
    [{"input_id": str(i), "content": "x"} for i in range(4)],
])
async def test_invalid_poll_batch_is_never_acknowledged(monkeypatch, items):
    requests = []
    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        raw = json.dumps({"result": {"request_id": body["args"]["request_id"], "inputs": items}}, ensure_ascii=True)
        return httpx.Response(200, content=raw.encode("ascii"), headers={"Content-Type": "application/json"})

    install_transport(monkeypatch, handler)
    async def emit(_kind, _value):
        pass
    remote = RemoteInputs(config(), payload(), emit)
    with pytest.raises(asyncio.CancelledError):
        await remote.poll(limit=3)
    assert len(requests) == 1 and requests[0]["command"] == "input_poll"
    with pytest.raises(asyncio.CancelledError):
        await remote.poll()
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_transport_failure_stops_without_exposing_error_or_retrying_a_new_batch(monkeypatch):
    requests, events = [], []
    async def handler(request):
        requests.append(json.loads(request.content))
        raise httpx.ReadTimeout("private diagnostic " + TOKEN, request=request)

    install_transport(monkeypatch, handler)
    async def emit(kind, value):
        events.append((kind, value))
    remote = RemoteInputs(config(), payload(), emit)
    with pytest.raises(asyncio.CancelledError) as error:
        await remote.poll()
    assert len(requests) == 3 and all(value == requests[0] for value in requests)
    assert "会话连接" in str(error.value)
    assert "private diagnostic" not in str(error.value) + json.dumps(events, ensure_ascii=False)
    assert TOKEN not in str(error.value) + json.dumps(events, ensure_ascii=False)
    with pytest.raises(asyncio.CancelledError):
        await remote.poll()
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_concurrent_polls_cannot_dispatch_the_same_batch_twice(monkeypatch):
    requests, started, release = [], asyncio.Event(), asyncio.Event()
    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        rid = body["args"]["request_id"]
        if body["command"] == "input_poll":
            if len(requests) == 1:
                started.set()
                await release.wait()
            return response({"request_id": rid, "inputs": [{"input_id": rid, "content": "指引"}]})
        return response({"states": [state(rid)]})

    install_transport(monkeypatch, handler)
    async def emit(_kind, _value):
        pass
    remote = RemoteInputs(config(), payload(), emit)
    first = asyncio.create_task(remote.poll(limit=1))
    await started.wait()
    second = asyncio.create_task(remote.poll(limit=1))
    await asyncio.sleep(0)
    assert len(requests) == 1
    release.set()
    values = await asyncio.gather(first, second)
    assert values[0][0]["id"] != values[1][0]["id"]
    assert [body["command"] for body in requests] == ["input_poll", "input_ack", "input_poll", "input_ack"]


@pytest.mark.asyncio
async def test_attachment_is_verified_and_uploaded_before_ack_and_projection(monkeypatch):
    raw = b"\x89PNG\r\n\x1a\nimage-fixture"
    descriptor = {"path": "/workspace/uploads/" + "1" * 32 + "/image.png", "name": "image.png",
                  "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    target = sandbox_target(SID, "image-input", descriptor)
    attachment = {**descriptor, "target_path": target, "data": base64.b64encode(raw).decode()}
    calls, requests, projections = [], [], []

    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        if body["command"] == "input_poll":
            return response({"request_id": body["args"]["request_id"], "inputs": [{"input_id": "image-input",
                "content": "", "attachments": [attachment], "metadata": {"ui_theme": "dark", "office_session_id": "office-1"}}]})
        calls.append("ack")
        if sum(row["command"] == "input_ack" for row in requests) == 1:
            raise httpx.ReadTimeout("lost ack response", request=request)
        return response({"states": [state("image-input")]})

    class Builder:
        def build_messages(self, history, text, **kwargs):
            assert not history and text == ""
            assert kwargs["message_metadata"] == {"ui_theme": "dark", "office_session_id": "office-1", "_attachment_paths": [target]}
            return [{"role": "system", "content": "static"}, {"role": "user", "content": "runtime projection"}]

    async def upload(request):
        calls.append("upload")
        assert request == {"action": "upload", "path": target, "data": attachment["data"]}
        return {"path": target, "name": "image.png", "size": len(raw), "sha256": descriptor["sha256"]}

    def register(input_id, original, projected):
        calls.append("register")
        projections.append((input_id, original, projected))

    runtime = SimpleNamespace(builder=Builder(), session=SimpleNamespace(metadata={}), register_injection_projection=register)
    install_transport(monkeypatch, handler)
    async def emit(_kind, _value):
        pass
    bind_capability_context(RequestContext(channel="websocket", chat_id=SID))
    activate_capabilities({"development"})
    assert not tool_enabled_by_capability("office")
    remote = RemoteInputs(config(), payload(), emit, sandbox=SimpleNamespace(file=upload), runtime=runtime)
    result = await remote.poll()
    assert calls == ["upload", "register", "ack", "ack"]
    assert requests[1] == requests[2]
    assert result[0]["id"] == "image-input" and result[0]["source_kind"] == "steering"
    assert result[0]["content"][0]["image_url"]["url"] == "data:image/png;base64," + attachment["data"]
    assert result[0]["content"][1] == {"type": "text", "text": "runtime projection"}
    assert projections == [("image-input", "", result[0]["content"])]
    assert tool_enabled_by_capability("office") and tool_enabled_by_capability("exec")


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["bad_data", "bad_target", "bad_upload"])
async def test_bad_attachment_stops_before_ack(monkeypatch, kind):
    raw = b"\x89PNG\r\n\x1a\nimage-fixture"
    descriptor = {"path": "/workspace/uploads/" + "1" * 32 + "/image.png", "name": "image.png",
                  "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    target = sandbox_target(SID, "image-input", descriptor)
    attachment = {**descriptor, "target_path": target, "data": base64.b64encode(raw).decode()}
    if kind == "bad_data":
        attachment["data"] = base64.b64encode(b"tampered").decode()
    elif kind == "bad_target":
        attachment["target_path"] = "../../outside"
    requests, uploads = [], []

    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        return response({"request_id": body["args"]["request_id"], "inputs": [{"input_id": "image-input",
            "content": "请看", "attachments": [attachment]}]})

    async def upload(request):
        uploads.append(request)
        return {"path": target, "name": "image.png", "size": len(raw), "sha256": "f" * 64}

    install_transport(monkeypatch, handler)
    async def emit(_kind, _value):
        pass
    runtime = SimpleNamespace(builder=SimpleNamespace(), session=SimpleNamespace(metadata={}))
    remote = RemoteInputs(config(), payload(), emit, sandbox=SimpleNamespace(file=upload), runtime=runtime)
    with pytest.raises(asyncio.CancelledError):
        await remote.poll()
    assert [body["command"] for body in requests] == ["input_poll"]
    assert len(uploads) == (1 if kind == "bad_upload" else 0)
    with pytest.raises(asyncio.CancelledError):
        await remote.poll()
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_pdf_attachment_activates_office_without_resetting_existing_capabilities(monkeypatch):
    raw = b"%PDF-fixture"
    descriptor = {"path": "/workspace/uploads/" + "1" * 32 + "/file.pdf", "name": "file.pdf",
                  "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
    target = sandbox_target(SID, "pdf-input", descriptor)

    async def handler(request):
        body = json.loads(request.content)
        if body["command"] == "input_poll":
            return response({"request_id": body["args"]["request_id"], "inputs": [{"input_id": "pdf-input",
                "content": "阅读", "attachments": [{**descriptor, "target_path": target,
                                                       "data": base64.b64encode(raw).decode()}]}]})
        return response({"states": [state("pdf-input")]})

    async def upload(request):
        return {"path": request["path"], "name": "file.pdf", "size": len(raw), "sha256": descriptor["sha256"]}

    class Builder:
        def build_messages(self, _history, text, **_kwargs):
            return [{"role": "user", "content": text}]

    install_transport(monkeypatch, handler)
    async def emit(_kind, _value):
        pass
    bind_capability_context(RequestContext(channel="websocket", chat_id=SID))
    activate_capabilities({"development"})
    runtime = SimpleNamespace(builder=Builder(), session=SimpleNamespace(metadata={}),
                              register_injection_projection=lambda *_args: None)
    remote = RemoteInputs(config(), payload(), emit, sandbox=SimpleNamespace(file=upload), runtime=runtime)
    assert (await remote.poll())[0]["content"] == "阅读"
    assert tool_enabled_by_capability("office") and tool_enabled_by_capability("exec")
