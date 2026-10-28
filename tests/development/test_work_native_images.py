"""Native tool results preserve image types across engine boundaries."""

import asyncio
import copy
import json

import pytest
from test_work_native import PEER, use_peer

from mona.config.schema import Config
from mona.providers.native_work_provider import NativeWorkProvider


@pytest.mark.parametrize("executor", ["codex", "codebuddy", "claude"])
@pytest.mark.asyncio
async def test_native_host_tool_preserves_text_and_image_blocks(tmp_path, executor):
    config = Config()
    config.agents.defaults.executor = executor
    provider = NativeWorkProvider(config, tmp_path)
    image_data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
    image = {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_data}"}}
    task = asyncio.create_task(provider._host_tool(None, "fixture-turn", {
        "tool": "inspect_fixture", "arguments": {},
    }))
    try:
        async with asyncio.timeout(2):
            request = await provider._requests.get()
            provider._pending[request.id].set_result([
                {"type": "text", "text": "First observation"}, image,
                {"type": "text", "text": "Second observation"}, image,
            ])
            result = await task
        expected_image = {"type": "image", "mimeType": "image/png", "data": image_data}
        assert result == {"content": [
            {"type": "text", "text": "First observation"}, expected_image,
            {"type": "text", "text": "Second observation"}, expected_image,
        ], "isError": False}
        assert all(image_data not in item.get("text", "") for item in result["content"])
        assert not provider._pending
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_codex_tool_images_keep_their_types_across_the_host_bridge(tmp_path, monkeypatch):
    config, root, _, _ = use_peer(tmp_path, monkeypatch)
    peer = tmp_path / "native-peer.py"
    peer.write_text(
        PEER.replace(
            "reply = request.get('result', {})",
            "reply = request.get('result', {})\n"
            "        Path('host-tool-result.json').write_text(json.dumps(reply), encoding='utf-8')",
        ),
        encoding="utf-8",
    )
    image_data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
    image = {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_data}"}}
    result = [{"type": "text", "text": "First observation"}, image,
              {"type": "text", "text": "Second observation"}, image]
    messages = [{"role": "system", "content": "Inspect the tool observations."},
                {"role": "user", "content": "Inspect once"}]
    provider = NativeWorkProvider(config, root)
    try:
        async with asyncio.timeout(10):
            response = await provider.chat(messages, model="native-fixture")
            assert len(response.tool_calls) == 1
            call = response.tool_calls[0]
            messages.extend([
                {"role": "assistant", "content": response.content,
                 "tool_calls": [call.to_openai_tool_call()]},
                {"role": "tool", "name": call.name, "tool_call_id": call.id, "content": result},
            ])
            completed = await provider.chat(messages, model="native-fixture")
        assert completed.finish_reason == "stop"
        sent = json.loads((root / "host-tool-result.json").read_text(encoding="utf-8"))
        assert sent == {"success": True, "contentItems": [
            {"type": "inputText", "text": "First observation"},
            {"type": "inputImage", "imageUrl": image["image_url"]["url"]},
            {"type": "inputText", "text": "Second observation"},
            {"type": "inputImage", "imageUrl": image["image_url"]["url"]},
        ]}
        assert all(image_data not in item.get("text", "") for item in sent["contentItems"])
    finally:
        await provider.aclose()


@pytest.mark.parametrize("active,is_error", [(True, False), (True, True), (False, False)])
@pytest.mark.asyncio
async def test_claude_sdk_preserves_tool_images_and_error_status(tmp_path, monkeypatch, active, is_error):
    pytest.importorskip("claude_agent_sdk")
    from mcp.shared.memory import create_connected_server_and_client_session
    from test_native_host_tools import _work_start

    from mona.development.contracts import ExecutorId
    from mona.development.executors.host_tools import WORK_SERVER, WORK_TOOL
    from mona.development.executors.sdk_worker import Worker

    start, _, _, _ = _work_start(tmp_path, monkeypatch, ExecutorId.CLAUDE, "Inspect the image.")
    worker = Worker()
    worker.start = start
    image_data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
    content = [
        {"type": "text", "text": "First observation"},
        {"type": "image", "mimeType": "image/png", "data": image_data},
        {"type": "text", "text": "Second observation"},
    ]

    async def host_reply(method, params):
        assert active
        assert method == "host/collaboration"
        assert params["arguments"] == {"tool": "inspect_fixture", "arguments": {}}
        return {"content": content, "isError": is_error}

    monkeypatch.setattr(worker, "ask", host_reply)
    try:
        worker.build_options(start)
        if active:
            worker.active = "fixture-turn"
            worker.projector.begin(worker.active)
        server = worker.options.mcp_servers[WORK_SERVER]["instance"]
        async with asyncio.timeout(5):
            async with create_connected_server_and_client_session(server) as client:
                result = await client.call_tool(WORK_TOOL, {"tool": "inspect_fixture", "arguments": {}})
        assert result.isError is (is_error or not active)
        if active:
            assert [block.type for block in result.content] == ["text", "image", "text"]
            assert result.content[1].mimeType == "image/png"
            assert result.content[1].data == image_data
            assert all(image_data not in getattr(block, "text", "") for block in result.content)
        else:
            assert "host_tool_unavailable" in result.content[0].text
    finally:
        worker._cleanup_work_prompt_file()


