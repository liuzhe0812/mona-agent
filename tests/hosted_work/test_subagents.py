"""The shared subagent lifecycle with hosted tool/context construction."""
from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.runner import AgentRunner, AgentRunResult, AgentRunSpec
from mona.agent.subagent import SubagentManager
from mona.agent.tools.base import Tool
from mona.agent.tools.context import RequestContext
from mona.agent.tools.registry import ToolRegistry
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.subagents import build_subagent_runtime
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.session.manager import Session


class _Provider(LLMProvider):
    def __init__(self, responses=None, block=None):
        super().__init__()
        self.responses = list(responses or [LLMResponse("verified result")])
        self.requests, self.block = [], block
        self.started = asyncio.Event()

    async def chat(self, messages, **kwargs):
        self.requests.append((messages, kwargs))
        self.started.set()
        if self.block:
            await self.block.wait()
        return self.responses.pop(0)

    def get_default_model(self):
        return "model"


class _Read(Tool):
    name = "read_file"
    description = "Read one approved file."
    parameters = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}

    def __init__(self, actions):
        self.actions = actions

    async def execute(self, path):
        self.actions.append(path)
        return "owned sandbox content"


def _runtime(sid="a" * 32):
    session = Session("websocket:" + sid)

    def get_session(key):
        assert key == session.key
        return session

    return SimpleNamespace(session_id=sid, session=session, sessions=SimpleNamespace(get_or_create=get_session),
                           config=SimpleNamespace(max_iterations=3), selection=SimpleNamespace(model="model"))


def _build(runtime=None, provider=None, *, factory=None, on_result=None):
    runtime, provider = runtime or _runtime(), provider or _Provider()
    notices, actions = [], []
    payload = {"session_id": runtime.session_id, "run_id": "f" * 32}

    async def make_spec(task_id, task, origin, hook, checkpoint):
        registry = ToolRegistry()
        registry.register(_Read(actions))
        return AgentRunSpec(
            initial_messages=[{"role": "system", "content": "shared subagent template"},
                              {"role": "user", "content": task}],
            tools=registry, model="model", max_iterations=3, max_tool_result_chars=1000,
            hook=hook, checkpoint_callback=checkpoint, session_key=origin["session_key"],
        )

    async def receive(message):
        notices.append(message)

    hosted = build_subagent_runtime(runtime, payload, provider, factory or make_spec, on_result=on_result or receive)
    return hosted, provider, notices, actions


