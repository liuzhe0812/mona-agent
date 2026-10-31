"""Main-chat coordination over the existing development runtime."""
from __future__ import annotations

import asyncio
import hashlib
import json
from typing import TYPE_CHECKING, Callable

from loguru import logger

from mona.agent.tools.context import RequestContext
from mona.bus.events import OutboundMessage
from mona.development.contracts import TERMINAL_RUN_STATUSES, InputState, now
from mona.development.hub_contracts import HubCommand
from mona.development.hub_store import HubRequest, HubStore, hub_id
from mona.development.store import ConflictError, DevelopmentError, NotFoundError
from mona.development.workspace import git_diff, git_summary, read_project_file

if TYPE_CHECKING:
    from mona.bus.queue import MessageBus
    from mona.development.runtime import DevelopmentRuntime
    from mona.session.manager import SessionManager


class DevelopmentHub:
    def __init__(self, runtime_loader: Callable[[], DevelopmentRuntime], sessions: SessionManager, bus: MessageBus):
        self._runtime_loader, self.sessions, self.bus = runtime_loader, sessions, bus
        self._store: HubStore | None = None
        self._watcher: asyncio.Task | None = None
        self._dispatching: set[str] = set()

    @property
    def store(self) -> HubStore:
        if self._store is None:
            self._store = HubStore(self._runtime_loader().store)
        return self._store

    def allows_context(self, source: RequestContext) -> bool:
        key = source.session_key
        if not key or key.startswith(("development:", "subagent:")):
            return False
        session = self.sessions.get_existing(key)
        return (session is not None and session.conversation_metadata.type == "direct"
                and session.conversation_metadata.direct_agent_id in {None, "mona"})

    @staticmethod
    def _page(rows: list, command: HubCommand) -> dict:
        end = command.offset + command.limit
        return {"items": rows[command.offset:end], "total": len(rows),
                "nextOffset": end if end < len(rows) else None, "checkedAt": now().isoformat()}

    @staticmethod
    def _project_summary(project) -> dict:
        return {"id": project.id, "displayName": project.display_name, "rootPath": project.root_path,
                "revision": project.revision, "lastOpenedAt": project.last_opened_at.isoformat()}

    async def execute(self, command: HubCommand, source: RequestContext) -> dict:
        if not self.allows_context(source):
            raise DevelopmentError("invalid_origin", "请在 Mona 普通聊天中协调开发任务。")
        runtime = self._runtime_loader()
        store = runtime.store
        if runtime._closed:
            raise DevelopmentError("shutting_down", "开发服务正在退出，请稍后重试。")
        action = command.action
        if action in {"create_session", "send_task"}:
            return await self._dispatch(command, source)
        if action == "list_tasks":
            origin = self.sessions.get_existing(source.session_key)
            records = [r for r in self.store.list(source.session_key) if r.source_created_at == origin.created_at.isoformat()]
            page = self._page(records, command)
            for record in page["items"]:
                if record.id not in self._dispatching:
                    self._reconcile(record)
            page["items"] = [self.describe(record) for record in page["items"]]
            return page
        if action == "list_projects":
            projects = [p for p in store.list_projects() if command.query.casefold() in
                        f"{p.display_name} {p.root_path}".casefold()]
            return self._page([self._project_summary(p) for p in projects], command)
        if action in {"list_sessions", "inspect_project"}:
            project = store.get_project(command.project_id)
            latest = store.latest_runs_for_project(project.id)
            rows = [s for s in store.list_sessions(project.id)
                    if (command.include_archived or not s.archived) and command.query.casefold() in s.title.casefold()]
            result = self._page(rows, command)
            result["items"] = [{**s.model_dump(mode="json", by_alias=True),
                "latestRun": latest[s.id].model_dump(mode="json", by_alias=True) if s.id in latest else None}
                for s in (runtime.resolve_session_title(item) for item in result["items"])]
            if action == "inspect_project":
                result.update(project=self._project_summary(project),
                              git=await git_summary(project, refresh=True),
                              evidenceNote="工作区差异可能来自多个会话或人工修改，不能归因于某一个任务。")
            return result
        if action in {"read_file", "read_diff"}:
            project = store.get_project(command.project_id)
            if action == "read_file":
                return await asyncio.to_thread(read_project_file, project, command.path)
            return await git_diff(project, command.path)
        if action == "inspect_session":
            store.get_session(command.session_id)
            runtime.schedule_recovery(command.session_id)
            return runtime.snapshot(command.session_id, before=command.before, limit=command.limit, after=command.after)
        return runtime.read_message(command.session_id, command.message_id, command.offset, command.expected_sha256)

    async def _dispatch(self, command: HubCommand, source: RequestContext) -> dict:
        runtime = self._runtime_loader()
        session = self.sessions.get_existing(source.session_key)
        payload = command.model_dump(mode="json", exclude_defaults=True)
        fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        record, created = self.store.begin(HubRequest(
            id=hub_id(source.session_key, session.created_at.isoformat(), command.request_id), source_session_key=source.session_key,
            source_channel=source.channel, source_chat_id=source.chat_id,
            source_created_at=session.created_at.isoformat(), source_message_id=source.message_id,
            action=command.action, fingerprint=fingerprint, project_id=command.project_id, session_id=command.session_id,
            receipt={"intent": command.intent}))
        if not created:
            if record.id not in self._dispatching:
                self._reconcile(record)
            return {"ok": record.state == "accepted", "reused": True, "task": self.describe(record)}
        self._dispatching.add(record.id)
        try:
            if command.action == "create_session":
                from mona.development.session_creation import create_session

                if runtime.store.get_project(command.project_id).removed:
                    raise ConflictError("项目已从工作台移除，请先重新打开项目。")
                options = {name: getattr(command, name) for name in
                    ("executor", "title", "model", "model_provider", "model_reasoning_effort", "readonly")}
                # A saved creation specification permits read-only reconciliation after a crash.
                record.receipt = {"creation": {**options, "executor": command.executor.value, "parent_session_id": None}}
                self.store.save(record)
                self._check_source(record)
                target = create_session(runtime, command.project_id, request_id=record.id, **options)
                record.session_id, record.project_id = target.id, target.project_id
                record.receipt = {"sessionId": target.id}
                record.finished = True
            else:
                target = runtime.store.get_session(command.session_id)
                if target.archived or target.parent_session_id:
                    raise ConflictError("请先恢复归档会话，或选择项目中的主开发会话。")
                project = runtime.store.get_project(target.project_id)
                if project.removed:
                    raise ConflictError("项目已从工作台移除，请先重新打开项目。")
                record.project_id = target.project_id
                self.store.save(record)
                receipt = await runtime.submit(target.id, record.id, command.content, intent=command.intent,
                    expected_revision=command.expected_revision, target_run_id=command.target_run_id,
                    authorize=lambda: self._check_source(record))
                record.receipt.update({key: value["id"] for key, value in receipt.items() if key in {"run", "input"}})
            record.state = "accepted"
            self.store.save(record)
        except BaseException as exc:
            self._reconcile(record)
            if record.state != "accepted":
                rejected = isinstance(exc, ValueError) and not getattr(exc, "outcome_unknown", False)
                record.state = "rejected" if rejected else "unknown"
                record.error_code = exc.code if isinstance(exc, DevelopmentError) else "dispatch_unconfirmed"
                record.finished = record.state == "rejected"
                self.store.save(record)
            raise
        finally:
            self._dispatching.discard(record.id)
            runtime.updates.notify()
        return {"ok": True, "reused": False, "task": self.describe(record)}

    def _check_source(self, record: HubRequest) -> None:
        source = self.sessions.get_existing(record.source_session_key)
        if source is None or source.created_at.isoformat() != record.source_created_at:
            raise DevelopmentError("origin_deleted", "来源聊天已删除，未继续派发任务。")

    def _reconcile(self, record: HubRequest) -> None:
        if record.state in {"accepted", "rejected"}:
            return
        previous = record.model_dump_json()
        runtime = self._runtime_loader()
        if record.action == "create_session":
            options = record.receipt.get("creation")
            target = runtime.store.find_session_creation(record.project_id, record.id, options) if options else None
            if target:
                record.session_id, record.state, record.finished = target.id, "accepted", True
                record.receipt = {"sessionId": target.id}
        elif record.session_id:
            try:
                run = runtime.store.find_run_request(record.session_id, record.id)
                item = runtime.store.get_input(record.id) if run is None else None
                record.receipt.update({"run": run.id} if run else {"input": item.id})
                record.state = "accepted"
            except NotFoundError:
                pass
        if record.state == "prepared":
            record.state, record.error_code = "unknown", "dispatch_unconfirmed"
        elif record.state == "accepted":
            record.error_code = None
        if record.model_dump_json() != previous:
            self.store.save(record)

    def describe(self, record: HubRequest) -> dict:
        runtime = self._runtime_loader()
        result = {"id": record.id, "action": record.action, "projectId": record.project_id,
                  "sessionId": record.session_id, "dispatchState": record.state, "status": record.state,
                  "createdAt": record.created_at.isoformat(), "errorCode": record.error_code}
        if record.session_id is None:
            return result
        try:
            session = runtime.store.get_session(record.session_id)
        except NotFoundError:
            result["status"] = "deleted"
            return result
        try:
            result["session"] = session.model_dump(mode="json", by_alias=True)
            if record.action == "create_session":
                result["status"] = "created"
                return result
            run = runtime.store.find_run_request(session.id, record.id)
            if run is None and record.state == "accepted":
                item = runtime.store.get_input(record.id)
                result["input"] = item.model_dump(mode="json", by_alias=True)
                if item.state in {InputState.PENDING, InputState.RESERVED}:
                    result["status"] = "queued"
                    return result
                if item.state in {InputState.CANCELLED, InputState.REJECTED, InputState.CLOSED_UNKNOWN}:
                    result["status"] = item.state.value
                    return result
                if item.state == InputState.UNKNOWN or record.receipt.get("intent") != "steering":
                    result["status"] = "unknown"
                    return result
                run = runtime.store.get_run(item.run_id)
            if run is not None:
                result.update(status=run.status.value, run=run.model_dump(mode="json", by_alias=True))
                if run.status.value in {"waiting_user", "waiting_children"}:
                    decisions = runtime.native.decisions.list_pending(session.id, include_children=True)
                    result["pendingDecisions"] = decisions
                    if decisions:
                        result["attention"] = "waiting_user"
                message_id = run.result_message_id
                # Mona checkpoints identify messages by run; native executors also save a result pointer.
                if message_id is None and run.status in TERMINAL_RUN_STATUSES:
                    transcript = self.sessions.get_existing(session.transcript_key)
                    message_id = next((m.get("id") for m in reversed(transcript.messages if transcript else [])
                        if m.get("run_id") == run.id and m.get("role") == "assistant"
                        and not m.get("tool_calls") and m.get("content")), None)
                if message_id:
                    result["resultRef"] = {"sessionId": session.id, "messageId": message_id}
        except NotFoundError:
            result["status"] = "unknown"
        return result

    async def start(self) -> None:
        if self._watcher is None:
            _ = self.store
            self._watcher = asyncio.create_task(self._watch(), name="development-hub-results")

    async def close(self) -> None:
        if self._watcher is not None:
            self._watcher.cancel()
            await asyncio.gather(self._watcher, return_exceptions=True)
            self._watcher = None

    async def _watch(self) -> None:
        runtime = self._runtime_loader()
        while not runtime._closed:
            version = runtime.updates.version
            for record in self.store.list(pending=True):
                try:
                    await self.observe(record)
                except Exception as exc:
                    logger.error("Development result notification {} failed ({})", record.id, type(exc).__name__)
            await runtime.updates.wait(version)

    async def observe(self, record: HubRequest) -> None:
        if record.id in self._dispatching:
            return
        try:
            self._check_source(record)
        except DevelopmentError:
            record.finished = True
            self.store.save(record)
            return
        self._reconcile(record)
        if record.session_id:
            self._runtime_loader().schedule_recovery(record.session_id)
        state = self.describe(record)
        status = state.get("attention", state["status"])
        labels = {"succeeded": "已结束本轮执行", "failed": "执行失败", "interrupted": "已中断",
                  "waiting_user": "需要你处理确认", "unknown": "执行结果暂时无法确认",
                  "closed_unknown": "已结束核对，执行结果仍未确认", "cancelled": "排队任务已取消",
                  "rejected": "任务未被接纳"}
        if status == "deleted":
            record.finished = True
            self.store.save(record)
            return
        if status not in labels:
            return
        run = state.get("run", {})
        decisions = ",".join(sorted(d["id"] for d in state.get("pendingDecisions", [])))
        notice_id = hub_id(record.id, run.get("id", ""), status, decisions)
        if notice_id in record.notified:
            return
        source = self.sessions.get_existing(record.source_session_key)
        title = state.get("session", {}).get("title", "开发任务")
        text = f"开发会话「{title}」{labels[status]}。"
        if status == "waiting_user":
            text += "请到开发工作台打开该会话处理确认。"
        elif status == "unknown":
            text += "任务记录已保留，没有重新执行；请先核对开发会话和实际改动。"
        result_ref = state.get("resultRef")
        if result_ref:
            result = self._runtime_loader().read_message(result_ref["sessionId"], result_ref["messageId"])
            text += "\n\n开发会话报告：\n" + result["content"]
            if result["nextOffset"] is not None:
                text += "\n\n结果较长，此处为首段；完整内容保留在开发会话中。"
        if not any(m.get("id") == notice_id for m in source.messages):
            source.add_message("assistant", text, id=notice_id, injected_event="development_result",
                               development_task=state, author_id="mona")
        self.sessions.save(source, fsync=True)
        if record.source_channel == "websocket":
            from mona.webui.transcript import append_transcript_object

            append_transcript_object(record.source_session_key, {"event": "background_message", "id": notice_id,
                "_event_id": notice_id, "text": text, "author_id": "mona", "chat_id": record.source_chat_id})
        await self.bus.publish_outbound(OutboundMessage(record.source_channel, record.source_chat_id,
            "" if record.source_channel == "websocket" else text,
            metadata={"_session_updated": True, "_session_update_scope": "thread"}
            if record.source_channel == "websocket" else {"message_id": notice_id}))
        record.notified.append(notice_id)
        record.finished = status in {"succeeded", "failed", "interrupted", "closed_unknown", "cancelled", "rejected"}
        self.store.save(record)
