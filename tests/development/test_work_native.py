"""Work models use production native transport and Mona's real tool runner."""

from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.filesystem import WriteFileTool
from mona.agent.tools.registry import ToolRegistry
from mona.config.loader import load_config, save_config
from mona.config.schema import Config
from mona.development.executors.codex_policy import (
    CodexProfile,
    _fixed_config,
    prepare_codex_work_profile,
)
from mona.providers.factory import build_provider_snapshot
from mona.providers.native_work_provider import NativeWorkProvider, native_history_input

PEER = r'''
import json, os, sys
from pathlib import Path

def emit(value):
    print(json.dumps(value), flush=True)

def event(method, params):
    emit({'method': method, 'params': params})

for line in sys.stdin:
    request = json.loads(line)
    method, identifier = request.get('method'), request.get('id')
    params = request.get('params', {})
    if method is None and identifier == 'host-work':
        reply = request.get('result', {})
        text = reply.get('contentItems', [{}])[0].get('text', '')
        event('item/completed', {'threadId': 'work-thread', 'turnId': 'work-turn',
            'item': {'id': 'answer', 'type': 'agentMessage', 'text': 'HOST_RESULT: ' + text}})
        event('thread/tokenUsage/updated', {'threadId': 'work-thread', 'turnId': 'work-turn',
            'tokenUsage': {'total': {'inputTokens': 100, 'outputTokens': 9},
                'last': {'totalTokens': 109}, 'modelContextWindow': 32768}})
        event('turn/completed', {'threadId': 'work-thread', 'turn': {'id': 'work-turn', 'status': 'completed'}})
        continue
    result = None
    if method == 'initialize':
        result = {'userAgent': 'codex/0.162.0'}
    elif method == 'config/read':
        result = {'config': json.loads(os.environ['PEER_CONFIG'])}
    elif method == 'account/read':
        result = {'account': {'type': 'chatgpt'}, 'requiresOpenaiAuth': True}
    elif method == 'thread/start':
        Path('thread-start.json').write_text(json.dumps(params), encoding='utf-8')
        result = {'thread': {'id': 'work-thread', 'cwd': params['cwd'], 'turns': [], 'status': {'type': 'idle'}},
            'instructionSources': [], 'sandbox': {'type': 'readOnly'},
            'approvalPolicy': params['approvalPolicy'], 'approvalsReviewer': params['approvalsReviewer']}
    elif method == 'turn/start':
        Path('turn-start.json').write_text(json.dumps(params), encoding='utf-8')
        emit({'id': identifier, 'result': {'turn': {'id': 'work-turn', 'status': 'inProgress'}}})
        event('turn/started', {'threadId': 'work-thread', 'turn': {'id': 'work-turn'}})
        if os.environ.get('PEER_HOLD') != '1':
            arguments = {'tool': 'write_file', 'arguments': {'path': os.environ['PEER_PATH'], 'content': 'native work'}}
            event('item/started', {'threadId': 'work-thread', 'turnId': 'work-turn',
                'item': {'id': 'host-work', 'type': 'dynamicToolCall', 'tool': 'mona_tool', 'arguments': arguments}})
            emit({'id': 'host-work', 'method': 'item/tool/call', 'params': {'threadId': 'work-thread',
                'turnId': 'work-turn', 'callId': 'host-work', 'tool': 'mona_tool', 'arguments': arguments}})
        continue
    elif method == 'turn/interrupt':
        event('turn/completed', {'threadId': 'work-thread', 'turn': {'id': 'work-turn', 'status': 'interrupted'}})
        result = {}
    if identifier is not None:
        emit({'id': identifier, 'result': result or {}})
'''


