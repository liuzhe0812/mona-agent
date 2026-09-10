from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry
from mona.config.schema import AgentDefaults
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest

_MAX_TOOL_RESULT_CHARS = AgentDefaults().max_tool_result_chars


class _ScriptedTool(Tool):
    def __init__(self, name: str, handler, *, read_only: bool = True) -> None:
        self._name = name
        self._handler = handler
        self._read_only = read_only

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return "test tool with a real registry execution"

    @property
    def parameters(self) -> dict[str, object]:
        return {"type": "object", "properties": {}}

    @property
    def read_only(self) -> bool:
        return self._read_only

    async def execute(self, **_kwargs):
        return await self._handler()


@pytest.mark.asyncio
async def test_warns_then_blocks_only_the_unchanged_tool_path():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls <= 6:
            return LLMResponse(
                content="working",
                tool_calls=[ToolCallRequest(
                    id=f"call-{model_calls}",
                    name="list_dir",
                    arguments={"path": "."},
                )],
            )
        return LLMResponse(content="Best answer from existing results.")

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="unchanged")

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        repeat_guard_enabled=True,
    ))

    assert result.stop_reason == "completed"
    assert provider.chat_with_retry.await_count == 7
    assert tools.execute.await_count == 5
    tool_messages = {
        message["tool_call_id"]: message["content"]
        for message in result.messages
        if message.get("role") == "tool"
    }
    assert "Harness notice" in tool_messages["call-3"]
    assert sum("Harness notice" in str(content) for content in tool_messages.values()) == 1
    assert "unchanged tool-call path is blocked" in tool_messages["call-5"]
    assert "unchanged tool-call path is blocked" in tool_messages["call-6"]
    step_hash = AgentRunner._tool_step_signature(
        ToolCallRequest(id="ignored", name="list_dir", arguments={"path": "."}),
        "unchanged",
    )
    call_hash = AgentRunner._tool_call_signature(
        ToolCallRequest(id="ignored", name="list_dir", arguments={"path": "."})
    )
    assert step_hash not in str(result.messages)
    assert call_hash not in str(result.messages)


@pytest.mark.parametrize(
    ("name", "arguments"),
    [
        ("write_stdin", {"session_id": "active", "chars": ""}),
        ("stock_research_status", {}),
        ("academic_search", {"cursor": "next"}),
        ("read_file", {"pages": "2-4"}),
    ],
)
def test_wait_poll_and_pagination_calls_use_relaxed_thresholds(name, arguments):
    call = ToolCallRequest(id="call", name=name, arguments=arguments)

    assert AgentRunner._tool_repeat_thresholds(call) == (5, 10)


def test_normal_calls_keep_the_minimal_thresholds():
    call = ToolCallRequest(id="call", name="list_dir", arguments={"path": "."})

    assert AgentRunner._tool_repeat_thresholds(call) == (3, 5)
    assert AgentRunSpec(
        initial_messages=[],
        tools=MagicMock(),
        model="test-model",
        max_iterations=1,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    ).repeat_guard_enabled is False


def test_non_retryable_tool_error_opens_circuit_breaker_immediately():
    failure_counts: dict[str, int] = {}
    disabled: set[str] = set()
    call = ToolCallRequest(id="call", name="generate_video", arguments={})
    spec = AgentRunSpec(
        initial_messages=[],
        tools=MagicMock(),
        model="test-model",
        max_iterations=3,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    )

    AgentRunner._update_failure_counts(
        failure_counts,
        disabled,
        [call],
        [
            {
                "name": "generate_video",
                "status": "error",
                "detail": "provider timeout",
                "retryable": "false",
            }
        ],
        spec=spec,
    )

    assert failure_counts["generate_video"] == spec.max_tool_failures
    assert disabled == {"generate_video"}


@pytest.mark.asyncio
async def test_changed_result_resets_the_repeat_count():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls <= 6:
            return LLMResponse(
                content="working",
                tool_calls=[ToolCallRequest(
                    id=f"call-{model_calls}",
                    name="list_dir",
                    arguments={"path": "."},
                )],
            )
        return LLMResponse(content="done")

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(side_effect=["same"] * 3 + ["changed"] * 3)

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        repeat_guard_enabled=True,
    ))

    assert result.stop_reason == "completed"
    assert tools.execute.await_count == 6
    assert not any(
        message.get("role") == "tool"
        and "unchanged tool-call path is blocked" in str(message.get("content"))
        for message in result.messages
    )


