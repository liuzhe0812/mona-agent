"""Real HTTP model contracts, with a deterministic local upstream model fixture."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from mona.api.stock_model_bridge import StockModelBridge, register_routes
from mona.config.schema import Config, ModelPresetConfig, ProviderConfig, _resolve_tool_config_refs

TOOLS = [{"type": "function", "function": {"name": name, "description": "contract fixture",
          "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}}}}}
         for name in ("lookup", "evidence")]


def configured(base: str) -> Config:
    _resolve_tool_config_refs()
    config = Config()
    config.providers.openai = ProviderConfig(api_key="synthetic-upstream-key", api_base=base)
    config.model_presets["stock-test"] = ModelPresetConfig(model="fixture-model", provider="openai", max_tokens=100)
    config.stock_vibe.model_preset = "stock-test"
    return config


def upstream(calls: list[dict]) -> web.Application:
    async def complete(request):
        body = await request.json()
        calls.append(body)
        if body["messages"][-1].get("content") == "fail-contract":
            return web.json_response({"error": {"message": "synthetic private detail", "type": "invalid_request_error"}}, status=400)
        continued = any(message.get("role") == "tool" for message in body["messages"])
        tool_calls = [{"id": f"call_{index}", "type": "function", "function": {
            "name": tool["function"]["name"], "arguments": '{"symbol":"中文标的"}'}}
            for index, tool in enumerate(body.get("tools", []))]
        message = {"role": "assistant", "content": "证据已续接" if continued else None}
        if not continued:
            message["tool_calls"] = tool_calls
        usage = {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}
        if not body.get("stream"):
            return web.json_response({"id": "fixture", "object": "chat.completion", "created": 1,
                                      "model": body["model"], "choices": [{"index": 0, "message": message,
                                      "finish_reason": "stop" if continued else "tool_calls"}], "usage": usage})
        response = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await response.prepare(request)
        if continued:
            deltas = [{"content": "证据"}, {"content": "已续接"}]
        else:
            deltas = [{"tool_calls": [{"index": index, **tool, "function": {
                **tool["function"], "arguments": tool["function"]["arguments"][:10]}} for index, tool in enumerate(tool_calls)]},
                {"tool_calls": [{"index": index, "function": {"arguments": tool["function"]["arguments"][10:]}}
                                for index, tool in enumerate(tool_calls)]}]
        for delta in deltas:
            payload = {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                       "model": body["model"], "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
            await response.write(("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode())
        await response.write(("data: " + json.dumps({"id": "fixture", "object": "chat.completion.chunk",
            "created": 1, "model": body["model"], "choices": [{"index": 0, "delta": {},
            "finish_reason": "stop" if continued else "tool_calls"}], "usage": usage}) + "\n\n").encode())
        await response.write(b"data: [DONE]\n\n")
        return response

    app = web.Application()
    app.router.add_post("/v1/chat/completions", complete)
    return app


@pytest.mark.parametrize("stream", [False, True])
async def test_real_provider_wire_and_tool_result_continuation(stream: bool, monkeypatch) -> None:
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-host-token")
    calls: list[dict] = []
    async with TestServer(upstream(calls)) as origin:
        config = configured(str(origin.make_url("/v1")))
        app = web.Application()
        register_routes(app, lambda: config)
        async with TestServer(app) as gateway, httpx.AsyncClient(trust_env=False, timeout=20) as client:
            host = {"X-Mona-Token": "synthetic-host-token"}
            instance = "a" * 32
            bind_url = str(gateway.make_url("/internal/stock-vibe/models"))
            assert (await client.post(bind_url, json={"instance_id": instance})).status_code == 401
            binding = (await client.post(bind_url, headers=host, json={"instance_id": instance})).json()
            url = str(gateway.make_url(binding["base_path"] + "/chat/completions"))
            headers = {"Authorization": "Bearer " + binding["api_key"]}
            body = {"model": "fixture-model", "messages": [{"role": "user", "content": "检查证据"}],
                    "tools": TOOLS, "max_tokens": 999, "stream": stream}
            assert (await client.post(url, json=body)).status_code == 401
            config.model_presets["stock-test"].model = "changed-after-binding"
            response = await client.post(url, headers=headers, json=body)
            assert response.status_code == 200, response.text
            if stream:
                chunks = [json.loads(line[6:]) for line in response.text.splitlines()
                          if line.startswith("data: ") and line[6:] != "[DONE]"]
                collected = {}
                for chunk in chunks:
                    for tool in chunk["choices"][0]["delta"].get("tool_calls", []):
                        current = collected.setdefault(tool["index"], {"id": "", "function": {"name": "", "arguments": ""}})
                        current["id"] += tool.get("id", "")
                        for key in ("name", "arguments"):
                            current["function"][key] += tool.get("function", {}).get(key, "")
                tool_calls = [{"type": "function", **value} for value in collected.values()]
                assert chunks[-1]["usage"]["total_tokens"] == 16
            else:
                tool_calls = response.json()["choices"][0]["message"]["tool_calls"]
                assert response.json()["usage"]["total_tokens"] == 16
            assert len({tool["id"] for tool in tool_calls}) == 2
            assert [json.loads(tool["function"]["arguments"])["symbol"] for tool in tool_calls] == ["中文标的"] * 2
            body["messages"] += [{"role": "assistant", "content": None, "tool_calls": tool_calls}]
            body["messages"] += [{"role": "tool", "tool_call_id": tool["id"], "content": "固定证据"} for tool in tool_calls]
            followup = await client.post(url, headers=headers, json={**body, "stream": False})
            assert followup.json()["choices"][0]["message"]["content"] == "证据已续接"
            assert len(calls) == 2
            assert calls[0]["model"] == "fixture-model"
            assert calls[0].get("max_tokens", calls[0].get("max_completion_tokens")) == 100
            assert calls[1]["messages"][-1]["tool_call_id"] == calls[1]["messages"][-3]["tool_calls"][1]["id"]
            assert (await client.delete(bind_url + "/" + instance, headers=host)).status_code == 200
            assert (await client.post(url, headers=headers, json=body)).status_code == 404


async def test_native_vibe_adapter_calls_bridge_without_mona_loop(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[2]
    python = Path(os.environ.get("STOCK_VIBE_TEST_PYTHON", root / ".codex_tmp/vibe-venv-313/Scripts/python.exe"))
    native = Path(os.environ.get("STOCK_VIBE_NATIVE_ROOT", root / ".codex_tmp/vibe-native-9"))
    if (native / "agent").is_dir():
        native = native / "agent"
    if not python.is_file() or not native.is_dir():
        pytest.skip("prepared native runtime is required for the cross-process contract")
    calls: list[dict] = []
    async with TestServer(upstream(calls)) as origin:
        bridge = StockModelBridge.from_config(configured(str(origin.make_url("/v1"))))
        app = web.Application()
        app.router.add_post("/v1/chat/completions", bridge.complete)
        async with TestServer(app) as gateway:
            env = {key: value for key, value in os.environ.items() if key.upper() in {
                "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"}}
            env.update({"PYTHONPATH": str(native), "PYTHONUTF8": "1", "VIBE_TRADING_HOME": str(tmp_path),
                        "VIBE_TRADING_HOSTED": "1", "LANGCHAIN_PROVIDER": "openai", "LANGCHAIN_MODEL_NAME": "fixture-model",
                        "OPENAI_BASE_URL": str(gateway.make_url("/v1")), "OPENAI_API_KEY": bridge.token})
            code = """
