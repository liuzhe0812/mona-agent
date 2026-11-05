"""Account- and run-bound access to the shared desktop question coordinator."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from mona.bus.events import OutboundMessage
from mona.bus.user_questions import USER_QUESTIONS_META, QuestionInput, UserQuestions
from mona.hosted_work.contracts import WorkError, identifier
from mona.hosted_work.store import WorkStore

_OWNER = re.compile(r"^[a-f0-9]{64}$")
_ASK_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_NOT_FOUND = "问题已结束或不属于当前会话，请查看最新会话。"


@dataclass(slots=True)
class _Entry:
    owner: str
    session_id: str
    run_id: str
    ask_id: str
    scope: str
    fingerprint: str
    task: asyncio.Task | None = None
    request_id: str | None = None
    answer_fingerprint: str | None = None
    cancelled: bool = False


class HostedQuestions:
    """One shared question implementation, scoped before any answer or fan-out.

    A caller dropping its HTTP connection does not cancel or recreate the
    question. The owning run must call cancel_run when it stops or expires.
    """

    def __init__(self, store: WorkStore, emit: Callable[[str, str, dict], Awaitable[None]]):
        self.store, self.emit = store, emit
        self.questions = UserQuestions(self._publish)
        self._entries: dict[tuple[str, str, str, str], _Entry] = {}
        self._scopes: dict[str, _Entry] = {}
        self._requests: dict[str, _Entry] = {}
        self._cancelled_runs: set[tuple[str, str, str]] = set()
        self._closed = False

    @staticmethod
    def _identity(owner: str, session_id: str, run_id: str | None = None) -> None:
        if not isinstance(owner, str) or not _OWNER.fullmatch(owner):
            raise WorkError("login_required", "请先登录 Mona 账号。", 401)
        identifier(session_id)
        if run_id is not None:
            identifier(run_id)

    def _active(self, owner: str, session_id: str, run_id: str) -> None:
        self._identity(owner, session_id, run_id)
        self.store.session(owner, session_id)
        run = self.store.run(owner, run_id)
        if run["session_id"] != session_id:
            raise WorkError("not_found", _NOT_FOUND, 404)
        if run["status"] != "running" or (owner, session_id, run_id) in self._cancelled_runs:
            raise WorkError("execution_stopped", "本轮已经结束，未继续提问。", 409)

    @staticmethod
    def _fingerprint(value: Any) -> str:
        try:
            raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        except (TypeError, ValueError):
            raise WorkError("invalid_request", "问题或回答的格式无效。") from None
        return hashlib.sha256(raw).hexdigest()

    async def _publish(self, message: OutboundMessage) -> None:
        entry = self._scopes.get(message.chat_id)
        if entry is None:
            return
        values = message.metadata.get(USER_QUESTIONS_META)
        if isinstance(values, list) and len(values) == 1 and isinstance(values[0], dict):
            request_id = values[0].get("request_id")
            if isinstance(request_id, str):
                entry.request_id = request_id
                self._requests[request_id] = entry
        try:
            requests = self.snapshot(entry.owner, entry.session_id)
        except WorkError as exc:
            if exc.status != 404:
                raise
            return
        await self.emit(entry.owner, entry.session_id,
                        {"event": "user_questions", "chat_id": entry.session_id, "requests": requests})

    def snapshot(self, owner: str, session_id: str) -> list[dict]:
        self._identity(owner, session_id)
        self.store.session(owner, session_id)
        result = []
        for entry in self._entries.values():
            if entry.owner != owner or entry.session_id != session_id or entry.cancelled:
                continue
            try:
                self._active(owner, session_id, entry.run_id)
            except WorkError:
                continue
            result.extend(self.questions.snapshot(entry.scope))
        return result

    async def ask(self, owner: str, session_id: str, run_id: str, ask_id: str, questions: list[dict]) -> dict:
        if self._closed:
            raise WorkError("question_unavailable", "提问服务暂不可用。", 503)
        self._active(owner, session_id, run_id)
        if not isinstance(ask_id, str) or not _ASK_ID.fullmatch(ask_id):
            raise WorkError("invalid_request", "提问标识无效。")
        try:
            body = QuestionInput.model_validate({"questions": questions})
        except (ValidationError, ValueError, TypeError):
            raise WorkError("invalid_request", "问题格式无效，请检查内容和选项。") from None
        fingerprint = self._fingerprint(body.model_dump(mode="json"))
        key = owner, session_id, run_id, ask_id
        entry = self._entries.get(key)
        if entry is not None:
            if entry.fingerprint != fingerprint:
                raise WorkError("question_conflict", "同一提问标识的内容已变化，未重复提问。", 409)
            if entry.cancelled:
                raise WorkError("execution_stopped", "该提问已结束，不会自动重新发起。", 409)
        else:
            entry = _Entry(owner, session_id, run_id, ask_id, uuid4().hex, fingerprint)
            self._entries[key] = entry
            self._scopes[entry.scope] = entry
            entry.task = asyncio.create_task(self.questions.ask(entry.scope, "mona", body.questions))
            # The original HTTP waiter can disconnect before the task ends.
            # Consume a later task exception without logging question content.
            entry.task.add_done_callback(lambda task: None if task.cancelled() else task.exception())
        assert entry.task is not None
        # A lost request or a disconnected browser must never cancel and replay
        # an unanswered question; run cancellation is explicit below.
        result = await asyncio.shield(entry.task)
        self._active(owner, session_id, run_id)
        return result

    def answer(self, owner: str, session_id: str, request_id: str, answers: list[dict] | None,
               *, attached: bool) -> None:
        self._identity(owner, session_id)
        entry = self._requests.get(request_id) if isinstance(request_id, str) and len(request_id) <= 100 else None
        if (attached is not True or entry is None or entry.owner != owner or entry.session_id != session_id
                or entry.cancelled):
            raise WorkError("not_found", _NOT_FOUND, 404)
        self._active(owner, session_id, entry.run_id)
        fingerprint = self._fingerprint(answers)
        if entry.answer_fingerprint is not None:
            if entry.answer_fingerprint != fingerprint:
                raise WorkError("question_conflict", "回答已提交，未覆盖原回答。", 409)
            return
        try:
            self.questions.answer(entry.scope, request_id, answers)
        except (ValidationError, ValueError, TypeError):
            raise WorkError("invalid_answer", "回答未提交，请检查所选内容或查看最新会话。") from None
        entry.answer_fingerprint = fingerprint

    async def cancel_run(self, owner: str, session_id: str, run_id: str) -> None:
        self._identity(owner, session_id, run_id)
        self._cancelled_runs.add((owner, session_id, run_id))
        entries = [entry for entry in self._entries.values()
                   if entry.owner == owner and entry.session_id == session_id and entry.run_id == run_id]
        pending = []
        for entry in entries:
            if entry.task is None or entry.task.done():
                continue
            if entry.answer_fingerprint is None and not entry.cancelled:
                entry.cancelled = True
                entry.task.cancel()
            pending.append(entry.task)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        # Once the run is no longer active, it cannot accept another ask with
        # this id. Remove retained fingerprints and request mappings as well.
        try:
            run = self.store.run(owner, run_id)
            still_running = run["session_id"] == session_id and run["status"] == "running"
        except WorkError:
            still_running = False
        if not still_running:
            self._cancelled_runs.discard((owner, session_id, run_id))
            for entry in entries:
                self._entries.pop((entry.owner, entry.session_id, entry.run_id, entry.ask_id), None)
                self._scopes.pop(entry.scope, None)
                if entry.request_id:
                    self._requests.pop(entry.request_id, None)

    async def close(self) -> None:
        self._closed = True
        tasks = []
        for entry in self._entries.values():
            if entry.task is None or entry.task.done():
                continue
            if entry.answer_fingerprint is None and not entry.cancelled:
                entry.cancelled = True
                entry.task.cancel()
            tasks.append(entry.task)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._entries.clear()
        self._scopes.clear()
        self._requests.clear()
        self._cancelled_runs.clear()
