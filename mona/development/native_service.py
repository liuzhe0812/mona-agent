"""Persistent native execution coordinator, independent of panes and HTTP requests.

Adapters own native execution; this layer owns Mona runs, transcript references
and the handoff dispatch boundary. A consumer never restarts a lost write request.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

from mona.development.contracts import (
    TERMINAL_RUN_STATUSES,
    Binding,
    ExecutorId,
    Run,
    RunStatus,
    new_id,
)
from mona.development.executors.base import Executor, NativeEvent
from mona.development.executors.rpc import RpcError
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore
from mona.session.manager import SessionManager

_TERMINALS = {"run.completed": RunStatus.SUCCEEDED, "run.failed": RunStatus.FAILED,
              "run.interrupted": RunStatus.INTERRUPTED}


def _stable_id(kind: str, *parts: str) -> str:
    value = "\x00".join(parts).encode("utf-8")
    return f"{kind}_{hashlib.sha256(value).hexdigest()}"


class NativeRunService:
    def __init__(self, store: DevelopmentStore, sessions: SessionManager):
        self.store, self.sessions = store, sessions
        self._adapters: dict[str, Executor] = {}
        self._consumers: dict[str, asyncio.Task[None]] = {}
        self._dispatches: dict[str, asyncio.Task[None]] = {}
        self._current: dict[str, str] = {}
        self._sent: set[str] = set()
        self._closed = False

    def attach(self, binding_id: str, adapter: Executor) -> None:
        """Called after native restore/create AND durable product binding activation."""
        binding = self.store.get_binding(binding_id)
        if self._closed or binding.executor != adapter.id or binding.executor == ExecutorId.MONA:
            raise DevelopmentError("invalid_executor", "原生执行服务不能使用模型供应商或其他执行者。")
        if binding.state != "active":
            raise ConflictError("请先恢复原生绑定。")
        existing = self._consumers.get(binding_id)
        if existing and not existing.done():
            if self._adapters[binding_id] is not adapter:
                raise ConflictError("原生绑定已有另一执行器宿主。")
            return
        self._adapters[binding_id] = adapter
        active = [r for r in self.store.list_runs(binding.session_id) if r.binding_id == binding_id and r.status not in TERMINAL_RUN_STATUSES]
        if active:
            self._current[binding_id] = active[0].id
        self._consumers[binding_id] = asyncio.create_task(self._consume(binding), name=f"native-events-{binding_id}")

    async def submit(self, session_id: str, request_id: str, message: str) -> Run:
        if self._closed or not isinstance(message, str) or not message.strip() or len(message) > 131072:
            raise DevelopmentError("invalid_request", "开发请求不能为空、过长或发给已关闭的服务。")
        session = self.store.get_session(session_id)
        bindings = [b for b in self.store.list_bindings(session_id) if b.state == "active" and b.executor == session.executor]
        if len(bindings) != 1:
            raise ConflictError("请先建立当前执行者的原生会话。")
        binding = bindings[0]
        message_id = _stable_id("message", session_id, request_id, message)
        # The unique durable request key, not an in-memory cache, arbitrates
        # concurrent HTTP retries. Existing requests never dispatch again.
        run, created = self.store.create_run(session_id, request_id, message_id, binding.id)
        if not created:
            return run
        adapter = self._adapters.get(binding.id)
        if adapter is None or self._consumers[binding.id].done():
            return self.store.transition_run(run.id, run.revision, RunStatus.FAILED, error_code="native_not_attached")
        transcript = self.sessions.get_or_create(session.transcript_key)
        original_length = len(transcript.messages)
        try:
            transcript.add_message("user", message, id=message_id, run_id=run.id)
            self.sessions.save(transcript, fsync=True)
            run = self.store.transition_run(run.id, run.revision, RunStatus.PREPARING)
        except BaseException:
            del transcript.messages[original_length:]
            self.sessions.invalidate(session.transcript_key)
            current = self.store.get_run(run.id)
            if current.status == RunStatus.QUEUED:
                self.store.transition_run(current.id, current.revision, RunStatus.FAILED, error_code="request_not_persisted")
            raise
        self._current[binding.id] = run.id
        task = asyncio.create_task(self._dispatch(run, binding, message), name=f"native-dispatch-{run.id}")
        self._dispatches[run.id] = task
        task.add_done_callback(lambda _: self._dispatches.pop(run.id, None))
        return run

    async def _dispatch(self, run: Run, binding: Binding, message: str) -> None:
        packet = None
        try:
            packet = self.store.reserve_handoff(binding.id, run.id)
            wire_message = packet.content + "\n\n" + message if packet else message
            self._sent.add(run.id)
            receipt = await self._adapters[binding.id].send(binding, run.request_id, wire_message)
            current = self.store.get_run(run.id)
            if receipt.input_id != run.request_id:
                raise DevelopmentError("native_input_mismatch", "原生派发回执属于另一输入。")
            if packet:
                outcome = "unknown" if receipt.outcome == "queued" else receipt.outcome
                self._resolve_packet(binding.id, packet.id, run.request_id, outcome)
            if receipt.outcome == "accepted":
                if not receipt.native_turn_id:
                    raise DevelopmentError("missing_native_turn", "已接受的请求缺少原生轮次标识。")
                current = self.store.bind_native_turn(run.id, binding.id, receipt.native_turn_id)
                if current.status == RunStatus.PREPARING:
                    self.store.transition_run(current.id, current.revision, RunStatus.RUNNING)
            elif receipt.outcome == "rejected":
                target = RunStatus.FAILED if current.status == RunStatus.PREPARING and not current.native_turn_id else RunStatus.UNKNOWN
                self._end_if_active(run.id, target, "native_dispatch_rejected")
            elif receipt.outcome == "unknown":
                self._end_if_active(run.id, RunStatus.UNKNOWN, "native_dispatch_unknown")
        except asyncio.CancelledError:
            self._uncertain(run, binding, packet)
            raise
        except Exception:
            # Keep native/SDK exceptions (which may contain secrets) out of logs.
            self._uncertain(run, binding, packet)

    def _uncertain(self, run: Run, binding: Binding, packet: Any) -> None:
        if packet is not None:
            self._resolve_packet(binding.id, packet.id, run.request_id, "unknown")
        self._end_if_active(run.id, RunStatus.UNKNOWN, "native_dispatch_unknown")

    def _resolve_packet(self, binding_id: str, packet_id: str, input_id: str, outcome: str) -> None:
        packet = self.store.get_binding(binding_id).handoff
        if packet and packet.id == packet_id and packet.input_id == input_id:
            self.store.resolve_handoff(binding_id, packet_id, input_id, outcome)
        # A delayed dispatch acknowledgement must not consume a newer handoff.

    def _end_if_active(self, run_id: str, status: RunStatus, reason: str) -> None:
        current = self.store.get_run(run_id)
        if current.status in TERMINAL_RUN_STATUSES or current.status == status:
            return
        if current.status == RunStatus.UNKNOWN:
            return  # Reconciliation requires actual native evidence, not caller intent.
        self.store.transition_run(current.id, current.revision, status, error_code=reason)

    async def _consume(self, binding: Binding) -> None:
        try:
            async for event in self._adapters[binding.id].events(binding):
                run_id = self._current.get(binding.id)
                if run_id is None or event.type.startswith("session."):
                    continue
                run = self.store.get_run(run_id)
                if run.status in TERMINAL_RUN_STATUSES:
                    continue
                if event.native_turn_id:
                    if run.native_turn_id is None:
                        if event.type != "run.started" or run.status not in {RunStatus.PREPARING, RunStatus.UNKNOWN}:
                            raise DevelopmentError("native_turn_unbound", "原生事件先于可靠的轮次绑定。")
                        run = self.store.bind_native_turn(run.id, binding.id, event.native_turn_id)
                    elif event.native_turn_id != run.native_turn_id:
                        continue  # Old turn callbacks cannot affect the current request.
                elif event.type not in {"run.unknown"}:
                    continue
                self._record(run, binding, event)
        except asyncio.CancelledError:
            raise
        except Exception:
            run_id = self._current.get(binding.id)
            if run_id:
                self._end_if_active(run_id, RunStatus.UNKNOWN, "native_event_stream_failed")
        finally:
            run_id = self._current.get(binding.id)
            if run_id:
                self._end_if_active(run_id, RunStatus.UNKNOWN, "native_event_stream_ended")

    def _record(self, run: Run, binding: Binding, event: NativeEvent) -> None:
        payload = dict(event.payload)
        target = _TERMINALS.get(event.type)
        if event.type == "run.started":
            target = RunStatus.RUNNING if run.status != RunStatus.INTERRUPTING else None
            packet = self.store.get_binding(binding.id).handoff
            if packet and packet.input_id == run.request_id and packet.state in {"reserved", "unknown"}:
                self.store.resolve_handoff(binding.id, packet.id, run.request_id, "accepted")
        elif event.type == "run.unknown":
            target = RunStatus.UNKNOWN
        elif event.type == "approval.requested" and run.status == RunStatus.RUNNING:
            target = RunStatus.WAITING_USER
        elif event.type == "approval.resolved" and run.status == RunStatus.WAITING_USER:
            target = RunStatus.RUNNING
        if run.status == RunStatus.UNKNOWN and target not in {None, RunStatus.UNKNOWN}:
            run = self.store.transition_run(run.id, run.revision, RunStatus.RECOVERING)
        if event.type in {"agent.message.delta", "agent.message.completed"}:
            payload = self._store_message(run, binding, event)
        if target in TERMINAL_RUN_STATUSES:
            transcript = self.sessions.get_or_create(self.store.get_session(run.session_id).transcript_key)
            result = next((m.get("id") for m in reversed(transcript.messages)
                           if m.get("run_id") == run.id and m.get("role") == "assistant"), None)
            payload["resultMessageId"] = result
        stable_part = event.native_event_id
        if stable_part is None and event.type in {"run.started", *_TERMINALS, "agent.message.completed"}:
            stable_part = event.type + ":" + str(event.payload.get("itemId", ""))
        event_id = _stable_id("event", run.id, stable_part) if stable_part else new_id("event")
        self.store.record_native_event(run.id, binding.id, event_id, event.type, payload, status=target)
        if target in TERMINAL_RUN_STATUSES:
            self._sent.discard(run.id)

    def _store_message(self, run: Run, binding: Binding, event: NativeEvent) -> dict[str, Any]:
        item_id = event.payload.get("itemId")
        content = event.payload.get("text" if event.type.endswith("completed") else "delta")
        if not isinstance(item_id, str) or not item_id or not isinstance(content, str):
            raise DevelopmentError("invalid_native_message", "原生消息缺少标识或正文。")
        session = self.store.get_session(run.session_id)
        transcript = self.sessions.get_or_create(session.transcript_key)
        message_id = _stable_id("message", run.id, item_id)
        existing = next((m for m in transcript.messages if m.get("id") == message_id), None)
        if existing is None:
            transcript.add_message("assistant", "", id=message_id, run_id=run.id,
                                   author_id=binding.executor.value, native_item_id=item_id)
            existing = transcript.messages[-1]
        updated = content if event.type.endswith("completed") else existing["content"] + content
        if len(updated) > 2_097_152:
            self.sessions.invalidate(session.transcript_key)
            raise DevelopmentError("native_message_too_large", "原生消息需要分段归档，未把截断文本作为完整结果。")
        existing["content"] = updated
        transcript.update_ui_summary(existing)
        self.sessions.save(transcript, fsync=True)
        # Body has one authoritative home (SessionManager), not a second DB copy.
        return {"messageId": message_id, "nativeItemId": item_id, "complete": event.type.endswith("completed")}

    async def interrupt(self, run_id: str) -> Run:
        run = self.store.get_run(run_id)
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        if run.binding_id not in self._adapters or run.status in {RunStatus.UNKNOWN, RunStatus.RECOVERING}:
            raise ConflictError("请先核对执行者状态，不能确认结果未知的任务已经停止。")
        if run.status != RunStatus.INTERRUPTING:
            run = self.store.transition_run(run.id, run.revision, RunStatus.INTERRUPTING)
        if run.id not in self._sent and run.native_turn_id is None:
            task = self._dispatches.get(run.id)
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            current = self.store.get_run(run.id)
            if current.status == RunStatus.INTERRUPTING:
                return self.store.transition_run(current.id, current.revision, RunStatus.INTERRUPTED)
            return current
        binding = self.store.get_binding(run.binding_id)
        try:
            receipt = await self._adapters[binding.id].interrupt(binding)
            if receipt.outcome == "unknown":
                self._end_if_active(run.id, RunStatus.UNKNOWN, "native_interrupt_unknown")
            # Confirmation arrives through native events; never infer all child processes stopped.
        except RpcError:
            self._end_if_active(run.id, RunStatus.UNKNOWN, "native_interrupt_unknown")
        return self.store.get_run(run.id)

    async def recover(self, run_id: str) -> Run:
        """Reconcile only a known native turn; missing identity is not retry authority."""
        run = self.store.get_run(run_id)
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        if run.status != RunStatus.UNKNOWN or not run.binding_id or not run.native_turn_id:
            raise ConflictError("需要结果未知且已有原生标识的轮次，未重新发送任何请求。")
        adapter = self._adapters.get(run.binding_id)
        if adapter is None:
            raise ConflictError("请先恢复当前执行者的原生会话。")
        binding = self.store.get_binding(run.binding_id)
        events = await adapter.inspect_turn(binding, run.native_turn_id)
        if not events or events[-1].type not in _TERMINALS or any(e.native_turn_id != run.native_turn_id for e in events):
            raise DevelopmentError("native_history_incomplete", "原生恢复结果不完整，未推断任务已完成。")
        current = self.store.get_run(run.id)
        if current.status in TERMINAL_RUN_STATUSES:
            return current
        current = self.store.transition_run(current.id, current.revision, RunStatus.RECOVERING)
        for event in events:
            current = self.store.get_run(run.id)
            if current.status in TERMINAL_RUN_STATUSES:
                break
            self._record(current, binding, event)
        return self.store.get_run(run.id)

    async def close(self) -> None:
        """Stop service observation, not remote work. Adapter supervisor owns shutdown."""
        self._closed = True
        tasks = [*self._dispatches.values(), *self._consumers.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for run_id in self._current.values():
            self._end_if_active(run_id, RunStatus.UNKNOWN, "native_service_closed")