import asyncio, json
from src.providers.llm import build_llm
from langchain_core.messages import HumanMessage, ToolMessage
async def main():
    model = build_llm().bind_tools([{'name':'lookup','description':'contract fixture','parameters':{'type':'object','properties':{}}}])
    first = await model.ainvoke([HumanMessage(content='检查中文证据')])
    assert first.tool_calls[0]['id']
    assert first.tool_calls[0]['args']['symbol'] == '中文标的'
    second = await model.ainvoke([HumanMessage(content='检查中文证据'),first,ToolMessage(content='固定证据',tool_call_id=first.tool_calls[0]['id'])])
    assert second.content == '证据已续接'
    print('NATIVE_ADAPTER_CONTRACT_OK')
asyncio.run(main())
"""
            process = await asyncio.create_subprocess_exec(str(python), "-c", code, cwd=tmp_path, env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=45)
            assert process.returncode == 0, stderr.decode("utf-8", errors="replace")
            assert b"NATIVE_ADAPTER_CONTRACT_OK" in stdout
            assert len(calls) == 2
        await bridge.snapshot.provider.aclose()


def test_missing_explicit_preset_and_native_account_models_are_rejected() -> None:
    config = configured("http://127.0.0.1:1/v1")
    config.stock_vibe.model_preset = None
    with pytest.raises(ValueError, match="模型预设"):
        StockModelBridge.from_config(config)
    config.stock_vibe.model_preset = "stock-test"
    config.model_presets["stock-test"].provider = "openai_codex"
    with pytest.raises(ValueError, match="来源"):
        StockModelBridge.from_config(config)


async def test_explicit_mona_api_defaults_work_with_a_codebuddy_chat_executor() -> None:
    calls: list[dict] = []
    async with TestServer(upstream(calls)) as origin:
        config = configured(str(origin.make_url("/v1")))
        config.agents.defaults.executor = "codebuddy"
        config.agents.defaults.model = "fixture-model"
        config.agents.defaults.provider = "openai"
        config.stock_vibe.model_preset = "default"
        bridge = StockModelBridge.from_config(config)
        app = web.Application()
        app.router.add_post("/v1/chat/completions", bridge.complete)
        try:
            async with TestServer(app) as gateway, httpx.AsyncClient(trust_env=False, timeout=20) as client:
                response = await client.post(str(gateway.make_url("/v1/chat/completions")),
                    headers={"Authorization": "Bearer " + bridge.token}, json={
                        "model": "fixture-model", "messages": [{"role": "user", "content": "API证据"}],
                        "tools": TOOLS, "max_tokens": 20,
                    })
                assert response.status_code == 200, response.text
                assert response.json()["choices"][0]["message"]["tool_calls"]
                assert len(calls) == 1
                assert bridge.metadata()["selection"] == "default"
                assert config.agents.defaults.executor == "codebuddy"
        finally:
            await bridge.snapshot.provider.aclose()


@pytest.mark.parametrize("stream", [False, True])
async def test_provider_error_is_explicit_and_has_no_private_detail(stream: bool) -> None:
    calls: list[dict] = []
    async with TestServer(upstream(calls)) as origin:
        bridge = StockModelBridge.from_config(configured(str(origin.make_url("/v1"))))
        app = web.Application()
        app.router.add_post("/v1/chat/completions", bridge.complete)
        async with TestServer(app) as gateway, httpx.AsyncClient(trust_env=False, timeout=20) as client:
            url = str(gateway.make_url("/v1/chat/completions"))
            headers = {"Authorization": "Bearer " + bridge.token}
            assert (await client.post(url, headers=headers, content="invalid JSON")).status_code == 400
            response = await client.post(url, headers=headers, json={"model": "fixture-model", "stream": stream,
                "messages": [{"role": "user", "content": "fail-contract"}]})
            assert response.status_code == (200 if stream else 502)
            assert "model_error" in response.text
            assert "synthetic private detail" not in response.text
            assert len(calls) == 1
            assert bridge.active == 0
        await bridge.snapshot.provider.aclose()


async def test_disconnected_stream_cancels_the_one_model_request() -> None:
    started, finish = asyncio.Event(), asyncio.Event()
    count = 0

    async def slow_model(request):
        nonlocal count
        await request.json()
        count += 1
        started.set()
        await finish.wait()
        return web.json_response({})

    origin_app = web.Application()
    origin_app.router.add_post("/v1/chat/completions", slow_model)
    async with TestServer(origin_app) as origin:
        bridge = StockModelBridge.from_config(configured(str(origin.make_url("/v1"))))
        app = web.Application()
        app.router.add_post("/v1/chat/completions", bridge.complete)
        try:
            async with TestServer(app) as gateway, httpx.AsyncClient(trust_env=False, timeout=20) as client:
                async with client.stream("POST", str(gateway.make_url("/v1/chat/completions")),
                    headers={"Authorization": "Bearer " + bridge.token}, json={"model": "fixture-model", "stream": True,
                    "messages": [{"role": "user", "content": "cancel-contract"}]}) as response:
                    assert response.status_code == 200
                    await asyncio.wait_for(started.wait(), timeout=10)
                for _ in range(50):
                    if not bridge.active:
                        break
                    await asyncio.sleep(0.1)
                assert bridge.active == 0
                assert count == 1
        finally:
            finish.set()
            await bridge.snapshot.provider.aclose()