def use_peer(tmp_path, monkeypatch, *, outside=False, hold=False):
    root = tmp_path / "work"
    root.mkdir()
    peer = tmp_path / "native-peer.py"
    peer.write_text(PEER, encoding="utf-8")
    catalog = tmp_path / "catalog.json"
    catalog.write_text("{}")
    config = Config()
    config.agents.defaults.executor = "codex"
    config.agents.defaults.native_model = "native-fixture"
    config.agents.defaults.native_reasoning_effort = "high"
    config.development.codex_path = sys.executable
    config.development.enabled_engines = ["codex"]
    effective = {}
    for name, value in _fixed_config().items():
        target = effective
        parts = name.split(".")
        for part in parts[:-1]:
            target = target.setdefault(part, {})
        target[parts[-1]] = value
    effective.update(model_catalog_json=str(catalog), web_search="disabled")
    effective["features"].update(shell_tool=False, view_image=False)
    effective["model_provider"] = "mona_work_openai"
    effective["model_providers"] = {"mona_work_openai": {"name": "OpenAI", "wire_api": "responses",
        "requires_openai_auth": True, "supports_websockets": False}}
    output = tmp_path / "outside.txt" if outside else root / "result.txt"
    profile = CodexProfile((sys.executable, "-u", str(peer)), tmp_path, root,
        {**os.environ, "PEER_CONFIG": json.dumps(effective), "PEER_PATH": str(output), "PEER_HOLD": "1" if hold else "0"},
        work_model_catalog=catalog)
    monkeypatch.setattr("mona.providers.native_work_provider.prepare_codex_work_profile", lambda *_: (profile, catalog))
    return config, root, output, catalog


@pytest.mark.asyncio
@pytest.mark.parametrize("outside", [False, True])
async def test_native_tool_calls_use_work_runner_and_workspace_permissions(tmp_path, monkeypatch, outside):
    config, root, output, catalog = use_peer(tmp_path, monkeypatch, outside=outside)
    tools = ToolRegistry()
    tools.register(WriteFileTool(workspace=root, allowed_dir=root))
    checkpoints = []
    async def checkpoint(payload):
        checkpoints.append(payload)
    provider = NativeWorkProvider(config, root)
    history = [{"role": "system", "content": "MONA_PERSONALITY"},
               {"role": "user", "content": "EARLIER_REQUEST"},
               {"role": "assistant", "content": "EARLIER_RESPONSE"},
               {"role": "user", "content": "Write once"}]
    async with asyncio.timeout(10):
        result = await AgentRunner(provider).run(AgentRunSpec(history, tools, "native-fixture", 5, 16000,
            workspace=root, reasoning_effort="high", checkpoint_callback=checkpoint))
    assert result.stop_reason == "completed"
    assert output.exists() is not outside
    if not outside:
        assert output.read_text() == "native work"
    assert len([message for message in result.messages if message.get("role") == "tool"]) == 1
    assert checkpoints and not catalog.exists()
    start = json.loads((root / "thread-start.json").read_text())
    turn = json.loads((root / "turn-start.json").read_text())
    assert "MONA_PERSONALITY" in start["baseInstructions"]
    assert "projectSkills" not in start["developerInstructions"]
    assert start["dynamicTools"][0]["name"] == "mona_tool"
    assert start["sandbox"] == "read-only"
    assert start["environments"] == []
    assert start["model"] == "native-fixture" and turn["effort"] == "high"
    assert "EARLIER_RESPONSE" in json.dumps(turn["input"])
    assert result.usage["prompt_tokens"] == 100 and result.usage["completion_tokens"] == 9


