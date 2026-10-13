from __future__ import annotations

import asyncio
import copy
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
        return {
            "type": "object",
            "properties": {
                "content": {"type": "string"},
                "path": {"type": "string"},
                "sort": {"type": "string"},
                "target": {"type": "string"},
            },
        }

    @property
    def read_only(self) -> bool:
        return self._read_only

    async def execute(self, **_kwargs):
        return await self._handler()


@pytest.mark.asyncio
async def test_warns_then_stops_repeated_tool_calls_before_dispatching_the_sixth():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0
    requests: list[dict[str, object]] = []
    executed: list[str] = []

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        requests.append(kwargs)
        if kwargs.get("tools") is None:
            return LLMResponse(content="I stopped because the repeated action made no progress.")
        arguments = (
            {"path": ".", "sort": "name"}
            if model_calls % 2
            else {"sort": "name", "path": "."}
        )
        return LLMResponse(
            content="working",
            tool_calls=[ToolCallRequest(
                id=f"call-{model_calls}",
                name="repeat",
                arguments=arguments,
            )],
            finish_reason="tool_calls",
        )

    async def repeat_tool():
        executed.append("repeat")
        return "unchanged"

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = ToolRegistry()
    tools.register(_ScriptedTool("repeat", repeat_tool))

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    ))

    assert result.stop_reason == "loop_detected"
    assert result.error and "重复" in result.error
    assert result.final_content and "重复" in result.final_content and "停止" in result.final_content
    assert provider.chat_with_retry.await_count == 6
    assert len(executed) == 5
    assert requests[-1]["tools"] is None
    assert all(request["tools"] is not None for request in requests[:-1])
    tool_messages = [message for message in result.messages if message.get("role") == "tool"]
    assistant_tool_calls = [
        call
        for message in result.messages
        if message.get("role") == "assistant"
        for call in message.get("tool_calls", [])
    ]
    assert len(tool_messages) == 5
    assert len(assistant_tool_calls) == 5
    assert all(call["id"] != "call-6" for call in assistant_tool_calls)
    assert sum("Harness notice" in str(message.get("content")) for message in tool_messages) == 1


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
    ).repeat_guard_enabled is True


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
    assert sum(
        "Harness notice" in str(message.get("content"))
        for message in result.messages
        if message.get("role") == "tool"
    ) == 1


@pytest.mark.asyncio
async def test_each_changed_result_warns_without_stopping_the_tool_path():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0
    requests: list[dict[str, object]] = []
    result_index = 0

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        requests.append(kwargs)
        if kwargs.get("tools") is None:
            return LLMResponse(content="Completed after each inspection changed the result.")
        if model_calls > 6:
            return LLMResponse(content="Completed after each inspection changed the result.")
        return LLMResponse(
            content="checking",
            tool_calls=[ToolCallRequest(
                id=f"call-{model_calls}",
                name="inspect",
                arguments={"target": "active"},
            )],
            finish_reason="tool_calls",
        )

    async def inspect():
        nonlocal result_index
        result_index += 1
        return f"new observation {result_index}"

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = ToolRegistry()
    tools.register(_ScriptedTool("inspect", inspect))

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
    assert result_index == 6
    assert requests[-1]["tools"] is not None
    tool_messages = [message for message in result.messages if message.get("role") == "tool"]
    assert sum("Harness notice" in str(message.get("content")) for message in tool_messages) == 1


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

    assert result.stop_reason == "completed"
    assert tools.execute.await_count == 6


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
async def test_runtime_injection_does_not_reset_the_repeat_count():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0
    injected = False
    executed: list[str] = []
    requests: list[dict[str, object]] = []

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        requests.append(kwargs)
        if kwargs.get("tools") is None:
            return LLMResponse(content="The repeated action was stopped.")
        return LLMResponse(
            content="working",
            tool_calls=[ToolCallRequest(
                id=f"call-{model_calls}",
                name="repeat",
                arguments={"target": "active"},
            )],
            finish_reason="tool_calls",
        )

    async def repeat_tool():
        executed.append("repeat")
        return "unchanged"

    async def injection_callback():
        nonlocal injected
        if not injected and len(executed) == 3:
            injected = True
            return [{
                "role": "user",
                "content": "Runtime state update.",
                "source_kind": "runtime",
            }]
        return []

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = ToolRegistry()
    tools.register(_ScriptedTool("repeat", repeat_tool))

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        injection_callback=injection_callback,
        repeat_guard_enabled=True,
    ))

    assert injected is True
    assert result.had_injections is True
    assert result.stop_reason == "loop_detected"
    assert len(executed) == 5
    assert provider.chat_with_retry.await_count == 6
    assert requests[-1]["tools"] is None


