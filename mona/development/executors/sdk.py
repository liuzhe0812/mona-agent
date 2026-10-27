"""Official Claude/CodeBuddy SDK adapters; isolated per-session SDK owners.

This bridge shares Mona event/dispatch contracts, not either vendor's agent loop.
Native SDK turn correlation is explicitly host-generated; it is never presented
as a vendor history ID or used to replay an uncertain task.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from mona.development.contracts import Binding, Capabilities, ExecutorId, PermissionMode
from mona.development.executors.base import (
    DispatchReceipt,
    ExecutorModel,
    ExecutorProbe,
    InterruptReceipt,
    NativeEvent,
    SessionStart,
)
from mona.development.executors.claude_account import (
    bind_local_account,
    is_local_account_bound,
    local_account_env,
    unbind_local_account,
)
from mona.development.executors.codebuddy_catalog import inspect_codebuddy_catalog
from mona.development.executors.codex import ApprovalHandler, QuestionHandler
from mona.development.executors.diagnostics import ERRORS, failed_probe
from mona.development.executors.host_tools import (
    DESIGN_ENVELOPE,
    HostToolHandler,
    call_in_turn,
    tool_unavailable,
)
from mona.development.executors.login import ACTIVE_LOGIN_STATES, NativeLogin, idle_login
from mona.development.executors.rpc import JsonRpcProcess, RemoteRpcError, RpcError
from mona.development.executors.sdk_policy import SDKProfile, sdk_version, worker_command
from mona.development.input_content import MAX_NATIVE_FRAME_BYTES, MessageContent, validate_content

_CAPABILITIES = Capabilities(resume=True, steering=False, interrupt=True, model_switch=True,
                            approval=True, usage=True, image_input=True, project_skills=True, rich_events=True)


def _worker_error(error: dict) -> RpcError | None:
    data = error.get("data")
    code = data.get("monaCode") if isinstance(data, dict) else None
    if error.get("code") == -32000 and isinstance(code, str) and code in ERRORS:
        return RpcError(code, ERRORS[code][1])
    return None


def _permission_modes(value: object) -> list[PermissionMode]:
    if not isinstance(value, list) or value not in ([PermissionMode.ASK.value, PermissionMode.AUTO.value],
                     [PermissionMode.ASK.value, PermissionMode.AUTO.value, PermissionMode.FULL_ACCESS.value]):
        raise RpcError("native_protocol_error", "SDK 权限模式能力回执无效。")
    return [PermissionMode(mode) for mode in value]


@dataclass
class _SDKSession:
    binding: Binding
    start: SessionStart
    connection: JsonRpcProcess | None = None
    queue: asyncio.Queue[NativeEvent | None] = field(default_factory=lambda: asyncio.Queue(maxsize=2048))
    status: str = "idle"
    turn_id: str | None = None
    dispatching: bool = False
    early: list[NativeEvent] = field(default_factory=list)
    closed: bool = False
    uses_local_account: bool = False
    pending_delta: NativeEvent | None = None

    def emit(self, event: NativeEvent) -> None:
        if self.closed:
            return
        # Work consumes text directly; Code keeps each persisted vendor event.
        is_delta = (self.start.work_prompt is not None
                    and event.type in {"agent.message.delta", "reasoning.delta", "tool.input.delta"}
                    and isinstance(event.payload.get("itemId"), str)
                    and isinstance(event.payload.get("delta"), str))
        previous = self.pending_delta
        if (is_delta and previous is not None and previous.type == event.type
                and previous.native_turn_id == event.native_turn_id
                and previous.payload["itemId"] == event.payload["itemId"]
                and len(previous.payload["delta"]) + len(event.payload["delta"]) <= 16_384):
            previous.payload = {**previous.payload, "delta": previous.payload["delta"] + event.payload["delta"]}
            previous.native_event_id = None
            return
        if self.queue.full():
            while not self.queue.empty():
                self.queue.get_nowait()
            self.status = "unknown"
            self.queue.put_nowait(NativeEvent(type="run.unknown", native_turn_id=self.turn_id,
                                            payload={"reason": "event_buffer_exhausted"}))
            self.closed = True
            self.pending_delta = None
            return
        self.queue.put_nowait(event)
        self.pending_delta = event if is_delta else None


class SDKExecutor:
    def __init__(self, profile: SDKProfile, *, approval_handler: ApprovalHandler | None = None,
                 question_handler: QuestionHandler | None = None, tool_handler: HostToolHandler | None = None):
        self.id = profile.executor
        self.profile, self.approval_handler = profile, approval_handler
        self.question_handler = question_handler
        self.tool_handler = tool_handler
        self._sessions: dict[str, _SDKSession] = {}
        self._starts: dict[str, SessionStart] = {}
        self._models: list[str] = []
        self._permission_modes: list[PermissionMode] = [PermissionMode.ASK]
        self._closed = False
        self._auth_connection: JsonRpcProcess | None = None
        self._login: NativeLogin | None = None
        self._login_lock = asyncio.Lock()

    def _environment(self) -> dict[str, str]:
        env = dict(self.profile.environment)
        if self.id == ExecutorId.CLAUDE:
            env["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] = "1"
            if "ANTHROPIC_BASE_URL" not in env:
                env.pop("ANTHROPIC_API_KEY", None)
                env.update(local_account_env(self.profile.home))
        return env

    async def probe(self) -> ExecutorProbe:
        connection = None
        version = None
        self._models = []
        self._permission_modes = [PermissionMode.ASK]
        async def deny(*_args):
            return "decline"
        try:
            version = sdk_version(self.id)
            environment = self._environment()
            connection = await JsonRpcProcess.spawn(worker_command(), cwd=self.profile.project_root,
                env=environment, notification=lambda *_: None, server_request=deny,
                disconnected=lambda _reason: None, request_timeout=30)
            result = await connection.request("probe", {"executor": self.id.value,
                "executable": str(self.profile.executable), "cwd": str(self.profile.project_root)}, classify_error=_worker_error)
            if not isinstance(result, dict) or result.get("protocolVerified") is not True:
                raise RpcError("native_protocol_error", "SDK 检查没有返回有效的原生握手结果。")
            auth = result.get("authentication")
            if auth not in {"unknown", "required"}:
                raise RpcError("native_protocol_error", "无任务检查不能冒称模型认证成功。")
            self._permission_modes = _permission_modes(result.get("permissionModes"))
            capabilities = _CAPABILITIES.model_copy(deep=True)
            capabilities.permission_modes = self._permission_modes.copy()
            models = result.get("models", [])
            if not isinstance(models, list) or not isinstance(result.get("version"), str):
                raise RpcError("native_protocol_error", "原生版本或模型列表格式不兼容。")
            self._models = [m.get("value", m.get("id", "")) for m in models if isinstance(m, dict)]
            if self.id == ExecutorId.CODEBUDDY:
                await connection.close()
                connection = None
                catalog = await inspect_codebuddy_catalog(self.profile)
                self._models = [model.id for model in catalog.model_details]
                return catalog.model_copy(update={"version": result["version"], "sdk_version": version,
                                                  "capabilities": capabilities})
            details = []
            for model in models:
                if not isinstance(model, dict) or not model.get("value", model.get("id")):
                    continue
                levels = model.get("supportedEffortLevels", []) if result.get("effortSupported") is True and model.get("supportsEffort") is True else []
                efforts = list(dict.fromkeys(value for value in levels if isinstance(value, str) and 0 < len(value) <= 32)) if isinstance(levels, list) else []
                default = model.get("defaultEffort")
                model_id = model.get("value", model.get("id"))
                details.append(ExecutorModel(id=model_id, label=model.get("displayName") or model_id,
                    description=model.get("description"), reasoning_efforts=efforts[:16],
                    reasoning_effort=default if default in efforts else None))
            if self.id == ExecutorId.CLAUDE and environment.get("CLAUDE_CODE_OAUTH_TOKEN"):
                auth = "ready"
            return ExecutorProbe(executor=self.id, state="ready" if auth == "ready" else "detected", version=result.get("version"), sdk_version=version,
                model_details=details,
                executable=str(self.profile.executable), stage="authentication", authentication=auth,
                capabilities=capabilities, protocol_verified=True,
                reason="已连接本机 Claude Code 账号。" if auth == "ready" else "程序版本与原生初始化已通过；尚未连接本机账号。",
                next_action="在本机 Claude Code 登录后，选择使用本机账号。" if auth == "required" else "可以发送任务；不把本次连接检查当作真实任务验收。")
        except RpcError as exc:
            return failed_probe(self.id, exc, executable=str(self.profile.executable), sdk_version=version)
        finally:
            if connection:
                await connection.close()

    def login_status(self) -> dict:
        return self._login.public() if self._login else idle_login()

    async def begin_login(self) -> dict:
        if self._closed:
            raise RpcError("native_host_closed", "执行者连接已关闭。")
        if self.id == ExecutorId.CLAUDE:
            async with self._login_lock:
                self._login = NativeLogin()
                try:
                    await asyncio.to_thread(bind_local_account, self.profile.home)
                    self._login.complete(True)
                except RpcError as exc:
                    self._login.complete(False, error_code=exc.code)
                except OSError:
                    self._login.complete(False, error_code="native_account_binding_failed")
                return self._login.public()
        async with self._login_lock:
            if self._closed:
                raise RpcError("native_host_closed", "执行者连接已关闭。")
            if self._login and self._login.state in ACTIVE_LOGIN_STATES:
                return self._login.public()
            sdk_version(self.id)
            if self._auth_connection:
                await self._auth_connection.close()
            attempt = self._login = NativeLogin()
            async def deny(*_args):
                return "decline"
            def notification(method, params):
                # The callback belongs to this connection, never to a later login.
                if method == "auth.completed" and type(params.get("success")) is bool:
                    attempt.complete(params["success"], error_code=params.get("errorCode"))
            try:
                connection = await JsonRpcProcess.spawn(worker_command(), cwd=self.profile.home,
                    env=self.profile.environment, notification=notification, server_request=deny,
                    disconnected=lambda _reason: attempt.disconnected(), request_timeout=60)
                self._auth_connection = connection
                result = await connection.request("auth/start", {"executable": str(self.profile.executable)}, classify_error=_worker_error)
                if (not isinstance(result, dict) or not isinstance(result.get("authUrl"), str)
                        or len(result["authUrl"]) > 16384):
                    raise RpcError("native_auth_reply_invalid", "认证回执无效，未使用替代登录方式。", outcome_unknown=True)
                attempt.attach(attempt.login_id, result["authUrl"])
                return attempt.public()
            except BaseException as exc:
                if isinstance(exc, asyncio.CancelledError) or getattr(exc, "outcome_unknown", False):
                    attempt.disconnected()
                else:
                    attempt.complete(False, error_code=getattr(exc, "code", None))
                if self._auth_connection:
                    await self._auth_connection.close()
                raise

    async def logout(self) -> None:
        if self.id != ExecutorId.CLAUDE:
            raise RpcError("unsupported_logout", "此连接没有受管账户断开操作。")
        async with self._login_lock:
            unbind_local_account(self.profile.home)
            self._login = None

    async def cancel_login(self, login_id: str) -> dict:
        async with self._login_lock:
            attempt = self._login
            if attempt is None or attempt.login_id != login_id:
                raise RpcError("login_not_current", "登录请求已经变化，未取消其他登录。")
            if attempt.state not in ACTIVE_LOGIN_STATES or attempt.state == "cancelling":
                return attempt.public()
            connection = self._auth_connection
            if connection is None or connection.closed:
                attempt.disconnected()
                return attempt.public()
            attempt.state = "cancelling"
            try:
                result = await connection.request("auth/cancel", {}, classify_error=_worker_error)
                if isinstance(result, dict) and result.get("cancelled") is True:
                    attempt.complete(False)
                elif attempt.state == "cancelling":
                    attempt.disconnected()
            except BaseException:
                attempt.disconnected()
                raise
            finally:
                await connection.close()
            return attempt.public()

    async def create_session(self, start: SessionStart) -> Binding:
        binding = Binding(session_id=start.session.id, executor=self.id, native_session_id=str(uuid.uuid4()),
            model_provider=start.session.model_provider,
            working_directory=str(start.context.root), readonly=start.readonly,
            permission_mode=start.session.permission_mode, capabilities=_CAPABILITIES)
        return await self._open(start, binding, resume=False)

    async def attach_session(self, start: SessionStart, binding: Binding) -> Binding:
        return await self._open(start, binding, resume=start.resume_history)

    async def resume_session(self, binding: Binding) -> Binding:
        start = self._starts.get(binding.id)
        if start is None:
            raise RpcError("binding_not_attached", "请通过当前项目恢复原生会话。")
        return await self._open(start, binding, resume=True)

    async def _open(self, start: SessionStart, binding: Binding, *, resume: bool) -> Binding:
        if self._closed or (binding.executor, binding.session_id, binding.working_directory, binding.readonly, binding.model_provider) != (
                self.id, start.session.id, str(start.context.root), start.readonly, start.session.model_provider):
            raise RpcError("binding_mismatch", "原生会话不属于当前项目或执行者。")
        if binding.permission_mode != start.session.permission_mode:
            raise RpcError("binding_mismatch", "原生会话权限模式与当前设置不一致。")
        if start.context.root != self.profile.project_root:
            raise RpcError("invalid_project_context", "原生宿主与项目范围不一致。")
        sdk_version(self.id)
        prior = self._sessions.get(binding.id)
        if prior:
            if prior.status not in {"idle", "not_loaded"}:
                raise RpcError("native_busy", "当前原生任务仍在执行或状态未知，未重建会话。")
            if prior.connection:
                await prior.connection.close()
            prior.closed = True
            if not prior.queue.full():
                prior.queue.put_nowait(None)
        runtime = _SDKSession(binding.model_copy(deep=True), start)
        work_mode = start.work_prompt is not None
        if work_mode and self.tool_handler is None:
            raise RpcError("sdk_host_tools_unsupported", "Work 工具宿主未连接，未启动原生会话。")
        host_tools = (not work_mode and self.tool_handler is not None and not start.readonly
                      and not start.session.parent_session_id)
        work_tools = work_mode and self.tool_handler is not None
        design_tools = not work_mode and self.tool_handler is not None
        async def request(_identifier, method, params):
            if method in {"host/collaboration", "host/design-resource"}:
                turn_id = params.get("turnId")
                resource = method == "host/design-resource"
                if not (design_tools if resource else host_tools or work_tools) or self.tool_handler is None or not isinstance(params.get("arguments"), dict):
                    return tool_unavailable()
                arguments = {DESIGN_ENVELOPE: params["arguments"]} if resource else params["arguments"]
                return await call_in_turn(self.tool_handler, runtime.binding, turn_id, arguments,
                    lambda: runtime.turn_id == turn_id and runtime.status in {"starting", "running", "waiting_user"}
                    and runtime.connection is not None and not runtime.connection.closed,
                    timeout_s=None if work_mode else 90)
            fallback = {} if method == "question" else "decline"
            if method not in {"permission", "question"} or params.get("turnId") != runtime.turn_id or runtime.status not in {"running", "starting", "waiting_user"}:
                return fallback
            if method == "question" and self.question_handler is None:
                return fallback
            if method == "permission" and (self.approval_handler is None or runtime.start.readonly):
                return fallback
            runtime.status = "waiting_user"
            try:
                if method == "question":
                    return await self.question_handler(runtime.binding, params)
                return await self.approval_handler(runtime.binding, method, params)
            finally:
                if runtime.status == "waiting_user":
                    runtime.status = "running"
        def notification(method, params):
            if method != "event":
                return
            event = NativeEvent.model_validate(params)
            if event.type.startswith("session."):
                return
            if runtime.dispatching:
                if len(runtime.early) >= 256:
                    raise ValueError("early_event_overflow")
                runtime.early.append(event)
            else:
                self._deliver(runtime, event)
        def disconnected(reason):
            if runtime.status == "idle":
                runtime.status = "not_loaded"
            else:
                runtime.status = "unknown"
                runtime.emit(NativeEvent(type="run.unknown", native_turn_id=runtime.turn_id, payload={"reason": reason}))
        environment = self._environment()
        runtime.uses_local_account = bool(environment.get("CLAUDE_CODE_OAUTH_TOKEN"))
        connection = await JsonRpcProcess.spawn(worker_command(), cwd=start.context.root,
            env=environment, notification=notification, server_request=request,
            disconnected=disconnected, request_timeout=60, max_frame_bytes=MAX_NATIVE_FRAME_BYTES)
        runtime.connection = connection
        try:
            reply = await connection.request("initialize", {"executor": self.id.value, "cwd": str(start.context.root),
                "executable": str(self.profile.executable), "nativeSessionId": binding.native_session_id,
                "readonly": start.readonly, "isSubagent": bool(start.session.parent_session_id),
                "context": start.context.model_context(), "model": start.model, "resume": resume,
                "permissionMode": start.session.permission_mode.value,
                "effort": start.session.model_reasoning_effort if not start.session.model_provider else None,
                "hostCollaboration": host_tools, "hostDesignResources": design_tools, "workPrompt": start.work_prompt},
                classify_error=_worker_error)
            if not isinstance(reply, dict) or reply.get("nativeSessionId") != binding.native_session_id:
                raise RpcError("native_protocol_error", "SDK 初始化回执身份不一致。", outcome_unknown=True)
            runtime.binding.protocol_version = str(reply.get("sdkVersion", ""))
            runtime.binding.context_fingerprint = start.context.rules_fingerprint + ":" + start.context.skills_fingerprint
            runtime.binding.state = "active"
            if reply.get("hostCollaboration", False) is not host_tools:
                raise RpcError("native_protocol_error", "SDK 宿主协作能力未按要求装配。")
            if reply.get("hostDesignResources", False) is not design_tools:
                raise RpcError("native_protocol_error", "SDK 内置设计资源未按要求装配。")
            if reply.get("workMode", False) is not work_mode:
                raise RpcError("native_protocol_error", "SDK Work 工具通道未按要求装配。")
            if reply.get("permissionMode") != start.session.permission_mode.value:
                raise RpcError("native_protocol_error", "SDK 初始化没有应用所选权限模式。", outcome_unknown=True)
            permission_modes = _permission_modes(reply.get("permissionModes"))
            if start.session.permission_mode not in permission_modes:
                raise RpcError("sdk_contract_incompatible", "当前 SDK 不支持所选权限模式。")
            self._permission_modes = permission_modes
            runtime.binding.capabilities.permission_modes = permission_modes.copy()
            runtime.binding.capabilities.host_subagents = host_tools
            models = reply.get("models", [])
            self._models = [m.get("value", m.get("id", "")) for m in models if isinstance(m, dict)] if isinstance(models, list) else []
            self._sessions[binding.id], self._starts[binding.id] = runtime, start
            return runtime.binding.model_copy(deep=True)
        except BaseException:
            await connection.close()
            raise

    def _runtime(self, binding: Binding) -> _SDKSession:
        value = self._sessions.get(binding.id)
        if value is None or (value.binding.session_id, value.binding.native_session_id) != (binding.session_id, binding.native_session_id):
            raise RpcError("binding_not_attached", "请先恢复原生执行会话。")
        return value

    def _deliver(self, runtime: _SDKSession, event: NativeEvent) -> None:
        if event.native_turn_id != runtime.turn_id or runtime.status in {"idle", "not_loaded"}:
            return
        if event.type in {"run.completed", "run.failed", "run.interrupted"}:
            runtime.status = "idle"
        elif event.type == "run.unknown":
            runtime.status = "unknown"
        runtime.emit(event)

    async def send(self, binding: Binding, input_id: str, message: MessageContent) -> DispatchReceipt:
        runtime = self._runtime(binding)
        validate_content(message, context_input=runtime.start.work_prompt is not None)
        if runtime.status != "idle" or runtime.connection is None or runtime.connection.closed:
            return DispatchReceipt(input_id=input_id, outcome="rejected", reason="原生会话不可接收新一轮任务。")
        if runtime.uses_local_account and not is_local_account_bound(self.profile.home):
            return DispatchReceipt(input_id=input_id, outcome="rejected", reason="本机账号已断开，请重新连接后再发送任务。")
        runtime.dispatching = True
        runtime.status, runtime.turn_id = "starting", "sdk:" + input_id
        try:
            reply = await runtime.connection.request("send", {"inputId": input_id, "text": message})
            if reply.get("inputId") != input_id or reply.get("turnId") != runtime.turn_id:
                raise RpcError("native_turn_mismatch", "SDK 派发回执不属于当前输入。", outcome_unknown=True)
            runtime.status = "running"
            runtime.emit(NativeEvent(type="run.started", native_turn_id=runtime.turn_id,
                payload={"turnIdentitySource": "host_dispatch"}))
            for event in runtime.early:
                self._deliver(runtime, event)
            return DispatchReceipt(input_id=input_id, outcome="accepted", native_turn_id=runtime.turn_id)
        except (RpcError, asyncio.CancelledError):
            # An SDK rejection can follow a successful pipe write; do not assume
            # the original command did not execute just because no receipt arrived.
            runtime.status = "unknown"
            runtime.emit(NativeEvent(type="run.unknown", native_turn_id=runtime.turn_id, payload={"reason": "sdk_dispatch_unknown"}))
            return DispatchReceipt(input_id=input_id, outcome="unknown", native_turn_id=runtime.turn_id)
        finally:
            runtime.dispatching = False
            runtime.early.clear()

    async def steer(self, binding: Binding, input_id: str, message: MessageContent) -> DispatchReceipt:
        return DispatchReceipt(input_id=input_id, outcome="rejected", reason="当前 SDK 入口不提供运行中引导，请发送为后续消息。")

    async def interrupt(self, binding: Binding, *, native_turn_id: str | None = None) -> InterruptReceipt:
        runtime = self._runtime(binding)
        if native_turn_id and runtime.turn_id not in {None, native_turn_id}:
            raise RpcError("native_turn_mismatch", "任务已变化，未停止其它任务。")
        if runtime.status == "idle":
            return InterruptReceipt(outcome="already_finished")
        if not runtime.connection or runtime.connection.closed:
            return InterruptReceipt(outcome="unknown")
        try:
            await runtime.connection.request("interrupt")
            return InterruptReceipt(outcome="requested")
        except RpcError:
            return InterruptReceipt(outcome="unknown")

    async def get_status(self, binding: Binding) -> str:
        return self._runtime(binding).status

    async def inspect_turn(self, binding: Binding, native_turn_id: str) -> list[NativeEvent]:
        raise RpcError("native_history_unsupported", "此 SDK 不提供指定执行轮次的只读核对接口；历史仍保留，未重新执行请求。")

    async def list_models(self) -> list[str]:
        return [m for m in self._models if isinstance(m, str) and m]

    async def events(self, binding: Binding) -> AsyncIterator[NativeEvent]:
        runtime = self._runtime(binding)
        while True:
            event = await runtime.queue.get()
            if event is runtime.pending_delta:
                runtime.pending_delta = None
            if event is None:
                return
            yield event

    async def close_runtime(self, binding: Binding, *, force: bool = False) -> None:
        runtime = self._runtime(binding)
        if not force and runtime.status not in {"idle", "not_loaded"}:
            raise RpcError("native_busy", "请先结束原生任务，再释放执行进程。")
        if runtime.connection and not runtime.connection.closed:
            with_error = False
            if not force:
                try:
                    await runtime.connection.request("close")
                except RemoteRpcError:
                    with_error = True
            if with_error:
                raise RpcError("native_busy", "原生进程尚未确认可关闭。")
            await runtime.connection.close()
        runtime.closed = True
        if not runtime.queue.full():
            runtime.queue.put_nowait(None)
        self._sessions.pop(binding.id, None)

    async def shutdown(self) -> None:
        self._closed = True
        if self._auth_connection:
            await self._auth_connection.close()
        for runtime in list(self._sessions.values()):
            if runtime.connection:
                await runtime.connection.close()
            runtime.closed = True
            if not runtime.queue.full():
                runtime.queue.put_nowait(None)
