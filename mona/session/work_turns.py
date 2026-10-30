"""Process-local identities and cancellation barriers for ordinary Work turns."""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict, deque
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal
from uuid import uuid4

from loguru import logger

StopOutcome = Literal["stopped", "already_finished", "unknown", "unsupported"]


class WorkTurnBlockedError(RuntimeError):
    """The previous turn's resource cleanup has not been confirmed."""


@dataclass
class WorkTurn:
    turn_id: str
    session_key: str
    chat_id: str
    task: asyncio.Task[Any] | None
    cancel: Callable[[], Awaitable[str | None]] | None
    input_id: str | None
    started_at: float
    state: Literal["running", "stopping", "unknown", "finished"] = "running"
    stop_task: asyncio.Task[StopOutcome] | None = None
    cleanup_task: asyncio.Task[str | None] | None = None
    stop_outcome: StopOutcome | None = None
    cleanup_failed: bool = False
    on_closed: Callable[[WorkTurn], None] | None = None


class WorkTurnController:
    def __init__(self, *, stop_timeout_seconds: float = 5, max_finished: int = 256):
        self.stop_timeout_seconds = stop_timeout_seconds
        self.max_finished = max_finished
        self._turns: OrderedDict[str, WorkTurn] = OrderedDict()
        self._finished: deque[str] = deque()
        self._by_chat: dict[str, str] = {}
        self._by_session: dict[str, str] = {}
        self._blocked: dict[str, WorkTurn] = {}

    def start(self, session_key: str, chat_id: str, task: asyncio.Task[Any],
              cancel: Callable[[], Awaitable[str | None]], input_id: str | None = None,
              on_closed: Callable[[WorkTurn], None] | None = None) -> WorkTurn:
        if session_key in self._blocked or session_key in self._by_session:
            raise WorkTurnBlockedError("原任务的结束状态尚未确认，本次未开始执行。")
        turn = WorkTurn(uuid4().hex, session_key, chat_id, task, cancel, input_id, time.time())
        turn.on_closed = on_closed
        self._turns[turn.turn_id] = turn
        self._by_chat[chat_id] = turn.turn_id
        self._by_session[session_key] = turn.turn_id
        return turn

    def current(self, chat_id: str) -> WorkTurn | None:
        identifier = self._by_chat.get(chat_id)
        return self._turns.get(identifier) if identifier else None

    def find(self, chat_id: str, turn_id: str) -> WorkTurn | None:
        turn = self._turns.get(turn_id)
        return turn if turn is not None and turn.chat_id == chat_id else None

    def snapshot(self, chat_id: str) -> dict[str, Any] | None:
        turn = self.current(chat_id)
        if turn is None:
            return None
        value = {"turn_id": turn.turn_id, "state": turn.state, "started_at": turn.started_at}
        if turn.input_id:
            value["input_id"] = turn.input_id
        return value

    async def wait_ready(self, session_key: str) -> None:
        while turn := self._blocked.get(session_key):
            if turn.stop_task is not None and not turn.stop_task.done():
                await asyncio.shield(turn.stop_task)
            elif turn.cleanup_task is not None and not turn.cleanup_task.done():
                await asyncio.shield(asyncio.gather(turn.cleanup_task, return_exceptions=True))
            elif self._cleanup_confirmed(turn):
                outcome = "unknown" if turn.cleanup_task.result() == "unknown" else "stopped"
                self._close(turn, outcome)
            else:
                raise WorkTurnBlockedError("原任务的清理结果仍待核对，本次未开始执行。")

    def finish(self, turn_id: str) -> None:
        turn = self._turns.get(turn_id)
        if turn is not None and turn.state == "running":
            self._close(turn)

    def _close(self, turn: WorkTurn, outcome: StopOutcome | None = None) -> None:
        if turn.state == "finished":
            return
        turn.state = "finished"
        turn.stop_outcome = outcome
        if self._by_chat.get(turn.chat_id) == turn.turn_id:
            self._by_chat.pop(turn.chat_id, None)
        if self._by_session.get(turn.session_key) == turn.turn_id:
            self._by_session.pop(turn.session_key, None)
        if turn.on_closed is not None:
            turn.on_closed(turn)
            turn.on_closed = None
        if self._blocked.get(turn.session_key) is turn:
            self._blocked.pop(turn.session_key, None)
        turn.task = None
        turn.cancel = None
        turn.stop_task = None
        turn.cleanup_task = None
        self._finished.append(turn.turn_id)
        while len(self._finished) > self.max_finished:
            self._turns.pop(self._finished.popleft(), None)

    def _cleanup_confirmed(self, turn: WorkTurn) -> bool:
        cleanup = turn.cleanup_task
        if turn.cleanup_failed or cleanup is None or not cleanup.done() or turn.task is None or not turn.task.done():
            return False
        try:
            cleanup.result()
        except BaseException:
            return False
        return True

    async def stop(self, chat_id: str, expected_turn_id: str) -> StopOutcome:
        turn = self._turns.get(expected_turn_id)
        if turn is None or turn.chat_id != chat_id:
            return "unknown"
        if turn.state == "finished":
            return "unknown" if turn.stop_outcome == "unknown" else "already_finished"
        if turn.state == "unknown":
            if self._cleanup_confirmed(turn):
                outcome = "unknown" if turn.cleanup_task.result() == "unknown" else "stopped"
                self._close(turn, outcome)
                return outcome
            return "unknown"
        if turn.stop_task is None:
            turn.state = "stopping"
            self._blocked[turn.session_key] = turn
            turn.stop_task = asyncio.create_task(self._stop(turn))
        return await asyncio.shield(turn.stop_task)

    async def _stop(self, turn: WorkTurn) -> StopOutcome:
        assert turn.cancel is not None
        turn.cleanup_task = asyncio.create_task(turn.cancel())
        done, _ = await asyncio.wait({turn.cleanup_task}, timeout=self.stop_timeout_seconds)
        if done and self._cleanup_confirmed(turn):
            outcome = "unknown" if turn.cleanup_task.result() == "unknown" else "stopped"
            self._close(turn, outcome)
            return outcome
        turn.state = "unknown"
        # Keep the cleanup task and barrier: a timeout is not proof that resources stopped.
        def observe(task: asyncio.Task[str | None]) -> None:
            if task.cancelled():
                return
            if task.exception() is not None:
                logger.warning("Work turn cleanup failed ({})", type(task.exception()).__name__)
            elif self._cleanup_confirmed(turn):
                outcome = "unknown" if task.result() == "unknown" else "stopped"
                self._close(turn, outcome)
        turn.cleanup_task.add_done_callback(observe)
        return "unknown"
