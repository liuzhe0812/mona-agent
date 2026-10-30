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
InputState = Literal["accepted", "consumed", "paused", "rejected"]


class WorkTurnBlockedError(RuntimeError):
    """The previous turn's resource cleanup has not been confirmed."""


@dataclass
class WorkInput:
    chat_id: str
    input_id: str
    target_turn_id: str | None
    state: InputState
    session_key: str | None = None
    execution_turn_id: str | None = None
    published: bool = False
    allow_next_turn: bool = False
    reason: str | None = None


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
    def __init__(self, *, stop_timeout_seconds: float = 5, max_finished: int = 256,
                 max_inputs: int = 4096, on_input_state: Callable[[dict[str, Any]], None] | None = None):
        self.stop_timeout_seconds = stop_timeout_seconds
        self.max_finished = max_finished
        self._turns: OrderedDict[str, WorkTurn] = OrderedDict()
        self._finished: deque[str] = deque()
        self._by_chat: dict[str, str] = {}
        self._by_session: dict[str, str] = {}
        self._blocked: dict[str, WorkTurn] = {}
        self.max_inputs = max_inputs
        self._inputs: OrderedDict[tuple[str, str], WorkInput] = OrderedDict()
        self._recent_inputs: OrderedDict[tuple[str, str], WorkInput] = OrderedDict()
        self._on_input_state = on_input_state

    def input_state(self, chat_id: str, input_id: str) -> dict[str, Any] | None:
        item = self._inputs.get((chat_id, input_id)) or self._recent_inputs.get((chat_id, input_id))
        return self._input_snapshot(item) if item is not None else None

    def input_snapshots(self, chat_id: str) -> list[dict[str, Any]]:
        values = {**self._recent_inputs, **self._inputs}
        return [self._input_snapshot(item) for item in values.values()
                if item.chat_id == chat_id and (item.published or item.state != "accepted")]

    def _remember_input(self, item: WorkInput) -> None:
        key = (item.chat_id, item.input_id)
        self._recent_inputs[key] = item
        self._recent_inputs.move_to_end(key)
        while len(self._recent_inputs) > self.max_inputs:
            self._recent_inputs.popitem(last=False)

    @staticmethod
    def _input_snapshot(item: WorkInput) -> dict[str, Any]:
        value = {"chat_id": item.chat_id, "input_id": item.input_id, "state": item.state}
        if item.target_turn_id:
            value["turn_id"] = item.target_turn_id
        return value

    def emit_input(self, chat_id: str, input_id: str) -> None:
        item = self._inputs.get((chat_id, input_id)) or self._recent_inputs.get((chat_id, input_id))
        if item is not None and (item.published or item.state != "accepted"):
            self._emit_input(item)

    def _emit_input(self, item: WorkInput) -> None:
        if self._on_input_state is not None:
            self._on_input_state(self._input_snapshot(item))

    def reject_input(self, chat_id: str, input_id: str, target_turn_id: str | None = None,
                     reason: str = "本次输入未开始执行。") -> WorkInput:
        current = self._inputs.get((chat_id, input_id)) or self._recent_inputs.get((chat_id, input_id))
        if current is not None and current.state == "consumed":
            self._emit_input(current)
            return current
        rejected = WorkInput(chat_id, input_id, target_turn_id, "rejected", reason=reason)
        if current is not None and current.target_turn_id == target_turn_id:
            rejected.session_key = current.session_key
            rejected.execution_turn_id = current.execution_turn_id
            self._inputs.pop((chat_id, input_id), None)
            self._remember_input(rejected)
        elif current is None:
            self._remember_input(rejected)
        self._emit_input(rejected)
        return rejected

    def accept_input(self, chat_id: str, input_id: str, target_turn_id: str | None = None,
                     *, resume: bool = False) -> tuple[WorkInput, bool]:
        key = (chat_id, input_id)
        item = self._inputs.get(key)
        recent = self._recent_inputs.get(key)
        if item is None and recent is not None and recent.state == "consumed":
            self._emit_input(recent)
            return recent, False
        if item is not None and item.state == "consumed":
            self._emit_input(item)
            return item, False
        if item is not None and item.state == "accepted":
            if item.target_turn_id != target_turn_id:
                return self.reject_input(chat_id, input_id, target_turn_id, "原输入仍在等待处理，未重复派发。"), False
            self.emit_input(chat_id, input_id)
            return item, False
        if item is not None and item.state == "paused" and not resume:
            self._emit_input(item)
            return item, False
        if resume and (item is None or item.state != "paused"):
            return self.reject_input(chat_id, input_id, target_turn_id, "无法核对待恢复的原输入，未重新派发。"), False
        active = self.current(chat_id)
        if active is not None and active.state in {"stopping", "unknown"}:
            if item is not None and item.state == "paused":
                self._emit_input(item)
                return item, False
            return self.reject_input(chat_id, input_id, target_turn_id, "原任务仍在停止或等待核对，本次输入未开始执行。"), False
        target = self.find(chat_id, target_turn_id) if target_turn_id else None
        if target_turn_id and (target is None or target.state != "running"):
            return self.reject_input(chat_id, input_id, target_turn_id, "原轮次已结束或无法核对，未把引导改为新任务。"), False
        accepted = WorkInput(chat_id, input_id, target_turn_id, "accepted",
                             session_key=target.session_key if target else item.session_key if item else None)
        if target_turn_id is not None or item is not None:
            if item is None and len(self._inputs) >= self.max_inputs:
                return self.reject_input(chat_id, input_id, target_turn_id, "待处理输入达到安全上限，请先处理已有队列。"), False
            self._inputs[key] = accepted
        self._recent_inputs.pop(key, None)
        return accepted, True

    def confirm_input(self, chat_id: str, input_id: str) -> None:
        item = self._inputs.get((chat_id, input_id))
        if item is not None and item.state == "accepted" and not item.published:
            item.published = True
            self._emit_input(item)

    def session_blocked(self, session_key: str) -> bool:
        return session_key in self._blocked

    def current_for_session(self, session_key: str) -> WorkTurn | None:
        identifier = self._by_session.get(session_key)
        return self._turns.get(identifier) if identifier else None

    def can_dispatch_input(self, chat_id: str, input_id: str, target_turn_id: str | None = None) -> bool:
        item = self._inputs.get((chat_id, input_id))
        if item is None:
            if (chat_id, input_id) in self._recent_inputs:
                return False
            active = self.current(chat_id)
            return target_turn_id is None and (active is None or active.state == "running")
        if item.state != "accepted" or item.target_turn_id != target_turn_id:
            return False
        owner = self._turns.get(item.execution_turn_id) if item.execution_turn_id else None
        target = self.find(chat_id, item.target_turn_id) if item.target_turn_id else None
        if owner is not None and owner.state in {"stopping", "unknown"}:
            self.pause_inputs(owner.chat_id, owner.turn_id)
            return False
        return item.allow_next_turn or item.target_turn_id is None or (target is not None and target.state == "running")

    def bind_input(self, chat_id: str, input_id: str, actual_turn_id: str) -> None:
        item = self._inputs.get((chat_id, input_id))
        owner = self._turns.get(actual_turn_id)
        if (item is not None and item.state == "accepted" and owner is not None
                and item.session_key in (None, owner.session_key)):
            item.execution_turn_id = actual_turn_id
            item.session_key = owner.session_key

    def consume_input(self, chat_id: str, input_id: str, target_turn_id: str | None = None) -> bool:
        if not self.can_dispatch_input(chat_id, input_id, target_turn_id):
            self.emit_input(chat_id, input_id)
            return False
        item = self._inputs.get((chat_id, input_id))
        if item is None:
            item = WorkInput(chat_id, input_id, None, "consumed")
            self._remember_input(item)
            self._emit_input(item)
        else:
            item.state = "consumed"
            self._emit_input(item)
        return True

    def pause_inputs(self, chat_id: str, turn_id: str | None = None) -> None:
        owner = self.find(chat_id, turn_id) if turn_id is not None else None
        for item in tuple(self._inputs.values()):
            if (item.state == "accepted" and ((turn_id is None and item.chat_id == chat_id)
                    or (item.chat_id == chat_id and item.target_turn_id == turn_id)
                    or (owner is not None and item.execution_turn_id == turn_id))):
                item.state = "paused"
                item.allow_next_turn = False
                self._emit_input(item)

    def pause_session_inputs(self, session_key: str) -> None:
        for item in tuple(self._inputs.values()):
            if item.session_key == session_key and item.state == "accepted":
                item.state = "paused"
                item.allow_next_turn = False
                self._emit_input(item)

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
        for key, item in tuple(self._inputs.items()):
            if item.state == "consumed" and (item.execution_turn_id == turn.turn_id
                                              or (item.execution_turn_id is None and item.target_turn_id == turn.turn_id)):
                self._inputs.pop(key, None)
                self._remember_input(item)
            elif item.state == "rejected" and turn.turn_id in {item.target_turn_id, item.execution_turn_id}:
                self._inputs.pop(key, None)
                self._remember_input(item)
            elif outcome is None and item.target_turn_id == turn.turn_id and item.state == "accepted":
                if item.published:
                    item.allow_next_turn = True
                else:
                    self.reject_input(item.chat_id, item.input_id, item.target_turn_id, "原轮次已结束，本次引导未开始执行。")
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
        self.pause_inputs(chat_id, expected_turn_id)
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
