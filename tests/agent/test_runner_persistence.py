"""Tests for tool result persistence: large results, pruning, temp files, cleanup."""

from __future__ import annotations

import os
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mona.config.schema import AgentDefaults
from mona.providers.base import LLMResponse, ToolCallRequest

_MAX_TOOL_RESULT_CHARS = AgentDefaults().max_tool_result_chars


@pytest.mark.asyncio
async def test_runner_publishes_request_stats_without_changing_billing_usage():
    from mona.agent.runner import AgentRunner, AgentRunSpec

    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(side_effect=[
        LLMResponse(
            content="working",
            tool_calls=[ToolCallRequest(id="call_1", name="read_file", arguments={})],
            usage={"prompt_tokens": 100, "completion_tokens": 10, "reported_cache_read_tokens": 0},
        ),
        LLMResponse(content="done", usage={"completion_tokens": 20, "reasoning_tokens": 4}),
    ])
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="result")
    events = []

    async def on_progress(_content: str, *, token_usage=None):
        if token_usage:
            events.append(token_usage)

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[{"role": "user", "content": "work"}],
        tools=tools,
        model="test-model",
        max_iterations=3,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        progress_callback=on_progress,
    ))

    assert len(events) == 2
    first, second = (event["request_stats"] for event in events)
    assert first == {
        "index": 0,
        "elapsed_ms": first["elapsed_ms"],
        "output_tokens": 10,
        "input_tokens": 100,
        "cache_read_tokens": 0,
    }
    assert second == {
        "index": 1,
        "elapsed_ms": second["elapsed_ms"],
        "output_tokens": 20,
        "reasoning_tokens": 4,
    }
    assert first["elapsed_ms"] >= 1 and second["elapsed_ms"] >= 1
    assert "context_tokens" not in events[1]
    assert "request_stats" not in result.usage
    assert "request_stats" not in result.final_usage
    assert result.usage["completion_tokens"] == 30
    assert result.usage["cached_tokens"] == 0


def test_runner_request_stats_ignore_failed_or_unreported_usage():
    from mona.agent.hook import AgentHookContext
    from mona.agent.runner import AgentRunner

    context = AgentHookContext(iteration=0, messages=[], request_elapsed_ms=500)
    assert AgentRunner._request_stats(LLMResponse(content="failed", finish_reason="error", usage={"completion_tokens": 10}), context) is None
    assert AgentRunner._request_stats(LLMResponse(content="failed", error_code="insufficient_credits", usage={"completion_tokens": 10}), context) is None
    assert AgentRunner._request_stats(LLMResponse(content="unknown", usage={"prompt_tokens": 20}), context) is None
    assert AgentRunner._request_stats(LLMResponse(content="unknown", usage={"completion_tokens": 0}), context) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code", [(402, None), (None, "insufficient_credits")])
async def test_balance_error_preserves_queued_inputs_without_another_model_call(status, code):
    from mona.agent.runner import AgentRunner, AgentRunSpec

    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(return_value=LLMResponse(
        content="balance exhausted", finish_reason="error",
        error_status_code=status, error_code=code,
    ))
    tools = MagicMock()
    tools.get_definitions.return_value = []
    queued = [{"role": "user", "content": f"follow-up {i}"} for i in range(5)]

    async def drain(*, limit, phase):
        assert phase == "balance exhausted"
        items = queued[:limit]
        del queued[:limit]
        return items

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[{"role": "user", "content": "long task"}],
        tools=tools, model="managed-model", max_iterations=10,
        injection_callback=drain, max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    ))

    assert provider.chat_with_retry.await_count == 1
    assert result.stop_reason == "error"
    assert "余额不足" in result.final_content
    assert result.had_injections and not queued
    history = str(result.messages)
    assert all(f"follow-up {i}" in history for i in range(5))
    tools.execute.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("media_tool", ["generate_image", "generate_video"])
