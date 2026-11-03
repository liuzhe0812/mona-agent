"""Regression coverage for native/host handoff, not live accounts or model calls."""
import asyncio
import base64
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image
from test_sdk_workbench import _event_host
from test_work_native import _install_native_work_image_hosts

from mona.development.contracts import ExecutorId
from mona.development.executors.base import NativeEvent
from mona.development.executors.sdk_events import SDKEventProjector
from mona.development.executors.sdk_worker import Worker
from mona.providers.native_work_provider import NativeWorkProvider


def complete_native(item="write", turn="turn-0"):
    return NativeEvent(type="tool.completed", native_turn_id=turn,
                       payload={"itemId": item, "isError": False})


@pytest.mark.parametrize("malformed", ['{"type":', '{"type":NaN}\n', '[]\n', 'garbage\n'])
async def test_bad_native_frame_cannot_be_silently_skipped(malformed):
    from mona.development.executors.codebuddy_transport import _stdout_json_lines
    from mona.development.executors.rpc import RpcError
    async def stream():
        yield malformed
        if malformed.endswith("\n"):
            yield '{"type":"result","subtype":"success"}\n'
    with pytest.raises(RpcError) as error:
        [frame async for frame in _stdout_json_lines(stream())]
    assert error.value.code == "native_protocol_error" and error.value.outcome_unknown
    assert malformed not in str(error.value)


async def test_standalone_codebuddy_uses_the_same_lossless_frame_boundary(monkeypatch):
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    import json

    from codebuddy_agent_sdk.transport import SubprocessTransport

    from mona.development.executors import codebuddy_transport
    payload = {"type": "assistant", "text": "中" * 100 + "  preserve whitespace  "}
    frame = json.dumps(payload, ensure_ascii=False)
    async def stdout():
        yield frame[:23]
        yield frame[23:]
        yield "\n"
    async def connect(transport):
        transport._process = SimpleNamespace(returncode=0)
        transport._stdout_stream = stdout()
    monkeypatch.setattr(SubprocessTransport, "connect", connect)
    monkeypatch.setattr(codebuddy_transport, "workbuddy_cli_launcher", lambda _: None)
    monkeypatch.delenv("ELECTRON_RUN_AS_NODE", raising=False)
    transport = codebuddy_transport.desktop_transport("fixture-cli", options=sdk.CodeBuddyAgentOptions())
    assert transport is not None
    await transport.connect()
    assert [message async for message in transport.read_messages()] == [payload]


def test_next_user_turn_preserves_native_operation_evidence_in_history(tmp_path):
    from mona.providers.native_work_provider import native_history_input
    from mona.session.manager import SessionManager
    record = {"native_session_id": "original", "status": "unknown", "calls": [
        {"id": "write-once", "name": "Write", "status": "unknown", "path": "output/report.txt"}]}
    session = SessionManager(tmp_path).get_or_create("test:workbuddy-history")
    session.add_message("user", "create report")
    session.add_message("assistant", "interrupted", native_work=record)
    session.add_message("user", "check results before continuing")
    blocks = native_history_input(session.get_history(model_view=True))
    text = "\n".join(block["text"] for block in blocks)
    assert text.count("write-once") == 1 and "unknown" in text and "output/report.txt" in text
    assert "不要重新执行" in text and "不要重放未确认的操作" in text
    assert session.messages[1]["native_work"] == record


async def test_failed_original_turn_queued_at_image_boundary_cannot_be_restarted(tmp_path, monkeypatch):
    provider, state, _ = await paused_provider(tmp_path, monkeypatch)
    await state["hosts"][0].events_queue.put(NativeEvent(type="run.failed", native_turn_id="turn-0",
                                                       payload={"errorCode": "native_execution_failed"}))
    try:
        with pytest.raises(Exception):
            await asyncio.wait_for(provider._reset_context(), 1)
        assert provider._context_reset_failed and len(state["hosts"]) == 1
    finally:
        await provider.aclose()


async def paused_provider(tmp_path, monkeypatch):
    config, state = _install_native_work_image_hosts(monkeypatch, tmp_path, "codebuddy", hold=True)
    provider = NativeWorkProvider(config, tmp_path / "work")
    initial = [{"role": "system", "content": "unchanged system"}, {"role": "user", "content": "inspect"}]
    await provider._start(initial, [], "native-fixture", None)
    return provider, state, initial


