"""Real local HTTP contracts for configured models used by native engines."""
import asyncio
import json
import os
import secrets
from pathlib import Path

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from mona.config.schema import Config, ProviderConfig, _resolve_tool_config_refs
from mona.development.contracts import DevelopmentSession, ExecutorId, Project
from mona.development.model_bridge import NativeModelBridge
from mona.development.model_protocol import (
    ModelOutput,
    ModelProtocolError,
    messages_input,
    responses_input,
)
from mona.development.store import NotFoundError
from mona.providers.base import LLMResponse, ToolCallRequest
from mona.webui import settings_api


def configured(base, monkeypatch):
    _resolve_tool_config_refs()
    config = Config()
    config.providers.cindy["custom-fixture"] = ProviderConfig(display_name="Fixture", api_base=base,
        discovered_models=[{"id": "fixture-model", "type": "chat"}], enabled_models=["fixture-model"])
    monkeypatch.setattr(settings_api, "_managed_model_catalog", lambda: {"available": False, "models": []})
    return config


def decode_events(raw):
    return [json.loads(line[6:]) for line in raw.splitlines() if line.startswith("data: ") and line[6:] != "[DONE]"]


async def upstream_handler(request):
    body = await request.json()
    request.app[CALLS].append(body)
    request.app[AUTH_HEADERS].append(request.headers.get("Authorization"))
    stream = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
    await stream.prepare(request)
    if any(message.get("role") == "tool" for message in body["messages"]):
        deltas = [({"content": "bridge finished"}, None), ({}, "stop")]
    else:
        tool = body["tools"][0]["function"]["name"]
        deltas = [({"tool_calls": [{"index": 0, "id": "call_fixture", "type": "function",
                    "function": {"name": tool, "arguments": '{"value":"42"}'}}]}, None), ({}, "tool_calls")]
    for delta, finish in deltas:
        data = {"id": "chatcmpl_fixture", "object": "chat.completion.chunk", "created": 1, "model": body["model"],
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        await stream.write(f"data: {json.dumps(data)}\n\n".encode())
    await stream.write(b"data: [DONE]\n\n")
    return stream


CALLS = web.AppKey("calls", list)
AUTH_HEADERS = web.AppKey("auth_headers", list)


@pytest.mark.asyncio
@pytest.mark.parametrize("engine,protocol", [(ExecutorId.CODEX, "responses"), (ExecutorId.CLAUDE, "messages")])
async def test_engine_http_tool_roundtrip_keeps_source_and_hides_credentials(tmp_path, monkeypatch, engine, protocol):
    app = web.Application()
    app[CALLS] = []
    app[AUTH_HEADERS] = []
    app.router.add_post("/v1/chat/completions", upstream_handler)
    upstream = TestServer(app)
    await upstream.start_server()
    config = configured(str(upstream.make_url("/v1")), monkeypatch)
    supplier_key = secrets.token_urlsafe(16) if engine == ExecutorId.CLAUDE else None
    config.providers.cindy["custom-fixture"].api_key = supplier_key
    session = DevelopmentSession(project_id="project_fixture", executor=engine,
        model="fixture-model", model_provider="custom-fixture")
    bridge = NativeModelBridge(lambda: config, lambda _id: session)
    base, token = await bridge.bind(session)
    headers = {"Authorization": f"Bearer {token}"}
    tool = {"name": "report_value", "description": "report", "parameters": {"type": "object", "properties": {"value": {"type": "string"}}}, "type": "function"}
    if protocol == "responses":
        body = {"model": "fixture-model", "stream": True, "instructions": "system fixture", "input": "hello", "tools": [tool]}
    else:
        body = {"model": "engine-helper-alias", "stream": True, "system": "system fixture", "messages": [{"role": "user", "content": "hello"}],
                "tools": [{"name": tool["name"], "description": "report", "input_schema": tool["parameters"]}]}
    try:
        async with httpx.AsyncClient() as client:
            assert (await client.post(f"{base}/v1/{protocol}", json=body)).status_code == 401
            assert not app[CALLS]
            response = await client.post(f"{base}/v1/{protocol}", json=body, headers=headers)
            assert response.status_code == 200
            events = decode_events(response.text)
            if protocol == "responses":
                call = events[-1]["response"]["output"][0]
                assert call["type"] == "function_call" and call["name"] == "report_value"
                body["input"] = [{"role": "user", "content": "hello"}, call,
                    {"type": "function_call_output", "call_id": call["call_id"], "output": "tool result 42"}]
            else:
                call = next(event["content_block"] for event in events if event["type"] == "content_block_start")
                call["input"] = {"value": "42"}
                body["messages"] += [{"role": "assistant", "content": [call]},
                    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": call["id"], "content": "tool result 42"}]}]
            config.providers.cindy["custom-fixture"].api_base = "http://169.254.169.254/v1"
            response = await client.post(f"{base}/v1/{protocol}", json=body, headers=headers)
            assert "bridge finished" in response.text
            assert app[CALLS][-1]["model"] == "fixture-model"
            history = app[CALLS][-1]["messages"]
            call_id = next(message["tool_calls"][0]["id"] for message in history if message.get("tool_calls"))
            assert any(message.get("tool_call_id") == call_id and message["content"] == "tool result 42" for message in history)
            assert token not in str(app[CALLS])
            assert app[AUTH_HEADERS] == [f"Bearer {supplier_key}" if supplier_key else None] * 2
            session.model_provider = "another-source"
            assert (await client.post(f"{base}/v1/{protocol}", json=body, headers=headers)).status_code == 403
            assert len(app[CALLS]) == 2
    finally:
        await bridge.close()
        await upstream.close()


@pytest.mark.asyncio
async def test_custom_and_namespaced_tools_preserve_native_identity():
    request = responses_input({"input": [{"role": "user", "content": [{"type": "input_image", "image_url": "data:image/png;base64,fixture"}]}],
        "tools": [{"type": "namespace", "name": "functions", "tools": [{"type": "custom", "name": "apply_patch", "description": "patch"}]}]})
    alias = request.tools[0]["function"]["name"]
    events = []
    async def emit(kind, body):
        events.append((kind, body))
    output = ModelOutput("responses", "fixture", request.tool_names, emit)
    await output.start()
    result = await output.finish(LLMResponse(content=None, finish_reason="tool_calls",
        tool_calls=[ToolCallRequest("call_1", alias, {"input": "patch content"})]))
    call = result["output"][0]
    assert (call["type"], call["namespace"], call["name"], call["input"]) == ("custom_tool_call", "functions", "apply_patch", "patch content")
    replay = responses_input({"input": [call, {"type": "custom_tool_call_output", "call_id": "call_1", "output": "applied"}],
                              "tools": [{"type": "namespace", "name": "functions", "tools": [{"type": "custom", "name": "apply_patch"}]}]})
    assert replay.messages[0]["tool_calls"][0]["function"]["name"] == alias
    assert replay.messages[1]["tool_call_id"] == "call_1"
    assert request.messages[0]["content"][0]["image_url"]["url"].startswith("data:image/png")


@pytest.mark.asyncio
async def test_signed_thinking_survives_native_history_roundtrip():
    events = []
    async def emit(kind, body):
        events.append(body)
    block = {"type": "thinking", "thinking": "fixture reasoning", "signature": "fixture-signature"}
    output = ModelOutput("responses", "fixture", {}, emit)
    await output.start()
    result = await output.finish(LLMResponse(content="fixture answer", thinking_blocks=[block]))
    parsed = responses_input({"input": result["output"]})
    assert parsed.messages[0]["thinking_blocks"] == [block]
    assert parsed.messages[0]["reasoning_content"] == "fixture reasoning"


def test_unknown_history_is_not_silently_dropped():
    with pytest.raises(ModelProtocolError):
        responses_input({"input": [{"type": "item_reference", "id": "missing-history"}]})
    parsed = messages_input({"messages": [{"role": "user", "content": [{"type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": "fixture"}}]}]})
    assert parsed.messages[0]["content"][0]["image_url"]["url"] == "data:image/png;base64,fixture"


@pytest.mark.asyncio
async def test_model_endpoint_blocks_metadata_addresses(monkeypatch):
    config = configured("http://169.254.169.254/v1", monkeypatch)
    session = DevelopmentSession(project_id="project_fixture", executor=ExecutorId.CODEX,
        model="fixture-model", model_provider="custom-fixture")
    bridge = NativeModelBridge(lambda: config, lambda _id: session)
    base, token = await bridge.bind(session)
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(base + "/v1/responses", headers={"Authorization": f"Bearer {token}"},
                                         json={"input": "hello", "model": "fixture-model"})
        assert response.status_code == 502
        assert "169.254" not in response.text and token not in response.text
    finally:
        await bridge.close()


@pytest.mark.asyncio
async def test_model_endpoint_does_not_forward_credentials_on_redirect(monkeypatch):
    forwarded = []
    async def redirect(_request):
        raise web.HTTPTemporaryRedirect("/unexpected-target")
    async def unexpected(request):
        forwarded.append(request.headers.get("Authorization"))
        return web.json_response({})
    app = web.Application()
    app.router.add_post("/v1/chat/completions", redirect)
    app.router.add_post("/unexpected-target", unexpected)
    upstream = TestServer(app)
    await upstream.start_server()
    config = configured(str(upstream.make_url("/v1")), monkeypatch)
    config.providers.cindy["custom-fixture"].api_key = secrets.token_urlsafe(16)
    session = DevelopmentSession(project_id="project_fixture", executor=ExecutorId.CODEX,
        model="fixture-model", model_provider="custom-fixture")
    bridge = NativeModelBridge(lambda: config, lambda _id: session)
    base, token = await bridge.bind(session)
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(base + "/v1/responses", headers={"Authorization": f"Bearer {token}"}, json={"input": "hello"})
        assert response.status_code == 502 and not forwarded
    finally:
        await bridge.close()
        await upstream.close()


@pytest.mark.asyncio
async def test_deletion_during_bridge_start_does_not_retain_model_access(monkeypatch):
    config = configured("http://127.0.0.1:9999/v1", monkeypatch)
    session = DevelopmentSession(project_id="project_fixture", executor=ExecutorId.CODEX,
        model="fixture-model", model_provider="custom-fixture")
    deleted = False
    def read_session(_id):
        if deleted:
            raise NotFoundError()
        return session
    started, release = asyncio.Event(), asyncio.Event()
    original = web.TCPSite.start
    async def pause_start(site):
        await original(site)
        started.set()
        await release.wait()
    monkeypatch.setattr(web.TCPSite, "start", pause_start)
    bridge = NativeModelBridge(lambda: config, read_session)
    task = asyncio.create_task(bridge.bind(session))
    try:
        await asyncio.wait_for(started.wait(), 3)
        deleted = True
        bridge.revoke({session.id})
        release.set()
        with pytest.raises(NotFoundError):
            await task
        assert not bridge._routes and not bridge._tokens
    finally:
        release.set()
        await bridge.close()


@pytest.mark.asyncio
@pytest.mark.skipif(not os.environ.get("MONA_TEST_CODEX_EXECUTABLE"), reason="explicit local Codex binary required")
async def test_real_codex_uses_configured_model_and_executes_tool(tmp_path, monkeypatch):
    from mona.development.context import load_project_context
    from mona.development.executors.base import SessionStart
    from mona.development.executors.codex import CodexExecutor
    from mona.development.executors.codex_policy import prepare_codex_profile

    calls = []
    async def model(request):
        body = await request.json()
        calls.append(body)
        if any(message.get("role") == "tool" for message in body["messages"]):
            delta, reason = {"content": "native bridge verified"}, "stop"
        else:
            tool = next(tool["function"] for tool in body["tools"]
                        if "command" in tool["function"].get("parameters", {}).get("properties", {})
                        or "cmd" in tool["function"].get("parameters", {}).get("properties", {}))
            key = "command" if "command" in tool["parameters"]["properties"] else "cmd"
            delta, reason = {"reasoning_content": "fixture planning", "tool_calls": [{"index": 0, "id": "call_native", "type": "function",
                "function": {"name": tool["name"], "arguments": json.dumps({key: "echo model-bridge-proof"})}}]}, "tool_calls"
        stream = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await stream.prepare(request)
        chunk = {"id": "chatcmpl_native", "object": "chat.completion.chunk", "created": 1, "model": "fixture-model",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
        await stream.write(f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n".encode())
        return stream

    app = web.Application()
    app.router.add_post("/v1/chat/completions", model)
    upstream = TestServer(app)
    await upstream.start_server()
    config = configured(str(upstream.make_url("/v1")), monkeypatch)
    root = tmp_path / "project"
    root.mkdir()
    project = Project(root_path=str(root), display_name="Model bridge")
    session = DevelopmentSession(project_id=project.id, executor=ExecutorId.CODEX,
        model="fixture-model", model_provider="custom-fixture")
    bridge = NativeModelBridge(lambda: config, lambda _id: session)
    base, token = await bridge.bind(session)
    profile = prepare_codex_profile(Path(os.environ["MONA_TEST_CODEX_EXECUTABLE"]), tmp_path / "native", root,
                                    model_endpoint=base, model_token=token)
    assert token not in " ".join(profile.command) and token not in repr(profile)
    async def approve(*_args):
        return "accept"
    host = CodexExecutor(profile, approval_handler=approve)
    try:
        binding = await host.create_session(SessionStart(session, load_project_context(project, config.development), model=session.model))
        receipt = await host.send(binding, "request_fixture", "Print model-bridge-proof and finish.")
        assert receipt.outcome == "accepted"
        events = []
        async with asyncio.timeout(90):
            async for event in host.events(binding):
                events.append(event)
                if event.type in {"run.completed", "run.failed", "run.unknown"}:
                    break
        assert len(calls) >= 2, [event.model_dump() for event in events]
        assert calls[-1]["model"] == "fixture-model"
        assert any(message.get("reasoning_content") == "fixture planning" for message in calls[-1]["messages"])
        assert any("model-bridge-proof" in str(message.get("content")) for message in calls[-1]["messages"] if message.get("role") == "tool")
        assert any(event.type == "run.completed" for event in events)
        count = len(calls)
        await host.shutdown()
        await bridge.close()
        bridge = NativeModelBridge(lambda: config, lambda _id: session)
        base, token = await bridge.bind(session)
        profile = prepare_codex_profile(Path(os.environ["MONA_TEST_CODEX_EXECUTABLE"]), tmp_path / "native", root,
                                        model_endpoint=base, model_token=token)
        host = CodexExecutor(profile, approval_handler=approve)
        resumed = await host.attach_session(SessionStart(session, load_project_context(project, config.development), model=session.model), binding)
        assert resumed.native_session_id == binding.native_session_id
        assert (await host.send(resumed, "request_after_restart", "Continue using the same configured model.")).outcome == "accepted"
        async with asyncio.timeout(90):
            async for event in host.events(resumed):
                if event.type in {"run.completed", "run.failed", "run.unknown"}:
                    assert event.type == "run.completed"
                    break
        assert len(calls) > count and calls[-1]["model"] == "fixture-model"
    finally:
        await host.shutdown()
        await bridge.close()
        await upstream.close()
