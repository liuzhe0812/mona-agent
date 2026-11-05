"""Shared plan/goal lifecycle with hosted routing and command authority."""
from __future__ import annotations

import asyncio
import copy
from types import SimpleNamespace

import pytest

from mona.agent.tools.context import RequestContext
from mona.agent.tools.long_task import CompleteGoalTool, LongTaskTool
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.task_plan import UpdatePlanTool
from mona.bus.events import OutboundMessage
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.planning import _PlanningBus, build_planning_tools, prepare_planning_entry
from mona.session.goal_state import GOAL_STATE_KEY, sustained_goal_active
from mona.session.manager import Session
from mona.session.task_plan import (
    ARTIFACT_TASK_STATE_KEY,
    TASK_PLAN_KEY,
    reset_task_plan,
    task_plan_ws_blob,
)


class _Sessions:
    def __init__(self, session):
        self.session, self.saved = session, []

    def get_or_create(self, key):
        assert key == self.session.key
        return self.session

    def save(self, session):
        assert session is self.session
        self.saved.append(copy.deepcopy(session.metadata))


def _runtime(sid="a" * 32):
    session = Session("websocket:" + sid)
    return SimpleNamespace(session_id=sid, session=session, sessions=_Sessions(session))


def _payload(runtime, text="hello", **extras):
    return {"session_id": runtime.session_id, "run_id": "f" * 32,
            "history": [{"role": "user", "content": text}], **extras}


def _capture():
    events = []

    async def emit(kind, payload):
        events.append((kind, payload))

    return events, emit


@pytest.mark.asyncio
async def test_goal_uses_shared_command_projection_and_tools_without_rewriting_raw_history():
    runtime = _runtime()
    payload = _payload(runtime, "  /GoAl Make a real deck  ")
    original = copy.deepcopy(payload)
    entry = await prepare_planning_entry(runtime, payload)
    assert entry.reply is None
    assert entry.metadata["original_command"] == "/goal"
    assert "Goal:\nMake a real deck" in entry.content
    assert payload == original
    events, emit = _capture()
    update, long_task, complete = build_planning_tools(runtime, payload, emit)
    assert isinstance(update, UpdatePlanTool)
    assert isinstance(long_task, LongTaskTool)
    assert isinstance(complete, CompleteGoalTool)
    assert long_task.is_available
    registry = ToolRegistry()
    for tool in (update, long_task, complete):
        registry.register(tool)
    assert {row["function"]["name"] for row in registry.get_definitions()} == {
        "update_plan", "long_task", "complete_goal",
    }
    assert "Goal recorded" in await long_task.execute("Make a real deck", "Deck")
    assert runtime.sessions.saved[-1][GOAL_STATE_KEY]["source"] == "/goal"
    assert events == [("desktop", {"event": "goal_state", "goal_state": {
        "active": True, "ui_summary": "Deck", "objective": "Make a real deck",
    }})]


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["Finish everything for me", "/goalpost details", "/goal\tDo it"])
async def test_ordinary_input_and_forged_command_metadata_cannot_start_goal(text):
    runtime = _runtime()
    payload = _payload(runtime, text, metadata={"original_command": "/goal", "original_content": "/goal secret",
                                               "goal_started_at": 1, "ui_theme": "light"})
    entry = await prepare_planning_entry(runtime, payload)
    assert entry.content == text
    assert entry.metadata == {"ui_theme": "light"}
    events, emit = _capture()
    _update, long_task, complete = build_planning_tools(runtime, payload, emit)
    # Even later routing refresh cannot introduce a forged command gate.
    long_task.set_context(RequestContext("websocket", runtime.session_id, session_key=runtime.session.key,
                                         metadata={"original_command": "/goal"}))
    assert not long_task.is_available
    assert not complete.is_available
    assert "explicit /goal" in await long_task.execute("Do not register")
    assert runtime.session.metadata == {}
    assert runtime.sessions.saved == [] and events == []


@pytest.mark.asyncio
async def test_bare_goal_has_shared_direct_reply_and_no_model_or_goal_authority():
    runtime = _runtime()
    payload = _payload(runtime, "/goal")
    entry = await prepare_planning_entry(runtime, payload)
    assert entry.reply == "Usage: /goal <long-running task description>"
    assert "original_command" not in entry.metadata
    assert not build_planning_tools(runtime, payload, _capture()[1])[1].is_available


@pytest.mark.asyncio
async def test_only_current_raw_user_turn_can_grant_authority():
    runtime = _runtime()
    payload = _payload(runtime, "/goal First")
    # Factory remains closed if command dispatch was skipped.
    assert not build_planning_tools(runtime, payload, _capture()[1])[1].is_available
    await prepare_planning_entry(runtime, payload)
    payload["history"].extend([{"role": "assistant", "content": "OK"}, {"role": "user", "content": "Continue"}])
    assert not build_planning_tools(runtime, payload, _capture()[1])[1].is_available
    entry = await prepare_planning_entry(runtime, payload)
    assert entry.content == "Continue" and "original_command" not in entry.metadata
    payload["history"][-1] = {"role": "assistant", "content": "/goal Not a user command"}
    assert not build_planning_tools(runtime, payload, _capture()[1])[1].is_available