@pytest.mark.asyncio
async def test_stopping_work_closes_native_turn_without_redispatch(tmp_path, monkeypatch):
    config, root, output, catalog = use_peer(tmp_path, monkeypatch, hold=True)
    provider = NativeWorkProvider(config, root)
    task = asyncio.create_task(AgentRunner(provider).run(AgentRunSpec(
        [{"role": "system", "content": "Mona"}, {"role": "user", "content": "wait"}],
        ToolRegistry(), "native-fixture", 3, 16000, workspace=root)))
    try:
        async with asyncio.timeout(5):
            while not (root / "turn-start.json").exists():
                await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not output.exists() and not catalog.exists()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def test_work_snapshot_preserves_explicit_api_routes_and_image_history(tmp_path):
    config = Config()
    config.agents.defaults.executor = "codex"
    config.agents.defaults.native_model = "native-fixture"
    config.agents.defaults.native_reasoning_effort = "high"
    config.agents.defaults.native_context_window_tokens = 32768
    config.agents.defaults.fallback_models = ["other-api-model"]
    snapshot = build_provider_snapshot(config)
    assert isinstance(snapshot.provider, NativeWorkProvider)
    assert snapshot.model == "native-fixture" and snapshot.context_window_tokens == 32768
    assert snapshot.provider.generation.reasoning_effort == "high"
    config.agents.defaults.fallback_models = []
    api = build_provider_snapshot(config, preset=config.resolve_default_preset())
    assert not isinstance(api.provider, NativeWorkProvider)
    image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,test-image"}}
    assert image in native_history_input([{"role": "user", "content": [{"type": "text", "text": "inspect"}, image]}])


def test_codex_work_profile_removes_native_filesystem_tools(tmp_path):
    root = tmp_path / "work"
    root.mkdir()
    home = tmp_path / "native"
    home.mkdir()
    (home / ".mona-native-home").write_text("mona-development-codex-v1\n")
    (home / "models_cache.json").write_text(json.dumps({"models": [{"slug": "native-fixture", "context_window": 32768,
        "shell_type": "unified_exec", "apply_patch_tool_type": "freeform", "experimental_supported_tools": ["exec"]}]}))
    profile, path = prepare_codex_work_profile(sys.executable, home, root)
    try:
        model = json.loads(path.read_text())["models"][0]
        assert model["shell_type"] == "disabled" and model["apply_patch_tool_type"] is None
        assert model["experimental_supported_tools"] == [] and model["context_window"] == 32768
        assert profile.work_model_catalog == path
    finally:
        path.unlink()


@pytest.mark.asyncio
async def test_work_source_api_persists_native_choice_and_restores_api(tmp_path, monkeypatch):
    from test_workbench_api import AUTH, setup_client
    config_path = tmp_path / "config.json"
    monkeypatch.setattr("mona.config.loader.get_config_path", lambda: config_path)
    monkeypatch.setattr("mona.webui.settings_api._managed_model_catalog", lambda: {"available": False, "models": []})
    config = Config()
    config.providers.openai.api_key = "synthetic-local-fixture"
    config.providers.openai.enabled_models = ["api-fixture"]
    config.providers.openai.discovered_models = [{"id": "api-fixture", "type": "chat", "reasoning_efforts": ["high"]}]
    save_config(config)
    client, runtime, _ = await setup_client(tmp_path, monkeypatch, config_loader=load_config)
    source = {"id": "codex", "available": True, "probe": {"authentication": "ready"},
              "models": [{"id": "native-fixture", "reasoningEfforts": ["high"], "contextWindow": 32768}]}
    monkeypatch.setattr(runtime.native, "describe", lambda: [source])
    try:
        body = {"executor": "codex", "model": "native-fixture", "effort": "high"}
        denied = await client.put("/api/development/work-model-source", json=body)
        assert denied.status == 401 and load_config().agents.defaults.executor == "mona"
        response = await client.put("/api/development/work-model-source", json=body, headers=AUTH)
        assert response.status == 200
        saved = (await response.json())["agent"]
        assert saved["executor"] == "codex" and saved["native_model"] == "native-fixture"
        assert saved["native_context_window_tokens"] == 32768
        before = config_path.read_bytes()
        invalid = await client.put("/api/development/work-model-source", json={**body, "effort": "unsupported"}, headers=AUTH)
        assert invalid.status == 422 and config_path.read_bytes() == before
        restored = await client.put("/api/development/work-model-source", json={
            "executor": "mona", "provider": "openai", "model": "api-fixture", "effort": "high"}, headers=AUTH)
        assert restored.status == 200
        assert load_config().agents.defaults.executor == "mona"
        assert load_config().agents.defaults.model == "api-fixture"
        assert runtime.store.list_projects() == [] and not runtime.tasks and not runtime.native.hosts
    finally:
        await client.close()