@pytest.mark.asyncio
async def test_model_context_compaction_does_not_reset_the_repeat_guard():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0
    executed: list[str] = []
    compacted_contexts = 0
    requests: list[dict[str, object]] = []
    system_message = {"role": "system", "content": "Stable system instructions."}
    user_message = {"role": "user", "content": "Inspect the active target."}

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        requests.append(kwargs)
        if kwargs.get("tools") is None:
            return LLMResponse(content="The repeated action was stopped.")
        return LLMResponse(
            content="working",
            tool_calls=[ToolCallRequest(
                id=f"call-{model_calls}",
                name="repeat",
                arguments={"target": "active"},
            )],
            finish_reason="tool_calls",
        )

    async def repeat_tool():
        executed.append("repeat")
        return "unchanged"

    async def compact_context(messages, *, force=False):
        nonlocal compacted_contexts
        if len(executed) < 3:
            return messages
        compacted_contexts += 1
        return [
            system_message,
            user_message,
            {"role": "user", "content": "Prior activity summary."},
        ]

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = ToolRegistry()
    tools.register(_ScriptedTool("repeat", repeat_tool))

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[system_message, user_message],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        model_context_callback=compact_context,
        repeat_guard_enabled=True,
    ))

    assert compacted_contexts >= 2
    assert result.had_injections is False
    assert result.stop_reason == "loop_detected"
    assert len(executed) == 5
    assert provider.chat_with_retry.await_count == 6
    assert requests[-1]["tools"] is None


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
async def test_alternating_tool_rounds_are_detected_as_a_repeating_cycle():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0
    requests: list[dict[str, object]] = []
    executed = {"first": 0, "second": 0}

    async def first_tool():
        executed["first"] += 1
        return "first result"

    async def second_tool():
        executed["second"] += 1
        return "second result"

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        requests.append(kwargs)
        if kwargs.get("tools") is None:
            return LLMResponse(content="The alternating cycle was stopped.")
        name = "first" if model_calls % 2 else "second"
        return LLMResponse(
            content="working",
            tool_calls=[ToolCallRequest(
                id=f"call-{model_calls}",
                name=name,
                arguments={"target": name},
            )],
            finish_reason="tool_calls",
        )

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = ToolRegistry()
    tools.register(_ScriptedTool("first", first_tool))
    tools.register(_ScriptedTool("second", second_tool))

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=20,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        repeat_guard_enabled=True,
    ))

    assert result.stop_reason == "loop_detected"
    assert executed == {"first": 5, "second": 5}
    assert provider.chat_with_retry.await_count == 11
    assert requests[-1]["tools"] is None
    assert sum(
        "Harness notice" in str(message.get("content"))
        for message in result.messages
        if message.get("role") == "tool"
    ) == 1


@pytest.mark.asyncio
async def test_repeated_parallel_tool_batch_is_detected_as_one_cycle():
    provider = MagicMock(spec=LLMProvider)
    model_calls = 0
    requests: list[dict[str, object]] = []
    executed = {"first": 0, "second": 0}

    async def first_tool():
        executed["first"] += 1
        return "first result"

    async def second_tool():
        executed["second"] += 1
        return "second result"

    async def chat_with_retry(**kwargs):
        nonlocal model_calls
        model_calls += 1
        requests.append(kwargs)
        if kwargs.get("tools") is None:
            return LLMResponse(content="The repeated parallel batch was stopped.")
        return LLMResponse(
            content="working",
            tool_calls=[
                ToolCallRequest(
                    id=f"first-{model_calls}",
                    name="first",
                    arguments={"target": "first"},
                ),
                ToolCallRequest(
                    id=f"second-{model_calls}",
                    name="second",
                    arguments={"target": "second"},
                ),
            ],
            finish_reason="tool_calls",
        )

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = ToolRegistry()
    tools.register(_ScriptedTool("first", first_tool))
    tools.register(_ScriptedTool("second", second_tool))

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        concurrent_tools=True,
        max_parallel_tool_calls=2,
        repeat_guard_enabled=True,
    ))

    assert result.stop_reason == "loop_detected"
    assert executed == {"first": 5, "second": 5}
    assert provider.chat_with_retry.await_count == 6
    assert requests[-1]["tools"] is None
    assert sum(
        "Harness notice" in str(message.get("content"))
        for message in result.messages
        if message.get("role") == "tool"
    ) == 1


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