@pytest.mark.asyncio
async def test_shared_runner_executes_only_injected_tools_without_desktop_discovery(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("desktop/global construction is forbidden")

    for target in (
        "mona.agent.subagent.ToolsConfig", "mona.agent.subagent.AgentRegistry",
        "mona.agent.subagent.SubagentManager._build_tools",
        "mona.agent.subagent.SubagentManager._build_subagent_prompt",
        "mona.agent.tools.loader.ToolLoader.load", "mona.session.manager.SessionManager.__init__",
        "mona.config.paths.get_data_dir",
    ):
        monkeypatch.setattr(target, forbidden)
    provider = _Provider([LLMResponse(None, [ToolCallRequest("call-1", "read_file", {"path": "own.txt"})]),
                          LLMResponse("Verified own.txt")])
    hosted, _, notices, actions = _build(provider=provider)
    assert hosted.manager.tools_config is None
    assert "started" in await hosted.spawn_tool.execute("Inspect own.txt", "Inspect")
    await hosted.wait()
    assert actions == ["own.txt"] and len(provider.requests) == 2
    assert len(notices) == 1 and "completed successfully" in notices[0].content
    assert "Verified own.txt" in notices[0].content
    assert notices[0].metadata["injected_event"] == "subagent_result"
    assert notices[0].session_key_override == "websocket:" + "a" * 32
    assert notices[0].metadata["origin_message_id"] == "f" * 32
    await hosted.close()
    assert hosted.manager.get_running_count() == 0


@pytest.mark.asyncio
async def test_default_desktop_manager_still_uses_original_builders(monkeypatch):
    provider, calls = _Provider(), []
    marker = SimpleNamespace()
    monkeypatch.setattr("mona.agent.subagent.ToolsConfig", lambda: marker)
    manager = SubagentManager(provider, Path("/workspace"), MessageBus(), 1000, model="model")
    assert manager.tools_config is marker

    def tools():
        calls.append("tools")
        return ToolRegistry()

    def prompt():
        calls.append("prompt")
        return "original desktop prompt"

    monkeypatch.setattr(manager, "_build_tools", tools)
    monkeypatch.setattr(manager, "_build_subagent_prompt", prompt)
    await manager.spawn("Task", session_key="cli:direct")
    await asyncio.gather(*tuple(manager._running_tasks.values()))
    assert calls == ["tools", "prompt"]
    assert provider.requests[0][0][0] == {"role": "system", "content": "original desktop prompt"}


@pytest.mark.asyncio
@pytest.mark.parametrize("stop_reason,error", [
    ("max_iterations", None), ("context_limit", None), ("empty_final_response", None),
    ("completed", "unfinished operation"),
])
async def test_unfinished_shared_subagent_preserves_partial_and_never_announces_success(stop_reason, error):
    hosted, _, notices, _ = _build()
    hosted.manager.runner.run = AsyncMock(return_value=AgentRunResult(
        final_content="Useful partial result", messages=[], stop_reason=stop_reason, error=error,
    ))
    await hosted.spawn_tool.execute("Work")
    await hosted.wait()
    assert len(notices) == 1
    assert " failed]" in notices[0].content and "Useful partial result" in notices[0].content
    assert "completed successfully" not in notices[0].content
    await hosted.close()


@pytest.mark.asyncio
async def test_shared_concurrency_limit_and_cancellation_close_real_tasks():
    provider = _Provider(block=asyncio.Event())
    hosted, _, notices, _ = _build(provider=provider)
    await hosted.spawn_tool.execute("Wait")
    await asyncio.wait_for(provider.started.wait(), timeout=1)
    assert hosted.manager.get_running_count_by_session(hosted.session_key) == 1
    assert "concurrency limit" in await hosted.spawn_tool.execute("Second")
    await hosted.close()
    assert hosted.manager.get_running_count() == 0
    assert notices == []
    assert "本轮已结束" in await hosted.spawn_tool.execute("Late")


@pytest.mark.asyncio
async def test_close_does_not_claim_stubborn_child_has_exited():
    hosted, _, notices, _ = _build()
    running, release = asyncio.Event(), asyncio.Event()

    async def stubborn(spec):
        running.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release.wait()
        return AgentRunResult("late known result", [], stop_reason="completed")

    hosted.manager.runner.run = stubborn
    hosted.manager.CANCEL_BY_SESSION_WAIT_SECONDS = 0.01
    await hosted.spawn_tool.execute("Work")
    tasks = tuple(hosted.manager._running_tasks.values())
    await asyncio.wait_for(running.wait(), timeout=1)
    with pytest.raises(WorkError, match="尚未确认停止"):
        await hosted.close()
    assert any(not task.done() for task in tasks)
    release.set()
    await asyncio.gather(*tasks)
    await hosted.close()
    assert len(notices) == 1


@pytest.mark.asyncio
async def test_spawn_and_result_routing_are_bound_to_parent_conversation():
    hosted, provider, notices, _ = _build(provider=_Provider(block=asyncio.Event()))
    for context in (
        RequestContext("websocket", "b" * 32, session_key=hosted.session_key),
        RequestContext("websocket", hosted.session_id, session_key="websocket:" + "b" * 32),
        RequestContext("telegram", hosted.session_id, session_key=hosted.session_key),
    ):
        with pytest.raises(WorkError, match="当前会话"):
            hosted.spawn_tool.set_context(context)
    await hosted.spawn_tool.execute("Wait")
    await asyncio.wait_for(provider.started.wait(), timeout=1)
    task_id = next(iter(hosted.manager._task_statuses))
    for key, value in (("session_key_override", "websocket:" + "b" * 32),
                       ("chat_id", "websocket:" + "b" * 32), ("sender_id", "user"),
                       ("subagent_task_id", "not-this-task"), ("subagent_task_id", []),
                       ("origin_message_id", "e" * 32)):
        message = InboundMessage("system", "subagent", hosted.session_key, "A result",
                                 session_key_override=hosted.session_key,
                                 metadata={"injected_event": "subagent_result", "subagent_task_id": task_id,
                                           "origin_message_id": "f" * 32})
        if key in {"subagent_task_id", "origin_message_id"}:
            message.metadata[key] = value
        else:
            setattr(message, key, value)
        with pytest.raises(WorkError, match="当前会话"):
            await hosted.bus.publish_inbound(message)
    assert notices == []
    with pytest.raises(WorkError, match="结果无法确认"):
        await hosted.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_name", ["ask_user_question", "long_task", "complete_goal", "spawn"])
async def test_children_cannot_gain_parent_or_recursive_tools(tool_name):
    async def factory(task_id, task, origin, hook, checkpoint):
        registry, tool = ToolRegistry(), _Read([])
        tool.name = tool_name
        registry.register(tool)
        return AgentRunSpec([], registry, "model", 1, 1000, session_key=origin["session_key"])

    hosted, provider, notices, _ = _build(factory=factory)
    await hosted.spawn_tool.execute("Work")
    await hosted.wait()
    assert provider.requests == []
    assert len(notices) == 1 and " failed]" in notices[0].content
    await hosted.close()


@pytest.mark.asyncio
async def test_failed_delivery_remains_visible_after_shared_task_cleanup():
    async def failed_delivery(message):
        raise RuntimeError("result persistence unavailable")

    hosted, provider, _, _ = _build(on_result=failed_delivery)
    await hosted.spawn_tool.execute("Work")
    with pytest.raises(WorkError, match="结果无法确认"):
        await hosted.wait()
    assert len(provider.requests) == 1
    with pytest.raises(WorkError, match="结果无法确认"):
        await hosted.close()


def _parent_run(hosted, release):
    class _ParentProvider(_Provider):
        def __init__(self):
            super().__init__([
                LLMResponse(None, [ToolCallRequest("spawn-1", "spawn", {"task": "Verify the file"})]),
                LLMResponse("I will review the delegated result."),
                LLMResponse("Reviewed the verified result."),
            ])
            self.tentative_final = asyncio.Event()

        async def chat(self, messages, **kwargs):
            response = await super().chat(messages, **kwargs)
            if len(self.requests) == 2:
                self.tentative_final.set()
            return response

    provider = _ParentProvider()
    tools = ToolRegistry()
    tools.register(hosted.spawn_tool)
    phases = []

    async def injection(*, limit=3, phase=""):
        phases.append(phase)
        return await hosted.injection_callback(limit=limit, phase=phase)

    spec = AgentRunSpec(
        [{"role": "system", "content": "Shared main prompt"}, {"role": "user", "content": "Verify a file"}],
        tools, "model", 5, 1000, injection_callback=injection, strict_injections=True,
        session_key=hosted.session_key,
    )
    return provider, phases, asyncio.create_task(AgentRunner(provider).run(spec))


@pytest.mark.asyncio
async def test_same_runner_waits_after_tentative_final_then_reviews_child_result():
    release = asyncio.Event()
    hosted, child_provider, notices, _ = _build(provider=_Provider(block=release))
    parent_provider, phases, running = _parent_run(hosted, release)
    await asyncio.wait_for(parent_provider.tentative_final.wait(), timeout=1)
    await asyncio.wait_for(child_provider.started.wait(), timeout=1)
    assert "after tool execution" in phases and "after final response" in phases
    assert not running.done() and len(parent_provider.requests) == 2
    release.set()
    result = await asyncio.wait_for(running, timeout=1)
    assert result.stop_reason == "completed" and result.had_injections
    assert result.final_content == "Reviewed the verified result."
    assert len(parent_provider.requests) == 3 and len(child_provider.requests) == 1
    injected = [message for message in result.messages if message.get("source_kind") == "runtime"]
    assert len(injected) == 1 and notices[0].content == injected[0]["content"]
    assert "verified result" in injected[0]["content"]
    assert "original_command" not in injected[0] and hosted.pending_result_count == 0
    await hosted.close()


@pytest.mark.asyncio
async def test_cancelling_parent_at_final_wait_stops_child_and_never_starts_review():
    release = asyncio.Event()
    hosted, child_provider, notices, _ = _build(provider=_Provider(block=release))
    parent_provider, _phases, running = _parent_run(hosted, release)
    await asyncio.wait_for(parent_provider.tentative_final.wait(), timeout=1)
    await asyncio.wait_for(child_provider.started.wait(), timeout=1)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    await hosted.close()
    assert hosted.manager.get_running_count() == 0
    assert len(parent_provider.requests) == 2 and notices == []


@pytest.mark.asyncio
async def test_composition_keeps_legacy_user_input_separate_from_runtime_authority():
    hosted, _, notices, _ = _build()
    await hosted.spawn_tool.execute("Work")
    await hosted.wait()
    user_input = [{"role": "user", "content": "Use the newer file", "source_kind": "steering"}]

    async def legacy_callback():
        nonlocal user_input
        current, user_input = user_input, []
        return current

    combined = hosted.compose_injections(legacy_callback)
    assert await combined(phase="after final response") == [
        {"role": "user", "content": "Use the newer file", "source_kind": "steering"},
    ]
    assert hosted.pending_result_count == 1
    assert await combined(phase="after final response") == [
        {"role": "user", "content": notices[0].content, "source_kind": "runtime"},
    ]
    assert hosted.pending_result_count == 0
    await hosted.close()


@pytest.mark.asyncio
async def test_ready_result_queue_keeps_fifo_and_respects_callback_limit():
    hosted, _, notices, _ = _build(provider=_Provider([LLMResponse("First"), LLMResponse("Second")]))
    for label in ("First", "Second"):
        await hosted.spawn_tool.execute(label, label)
        await hosted.wait()
    assert hosted.pending_result_count == 2
    assert await hosted.injection_callback(limit=0, phase="after final response") == []
    assert hosted.pending_result_count == 2
    for notice in notices:
        assert await hosted.injection_callback(limit=1, phase="after tool execution") == [
            {"role": "user", "content": notice.content, "source_kind": "runtime"},
        ]
    assert hosted.pending_result_count == 0
    await hosted.close()


@pytest.mark.asyncio
async def test_composition_forwards_phase_and_propagates_result_failure():
    hosted, _, _, _ = _build()
    calls = []

    async def phase_callback(*, limit, phase):
        calls.append((limit, phase))
        return []

    combined = hosted.compose_injections(phase_callback)
    assert await combined(limit=2, phase="after final response") == []
    assert calls == [(2, "after final response")]
    hosted.bus.delivery_failed = True
    with pytest.raises(WorkError, match="结果无法确认"):
        await combined(phase="after final response")
    assert len(calls) == 1