@pytest.mark.parametrize("active,is_error", [(True, False), (True, True), (False, False)])
@pytest.mark.asyncio
async def test_codebuddy_sdk_control_reply_keeps_mcp_image_blocks(tmp_path, monkeypatch, active, is_error):
    pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk.transport.subprocess import SubprocessTransport
    from test_native_host_tools import _work_start

    from mona.development.contracts import ExecutorId
    from mona.development.executors.host_tools import WORK_SERVER, WORK_TOOL
    from mona.development.executors.sdk_worker import Worker

    start, _, _, _ = _work_start(tmp_path, monkeypatch, ExecutorId.CODEBUDDY, "Inspect the image.")
    monkeypatch.setenv("CODEBUDDY_CODE_ENTRYPOINT", "sdk-py-client")
    worker = Worker()
    worker.start = start
    image_data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
    content = [
        {"type": "text", "text": "First observation"},
        {"type": "image", "mimeType": "image/png", "data": image_data},
        {"type": "text", "text": "Second observation"},
    ]

    async def host_reply(method, params):
        assert active and method == "host/collaboration"
        assert params["arguments"] == {"tool": "inspect_fixture", "arguments": {}}
        return {"content": content, "isError": is_error}

    replies = []

    async def capture_reply(value):
        replies.append(json.loads(value))

    monkeypatch.setattr(worker, "ask", host_reply)
    try:
        worker.build_options(start)
        if active:
            worker.active = "fixture-turn"
            worker.projector.begin(worker.active)
        transport = object.__new__(SubprocessTransport)
        transport._sdk_mcp_servers = {WORK_SERVER: worker.options.mcp_servers[WORK_SERVER]["server"]}
        transport.write = capture_reply
        await transport.handle_mcp_message_request("fixture-control", {
            "server_name": WORK_SERVER,
            "message": {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {
                "name": WORK_TOOL, "arguments": {"tool": "inspect_fixture", "arguments": {}},
            }},
        })

        assert len(replies) == 1
        envelope = replies[0]
        assert envelope["type"] == "control_response"
        assert envelope["response"]["request_id"] == "fixture-control"
        reply = envelope["response"]["response"]["mcp_response"]
        assert reply["id"] == 7
        result = reply["result"]
        assert result["isError"] is (is_error or not active)
        if active:
            assert result["content"] == content
            assert all(image_data not in block.get("text", "") for block in result["content"])
        else:
            assert "host_tool_unavailable" in result["content"][0]["text"]
    finally:
        worker._cleanup_work_prompt_file()


@pytest.mark.asyncio
async def test_codebuddy_sdk_user_input_transmits_history_images_without_text_encoding(tmp_path, monkeypatch):
    sdk = pytest.importorskip("codebuddy_agent_sdk")
    from codebuddy_agent_sdk.transport.base import Transport
    from test_native_host_tools import _work_start

    from mona.development.contracts import ExecutorId
    from mona.development.executors.sdk_worker import Worker
    from mona.providers.native_work_provider import native_history_input

    class MemoryTransport(Transport):
        def __init__(self):
            self.incoming = asyncio.Queue()
            self.messages = []
            self._closed = False

        async def connect(self):
            pass

        async def write(self, data):
            value = json.loads(data)
            if value.get("type") == "control_request":
                await self.incoming.put({"type": "control_response", "response": {
                    "subtype": "success", "request_id": value["request_id"], "response": {},
                }})
            else:
                self.messages.append(value)

        async def read_messages(self):
            while True:
                value = await self.incoming.get()
                if value is None:
                    return
                yield value

        async def close(self):
            self._closed = True
            await self.incoming.put(None)

    transport = MemoryTransport()
    client_class = sdk.CodeBuddySDKClient
    monkeypatch.setattr(sdk, "CodeBuddySDKClient", lambda options: client_class(options, transport=transport))
    monkeypatch.setenv("CODEBUDDY_CODE_ENTRYPOINT", "sdk-py-client")
    start, _, _, _ = _work_start(tmp_path, monkeypatch, ExecutorId.CODEBUDDY, "Inspect the image.")
    worker = Worker()
    worker.start = start
    client, _ = worker.build_options(start)
    worker.client = client
    worker.owner = asyncio.create_task(asyncio.Event().wait())
    image_data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC"
    image = {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{image_data}"}}
    history = [
        {"role": "user", "content": "Continue from the existing observations."},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "already-completed", "type": "function",
            "function": {"name": "office", "arguments": '{"action":"inspect"}'}}]},
        {"role": "tool", "tool_call_id": "already-completed", "name": "office", "content": [
            {"type": "text", "text": "First observation"}, image,
            {"type": "text", "text": "Second observation"}, image,
        ]},
    ]
    original = copy.deepcopy(history)
    try:
        async with asyncio.timeout(5):
            await client.connect()
            receipt = await worker.handle("send", {"inputId": "images", "text": native_history_input(history)})
        assert receipt["inputId"] == "images"
        assert len(transport.messages) == 1
        sent = transport.messages[0]
        assert sent["type"] == "user" and sent["session_id"] == start["nativeSessionId"]
        content = sent["message"]["content"]
        pictures = [block for block in content if block["type"] == "image"]
        assert len(pictures) == 2
        assert all(block["source"] == {"type": "base64", "media_type": "image/png", "data": image_data}
                   for block in pictures)
        assert all(image_data not in block.get("text", "") for block in content)
        assert history == original
    finally:
        await client.disconnect()
        worker.owner.cancel()
        await asyncio.gather(worker.owner, return_exceptions=True)
        worker._cleanup_work_prompt_file()