@pytest.mark.asyncio
async def test_provider_repeat_error_finalizes_without_replaying_a_write_and_preserves_images():
    system_message = {"role": "system", "content": "Keep system context stable."}
    user_image = {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,user-original"},
    }
    user_message = {
        "role": "user",
        "content": [
            {"type": "text", "text": "Save the report and inspect its preview."},
            user_image,
        ],
    }
    prior_tool_call = {
        "id": "prior-search-1",
        "type": "function",
        "function": {"name": "prior_search", "arguments": "{}"},
    }
    prior_assistant_call = {
        "role": "assistant",
        "content": None,
        "tool_calls": [prior_tool_call],
    }
    prior_tool_result = {
        "role": "tool",
        "tool_call_id": "prior-search-1",
        "name": "prior_search",
        "content": "Prior search result.",
    }
    prior_subtask_result = {"role": "assistant", "content": "The research subtask finished."}
    image_block = {
        "type": "image_url",
        "image_url": {"url": "data:image/png;base64,fixture"},
    }
    tool_result = [
        {"type": "text", "text": "The report was saved and previewed."},
        image_block,
    ]
    provider = MagicMock(spec=LLMProvider)
    requests: list[dict[str, object]] = []
    finalization_snapshot: list[dict[str, object]] | None = None
    write_count = 0

    async def write_once():
        nonlocal write_count
        write_count += 1
        return tool_result

    async def chat_with_retry(**kwargs):
        nonlocal finalization_snapshot
        requests.append(kwargs)
        if kwargs.get("tools") is None:
            finalization_snapshot = copy.deepcopy(kwargs["messages"])
            for message in kwargs["messages"]:
                content = message.get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "image_url":
                        block["image_url"]["url"] = "data:image/png;base64,mutated-by-provider"
                        break
            return LLMResponse(content="The write completed before further work was blocked.")
        if write_count == 0:
            return LLMResponse(
                content="Writing the report.",
                tool_calls=[ToolCallRequest(
                    id="write-1",
                    name="write_once",
                    arguments={"path": "report.txt", "content": "saved"},
                )],
                finish_reason="tool_calls",
            )
        return LLMResponse(
            content="400 InternalError.Algo.InvalidParameter: Repetitive tool calls detected: identical name and arguments",
            finish_reason="error",
        )

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = ToolRegistry()
    tools.register(_ScriptedTool("write_once", write_once, read_only=False))

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[
            system_message,
            user_message,
            prior_assistant_call,
            prior_tool_result,
            prior_subtask_result,
        ],
        tools=tools,
        model="test-model",
        max_iterations=10,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
    ))

    assert result.stop_reason == "loop_detected"
    assert result.error and "重复" in result.error
    assert result.final_content and "重复" in result.final_content and "停止" in result.final_content
    assert "The write completed before further work was blocked." in result.final_content
    assert write_count == 1
    assert provider.chat_with_retry.await_count == 3
    assert sum(request["tools"] is None for request in requests) == 1
    assert requests[-1]["tools"] is None
    assert requests[-1]["require_image"] is True

    assert finalization_snapshot is not None
    projected = finalization_snapshot
    assert projected[:2] == [system_message, user_message]
    assert projected[1]["content"][1] == user_image
    projected_calls = [
        message for message in projected
        if message.get("role") == "assistant"
        and "Recorded tool calls (already attempted)" in str(message.get("content"))
    ]
    assert len(projected_calls) == 2
    assert sum("write_once" in str(message["content"]) for message in projected_calls) == 1
    assert prior_subtask_result in projected
    projected_results = [
        message for message in projected
        if message.get("role") == "user"
        and isinstance(message.get("content"), list)
        and message["content"]
        and "Recorded tool result for write_once" in str(message["content"][0].get("text", ""))
    ]
    assert len(projected_results) == 1
    assert projected_results[0]["content"][2] == image_block
    assert all(message.get("role") != "tool" for message in projected)
    assert requests[-1]["messages"][1]["content"][1]["image_url"]["url"] == (
        "data:image/png;base64,mutated-by-provider"
    )

    raw_tool_calls = [
        call
        for message in result.messages
        if message.get("role") == "assistant"
        for call in message.get("tool_calls", [])
    ]
    raw_results = [message for message in result.messages if message.get("role") == "tool"]
    assert result.messages[:5] == [
        system_message,
        user_message,
        prior_assistant_call,
        prior_tool_result,
        prior_subtask_result,
    ]
    assert len(raw_tool_calls) == 2
    assert raw_tool_calls[-1]["id"] == "write-1"
    assert result.messages[5]["content"] == "Writing the report."
    assert len(raw_results) == 2
    assert raw_results[-1]["content"][1] == image_block
    assert result.messages[1]["content"][1]["image_url"]["url"] == (
        "data:image/png;base64,user-original"
    )
    assert result.messages[-1]["role"] == "assistant"
    assert result.messages[-1]["content"] == result.final_content


