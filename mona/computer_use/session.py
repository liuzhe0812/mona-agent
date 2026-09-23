"""Per-request lifecycle for exclusive Computer Use access."""

from __future__ import annotations

import asyncio
import threading
import uuid
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from mona.agent.tools.context import RequestContext

COMPUTER_SESSION_CLEANUP_TIMEOUT_SECONDS = 5.0


@dataclass(eq=False)
class ComputerUseTurn:
    session_key: str
    driver_label: str = field(default_factory=lambda: f"Mona-{uuid.uuid4().hex[:8]}")
    stopped: bool = False
    observation: dict | None = None
    pending_action: dict | None = None
    last_action_signature: str | None = None
    consecutive_no_progress: int = 0
    last_action_effect: dict | None = None
    perception_cache: dict = field(default_factory=dict, repr=False)
    decision_handoffs: set[str] = field(default_factory=set)
    decision_running: bool = False
    dispatch_guard: Any = field(default=None, repr=False)
    progress: Any = field(default=None, repr=False)
    model_response_timeout_seconds: float | None = None
    drivers: list[tuple[Any, str]] = field(default_factory=list, repr=False)
    close_task: asyncio.Task[None] | None = field(default=None, repr=False)


_current_turn: ContextVar[ComputerUseTurn | None] = ContextVar(
    "computer_use_turn", default=None
)
_owner_lock = threading.Lock()
_claimed_turn: ComputerUseTurn | None = None


def bind_computer_context(ctx: RequestContext) -> ComputerUseTurn:
    """Start a fresh Computer Use lifecycle in the current request context."""
    session_key = ctx.session_key or f"{ctx.channel}:{ctx.chat_id}"
    turn = ComputerUseTurn(session_key=session_key)
    _current_turn.set(turn)
    return turn


def get_computer_turn() -> ComputerUseTurn | None:
    return _current_turn.get()


def claim_computer_turn(turn: ComputerUseTurn) -> bool:
    """Claim the process-wide desktop for this turn, without preempting its owner."""
    global _claimed_turn

    with _owner_lock:
        if turn.stopped:
            return False
        if _claimed_turn is turn:
            return True
        if _claimed_turn is not None:
            return False
        _claimed_turn = turn
        return True


def track_computer_session(
    turn: ComputerUseTurn,
    session: Any,
    driver_label: str,
) -> bool:
    """Register a driver session for cleanup, deduplicated by identity and label."""
    with _owner_lock:
        if _claimed_turn is not turn or turn.stopped or turn.close_task is not None:
            return False
        if not any(
            existing is session and existing_label == driver_label
            for existing, existing_label in turn.drivers
        ):
            turn.drivers.append((session, driver_label))
        return True


def mark_computer_turn_stopped(session_key: str) -> bool:
    """Synchronously block further dispatch for the claimed turn, if it matches."""
    with _owner_lock:
        if _claimed_turn is None or _claimed_turn.session_key != session_key:
            return False
        _claimed_turn.stopped = True
        return True


def _release_computer_turn(turn: ComputerUseTurn) -> None:
    global _claimed_turn

    with _owner_lock:
        if _claimed_turn is turn:
            _claimed_turn = None


def _is_error(result: Any) -> bool:
    if isinstance(result, dict):
        return bool(result.get("isError"))
    return bool(getattr(result, "isError", False))


def _consume_task_result(task: asyncio.Task[Any]) -> None:
    try:
        task.exception()
    except asyncio.CancelledError:
        pass


async def _end_driver_session(
    turn: ComputerUseTurn,
    session: Any,
    driver_label: str,
) -> None:
    try:
        result = await session.call_tool(
            "end_session",
            arguments={"session": driver_label},
        )
    except Exception as exc:
        logger.warning(
            "Computer Use end_session failed for session {} driver {}: {}",
            turn.session_key,
            driver_label,
            type(exc).__name__,
        )
        return

    if _is_error(result):
        logger.warning(
            "Computer Use end_session returned isError for session {} driver {}",
            turn.session_key,
            driver_label,
        )


async def _close_computer_turn(turn: ComputerUseTurn) -> None:
    sessions = tuple(turn.drivers)
    tasks = [
        asyncio.create_task(_end_driver_session(turn, session, label))
        for session, label in sessions
    ]
    try:
        if not tasks:
            return
        done, pending = await asyncio.wait(
            tasks,
            timeout=COMPUTER_SESSION_CLEANUP_TIMEOUT_SECONDS,
        )
        if pending:
            for task in pending:
                index = tasks.index(task)
                _, label = sessions[index]
                logger.warning(
                    "Computer Use end_session timed out after {}s for session {} driver {}",
                    COMPUTER_SESSION_CLEANUP_TIMEOUT_SECONDS,
                    turn.session_key,
                    label,
                )
                task.cancel()
        if done:
            await asyncio.gather(*done, return_exceptions=True)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
                task.add_done_callback(_consume_task_result)
        turn.drivers.clear()


async def _close_and_release(turn: ComputerUseTurn) -> None:
    try:
        await _close_computer_turn(turn)
    finally:
        turn.observation = None
        turn.pending_action = None
        turn.perception_cache.clear()
        _release_computer_turn(turn)


async def finish_computer_turn(turn: ComputerUseTurn | None = None) -> None:
    """Stop and clean up a turn once, even when stop and finally race."""
    turn = turn or get_computer_turn()
    if turn is None:
        return

    with _owner_lock:
        turn.stopped = True
        close_task = turn.close_task
        if close_task is None:
            close_task = asyncio.create_task(_close_and_release(turn))
            turn.close_task = close_task
    await asyncio.shield(close_task)


async def stop_computer_turns(session_key: str) -> None:
    """Stop the claimed desktop turn only when it belongs to this session."""
    with _owner_lock:
        turn = _claimed_turn
        if turn is None or turn.session_key != session_key:
            return
        turn.stopped = True
    await finish_computer_turn(turn)
