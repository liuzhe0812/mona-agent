from __future__ import annotations

import asyncio
import copy
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry
from mona.providers.base import LLMResponse, ToolCallRequest


class _SequencedProvider:
    def __init__(self, responses: list[LLMResponse]) -> None:
        self.responses = list(responses)
        self.requests: list[list[dict[str, Any]]] = []
        self.generation = SimpleNamespace(max_tokens=128, temperature=0.0, reasoning_effort=None)

    def get_default_model(self) -> str:
        return "test-model"

    def estimate_prompt_tokens(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        model: str | None = None,
    ) -> tuple[int, str]:
        return 128, "test-provider"

    async def chat_with_retry(self, **kwargs: Any) -> LLMResponse:
        self.requests.append(copy.deepcopy(kwargs["messages"]))
        if not self.responses:
            raise AssertionError("AgentRunner sent an unexpected extra model request")
        return self.responses.pop(0)


class _ConcurrencyProbe:
    def __init__(self) -> None:
        self.active: set[str] = set()
        self.peak = 0
        self.started: list[str] = []
        self.completed: list[str] = []

    def enter(self, name: str) -> None:
        self.active.add(name)
        self.started.append(name)
        self.peak = max(self.peak, len(self.active))

    def leave(self, name: str) -> None:
        self.active.remove(name)
        self.completed.append(name)


class _ControlledTool(Tool):
    def __init__(
        self,
        name: str,
        probe: _ConcurrencyProbe,
        *,
        release: asyncio.Event,
        safe: bool = True,
        exclusive: bool = False,
    ) -> None:
        self._name = name
        self.probe = probe
        self.release = release
        self.safe = safe
        self._exclusive = exclusive
        self.calls = 0
        self.entered = asyncio.Event()
        self.finished = asyncio.Event()

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return f"Controlled local read {self.name}."

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    @property
    def read_only(self) -> bool:
        return self.safe

    @property
    def exclusive(self) -> bool:
        return self._exclusive

    async def execute(self) -> str:
        self.calls += 1
        self.probe.enter(self.name)
        self.entered.set()
        try:
            await self.release.wait()
            return f"result:{self.name}"
        finally:
            self.probe.leave(self.name)
            self.finished.set()


def _tool_call(call_id: str, name: str) -> ToolCallRequest:
    return ToolCallRequest(id=call_id, name=name, arguments={})


def _tool_response(*calls: ToolCallRequest) -> LLMResponse:
    return LLMResponse(content=None, tool_calls=list(calls), finish_reason="tool_calls")


def _registry(*tools: Tool) -> ToolRegistry:
    registry = ToolRegistry()
    for tool in tools:
        registry.register(tool)
    return registry


def _spec(
    tmp_path: Path,
    registry: ToolRegistry,
    *,
    max_parallel_tool_calls: int | None,
    checkpoint_callback: Any = None,
) -> AgentRunSpec:
    return AgentRunSpec(
        initial_messages=[
            {"role": "system", "content": "Use the registered tools."},
            {"role": "user", "content": "Read each requested item."},
        ],
        tools=registry,
        model="test-model",
        max_iterations=3,
        max_tool_result_chars=4096,
        concurrent_tools=True,
        max_parallel_tool_calls=max_parallel_tool_calls,
        checkpoint_callback=checkpoint_callback,
        workspace=tmp_path,
    )