@pytest.mark.parametrize("code,expected", [("INSUFFICIENT_CREDITS", "余额不足"), ("MEDIA_RESULT_UNKNOWN", "结果暂时无法确认")])
async def test_media_terminal_error_preserves_results_and_skips_unstarted_tools(tmp_path, media_tool, code, expected):
    import json
    from types import SimpleNamespace

    from mona.agent.runner import AgentRunner, AgentRunSpec

    artifact = tmp_path / "completed.txt"
    artifact.write_text("completed result", encoding="utf-8")
    unwanted_write = tmp_path / "must-not-be-created.txt"
    calls = [ToolCallRequest(id=str(i), name=name, arguments={})
             for i, name in enumerate(["read_file", media_tool, "write_file"])]
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(return_value=LLMResponse(
        content="", finish_reason="tool_calls", tool_calls=calls,
    ))
    executed = []
    checkpoints = []
    queued = [{"role": "user", "content": "queued instruction"}]

    async def execute(name, _params):
        executed.append(name)
        if name == "read_file":
            return artifact.read_text(encoding="utf-8")
        if name == media_tool:
            return json.dumps({"ok": False, "code": code,
                               "message": expected, "retryable": False,
                               "artifacts": [{"path": str(artifact)}]})
        unwanted_write.write_text("unexpected", encoding="utf-8")
        return "written"

    async def checkpoint(payload):
        checkpoints.append(payload)

    async def drain(*, limit, phase):
        expected_phase = "balance exhausted" if code == "INSUFFICIENT_CREDITS" else "media result unknown"
        if phase != expected_phase:
            return []
        items = queued[:limit]
        del queued[:limit]
        return items

    tools = SimpleNamespace(get_definitions=lambda: [], get=lambda _name: None, execute=execute)
    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[{"role": "user", "content": "make media then write"}],
        tools=tools, model="managed-model", max_iterations=10,
        checkpoint_callback=checkpoint, injection_callback=drain, max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    ))

    assert executed == ["read_file", media_tool]
    assert not unwanted_write.exists()
    assert artifact.read_text(encoding="utf-8") == "completed result"
    assert provider.chat_with_retry.await_count == 1
    assert result.stop_reason == "error" and expected in result.final_content
    assert result.had_injections and not queued
    assert any(message.get("content") == "queued instruction" for message in result.messages)
    assert result.tools_used == ["read_file", media_tool]
    receipts = [message for message in result.messages if message.get("role") == "tool"]
    assert len(receipts) == 3
    assert "completed result" in receipts[0]["content"]
    assert str(artifact) in json.loads(receipts[1]["content"])["artifacts"][0]["path"]
    assert "未执行" in receipts[2]["content"]
    assert result.tool_events[-1]["status"] == "skipped"
    assert checkpoints[-1]["pending_tool_calls"] == []
    assert "2" not in checkpoints[-1]["started_tool_call_ids"]


@pytest.mark.asyncio
async def test_unknown_media_result_waits_for_started_tools_and_skips_queued_write(tmp_path):
    import asyncio
    import json
    from types import SimpleNamespace

    from mona.agent.runner import AgentRunner, AgentRunSpec

    started = asyncio.Event()
    release = asyncio.Event()
    executed = []
    calls = [ToolCallRequest(id=str(i), name=name, arguments={})
             for i, name in enumerate(["read_file", "generate_image", "write_file"])]
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(return_value=LLMResponse(
        content="", finish_reason="tool_calls", tool_calls=calls,
    ))

    async def execute(name, _params):
        executed.append(name)
        if name == "read_file":
            started.set()
            await release.wait()
            return "completed read"
        if name == "generate_image":
            await started.wait()
            release.set()
            return json.dumps({"ok": False, "code": "MEDIA_RESULT_UNKNOWN", "retryable": False})
        (tmp_path / "unexpected").write_text("unexpected", encoding="utf-8")
        return "written"

    tools = SimpleNamespace(get_definitions=lambda: [], get=lambda _name: SimpleNamespace(concurrency_safe=True), execute=execute)
    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[{"role": "user", "content": "generate"}], tools=tools,
        model="managed-model", max_iterations=10, concurrent_tools=True,
        max_parallel_tool_calls=2, max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    ))

    assert set(executed) == {"read_file", "generate_image"}
    assert not (tmp_path / "unexpected").exists()
    assert result.stop_reason == "error" and "结果暂时无法确认" in result.final_content
    assert "completed read" in str(result.messages)
    assert result.tool_events[-1]["status"] == "skipped"
    assert provider.chat_with_retry.await_count == 1


