"""Stock HTTP bridge against the production native transport and a scripted RPC peer."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from mona.api.stock_model_bridge import StockModelBridge
from mona.config.paths import get_managed_runtimes_dir
from mona.config.schema import Config, StockVibeModelBinding, _resolve_tool_config_refs
from mona.development.executors.codex_policy import CodexProfile, _fixed_config
from mona.development.input_content import MAX_NATIVE_TEXT_CHARS
from mona.providers.native_work_provider import NativeWorkProvider
from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.python_env import PythonEnvironmentBuilder
from mona.services.stock_vibe.runtime import StockVibeRuntime

PEER = r'''
import json, os, sys
from pathlib import Path
def emit(value):
    print(json.dumps(value), flush=True)
def event(method, params):
    emit({'method':method,'params':params})
for line in sys.stdin:
    request=json.loads(line)
    method,identifier=request.get('method'),request.get('id')
    params=request.get('params',{})
    if method is None and identifier=='evidence':
        text=request.get('result',{}).get('contentItems',[{}])[0].get('text','')
        event('item/completed',{'threadId':'thread','turnId':'turn','item':{
            'id':'answer','type':'agentMessage','text':'MODEL_RESULT:'+text}})
        event('turn/completed',{'threadId':'thread','turn':{'id':'turn','status':'completed'}})
        continue
    result={}
    if method=='initialize':
        result={'userAgent':'codex/0.162.0'}
    elif method=='config/read':
        result={'config':json.loads(os.environ['PEER_CONFIG'])}
    elif method=='account/read':
        result={'account':{'type':'chatgpt'},'requiresOpenaiAuth':True}
    elif method=='thread/start':
        Path('thread.json').write_text(json.dumps(params))
        result={'thread':{'id':'thread','cwd':params['cwd'],'turns':[],'status':{'type':'idle'}},
            'instructionSources':[],'sandbox':{'type':'readOnly'},
            'approvalPolicy':params['approvalPolicy'],'approvalsReviewer':params['approvalsReviewer']}
    elif method=='turn/start':
        Path('turn.json').write_text(json.dumps(params))
        emit({'id':identifier,'result':{'turn':{'id':'turn','status':'inProgress'}}})
        event('turn/started',{'threadId':'thread','turn':{'id':'turn'}})
        if os.environ.get('PEER_HOLD')!='1':
            args={'tool':'fixture_evidence','arguments':{'workspace':os.getcwd()}}
            event('item/started',{'threadId':'thread','turnId':'turn','item':{
                'id':'evidence','type':'dynamicToolCall','tool':'mona_tool','arguments':args}})
            emit({'id':'evidence','method':'item/tool/call','params':{
                'threadId':'thread','turnId':'turn','callId':'evidence','tool':'mona_tool','arguments':args}})
        continue
    elif method=='turn/interrupt':
        event('turn/completed',{'threadId':'thread','turn':{'id':'turn','status':'interrupted'}})
    if identifier is not None:
        emit({'id':identifier,'result':result})
'''

TOOLS = [{"type": "function", "function": {"name": "fixture_evidence", "description": "Read test evidence",
         "parameters": {"type": "object", "properties": {"workspace": {"type": "string"}}}}}]


def native_config(executor="codex"):
    _resolve_tool_config_refs()
    config = Config()
    config.stock_vibe.model_binding = StockVibeModelBinding(executor=executor, model="native-fixture", effort="high")
    config.development.enabled_engines = [executor]
    config.development.codex_path = sys.executable
    return config


def use_peer(tmp_path, monkeypatch, *, hold=False):
    peer = tmp_path / "peer.py"
    peer.write_text(PEER, encoding="utf-8")

    def profile(_executable, _home, workspace):
        catalog = workspace / "catalog.json"
        catalog.write_text("{}")
        effective = {}
        for name, value in _fixed_config().items():
            target = effective
            parts = name.split(".")
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            target[parts[-1]] = value
        effective.update(model_catalog_json=str(catalog), web_search="disabled", model_provider="mona_work_openai",
                         model_providers={"mona_work_openai": {"name": "OpenAI", "wire_api": "responses",
                                          "requires_openai_auth": True, "supports_websockets": False}})
        effective["features"].update(shell_tool=False, view_image=False)
        return CodexProfile((sys.executable, "-u", str(peer)), tmp_path, workspace,
                            {**os.environ, "PEER_CONFIG": json.dumps(effective), "PEER_HOLD": "1" if hold else "0"},
                            work_model_catalog=catalog), catalog

    monkeypatch.setattr("mona.providers.native_work_provider.prepare_codex_work_profile", profile)
    return StockModelBridge.from_config(native_config())


def body(messages=None, **kwargs):
    return {"model": "native-fixture", "messages": messages or [{"role": "user", "content": "Read evidence"}],
            "tools": TOOLS, **kwargs}


def continuation(first, evidence):
    return body([*body()["messages"], first,
                 {"role": "tool", "tool_call_id": first["tool_calls"][0]["id"], "content": evidence}])


@pytest.mark.parametrize("executor", ["codex", "claude", "codebuddy"])
async def test_selected_native_snapshot_is_independent_of_global_defaults(executor):
    config = native_config(executor)
    config.agents.defaults.native_context_window_tokens = 123456
    before = config.model_dump()
    bridge = StockModelBridge.from_config(config)
    try:
        assert isinstance(bridge.snapshot.provider, NativeWorkProvider)
        assert bridge.snapshot.provider.executor.value == executor
        assert bridge.snapshot.model == "native-fixture"
        assert bridge.metadata()["binding"]["effort"] == "high"
        assert not bridge.snapshot.context_window_verified
        assert config.model_dump() == before
        signature = StockVibeRuntime._model_signature(config)
        config.stock_vibe.model_binding.model = "another-native-model"
        assert StockVibeRuntime._model_signature(config) != signature
    finally:
        await bridge.aclose()


@pytest.mark.parametrize("stream", [False, True])
async def test_native_tool_roundtrip_and_isolated_concurrent_contexts(tmp_path, monkeypatch, stream):
    bridge = use_peer(tmp_path, monkeypatch)
    app = web.Application()
    app.router.add_post("/v1/chat/completions", bridge.complete)
    try:
        async with TestServer(app) as server, httpx.AsyncClient(trust_env=False, timeout=20) as client:
            url = str(server.make_url("/v1/chat/completions"))
            headers = {"Authorization": "Bearer " + bridge.token}
            responses = await asyncio.gather(*[client.post(url, headers=headers, json=body(stream=stream)) for _ in range(2)])
            first = []
            for response in responses:
                assert response.status_code == 200, response.text
                if stream:
                    chunks = [json.loads(line[6:]) for line in response.text.splitlines()
                              if line.startswith("data: ") and line[6:] != "[DONE]"]
                    calls = [call for chunk in chunks for call in chunk["choices"][0]["delta"].get("tool_calls", [])]
                    first.append({"role": "assistant", "content": None, "tool_calls": calls})
                    assert chunks[-1]["choices"][0]["finish_reason"] == "tool_calls"
                else:
                    first.append(response.json()["choices"][0]["message"])
            calls = [message["tool_calls"][0] for message in first]
            assert calls[0]["id"] != calls[1]["id"]
            workspaces = [Path(json.loads(call["function"]["arguments"])["workspace"]) for call in calls]
            assert workspaces[0] != workspaces[1]
            for workspace in workspaces:
                start = json.loads((workspace / "thread.json").read_text())
                assert start["model"] == "native-fixture"
                assert [item["name"] for item in start["dynamicTools"]] == ["mona_tool"]
            mixed = continuation(first[0], "A")
            mixed["messages"].append(continuation(first[1], "B")["messages"][-1])
            assert (await client.post(url, headers=headers, json=mixed)).status_code == 409
            duplicate = continuation(first[0], "A")
            duplicate["messages"].append(duplicate["messages"][-1])
            assert (await client.post(url, headers=headers, json=duplicate)).status_code == 409
            for index in (1, 0):
                result = await client.post(url, headers=headers, json=continuation(first[index], f"evidence-{index}"))
                assert result.json()["choices"][0]["message"]["content"] == f"MODEL_RESULT:evidence-{index}"
                assert (await client.post(url, headers=headers, json=continuation(first[index], "repeat"))).status_code == 409
            assert not bridge._native_turns and not bridge._native_pending
            assert not any(path.exists() for path in workspaces)
    finally:
        await bridge.aclose()


async def test_pending_native_turn_is_closed_on_release_and_large_history_is_rejected(tmp_path, monkeypatch):
    bridge = use_peer(tmp_path, monkeypatch)
    app = web.Application()
    app.router.add_post("/v1/chat/completions", bridge.complete)
    async with TestServer(app) as server, httpx.AsyncClient(trust_env=False, timeout=20) as client:
        url = str(server.make_url("/v1/chat/completions"))
        headers = {"Authorization": "Bearer " + bridge.token}
        oversized = body([{"role": "user", "content": "x" * MAX_NATIVE_TEXT_CHARS}])
        assert (await client.post(url, headers=headers, json=oversized)).status_code == 400
        assert not bridge._native_turns
        response = await client.post(url, headers=headers, json=body())
        assert response.json()["choices"][0]["message"]["tool_calls"]
        turn = next(iter(bridge._native_turns.values()))
        workspace = Path(turn.workspace.name)
        await bridge.aclose()
        assert turn.provider._host is None
        assert not workspace.exists() and not bridge._native_pending


async def test_disconnected_native_stream_is_cancelled_without_replay(tmp_path, monkeypatch):
    bridge = use_peer(tmp_path, monkeypatch, hold=True)
    app = web.Application()
    app.router.add_post("/v1/chat/completions", bridge.complete)
    try:
        async with TestServer(app) as server, httpx.AsyncClient(trust_env=False, timeout=20) as client:
            async with client.stream("POST", str(server.make_url("/v1/chat/completions")),
                                     headers={"Authorization": "Bearer " + bridge.token}, json=body(stream=True)) as response:
                assert response.status_code == 200
                async with asyncio.timeout(10):
                    while not bridge._native_turns or not all(
                        (Path(turn.workspace.name) / "turn.json").is_file() for turn in bridge._native_turns.values()
                    ):
                        await asyncio.sleep(0.05)
                turns = list(bridge._native_turns.values())
            async with asyncio.timeout(10):
                while bridge.active:
                    await asyncio.sleep(0.05)
            assert len(turns) == 1
            assert turns[0].provider._host is None
            assert not Path(turns[0].workspace.name).exists()
            assert not bridge._native_turns
    finally:
        await bridge.aclose()


async def test_installed_vibe_adapter_executes_tool_and_resumes_native_account_turn(tmp_path, monkeypatch):
    root = get_managed_runtimes_dir()
    store = RuntimeComponentStore(root)
    active = store.active("stock-vibe")
    if active is None:
        pytest.skip("installed stock-vibe component required for cross-process contract")
    manifest, bundle = active
    python = PythonEnvironmentBuilder(root, store, environment="stock-vibe").python_for(
        [f"{manifest.id}@{manifest.version}"])
    if python is None:
        pytest.skip("installed stock-vibe Python environment required")
    bridge = use_peer(tmp_path, monkeypatch)
    app = web.Application()
    app.router.add_post("/v1/chat/completions", bridge.complete)
    code = """