@pytest.mark.asyncio
async def test_changed_arguments_reset_the_repeat_count():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls <= 6:
            path = "." if model_calls <= 3 else "./src"
            return LLMResponse(
                content="working",
                tool_calls=[ToolCallRequest(
                    id=f"call-{model_calls}",
                    name="list_dir",
                    arguments={"path": path},
                )],
            )
        return LLMResponse(content="done")

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="unchanged")

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        repeat_guard_enabled=True,
    ))

    assert tools.execute.await_count == 6
    assert not any(
        message.get("role") == "tool"
        and "unchanged tool-call path is blocked" in str(message.get("content"))
        for message in result.messages
    )


@pytest.mark.asyncio
async def test_user_injection_resets_the_repeat_count():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0
    injected = False

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls <= 6:
            return LLMResponse(
                content="working",
                tool_calls=[ToolCallRequest(
                    id=f"call-{model_calls}",
                    name="list_dir",
                    arguments={"path": "."},
                )],
            )
        return LLMResponse(content="done")

    async def injection_callback():
        nonlocal injected
        if not injected and tools.execute.await_count == 3:
            injected = True
            return [{"role": "user", "content": "Continue with the new instruction."}]
        return []

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="unchanged")

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        injection_callback=injection_callback,
        repeat_guard_enabled=True,
    ))

    assert result.had_injections is True
    assert tools.execute.await_count == 6


@pytest.mark.asyncio
async def test_user_injection_after_final_response_resets_the_repeat_count():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0
    injected = False

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls in {5, 10}:
            return LLMResponse(content=f"answer-{model_calls}")
        return LLMResponse(
            content="working",
            tool_calls=[ToolCallRequest(
                id=f"call-{model_calls}",
                name="list_dir",
                arguments={"path": "."},
            )],
        )

    async def injection_callback():
        nonlocal injected
        if not injected and model_calls == 5:
            injected = True
            return [{"role": "user", "content": "Continue after this answer."}]
        return []

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="unchanged")

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=12,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        injection_callback=injection_callback,
        repeat_guard_enabled=True,
    ))

    assert result.final_content == "answer-10"
    assert result.had_injections is True
    assert tools.execute.await_count == 8


@pytest.mark.asyncio
async def test_distinct_web_lookups_are_not_capped():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls > 12:
            return LLMResponse(content="Best answer from collected sources.")
        return LLMResponse(
            content="searching",
            tool_calls=[ToolCallRequest(
                id=f"search-{model_calls}",
                name="web_search",
                arguments={"query": f"different query {model_calls}"},
            )],
        )

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="new result")

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=20,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        repeat_guard_enabled=True,
    ))

    assert result.stop_reason == "completed"
    assert tools.execute.await_count == 12


@pytest.mark.asyncio
async def test_polling_tools_have_a_larger_repeat_budget():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls <= 6:
            return LLMResponse(
                content="waiting",
                tool_calls=[ToolCallRequest(
                    id=f"poll-{model_calls}",
                    name="terminal_output",
                    arguments={"session_id": "active"},
                )],
            )
        return LLMResponse(content="done")

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="still running")

    await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        repeat_guard_enabled=True,
    ))

    assert tools.execute.await_count == 6


@pytest.mark.asyncio
async def test_paginated_tools_have_a_larger_repeat_budget():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls <= 6:
            return LLMResponse(
                content="reading page",
                tool_calls=[ToolCallRequest(
                    id=f"page-{model_calls}",
                    name="grep",
                    arguments={"pattern": "needle", "offset": 100},
                )],
            )
        return LLMResponse(content="done")

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="same page")

    await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        repeat_guard_enabled=True,
    ))

    assert tools.execute.await_count == 6