@pytest.mark.parametrize("delay", [0, 0.02])
async def test_rebuild_consumes_native_completion_before_rejecting_pending_write(tmp_path, monkeypatch, delay):
    provider, state, _ = await paused_provider(tmp_path, monkeypatch)
    target = tmp_path / "work" / "already-written.txt"
    target.write_text("write once", encoding="utf-8")
    provider._native_calls["write"] = {"id": "write", "name": "Write", "status": "started",
        "native_session_id": "native-work-0", "native_turn_id": "turn-0", "path": str(target)}
    async def native_completion():
        await asyncio.sleep(delay)
        await state["hosts"][0].events_queue.put(complete_native())
    sender = asyncio.create_task(native_completion())
    try:
        await asyncio.wait_for(provider._reset_context(), 1)
        assert provider._native_calls["write"]["status"] == "completed"
        assert not provider._context_reset_failed
        assert len(state["hosts"]) == 1 and len(state["hosts"][0].sent) == 1
        assert target.read_text(encoding="utf-8") == "write once"
        assert state["hosts"][0].shutdown_complete
    finally:
        await sender
        await provider.aclose()


@pytest.mark.parametrize("foreign_receipt", [False, True])
async def test_missing_or_foreign_native_receipt_never_restarts_the_task(tmp_path, monkeypatch, foreign_receipt):
    from mona.development.executors.rpc import RpcError
    provider, state, _ = await paused_provider(tmp_path, monkeypatch)
    monkeypatch.setattr(provider.config.tools.exec, "timeout", 0.03)
    provider._native_calls["write"] = {"id": "write", "name": "Write", "status": "started",
        "native_session_id": "native-work-0", "native_turn_id": "turn-0"}
    if foreign_receipt:
        await state["hosts"][0].events_queue.put(complete_native(turn="other-turn"))
    try:
        with pytest.raises(RpcError) as error:
            await asyncio.wait_for(provider._reset_context(), 1)
        assert error.value.code == "native_turn_incomplete"
        assert provider._context_reset_failed
        assert provider._native_calls["write"]["status"] == "started"
        assert len(state["hosts"]) == 1 and len(state["hosts"][0].sent) == 1
    finally:
        await provider.aclose()


async def test_cancellation_during_native_settlement_closes_only_original_execution(tmp_path, monkeypatch):
    provider, state, _ = await paused_provider(tmp_path, monkeypatch)
    provider._native_calls["write"] = {"id": "write", "name": "Write", "status": "started",
        "native_session_id": "native-work-0", "native_turn_id": "turn-0"}
    task = asyncio.create_task(provider._reset_context())
    try:
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert provider._context_reset_failed and len(state["hosts"]) == 1
        assert provider._native_calls["write"]["status"] == "started"
    finally:
        await provider.aclose()
    assert state["hosts"][0].shutdown_complete
    assert len(state["hosts"][0].sent) == 1


async def test_image_handoff_returns_other_pending_host_call_before_reset(tmp_path, monkeypatch):
    image = io.BytesIO()
    Image.new("RGB", (1, 1)).save(image, format="PNG")
    url = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode()
    provider, state, initial = await paused_provider(tmp_path, monkeypatch)
    first = asyncio.create_task(provider._host_tool(provider._binding, "turn-0", {"tool": "office", "arguments": {"action": "inspect"}}))
    second = asyncio.create_task(provider._host_tool(provider._binding, "turn-0", {"tool": "fixture_save", "arguments": {"value": "once"}}))
    try:
        response = await asyncio.wait_for(provider.chat_stream(initial, model="native-fixture"), 1)
        call = response.tool_calls[0]
        assert call.name == "office"
        history = [*initial, {"role": "assistant", "tool_calls": [{"id": call.id, "function": {"name": call.name, "arguments": "{}"}}]},
                   {"role": "tool", "tool_call_id": call.id, "content": [{"type": "image_url", "image_url": {"url": url}}]}]
        reply = await asyncio.wait_for(provider.chat_stream(history, model="native-fixture"), 1)
        assert len(reply.tool_calls) == 1 and reply.tool_calls[0].name == "fixture_save"
        assert not state["hosts"][0].shutdown_complete
        assert not first.done() and not second.done()
    finally:
        await provider.aclose()
        await asyncio.gather(first, second, return_exceptions=True)