@pytest.mark.asyncio
async def test_runner_keeps_old_tool_results_when_context_has_room(monkeypatch):
    from mona.agent.runner import AgentRunner, AgentRunSpec

    provider = MagicMock()
    captured = []

    async def chat_with_retry(*, messages, **kwargs):
        captured.extend(message for message in messages if message.get("role") == "tool")
        return LLMResponse(content="done")

    provider.chat_with_retry = chat_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []
    messages = [{"role": "system", "content": "system"}, {"role": "user", "content": "inspect files"}]
    expected = []
    for index in range(12):
        call_id = f"call-{index}"
        output = f"file-{index}:" + str(index) * 600
        expected.append(output)
        messages.extend([
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": call_id, "type": "function", "function": {"name": "read_file", "arguments": "{}"}}],
            },
            {"role": "tool", "tool_call_id": call_id, "name": "read_file", "content": output},
        ])
    monkeypatch.setattr("mona.agent.runner.estimate_prompt_tokens_chain", lambda *_args, **_kwargs: (100, "test"))

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=messages,
        tools=tools,
        model="test-model",
        max_iterations=1,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        context_window_tokens=100_000,
    ))

    assert result.final_content == "done"
    assert [message["content"] for message in captured] == expected


@pytest.mark.asyncio
async def test_runner_preserves_current_tool_turn_when_it_exceeds_context(monkeypatch):
    from mona.agent.runner import AgentRunner, AgentRunSpec

    provider = MagicMock()
    provider.chat_with_retry = AsyncMock()
    tools = MagicMock()
    tools.get_definitions.return_value = []
    messages = [{"role": "system", "content": "system"}, {"role": "user", "content": "finish this task"}]
    expected_results = []
    for index in range(20):
        call_id = f"call-{index}"
        output = f"tool-result-{index}:" + str(index) * 500
        expected_results.append(output)
        messages.extend([
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": call_id, "type": "function", "function": {"name": "read_file", "arguments": "{}"}}],
            },
            {"role": "tool", "tool_call_id": call_id, "name": "read_file", "content": output},
        ])
    monkeypatch.setattr("mona.agent.runner.estimate_prompt_tokens_chain", lambda *_args, **_kwargs: (10_000, "test"))
    monkeypatch.setattr(
        "mona.agent.runner.estimate_message_tokens",
        lambda message: 500 if message.get("role") == "tool" else 10,
    )

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=messages,
        tools=tools,
        model="test-model",
        max_iterations=1,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        context_window_tokens=10_000,
        context_block_limit=3_000,
    ))

    provider.chat_with_retry.assert_not_awaited()
    assert result.stop_reason == "context_limit"
    assert "超出模型可用上下文" in result.final_content
    assert result.messages[1]["content"] == "finish this task"
    assert [message["content"] for message in result.messages if message.get("role") == "tool"] == expected_results


@pytest.mark.asyncio
async def test_snipped_prefix_stays_fixed_until_pressure_returns(monkeypatch):
    from mona.agent.runner import AgentRunner, AgentRunSpec
    from mona.agent.tools.base import Tool
    from mona.agent.tools.registry import ToolRegistry

    class SmallTool(Tool):
        @property
        def name(self):
            return "small"

        @property
        def description(self):
            return "Return one small result."

        @property
        def parameters(self):
            return {"type": "object", "properties": {}}

        async def execute(self, **kwargs):
            return "small result"

    tools = ToolRegistry()
    tools.register(SmallTool())
    provider = MagicMock()
    captured = []

    async def chat_with_retry(*, messages, **kwargs):
        captured.append(list(messages))
        if len(captured) == 1:
            return LLMResponse(
                content=None,
                tool_calls=[ToolCallRequest(id="new-call", name="small", arguments={})],
            )
        return LLMResponse(content="done")

    provider.chat_with_retry = chat_with_retry
    messages = [{"role": "system", "content": "system"}, {"role": "user", "content": "old task"}]
    for index in range(20):
        call_id = f"call-{index}"
        messages.extend([
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": call_id, "type": "function", "function": {"name": "read_file", "arguments": "{}"}}],
            },
            {"role": "tool", "tool_call_id": call_id, "name": "read_file", "content": str(index) * 500},
        ])
    messages.extend([{"role": "assistant", "content": "old answer"}, {"role": "user", "content": "current task"}])
    monkeypatch.setattr(
        "mona.agent.runner.estimate_prompt_tokens_chain",
        lambda _provider, _model, current, _tools: (
            4_000 if sum(message.get("role") != "system" for message in current) > 25 else 1_000,
            "test",
        ),
    )
    monkeypatch.setattr(
        "mona.agent.runner.estimate_message_tokens",
        lambda message: 500 if message.get("role") == "tool" else 10,
    )

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=messages,
        tools=tools,
        model="test-model",
        max_iterations=2,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        context_window_tokens=10_000,
        context_block_limit=3_000,
    ))

    assert result.final_content == "done"
    assert len(captured) == 2
    assert len(captured[0]) < len(messages)
    assert captured[0][-1] == messages[-1]
    assert captured[1][:len(captured[0])] == captured[0]
    assert captured[1][len(captured[0]):] == [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "new-call",
                "type": "function",
                "function": {"name": "small", "arguments": "{}"},
            }],
        },
        {"role": "tool", "tool_call_id": "new-call", "name": "small", "content": "small result"},
    ]
    assert result.messages[:len(messages)] == messages