@pytest.mark.asyncio
async def test_repeat_guard_can_be_disabled_for_workflow_steps():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        if model_calls <= 6:
            return LLMResponse(
                content="working",
                tool_calls=[ToolCallRequest(
                    id=f"call-{model_calls}",
                    name="list_dir",
                    arguments={"path": "."},
                )],
            )
        return LLMResponse(content="done")

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = MagicMock()
    tools.get_definitions.return_value = []
    tools.execute = AsyncMock(return_value="unchanged")

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        repeat_guard_enabled=False,
    ))

    assert tools.execute.await_count == 6
    assert not any(
        message.get("role") == "tool" and "Harness notice" in str(message.get("content"))
        for message in result.messages
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("concurrent_tools", [False, True])
async def test_checkpoint_keeps_completed_tool_when_later_tool_is_cancelled(
    concurrent_tools: bool,
) -> None:
    first_finished = asyncio.Event()
    second_started = asyncio.Event()
    release_second = asyncio.Event()
    checkpoints: list[dict[str, object]] = []

    async def first() -> str:
        first_finished.set()
        return "first result"

    async def second() -> str:
        second_started.set()
        await release_second.wait()
        return "second result"

    registry = ToolRegistry()
    registry.register(_ScriptedTool("first", first))
    registry.register(_ScriptedTool("second", second))

    provider = MagicMock(spec=LLMProvider)
    provider.chat_with_retry = AsyncMock(
        return_value=LLMResponse(
            content="working",
            tool_calls=[
                ToolCallRequest(id="call-first", name="first", arguments={}),
                ToolCallRequest(id="call-second", name="second", arguments={}),
            ],
        )
    )

    async def checkpoint(payload: dict[str, object]) -> None:
        checkpoints.append(payload)

    task = asyncio.create_task(
        AgentRunner(provider).run(
            AgentRunSpec(
                initial_messages=[],
                tools=registry,
                model="test-model",
                max_iterations=2,
                max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
                concurrent_tools=concurrent_tools,
                checkpoint_callback=checkpoint,
            )
        )
    )
    await asyncio.wait_for(first_finished.wait(), timeout=1.0)
    await asyncio.wait_for(second_started.wait(), timeout=1.0)

    async def has_partial_checkpoint() -> bool:
        return any(item.get("phase") == "tools_partial" for item in checkpoints)

    for _ in range(100):
        if await has_partial_checkpoint():
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("the completed first tool did not produce a partial checkpoint")

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    partial = [item for item in checkpoints if item.get("phase") == "tools_partial"][-1]
    completed = partial["completed_tool_results"]
    pending = partial["pending_tool_calls"]
    assert [item["tool_call_id"] for item in completed] == ["call-first"]
    assert completed[0]["content"] == "first result"
    assert [item["id"] for item in pending] == ["call-second"]


@pytest.mark.asyncio
async def test_structured_json_failure_is_error_but_version_conflict_is_recoverable() -> None:
    def make_registry(receipt: dict[str, object]) -> ToolRegistry:
        async def execute_receipt() -> dict[str, object]:
            return receipt

        registry = ToolRegistry()
        registry.register(_ScriptedTool("office", execute_receipt, read_only=False))
        return registry

    async def run_once(receipt: dict[str, object]):
        provider = MagicMock(spec=LLMProvider)
        provider.chat_with_retry = AsyncMock(
            side_effect=[
                LLMResponse(
                    content="apply",
                    tool_calls=[
                        ToolCallRequest(
                            id="office-call",
                            name="office",
                            arguments={"action": "apply", "session_id": "office-1"},
                        )
                    ],
                ),
                LLMResponse(content="recovered"),
            ]
        )
        return await AgentRunner(provider).run(
            AgentRunSpec(
                initial_messages=[],
                tools=make_registry(receipt),
                model="test-model",
                max_iterations=3,
                max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
                fail_on_tool_error=True,
            )
        )

    failure = await run_once(
        {
            "ok": False,
            "error": {"code": "INVALID_OPERATION", "message": "bad field"},
        }
    )
    assert failure.stop_reason == "tool_error"
    assert failure.error and "bad field" in failure.error
    assert failure.tool_events[-1]["status"] == "error"

    conflict = await run_once(
        {
            "ok": False,
            "error": {"code": "VERSION_CONFLICT", "message": "stale version"},
        }
    )
    assert conflict.stop_reason == "completed"
    assert conflict.final_content == "recovered"
    assert conflict.error is None
    assert conflict.tool_events[-1]["status"] == "conflict"
