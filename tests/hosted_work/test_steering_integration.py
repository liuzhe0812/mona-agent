"""Real HTTP/WS steering integration with the declared synthetic model fixture.

No production model, account credential, SSH connection or container is used.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
from io import BytesIO
from types import SimpleNamespace
from urllib.parse import urlsplit

from PIL import Image

from mona.hosted_work.context import build_turn_context
from mona.hosted_work.desktop_api import PREFIX
from mona.hosted_work.remote_inputs import RemoteInputs
from mona.hosted_work.steering_attachments import sandbox_target
from mona.hosted_work.tools import HostedTools
from tests.hosted_work.test_context import Provider
from tests.hosted_work.test_shared_interaction_integration import (
    ALICE,
    BOB,
    RID,
    SID_A,
    SID_B,
    connect,
    headers,
    receive,
)
from tests.hosted_work.test_shared_interaction_integration import (
    environment as environment,
)


def steering(input_id, content, **changes):
    return {"type": "message", "chat_id": SID_A, "target_turn_id": RID,
            "input_id": input_id, "content": content, **changes}


async def send_input(socket, frame):
    await socket.send_json(frame)
    state = await receive(socket, "work_input_state", lambda item: item["input_id"] == frame["input_id"])
    accepted = await receive(socket, "message_accepted", lambda item: item["input_id"] == frame["input_id"])
    assert state == {"event": "work_input_state", "chat_id": SID_A,
                     "input_id": frame["input_id"], "turn_id": RID, "state": "accepted"}
    assert accepted["target_turn_id"] == RID


async def input_rpc(e, command, request_id, *, limit=3, account="alice", sid=SID_A, rid=RID):
    args = {"request_id": request_id, **({"limit": limit} if command == "input_poll" else {})}
    return await e.client.post(PREFIX + "/internal/tool", headers=headers(account),
        json={"run_id": rid, "session_id": sid, "command": command, "args": args})


async def history(e):
    response = await e.client.get(PREFIX + f"/api/sessions/websocket:{SID_A}/webui-thread", headers=headers())
    assert response.status == 200
    return await response.json()


async def test_ws_steering_http_receipts_and_child_poll_deliver_each_input_once(environment):
    e = environment
    socket = await connect(e)
    frame = steering("guide-1", "请把标题改为中文")
    await send_input(socket, frame)
    await send_input(socket, frame)
    changed = {**frame, "content": "覆盖成其他文字"}
    await socket.send_json(changed)
    conflict = await receive(socket, "error", lambda item: item.get("input_id") == "guide-1")
    assert conflict["code"] == "input_conflict" and conflict["message_rejected"] is True

    expected = {"request_id": "poll-1", "inputs": [{"input_id": "guide-1", "content": frame["content"]}]}
    for _ in range(2):
        response = await input_rpc(e, "input_poll", "poll-1")
        assert response.status == 200 and (await response.json())["result"] == expected
    assert (await e.api.inputs.snapshot(ALICE, SID_A))[0]["state"] == "accepted"
    assert (await input_rpc(e, "input_poll", "different-before-ack")).status == 409
    expected_states = [{"chat_id": SID_A, "input_id": "guide-1", "turn_id": RID, "state": "consumed"}]
    for _ in range(2):
        response = await input_rpc(e, "input_ack", "poll-1")
        assert response.status == 200 and (await response.json())["result"] == {"states": expected_states}
    # Retrying the original receipt preserves its exact batch, without queuing it again.
    retry = await input_rpc(e, "input_poll", "poll-1")
    assert retry.status == 200 and (await retry.json())["result"] == expected

    second = steering("guide-2", "另加一段结论")
    await send_input(socket, second)
    remote = RemoteInputs(e.service.config, e.executor.calls[0], e.executor.emit)
    assert await remote.poll(phase="after_tools") == [{
        "role": "user", "id": "guide-2", "content": second["content"], "source_kind": "steering"}]
    assert await remote.poll(phase="after_tools") == []
    snapshots = await e.api.inputs.snapshot(ALICE, SID_A)
    assert snapshots == [*expected_states, {"chat_id": SID_A, "input_id": "guide-2", "turn_id": RID, "state": "consumed"}]

    await socket.close()
    resumed = await connect(e)
    restored = [await receive(resumed, "work_input_state") for _ in range(2)]
    assert [{key: value for key, value in item.items() if key != "event"} for item in restored] == snapshots
    messages = (await history(e))["messages"]
    for frame in (frame, second):
        matches = [item for item in messages if item.get("content") == frame["content"]]
        assert len(matches) == 1 and matches[0]["role"] == "user" and matches[0]["id"] == frame["input_id"]
        source = matches[0]["sourceTranscriptIndex"]
        assert e.api.state.records(ALICE, SID_A)[source][0]["input_id"] == frame["input_id"]
    assert len(e.executor.calls) == 1
    e.executor.release.set()
    await receive(resumed, "turn_end")
    assert e.service.store.run(ALICE, RID)["status"] == "completed"


async def test_steering_rejects_other_accounts_and_mismatched_sessions(environment):
    e = environment
    alice, bob = await connect(e), await connect(e, "bob")
    for sid, expected in ((SID_A, "not_found"), (SID_B, "input_turn_conflict")):
        await bob.send_json(steering("foreign-" + sid, "不能加入别人的任务", chat_id=sid))
        rejected = await receive(bob, "error")
        assert rejected["code"] == expected and rejected["message_rejected"] is True
    for command in ("input_poll", "input_ack"):
        assert (await input_rpc(e, command, "foreign", account="bob")).status == 404
        assert (await input_rpc(e, command, "foreign", account="bob", sid=SID_B)).status == 404

    other_sid = "4" * 32
    created = await e.client.post("/api/work/sessions", headers=headers(), json={"request_id": other_sid})
    assert created.status == 201
    await alice.send_json(steering("wrong-session", "不属于这个会话", chat_id=other_sid))
    assert (await receive(alice, "error"))["code"] == "input_turn_conflict"
    for command in ("input_poll", "input_ack"):
        assert (await input_rpc(e, command, "wrong-session", sid=other_sid)).status == 409
    await alice.send_json(steering("wrong-run", "不能悄悄新建任务", target_turn_id="5" * 32))
    assert (await receive(alice, "error"))["code"] == "input_turn_conflict"
    await alice.send_json(steering("unsupported-attachment", "追加附件", doc_paths=["/workspace/fixture.txt"]))
    assert (await receive(alice, "error"))["code"] == "not_found"
    assert await e.api.inputs.snapshot(ALICE, SID_A) == []
    assert await e.api.inputs.snapshot(BOB, SID_B) == []
    assert len(e.executor.calls) == 1 and len(e.service.store.session_detail(ALICE, SID_A)["runs"]) == 1


async def test_stop_pauses_unconsumed_inputs_and_refresh_never_starts_another_turn(environment):
    e = environment
    socket = await connect(e)
    frames = [steering("paused-1", "先保留这段补充"), steering("paused-2", "这段也不要丢失")]
    for frame in frames:
        await send_input(socket, frame)
    offered = await input_rpc(e, "input_poll", "offered-before-stop", limit=1)
    assert offered.status == 200 and (await offered.json())["result"]["inputs"] == [
        {"input_id": frames[0]["input_id"], "content": frames[0]["content"]}]
    await socket.send_json({"type": "stop_work_turn", "chat_id": SID_A,
                            "request_id": "stop-steering", "expected_turn_id": RID})
    stopped = await receive(socket, "work_turn_stop_result")
    assert stopped["ok"] is True and stopped["outcome"] == "stopped"
    paused = [{"chat_id": SID_A, "input_id": frame["input_id"], "turn_id": RID, "state": "paused"} for frame in frames]
    assert await e.api.inputs.snapshot(ALICE, SID_A) == paused
    assert (await input_rpc(e, "input_ack", "offered-before-stop")).status == 409
    assert (await input_rpc(e, "input_poll", "after-stop")).status == 409
    await socket.close()

    resumed = await connect(e)
    snapshots = [await receive(resumed, "work_input_state") for _ in frames]
    assert [{key: value for key, value in item.items() if key != "event"} for item in snapshots] == paused
    assert (await receive(resumed, "goal_status"))["status"] == "idle"
    for frame in frames:
        await resumed.send_json(frame)
        rejected = await receive(resumed, "error", lambda item: item.get("input_id") == frame["input_id"])
        assert rejected["code"] == "input_turn_conflict" and rejected["message_rejected"] is True
    await resumed.send_json({**frames[0], "resume_input": True})
    assert (await receive(resumed, "error"))["code"] == "input_turn_conflict"
    messages = (await history(e))["messages"]
    for frame in frames:
        matches = [item for item in messages if item.get("id") == frame["input_id"]]
        assert len(matches) == 1 and matches[0]["content"] == frame["content"]
    await asyncio.sleep(0)
    assert await e.api.inputs.snapshot(ALICE, SID_A) == paused
    assert e.service.store.run(ALICE, RID)["status"] == "cancelled"
    assert len(e.executor.calls) == 1 and len(e.service.store.session_detail(ALICE, SID_A)["runs"]) == 1


async def test_attachment_only_steering_refresh_import_and_canonical_history(environment):
    """HTTP/WS/storage are real; only the receiving sandbox is an in-memory byte fixture."""
    e = environment
    socket = await connect(e)
    for frame, code in ((steering("bad-image", "", media=[{
            "name": "bad.png", "data_url": "data:image/png;base64," + base64.b64encode(b"not an image").decode()}]),
            "unsupported_media"),
            (steering("missing-file", "", doc_paths=["/workspace/uploads/" + "f" * 32 + "/missing.txt"]), "not_found")):
        await socket.send_json(frame)
        rejected = await receive(socket, "error", lambda item: item.get("input_id") == frame["input_id"])
        assert rejected["code"] == code and rejected["message_rejected"] is True
    assert await e.api.inputs.snapshot(ALICE, SID_A) == []

    document = "真实附件原文：保留这份参考资料。\n".encode()
    await socket.send_json({"type": "doc_upload", "chat_id": SID_A, "request_id": "upload-reference", "files": [{
        "name": "reference.txt", "data_url": "data:text/plain;base64," + base64.b64encode(document).decode()}]})
    uploaded = await receive(socket, "doc_upload_result")
    assert uploaded["ok"] is True and uploaded["files"][0]["size"] == len(document)
    doc_path = uploaded["files"][0]["path"]
    image = BytesIO()
    Image.new("RGB", (7, 4), (80, 130, 200)).save(image, format="PNG")
    png = image.getvalue()
    frame = steering("files-only", "", doc_paths=[doc_path], media=[{
        "name": "reference.png", "data_url": "data:image/png;base64," + base64.b64encode(png).decode()}],
        ui_theme="dark", office_session_id="office_reference", office_document_type="docs", office_display_name="参考资料")
    await send_input(socket, frame)
    queued = e.api.state.get(ALICE, "work_inputs:" + SID_A)["inputs"]["files-only"]
    descriptors = queued["attachments"]
    expected_bytes = {"reference.txt": document, "reference.png": png}
    assert queued["content"] == "" and len(descriptors) == 2
    assert queued["metadata"]["ui_theme"] == "dark"
    for item in descriptors:
        raw = expected_bytes[item["name"]]
        assert item["size"] == len(raw) and item["sha256"] == hashlib.sha256(raw).hexdigest()
        assert e.api.files._path(e.api.files.root(ALICE), item["path"]).read_bytes() == raw
        assert "data" not in item and "data_url" not in item

    await socket.close()
    resumed = await connect(e)
    restored = await receive(resumed, "work_input_state", lambda item: item["input_id"] == "files-only")
    assert restored["state"] == "accepted"
    user = next(item for item in (await history(e))["messages"] if item["id"] == "files-only")
    assert user["content"] == "" and user["media"][0]["name"] == "reference.png"
    media_path = urlsplit(user["media"][0]["url"]).path
    media = await e.client.get(media_path)
    assert media.status == 200 and await media.read() == png
    denied = await e.client.get(media_path, headers=headers("bob"))
    assert denied.status == 404
    denied = await e.client.get(PREFIX + "/api/file-preview", headers=headers("bob"),
        params={"session_key": "websocket:" + SID_B, "path": doc_path})
    assert denied.status == 404 and document not in await denied.read()
    assert (await input_rpc(e, "input_poll", "steal-files", account="bob")).status == 404
    offered = []
    for _ in range(2):
        response = await input_rpc(e, "input_poll", "files-import")
        assert response.status == 200
        offered.append((await response.json())["result"])
    assert offered[0] == offered[1]
    offered_input = offered[0]["inputs"][0]
    assert offered_input["content"] == "" and offered_input["metadata"] == queued["metadata"]
    for attachment in offered_input["attachments"]:
        assert base64.b64decode(attachment["data"], validate=True) == expected_bytes[attachment["name"]]

    class SandboxBytes:
        """Declared sandbox boundary; imports decode and store the exact received bytes."""

        def __init__(self):
            self.files, self.calls = {}, []

        async def file(self, request):
            assert set(request) == {"action", "path", "data"} and request["action"] == "upload"
            raw = base64.b64decode(request["data"], validate=True)
            self.files[request["path"]] = raw
            self.calls.append(request)
            return {"path": request["path"], "name": request["path"].rsplit("/", 1)[1],
                    "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}

    async def local_emit(_kind, _value):
        pass

    # The actual shared context builder runs without an owner, private profile,
    # desktop session manager or an account runtime directory.
    payload = {**e.executor.calls[0], "context_state": {}}
    payload.pop("owner")
    tools = HostedTools(SimpleNamespace(config=e.service.config), local_emit, config=e.service.config,
                        history=payload["history"])
    runtime = await build_turn_context(e.service.config, payload, tools, Provider(), local_emit)
    assert runtime._runtime is None and runtime._state_path is None and runtime.session.key == "websocket:" + SID_A
    sandbox = SandboxBytes()
    remote = RemoteInputs(e.service.config, e.executor.calls[0], e.executor.emit, sandbox=sandbox, runtime=runtime)
    # Resume the same reserved receipt, as after a lost poll response.
    remote._request_id = "files-import"
    projected = await remote.poll()
    assert len(projected) == 1 and projected[0]["id"] == "files-only"
    assert len(sandbox.calls) == 2
    for item in descriptors:
        target = sandbox_target(SID_A, "files-only", item)
        assert sandbox.files[target] == expected_bytes[item["name"]]
        assert hashlib.sha256(sandbox.files[target]).hexdigest() == item["sha256"]
    blocks = projected[0]["content"]
    assert blocks[0]["image_url"]["url"] == "data:image/png;base64," + base64.b64encode(png).decode()
    image_descriptor = next(item for item in descriptors if item["name"] == "reference.png")
    assert blocks[0]["_meta"]["path"] == "/workspace/" + sandbox_target(SID_A, "files-only", image_descriptor)
    assert blocks[-1]["type"] == "text" and "Current UI Theme: dark" in blocks[-1]["text"]
    assert "Active Office Document: 参考资料" in blocks[-1]["text"]
    for item in descriptors:
        assert sandbox_target(SID_A, "files-only", item) in blocks[-1]["text"]
    canonical = runtime.history_for_storage([*runtime.messages, *projected])
    assert canonical[-1]["id"] == "files-only" and canonical[-1]["content"] == "" and canonical[-1]["timestamp"]
    assert await remote.poll() == [] and len(sandbox.calls) == 2
    # Duplicate delivery of the same browser input cannot import or consume again.
    await resumed.send_json(frame)
    consumed = await receive(resumed, "work_input_state", lambda item: item["input_id"] == "files-only")
    assert consumed["state"] == "consumed"
    await receive(resumed, "message_accepted", lambda item: item["input_id"] == "files-only")
    assert await remote.poll() == [] and len(sandbox.calls) == 2
    assert len([item for item in (await history(e))["messages"] if item["id"] == "files-only"]) == 1
    assert (await e.api.inputs.snapshot(ALICE, SID_A))[0]["state"] == "consumed"
    assert len(e.executor.calls) == 1