import asyncio
from langchain_core.messages import HumanMessage, ToolMessage
from langchain_core.tools import tool
from src.providers.llm import build_llm
@tool
def fixture_evidence(workspace: str) -> str:
    '''Read fixed contract evidence in Vibe's tool loop.'''
    return 'evidence returned by Vibe'
async def main():
    model = build_llm().bind_tools([fixture_evidence])
    history = [HumanMessage(content='Read evidence')]
    first = await model.ainvoke(history)
    assert len(first.tool_calls) == 1 and first.tool_calls[0]['name'] == 'fixture_evidence'
    evidence = await fixture_evidence.ainvoke(first.tool_calls[0]['args'])
    last = await model.ainvoke([*history, first, ToolMessage(content=evidence, tool_call_id=first.tool_calls[0]['id'])])
    assert last.content == 'MODEL_RESULT:evidence returned by Vibe'
    print('VIBE_NATIVE_ACCOUNT_TOOL_CONTRACT_OK')
asyncio.run(main())
"""
    try:
        async with TestServer(app) as server:
            env = {key: value for key, value in os.environ.items() if key.upper() in {
                "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"}}
            env.update(PYTHONPATH=str(bundle / "agent"), PYTHONUTF8="1", VIBE_TRADING_HOME=str(tmp_path / "vibe"),
                       VIBE_TRADING_HOSTED="1", LANGCHAIN_PROVIDER="openai", LANGCHAIN_MODEL_NAME="native-fixture",
                       OPENAI_BASE_URL=str(server.make_url("/v1")), OPENAI_API_KEY=bridge.token)
            process = await asyncio.create_subprocess_exec(str(python), "-c", code, cwd=tmp_path, env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), 45)
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            assert process.returncode == 0, stderr.decode("utf-8", errors="replace")
            assert b"VIBE_NATIVE_ACCOUNT_TOOL_CONTRACT_OK" in stdout
            assert not bridge._native_turns
    finally:
        await bridge.aclose()
