"""Installed SDK control protocol and Mona hooks; no native account or model request."""
import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from test_native_host_tools import _work_start

from mona.development.contracts import ExecutorId
from mona.development.executors.sdk_worker import Worker


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_hook", ["PostToolUse", "PostToolUseFailure"])
async def test_installed_sdk_carries_independent_native_receipts(tmp_path, monkeypatch, terminal_hook):
    pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk.transport.base import Transport

    class MemoryTransport(Transport):
        def __init__(self):
            self.incoming = asyncio.Queue()
            self.responses = asyncio.Queue()
            self.initialization = None
            self._closed = False

        async def connect(self):
            pass

        async def write(self, data):
            message = json.loads(data)
            if message["type"] == "control_request":
                assert message["request"]["subtype"] == "initialize"
                self.initialization = message["request"]
                await self.incoming.put({"type": "control_response", "response": {
                    "subtype": "success", "request_id": message["request_id"], "response": {}}})
            elif message["type"] == "control_response":
                await self.responses.put(message["response"])
            else:
                raise AssertionError("Test must not send a model/user request")

        async def read_messages(self):
            while (item := await self.incoming.get()) is not None:
                yield item

        async def close(self):
            self._closed = True
            await self.incoming.put(None)

    start, _, _, _ = _work_start(tmp_path, monkeypatch, ExecutorId.CODEBUDDY, "Keep the same task.")
    start["workNativeTools"] = ["Write"]
    transport = MemoryTransport()
    monkeypatch.setattr("mona.development.executors.codebuddy_transport.desktop_transport",
                        lambda executable, *, options: transport)
    worker = Worker()
    worker.start = start
    worker.client, _ = worker.build_options(start)
    worker.ask = AsyncMock(return_value={"allow": True})
    emitted = []
    worker.write = emitted.append

    async def hook(event, call_id="write-once", session_id="test-session"):
        callback = transport.initialization["hooks"][event][0]["hookCallbackIds"][0]
        await transport.incoming.put({"type": "control_request", "request_id": event, "request": {
            "subtype": "hook_callback", "callback_id": callback, "tool_use_id": call_id,
            "input": {"hook_event_name": event, "tool_use_id": call_id, "session_id": session_id,
                      "tool_name": "Write", "tool_input": {"file_path": "report.txt", "content": "synthetic"},
                      "tool_response": {"body": "PRIVATE_TEST_RESULT"}}}})
        response = await asyncio.wait_for(transport.responses.get(), 2)
        assert response["request_id"] == event and response["subtype"] == "success"
        return response["response"]

    try:
        await worker.connect_client(start)
        assert set(transport.initialization["hooks"]) == {"PreToolUse", "PostToolUse", "PostToolUseFailure"}
        worker.active = "sdk:only-turn"
        worker.projector.begin(worker.active)
        pre = await hook("PreToolUse")
        assert pre["hookSpecificOutput"]["permissionDecision"] == "allow"
        post = await hook(terminal_hook)
        assert post == {"continue": True}
        assert len(emitted) == 1 and emitted[0]["params"]["native_turn_id"] == worker.active
        assert emitted[0]["params"]["payload"] == {
            "itemId": "write-once", "isError": terminal_hook == "PostToolUseFailure", "receiptSource": "native_hook"}
        await hook(terminal_hook)
        await hook(terminal_hook, call_id="other-call")
        await hook(terminal_hook, session_id="other-session")
        assert len(emitted) == 1 and "PRIVATE_TEST_RESULT" not in str(emitted)
        worker.ask.assert_awaited_once()
    finally:
        await worker.client.disconnect()
        worker._cleanup_work_prompt_file()
