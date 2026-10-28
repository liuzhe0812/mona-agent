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
from mona.development.input_content import (
    MAX_NATIVE_FRAME_BYTES,
    codex_input,
    sdk_content,
    validate_content,
)
from mona.development.store import DevelopmentError
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
            'tokenUsage': json.loads(os.environ['PEER_TOKEN_USAGE'])})
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
        if failure == 'classified':
            event('turn/completed', {'threadId': 'work-thread', 'turn': {'id': 'work-turn', 'status': 'failed',
                'error': {'message': 'private upstream detail', 'codexErrorInfo': json.loads(os.environ['PEER_ERROR_INFO'])}}})
            continue
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


def use_peer(tmp_path, monkeypatch, *, outside=False, hold=False, failure="", token_usage=None, error_info=None):
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
    if token_usage is None:
        token_usage = {
            "total": {"inputTokens": 100, "outputTokens": 9},
            "last": {"totalTokens": 109},
            "modelContextWindow": 32768,
        }
    profile = CodexProfile((sys.executable, "-u", str(peer)), tmp_path, root,
        {**os.environ, "PEER_CONFIG": json.dumps(effective), "PEER_PATH": str(output),
         "PEER_HOLD": "1" if hold else "0", "PEER_FAILURE": failure,
         "PEER_ERROR_INFO": json.dumps(error_info),
         "PEER_TOKEN_USAGE": json.dumps(token_usage)},
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


def test_runner_preserves_native_context_usage_and_reported_window():
    spec = AgentRunSpec(
        [], ToolRegistry(), "native-model", 1, 16000,
        context_window_tokens=32_000,
        context_window_verified=True,
        context_provider="codex",
    )

    usage = AgentRunner._contextualize_usage({
        "prompt_tokens": 5_500_000,
        "completion_tokens": 41_000,
        "context_tokens": 80_000,
        "context_window_tokens": 1_000_000,
    }, spec)

    assert usage["prompt_tokens"] + usage["completion_tokens"] == 5_541_000
    assert usage["context_tokens"] == 80_000
    assert usage["context_window_tokens"] == 1_000_000
    assert usage["context_model"] == "native-model"
    assert usage["context_provider"] == "codex"


@pytest.mark.parametrize(
    "native_usage,expected_prompt,cached",
    [
        ({"input_tokens": 100, "cache_read_input_tokens": 25,
          "cache_creation_input_tokens": 10, "output_tokens": 20}, 135, 25),
        ({"inputTokens": 135, "cachedInputTokens": 25,
          "cache_creation_input_tokens": 10, "outputTokens": 20}, 135, 25),
    ],
)
def test_native_work_usage_normalizes_cache_without_double_counting(
    tmp_path, native_usage, expected_prompt, cached,
):
    provider = NativeWorkProvider(Config(), tmp_path)

    provider._update_usage({"usage": native_usage})
    response = provider._response("done")

    assert response.usage["prompt_tokens"] == expected_prompt
    assert response.usage["cached_tokens"] == cached
    assert response.usage["total_tokens"] == expected_prompt + 20


def test_native_work_usage_diffs_cumulative_cache_updates():
    provider = NativeWorkProvider.__new__(NativeWorkProvider)
    provider._usage = {}
    provider._reported_usage = {}
    provider._context_usage = {}
    provider._carry_usage = {}
    from mona.development.contracts import ExecutorId
    provider.executor = ExecutorId.CLAUDE

    provider._update_usage({"usage": {
        "input_tokens": 90,
        "cache_read_input_tokens": 10,
        "cache_creation_input_tokens": 4,
        "output_tokens": 5,
    }})
    first = provider._response("first")
    provider._update_usage({"usage": {
        "input_tokens": 140,
        "cache_read_input_tokens": 30,
        "cache_creation_input_tokens": 8,
        "output_tokens": 9,
    }})
    second = provider._response("second")
    repeated = provider._response("same cumulative snapshot")

    assert first.usage == {"prompt_tokens": 104, "cached_tokens": 10, "completion_tokens": 5, "total_tokens": 109}
    assert second.usage == {"prompt_tokens": 74, "cached_tokens": 20, "completion_tokens": 4, "total_tokens": 78}
    assert repeated.usage == {"prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0, "total_tokens": 0}


def test_codebuddy_native_cache_is_a_subset_and_missing_input_is_not_reported_as_zero(tmp_path):
    config = Config()
    config.agents.defaults.executor = "codebuddy"
    provider = NativeWorkProvider(config, tmp_path)
    provider._update_usage({"usage": {"input_tokens": 100, "cache_read_input_tokens": 90, "output_tokens": 5}})
    response = provider._response("received")
    assert response.usage == {"prompt_tokens": 100, "cached_tokens": 90, "completion_tokens": 5, "total_tokens": 105}
    provider = NativeWorkProvider(config, tmp_path)
    provider._update_usage({"usage": {"cache_read_input_tokens": 90}})
    assert provider._response("received cache only").usage == {"cached_tokens": 90}


def test_native_cumulative_usage_is_not_a_context_window_estimate():
    spec = AgentRunSpec([], ToolRegistry(), "native-model", 1, 16000, context_usage_fallback=False)
    usage = AgentRunner._contextualize_usage({"prompt_tokens": 5_500_000, "completion_tokens": 41_000}, spec)
    assert usage == {"prompt_tokens": 5_500_000, "completion_tokens": 41_000}


def test_runner_treats_zero_native_context_usage_as_reported():
    spec = AgentRunSpec([], ToolRegistry(), "native-model", 1, 16000)

    usage = AgentRunner._contextualize_usage({
        "prompt_tokens": 5_500_000,
        "completion_tokens": 41_000,
        "context_tokens": 0,
    }, spec)

    assert usage["context_tokens"] == 0


def test_runner_binds_context_metadata_without_billing_fields():
    spec = AgentRunSpec(
        [], ToolRegistry(), "native-model", 1, 16000, context_provider="codex",
    )

    usage = AgentRunner._contextualize_usage({"context_tokens": 80_000}, spec)

    assert usage["context_tokens"] == 80_000
    assert usage["context_model"] == "native-model"
    assert usage["context_provider"] == "codex"
    assert "prompt_tokens" not in usage
    assert "completion_tokens" not in usage


@pytest.mark.asyncio
async def test_native_work_keeps_cumulative_billing_separate_from_last_context(tmp_path, monkeypatch):
    monkeypatch.setattr(
        NativeWorkProvider,
        "estimate_prompt_tokens",
        lambda *args, **kwargs: (10_000, "test"),
        raising=False,
    )
    config, root, output, _ = use_peer(tmp_path, monkeypatch, token_usage={
        "total": {"inputTokens": 5_500_000, "outputTokens": 41_000},
        "last": {"totalTokens": 80_000},
        "modelContextWindow": 1_000_000,
    })
    tools = ToolRegistry()
    tools.register(WriteFileTool(workspace=root, allowed_dir=root))
    progress = []

    async def progress_callback(_content, *, token_usage=None):
        if token_usage:
            progress.append(token_usage)

    provider = NativeWorkProvider(config, root)
    async with asyncio.timeout(10):
        result = await AgentRunner(provider).run(AgentRunSpec(
            [{"role": "system", "content": "MONA_PERSONALITY"},
             {"role": "user", "content": "Write once"}],
            tools,
            "native-fixture",
            5,
            16000,
            workspace=root,
            reasoning_effort="high",
            context_window_tokens=32_000,
            context_window_verified=True,
            context_provider="codex",
            progress_callback=progress_callback,
        ))

    assert result.stop_reason == "completed"
    assert output.read_text() == "native work"
    assert result.usage["prompt_tokens"] == 5_500_000
    assert result.usage["completion_tokens"] == 41_000
    assert result.usage["total_tokens"] == 5_541_000
    assert result.final_usage["context_tokens"] == 80_000
    assert result.final_usage["context_window_tokens"] == 1_000_000
    assert progress[-1]["context_tokens"] == 80_000
    assert progress[-1]["context_window_tokens"] == 1_000_000


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
        assert "尚未开始本次生成" in response.content
        assert ("账号状态检查" in response.content) is (failure == "account_rejected")
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
@pytest.mark.parametrize("error_info,code,message,status", [
    ("contextWindowExceeded", "context_window_exceeded", "容量", None),
    ("sessionBudgetExceeded", "session_budget_exceeded", "运行预算", None),
    ("usageLimitExceeded", "usage_limit_exceeded", "使用额度", None),
    ("rateLimitExceeded", "rate_limit_exceeded", "请求频率", None),
    ("unauthorized", "authentication_required", "登录", None),
    ("badRequest", "upstream_invalid_request", "请求参数", None),
    ("internalServerError", "upstream_internal_error", "模型服务发生内部错误", None),
    ("cyberPolicy", "model_policy_rejected", "内容政策", None),
    ({"responseStreamDisconnected": {"httpStatusCode": None}}, "upstream_stream_disconnected", "断开", None),
    ({"httpConnectionFailed": {"httpStatusCode": 401}}, "authentication_required", "登录", 401),
    ({"httpConnectionFailed": {"httpStatusCode": 403}}, "model_access_denied", "模型权限", 403),
    ({"httpConnectionFailed": {"httpStatusCode": 404}}, "upstream_not_found", "请求地址", 404),
    ({"httpConnectionFailed": {"httpStatusCode": 429}}, "rate_limit_exceeded", "请求频率", 429),
    ({"responseTooManyFailedAttempts": {"httpStatusCode": 502}}, "upstream_internal_error", "模型服务发生内部错误", 502),
    ("futureErrorVariant", "native_turn_failed", "未提供可识别的原因", None),
])
async def test_native_work_reports_sanitized_error_categories(tmp_path, monkeypatch, error_info, code, message, status):
    config, root, output, _ = use_peer(tmp_path, monkeypatch, failure="classified", error_info=error_info)
    provider = NativeWorkProvider(config, root)
    try:
        async with asyncio.timeout(10):
            response = await provider.chat_stream_with_retry([{"role": "user", "content": "Inspect"}], model="native-fixture")
        assert response.finish_reason == "error" and response.error_code == code
        assert response.error_status_code == status and message in response.content
        assert "private upstream detail" not in response.content and not response.error_should_retry
        assert (root / "attempts.json").read_text() == "1" and not output.exists()
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_invalid_local_input_is_reported_before_starting_a_model(tmp_path, monkeypatch):
    config, root, output, _ = use_peer(tmp_path, monkeypatch)
    provider = NativeWorkProvider(config, root)
    response = await provider.chat_stream_with_retry([
        {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,invalid"}}]},
    ])
    assert response.error_code == "invalid_input_content"
    assert "图片格式无法识别" in response.content and "尚未发送" in response.content
    assert not response.error_should_retry and not (root / "thread-start.json").exists()
    assert not output.exists()


@pytest.mark.asyncio
async def test_internal_preparation_error_does_not_blame_model_or_expose_exception(tmp_path, monkeypatch):
    config, root, _, _ = use_peer(tmp_path, monkeypatch)
    def broken_history(_):
        raise AttributeError("PRIVATE_INTERNAL_DETAIL")
    monkeypatch.setattr("mona.providers.native_work_provider.native_history_input", broken_history)
    response = await NativeWorkProvider(config, root).chat_stream_with_retry([{"role": "user", "content": "Inspect"}])
    assert response.error_code == "native_response_failed" and "Mona" in response.content
    assert "内部错误" in response.content and "尚未开始" in response.content
    assert "PRIVATE_INTERNAL_DETAIL" not in response.content and not response.error_should_retry
    assert not (root / "thread-start.json").exists()


@pytest.mark.asyncio
async def test_unmapped_connection_setup_error_still_reports_setup_stage(tmp_path, monkeypatch):
    from mona.development.executors.rpc import RpcError

    config, root, _, _ = use_peer(tmp_path, monkeypatch)
    def unavailable(*_):
        raise RpcError("work_policy_unverified", "PRIVATE_CONFIGURATION_DETAIL")
    monkeypatch.setattr("mona.providers.native_work_provider.prepare_codex_work_profile", unavailable)
    response = await NativeWorkProvider(config, root).chat_stream_with_retry([{"role": "user", "content": "Inspect"}])
    assert response.error_code == "work_policy_unverified" and "本机连接未能准备就绪" in response.content
    assert "尚未开始" in response.content and "内部错误" not in response.content
    assert "PRIVATE_CONFIGURATION_DETAIL" not in response.content and not response.error_should_retry


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


def test_work_context_preserves_large_history_and_tool_arguments():
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
    validate_content(content, context_input=True)
    assert messages == saved
    text = "".join(block.get("text", "") for block in content)
    assert "Use the approved script, voice and Dashi style." in text
    assert "Change only the last sentence of scene 2." in text
    assert "CURRENT APPROVED PLAN" in text and "old-preview" in text
    assert messages[2]["content"] in text
    assert "Older tool text omitted" not in text


def test_model_context_and_single_user_input_have_separate_limits():
    request = "user's current facts " * 11_000
    content = native_history_input([{"role": "user", "content": request}])
    assert request in content[0]["text"]
    with pytest.raises(DevelopmentError) as error:
        validate_content(content)
    assert error.value.code == "input_text_too_large"
    assert codex_input(content, context_input=True)[0]["text"] == content[0]["text"]
    assert sdk_content(content, context_input=True) == content


def test_work_context_still_rejects_a_request_above_the_transport_byte_limit():
    # Multibyte text can exceed the byte budget while the character count is smaller.
    content = [{"type": "text", "text": "汉" * (MAX_NATIVE_FRAME_BYTES // 3 + 1)}]
    for convert in (codex_input, sdk_content):
        with pytest.raises(DevelopmentError) as error:
            convert(content, context_input=True)
        assert error.value.code == "rpc_frame_too_large"


def test_work_context_keeps_multiple_message_blocks_without_single_input_count_limit():
    content = [{"type": "text", "text": f"message-{index}"} for index in range(40)]
    with pytest.raises(DevelopmentError) as error:
        validate_content(content)
    assert error.value.code == "input_parts_too_many"
    assert sdk_content(content, context_input=True) == content
    assert codex_input(content, context_input=True) == content


@pytest.mark.asyncio
async def test_long_work_history_reaches_native_model_without_loss_or_replaying_tools(tmp_path, monkeypatch):
    config, root, output, _ = use_peer(tmp_path, monkeypatch)
    tools = ToolRegistry()
    tools.register(WriteFileTool(workspace=root, allowed_dir=root))
    history = [{"role": "system", "content": "MONA_PERSONALITY"}, {"role": "user", "content": "Earlier task"}]
    for index in range(80):
        history.extend([
            {"role": "assistant", "tool_calls": [{"id": f"old-{index}", "type": "function",
                "function": {"name": "write_file", "arguments": json.dumps({"content": "a" * 1000})}}]},
            {"role": "tool", "tool_call_id": f"old-{index}", "content": f"result-{index}:" + "b" * 3000},
        ])
    history.append({"role": "user", "content": "Write once"})
    original = copy.deepcopy(history)
    async with asyncio.timeout(10):
        result = await AgentRunner(NativeWorkProvider(config, root)).run(AgentRunSpec(
            history, tools, "native-fixture", 5, 16000, workspace=root, context_window_tokens=1_000_000))
    assert result.stop_reason == "completed" and output.read_text() == "native work"
    sent = json.loads((root / "turn-start.json").read_text())["input"][0]["text"]
    assert len(sent) > 200_000
    for message in original:
        if message.get("role") == "tool":
            assert message["content"] in sent
    assert (root / "attempts.json").read_text() == "1"
    assert len([m for m in result.messages[len(original):] if m.get("role") == "tool"]) == 1


@pytest.mark.asyncio
async def test_work_model_token_budget_still_blocks_oversized_context_before_dispatch(tmp_path, monkeypatch):
    config, root, _, _ = use_peer(tmp_path, monkeypatch)
    async with asyncio.timeout(10):
        result = await AgentRunner(NativeWorkProvider(config, root)).run(AgentRunSpec(
            [{"role": "user", "content": "large input " * 40_000}], ToolRegistry(), "native-fixture", 2, 16000,
            workspace=root, context_window_tokens=32_768, max_tokens=1024))
    assert result.stop_reason == "context_limit"
    assert not (root / "turn-start.json").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("executor", ["claude", "codebuddy"])
@pytest.mark.parametrize("work_mode", [False, True])
async def test_sdk_host_and_worker_agree_on_context_input_limits(tmp_path, executor, work_mode):
    from pathlib import Path
    from types import SimpleNamespace

    from mona.development.context import ProjectContext
    from mona.development.contracts import Binding, DevelopmentSession, ExecutorId
    from mona.development.executors.base import SessionStart
    from mona.development.executors.sdk import SDKExecutor, _SDKSession
    from mona.development.executors.sdk_events import SDKEventProjector
    from mona.development.executors.sdk_policy import SDKProfile
    from mona.development.executors.sdk_worker import Worker

    selected = ExecutorId(executor)
    session = DevelopmentSession(project_id="work", executor=selected)
    context = ProjectContext("work", tmp_path, (), (), (), "rules", "skills")
    prompt = "Use Mona tools" if work_mode else None
    start = SessionStart(session, context, work_prompt=prompt)
    binding = Binding(session_id=session.id, executor=selected, native_session_id="sdk-test", working_directory=str(tmp_path))
    host = SDKExecutor(SDKProfile(selected, Path(sys.executable), tmp_path / "home", tmp_path, {}))
    worker, delivered = Worker(), []
    worker.start = {"nativeSessionId": binding.native_session_id, "workPrompt": prompt}
    worker.projector = SDKEventProjector(binding.native_session_id, work_tool=work_mode)
    async def query(content, **_):
        delivered.extend([block async for block in content])
    worker.client = SimpleNamespace(query=query)
    worker.owner = asyncio.create_task(asyncio.Event().wait())
    class Connection:
        closed = False
        async def request(self, method, params):
            return await worker.handle(method, params)
    host._sessions[binding.id] = _SDKSession(binding=binding, start=start, connection=Connection())
    content = [{"type": "text", "text": "history " * 30_000}]
    try:
        if work_mode:
            receipt = await host.send(binding, "input-test", content)
            assert receipt.outcome == "accepted"
            assert delivered[0]["message"]["content"] == content
        else:
            with pytest.raises(DevelopmentError) as error:
                await host.send(binding, "input-test", content)
            assert error.value.code == "input_text_too_large"
            with pytest.raises(DevelopmentError):
                await worker.handle("send", {"inputId": "input-test", "text": content})
            assert delivered == []
    finally:
        worker.owner.cancel()
        await asyncio.gather(worker.owner, return_exceptions=True)


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


class _NativeWorkImageHost:
    def __init__(self, state, executor, tool_handler):
        from mona.development.executors.base import NativeEvent

        self.state = state
        self.executor = executor
        self.tool_handler = tool_handler
        self.index = len(state["hosts"])
        self.state["hosts"].append(self)
        self.events_queue = asyncio.Queue()
        self.binding = None
        self.sent = []
        self.tool_results = []
        self.cancelled_tools = []
        self.driver = None
        self.shutdown_complete = False
        self._native_event = NativeEvent

    async def create_session(self, start):
        from mona.development.contracts import Binding

        previous = self.state["hosts"][:self.index]
        assert all(host.shutdown_complete for host in previous)
        self.state["work_prompts"].append(start.work_prompt.encode("utf-8"))
        self.binding = Binding(
            session_id=start.session.id,
            executor=self.executor,
            native_session_id=f"native-work-{self.index}",
            working_directory=start.session.project_id,
        )
        return self.binding

    async def send(self, binding, input_id, message):
        from mona.development.executors.base import DispatchReceipt

        assert binding == self.binding
        self.sent.append(copy.deepcopy(message))
        if self.state.get("hold"):
            return DispatchReceipt(input_id=input_id, outcome="accepted")
        if self.index == 2:
            await self.events_queue.put(self._native_event(
                type="agent.message.completed", payload={"itemId": "answer", "text": "done"}))
            await self.events_queue.put(self._native_event(type="run.completed"))
        else:
            usage = {0: (10, 1, 700), 1: (3, 1, None)}[self.index]
            payload = {"usage": {"inputTokens": usage[0], "outputTokens": usage[1]},
                       "contextWindow": 1000}
            if usage[2] is not None:
                payload["contextTokens"] = usage[2]
            await self.events_queue.put(self._native_event(type="usage.updated", payload=payload))
            self.driver = asyncio.create_task(self._run_tools())
        return DispatchReceipt(input_id=input_id, outcome="accepted", native_turn_id=f"turn-{self.index}")

    async def _call_tool(self, tool, arguments):
        try:
            result = await self.tool_handler(
                self.binding, f"turn-{self.index}", {"tool": tool, "arguments": arguments})
        except asyncio.CancelledError:
            self.cancelled_tools.append(tool)
            raise
        self.tool_results.append((tool, result))
        if any(block.get("type") == "image" for block in result.get("content", [])):
            self.state["mcp_image_results"].append((self.index, tool))

    async def _run_tools(self):
        append_args = {"content": "appended once"}
        read_args = {"path": str(self.state["image_path"]), "force": True}
        try:
            if self.state.get("manual_tool") and self.index == 0:
                await self._call_tool("read_file", read_args)
            elif self.index == 0:
                await self._call_tool("append_file", append_args)
                await self._call_tool("read_file", read_args)
                if self.executor != self.state["codebuddy"]:
                    await self._call_tool("read_file", read_args)
            elif self.index == 1:
                await self._call_tool("read_file", read_args)
            await self.events_queue.put(self._native_event(
                type="agent.message.completed", payload={"itemId": "answer", "text": "done"}))
            await self.events_queue.put(self._native_event(type="run.completed"))
        except asyncio.CancelledError:
            return

    async def interrupt(self, binding, *, native_turn_id=None):
        from mona.development.executors.base import InterruptReceipt

        assert binding == self.binding
        tokens = {0: (12, 2, 700), 1: (5, 2, 600)}[self.index]
        payload = {"usage": {"inputTokens": tokens[0], "outputTokens": tokens[1]},
                   "contextTokens": tokens[2]}
        await self.events_queue.put(self._native_event(type="usage.updated", payload=payload))
        await self.events_queue.put(self._native_event(type="run.interrupted"))
        return InterruptReceipt(outcome="confirmed")

    async def shutdown(self):
        if self.driver is not None:
            await asyncio.gather(self.driver, return_exceptions=True)
        self.state["shutdown_attempts"].append(self.index)
        if self.state.get("fail_shutdown") and self.index == 0:
            raise RuntimeError("fixture shutdown failed")
        self.shutdown_complete = True
        self.state["shutdown_order"].append(self.index)

    async def close_runtime(self, binding, *, force=False):
        return None

    async def get_status(self, binding):
        return "idle"

    async def events(self, binding):
        assert binding == self.binding
        while True:
            event = await self.events_queue.get()
            if event is None:
                return
            yield event


def _install_native_work_image_hosts(monkeypatch, tmp_path, executor, *, hold=False, fail_shutdown=False):
    from types import SimpleNamespace

    from mona.development.contracts import ExecutorId

    selected = ExecutorId(executor)
    codebuddy = ExecutorId.CODEBUDDY
    root = tmp_path / "work"
    root.mkdir(exist_ok=True)
    state = {"hosts": [], "work_prompts": [], "mcp_image_results": [], "shutdown_order": [],
             "shutdown_attempts": [],
             "image_path": root / "photo.png", "codebuddy": codebuddy,
             "hold": hold, "fail_shutdown": fail_shutdown, "manual_tool": False}
    state["image_path"].write_bytes(b"\x89PNG\r\n\x1a\n")
    config = Config()
    config.agents.defaults.executor = executor
    config.agents.defaults.native_model = "native-fixture"
    config.development.enabled_engines = [executor]
    config.development.codex_path = str(tmp_path / "native-engine")
    executable = str(tmp_path / "native-engine")
    discovery = SimpleNamespace(executor=selected, state="detected", executable=executable)
    monkeypatch.setattr("mona.providers.native_work_provider.discover_executors", lambda _config: [discovery])
    catalog = tmp_path / "catalog.json"
    catalog.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        "mona.providers.native_work_provider.prepare_codex_work_profile",
        lambda *_args: (object(), catalog),
    )
    monkeypatch.setattr(
        "mona.providers.native_work_provider.prepare_sdk_profile",
        lambda *_args, **_kwargs: object(),
    )

    def factory(profile, *, tool_handler):
        return _NativeWorkImageHost(state, selected, tool_handler)

    monkeypatch.setattr("mona.providers.native_work_provider.CodexExecutor", factory)
    monkeypatch.setattr("mona.providers.native_work_provider.SDKExecutor", factory)
    return config, state


@pytest.mark.asyncio
@pytest.mark.parametrize("executor", ["codebuddy", "claude", "codex"])
async def test_native_work_image_history_rebuilds_only_codebuddy_and_carries_usage_once(
    tmp_path, monkeypatch, executor,
):
    from mona.agent.tools.base import Tool
    from mona.agent.tools.filesystem import ReadFileTool
    config, state = _install_native_work_image_hosts(monkeypatch, tmp_path, executor)
    root = tmp_path / "work"

    class AppendFileTool(Tool):
        def __init__(self, path):
            self.path = path
            self.calls = 0

        @property
        def name(self):
            return "append_file"

        @property
        def description(self):
            return "Append one line to the test file."

        @property
        def parameters(self):
            return {"type": "object", "properties": {"content": {"type": "string"}},
                    "required": ["content"]}

        async def execute(self, *, content):
            self.calls += 1
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(content + "\n")
            return "appended"

    append_path = root / "append.txt"
    append_tool = AppendFileTool(append_path)
    tools = ToolRegistry()
    tools.register(append_tool)
    tools.register(ReadFileTool(workspace=root, allowed_dir=root))
    provider = NativeWorkProvider(config, root)
    history = [{"role": "system", "content": "stable Work instructions"},
               {"role": "user", "content": "Inspect photo and append once"}]
    async with asyncio.timeout(10):
        result = await AgentRunner(provider).run(AgentRunSpec(
            history, tools, "native-fixture", 8, 16000, workspace=root,
            context_window_tokens=1000, context_window_verified=True,
        ))

    expected_rebuilds = 2 if executor == "codebuddy" else 0
    assert result.stop_reason == "completed"
    assert append_tool.calls == 1 and append_path.read_text(encoding="utf-8") == "appended once\n"
    assert len(state["hosts"]) == expected_rebuilds + 1
    assert state["shutdown_order"] == list(range(expected_rebuilds + 1))
    assert len(set(state["work_prompts"])) == 1
    assert all("Inspect photo and append once" in json.dumps(host.sent[0]) for host in state["hosts"])
    image_counts = [sum(block.get("type") == "image_url" for block in message)
                    for host in state["hosts"] for message in host.sent]
    if executor == "codebuddy":
        assert image_counts == [0, 1, 2]
        assert state["mcp_image_results"] == []
        assert state["hosts"][0].cancelled_tools == ["read_file"]
        assert state["hosts"][1].cancelled_tools == ["read_file"]
        assert result.usage == {"prompt_tokens": 17, "completion_tokens": 4, "total_tokens": 21}
        assert result.final_usage["context_window_tokens"] == 1000
        assert "context_tokens" not in result.final_usage
    else:
        assert image_counts == [0]
        assert len(state["mcp_image_results"]) == 2
        assert state["hosts"][0].cancelled_tools == []


@pytest.mark.asyncio
async def test_native_work_context_rebuild_requires_completed_tool_boundary(tmp_path, monkeypatch):
    config, state = _install_native_work_image_hosts(monkeypatch, tmp_path, "codebuddy", hold=True)
    root = tmp_path / "work"
    provider = NativeWorkProvider(config, root)
    messages = [{"role": "system", "content": "stable Work instructions"},
                {"role": "user", "content": "original goal"}]
    await provider._start(messages, [], "native-fixture", None)
    changed = [messages[0], {"role": "user", "content": "changed projection"}]
    result = await provider.chat_stream(changed, model="native-fixture")
    assert result.error_code == "native_turn_incomplete"
    assert len(state["hosts"]) == 1 and len(state["hosts"][0].sent) == 1
    await provider.aclose()


@pytest.mark.asyncio
async def test_native_work_rebuild_includes_new_user_image_at_completed_tool_boundary(tmp_path, monkeypatch):
    from mona.agent.tools.filesystem import ReadFileTool

    config, state = _install_native_work_image_hosts(monkeypatch, tmp_path, "codebuddy")
    state["manual_tool"] = True
    root = tmp_path / "work"
    tools = ToolRegistry()
    tools.register(ReadFileTool(workspace=root, allowed_dir=root))
    provider = NativeWorkProvider(config, root)
    initial = [{"role": "system", "content": "stable Work instructions"},
               {"role": "user", "content": "original goal"}]
    definitions = tools.get_definitions()
    await provider._start(initial, definitions, "native-fixture", None)
    first = await provider._chat(initial, definitions, "native-fixture", None)
    call = first.tool_calls[0]
    image_result = await tools.execute(call.name, call.arguments)
    new_user_image = next(block for block in image_result if block.get("type") == "image_url")
    messages = [*initial,
        {"role": "assistant", "tool_calls": [{"id": call.id, "function": {
            "name": call.name, "arguments": json.dumps(call.arguments)}}]},
        {"role": "tool", "tool_call_id": call.id, "content": image_result},
        {"role": "user", "content": [{"type": "text", "text": "also inspect this image"},
            new_user_image]},
    ]
    async with asyncio.timeout(5):
        await provider.chat_stream(messages, tools=definitions, model="native-fixture")
    assert len(state["hosts"]) == 2
    assert state["shutdown_order"] == [0]
    rebuilt = state["hosts"][1].sent[0]
    assert sum(block.get("type") == "image_url" for block in rebuilt) == 2
    assert "original goal" in json.dumps(rebuilt)
    await provider.aclose()


@pytest.mark.asyncio
async def test_native_work_shutdown_failure_does_not_dispatch_rebuilt_context(tmp_path, monkeypatch):
    from mona.agent.tools.filesystem import ReadFileTool

    config, state = _install_native_work_image_hosts(
        monkeypatch, tmp_path, "codebuddy", fail_shutdown=True)
    state["manual_tool"] = True
    root = tmp_path / "work"
    tools = ToolRegistry()
    tools.register(ReadFileTool(workspace=root, allowed_dir=root))
    provider = NativeWorkProvider(config, root)
    initial = [{"role": "system", "content": "stable Work instructions"},
               {"role": "user", "content": "Inspect photo"}]
    definitions = tools.get_definitions()
    await provider._start(initial, definitions, "native-fixture", None)
    first = await provider._chat(initial, definitions, "native-fixture", None)
    call = first.tool_calls[0]
    image_result = await tools.execute(call.name, call.arguments)
    messages = [*initial,
        {"role": "assistant", "tool_calls": [{"id": call.id, "function": {
            "name": call.name, "arguments": json.dumps(call.arguments)}}]},
        {"role": "tool", "tool_call_id": call.id, "content": image_result},
    ]
    await provider.chat_stream(messages, tools=definitions, model="native-fixture")
    second = await provider.chat_stream(messages, tools=definitions, model="native-fixture")
    assert len(state["hosts"]) == 1
    assert len(state["hosts"][0].sent) == 1
    assert state["shutdown_order"] == []
    assert second.error_code == "native_turn_incomplete"
    with pytest.raises(RuntimeError, match="fixture shutdown failed"):
        await provider.aclose()