@pytest.mark.parametrize("tool_name", ["document", "read_file", "skill_reference_read"])
async def test_runner_delivers_complete_middle_evidence_across_model_turns(tmp_path, tool_name):
    from mona.agent.runner import AgentRunner, AgentRunSpec

    source = '<!-- parsed source -->\n' + '\n'.join(f'{i}| 完整原文和协议字段 rowSpan={i}' for i in range(360))
    provider = MagicMock()
    seen = []

    async def chat_with_retry(*, messages, **kwargs):
        outputs = [message['content'] for message in messages if message.get('role') == 'tool']
        if outputs:
            seen.append(outputs[0])
        if not outputs:
            return LLMResponse(content=None, tool_calls=[ToolCallRequest(id='source', name=tool_name, arguments={})])
        if len(outputs) == 1:
            return LLMResponse(content=None, tool_calls=[ToolCallRequest(id='step', name='inspect', arguments={})])
        return LLMResponse(content='done')

    provider.chat_with_retry = chat_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(side_effect=[source, 'current state'])
    await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[{'role': 'user', 'content': 'Preserve every item in this material'}],
        tools=tools, model='test', max_iterations=3, workspace=tmp_path,
        max_tool_result_chars=16000,
    ))
    assert seen == [source, source]


def test_oversized_result_reference_is_stable_and_full_output_is_retrievable(tmp_path):
    from mona.agent.runner import AgentRunner, AgentRunSpec

    source = '\n'.join(f'{i}| 保留全文 evidence {i}' for i in range(1000))
    runner = AgentRunner(MagicMock())
    spec = AgentRunSpec(initial_messages=[], tools=MagicMock(), model='test', max_iterations=1,
        workspace=tmp_path, session_key='source:test', max_tool_result_chars=1024)
    once = runner._normalize_tool_result(spec, 'read1', 'read_file', source)
    twice = runner._normalize_tool_result(spec, 'read1', 'read_file', once)
    assert twice == once
    assert len(once) <= 1024
    assert '[tool output persisted]' in once
    assert (tmp_path / '.mona/tool-results/source_test/read1.txt').read_text(encoding='utf-8') == source

async def test_runner_persists_large_tool_results_for_follow_up_calls(tmp_path):
    from mona.agent.runner import AgentRunner, AgentRunSpec

    provider = MagicMock()
    captured_second_call: list[dict] = []
    call_count = {"n": 0}

    async def chat_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return LLMResponse(
                content="working",
                tool_calls=[ToolCallRequest(id="call_big", name="list_dir", arguments={"path": "."})],
                usage={"prompt_tokens": 5, "completion_tokens": 3},
            )
        captured_second_call[:] = messages
        return LLMResponse(content="done", tool_calls=[], usage={})

    provider.chat_with_retry = chat_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="x" * 20_000)

    runner = AgentRunner(provider)
    result = await runner.run(AgentRunSpec(
        initial_messages=[{"role": "user", "content": "do task"}],
        tools=tools,
        model="test-model",
        max_iterations=2,
        workspace=tmp_path,
        session_key="test:runner",
        max_tool_result_chars=2048,
    ))

    assert result.final_content == "done"
    tool_message = next(msg for msg in captured_second_call if msg.get("role") == "tool")
    assert "[tool output persisted]" in tool_message["content"]
    assert "tool-results" in tool_message["content"]
    assert (tmp_path / ".mona" / "tool-results" / "test_runner" / "call_big.txt").exists()


