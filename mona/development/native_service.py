"""Persistent native execution coordinator, independent of panes and HTTP requests.

Adapters own native execution; this layer owns Mona runs, transcript references
and the handoff dispatch boundary. A consumer never restarts a lost write request.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

from loguru import logger

from mona.development.contracts import (
    TERMINAL_RUN_STATUSES,
    Binding,
    ExecutorId,
    InputState,
    Run,
    RunInput,
    RunStatus,
    new_id,
)
from mona.development.display_content import display_content
from mona.development.executors.base import Executor, NativeEvent
from mona.development.executors.rpc import RpcError
from mona.development.input_content import (
    MessageContent,
    encoded_content,
    validate_content,
    with_context,
)
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore, NotFoundError
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
        self._steering_responses: dict[tuple[str, str], list[str]] = {}
        self._closed = False
        self._changed: dict[str, asyncio.Event] = {}

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

    def is_dispatching(self, run_id: str) -> bool:
        task = self._dispatches.get(run_id)
        return task is not None and not task.done()

    async def submit(self, session_id: str, request_id: str, message: MessageContent, *, message_id: str | None = None,
                     runtime_context: str = "", display_content: str | None = None, input_source: dict | None = None) -> Run:
        validate_content(message)
        if self._closed:
            raise DevelopmentError("invalid_request", "开发请求不能为空、过长或发给已关闭的服务。")
        session = self.store.get_session(session_id)
        bindings = [b for b in self.store.list_bindings(session_id) if b.state == "active" and b.executor == session.executor]
        if len(bindings) != 1:
            raise ConflictError("请先建立当前执行者的原生会话。")
        binding = bindings[0]
        message_id = message_id or _stable_id("message", session_id, request_id, encoded_content(message))
        transcript = self.sessions.get_or_create(session.transcript_key)
        prior_message = next((m for m in transcript.messages if m.get("id") == message_id), None)
        if prior_message and prior_message.get("content") != message:
            raise ConflictError("相同请求标识携带了不同内容，未重复执行。")
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
            if prior_message:
                transcript.messages.remove(prior_message)
            transcript.add_message("user", message, id=message_id, run_id=run.id, request_id=request_id,
                                   _runtime_input=bool(input_source and input_source.get("kind") == "collaboration_result"), _input_source=input_source,
                                   **({"_display_content": display_content} if display_content is not None else {}))
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
        task = asyncio.create_task(self._dispatch(run, binding, message, runtime_context), name=f"native-dispatch-{run.id}")
        self._dispatches[run.id] = task
        task.add_done_callback(lambda _: self._dispatches.pop(run.id, None))
        return run

    def check_steering(self, run: Run) -> Binding:
        if not run.binding_id or not run.native_turn_id or run.status not in {RunStatus.RUNNING, RunStatus.WAITING_USER}:
            raise ConflictError("当前轮次尚未就绪或已经结束，请保留消息并核对任务。")
        binding = self.store.get_binding(run.binding_id)
        if not binding.capabilities.steering:
            raise DevelopmentError("steering_unsupported", "当前引擎不支持引导运行中的任务。")
        if binding.id not in self._adapters or self._consumers[binding.id].done() or self._current.get(binding.id) != run.id:
            raise ConflictError("当前轮次连接未就绪，请保留消息并核对任务。")
        return binding

    async def steer(self, item: RunInput, message: MessageContent) -> RunInput:
        run = self.store.get_run(item.run_id)
        binding = self.check_steering(run)
        reserved = self.store.transition_input(item.id, item.revision, InputState.RESERVED)
        try:
            receipt = await self._adapters[binding.id].steer(binding, item.id, message)
            if receipt.input_id != item.id or receipt.native_turn_id != run.native_turn_id and receipt.outcome == "accepted":
                raise DevelopmentError("native_steering_unknown", "引导回执不属于原轮次，请核对原请求。")
            if receipt.outcome == "accepted":
                accepted = self.store.transition_input(item.id, reserved.revision, InputState.ACCEPTED)
                transcript = self.sessions.get_or_create(self.store.get_session(run.session_id).transcript_key)
                original = next(m for m in transcript.messages if m.get("id") == item.message_id)
                original.update(_ui_only=False, run_id=run.id, source_kind="steering")
                self.sessions.save(transcript, fsync=True)
                return accepted
            if receipt.outcome == "rejected":
                self.store.transition_input(item.id, reserved.revision, InputState.REJECTED)
                raise DevelopmentError("native_steering_rejected", "本次引导未被接受，消息已保留，请核对当前任务。")
        except DevelopmentError as exc:
            if exc.code == "native_steering_rejected":
                raise
        except asyncio.CancelledError:
            self.store.transition_input(item.id, self.store.get_input(item.id).revision, InputState.UNKNOWN)
            self._end_if_active(run.id, RunStatus.UNKNOWN, "native_steering_unknown")
            raise
        except Exception:
            pass  # The durable input below remains unknown and is never replayed.
        self.store.transition_input(item.id, self.store.get_input(item.id).revision, InputState.UNKNOWN)
        self._end_if_active(run.id, RunStatus.UNKNOWN, "native_steering_unknown")
        raise DevelopmentError("native_steering_unknown", "引导结果待核对，原请求已保留，不会自动重复发送。")

    async def _dispatch(self, run: Run, binding: Binding, message: MessageContent, runtime_context: str = "") -> None:
        packet = None
        try:
            packet = self.store.reserve_handoff(binding.id, run.id)
            wire_message = with_context(message, packet.content if packet else "", runtime_context)
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
                current = self.store.record_native_dispatch(run.id, binding.id, "accepted")
                if current.status == RunStatus.PREPARING:
                    self.store.transition_run(current.id, current.revision, RunStatus.RUNNING)
            elif receipt.outcome == "rejected":
                self.store.record_native_dispatch(run.id, binding.id, "rejected")
                target = RunStatus.FAILED if current.status == RunStatus.PREPARING and not current.native_turn_id else RunStatus.UNKNOWN
                self._end_if_active(run.id, target, "native_dispatch_rejected")
            elif receipt.outcome in {"unknown", "queued"}:
                # This service owns the input queue. An upstream queue receipt
                # proves neither acceptance nor safe re-dispatch.
                self.store.record_native_dispatch(run.id, binding.id, "unknown")
                self._end_if_active(run.id, RunStatus.UNKNOWN, "native_dispatch_unknown")
        except asyncio.CancelledError:
            self._uncertain(run, binding, packet)
            raise
        except Exception:
            # Keep native/SDK exceptions (which may contain secrets) out of logs.
            self._uncertain(run, binding, packet)
        finally:
            if run.id in self._changed:
                self._changed[run.id].set()

    def _uncertain(self, run: Run, binding: Binding, packet: Any) -> None:
        try:
            self.store.get_run(run.id)
        except NotFoundError:
            return
        self.store.record_native_dispatch(run.id, binding.id, "unknown")
        if packet is not None:
            self._resolve_packet(binding.id, packet.id, run.request_id, "unknown")
        self._end_if_active(run.id, RunStatus.UNKNOWN, "native_dispatch_unknown")

    def _resolve_packet(self, binding_id: str, packet_id: str, input_id: str, outcome: str) -> None:
        packet = self.store.get_binding(binding_id).handoff
        if packet and packet.id == packet_id and packet.input_id == input_id:
            self.store.resolve_handoff(binding_id, packet_id, input_id, outcome)
        # A delayed dispatch acknowledgement must not consume a newer handoff.

    def _end_if_active(self, run_id: str, status: RunStatus, reason: str) -> None:
        try:
            current = self.store.get_run(run_id)
        except NotFoundError:
            return
        if current.status in TERMINAL_RUN_STATUSES or current.status in {status, RunStatus.WAITING_CHILDREN}:
            return
        if current.status == RunStatus.UNKNOWN:
            return  # Reconciliation requires actual native evidence, not caller intent.
        self.store.transition_run(current.id, current.revision, status, error_code=reason)
        if run_id in self._changed:
            self._changed[run_id].set()

    async def _consume(self, binding: Binding) -> None:
        try:
            async for event in self._adapters[binding.id].events(binding):
                run_id = self._current.get(binding.id)
                if run_id is None or event.type.startswith("session."):
                    continue
                run = self.store.get_run(run_id)
                if run.status in TERMINAL_RUN_STATUSES or run.status == RunStatus.WAITING_CHILDREN:
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
        except Exception as exc:
            run_id = self._current.get(binding.id)
            if run_id:
                logger.warning("Native event stream failed for run {} binding {} ({})",
                               run_id, binding.id, exc.code if isinstance(exc, DevelopmentError) else type(exc).__name__)
                self._end_if_active(run_id, RunStatus.UNKNOWN, "native_event_stream_failed")
        finally:
            run_id = self._current.get(binding.id)
            if run_id:
                self._end_if_active(run_id, RunStatus.UNKNOWN, "native_event_stream_ended")

    def _record(self, run: Run, binding: Binding, event: NativeEvent) -> None:
        payload = dict(event.payload)
        if event.type == "usage.updated":
            session = self.store.get_session(run.session_id)
            payload.update(executor=binding.executor.value, selectedModel=session.model,
                           modelProvider=binding.model_provider)
        stable_part = event.native_event_id
        if stable_part is None and event.type in {"run.started", *_TERMINALS, "agent.message.started", "agent.message.completed"}:
            stable_part = event.type + ":" + str(event.payload.get("itemId", ""))
        event_id = _stable_id("event", run.id, stable_part) if stable_part else new_id("event")
        source_sha = hashlib.sha256(json.dumps(event.payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        if self.store.native_event_recorded(event_id, run.id, event.type, source_sha):
            return
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
            payload = self._store_message(run, binding, event, event_id, source_sha)
        elif event.type == "tool.completed" and event.payload.get("kind") == "imageGeneration" and "content" in event.payload:
            image_event = event.model_copy(update={"type": "agent.message.completed"})
            payload = {"itemId": event.payload["itemId"], "kind": "imageGeneration", "status": event.payload["status"],
                       **self._store_message(run, binding, image_event, event_id, source_sha)}
        if target in TERMINAL_RUN_STATUSES:
            transcript = self.sessions.get_or_create(self.store.get_session(run.session_id).transcript_key)
            result = next((m.get("id") for m in reversed(transcript.messages)
                           if m.get("run_id") == run.id and m.get("role") == "assistant"), None)
            payload["resultMessageId"] = result
        payload["sourceSha256"] = source_sha
        self.store.record_native_event(run.id, binding.id, event_id, event.type, payload, status=target)
        response_key = (run.id, str(event.payload.get("itemId", "")))
        if event.type == "agent.message.started":
            self._steering_responses[response_key] = [item.id for item in self.store.list_inputs(run.id)
                if item.intent == "steering" and item.state == InputState.ACCEPTED]
        elif event.type == "agent.message.completed":
            for identifier in self._steering_responses.pop(response_key, []):
                item = self.store.get_input(identifier)
                if item.state == InputState.ACCEPTED:
                    self.store.transition_input(item.id, item.revision, InputState.CONSUMED)
        if target in TERMINAL_RUN_STATUSES:
            self._sent.discard(run.id)
        if run.id in self._changed:
            self._changed[run.id].set()

    def _store_message(self, run: Run, binding: Binding, event: NativeEvent, event_id: str, source_sha: str) -> dict[str, Any]:
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
            if event.payload.get("kind") == "imageGeneration":
                # Restored image events belong beside their original run, not a later user request.
                previous = [i for i, message in enumerate(transcript.messages[:-1])
                            if message.get("run_id") == run.id and message.get("role") == "assistant"]
                if previous:
                    transcript.messages.insert(previous[-1] + 1, transcript.messages.pop())
        # A crash can happen after transcript fsync and before the event DB commit.
        # Keep one write-ahead marker per message; older events are in the event DB.
        marker = existing.get("_native_pending_event")
        response = {"messageId": message_id, "nativeItemId": item_id, "complete": event.type.endswith("completed")}
        if marker and marker.get("id") == event_id:
            if marker.get("sha256") != source_sha:
                raise ConflictError("原生消息回放内容不一致。")
            return response
        existing["_native_pending_event"] = {"id": event_id, "sha256": source_sha}
        updated = content if event.type.endswith("completed") else existing["content"] + content
        media = []
        if event.type.endswith("completed") and isinstance(event.payload.get("content"), list):
            updated, media = display_content(event.payload["content"])
        if event.payload.get("kind") == "imageGeneration":
            from mona.development.output_media import materialize_generated_image
            project = self.store.get_project(session.project_id)
            owner = "".join(c if c.isascii() and (c.isalnum() or c in "-_") else "_" for c in binding.native_session_id)
            artifact_root = self.store.path.parent.resolve() / "native" / "codex" / "generated_images" / owner
            for image in media:
                try:
                    image["url"] = materialize_generated_image(project, artifact_root, image["url"])
                except (DevelopmentError, OSError) as error:
                    logger.warning("Generated image unavailable for session {} item {} ({})", session.id, item_id, type(error).__name__)
                    image["url"] = ""
        size = len(updated) + (len(json.dumps(media, ensure_ascii=False)) if media else 0)
        if size > 2_097_152:
            self.sessions.invalidate(session.transcript_key)
            raise DevelopmentError("native_message_too_large", "原生消息需要分段归档，未把截断文本作为完整结果。")
        existing["content"] = updated
        if event.type.endswith("completed"):
            # Keep vendor media schemas out of text-only handoff/collaboration
            # and subsequent model requests; these attachments belong to display.
            if media:
                existing["_display_media"] = media
            else:
                existing.pop("_display_media", None)
        transcript.update_ui_summary(existing)
        self.sessions.save(transcript, fsync=True)
        # Body has one authoritative home (SessionManager), not a second DB copy.
        return response

    def restore_generated_images(self, session_id: str) -> None:
        from mona.development.executors.codex_events import normalize_codex_event

        def sanitize(value: str) -> str:
            return "".join(c if c.isascii() and (c.isalnum() or c in "-_") else "_" for c in value)

        for old in self.store.list_unmaterialized_images(session_id):
            if old.run_id is None:
                continue
            run = self.store.get_run(old.run_id)
            if run.status not in TERMINAL_RUN_STATUSES or run.executor != ExecutorId.CODEX or not run.binding_id:
                continue
            binding = self.store.get_binding(run.binding_id)
            item_id = old.payload.get("itemId")
            if not isinstance(item_id, str) or not item_id:
                continue
            source = (self.store.path.parent.resolve() / "native" / "codex" / "generated_images"
                      / sanitize(binding.native_session_id) / (sanitize(item_id) + ".png"))
            if not source.is_file():
                continue
            event = normalize_codex_event("item/completed", {"threadId": binding.native_session_id,
                "turnId": run.native_turn_id, "item": {"id": item_id, "type": "imageGeneration",
                    "status": "completed", "savedPath": str(source)}})
            assert event is not None
            self._record(run, binding, event)

    async def interrupt(self, run_id: str) -> Run:
        run = self.store.get_run(run_id)
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        if run.binding_id not in self._adapters:
            raise ConflictError("暂时无法停止任务，已有改动可能已生效。请稍后再试。")
        unsent = run.status in {RunStatus.QUEUED, RunStatus.PREPARING} and run.id not in self._sent and run.native_turn_id is None
        if run.status == RunStatus.UNKNOWN:
            run = self.store.transition_run(run.id, run.revision, RunStatus.RECOVERING)
        if run.status != RunStatus.INTERRUPTING:
            run = self.store.transition_run(run.id, run.revision, RunStatus.INTERRUPTING)
        if unsent:
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
            receipt = await self._adapters[binding.id].interrupt(binding, native_turn_id=run.native_turn_id)
            if receipt.outcome in {"unknown", "already_finished"}:
                self._end_if_active(run.id, RunStatus.UNKNOWN, "native_interrupt_unknown")
            elif receipt.outcome == "confirmed":
                self._end_if_active(run.id, RunStatus.INTERRUPTED, "native_interrupt_confirmed")
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
        if not events or events[-1].type not in {*_TERMINALS, "run.started"} or any(e.native_turn_id != run.native_turn_id for e in events):
            raise DevelopmentError("native_history_incomplete", "原生恢复结果不完整，未推断任务已完成。")
        current = self.store.get_run(run.id)
        if current.status in TERMINAL_RUN_STATUSES:
            return current
        current = self.store.transition_run(current.id, current.revision, RunStatus.RECOVERING)
        try:
            for event in events:
                current = self.store.get_run(run.id)
                if current.status in TERMINAL_RUN_STATUSES:
                    break
                if event.type == "run.started":
                    event = event.model_copy(update={"native_event_id": f"recovered:{run.revision}:{event.type}"})
                self._record(current, binding, event)
        except Exception:
            self._end_if_active(run.id, RunStatus.UNKNOWN, "native_history_incomplete")
            raise
        return self.store.get_run(run.id)

    async def wait_for_dispatch(self, run_id: str) -> Run:
        signal = self._changed.setdefault(run_id, asyncio.Event())
        while True:
            signal.clear()
            run = self.store.get_run(run_id)
            if run.native_dispatch != "pending" or run.status in TERMINAL_RUN_STATUSES or run.status == RunStatus.UNKNOWN:
                return run
            await signal.wait()

    async def wait_for_outcome(self, run_id: str) -> Run:
        signal = self._changed.setdefault(run_id, asyncio.Event())
        try:
            while True:
                signal.clear()
                run = self.store.get_run(run_id)
                if run.status in TERMINAL_RUN_STATUSES or run.status in {RunStatus.UNKNOWN, RunStatus.WAITING_CHILDREN}:
                    return run
                await signal.wait()
        finally:
            self._changed.pop(run_id, None)

    async def detach(self, binding_id: str) -> None:
        task = self._consumers.pop(binding_id, None)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._adapters.pop(binding_id, None)
        self._current.pop(binding_id, None)

    async def close(self) -> None:
        """Stop service observation, not remote work. Adapter supervisor owns shutdown."""
        self._closed = True
        tasks = [*self._dispatches.values(), *self._consumers.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for run_id in self._current.values():
            self._end_if_active(run_id, RunStatus.UNKNOWN, "native_service_closed")
