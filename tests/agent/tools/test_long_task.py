"""Tests for sustained goal tools (`long_task`, `complete_goal`)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.loop import AgentLoop
from mona.agent.tools.context import RequestContext
from mona.agent.tools.long_task import (
    CompleteGoalTool,
    LongTaskTool,
)
from mona.agent.tools.registry import ToolRegistry
from mona.bus.queue import MessageBus
from mona.session.goal_state import GOAL_STATE_KEY
from mona.session.manager import SessionManager


def _tools(
    sm: SessionManager,
    *,
    goal_command: bool = True,
) -> tuple[LongTaskTool, CompleteGoalTool]:
    lt = LongTaskTool(sessions=sm)
    cg = CompleteGoalTool(sessions=sm)
    rc = RequestContext(
        channel="websocket",
        chat_id="c1",
        session_key="websocket:c1",
        metadata={"original_command": "/goal"} if goal_command else {},
    )
    lt.set_context(rc)
    cg.set_context(rc)
    return lt, cg


@pytest.mark.asyncio
async def test_long_task_records_goal_metadata(tmp_path):
    sm = SessionManager(tmp_path)
    lt, _cg = _tools(sm)

    out = await lt.execute(goal="Do the thing", ui_summary="thing")
    assert "Goal recorded" in out

    sess = sm.get_or_create("websocket:c1")
    blob = sess.metadata.get(GOAL_STATE_KEY)
    assert isinstance(blob, dict)
    assert blob["status"] == "active"
    assert blob["source"] == "/goal"
    assert blob["objective"] == "Do the thing"
    assert blob["ui_summary"] == "thing"


@pytest.mark.asyncio
async def test_long_task_is_unavailable_without_explicit_goal_command(tmp_path):
    sm = SessionManager(tmp_path)
    lt, _cg = _tools(sm, goal_command=False)

    assert lt.is_available is False
    out = await lt.execute(goal="Do not persist this")

    assert "explicit /goal command" in out
    assert GOAL_STATE_KEY not in sm.get_or_create("websocket:c1").metadata


def test_long_task_is_hidden_from_model_outside_goal_command(tmp_path):
    sm = SessionManager(tmp_path)
    lt, _cg = _tools(sm, goal_command=False)
    registry = ToolRegistry()
    registry.register(lt)

    assert registry.get_definitions() == []

    lt.set_context(
        RequestContext(
            channel="websocket",
            chat_id="c1",
            session_key="websocket:c1",
            metadata={"original_command": "/goal"},
        )
    )
    registry.invalidate_definitions_cache()

    assert [definition["function"]["name"] for definition in registry.get_definitions()] == [
        "long_task"
    ]


@pytest.mark.asyncio
async def test_long_task_rejects_second_active_goal(tmp_path):
    sm = SessionManager(tmp_path)
    lt, _cg = _tools(sm)

    await lt.execute(goal="First")
    out = await lt.execute(goal="Second")
    assert "already active" in out


@pytest.mark.asyncio
async def test_complete_goal_closes_active_goal(tmp_path):
    sm = SessionManager(tmp_path)
    lt, cg = _tools(sm)

    await lt.execute(goal="X")
    out = await cg.execute(recap="Done.")
    assert "marked complete" in out

    sess = sm.get_or_create("websocket:c1")
    blob = sess.metadata.get(GOAL_STATE_KEY)
    assert blob["status"] == "completed"
    assert blob["recap"] == "Done."


@pytest.mark.asyncio
async def test_long_task_publishes_goal_state_ws_after_save(tmp_path):
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    sm = SessionManager(tmp_path)
    lt = LongTaskTool(sessions=sm, bus=bus)
    rc = RequestContext(
        channel="websocket",
        chat_id="chat-99",
        session_key="websocket:chat-99",
        metadata={"original_command": "/goal"},
    )
    lt.set_context(rc)

    await lt.execute(goal="Objective alpha", ui_summary="alpha")

    bus.publish_outbound.assert_awaited_once()
    call = bus.publish_outbound.await_args.args[0]
    assert call.channel == "websocket"
    assert call.chat_id == "chat-99"
    assert call.metadata.get("_goal_state_sync") is True
    assert call.metadata["goal_state"] == {
        "active": True,
        "ui_summary": "alpha",
        "objective": "Objective alpha",
    }


@pytest.mark.asyncio
async def test_complete_goal_publishes_inactive_goal_state_ws(tmp_path):
    bus = MagicMock()
    bus.publish_outbound = AsyncMock()
    sm = SessionManager(tmp_path)
    lt = LongTaskTool(sessions=sm, bus=bus)
    cg = CompleteGoalTool(sessions=sm, bus=bus)
    rc = RequestContext(
        channel="websocket",
        chat_id="chat-z",
        session_key="websocket:chat-z",
        metadata={"original_command": "/goal"},
    )
    lt.set_context(rc)
    await lt.execute(goal="X")

    bus.publish_outbound.reset_mock()
    cg.set_context(rc)
    await cg.execute(recap="Done.")

    bus.publish_outbound.assert_awaited_once()
    call = bus.publish_outbound.await_args.args[0]
    assert call.metadata["goal_state"] == {"active": False}


@pytest.mark.asyncio
async def test_complete_goal_without_active_is_noop_message(tmp_path):
    sm = SessionManager(tmp_path)
    _lt, cg = _tools(sm)

    out = await cg.execute(recap="n/a")
    assert "No active" in out


@pytest.mark.asyncio
async def test_long_task_skips_ws_publish_without_bus(tmp_path):
    sm = SessionManager(tmp_path)
    lt, _cg = _tools(sm)
    out = await lt.execute(goal="Solo", ui_summary="s")
    assert "Goal recorded" in out


@pytest.mark.asyncio
async def test_long_task_and_complete_goal_registered(tmp_path):
    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    loop = AgentLoop(bus=bus, provider=provider, workspace=tmp_path, model="test-model")

    lt = loop.tools.get("long_task")
    cg = loop.tools.get("complete_goal")
    assert lt is not None and lt.name == "long_task"
    assert cg is not None and cg.name == "complete_goal"


@pytest.mark.asyncio
async def test_goal_tools_keep_each_partner_session_isolated(tmp_path):
    sm = SessionManager(tmp_path)
    lt_one, _ = _tools(sm)
    await lt_one.execute(goal="First session")

    lt_two = LongTaskTool(sessions=sm)
    lt_two.set_context(
        RequestContext(
            channel="websocket",
            chat_id="c2",
            session_key="websocket:c2",
            metadata={"original_command": "/goal"},
        )
    )
    await lt_two.execute(goal="Second session")

    assert sm.get_or_create("websocket:c1").metadata[GOAL_STATE_KEY]["objective"] == "First session"
    assert sm.get_or_create("websocket:c2").metadata[GOAL_STATE_KEY]["objective"] == "Second session"