def _ordered_tool_results(messages: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [
        (message["tool_call_id"], message["content"])
        for message in messages
        if message.get("role") == "tool"
    ]


@pytest.mark.asyncio
async def test_parallel_safe_tools_obey_budget_and_keep_model_order(tmp_path: Path) -> None:
    probe = _ConcurrencyProbe()
    first = _ControlledTool("first", probe, release=asyncio.Event())
    second = _ControlledTool("second", probe, release=asyncio.Event())
    third = _ControlledTool("third", probe, release=asyncio.Event())
    provider = _SequencedProvider([
        _tool_response(
            _tool_call("call-first", first.name),
            _tool_call("call-second", second.name),
            _tool_call("call-third", third.name),
        ),
        LLMResponse(content="Done."),
    ])

    task = asyncio.create_task(AgentRunner(provider).run(_spec(
        tmp_path,
        _registry(first, second, third),
        max_parallel_tool_calls=2,
    )))

    await asyncio.wait_for(asyncio.gather(first.entered.wait(), second.entered.wait()), timeout=2)
    assert probe.active == {"first", "second"}
    assert probe.peak == 2
    assert third.calls == 0

    second.release.set()
    await asyncio.wait_for(third.entered.wait(), timeout=2)
    assert probe.active == {"first", "third"}
    assert probe.peak == 2
    assert probe.completed == ["second"]

    third.release.set()
    await asyncio.wait_for(third.finished.wait(), timeout=2)
    first.release.set()
    result = await asyncio.wait_for(task, timeout=2)

    assert probe.peak <= 2
    assert probe.completed == ["second", "third", "first"]
    assert result.final_content == "Done."
    assert _ordered_tool_results(provider.requests[1]) == [
        ("call-first", "result:first"),
        ("call-second", "result:second"),
        ("call-third", "result:third"),
    ]


@pytest.mark.asyncio
async def test_exclusive_tool_separates_safe_batches(tmp_path: Path) -> None:
    probe = _ConcurrencyProbe()
    before_first = _ControlledTool("before_first", probe, release=asyncio.Event())
    before_second = _ControlledTool("before_second", probe, release=asyncio.Event())
    exclusive = _ControlledTool(
        "exclusive", probe, release=asyncio.Event(), safe=False, exclusive=True,
    )
    after_first = _ControlledTool("after_first", probe, release=asyncio.Event())
    after_second = _ControlledTool("after_second", probe, release=asyncio.Event())
    provider = _SequencedProvider([
        _tool_response(*[
            _tool_call(f"call-{tool.name}", tool.name)
            for tool in (before_first, before_second, exclusive, after_first, after_second)
        ]),
        LLMResponse(content="Done."),
    ])
    tools = (before_first, before_second, exclusive, after_first, after_second)
    task = asyncio.create_task(AgentRunner(provider).run(_spec(
        tmp_path,
        _registry(*tools),
        max_parallel_tool_calls=2,
    )))

    await asyncio.wait_for(
        asyncio.gather(before_first.entered.wait(), before_second.entered.wait()),
        timeout=2,
    )
    assert exclusive.calls == after_first.calls == after_second.calls == 0
    before_first.release.set()
    before_second.release.set()

    await asyncio.wait_for(exclusive.entered.wait(), timeout=2)
    assert probe.active == {"exclusive"}
    assert set(probe.completed) == {"before_first", "before_second"}
    assert after_first.calls == after_second.calls == 0
    exclusive.release.set()

    await asyncio.wait_for(
        asyncio.gather(after_first.entered.wait(), after_second.entered.wait()),
        timeout=2,
    )
    assert probe.active == {"after_first", "after_second"}
    assert probe.completed.index("exclusive") < probe.started.index("after_first")
    assert probe.completed.index("exclusive") < probe.started.index("after_second")
    after_first.release.set()
    after_second.release.set()

    result = await asyncio.wait_for(task, timeout=2)
    assert result.final_content == "Done."
    assert _ordered_tool_results(provider.requests[1]) == [
        (f"call-{tool.name}", f"result:{tool.name}") for tool in tools
    ]


@pytest.mark.asyncio
async def test_cancelled_pool_waiter_is_not_dispatched_or_checkpointed(tmp_path: Path) -> None:
    probe = _ConcurrencyProbe()
    first = _ControlledTool("running", probe, release=asyncio.Event())
    waiting = _ControlledTool("waiting", probe, release=asyncio.Event())
    provider = _SequencedProvider([_tool_response(
        _tool_call("running-call", first.name),
        _tool_call("waiting-call", waiting.name),
    )])
    started_checkpoints: list[list[str]] = []

    async def capture_checkpoint(payload: dict[str, Any]) -> None:
        if payload.get("phase") == "tools_started":
            started_checkpoints.append(list(payload["started_tool_call_ids"]))

    task = asyncio.create_task(AgentRunner(provider).run(_spec(
        tmp_path,
        _registry(first, waiting),
        max_parallel_tool_calls=1,
        checkpoint_callback=capture_checkpoint,
    )))

    await asyncio.wait_for(first.entered.wait(), timeout=2)
    assert waiting.calls == 0
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert first.calls == 1
    assert waiting.calls == 0
    assert started_checkpoints == [["running-call"]]


@pytest.mark.asyncio
async def test_agent_defaults_camel_case_limit_reaches_work_agent_loop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mona.agent.loop import AgentLoop
    from mona.bus.queue import MessageBus
    from mona.config.schema import AgentDefaults

    defaults = AgentDefaults.model_validate({"maxParallelToolCalls": 1})
    assert defaults.max_parallel_tool_calls == 1
    assert defaults.model_dump(by_alias=True)["maxParallelToolCalls"] == 1
    with pytest.raises(ValidationError):
        AgentDefaults.model_validate({"maxParallelToolCalls": 0})

    monkeypatch.setattr(AgentLoop, "_refresh_mona_user_config", lambda _self: None)
    monkeypatch.setattr(
        "mona.config.paths.get_agent_memory_dir",
        lambda _agent_id: tmp_path / "agent-memory",
    )
    probe = _ConcurrencyProbe()
    first = _ControlledTool("work_first", probe, release=asyncio.Event())
    second = _ControlledTool("work_second", probe, release=asyncio.Event())
    provider = _SequencedProvider([
        _tool_response(
            _tool_call("work-first-call", first.name),
            _tool_call("work-second-call", second.name),
        ),
        LLMResponse(content="Work completed."),
    ])
    loop = AgentLoop(
        bus=MessageBus(),
        provider=provider,  # type: ignore[arg-type]
        workspace=tmp_path,
        model="test-model",
        max_parallel_tool_calls=defaults.max_parallel_tool_calls,
    )
    loop.tools = _registry(first, second)

    task = asyncio.create_task(loop._run_agent_loop(
        [
            {"role": "system", "content": "Use the registered tools."},
            {"role": "user", "content": "Read both items."},
        ],
        channel="test",
        chat_id="parallel-budget",
    ))

    await asyncio.wait_for(first.entered.wait(), timeout=2)
    assert loop.max_parallel_tool_calls == 1
    assert probe.peak == 1
    assert second.calls == 0
    first.release.set()
    await asyncio.wait_for(second.entered.wait(), timeout=2)
    assert probe.peak == 1
    second.release.set()

    final, _used, _messages, stop_reason, _injected = await asyncio.wait_for(task, timeout=2)
    assert final == "Work completed."
    assert stop_reason == "completed"
    assert probe.peak == 1


@pytest.mark.asyncio
async def test_checkpoint_failure_waits_for_started_tool_to_settle(tmp_path: Path) -> None:
    probe = _ConcurrencyProbe()
    running = _ControlledTool("running", probe, release=asyncio.Event())
    rejected = _ControlledTool("checkpoint_rejected", probe, release=asyncio.Event())
    provider = _SequencedProvider([_tool_response(
        _tool_call("running-call", running.name),
        _tool_call("rejected-call", rejected.name),
    )])
    failed_checkpoint = asyncio.Event()
    completed_checkpoints: list[dict[str, Any]] = []

    async def persist_checkpoint(payload: dict[str, Any]) -> None:
        if payload.get("phase") == "tools_started" and "rejected-call" in payload[
            "started_tool_call_ids"
        ]:
            failed_checkpoint.set()
            raise RuntimeError("checkpoint storage failed")
        if payload.get("phase") == "tools_partial":
            completed_checkpoints.append(copy.deepcopy(payload))

    task = asyncio.create_task(AgentRunner(provider).run(_spec(
        tmp_path,
        _registry(running, rejected),
        max_parallel_tool_calls=2,
        checkpoint_callback=persist_checkpoint,
    )))

    await asyncio.wait_for(running.entered.wait(), timeout=2)
    await asyncio.wait_for(failed_checkpoint.wait(), timeout=2)
    assert not task.done()
    assert rejected.calls == 0
    assert probe.active == {"running"}

    running.release.set()
    with pytest.raises(RuntimeError, match="checkpoint storage failed"):
        await asyncio.wait_for(task, timeout=2)

    assert running.finished.is_set()
    assert probe.completed == ["running"]
    assert rejected.calls == 0
    assert len(completed_checkpoints) == 1
    assert [
        message["tool_call_id"] for message in completed_checkpoints[0]["completed_tool_results"]
    ] == ["running-call"]
