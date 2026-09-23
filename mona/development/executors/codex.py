"""Native Codex App Server adapter with per-thread ownership and shared transport.

Cindy reference: app-server/{host,client,stdioTransport}.ts. This implementation
keeps Mona's project-only policy instead of Cindy's user config/MCP injection.
No model Provider is used here and no product transcript is written by adapters.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from mona.development.contracts import Binding, Capabilities, ExecutorId
from mona.development.executors.base import (
    DispatchReceipt,
    ExecutorProbe,
    InterruptReceipt,
    NativeEvent,
    SessionStart,
)
from mona.development.executors.codex_events import normalize_codex_event, thread_id
from mona.development.executors.codex_policy import (
    CodexProfile,
    disabled_skill_overrides,
    validate_effective_config,
)
from mona.development.executors.rpc import JsonId, JsonRpcProcess, RemoteRpcError, RpcError

Approval = Literal["accept", "decline", "cancel"]
ApprovalHandler = Callable[[Binding, str, dict[str, Any]], Awaitable[Approval]]
QuestionHandler = Callable[[Binding, dict[str, Any]], Awaitable[dict[str, list[str]]]]
_TERMINAL = {"completed", "failed", "interrupted"}
_CAPABILITIES = Capabilities(resume=True, steering=True, interrupt=True, model_switch=True,
                             approval=True, usage=True, project_skills=True, rich_events=True)


def _same_root(value: Any, expected: Path) -> bool:
    if not isinstance(value, str) or not Path(value).is_absolute():
        return False
    try:
        return Path(value).resolve(strict=True) == expected.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return False


@dataclass
class _Thread:
    binding: Binding
    start: SessionStart
    queue: asyncio.Queue[tuple[NativeEvent | None, int]] = field(default_factory=asyncio.Queue)
    dispatch_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    queued_bytes: int = 0
    status: str = "idle"
    turn_id: str | None = None
    desynchronized: bool = False
    receiving: bool = False
    completed_turns: OrderedDict[str, str] = field(default_factory=OrderedDict)
    receipts: OrderedDict[str, tuple[str, DispatchReceipt]] = field(default_factory=OrderedDict)

    def publish(self, event: NativeEvent) -> None:
        size = len(event.model_dump_json().encode("utf-8"))
        if self.desynchronized:
            return
        if self.queue.qsize() >= 2048 or self.queued_bytes + size > 8_388_608:
            self.fault("event_buffer_exhausted")
            return
        self.queue.put_nowait((event, size))
        self.queued_bytes += size

    def fault(self, reason: str) -> None:
        self.status = "unknown"
        self.desynchronized = True
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queued_bytes = 0
        self.queue.put_nowait((NativeEvent(native_turn_id=self.turn_id, type="run.unknown",
                                          payload={"reason": reason, "requiresReconciliation": True}), 0))

    def remember(self, input_id: str, fingerprint: str, receipt: DispatchReceipt) -> DispatchReceipt:
        # The service's durable request/input ledger is authoritative across
        # restart and older inputs. This cache only closes local dispatch races.
        self.receipts[input_id] = (fingerprint, receipt.model_copy(deep=True))
        while len(self.receipts) > 256:
            self.receipts.popitem(last=False)
        return receipt


class CodexExecutor:
    id = ExecutorId.CODEX

    def __init__(self, profile: CodexProfile, *, approval_handler: ApprovalHandler | None = None,
                 question_handler: QuestionHandler | None = None, request_timeout: float = 30.0):
        self.profile = profile
        self._approval_handler = approval_handler
        self._question_handler = question_handler
        self._timeout = request_timeout
        self._client: JsonRpcProcess | None = None
        self._starting: asyncio.Task[JsonRpcProcess] | None = None
        self._opening_lock = asyncio.Lock()
        self._threads: dict[str, _Thread] = {}
        self._known_bindings: dict[str, Binding] = {}
        self._starts: dict[str, SessionStart] = {}
        self._early: list[tuple[str, dict[str, Any]]] = []
        self._opening = False
        self._closed = False
        self._version: str | None = None
        self._isolation_checked = False
        self._auth: Literal["unknown", "required", "ready"] = "unknown"

    async def _ensure_started(self) -> JsonRpcProcess:
        if self._closed:
            raise RpcError("native_host_closed", "执行器宿主已关闭，不能重新派发任务。")
        if self._client is not None and not self._client.closed:
            return self._client
        if self._starting is None:
            self._starting = asyncio.create_task(self._start())
        task = self._starting
        try:
            return await asyncio.shield(task)
        finally:
            if task.done() and self._starting is task:
                self._starting = None

    async def _start(self) -> JsonRpcProcess:
        # Dispose the previous connection only after explicit use/recovery. No
        # write request is retried here; initialization is not task execution.
        previous = self._client
        if previous is not None:
            await previous.close()
        client = await JsonRpcProcess.spawn(
            self.profile.command, cwd=self.profile.project_root, env=self.profile.environment,
            notification=self._on_notification, server_request=self._on_server_request,
            disconnected=self._on_disconnect, request_timeout=self._timeout,
        )
        self._client = client
        try:
            reply = await client.request("initialize", {"clientInfo": {
                "name": "mona_development", "title": "Mona Development", "version": "1.8.0",
            }})
            if not isinstance(reply, dict):
                raise RpcError("native_protocol_error", "原生初始化回执无效。")
            self._version = reply.get("userAgent") if isinstance(reply.get("userAgent"), str) else None
            await client.notify("initialized")
            await self._check_policy(client)
            account = await client.request("account/read", {"refreshToken": False})
            if not isinstance(account, dict) or "requiresOpenaiAuth" not in account:
                raise RpcError("native_protocol_error", "原生认证状态回执无效。")
            self._auth = "ready" if account.get("account") or account.get("requiresOpenaiAuth") is False else "required"
            return client
        except BaseException:
            await client.close()
            raise

    async def _check_policy(self, client: JsonRpcProcess) -> None:
        reply = await client.request("config/read", {"includeLayers": False, "cwd": str(self.profile.project_root)})
        validate_effective_config(reply)
        self._isolation_checked = True

    async def probe(self) -> ExecutorProbe:
        try:
            await self._ensure_started()
            return ExecutorProbe(executor=self.id, state="ready" if self._auth == "ready" else "detected",
                                 executable=self.profile.command[0], version=self._version,
                                 authentication=self._auth, capabilities=_CAPABILITIES,
                                 isolation_verified=self._isolation_checked,
                                 reason="原生协议和有效配置检查已通过；需按支持版本矩阵完成真实任务验收。")
        except RpcError as exc:
            return ExecutorProbe(executor=self.id, state="unavailable", executable=self.profile.command[0],
                                 version=self._version, authentication=self._auth, reason=str(exc))

    async def begin_login(self) -> dict[str, str]:
        """Only the authenticated host's explicit login UI may call this method."""
        client = await self._ensure_started()
        reply = await client.request("account/login/start", {"type": "chatgpt"})
        if not isinstance(reply, dict) or not all(isinstance(reply.get(k), str) for k in ("loginId", "authUrl")):
            raise RpcError("native_protocol_error", "登录回执不兼容，未打开未知链接。")
        return {"loginId": reply["loginId"], "authUrl": reply["authUrl"]}

    async def create_session(self, start: SessionStart) -> Binding:
        return await self._open(start, None)

    async def attach_session(self, start: SessionStart, binding: Binding) -> Binding:
        """Restore a host-verified persisted binding after process/app restart."""
        self._validate_start(start)
        if (binding.session_id != start.session.id or binding.executor != self.id
                or binding.working_directory != str(start.context.root) or binding.readonly != start.readonly):
            raise RpcError("binding_mismatch", "原生绑定不属于当前开发会话或项目。")
        for known in self._known_bindings.values():
            if known.native_session_id == binding.native_session_id and (known.id, known.session_id) != (binding.id, binding.session_id):
                raise RpcError("binding_mismatch", "原生线程已经属于其他开发会话。")
        self._starts[binding.id] = start
        self._known_bindings[binding.id] = binding.model_copy(deep=True)
        return await self._open(start, binding)

    async def resume_session(self, binding: Binding) -> Binding:
        start = self._starts.get(binding.id)
        if start is None:
            raise RpcError("binding_not_attached", "需要先通过已验证的项目会话恢复原生绑定。")
        return await self._open(start, binding)

    def _validate_start(self, start: SessionStart) -> None:
        if (start.session.project_id != start.context.project_id
                or start.context.root != self.profile.project_root
                or start.context.root.resolve(strict=True) != start.context.root):
            raise RpcError("invalid_project_context", "项目上下文与当前原生宿主不一致。")

    async def _open(self, start: SessionStart, binding: Binding | None) -> Binding:
        self._validate_start(start)
        async with self._opening_lock:
            if binding is not None:
                self._validate_binding(binding)
                existing = self._threads.get(binding.native_session_id)
                if (existing and self._client is not None and not self._client.closed
                        and existing.status in {"starting", "running", "waiting_user", "interrupting", "unknown"}):
                    raise RpcError("native_busy", "原生轮次尚未结束或结果未知，请先核对状态，不要重建会话。")
            client = await self._ensure_started()
            await self._check_policy(client)
            account = await client.request("account/read", {"refreshToken": False})
            if not isinstance(account, dict) or (account.get("requiresOpenaiAuth") is not False and not account.get("account")):
                self._auth = "required"
                raise RpcError("authentication_required", "请先在执行器设置中完成官方认证，原会话仍保留。")
            self._auth = "ready"
            skills = await client.request("skills/list", {"cwds": [str(start.context.root)], "forceReload": True})
            disabled = disabled_skill_overrides(skills, start.context)
            params: dict[str, Any] = {
                "cwd": str(start.context.root), "approvalPolicy": "on-request", "approvalsReviewer": "user",
                "sandbox": "read-only" if start.readonly else "workspace-write",
                "developerInstructions": start.context.model_context(),
                "config": {"skills.config": disabled},
            }
            if start.model:
                params["model"] = start.model
            if binding is not None:
                params["threadId"] = binding.native_session_id
            self._opening = True
            self._early = []
            try:
                reply = await client.request("thread/resume" if binding else "thread/start", params)
                thread = reply.get("thread") if isinstance(reply, dict) else None
                if not isinstance(thread, dict) or not isinstance(thread.get("id"), str) or not thread["id"]:
                    raise RpcError("native_protocol_error", "原生会话回执缺少线程标识。", outcome_unknown=True)
                native_id = thread["id"]
                if binding is not None and native_id != binding.native_session_id:
                    raise RpcError("binding_mismatch", "恢复回执指向了另一原生会话。", outcome_unknown=True)
                if not _same_root(thread.get("cwd"), start.context.root):
                    raise RpcError("binding_mismatch", "原生会话工作目录与授权项目不一致。", outcome_unknown=True)
                # project_doc_max_bytes=0 means all project instructions come
                # from the explicit ProjectContext above, never ambient files.
                sources = reply.get("instructionSources")
                if sources != []:
                    raise RpcError("project_policy_violation", "原生会话指令来源未通过项目隔离检查。", outcome_unknown=True)
                sandbox = reply.get("sandbox")
                expected_sandbox = "readOnly" if start.readonly else "workspaceWrite"
                if not isinstance(sandbox, dict) or sandbox.get("type") != expected_sandbox:
                    raise RpcError("project_policy_violation", "原生会话没有启用要求的文件权限边界。", outcome_unknown=True)
                if reply.get("approvalPolicy") != "on-request" or reply.get("approvalsReviewer") != "user":
                    raise RpcError("project_policy_violation", "原生会话审批策略未生效。", outcome_unknown=True)
                if native_id in self._threads and binding is None:
                    raise RpcError("binding_mismatch", "新建会话回执重复了已有线程。", outcome_unknown=True)
                active = binding.model_copy(deep=True) if binding else Binding(
                    session_id=start.session.id, executor=self.id, native_session_id=native_id,
                    working_directory=str(start.context.root), readonly=start.readonly, capabilities=_CAPABILITIES,
                )
                active.state = "active"
                active.context_fingerprint = start.context.rules_fingerprint + ":" + start.context.skills_fingerprint
                active.protocol_version = self._version
                runtime = _Thread(active, start)
                stored_turns = thread.get("turns", [])
                if not isinstance(stored_turns, list):
                    raise RpcError("native_protocol_error", "原生会话历史格式不兼容。", outcome_unknown=True)
                for stored in stored_turns[-256:]:
                    if not isinstance(stored, dict) or not isinstance(stored.get("id"), str):
                        continue
                    if stored.get("status") in _TERMINAL:
                        runtime.completed_turns[stored["id"]] = stored["status"]
                    elif stored.get("status") == "inProgress":
                        runtime.turn_id, runtime.status = stored["id"], "unknown"
                old = self._threads.get(native_id)
                if old:
                    old.queue.put_nowait((None, 0))
                self._threads[native_id] = runtime
                self._starts[active.id] = start
                self._known_bindings[active.id] = active.model_copy(deep=True)
                for method, event in self._early:
                    if thread_id(method, event) == native_id:
                        self._deliver(runtime, method, event)
                return active.model_copy(deep=True)
            finally:
                self._opening = False
                self._early = []

    def _validate_binding(self, binding: Binding) -> Binding:
        known = self._known_bindings.get(binding.id)
        if known is None or (known.session_id, known.native_session_id, known.working_directory, known.executor, known.readonly) != (
                binding.session_id, binding.native_session_id, binding.working_directory, binding.executor, binding.readonly):
            raise RpcError("binding_mismatch", "原生会话绑定未验证或被替换。")
        return known

    def _runtime(self, binding: Binding) -> _Thread:
        known = self._validate_binding(binding)
        runtime = self._threads.get(known.native_session_id)
        if runtime is None:
            raise RpcError("native_not_loaded", "原生会话已停泊，请恢复原绑定后继续。")
        return runtime

    async def send(self, binding: Binding, input_id: str, message: str) -> DispatchReceipt:
        return await self._dispatch_input(binding, input_id, message, steering=False)

    async def steer(self, binding: Binding, input_id: str, message: str) -> DispatchReceipt:
        return await self._dispatch_input(binding, input_id, message, steering=True)

    async def _dispatch_input(self, binding: Binding, input_id: str, message: str, *, steering: bool) -> DispatchReceipt:
        runtime = self._runtime(binding)
        if not input_id or len(input_id) > 200 or not isinstance(message, str) or not message.strip():
            raise RpcError("invalid_input", "请求标识和消息内容不能为空。")
        fingerprint = hashlib.sha256((str(steering) + "\x00" + message).encode()).hexdigest()
        async with runtime.dispatch_lock:
            prior = runtime.receipts.get(input_id)
            if prior:
                if prior[0] != fingerprint:
                    raise RpcError("input_conflict", "同一请求标识携带了不同内容，未执行。")
                return prior[1].model_copy(deep=True)
            if runtime.desynchronized or runtime.status == "unknown":
                return DispatchReceipt(input_id=input_id, outcome="unknown", reason="请先核对原生执行状态；未重新发送。")
            if self._client is None or self._client.closed:
                return DispatchReceipt(input_id=input_id, outcome="rejected", reason="原生连接已关闭，请恢复原会话。")
            if (steering and runtime.status not in {"running", "waiting_user"}) or (not steering and runtime.status != "idle"):
                return DispatchReceipt(input_id=input_id, outcome="rejected", reason="当前轮次状态不接受此输入，请排队或等待。")
            previous_turn = runtime.turn_id
            previous_status = runtime.status
            if not steering:
                runtime.status, runtime.turn_id = "starting", None
            params: dict[str, Any] = {"threadId": binding.native_session_id,
                "input": [{"type": "text", "text": message}], "clientUserMessageId": input_id}
            if steering:
                params["expectedTurnId"] = previous_turn
            try:
                reply = await self._client.request("turn/steer" if steering else "turn/start", params)
                turn = reply.get("turn", {}) if isinstance(reply, dict) else {}
                accepted_turn = reply.get("turnId") if steering and isinstance(reply, dict) else turn.get("id")
                if not isinstance(accepted_turn, str) or not accepted_turn:
                    raise RpcError("native_protocol_error", "派发回执缺少原生轮次标识。", outcome_unknown=True)
                if steering and accepted_turn != previous_turn:
                    raise RpcError("native_turn_mismatch", "追加输入回执对应另一轮次，请核对执行状态。", outcome_unknown=True)
                if not steering and runtime.turn_id not in {None, accepted_turn}:
                    raise RpcError("native_turn_mismatch", "派发回执与事件轮次不一致。", outcome_unknown=True)
                runtime.turn_id = accepted_turn
                if runtime.status == "starting":
                    runtime.status = "running"
                receipt = DispatchReceipt(input_id=input_id, outcome="accepted", native_turn_id=accepted_turn)
            except RemoteRpcError as exc:
                if runtime.turn_id == previous_turn or (not steering and runtime.turn_id is None):
                    runtime.status, runtime.turn_id = previous_status, previous_turn
                else:
                    runtime.fault("contradictory_dispatch_evidence")
                receipt = DispatchReceipt(input_id=input_id, outcome="unknown" if runtime.desynchronized else "rejected", reason=str(exc))
            except RpcError as exc:
                if exc.outcome_unknown:
                    runtime.status = "unknown"
                else:
                    runtime.status, runtime.turn_id = previous_status, previous_turn
                receipt = DispatchReceipt(input_id=input_id, outcome="unknown" if exc.outcome_unknown else "rejected", reason=str(exc))
            except asyncio.CancelledError:
                runtime.status = "unknown"
                runtime.remember(input_id, fingerprint, DispatchReceipt(input_id=input_id, outcome="unknown", reason="等待派发回执已取消，未重跑请求。"))
                raise
            return runtime.remember(input_id, fingerprint, receipt)

    async def interrupt(self, binding: Binding) -> InterruptReceipt:
        runtime = self._runtime(binding)
        if runtime.status == "idle":
            return InterruptReceipt(outcome="already_finished")
        if not runtime.turn_id or self._client is None or self._client.closed:
            return InterruptReceipt(outcome="unknown")
        turn_id = runtime.turn_id
        runtime.status = "interrupting"
        try:
            await self._client.request("turn/interrupt", {"threadId": binding.native_session_id, "turnId": turn_id})
        except RpcError:
            if turn_id not in runtime.completed_turns:
                runtime.status = "unknown"
                return InterruptReceipt(outcome="unknown")
        # Empty interrupt reply only acknowledges the request, not termination.
        terminal = runtime.completed_turns.get(turn_id)
        return InterruptReceipt(outcome="confirmed" if terminal == "interrupted"
                                else "already_finished" if terminal else "requested")

    async def get_status(self, binding: Binding) -> str:
        runtime = self._runtime(binding)
        if self._client is None or self._client.closed:
            return "unknown"
        reply = await self._client.request("thread/read", {"threadId": binding.native_session_id, "includeTurns": True})
        thread = reply.get("thread", {}) if isinstance(reply, dict) else {}
        if thread.get("id") != binding.native_session_id or not _same_root(thread.get("cwd"), Path(binding.working_directory)):
            raise RpcError("binding_mismatch", "状态回执不属于当前原生会话。")
        turns = thread.get("turns", [])
        if runtime.turn_id:
            turn = next((t for t in turns if isinstance(t, dict) and t.get("id") == runtime.turn_id), None)
            if turn and turn.get("status") in _TERMINAL:
                self._deliver(runtime, "turn/completed", {"threadId": binding.native_session_id, "turn": turn})
        return "unknown" if runtime.desynchronized else runtime.status

    async def inspect_turn(self, binding: Binding, native_turn_id: str) -> list[NativeEvent]:
        """Explicit read-only recovery of a completed turn; never reruns its prompt."""
        runtime = self._runtime(binding)
        if self._client is None or self._client.closed:
            raise RpcError("native_not_loaded", "请先恢复原生会话，再核对原轮次结果。")
        if runtime.turn_id not in {None, native_turn_id} and runtime.status != "idle":
            raise RpcError("native_busy", "原生会话正在执行另一轮次，未改变其状态。")
        reply = await self._client.request("thread/read", {"threadId": binding.native_session_id, "includeTurns": True})
        thread = reply.get("thread") if isinstance(reply, dict) else None
        if not isinstance(thread, dict) or thread.get("id") != binding.native_session_id or not _same_root(thread.get("cwd"), Path(binding.working_directory)):
            raise RpcError("binding_mismatch", "原生历史不属于当前项目会话。")
        turns = thread.get("turns")
        if not isinstance(turns, list):
            raise RpcError("native_protocol_error", "原生历史轮次格式不兼容。")
        turn = next((t for t in turns if isinstance(t, dict) and t.get("id") == native_turn_id), None)
        if turn is None:
            raise RpcError("native_turn_not_found", "尚未找到原轮次，未重新执行请求。", outcome_unknown=True)
        if turn.get("status") not in _TERMINAL:
            raise RpcError("native_turn_not_finished", "原轮次尚未确认结束，请继续观察；未重新执行请求。", outcome_unknown=True)
        items = turn.get("items")
        if not isinstance(items, list) or len(items) > 10000:
            raise RpcError("native_history_incomplete", "原生轮次内容不完整，未标记恢复成功。")
        events: list[NativeEvent] = []
        for item in items:
            event = normalize_codex_event("item/completed", {"threadId": binding.native_session_id,
                                         "turnId": native_turn_id, "item": item})
            if event is not None:
                if event.type == "policy.violation":
                    raise RpcError("native_policy_violation", "原轮次包含未授权能力，需人工核对。")
                events.append(event)
        terminal = normalize_codex_event("turn/completed", {"threadId": binding.native_session_id, "turn": turn})
        assert terminal is not None
        events.append(terminal)
        runtime.turn_id, runtime.status = native_turn_id, "idle"
        runtime.desynchronized = False
        runtime.completed_turns[native_turn_id] = turn["status"]
        while len(runtime.completed_turns) > 256:
            runtime.completed_turns.popitem(last=False)
        return events

    async def list_models(self) -> list[str]:
        client = await self._ensure_started()
        models: list[str] = []
        cursor: str | None = None
        seen: set[str] = set()
        for _ in range(20):
            reply = await client.request("model/list", {"cursor": cursor, "limit": 100})
            if not isinstance(reply, dict) or not isinstance(reply.get("data"), list):
                raise RpcError("native_protocol_error", "模型列表回执不兼容。")
            for entry in reply["data"]:
                if isinstance(entry, dict) and isinstance(entry.get("model"), str):
                    models.append(entry["model"])
            cursor = reply.get("nextCursor")
            if cursor is None:
                return list(dict.fromkeys(models))
            if not isinstance(cursor, str) or cursor in seen:
                break
            seen.add(cursor)
        raise RpcError("native_pagination_error", "模型列表未完整返回，未把部分列表当作完整结果。")

    async def close_runtime(self, binding: Binding) -> None:
        runtime = self._runtime(binding)
        if runtime.status != "idle":
            raise RpcError("native_busy", "请先中断并确认当前轮次结束，再释放原生会话。")
        if self._client is None or self._client.closed:
            raise RpcError("native_disconnected", "连接已断开，无法确认原生会话已卸载。", outcome_unknown=True)
        await self._client.request("thread/unsubscribe", {"threadId": binding.native_session_id})
        self._threads.pop(binding.native_session_id, None)
        self._known_bindings[binding.id].state = "parked"
        runtime.queue.put_nowait((None, 0))
        # Other threads keep the same App Server process. Never archive here.

    async def events(self, binding: Binding) -> AsyncIterator[NativeEvent]:
        runtime = self._runtime(binding)
        if runtime.receiving:
            raise RpcError("duplicate_event_consumer", "该原生会话已有事件消费者；分屏应共享产品事件流。")
        runtime.receiving = True
        try:
            while True:
                event, size = await runtime.queue.get()
                runtime.queued_bytes -= size
                if event is None:
                    return
                yield event
        finally:
            runtime.receiving = False

    def _on_notification(self, method: str, params: dict[str, Any]) -> None:
        if method == "account/updated":
            self._auth = "ready" if params.get("authMode") else "required"
            return
        owner = thread_id(method, params)
        runtime = self._threads.get(owner or "")
        if runtime is not None:
            self._deliver(runtime, method, params)
        elif owner and self._opening:
            if len(self._early) >= 128 or sum(len(str(p)) for _, p in self._early) > 2_097_152:
                raise ValueError("Early native events exceeded bound")
            self._early.append((method, params))

    def _deliver(self, runtime: _Thread, method: str, params: dict[str, Any]) -> None:
        event = normalize_codex_event(method, params)
        if event is None:
            return
        turn_id = event.native_turn_id
        if turn_id and turn_id in runtime.completed_turns:
            return
        if event.type == "run.started":
            if runtime.turn_id not in {None, turn_id} and runtime.status != "idle":
                runtime.fault("native_turn_mismatch")
                return
            runtime.turn_id = turn_id
            if runtime.status != "interrupting":
                runtime.status = "running"
        elif event.type in {"run.completed", "run.interrupted", "run.failed"}:
            if turn_id:
                runtime.completed_turns[turn_id] = {"run.completed": "completed", "run.interrupted": "interrupted", "run.failed": "failed"}[event.type]
                while len(runtime.completed_turns) > 256:
                    runtime.completed_turns.popitem(last=False)
            if runtime.turn_id in {None, turn_id}:
                runtime.turn_id, runtime.status = turn_id, "idle"
        elif event.type == "policy.violation":
            runtime.fault("native_policy_violation")
            return
        runtime.publish(event)

    async def _on_server_request(self, request_id: JsonId, method: str, params: dict[str, Any]) -> Any:
        owner = thread_id(method, params)
        runtime = self._threads.get(owner or "")
        turn_id = params.get("turnId")
        is_current = (runtime is not None and not runtime.desynchronized and runtime.turn_id == turn_id
                      and runtime.status in {"running", "waiting_user"})
        if method == "item/permissions/requestApproval":
            return {"permissions": {}, "scope": "turn"}
        if method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}:
            if not is_current or runtime is None or runtime.start.readonly or self._approval_handler is None:
                return {"decision": "decline"}
            runtime.status = "waiting_user"
            runtime.publish(NativeEvent(native_turn_id=turn_id, type="approval.requested",
                payload={"requestId": request_id, "kind": method, **{k: params[k] for k in ("itemId", "command", "cwd", "reason") if k in params}}))
            try:
                decision = await self._approval_handler(runtime.binding.model_copy(deep=True), method, params.copy())
            except asyncio.CancelledError:
                raise
            except Exception:
                decision = "decline"
            if runtime.status not in {"waiting_user", "running"} or runtime.turn_id != turn_id or self._client is None or self._client.closed:
                decision = "cancel"
            if decision not in {"accept", "decline", "cancel"}:
                decision = "decline"
            if runtime.status == "waiting_user":
                runtime.status = "running"
            runtime.publish(NativeEvent(native_turn_id=turn_id, type="approval.resolved", payload={"requestId": request_id, "decision": decision}))
            return {"decision": decision}
        if method == "item/tool/requestUserInput":
            if not is_current or runtime is None or self._question_handler is None:
                return {"answers": {}}
            try:
                answers = await self._question_handler(runtime.binding.model_copy(deep=True), params.copy())
            except asyncio.CancelledError:
                raise
            except Exception:
                return {"answers": {}}
            if runtime.turn_id != turn_id or runtime.status not in {"running", "waiting_user"}:
                return {"answers": {}}
            valid_ids = {q["id"] for q in params.get("questions", []) if isinstance(q, dict) and isinstance(q.get("id"), str)}
            if not isinstance(answers, dict) or any(k not in valid_ids or not isinstance(v, list)
                    or not all(isinstance(a, str) for a in v) for k, v in answers.items()):
                return {"answers": {}}
            return {"answers": {key: {"answers": values} for key, values in answers.items()}}
        raise RemoteRpcError(-32601)

    def _on_disconnect(self, reason: str) -> None:
        self._isolation_checked = False
        self._auth = "unknown"
        for runtime in self._threads.values():
            if runtime.status == "idle":
                runtime.status = "not_loaded"
                runtime.publish(NativeEvent(type="session.unavailable", payload={"reason": reason}))
            else:
                runtime.fault(reason)

    async def shutdown(self) -> None:
        self._closed = True
        if self._starting is not None:
            try:
                await asyncio.shield(self._starting)
            except (RpcError, OSError):
                pass
        if self._client is not None:
            await self._client.close()
        for runtime in self._threads.values():
            runtime.queue.put_nowait((None, 0))
