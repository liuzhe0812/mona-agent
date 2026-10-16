"""Work models use production native transport and Mona's real tool runner."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import sys

import pytest
from loguru import logger

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
from mona.development.executors.host_tools import WORK_DESCRIPTION
from mona.development.input_content import validate_content
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
    failure = os.environ.get('PEER_FAILURE')
    if (failure == 'account_rejected' and method == 'account/read'
            or failure == 'thread_rejected' and method == 'thread/start'):
        counter = Path('rejections.json')
        counter.write_text(str(int(counter.read_text()) + 1 if counter.exists() else 1))
        emit({'id': identifier, 'error': {'code': -32603, 'message': 'private upstream detail',
            'data': {'detail': 'private upstream detail'}}})
        continue
    if method is None and identifier == 'host-work':
        reply = request.get('result', {})
        text = reply.get('contentItems', [{}])[0].get('text', '')
        if os.environ.get('PEER_FAILURE') == 'overload_after_tool':
            event('turn/completed', {'threadId': 'work-thread', 'turn': {'id': 'work-turn', 'status': 'failed',
                'error': {'message': 'wording changed', 'codexErrorInfo': 'serverOverloaded'}}})
            continue
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
        counter = Path('attempts.json')
        attempt = int(counter.read_text()) + 1 if counter.exists() else 1
        counter.write_text(str(attempt))
        emit({'id': identifier, 'result': {'turn': {'id': 'work-turn', 'status': 'inProgress'}}})
        event('turn/started', {'threadId': 'work-thread', 'turn': {'id': 'work-turn'}})
        failure = os.environ.get('PEER_FAILURE')
        if failure == 'server_retry':
            event('error', {'threadId': 'work-thread', 'turnId': 'work-turn', 'willRetry': True,
                'error': {'message': 'wording changed', 'codexErrorInfo': 'serverOverloaded'}})
        if failure in {'overload_always', 'overload_after_output', 'unknown'} or failure == 'overload_once' and attempt == 1:
            if failure == 'overload_after_output':
                event('item/agentMessage/delta', {'threadId': 'work-thread', 'turnId': 'work-turn',
                    'itemId': 'partial', 'delta': 'already started'})
            event('turn/completed', {'threadId': 'work-thread', 'turn': {'id': 'work-turn',
                'status': 'unknownStatus' if failure == 'unknown' else 'failed',
                'error': {'message': 'wording changed', 'codexErrorInfo': 'serverOverloaded'}}})
            continue
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


def use_peer(tmp_path, monkeypatch, *, outside=False, hold=False, failure=""):
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
        {**os.environ, "PEER_CONFIG": json.dumps(effective), "PEER_PATH": str(output),
         "PEER_HOLD": "1" if hold else "0", "PEER_FAILURE": failure},
        work_model_catalog=catalog)
    monkeypatch.setattr("mona.providers.native_work_provider.prepare_codex_work_profile", lambda *_: (profile, catalog))
    return config, root, output, catalog


@pytest.mark.asyncio
@pytest.mark.parametrize("direct", [False, True])
async def test_agent_binding_reaches_native_transport_without_changing_global_source(
        tmp_path, monkeypatch, direct):
    from types import SimpleNamespace

    from mona.agent.loop import AgentLoop
    from mona.agent.partner_loop import PartnerAgentLoop
    from mona.agent.partners import AgentDefinition
    from mona.agent.user_config import save_agent_user_config
    from mona.bus.queue import MessageBus

    config, root, output, _ = use_peer(tmp_path, monkeypatch)
    config.agents.defaults.executor = "claude"
    config.agents.defaults.native_model = "global-other-model"
    config.agents.defaults.native_reasoning_effort = "low"
    agent_id = "agent.native-test"
    monkeypatch.setattr("mona.agent.user_config.get_agent_user_config_path",
                        lambda selected: tmp_path / selected / "config.json")
    save_agent_user_config(agent_id, {"model_binding": {
        "executor": "codex", "model": "agent-bound-model", "effort": "high",
    }}, expected_revision=0)
    definition = AgentDefinition(id=agent_id, display_name="Bound Agent")
    kwargs = dict(bus=MessageBus(), provider=NativeWorkProvider(config, root),
                  workspace=root, model="global-other-model", max_iterations=5,
                  runtime_config_loader=lambda: config)
    tools = ToolRegistry()
    tools.register(WriteFileTool(workspace=root, allowed_dir=root))
    history = [{"role": "system", "content": "AGENT_IDENTITY"},
               {"role": "user", "content": "Write once"}]
    async with asyncio.timeout(10):
        if direct:
            registry = SimpleNamespace(require=lambda _: definition, resolve_skill_dirs=lambda _: [])
            loop = PartnerAgentLoop(agent_id=agent_id, registry=registry, **kwargs)
            loop.tools = tools
            final, _, _, reason, _ = await loop._run_agent_loop(history)
            assert reason == "completed" and "HOST_RESULT" in final
        else:
            loop = AgentLoop(**kwargs)
            provider, model, effective, snapshot = loop._resolve_named_agent_runtime(definition)
            result = await AgentRunner(provider).run(AgentRunSpec(
                history, tools, model, 5, 16000, workspace=root,
                reasoning_effort=effective.reasoning_effort,
                context_window_tokens=snapshot.context_window_tokens,
                context_window_verified=snapshot.context_window_verified,
                context_provider=snapshot.context_provider,
            ))
            assert result.stop_reason == "completed"
    assert output.read_text() == "native work"
    start = json.loads((root / "thread-start.json").read_text())
    turn = json.loads((root / "turn-start.json").read_text())
    assert start["model"] == "agent-bound-model"
    assert turn["effort"] == "high"
    assert config.agents.defaults.executor == "claude"
    assert config.agents.defaults.native_model == "global-other-model"
    assert config.agents.defaults.native_reasoning_effort == "low"


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
    calls = [message for message in result.messages if message.get("role") == "tool"]
    assert len(calls) == 1
    assert ("outside allowed directory" in calls[0]["content"]) is outside
    assert checkpoints and not catalog.exists()
    start = json.loads((root / "thread-start.json").read_text())
    turn = json.loads((root / "turn-start.json").read_text())
    assert "MONA_PERSONALITY" in start["baseInstructions"]
    assert "projectSkills" not in start["developerInstructions"]
    assert start["dynamicTools"][0]["name"] == "mona_tool"
    assert start["developerInstructions"] == start["dynamicTools"][0]["description"] == WORK_DESCRIPTION
    assert "does not make the listed Mona tools read-only" in start["developerInstructions"]
    assert start["sandbox"] == "read-only"
    assert start["environments"] == []
    assert start["model"] == "native-fixture" and turn["effort"] == "high"
    assert "EARLIER_RESPONSE" in json.dumps(turn["input"])
    assert result.usage["prompt_tokens"] == 100 and result.usage["completion_tokens"] == 9


@pytest.mark.asyncio
@pytest.mark.parametrize("failure,code", [
    ("account_rejected", "native_account_check_failed"),
    ("thread_rejected", "native_request_rejected"),
])
async def test_work_initialization_rejection_reports_stage_without_replaying_or_exposing_details(
        tmp_path, monkeypatch, failure, code):
    config, root, output, catalog = use_peer(tmp_path, monkeypatch, failure=failure)
    diagnostics = []
    sink = logger.add(lambda message: diagnostics.append(str(message)), level="WARNING")
    provider = NativeWorkProvider(config, root)
    try:
        async with asyncio.timeout(10):
            response = await provider.chat_stream_with_retry(
                [{"role": "user", "content": "Prepare the storyboard"}], model="native-fixture")
        assert response.finish_reason == "error" and response.error_code == code
        assert not response.error_should_retry
        assert ("尚未开始本次生成" in response.content) is (failure == "account_rejected")
        assert "private upstream detail" not in response.content
        assert (root / "rejections.json").read_text() == "1"
        assert not (root / "turn-start.json").exists() and not output.exists()
        diagnostic = "".join(diagnostics)
        assert f"method={'account/read' if failure == 'account_rejected' else 'thread/start'}" in diagnostic
        assert "rpc_code=-32603" in diagnostic and "private upstream detail" not in diagnostic
    finally:
        logger.remove(sink)
        await provider.aclose()
    assert not catalog.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure,attempts,completed,written", [
    ("overload_once", 2, True, True),
    ("overload_always", 4, False, False),
    ("overload_after_tool", 1, False, True),
    ("overload_after_output", 1, False, False),
    ("unknown", 1, False, False),
    ("server_retry", 1, True, True),
])
async def test_work_overload_retry_requires_a_failed_turn_without_output_or_tools(
        tmp_path, monkeypatch, failure, attempts, completed, written):
    config, root, output, catalog = use_peer(tmp_path, monkeypatch, failure=failure)
    monkeypatch.setattr(NativeWorkProvider, "_CHAT_RETRY_DELAYS", (0, 0, 0))
    tools = ToolRegistry()
    tools.register(WriteFileTool(workspace=root, allowed_dir=root))
    content = [{"type": "text", "text": "Write once"}]
    if failure == "unknown":
        content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64,"
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jpfoAAAAASUVORK5CYII="}})
    provider = NativeWorkProvider(config, root)
    async with asyncio.timeout(30):
        result = await AgentRunner(provider).run(AgentRunSpec(
            [{"role": "system", "content": "Mona"}, {"role": "user", "content": content}],
            tools, "native-fixture", 5, 16000, workspace=root))
    assert result.stop_reason == ("completed" if completed else "error")
    assert int((root / "attempts.json").read_text()) == attempts
    assert output.exists() is written
    calls = [message for message in result.messages if message.get("role") == "tool"]
    assert len(calls) == int(written)
    if written:
        assert output.read_text() == "native work"
    if not completed and failure != "unknown":
        assert "模型繁忙" in result.final_content and "检查连接" not in result.final_content
    if failure == "unknown":
        assert any(block.get("type") == "image_url" for block in content)
    assert not catalog.exists()


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


def test_long_work_history_is_a_valid_native_input_without_losing_message_boundaries():
    messages = [{"role": "user" if index % 2 == 0 else "assistant", "content": f"history-{index}"}
                for index in range(80)]
    content = native_history_input(messages)
    validate_content(content)
    assert len(content) == 1
    for index in range(80):
        assert f'"content": "history-{index}"' in content[0]["text"]
    assert '"role": "user"' in content[0]["text"] and '"role": "assistant"' in content[0]["text"]


def test_native_history_text_coalescing_preserves_image_position():
    image = {"type": "image_url", "image_url": {"url": "data:image/png;base64,fixture"}}
    content = native_history_input([
        {"role": "user", "content": [{"type": "text", "text": "before-image"}, image,
                                     {"type": "text", "text": "after-image"}]},
        {"role": "assistant", "content": "later-response"},
    ])
    assert len(content) == 3 and content[1] == image
    assert "before-image" in content[0]["text"] and "after-image" not in content[0]["text"]
    assert "after-image" in content[2]["text"] and "later-response" in content[2]["text"]


def test_completed_video_tool_history_fits_next_turn_without_dropping_user_or_current_results():
    messages = [
        {"role": "user", "content": "Use the approved script, voice and Dashi style."},
        {"role": "assistant", "tool_calls": [{"id": "old-preview", "function": {"name": "video", "arguments": {"action": "preview"}}}]},
        {"role": "tool", "tool_call_id": "old-preview", "content": "old diagnostics " * 16_000},
        {"role": "assistant", "content": "Two scenes are prepared; no export."},
        {"role": "user", "content": "Change only the last sentence of scene 2."},
        {"role": "tool", "tool_call_id": "current-inspect", "content": "CURRENT APPROVED PLAN"},
    ]
    saved = copy.deepcopy(messages)
    content = native_history_input(messages)
    validate_content(content)
    assert messages == saved
    text = "".join(block.get("text", "") for block in content)
    assert "Use the approved script, voice and Dashi style." in text
    assert "Change only the last sentence of scene 2." in text
    assert "CURRENT APPROVED PLAN" in text and "old-preview" in text
    assert "Older tool text omitted" in text and "do not replay" in text


def test_native_history_never_trims_the_current_user_request_to_hide_input_overflow():
    from mona.development.store import DevelopmentError

    request = "user's current facts " * 11_000
    content = native_history_input([{"role": "user", "content": request}])
    assert request in content[0]["text"]
    with pytest.raises(DevelopmentError, match="输入内容无效"):
        validate_content(content)


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


@pytest.mark.asyncio
@pytest.mark.parametrize("cached_auth,missing_model,connected", [
    ("unknown", False, True), ("ready", True, True), ("required", False, False),
])
async def test_work_model_selection_refreshes_stale_account_or_catalog_before_saving(
        tmp_path, monkeypatch, cached_auth, missing_model, connected):
    from test_workbench_api import AUTH, setup_client

    config_path = tmp_path / "config.json"
    monkeypatch.setattr("mona.config.loader.get_config_path", lambda: config_path)
    monkeypatch.setattr("mona.webui.settings_api._managed_model_catalog", lambda: {"available": False, "models": []})
    config = Config()
    config.development.enabled_engines = ["codex"]
    save_config(config)
    before = config_path.read_bytes()
    client, runtime, _ = await setup_client(tmp_path, monkeypatch, config_loader=load_config)
    models = [{"id": "gpt-6-sol", "reasoningEfforts": ["medium", "high"], "contextWindow": 32768}]
    source = {"id": "codex", "available": True, "probe": {"authentication": cached_auth},
              "models": [] if missing_model else models}
    monkeypatch.setattr(runtime.native, "describe", lambda: [source])
    probes = []

    async def probe(project_id, executor):
        probes.append((project_id, executor.value))
        source["probe"] = {"authentication": "ready" if connected else "required"}
        source["models"] = models
        return {**source["probe"], "errorCode": None if connected else "authentication_required"}

    monkeypatch.setattr(runtime.native, "probe", probe)
    try:
        response = await client.put("/api/development/work-model-source", headers=AUTH,
                                    json={"executor": "codex", "model": "gpt-6-sol", "effort": "high"})
        assert probes == [(None, "codex")]
        if connected:
            assert response.status == 200
            saved = load_config().agents.defaults
            assert saved.native_model == "gpt-6-sol" and saved.native_reasoning_effort == "high"
        else:
            assert response.status == 422 and (await response.json())["error"]["code"] == "authentication_required"
            assert config_path.read_bytes() == before
        assert not runtime.tasks and not runtime.native.hosts and runtime.store.list_projects() == []
    finally:
        await client.close()