@pytest.mark.asyncio
async def test_loop_report_over_budget_keeps_the_goal_without_another_model_request():
    provider = MagicMock(spec=LLMProvider)
    provider.chat_with_retry = AsyncMock(return_value=LLMResponse(
        content="400 Repetitive tool calls detected", finish_reason="error",
    ))
    goal = {"role": "user", "content": "Preserve this goal."}
    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[goal], tools=ToolRegistry(), model="test-model",
        max_iterations=4, max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        context_window_tokens=10_000, context_block_limit=80,
    ))

    assert result.stop_reason == "loop_detected"
    assert result.error and "停止" in result.error
    assert result.messages[0] == goal
    assert len(result.messages) == 2
    assert result.messages[-1]["content"] == result.final_content
    provider.chat_with_retry.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "finalization_failure",
    ["repeated_400", "blank", "exception", "timeout"],
)
async def test_provider_repeat_error_uses_a_fallback_when_tool_free_finalization_fails(
    finalization_failure: str,
):
    provider = MagicMock(spec=LLMProvider)
    requests: list[dict[str, object]] = []
    error_response = LLMResponse(
        content="400 InternalError.Algo.InvalidParameter: Repetitive tool calls detected",
        finish_reason="error",
    )
    initial_messages = [
        {"role": "user", "content": "Complete the task."},
        {"role": "assistant", "content": "Existing subtask result."},
    ]

    async def chat_with_retry(**kwargs):
        requests.append(kwargs)
        if kwargs.get("tools") is not None:
            return error_response
        if finalization_failure == "repeated_400":
            return LLMResponse(
                content="400 InternalError.Algo.InvalidParameter: Repetitive tool calls detected",
                finish_reason="error",
            )
        if finalization_failure == "blank":
            return LLMResponse(content="   ")
        if finalization_failure == "timeout":
            await asyncio.Event().wait()
        raise RuntimeError("tool-free finalization failed")

    provider.chat_with_retry = AsyncMock(side_effect=chat_with_retry)
    tools = ToolRegistry()
    tools.register(_ScriptedTool("unused", lambda: None))

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=initial_messages,
        tools=tools,
        model="test-model",
        max_iterations=4,
        max_tool_result_chars=_MAX_TOOL_RESULT_CHARS,
        llm_timeout_s=0.01,
    ))

    assert result.stop_reason == "loop_detected"
    assert result.error and "重复" in result.error and "停止" in result.error
    assert result.final_content and "重复" in result.final_content and "停止" in result.final_content
    assert provider.chat_with_retry.await_count == 2
    assert requests[-1]["tools"] is None
    assert result.messages[:2] == initial_messages
    assert len(result.messages) == 3
    assert result.messages[-1]["role"] == "assistant"
    assert result.messages[-1]["content"] == result.final_content
    assert all(not message.get("tool_calls") for message in result.messages)