async def test_native_success_cannot_hide_unconfirmed_operation(tmp_path, monkeypatch):
    provider, state, initial = await paused_provider(tmp_path, monkeypatch)
    provider._native_calls["write"] = {"id": "write", "name": "Write", "status": "started",
        "native_session_id": "native-work-0", "native_turn_id": "turn-0"}
    await state["hosts"][0].events_queue.put(NativeEvent(type="run.completed", native_turn_id="turn-0"))
    try:
        reply = await asyncio.wait_for(provider.chat_stream(initial), 1)
        assert reply.error_code == "native_turn_incomplete"
        assert not reply.error_should_retry
        assert provider._native_calls["write"]["status"] == "unknown"
    finally:
        await provider.aclose()


@pytest.mark.parametrize("terminal", ["run.failed", "run.unknown", "run.interrupted"])
async def test_rebuild_never_replays_after_original_turn_error(tmp_path, monkeypatch, terminal):
    provider, state, _ = await paused_provider(tmp_path, monkeypatch)
    provider._native_calls["write"] = {"id": "write", "name": "Write", "status": "started",
        "native_session_id": "native-work-0", "native_turn_id": "turn-0"}
    await state["hosts"][0].events_queue.put(NativeEvent(type=terminal, native_turn_id="turn-0",
        payload={"reason": "sdk_stream_ended_without_result", "errorCode": "native_execution_failed"}))
    try:
        with pytest.raises(Exception):
            await asyncio.wait_for(provider._reset_context(), 1)
        assert provider._context_reset_failed
        assert len(state["hosts"]) == 1
    finally:
        await provider.aclose()


@pytest.mark.parametrize("failure", [False, True])
async def test_post_tool_receipt_does_not_wait_for_blocked_host_tool(failure):
    worker = Worker()
    worker.start = {"workPrompt": "stable", "workNativeTools": ["Write"]}
    worker.active = "sdk:test"
    worker.projector = SDKEventProjector("session", work_tool=True, native_tools=["Write"], executor=ExecutorId.CODEBUDDY)
    worker.projector.begin(worker.active)
    worker.ask = AsyncMock(return_value={"allow": True})
    output = []
    worker.write = output.append
    assert (await worker.work_native_permission(worker.active, "native-write", "Write", {"file_path": "report.txt"}))["allow"]
    hook = {"hook_event_name": "PostToolUseFailure" if failure else "PostToolUse", "session_id": "session",
            "tool_use_id": "native-write", "tool_name": "Write", "tool_response": {"private_body": "DO_NOT_LOG"}}
    await worker.work_native_post_tool(hook, "native-write", None)
    assert len(output) == 1
    event = NativeEvent.model_validate(output[0]["params"])
    assert event.type == "tool.completed" and event.native_turn_id == "sdk:test"
    assert event.payload["itemId"] == "native-write" and event.payload["isError"] is failure
    assert "DO_NOT_LOG" not in str(output)
    await worker.work_native_post_tool(hook, "native-write", None)
    assert len(output) == 1
    for changed in [{**hook, "tool_use_id": "foreign"}, {**hook, "session_id": "foreign"}, {**hook, "tool_name": "Read"}]:
        await worker.work_native_post_tool(changed, "native-write", None)
    assert len(output) == 1


async def test_sdk_send_cancellation_propagates_and_does_not_repeat(tmp_path):
    host, binding, runtime = _event_host(tmp_path, work_mode=True)
    runtime.status = "idle"
    entered = asyncio.Event()
    async def request(*_args):
        entered.set()
        await asyncio.Event().wait()
    runtime.connection = SimpleNamespace(closed=False, request=AsyncMock(side_effect=request), close=AsyncMock())
    task = asyncio.create_task(host.send(binding, "input", "hello"))
    await entered.wait()
    task.cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await task
        assert runtime.status == "unknown" and not runtime.dispatching
        assert runtime.connection.request.await_count == 1
        runtime.connection.request = AsyncMock(return_value={"closed": True})
    finally:
        await host.shutdown()


@pytest.mark.parametrize("reply", [None, [], "invalid", {"inputId": "wrong", "turnId": "sdk:input"}])
async def test_sdk_malformed_acceptance_is_unknown_not_stuck_starting(tmp_path, reply):
    host, binding, runtime = _event_host(tmp_path, work_mode=True)
    runtime.status = "idle"
    runtime.connection = SimpleNamespace(closed=False, request=AsyncMock(return_value=reply), close=AsyncMock())
    try:
        result = await host.send(binding, "input", "hello")
        assert result.outcome == "unknown" and runtime.status == "unknown"
        assert not runtime.dispatching
        assert (await host.send(binding, "another", "do not duplicate")).outcome == "rejected"
        runtime.connection.request = AsyncMock(return_value={"closed": True})
    finally:
        await host.shutdown()
