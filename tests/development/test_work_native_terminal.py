"""Reconcile original SDK results without redispatching uncertain Work operations."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from loguru import logger

from mona.config.schema import Config
from mona.development.executors.base import NativeEvent
from mona.development.executors.sdk_events import SDKEventProjector
from mona.development.executors.sdk_worker import Worker
from mona.providers.base import ToolCallRequest
from mona.providers.native_work_provider import NativeWorkProvider


def event_provider(tmp_path, *, executor="codebuddy", timeout=0.1):
    config = Config()
    config.agents.defaults.executor = executor
    config.development.native_work_reconciliation_timeout_seconds = timeout
    provider = NativeWorkProvider(config, tmp_path)
    queue = asyncio.Queue()

    async def events():
        while True:
            event = await queue.get()
            if event is None:
                return
            yield event
            queue.task_done()

    provider._host = SimpleNamespace(send=AsyncMock(), shutdown=AsyncMock(), interrupt=AsyncMock())
    provider._events = events().__aiter__()
    provider._event_task = asyncio.create_task(anext(provider._events))
    provider._tool_task = asyncio.create_task(provider._requests.get())
    provider._history_digest = provider._history_fingerprint([])
    provider._request_stage = "response"
    return provider, queue


def error_notification():
    return NativeEvent(type="run.unknown", payload={
        "reason": "sdk_error_reported", "requiresReconciliation": True})


@pytest.mark.parametrize("executor", ["codebuddy", "claude"])
@pytest.mark.parametrize("failed", [False, True])
async def test_work_uses_matching_sdk_result_after_error_notification(tmp_path, executor, failed):
    provider, queue = event_provider(tmp_path, executor=executor)
    projector = SDKEventProjector("native-test", executor=provider.executor)
    projector.begin("sdk:first")
    messages = [
        {"type": "error", "error": "PRIVATE_VENDOR_DETAIL", "session_id": "native-test"},
        {"type": "result", "session_id": "native-test", "subtype": "success", "is_error": failed,
         "result": "OK", "usage": {"input_tokens": 10, "output_tokens": 2}},
    ]
    if failed:
        messages[1]["subtype"] = "error_during_execution"
        messages[1]["errors"] = ["PRIVATE_VENDOR_DETAIL"]
    for message in messages:
        for event in projector.consume(message):
            queue.put_nowait(event)
    host = provider._host
    try:
        response = await provider.chat_stream_with_retry([])
        assert response.finish_reason == ("error" if failed else "stop")
        assert response.error_code == ("native_execution_failed" if failed else None)
        if not failed:
            assert response.content == "OK"
        assert response.usage["total_tokens"] == 12
        assert not response.tool_calls and not response.error_should_retry
        assert "PRIVATE_VENDOR_DETAIL" not in response.content
        assert provider._done
        host.send.assert_not_called()
    finally:
        await provider.aclose()


@pytest.mark.parametrize("repeated", [False, True])
async def test_work_terminal_wait_does_not_dispatch_tools_or_extend_on_repeated_errors(tmp_path, repeated):
    provider, queue = event_provider(tmp_path)
    queue.put_nowait(error_notification())
    task = asyncio.create_task(provider.chat_stream_with_retry([]))
    await queue.join()
    provider._requests.put_nowait(ToolCallRequest("queued", "write_file", {"path": "never-written"}))

    async def repeated_notifications():
        while True:
            queue.put_nowait(error_notification())
            await asyncio.sleep(0.005)

    notifications = asyncio.create_task(repeated_notifications()) if repeated else None
    host = provider._host
    try:
        response = await asyncio.wait_for(task, 1)
        assert response.error_code == "native_turn_incomplete" and not response.error_should_retry
        assert not response.tool_calls and not provider._done
        again = await asyncio.wait_for(provider.chat_stream([]), 1)
        assert again.error_code == "native_turn_incomplete" and not again.tool_calls
        host.send.assert_not_called()
    finally:
        if notifications:
            notifications.cancel()
            await asyncio.gather(notifications, return_exceptions=True)
        await provider.aclose()


@pytest.mark.parametrize("reason,code", [
    ("sdk_event_stream_failed", "native_policy_violation"),
    ("sdk_stream_ended_without_result", "native_turn_incomplete"),
    ("event_buffer_exhausted", "native_turn_incomplete"),
])
async def test_work_stream_loss_ends_immediately_with_safe_diagnostics(tmp_path, reason, code):
    provider, queue = event_provider(tmp_path, timeout=60)
    queue.put_nowait(NativeEvent(type="run.unknown", native_turn_id="sdk:first", payload={
        "reason": reason, "errorCode": code, "exceptionType": "RpcError",
        "errorLocation": "sdk_events.py:1:consume", "message": "PRIVATE_VENDOR_DETAIL",
        "rejectedTool": "Write", "toolEventStage": "assistant"}))
    diagnostics = []
    sink = logger.add(lambda message: diagnostics.append(str(message)), level="WARNING")
    try:
        response = await asyncio.wait_for(provider.chat_stream([]), 1)
        assert response.error_code == code and not response.error_should_retry
        diagnostic = "".join(diagnostics)
        assert reason in diagnostic and "sdk:first" in diagnostic
        assert "sdk_events.py:1:consume" in diagnostic and "PRIVATE_VENDOR_DETAIL" not in diagnostic
        assert "rejected_tool=Write" in diagnostic and "tool_stage=assistant" in diagnostic
    finally:
        logger.remove(sink)
        await provider.aclose()


async def test_work_cancellation_and_eof_do_not_confirm_sdk_result(tmp_path):
    provider, queue = event_provider(tmp_path, timeout=60)
    queue.put_nowait(error_notification())
    task = asyncio.create_task(provider.chat_stream([]))
    try:
        await queue.join()
        provider._requests.put_nowait(ToolCallRequest("queued", "write_file", {"path": "never-written"}))
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not provider._done
        resumed = asyncio.create_task(provider.chat_stream([]))
        try:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(resumed), 0.02)
        finally:
            resumed.cancel()
            await asyncio.gather(resumed, return_exceptions=True)
        queue.put_nowait(None)
        response = await provider.chat_stream([])
        assert response.error_code == "native_turn_incomplete" and not response.error_should_retry
    finally:
        await provider.aclose()


async def test_work_does_not_retry_overload_after_unconfirmed_sdk_notification(tmp_path):
    provider, queue = event_provider(tmp_path)
    queue.put_nowait(error_notification())
    queue.put_nowait(NativeEvent(type="run.failed", payload={"errorCode": "server_overloaded"}))
    try:
        response = await provider.chat_stream([])
        assert response.error_code == "server_overloaded" and response.error_should_retry is False
        provider._host.send.assert_not_called()
    finally:
        await provider.aclose()


async def test_work_reconciles_result_through_sdk_worker_and_session_queue(tmp_path):
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    from mona.development.contracts import Binding
    from mona.development.executors.sdk import SDKExecutor, _SDKSession

    provider, _ = event_provider(tmp_path)
    provider._event_task.cancel()
    await asyncio.gather(provider._event_task, return_exceptions=True)
    host = SDKExecutor(SimpleNamespace(executor=provider.executor))
    host.send = AsyncMock()
    binding = Binding(session_id="work-test", executor=provider.executor,
                      native_session_id="native-test", working_directory=str(tmp_path))
    runtime = _SDKSession(binding, SimpleNamespace(work_prompt="diagnostic"),
                          status="running", turn_id="sdk:first")
    host._sessions[binding.id] = runtime
    provider._host, provider._binding = host, binding
    provider._events = host.events(binding).__aiter__()
    provider._event_task = asyncio.create_task(anext(provider._events))
    worker = Worker()
    worker.active = runtime.turn_id
    worker.projector = SDKEventProjector(binding.native_session_id, work_tool=True,
                                         executor=provider.executor)
    worker.projector.begin(runtime.turn_id)

    async def messages():
        yield sdk.ErrorMessage(error="PRIVATE_VENDOR_DETAIL", session_id=binding.native_session_id)
        assert runtime.status == "unknown" and not worker._current_turn(runtime.turn_id)
        yield sdk.ResultMessage(subtype="success", duration_ms=1, duration_api_ms=1, is_error=False,
                                num_turns=1, session_id=binding.native_session_id, result="OK")

    worker.client = SimpleNamespace(receive_messages=messages)
    worker.write = lambda value: host._deliver(runtime, NativeEvent.model_validate(value["params"]))
    try:
        await worker.receive()
        response = await provider.chat_stream_with_retry([])
        assert response.content == "OK" and response.finish_reason == "stop"
        assert runtime.status == "idle" and provider._done
        host.send.assert_not_called()
    finally:
        await provider.aclose()


@pytest.mark.parametrize("policy_violation", [False, True])
async def test_worker_stream_failure_preserves_only_safe_diagnostics(policy_violation):
    worker = Worker()
    worker.active = "sdk:first"
    worker.projector = SDKEventProjector("native-test", work_tool=True)
    worker.projector.begin(worker.active)

    async def messages():
        if not policy_violation:
            raise ValueError("PRIVATE_VENDOR_DETAIL")
        yield {"type": "assistant", "content": [
            {"type": "tool_use", "id": "unauthorized", "name": "mcp__foreign__tool", "input": {}}]}

    worker.client = SimpleNamespace(receive_messages=messages)
    output = []
    worker.write = output.append
    await worker.receive()
    assert worker.closing.is_set()
    event = output[-1]["params"]
    assert event["type"] == "run.unknown" and event["native_turn_id"] == "sdk:first"
    payload = event["payload"]
    assert payload["reason"] == "sdk_event_stream_failed"
    assert payload["exceptionType"] == ("RpcError" if policy_violation else "ValueError")
    assert payload.get("errorCode") == ("native_policy_violation" if policy_violation else None)
    assert payload["errorLocation"].endswith(":consume" if policy_violation else ":messages")
    assert "PRIVATE_VENDOR_DETAIL" not in str(output)
    if policy_violation:
        assert payload["rejectedTool"] == "mcp__foreign__tool"
        assert payload["toolEventStage"] == "assistant"
