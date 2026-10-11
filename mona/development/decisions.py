"""Run-scoped permission questions. UI focus and model text grant no authority."""

from __future__ import annotations

import asyncio
import copy
from typing import Any

from mona.development.contracts import (
    TERMINAL_RUN_STATUSES,
    Binding,
    ExecutorId,
    Run,
    RunStatus,
    new_id,
    now,
)
from mona.development.executors.codex_policy import similar_command_prefix
from mona.development.handoff import _redact
from mona.development.store import ConflictError, DevelopmentStore, NotFoundError


class DecisionBroker:
    def __init__(self, store: DevelopmentStore, timeout: float = 600):
        self.store, self.timeout = store, timeout
        self._pending: dict[str, tuple[dict, asyncio.Future]] = {}

    def list_pending(self, session_id: str, *, include_children: bool = False) -> list[dict]:
        if not self._pending:
            return []
        parent = self.store.get_session(session_id)
        owners = {session_id: parent}
        if include_children and not parent.parent_session_id:
            for record in self.store.list_collaborations(session_id):
                child = self.store.get_session(record.child_session_id)
                if child.parent_session_id == session_id and child.project_id == parent.project_id:
                    owners[child.id] = child
        result = []
        for data, future in self._pending.values():
            owner = owners.get(data["sessionId"])
            if owner is None or future.done():
                continue
            try:
                run = self.store.get_run(data["runId"])
            except NotFoundError:
                continue
            if run.session_id != owner.id or run.status not in {RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.WAITING_USER}:
                continue
            value = copy.deepcopy(data)
            if owner.id != session_id:
                value.update(parentSessionId=session_id, taskTitle=owner.title)
            result.append(value)
        return result

    async def request(self, binding: Binding, kind: str, params: dict[str, Any]) -> Any:
        run = next((r for r in self.store.list_runs(binding.session_id)
                    if r.binding_id == binding.id and r.status not in TERMINAL_RUN_STATUSES), None)
        if run is None or run.status not in {RunStatus.RUNNING, RunStatus.WAITING_USER, RunStatus.PREPARING}:
            raise ConflictError("原任务不再等待此确认，未授予权限。")
        native_turn = params.get("turnId")
        if native_turn and run.native_turn_id and native_turn != run.native_turn_id:
            raise ConflictError("确认请求属于另一执行轮次。")
        return await self.request_run(run.id, kind, params)

    async def request_run(self, run_id: str, kind: str, params: dict[str, Any]) -> Any:
        run: Run = self.store.get_run(run_id)
        if run.status not in {RunStatus.RUNNING, RunStatus.WAITING_USER, RunStatus.PREPARING}:
            raise ConflictError("原任务不再等待此确认，未授予权限。")
        details = {key: _redact(str(params[key]))[:12000]
                   for key in ("command", "cwd", "reason", "toolName") if key in params}
        prefix = similar_command_prefix(params) if run.executor == ExecutorId.CODEX else None
        if prefix:
            details["similarCommandPrefix"] = [_redact(part) for part in prefix]
        questions = params.get("questions", []) if kind == "question" else []
        if not isinstance(questions, list) or len(questions) > 20:
            raise ConflictError("问题格式无效，未提交任何回答。")
        details["questions"] = [{"id": q["id"], "question": str(q.get("question", q.get("header", "")))[:4000],
            "options": [{"label": str(o.get("label", ""))[:500]} for o in q.get("options", [])[:30] if isinstance(o, dict)]}
            for q in questions if isinstance(q, dict) and isinstance(q.get("id"), str)]
        identifier = new_id("decision")
        record = {"id": identifier, "sessionId": run.session_id, "runId": run.id,
                  "kind": kind, "details": details, "createdAt": now().isoformat()}
        future = asyncio.get_running_loop().create_future()
        self._pending[identifier] = (record, future)
        self.store.append_run_event(run.id, "decision.requested", record)
        if run.status in {RunStatus.RUNNING, RunStatus.PREPARING}:
            self.store.transition_run(run.id, run.revision, RunStatus.WAITING_USER)
        try:
            result = await asyncio.wait_for(asyncio.shield(future), self.timeout)
            current = self.store.get_run(run.id)
            if current.status not in {RunStatus.RUNNING, RunStatus.WAITING_USER}:
                raise ConflictError("任务已变化，确认已失效。")
            self.store.append_run_event(run.id, "decision.resolved", {"decisionId": identifier,
                "decision": result if isinstance(result, str) else "answered"})
            if current.status == RunStatus.WAITING_USER and not any(
                    data["runId"] == run.id and key != identifier and not item.done()
                    for key, (data, item) in self._pending.items()):
                self.store.transition_run(run.id, current.revision, RunStatus.RUNNING)
            return result
        except (asyncio.TimeoutError, asyncio.CancelledError):
            self.store.append_run_event(run.id, "decision.expired", {"decisionId": identifier})
            raise
        finally:
            self._pending.pop(identifier, None)
            if not future.done():
                future.cancel()
            current = self.store.get_run(run.id)
            if current.status == RunStatus.WAITING_USER and not any(
                    data["runId"] == run.id and not pending.done()
                    for data, pending in self._pending.values()):
                # Expiry/denial releases only this question. Do not revive an
                # interrupted, disconnected or already completed execution.
                self.store.transition_run(run.id, current.revision, RunStatus.RUNNING)

    def resolve(self, session_id: str, identifier: str, value: Any) -> None:
        item = self._pending.get(identifier)
        if item is None or item[0]["sessionId"] != session_id:
            raise ConflictError("确认请求不存在、已过期或属于其他会话。")
        record, future = item
        run = self.store.get_run(record["runId"])
        if future.done() or run.status not in {RunStatus.RUNNING, RunStatus.WAITING_USER}:
            raise ConflictError("确认已处理或原任务不再等待，未重复提交。")
        if record["kind"] == "question":
            ids = {q["id"] for q in record["details"]["questions"]}
            if not isinstance(value, dict) or set(value) != ids or any(not isinstance(v, list) or not 1 <= len(v) <= 20
                    or any(not isinstance(t, str) or not t.strip() or len(t) > 8000 for t in v) for v in value.values()):
                raise ConflictError("回答必须对应当前问题。")
        elif value == "accept_similar" and record["details"].get("similarCommandPrefix"):
            pass
        elif value not in ("accept", "decline", "cancel"):
            raise ConflictError("只允许单次同意、拒绝或取消。")
        future.set_result(value)

    def cancel_run(self, run_id: str) -> None:
        for record, future in list(self._pending.values()):
            if record["runId"] == run_id and not future.done():
                future.cancel()

    def close(self) -> None:
        for _, future in list(self._pending.values()):
            if not future.done():
                future.cancel()
