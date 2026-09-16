"""Tests for exclusive Computer Use turn ownership and cleanup."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import mona.agent.loop as agent_loop_module
import mona.agent.tools.exec_session as exec_session_module
import mona.agent.tools.terminal as terminal_module
import mona.computer_use.session as computer_session
from mona.agent.tools.context import RequestContext
from mona.computer_use.session import (
    ComputerUseTurn,
    bind_computer_context,
    claim_computer_turn,
    finish_computer_turn,
    get_computer_turn,
    stop_computer_turns,
    track_computer_session,
)


def _context(session_key: str) -> RequestContext:
    return RequestContext(
        channel="websocket",
        chat_id=session_key,
        session_key=session_key,
    )


class _DriverSession:
    def __init__(self, result=None, error: Exception | None = None, block=False):
        self.result = result
        self.error = error
        self.block = block
        self.calls: list[tuple[str, dict]] = []

    async def call_tool(self, name: str, *, arguments: dict):
        self.calls.append((name, arguments))
        if self.error is not None:
            raise self.error
        if self.block:
            await asyncio.Event().wait()
        return self.result


@pytest.mark.asyncio
async def test_claim_is_exclusive_until_owner_finishes() -> None:
    owner = bind_computer_context(_context("owner"))
    other = ComputerUseTurn("other")

    assert claim_computer_turn(owner)
    assert claim_computer_turn(owner)
    assert not claim_computer_turn(other)

    await finish_computer_turn(owner)

    assert owner.stopped
    assert not claim_computer_turn(owner)
    assert claim_computer_turn(other)
    await finish_computer_turn(other)


@pytest.mark.asyncio
async def test_finish_and_stop_end_each_registered_driver_once() -> None:
    turn = bind_computer_context(_context("same-session"))
    driver = _DriverSession()
    assert claim_computer_turn(turn)
    assert track_computer_session(turn, driver, "cua")
    assert track_computer_session(turn, driver, "cua")

    await asyncio.gather(
        finish_computer_turn(turn),
        finish_computer_turn(turn),
        stop_computer_turns("same-session"),
    )

    assert driver.calls == [("end_session", {"session": "cua"})]


@pytest.mark.asyncio
async def test_stop_only_finishes_matching_claimed_session() -> None:
    turn = bind_computer_context(_context("first"))
    other = ComputerUseTurn("second")
    driver = _DriverSession()
    assert claim_computer_turn(turn)
    assert track_computer_session(turn, driver, "cua")

    await stop_computer_turns("second")

    assert not turn.stopped
    assert driver.calls == []
    assert not claim_computer_turn(other)

    await stop_computer_turns("first")

    assert turn.stopped
    assert len(driver.calls) == 1
    assert claim_computer_turn(other)
    await finish_computer_turn(other)


@pytest.mark.asyncio
async def test_request_context_isolated_between_concurrent_tasks() -> None:
    both_bound = asyncio.Event()
    bound_count = 0

    async def bind_in_task(session_key: str) -> ComputerUseTurn | None:
        nonlocal bound_count
        bind_computer_context(_context(session_key))
        bound_count += 1
        if bound_count == 2:
            both_bound.set()
        await both_bound.wait()
        return get_computer_turn()

    first, second = await asyncio.gather(
        bind_in_task("first"),
        bind_in_task("second"),
    )

    assert first is not None and first.session_key == "first"
    assert second is not None and second.session_key == "second"
    assert first is not second


@pytest.mark.asyncio
async def test_cancel_active_tasks_stops_computer_turn_before_cancelling(monkeypatch) -> None:
    session_key = "same-session"
    turn = bind_computer_context(_context(session_key))
    driver = _DriverSession()
    assert claim_computer_turn(turn)
    assert track_computer_session(turn, driver, "cua")

    observed_stopped: list[bool] = []
    started = asyncio.Event()

    async def active_turn() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            observed_stopped.append(turn.stopped)
            raise

    task = asyncio.create_task(active_turn())
    await started.wait()
    subagents = SimpleNamespace(cancel_by_session=AsyncMock(return_value=0))
    loop = SimpleNamespace(
        CANCEL_ACTIVE_TASKS_WAIT_SECONDS=0.5,
        _active_tasks={session_key: [task]},
        subagents=subagents,
    )
    monkeypatch.setattr(
        exec_session_module.DEFAULT_EXEC_SESSION_MANAGER,
        "cancel_by_session",
        AsyncMock(return_value=0),
    )
    monkeypatch.setattr(
        terminal_module,
        "cancel_terminal_tasks_by_session",
        AsyncMock(return_value=0),
    )

    await agent_loop_module.AgentLoop._cancel_active_tasks(loop, session_key)

    assert observed_stopped == [True]
    assert turn.stopped
    assert driver.calls == [("end_session", {"session": "cua"})]
    assert not claim_computer_turn(turn)

    next_turn = bind_computer_context(_context(session_key))
    assert claim_computer_turn(next_turn)
    await finish_computer_turn(next_turn)


@pytest.mark.asyncio
async def test_cleanup_logs_errors_and_times_out_without_blocking(monkeypatch) -> None:
    warnings: list[str] = []
    monkeypatch.setattr(
        computer_session,
        "logger",
        SimpleNamespace(warning=lambda message, *args: warnings.append(message.format(*args))),
    )
    monkeypatch.setattr(computer_session, "COMPUTER_SESSION_CLEANUP_TIMEOUT_SECONDS", 0.01)

    turn = bind_computer_context(_context("cleanup"))
    is_error = _DriverSession(result={"isError": True})
    raises = _DriverSession(error=ValueError("driver unavailable"))
    blocks = _DriverSession(block=True)
    assert claim_computer_turn(turn)
    assert track_computer_session(turn, is_error, "is-error")
    assert track_computer_session(turn, raises, "raises")
    assert track_computer_session(turn, blocks, "blocks")

    await asyncio.wait_for(finish_computer_turn(turn), timeout=0.5)

    assert any("returned isError" in message and "is-error" in message for message in warnings)
    assert any("ValueError" in message and "raises" in message for message in warnings)
    assert any("timed out" in message and "blocks" in message for message in warnings)
