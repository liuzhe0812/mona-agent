"""Gateway-owned Coding sessions, independent of browser panes and module visibility."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

from loguru import logger

from mona.agent.hook import AgentHook, AgentHookContext
from mona.agent.runner import AgentRunner
from mona.config.schema import Config
from mona.development.browser import DevelopmentBrowser, get_binding
from mona.development.coding import CodingTools, build_coding_run_spec, prepare_coding_extensions
from mona.development.collaboration import CollaborationManager, DevelopmentDelegate
from mona.development.compaction import summary_text
from mona.development.context import collaboration_context, load_project_context
from mona.development.continuation import CodingContinuation
from mona.development.contracts import (
    TERMINAL_RUN_STATUSES,
    DevelopmentSession,
    ExecutorId,
    InputState,
    PermissionMode,
    Run,
    RunInput,
    RunStatus,
)
from mona.development.display_content import display_content
from mona.development.git_operations import GitOperations
from mona.development.input_content import MAX_IMAGE_BYTES, MessageContent, validate_content
from mona.development.model_selection import resolve_coding_model
from mona.development.native_collaboration import NativeCollaboration
from mona.development.native_manager import NativeExecutorManager
from mona.development.permissions import DevelopmentPermissions
from mona.development.plan import DevelopmentPlanTool
from mona.development.result_continuation import continue_required_results, model_route
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore, NotFoundError
from mona.development.updates import DevelopmentUpdates
from mona.providers.factory import build_provider_snapshot
from mona.session.manager import SessionManager
from mona.utils.document import extract_documents
from mona.utils.helpers import build_image_content_blocks, detect_image_mime


def stable_id(kind: str, *parts: str) -> str:
    return kind + "_" + hashlib.sha256("\x00".join(parts).encode()).hexdigest()[:40]


def public_message(message: dict) -> dict:
    # Native reasoning and provider-private fields never enter the display contract.
    content, media = display_content(message.get("_display_content", message.get("content", "")))
    if "_display_content" in message and isinstance(message.get("content"), list):
        _, media = display_content(message["content"])
    media = [*media, *message.get("_display_media", [])]
    # Tool logs have a separate full-record viewer. Conversation Markdown must
    # retain complete fences, tables and formulae after a streamed turn finishes.
    truncated = message.get("role") == "tool" and len(content) > 24000
    return {"id": message.get("id", ""), "role": message.get("role"), "content": content[:24000] if truncated else content,
            **({"media": media} if media else {}),
            "truncated": truncated, "runId": message.get("run_id"),
            "authorId": message.get("author_id", "mona"),
            "sourceKind": message.get("source_kind"), "childSessionId": message.get("child_session_id"),
            "name": message.get("name"), "toolCallId": message.get("tool_call_id"),
            "toolCalls": message.get("tool_calls", []),
            "queued": bool(message.get("_ui_only")) and message.get("source_kind") != "collaboration", "timestamp": message.get("timestamp")}


class _CodingHook(AgentHook):
    def __init__(self, runtime: DevelopmentRuntime, run: Run):
        super().__init__(reraise=True)
        self.runtime, self.run = runtime, run
        self.iteration = -1
        self.live_iteration = -1
        self.context: AgentHookContext | None = None
        self.reasoning_item_id = ""
        self.reasoning_started_at: float | None = None
        self.snapshot_reasoning = False
        self.reasoning_text = ""
        self.reasoning_closed = False

    def wants_streaming(self) -> bool:
        return True

    async def before_iteration(self, context: AgentHookContext) -> None:
        self.context = context
        self.reasoning_item_id = stable_id("reasoning", self.run.id, str(context.iteration))
        self.reasoning_started_at = None
        self.snapshot_reasoning = False
        self.reasoning_text = ""
        self.reasoning_closed = False

    async def emit_reasoning(self, reasoning_content: str | None) -> None:
        if not reasoning_content or self.context is None:
            return
        if self.run.id in self.runtime._deleted_runs:
            raise asyncio.CancelledError
        if not self.context.streamed_reasoning:
            self.snapshot_reasoning = True
            self.reasoning_text = reasoning_content
            return
        if self.reasoning_closed:
            return
        if self.reasoning_started_at is None:
            self.reasoning_started_at = time.monotonic()
            self.runtime.store.append_run_event(self.run.id, "reasoning.started", {
                "itemId": self.reasoning_item_id,
            })
        self.runtime.store.append_run_event(self.run.id, "reasoning.delta", {
            "itemId": self.reasoning_item_id, "delta": reasoning_content,
        })

    async def emit_reasoning_end(self) -> None:
        if self.reasoning_started_at is not None:
            self.reasoning_closed = True
            duration_ms = max(0, round((time.monotonic() - self.reasoning_started_at) * 1000))
            self.runtime.store.append_run_event(self.run.id, "reasoning.completed", {
                "itemId": self.reasoning_item_id, "durationMs": duration_ms,
            })
            self.reasoning_started_at = None
        elif self.snapshot_reasoning:
            self.reasoning_closed = True
            self.runtime.store.append_run_event(self.run.id, "reasoning.completed", {
                "itemId": self.reasoning_item_id, "text": self.reasoning_text,
            })
            self.snapshot_reasoning = False

    async def on_stream_end(self, context: AgentHookContext, *, resuming: bool) -> None:
        await self.emit_reasoning_end()

    async def on_stream(self, context: AgentHookContext, delta: str) -> None:
        if self.run.id in self.runtime._deleted_runs:
            raise asyncio.CancelledError
        if delta:
            await self.emit_reasoning_end()
        if context.iteration != self.live_iteration:
            self.live_iteration = context.iteration
            self.runtime.live[self.run.session_id] = {"runId": self.run.id, "content": ""}
        live = self.runtime.live.setdefault(self.run.session_id, {"runId": self.run.id, "content": ""})
        if len(live["content"]) + len(delta) > 1_048_576:
            raise DevelopmentError("stream_too_large", "本轮输出过大，已保留执行检查点。")
        live["content"] += delta
        self.runtime.updates.notify()

    async def before_execute_tools(self, context: AgentHookContext) -> None:
        self.runtime.store.append_run_event(self.run.id, "tools.started", {
            "tools": [{"id": call.id, "name": call.name,
                       **({"path": call.arguments["path"]} if call.name in {"write_file", "edit_file"}
                          and isinstance(call.arguments, dict) and isinstance(call.arguments.get("path"), str) else {})}
                      for call in context.tool_calls],
        })

    async def after_iteration(self, context: AgentHookContext) -> None:
        if "context_tokens" not in context.usage:
            return
        session = self.runtime.store.get_session(self.run.session_id)
        self.runtime.store.append_run_event(self.run.id, "usage.updated", {
            "contextTokens": context.usage["context_tokens"],
            "contextWindow": context.usage.get("context_window_tokens"),
            "model": context.usage.get("context_model"), "executor": "mona",
            "selectedModel": session.model, "modelProvider": session.model_provider,
        })


class DevelopmentRuntime:
    def __init__(self, store: DevelopmentStore, sessions: SessionManager,
                 config_loader: Callable[[], Config], attachment_root: Path | None = None):
        self.store, self.sessions, self.config_loader = store, sessions, config_loader
        self.attachment_root = attachment_root.resolve() if attachment_root is not None else None
        self.updates = DevelopmentUpdates()
        self.store.on_change = self.updates.notify
        self.tasks: dict[str, asyncio.Task] = {}
        self.tools: dict[str, CodingTools] = {}
        self.live: dict[str, dict] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._closed = False
        self._deleted_runs: set[str] = set()
        self._deletion_tasks: set[asyncio.Task] = set()
        self._recovery_tasks: dict[str, asyncio.Task] = {}
        self._recovery_attempted: set[str] = set()
        self.store.reconcile_after_restart()
        self.collaboration = CollaborationManager(self)
        self.native_collaboration = NativeCollaboration(self)
        self.native = NativeExecutorManager(store, sessions, config_loader, tool_handler=self.native_collaboration)
        self.permissions = DevelopmentPermissions(store, sessions, self.native.decisions, config_loader)
        self.native.permission_handler = self.permissions.native_request
        self.git_operations = GitOperations(store)
        for pending in self.store.pending_result_runs():
            self._schedule_result_work(pending.id)

    def _schedule_result_work(self, run_id: str) -> None:
        if self._closed or run_id in self.tasks:
            return
        task = asyncio.create_task(self._after_run(run_id), name=f"development-results:{run_id}")
        self.tasks[run_id] = task
        task.add_done_callback(lambda done: self._task_done(run_id, done))

    async def _after_run(self, run_id: str) -> None:
        if self._closed or run_id in self._deleted_runs:
            return
        run = self.store.get_run(run_id)
        if run.status == RunStatus.WAITING_CHILDREN or run.continuation_input_id:
            await continue_required_results(self, run.id)
        elif run.status == RunStatus.SUCCEEDED:
            await self._next_input(run.session_id, run.id)

    def _lock(self, session_id: str) -> asyncio.Lock:
        return self._locks.setdefault(session_id, asyncio.Lock())

    def _prepare_input(self, content: str, doc_paths: list[str] | None,
                       document_names: list[str] | None) -> tuple[MessageContent, str]:
        paths = doc_paths or []
        if len(paths) > 16:
            raise DevelopmentError("too_many_attachments", "一次最多添加 16 个文件。")
        if not paths:
            if not content.strip():
                raise DevelopmentError("invalid_input", "输入不能为空或超过长度上限。")
            return content, content
        if self.attachment_root is None:
            raise DevelopmentError("attachments_unavailable", "当前开发会话无法读取附件，请稍后重试。")
        resolved: list[str] = []
        names: list[str] = []
        for index, raw in enumerate(paths):
            if not isinstance(raw, str) or not raw or len(raw) > 4096:
                raise DevelopmentError("invalid_attachment", "附件路径无效，请重新选择文件。")
            candidate = Path(raw)
            if candidate.is_absolute() or ".." in candidate.parts:
                raise DevelopmentError("invalid_attachment", "附件路径无效，请重新选择文件。")
            try:
                target = (self.attachment_root / candidate).resolve(strict=True)
            except (OSError, RuntimeError) as exc:
                raise DevelopmentError("attachment_unavailable", "附件已不可用，请重新选择文件。") from exc
            if not target.is_relative_to(self.attachment_root) or not target.is_file():
                raise DevelopmentError("invalid_attachment", "附件不属于当前上传区域，请重新选择文件。")
            resolved.append(str(target))
            supplied = document_names[index].strip() if document_names and index < len(document_names) and isinstance(document_names[index], str) else ""
            names.append((supplied or target.name)[:200])
        if any(Path(path).stat().st_size > 50 * 1024 * 1024 for path in resolved):
            raise DevelopmentError("attachments_too_large", "附件超过 50 MiB，请减少文件大小后重试。")
        enriched, images = extract_documents(content, resolved)
        blocks = [{"type": "text", "text": enriched}] if enriched.strip() else []
        image_bytes = 0
        for path in images:
            with Path(path).open("rb") as stream:
                raw = stream.read(MAX_IMAGE_BYTES - image_bytes + 1)
            image_bytes += len(raw)
            mime = detect_image_mime(raw)
            if image_bytes > MAX_IMAGE_BYTES or mime is None:
                raise DevelopmentError("invalid_image_attachment", "图片无效或总大小超过 8 MiB，请重新选择。")
            image = build_image_content_blocks(raw, mime, path, "")[0]
            image.pop("_meta", None)
            blocks.append(image)
        if len(enriched) > 120_000:
            raise DevelopmentError("attachments_too_large", "附件解析后的内容过大，请减少文件数量或大小。")
        if not enriched.strip() and not images:
            raise DevelopmentError("invalid_input", "输入和附件都没有可读取的内容。")
        prepared = blocks if images else enriched
        validate_content(prepared)
        visible = content.strip()
        attachment_line = "附件：" + "、".join(names)
        return prepared, f"{visible}\n\n{attachment_line}" if visible else attachment_line

    def resolve_session_title(self, session: DevelopmentSession) -> DevelopmentSession:
        if session.title_source != "default" or session.title != "新开发任务" or session.parent_session_id or session.readonly:
            return session
        transcript = self.sessions.get_or_create(session.transcript_key)
        first = next((m for m in transcript.messages if m.get("role") == "user"
            and m.get("source_kind") not in {"runtime", "collaboration"}
            and not any(m.get(key) for key in ("_ui_only", "_input_cancelled", "_runtime_input", "_collaboration_context", "injected_event"))), None)
        if first is None:
            return session
        original = (first.get("_input_source") or {}).get("content")
        text = original if isinstance(original, str) and original.strip() else public_message(first)["content"]
        title = " ".join(text.split())
        if not title:
            return session
        return self.store.set_message_title(session.id, title if len(title) <= 200 else title[:199] + "…")

    def snapshot(self, session_id: str, *, before: int | None = None, limit: int = 100, after: int = 0) -> dict:
        from mona.development.fork import snapshot_history

        session = self.resolve_session_title(self.store.get_session(session_id))
        transcript = self.sessions.get_or_create(session.transcript_key)
        end = min(len(transcript.messages), before if before is not None else len(transcript.messages))
        start = max(0, end - limit)
        runs, events = snapshot_history(self, session.id, transcript, after)
        binding = next((b for b in self.store.list_bindings(session.id)
                        if b.state == "active" and b.executor == session.executor), None)
        preview = get_binding(self, session.id)
        return {"session": session.model_dump(mode="json", by_alias=True),
                "messages": [public_message(m) for m in transcript.messages[start:end]
                    if not m.get("_input_cancelled") and not m.get("_input_delivered")
                    and not m.get("_collaboration_context") and not m.get("_runtime_input")],
                "before": start if start else None, "messageCount": len(transcript.messages),
                "runs": runs,
                "events": events,
                "eventCursor": events[-1]["sequence"] if events else after,
                "watchVersion": self.updates.version, "moreEvents": len(events) == 100,
                "live": self.live.get(session.id),
                "plan": self.store.latest_plan(session.id),
                "browserBinding": preview.model_dump(mode="json", by_alias=True) if preview else None,
                "nativeBinding": {"id": binding.id, "turnHistory": binding.capabilities.turn_history, "steering": binding.capabilities.steering,
                    "hostSubagents": binding.capabilities.host_subagents,
                    "replacesBindingId": binding.replaces_binding_id, "replacementReason": binding.replacement_reason} if binding else None,
                "pendingDecisions": self.native.decisions.list_pending(session.id, include_children=True),
                "pendingInputs": [{**item.model_dump(mode="json", by_alias=True),
                    "source": copy.deepcopy(next((m.get("_input_source") for m in transcript.messages if m.get("id") == item.message_id), None))}
                    for r in self.store.list_runs(session.id, 20) for item in self.store.list_inputs(r.id)
                    if item.state in {InputState.PENDING, InputState.RESERVED, InputState.UNKNOWN}
                    and not any(m.get("id") == item.message_id and m.get("_runtime_input") for m in transcript.messages)]}

    async def submit(self, session_id: str, request_id: str, content: str, *, intent: str = "follow_up",
                     expected_revision: int | None = None, doc_paths: list[str] | None = None,
                     document_names: list[str] | None = None, target_run_id: str | None = None,
                     follow_up_allowed: bool = True, authorize: Callable[[], None] | None = None) -> dict:
        if self._closed:
            raise DevelopmentError("shutting_down", "开发服务正在退出，请稍后重试。")
        async with self._lock(session_id):
            session = self.store.get_session(session_id)
            if len(content) > 200_000:
                raise DevelopmentError("invalid_input", "输入不能为空或超过长度上限。")
            input_source = {"content": content, "docPaths": list(doc_paths or []), "documentNames": list(document_names or [])}
            if intent not in {"steering", "follow_up"}:
                raise DevelopmentError("invalid_input_intent", "请选择补充当前任务或排队下一任务。")
            message_id = stable_id("message", session_id, request_id)
            transcript = self.sessions.get_or_create(session.transcript_key)
            prior = next((m for m in transcript.messages if m.get("id") == message_id), None)
            if prior and prior.get("_input_source") is not None:
                if prior["_input_source"] != input_source:
                    raise ConflictError("相同请求标识不能修改内容或附件，原请求未重复执行。")
                content, display_content = prior["content"], prior.get("_display_content", input_source["content"])
            else:
                content, display_content = self._prepare_input(content, doc_paths, document_names)
                if prior and prior.get("content") != content:
                    raise ConflictError("相同请求标识不能修改内容，原请求未重复执行。")
            # Query by request, not a bounded recent-run page: old retries remain idempotent.
            previous = self.store.find_run_request(session_id, request_id)
            if previous:
                return {"run": previous.model_dump(mode="json", by_alias=True), "queued": False, "reused": True}
            try:
                previous_input = self.store.get_input(request_id)
            except NotFoundError:
                previous_input = None
            if previous_input:
                if (previous_input.session_id != session_id or previous_input.intent != intent
                        or previous_input.follow_up_allowed != follow_up_allowed):
                    raise ConflictError("相同请求标识不能更换会话或发送方式。")
                if target_run_id is not None and previous_input.run_id != target_run_id:
                    raise ConflictError("引导目标轮次已变化，原请求没有重复执行。")
                return {"input": previous_input.model_dump(mode="json", by_alias=True), "queued": previous_input.state == InputState.PENDING, "reused": True}
            if session.executor != ExecutorId.MONA:
                if session.executor.value not in self.config_loader().development.enabled_engines:
                    raise DevelopmentError("engine_disabled", "此模型来源已停用，请在模型设置中启用后再调用。")
                if session.model_provider:
                    raise DevelopmentError("unsupported_model_route", "此任务使用了旧的跨引擎模型配置，请重新选择 Mona 或对应引擎自己的模型。")
            if expected_revision is not None and session.revision != expected_revision:
                raise ConflictError("主会话已变化，请重新确认当前模型与会话状态；没有发送新任务。")
            session = self.resolve_session_title(session)
            active = next((r for r in self.store.list_runs(session_id) if r.status not in TERMINAL_RUN_STATUSES), None)
            if intent == "steering" and (active is None or target_run_id is not None and active.id != target_run_id):
                raise ConflictError("目标轮次已结束或变化，消息已保留，请作为后续任务发送。")
            if active:
                if active.status in {RunStatus.UNKNOWN, RunStatus.RECOVERING, RunStatus.INTERRUPTING}:
                    raise ConflictError("当前执行尚未确认结束，输入草稿已保留。请先核对实际状态或使用另一会话。")
                if intent == "steering" and session.executor != ExecutorId.MONA:
                    self.native.service.check_steering(active)
                if not follow_up_allowed:
                    if intent != "steering" or active.status not in {RunStatus.RUNNING, RunStatus.WAITING_USER}:
                        raise ConflictError("原子任务尚未运行或已经结束，没有启动后续任务。")
                    outstanding = [i for i in self.store.list_inputs(active.id) if not i.follow_up_allowed
                                   and i.state in {InputState.PENDING, InputState.RESERVED, InputState.ACCEPTED, InputState.UNKNOWN}]
                    if len(outstanding) >= 8:
                        raise DevelopmentError("steering_queue_full", "子任务待确认纠偏已达上限，请先核对已有消息。")
                if authorize is not None:
                    authorize()
                if not prior:
                    transcript.add_message("user", content, id=message_id, request_id=request_id, _ui_only=True,
                                           input_intent=intent, _display_content=display_content, _input_source=input_source)
                    self.sessions.save(transcript, fsync=True)
                queued = self.store.enqueue_input(RunInput(id=request_id, session_id=session_id,
                    run_id=active.id, message_id=message_id, intent=intent, follow_up_allowed=follow_up_allowed))
                if intent == "steering" and session.executor != ExecutorId.MONA:
                    accepted = await self.native.service.steer(queued, content)
                    return {"input": accepted.model_dump(mode="json", by_alias=True), "queued": False}
                return {"input": queued.model_dump(mode="json", by_alias=True), "queued": True}
            result = await self._dispatch_start(session, request_id, message_id, content, display_content=display_content, input_source=input_source)
            self.resolve_session_title(self.store.get_session(session_id))
            return result

    async def _dispatch_start(self, session, request_id: str, message_id: str, content: MessageContent,
                              *, display_content: str | None = None, input_source: dict | None = None) -> dict:
        if session.executor == ExecutorId.MONA:
            return self._start(session, request_id, message_id, content, display_content=display_content, input_source=input_source)
        if session.executor.value not in self.config_loader().development.enabled_engines:
            raise DevelopmentError("engine_disabled", "此模型来源已停用，排队任务未自动执行。")
        binding = await self.native.ensure(session)
        transcript = self.sessions.get_or_create(session.transcript_key)
        include_source = binding.transcript_cursor == 0
        handoff = binding.handoff
        # Native handoffs carry transcript message IDs. Use that structure so a
        # bounded handoff can fall back to runtime context when it omitted the source.
        if include_source and handoff and handoff.state in {"pending", "reserved"}:
            source = next((message for message in reversed(transcript.messages)
                           if message.get("_collaboration_context")), None)
            if source is not None:
                source_id = source.get("id")
                _, separator, remainder = handoff.content.partition("\n")
                _, body_separator, body = remainder.partition("\n")
                end_marker = "\n[/Mona handoff — current user request follows]"
                serialized, end_separator, _ = body.rpartition(end_marker)
                if not isinstance(source_id, str) or not source_id or not separator or not body_separator or not end_separator:
                    raise DevelopmentError("invalid_handoff_context", "原生交接资料格式无效，未派发新任务。")
                try:
                    handoff_data = json.loads(serialized)
                except json.JSONDecodeError as exc:
                    raise DevelopmentError("invalid_handoff_context", "原生交接资料格式无效，未派发新任务。") from exc
                conversation = handoff_data.get("conversation") if isinstance(handoff_data, dict) else None
                if not isinstance(conversation, list) or any(not isinstance(item, dict) for item in conversation):
                    raise DevelopmentError("invalid_handoff_context", "原生交接资料格式无效，未派发新任务。")
                source_count = sum(item.get("messageId") == source_id for item in conversation)
                if source_count > 1:
                    raise DevelopmentError("invalid_handoff_context", "原生交接资料重复包含协作摘录，未派发新任务。")
                include_source = source_count == 0
        consumed = frozenset(record.id for record in self.store.list_collaborations(session.id)
                             if record.result_preview_received_by_run_id
                             and (consumer := self.store.get_run(record.result_preview_received_by_run_id)).binding_id == binding.id
                             and consumer.status == RunStatus.SUCCEEDED)
        incoming = content if (input_source or {}).get("kind") == "collaboration_result" else None
        shared = collaboration_context(transcript, include_source=include_source,
                                       replay_start=None, incoming_content=incoming, consumed_task_ids=consumed)
        if binding.capabilities.host_subagents:
            shared = "\n\n".join(part for part in [self.collaboration.scheduling_context(session.id), shared] if part)
        run = await self.native.service.submit(session.id, request_id, content, message_id=message_id,
                                               runtime_context=shared, display_content=display_content, input_source=input_source)
        if run.id not in self.tasks and run.status not in TERMINAL_RUN_STATUSES:
            task = asyncio.create_task(self._watch_native(run), name=f"development-native:{run.id}")
            self.tasks[run.id] = task
            task.add_done_callback(lambda done: self._task_done(run.id, done))
        return {"run": run.model_dump(mode="json", by_alias=True), "queued": False, "reused": False}

    async def _watch_native(self, run: Run) -> None:
        try:
            result = await self.native.service.wait_for_outcome(run.id)
            self.native.decisions.cancel_run(run.id)
            if result.status in TERMINAL_RUN_STATUSES | {RunStatus.WAITING_CHILDREN} and result.binding_id:
                session = self.store.get_session(run.session_id)
                transcript = self.sessions.get_or_create(session.transcript_key)
                self.store.update_binding_cursor(result.binding_id, len(transcript.messages))
            await self._after_run(run.id)
        except asyncio.CancelledError:
            if self._closed and self.store.get_run(run.id).status != RunStatus.WAITING_CHILDREN:
                self._end(run.id, RunStatus.UNKNOWN, "host_shutdown")
            raise

    async def set_permission_mode(self, session_id: str, revision: int, mode: PermissionMode, *, confirmed: bool = False):
        async with self._lock(session_id):
            session = self.store.get_session(session_id)
            if session.revision != revision:
                raise ConflictError("会话已更新，请重新选择权限；原设置没有改变。")
            if session.readonly or session.parent_session_id or session.archived:
                raise ConflictError("当前会话不能修改权限。")
            if self.store.active_run(session_id):
                raise ConflictError("当前任务尚未结束，请处理待办或停止任务后再切换权限。")
            if any(item.state in {InputState.PENDING, InputState.RESERVED, InputState.UNKNOWN}
                   for owner in self.store.list_runs(session_id) for item in self.store.list_inputs(owner.id)):
                raise ConflictError("仍有排队或待核对消息，请先处理这些消息再切换权限。")
            tools = self.tools.get(session_id)
            if tools and any(item.returncode is None for item in await tools.exec_sessions.list()):
                raise ConflictError("仍有运行中的终端命令，请先停止这些命令再切换权限。")
            if mode == PermissionMode.FULL_ACCESS and session.permission_mode != mode and not confirmed:
                raise ConflictError("请确认完全访问的授权范围后再切换。")
            if session.permission_mode == mode:
                return session
            if session.executor != ExecutorId.MONA:
                host = await self.native._host(session)
                probe = await host.probe()
                if mode not in probe.capabilities.permission_modes:
                    raise DevelopmentError("unsupported_permissions", "当前引擎版本不支持这个权限档位，请选择其它档位或更新引擎。")
                for binding in self.store.list_bindings(session_id):
                    loaded = self.native.loaded.get(binding.id)
                    if loaded and binding.state == "active":
                        await loaded[0].close_runtime(binding)
                        await self.native.service.detach(binding.id)
                        self.native.loaded.pop(binding.id, None)
            return self.store.set_permission_mode(session_id, revision, mode)

    async def select_model_source(self, session_id: str, revision: int, executor: ExecutorId,
                                  model: str | None, provider: str | None, effort: str | None):
        async with self._lock(session_id):
            if executor != ExecutorId.MONA:
                return await self.native.switch(session_id, revision, executor, model, effort, provider=provider)
            resolve_coding_model(self.config_loader(), model, provider, effort, require_visible=True)
            return self.store.select_mona(session_id, revision, model, provider=provider, effort=effort)

    async def switch_executor(self, session_id: str, revision: int, executor: ExecutorId, model: str | None):
        async with self._lock(session_id):
            return await self.native.switch(session_id, revision, executor, model)

    async def reconnect_native(self, session_id: str, revision: int, binding_id: str):
        async with self._lock(session_id):
            return await self.native.reconnect(session_id, revision, binding_id)

    async def close_unknown(self, session_id: str, run_id: str, revision: int, binding_id: str):
        async with self._lock(session_id):
            return await self.native.close_unknown(session_id, run_id, revision, binding_id)

    async def recover_native(self, session_id: str, run_id: str):
        async with self._lock(session_id):
            result = await self.native.recover(session_id, run_id)
        if result.status == RunStatus.SUCCEEDED:
            await self._next_input(session_id, run_id)
        elif result.status == RunStatus.WAITING_CHILDREN:
            self._schedule_result_work(run_id)
        return result

    def schedule_recovery(self, session_id: str) -> None:
        session = self.store.get_session(session_id)
        if self._closed or session.archived:
            return
        run = self.store.active_run(session_id)
        if (run is None or run.status != RunStatus.UNKNOWN or run.executor != ExecutorId.CODEX
                or not run.binding_id or run.id in self._recovery_attempted
                or self.native.service.is_dispatching(run.id)):
            return
        self._recovery_attempted.add(run.id)
        task = asyncio.create_task(self._restore_native_run(run), name=f"development-recovery:{run.id}")
        self._recovery_tasks[run.id] = task
        task.add_done_callback(lambda _: self._recovery_tasks.pop(run.id, None))

    async def _restore_native_run(self, run: Run) -> None:
        try:
            async with self._lock(run.session_id):
                if not self._closed and self.store.get_run(run.id).status == RunStatus.UNKNOWN:
                    # Observe only; recovering a result must not dispatch queued work.
                    await self.native.recover(run.session_id, run.id)
        except DevelopmentError as exc:
            logger.warning("Native run recovery unavailable for {} ({})", run.id, exc.code)
        except Exception as exc:
            logger.warning("Native run recovery failed for {} ({})", run.id, type(exc).__name__)

    def read_message(self, session_id: str, message_id: str, offset: int = 0, expected_sha: str | None = None) -> dict:
        session = self.store.get_session(session_id)
        transcript = self.sessions.get_or_create(session.transcript_key)
        message = next((m for m in transcript.messages if m.get("id") == message_id), None)
        if message is None:
            raise DevelopmentError("message_not_found", "原消息不存在，未读取其他会话。")
        content, _ = display_content(message.get("content", ""))
        sha = hashlib.sha256(content.encode()).hexdigest()
        if expected_sha is not None and expected_sha != sha:
            raise ConflictError("消息仍在更新，请重新读取当前版本。")
        if not 0 <= offset <= len(content):
            raise DevelopmentError("invalid_message_offset", "消息读取偏移无效。")
        end = min(len(content), offset + 64000)
        return {"messageId": message_id, "content": content[offset:end], "sha256": sha,
                "offset": offset, "nextOffset": end if end < len(content) else None, "totalCharacters": len(content)}

    def _start(self, session, request_id: str, message_id: str, content: MessageContent,
               *, display_content: str | None = None, input_source: dict | None = None) -> dict:
        config = self.config_loader()
        # Resolve invalid model selection before creating an execution record.
        resolve_coding_model(config, session.model, session.model_provider, session.model_reasoning_effort)
        load_project_context(self.store.get_project(session.project_id), config.development)
        run, created = self.store.create_run(session.id, request_id, message_id)
        if not created:
            return {"run": run.model_dump(mode="json", by_alias=True), "queued": False, "reused": True}
        transcript = self.sessions.get_or_create(session.transcript_key)
        try:
            existing = next((m for m in transcript.messages if m.get("id") == message_id), None)
            if existing:
                # Keep physical history offsets stable across compaction. The
                # queued placeholder is hidden, not removed from the archive.
                existing["id"] = stable_id("queued", session.id, request_id)
                existing["_input_delivered"] = True
                existing["_ui_only"] = True
            internal = bool(input_source and input_source.get("kind") == "collaboration_result")
            transcript.add_message("user", content, id=message_id, request_id=request_id, run_id=run.id, _input_source=input_source,
                                   _runtime_input=internal, **({"source_kind": "runtime"} if internal else {}),
                                   **({"_display_content": display_content} if display_content is not None else {}))
            self.sessions.save(transcript, fsync=True)
            run = self.store.transition_run(run.id, run.revision, RunStatus.PREPARING)
        except Exception:
            self._end(run.id, RunStatus.FAILED, "input_persistence_failed")
            raise
        task = asyncio.create_task(self._execute(run, config), name=f"development:{run.id}")
        self.tasks[run.id] = task
        task.add_done_callback(lambda done: self._task_done(run.id, done))
        return {"run": run.model_dump(mode="json", by_alias=True), "queued": False, "reused": False}

    def _task_done(self, run_id: str, task: asyncio.Task) -> None:
        self.tasks.pop(run_id, None)
        deleted = run_id in self._deleted_runs
        self._deleted_runs.discard(run_id)
        if not task.cancelled() and task.exception() is not None:
            if deleted:
                return
            # Never log arbitrary provider exceptions (they may contain credentials).
            logger.error("Development task {} failed ({})", run_id, type(task.exception()).__name__)

    def _end(self, run_id: str, status: RunStatus, error: str | None = None) -> None:
        try:
            current = self.store.get_run(run_id)
        except NotFoundError:
            if run_id in self._deleted_runs:
                return
            raise
        if current.status not in TERMINAL_RUN_STATUSES and current.status != status:
            self.store.transition_run(run_id, current.revision, status, error_code=error)

    async def _execute(self, run: Run, config: Config) -> None:
        session = self.store.get_session(run.session_id)
        transcript = self.sessions.get_or_create(session.transcript_key)
        continuation = None
        provider = None
        result = None
        try:
            project = self.store.get_project(session.project_id)
            context = load_project_context(project, config.development)
            preset = resolve_coding_model(config, session.model, session.model_provider, session.model_reasoning_effort)
            # Work failover settings must not change the explicitly selected Code model.
            provider_config = config.model_copy(update={"agents": config.agents.model_copy(update={
                "defaults": config.agents.defaults.model_copy(update={"fallback_models": []})})})
            snapshot = build_provider_snapshot(provider_config, preset=preset)
            provider = snapshot.provider
            coding = config.development.coding
            if "collaboration" in coding.extensions:
                context = replace(context, subagent_context=self.collaboration.scheduling_context(session.id))
            tools = self.tools.get(session.id)
            if tools is None:
                tools = CodingTools(context.root, session.transcript_key, coding.exec, readonly=session.readonly)
                self.tools[session.id] = tools
            else:
                tools.configure_exec(coding.exec)
            extensions = {}
            if not session.readonly and "plan" in coding.extensions:
                extensions["plan"] = DevelopmentPlanTool(self.store, run.id)
            if not session.readonly and not session.parent_session_id and "collaboration" in coding.extensions:
                extensions["collaboration"] = DevelopmentDelegate(self.collaboration, session.id, run.id)
            preview = get_binding(self, session.id)
            if preview and not session.readonly and "browser" in coding.extensions:
                extensions["browser"] = DevelopmentBrowser(self, session.id, preview)
            prepare_coding_extensions(tools, extensions, transcript.messages)
            tools.configure_permissions(run.permission_mode or session.permission_mode,
                lambda name, arguments: self.permissions.decide(run.id, name, arguments))
            defaults = coding.model_copy(update={"max_tokens": preset.max_tokens,
                "temperature": preset.temperature, "reasoning_effort": preset.reasoning_effort})
            spec = build_coding_run_spec(context, session, transcript, tools,
                model=snapshot.model, context_window_tokens=snapshot.context_window_tokens, defaults=defaults,
                summary=summary_text(transcript))
            spec.context_window_verified = getattr(snapshot, "context_window_verified", True)
            spec.context_provider = getattr(snapshot, "context_provider", None)
            continuation = CodingContinuation(self, run, context, transcript, tools, snapshot.provider,
                trigger_tokens=preset.auto_compact_token_limit)
            continuation.attach(spec)
            spec.hook = _CodingHook(self, run)
            current = self.store.get_run(run.id)
            if current.status == RunStatus.INTERRUPTING:
                self._end(run.id, RunStatus.INTERRUPTED)
                return
            self.store.transition_run(run.id, current.revision, RunStatus.RUNNING)
            result = await AgentRunner(snapshot.provider).run(spec)
            continuation.persist(result.messages[continuation.initial_length:])
            total_usage = dict(result.usage)
            for key, value in continuation.summary_usage.items():
                total_usage[key] = total_usage.get(key, 0) + value
            self.store.append_run_event(run.id, "usage.updated", {"usage": total_usage,
                "executionUsage": result.usage, "compactionUsage": continuation.summary_usage, "model": snapshot.model,
                "executor": "mona", "selectedModel": session.model, "modelProvider": session.model_provider,
                **({"contextTokens": result.final_usage["context_tokens"],
                    "contextWindow": result.final_usage.get("context_window_tokens")} if "context_tokens" in result.final_usage else {})})
        except asyncio.CancelledError:
            # Completed tool checkpoints are retained. Do not promise descendant processes stopped.
            self._end(run.id, RunStatus.UNKNOWN if self._closed else RunStatus.INTERRUPTED,
                      "host_shutdown" if self._closed else "user_interrupted")
        except Exception as exc:
            logger.error("Coding run {} error category {}", run.id, type(exc).__name__)
            self._end(run.id, RunStatus.FAILED, exc.code if isinstance(exc, DevelopmentError) else "execution_failed")
        finally:
            self.live.pop(session.id, None)
            try:
                try:
                    if continuation is not None:
                        continuation.settle()
                finally:
                    if provider is not None:
                        await provider.aclose()
            except asyncio.CancelledError:
                self._end(run.id, RunStatus.UNKNOWN if self._closed else RunStatus.INTERRUPTED,
                          "host_shutdown" if self._closed else "user_interrupted")
                raise
            except Exception:
                self._end(run.id, RunStatus.FAILED, "cleanup_failed")
                raise
        if result is not None:
            self._end(run.id, RunStatus.SUCCEEDED if result.stop_reason == "completed" and not result.error else RunStatus.FAILED,
                      None if not result.error else "execution_failed")
        await self._after_run(run.id)

    async def _next_input(self, session_id: str, run_id: str) -> None:
        async with self._lock(session_id):
            await self._next_input_locked(session_id, run_id)

    async def _next_input_locked(self, session_id: str, run_id: str) -> None:
        owner = self.store.get_run(run_id)
        candidates = [i for i in self.store.list_inputs(run_id) if i.state == InputState.PENDING and i.follow_up_allowed]
        pending = next((i for i in candidates if i.id == owner.continuation_input_id), next(iter(candidates), None))
        if pending is None:
            return
        session = self.store.get_session(session_id)
        transcript = self.sessions.get_or_create(session.transcript_key)
        row = next((m for m in transcript.messages if m.get("id") == pending.message_id), None)
        if row is None:
            raise DevelopmentError("missing_queued_input", "排队消息正文缺失，未执行。")
        if session.executor != ExecutorId.MONA and session.executor.value not in self.config_loader().development.enabled_engines:
            self.store.transition_input(pending.id, pending.revision, InputState.REJECTED)
            return
        source = row.get("_input_source") or {}
        internal = source.get("kind") == "collaboration_result"
        reserved = self.store.reserve_follow_up(pending.id, pending.revision)
        try:
            if internal and source.get("route") != model_route(session):
                raise DevelopmentError("collaboration_route_changed", "当前模型已变化，请核对原子任务结果后继续。")
            reply = await self._dispatch_start(session, pending.id, pending.message_id, row["content"],
                                               display_content=row.get("_display_content"), input_source=row.get("_input_source"))
            # Move remaining inputs before awaiting native dispatch: a fast
            # native completion may immediately start draining the next queue.
            self.store.move_pending_inputs(run_id, reply["run"]["id"])
            if session.executor != ExecutorId.MONA:
                sent = await self.native.service.wait_for_dispatch(reply["run"]["id"])
                if sent.native_dispatch != "accepted":
                    state = InputState.REJECTED if sent.status in TERMINAL_RUN_STATUSES else InputState.UNKNOWN
                    self.store.transition_input(reserved.id, reserved.revision, state)
                    return
            accepted = self.store.transition_input(reserved.id, reserved.revision, InputState.ACCEPTED)
            self.store.transition_input(accepted.id, accepted.revision, InputState.CONSUMED)
        except Exception:
            latest = self.store.get_input(reserved.id)
            if internal and self.store.find_run_request(session_id, pending.id) is None:
                failed, _ = self.store.create_run(session_id, pending.id, pending.message_id)
                self._end(failed.id, RunStatus.FAILED, "collaboration_continuation_failed")
                if latest.state == InputState.RESERVED:
                    self.store.transition_input(latest.id, latest.revision, InputState.REJECTED)
                return
            if latest.state == InputState.RESERVED:
                self.store.transition_input(latest.id, latest.revision, InputState.UNKNOWN)
            raise

    async def cancel_input(self, session_id: str, input_id: str) -> None:
        async with self._lock(session_id):
            item = self.store.get_input(input_id)
            if item.session_id != session_id:
                raise ConflictError("消息不属于当前会话。")
            if item.state != InputState.CANCELLED:
                self.store.transition_input(item.id, item.revision, InputState.CANCELLED)
            session = self.store.get_session(session_id)
            transcript = self.sessions.get_or_create(session.transcript_key)
            message = next((m for m in transcript.messages if m.get("id") == item.message_id), None)
            if message is not None:
                message["_input_cancelled"] = True
                self.sessions.save(transcript, fsync=True)

    async def interrupt(self, session_id: str, run_id: str) -> Run:
        run = self.store.get_run(run_id)
        if run.session_id != session_id:
            raise ConflictError("执行任务不属于当前会话。")
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        if run.status == RunStatus.WAITING_CHILDREN:
            async with self._lock(session_id):
                current = self.store.get_run(run_id)
                if current.status != RunStatus.WAITING_CHILDREN:
                    return current
                self._end(run_id, RunStatus.INTERRUPTED, "collaboration_wait_cancelled")
            task = self.tasks.get(run_id)
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            return self.store.get_run(run_id)
        if run.executor != ExecutorId.MONA:
            async with self._lock(session_id):
                return await self.native.interrupt(session_id, run.id)
        task = self.tasks.get(run.id)
        if task is None:
            if run.status == RunStatus.UNKNOWN:
                return self.store.close_unknown(session_id, run.id, run.revision, None)
            raise ConflictError("暂时无法停止任务，已有改动可能已生效。请稍后再试。")
        self._end(run.id, RunStatus.INTERRUPTING)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        current = self.store.get_run(run.id)
        if current.status == RunStatus.INTERRUPTING:
            self._end(run.id, RunStatus.INTERRUPTED)
        return self.store.get_run(run.id)

    async def close(self) -> None:
        self._closed = True
        self.updates.notify()
        tasks = [*self.tasks.values(), *self._recovery_tasks.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self._deletion_tasks:
            await asyncio.wait(self._deletion_tasks, timeout=2)
        await self.git_operations.close()
        await self.collaboration.close()
        await self.native.close()
        for tools in self.tools.values():
            await tools.exec_sessions.cancel_by_session(tools.session_key)
        self.sessions.flush_all()
        if self.store.on_change == self.updates.notify:
            self.store.on_change = None