@pytest.mark.asyncio
async def test_video_preview_images_set_require_image_on_follow_up_request(tmp_path):
    from mona.agent.runner import AgentRunner, AgentRunSpec

    provider = MagicMock()
    request_kwargs = []

    async def chat_with_retry(**kwargs):
        request_kwargs.append(kwargs)
        if len(request_kwargs) == 1:
            return LLMResponse(content=None, tool_calls=[
                ToolCallRequest(id="call_video", name="video", arguments={}),
            ])
        return LLMResponse(content="preview checked")

    provider.chat_with_retry = chat_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value=[
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,fixture"}},
        {"type": "text", "text": "Three preview frames attached"},
    ])

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[{"role": "user", "content": "Review this preview"}],
        tools=tools,
        model="text-only-model",
        max_iterations=2,
        max_tool_result_chars=4096,
        workspace=tmp_path,
    ))

    assert result.final_content == "preview checked"
    assert request_kwargs[1]["require_image"] is True
    assert any(
        isinstance(block, dict) and block.get("type") == "image_url"
        for message in request_kwargs[1]["messages"]
        if isinstance(message.get("content"), list)
        for block in message["content"]
    )


def test_persist_tool_result_prunes_old_session_buckets(tmp_path):
    from mona.utils.helpers import maybe_persist_tool_result

    root = tmp_path / ".mona" / "tool-results"
    old_bucket = root / "old_session"
    recent_bucket = root / "recent_session"
    old_bucket.mkdir(parents=True)
    recent_bucket.mkdir(parents=True)
    (old_bucket / "old.txt").write_text("old", encoding="utf-8")
    (recent_bucket / "recent.txt").write_text("recent", encoding="utf-8")

    stale = time.time() - (8 * 24 * 60 * 60)
    os.utime(old_bucket, (stale, stale))
    os.utime(old_bucket / "old.txt", (stale, stale))

    persisted = maybe_persist_tool_result(
        tmp_path,
        "current:session",
        "call_big",
        "x" * 5000,
        max_chars=64,
    )

    assert "[tool output persisted]" in persisted
    assert not old_bucket.exists()
    assert recent_bucket.exists()
    assert (root / "current_session" / "call_big.txt").exists()


def test_persist_tool_result_leaves_no_temp_files(tmp_path):
    from mona.utils.helpers import maybe_persist_tool_result

    root = tmp_path / ".mona" / "tool-results"
    maybe_persist_tool_result(
        tmp_path,
        "current:session",
        "call_big",
        "x" * 5000,
        max_chars=64,
    )

    assert (root / "current_session" / "call_big.txt").exists()
    assert list((root / "current_session").glob("*.tmp")) == []


def test_persist_tool_result_logs_cleanup_failures(monkeypatch, tmp_path):
    from mona.utils.helpers import maybe_persist_tool_result

    warnings: list[str] = []

    monkeypatch.setattr(
        "mona.utils.helpers._cleanup_tool_result_buckets",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("busy")),
    )
    monkeypatch.setattr(
        "mona.utils.helpers.logger.exception",
        lambda message, *args: warnings.append(message.format(*args)),
    )

    persisted = maybe_persist_tool_result(
        tmp_path,
        "current:session",
        "call_big",
        "x" * 5000,
        max_chars=64,
    )

    assert "[tool output persisted]" in persisted
    assert warnings and "Failed to clean stale tool result buckets" in warnings[0]
async def test_runner_keeps_going_when_tool_result_persistence_fails():
    from mona.agent.runner import AgentRunner, AgentRunSpec

    provider = MagicMock()
    captured_second_call: list[dict] = []
    call_count = {"n": 0}

    async def chat_with_retry(*, messages, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return LLMResponse(
                content="working",
                tool_calls=[ToolCallRequest(id="call_1", name="list_dir", arguments={"path": "."})],
                usage={"prompt_tokens": 5, "completion_tokens": 3},
            )
        captured_second_call[:] = messages
        return LLMResponse(content="done", tool_calls=[], usage={})

    provider.chat_with_retry = chat_with_retry
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="tool result")

    runner = AgentRunner(provider)
    with patch("mona.agent.runner.maybe_persist_tool_result", side_effect=RuntimeError("disk full")):
        result = await runner.run(AgentRunSpec(
            initial_messages=[{"role": "user", "content": "do task"}],
            tools=tools,
            model="test-model",
            max_iterations=2,
            max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        ))

    assert result.final_content == "done"
    tool_message = next(msg for msg in captured_second_call if msg.get("role") == "tool")
    assert tool_message["content"] == "tool result"