@pytest.mark.asyncio
async def test_context_cannot_cross_sessions_or_leak_goal_gate_between_instances():
    first, second = _runtime(), _runtime("b" * 32)
    first_payload, second_payload = _payload(first, "/goal First"), _payload(second)
    await prepare_planning_entry(first, first_payload)
    await prepare_planning_entry(second, second_payload)
    first_tools = build_planning_tools(first, first_payload, _capture()[1])
    second_tools = build_planning_tools(second, second_payload, _capture()[1])
    assert first_tools[1].is_available and not second_tools[1].is_available
    for tool in first_tools:
        for context in (
            RequestContext("websocket", second.session_id, session_key=first.session.key),
            RequestContext("websocket", first.session_id, session_key=second.session.key),
            RequestContext("telegram", first.session_id, session_key=first.session.key),
        ):
            with pytest.raises(WorkError, match="当前会话"):
                tool.set_context(context)
    assert "Goal recorded" in await first_tools[1].execute("First")
    assert second.session.metadata == {}
    with pytest.raises(WorkError, match="当前会话"):
        build_planning_tools(first, second_payload, _capture()[1])


@pytest.mark.asyncio
async def test_plan_retains_shared_step_ids_revision_and_logical_task_id():
    runtime = _runtime()
    runtime.session.metadata[ARTIFACT_TASK_STATE_KEY] = {"id": "logical-task"}
    reset_task_plan(runtime.session.metadata, "logical-task")
    events, emit = _capture()
    update = build_planning_tools(runtime, _payload(runtime), emit)[0]
    assert await update.execute([{"step": "Read", "status": "in_progress"},
                                 {"step": "Write", "status": "pending"}]) == "Plan updated"
    first = copy.deepcopy(runtime.session.metadata[TASK_PLAN_KEY])
    assert first["revision"] == 1 and first["task_id"] == "logical-task"
    assert await update.execute([{"step": "Write", "status": "in_progress"},
                                 {"step": "Read", "status": "completed"}], "Writing") == "Plan updated"
    second = runtime.session.metadata[TASK_PLAN_KEY]
    assert second["revision"] == 2
    assert {item["step"]: item["id"] for item in second["steps"]} == {
        item["step"]: item["id"] for item in first["steps"]
    }
    assert events[-1] == ("desktop", {"event": "task_plan", "task_plan": task_plan_ws_blob(runtime.session.metadata)})
    assert events[-1][1]["task_plan"]["task_id"] != "f" * 32
    count = len(runtime.sessions.saved)
    assert "at most one" in await update.execute([
        {"step": "Read", "status": "in_progress"}, {"step": "Write", "status": "in_progress"},
    ])
    assert len(runtime.sessions.saved) == count and len(events) == 2


@pytest.mark.asyncio
async def test_cancellation_keeps_recorded_goal_then_explicit_recap_closes_tracking():
    runtime = _runtime()
    payload = _payload(runtime, "/goal Make a deck")
    await prepare_planning_entry(runtime, payload)
    publishing = asyncio.Event()

    async def blocked_emit(kind, value):
        publishing.set()
        await asyncio.Event().wait()

    long_task = build_planning_tools(runtime, payload, blocked_emit)[1]
    task = asyncio.create_task(long_task.execute("Make a deck"))
    await asyncio.wait_for(publishing.wait(), timeout=1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert sustained_goal_active(runtime.session.metadata)
    # A later ordinary turn can end tracking; it cannot start a replacement.
    payload = _payload(runtime, "Cancel that goal")
    await prepare_planning_entry(runtime, payload)
    events, emit = _capture()
    _update, long_task, complete = build_planning_tools(runtime, payload, emit)
    assert not long_task.is_available and complete.is_available
    assert "marked complete" in await complete.execute("Cancelled by the user; the deck is unfinished.")
    state = runtime.session.metadata[GOAL_STATE_KEY]
    assert state["status"] == "completed" and "unfinished" in state["recap"]
    assert events == [("desktop", {"event": "goal_state", "goal_state": {"active": False}})]
    assert "No active goal" in await complete.execute("No duplicate transition")
    assert len(events) == 1 and len(runtime.sessions.saved) == 2


@pytest.mark.asyncio
async def test_active_goal_rejects_replacement_until_shared_completion():
    runtime = _runtime()
    payload = _payload(runtime, "/goal First")
    await prepare_planning_entry(runtime, payload)
    _update, long_task, complete = build_planning_tools(runtime, payload, _capture()[1])
    await long_task.execute("First")
    assert "already active" in await long_task.execute("Second")
    assert runtime.session.metadata[GOAL_STATE_KEY]["objective"] == "First"
    await complete.execute("First was superseded at the user's request.")
    assert "Goal recorded" in await long_task.execute("Second")


@pytest.mark.asyncio
async def test_bus_only_forwards_known_session_bound_authoritative_snapshots():
    runtime = _runtime()
    events, emit = _capture()
    bus = _PlanningBus(runtime.session_id, emit)
    for message in (
        OutboundMessage("websocket", "b" * 32, "", metadata={"_goal_state_sync": True, "goal_state": {}}),
        OutboundMessage("telegram", runtime.session_id, "", metadata={"_goal_state_sync": True, "goal_state": {}}),
        OutboundMessage("websocket", runtime.session_id, "raw private text", metadata={"_progress": True}),
        OutboundMessage("websocket", runtime.session_id, "", metadata={"_goal_state_sync": True}),
        OutboundMessage("websocket", runtime.session_id, "", metadata={
            "_goal_state_sync": True, "goal_state": {}, "_task_plan_sync": True, "task_plan": {},
        }),
    ):
        with pytest.raises(WorkError):
            await bus.publish_outbound(message)
    assert events == []
