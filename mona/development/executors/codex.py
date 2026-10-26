"""Native Codex App Server adapter with per-thread ownership and shared transport.

Cindy reference: app-server/{host,client,stdioTransport}.ts. This implementation
keeps Mona's project-only policy instead of Cindy's user config/MCP injection.
No model Provider is used here and no product transcript is written by adapters.
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from mona.development.contracts import Binding, Capabilities, ExecutorId, PermissionMode
from mona.development.design_resources import (
    DESIGN_DESCRIPTION,
    DESIGN_POLICY_TAG,
    DESIGN_TOOL,
    DesignResourceCall,
)
from mona.development.executors.account_usage import AccountUsage, account_identity, with_usage
from mona.development.executors.base import (
    DispatchReceipt,
    ExecutorModel,
    ExecutorProbe,
    InterruptReceipt,
    NativeEvent,
    SessionStart,
)
from mona.development.executors.codex_events import normalize_codex_event, thread_id
from mona.development.executors.codex_policy import (
    CodexProfile,
    disabled_skill_overrides,
    similar_command_prefix,
    validate_effective_config,
)
from mona.development.executors.diagnostics import failed_probe
from mona.development.executors.host_tools import (
    COLLABORATION_POLICY_TAG,
    DELEGATION_INSTRUCTIONS,
    DESIGN_ENVELOPE,
    HOST_DESCRIPTION,
    HOST_TOOL,
    SUBAGENT_INSTRUCTIONS,
    WORK_DESCRIPTION,
    WORK_TOOL,
    HostToolCall,
    HostToolHandler,
    WorkToolCall,
    call_in_turn,
    tool_unavailable,
)
from mona.development.executors.login import ACTIVE_LOGIN_STATES, NativeLogin, idle_login
from mona.development.executors.rpc import (
    JsonId,
    JsonRpcProcess,
    MissingNativeSessionError,
    RemoteRpcError,
    RpcError,
)
from mona.development.input_content import (
    MAX_NATIVE_FRAME_BYTES,
    MessageContent,
    codex_input,
    encoded_content,
)

Approval = Literal["accept", "decline", "cancel"]
ApprovalHandler = Callable[[Binding, str, dict[str, Any]], Awaitable[Approval]]
QuestionHandler = Callable[[Binding, dict[str, Any]], Awaitable[dict[str, list[str]]]]
_TERMINAL = {"completed", "failed", "interrupted"}
_CAPABILITIES = Capabilities(resume=True, turn_history=True, steering=True, interrupt=True, model_switch=True,
                            approval=True, usage=True, image_input=True, project_skills=True, rich_events=True,
                            permission_modes=[PermissionMode.ASK, PermissionMode.AUTO, PermissionMode.FULL_ACCESS])


def _thread_permissions(permission_mode: PermissionMode, readonly: bool) -> tuple[str, str, str]:
    """Resolve the selected product mode to Codex's session-level policy."""
    if readonly:
        return "on-request", "user", "read-only"
    if permission_mode == PermissionMode.FULL_ACCESS:
        return "never", "user", "danger-full-access"
    # Both ask and auto use the same native gate. Auto review is supplied by
    # Mona's approval handler, so Codex must continue routing requests to it.
    return "on-request", "user", "workspace-write"


def _missing_resume(error: dict[str, Any], native_id: str) -> RpcError | None:
    # Codex also uses -32600 for invalid project configuration. Do not classify
    # by error number, substrings, stderr, or a different thread's identifier.
    if error.get("code") == -32600 and error.get("message") == f"no rollout found for thread id {native_id}":
        return MissingNativeSessionError()
    return None


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
    queued_output: NativeEvent | None = None
    completed_turns: OrderedDict[str, str] = field(default_factory=OrderedDict)
    receipts: OrderedDict[str, tuple[str, DispatchReceipt]] = field(default_factory=OrderedDict)

    def publish(self, event: NativeEvent) -> None:
        size = len(event.model_dump_json().encode("utf-8"))
        if self.desynchronized:
            return
        previous = self.queued_output
        if (previous is not None and event.type == "command.output" and event.native_event_id is None
                and previous.native_turn_id == event.native_turn_id
                and previous.payload.get("itemId") == event.payload.get("itemId")
                and isinstance(event.payload.get("delta"), str)):
            combined = previous.model_copy(update={"payload": {**previous.payload,
                "delta": previous.payload["delta"] + event.payload["delta"]}})
            combined_size = len(combined.model_dump_json().encode("utf-8"))
            if combined_size <= 16_384:
                extra = combined_size - len(previous.model_dump_json().encode("utf-8"))
                if self.queued_bytes + extra > 8_388_608:
                    self.fault("event_buffer_exhausted")
                    return
                self.queued_bytes += extra
                previous.payload = combined.payload
                return
        if self.queue.qsize() >= 2048 or self.queued_bytes + size > 8_388_608:
            self.fault("event_buffer_exhausted")
            return
        self.queue.put_nowait((event, size))
        self.queued_bytes += size
        self.queued_output = event if event.type == "command.output" and event.native_event_id is None and isinstance(event.payload.get("delta"), str) else None

    def fault(self, reason: str) -> None:
        self.status = "unknown"
        self.desynchronized = True
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queued_bytes = 0
        self.queued_output = None
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
                 question_handler: QuestionHandler | None = None, request_timeout: float = 30.0,
                 tool_handler: HostToolHandler | None = None, account_changed: Callable[[bool], None] | None = None):
        self.profile = profile
        self._approval_handler = approval_handler
        self._question_handler = question_handler
        self._tool_handler = tool_handler
        self._account_changed = account_changed
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
        self._auth_mode: Literal["unknown", "chatgpt", "api_key"] = "unknown"
        self._login: NativeLogin | None = None
        self._login_lock = asyncio.Lock()
        self._model_details: list[ExecutorModel] = []

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
            if self._login and self._login.state == "unknown":
                # The old callback process has now actually ended. Its account
                # state is checked separately; never call that attempt successful.
                self._login.complete(False)
        client = await JsonRpcProcess.spawn(
            self.profile.command, cwd=self.profile.project_root, env=self.profile.environment,
            notification=self._on_notification, server_request=self._on_server_request,
            disconnected=self._on_disconnect, request_timeout=self._timeout, max_frame_bytes=MAX_NATIVE_FRAME_BYTES,
        )
        self._client = client
        try:
            reply = await client.request("initialize", {"clientInfo": {
                "name": "mona_development", "title": "Mona Development", "version": "1.8.0",
            }, "capabilities": {"experimentalApi": True}})
            if not isinstance(reply, dict):
                raise RpcError("native_protocol_error", "原生初始化回执无效。")
            self._version = reply.get("userAgent") if isinstance(reply.get("userAgent"), str) else None
            await client.notify("initialized")
            await self._check_policy(client)
            account = await client.request("account/read", {"refreshToken": False})
            if not isinstance(account, dict) or "requiresOpenaiAuth" not in account:
                raise RpcError("native_protocol_error", "原生认证状态回执无效。")
            self._auth = "ready" if account.get("account") or account.get("requiresOpenaiAuth") is False else "required"
            account_type = (account.get("account") or {}).get("type") if isinstance(account.get("account"), dict) else None
            self._auth_mode = "chatgpt" if account_type == "chatgpt" else "api_key" if account_type == "apiKey" else "unknown"
            return client
        except BaseException:
            await client.close()
            raise

    async def _check_policy(self, client: JsonRpcProcess) -> None:
        reply = await client.request("config/read", {"includeLayers": False, "cwd": str(self.profile.project_root)})
        validate_effective_config(reply, model_endpoint=self.profile.model_endpoint,
                                  work_model_catalog=self.profile.work_model_catalog)
        self._isolation_checked = True

    async def probe(self) -> ExecutorProbe:
        try:
            client = await self._ensure_started()
            account = await client.request("account/read", {"refreshToken": False})
            if not isinstance(account, dict) or type(account.get("requiresOpenaiAuth")) is not bool:
                raise RpcError("native_protocol_error", "原生认证状态回执无效。")
            self._auth = "ready" if account.get("account") or account["requiresOpenaiAuth"] is False else "required"
            account_type = (account.get("account") or {}).get("type") if isinstance(account.get("account"), dict) else None
            self._auth_mode = "chatgpt" if account_type == "chatgpt" else "api_key" if account_type == "apiKey" else "unknown"
            await self.list_models()
            return ExecutorProbe(executor=self.id, state="ready" if self._auth == "ready" else "detected",
                                 executable=self.profile.command[0], version=self._version,
                                 authentication=self._auth, auth_mode=self._auth_mode, capabilities=_CAPABILITIES,
                                 model_details=self._model_details,
                                 isolation_verified=self._isolation_checked, protocol_verified=True,
                                 stage="ready" if self._auth == "ready" else "authentication",
                                 error_code=None if self._auth == "ready" else "authentication_required",
                                 next_action="可以发送任务；本次没有执行代码任务。" if self._auth == "ready" else "使用官方登录入口完成受管环境认证。",
                                 reason="原生协议和有效配置检查已通过；真实任务仍需单独验收。")
        except RpcError as exc:
            return failed_probe(self.id, exc, executable=self.profile.command[0], version=self._version)

    async def account_usage(self) -> AccountUsage:
        client = await self._ensure_started()
        account = await client.request("account/read", {"refreshToken": False})
        if not isinstance(account, dict):
            raise RpcError("native_protocol_error", "原生账号状态回执无效。")
        identity = account_identity(account)
        if not identity.connected:
            return identity
        try:
            reply = await client.request("account/rateLimits/read", omit_params=True)
            if not isinstance(reply, dict):
                raise ValueError("invalid usage snapshot")
            result = with_usage(identity, reply)
            after = await client.request("account/read", {"refreshToken": False})
            if not isinstance(after, dict):
                raise ValueError("invalid account snapshot")
            current = account_identity(after)
            if (current.connected, current.account_key, current.email, current.plan_type) != (identity.connected, identity.account_key, identity.email, identity.plan_type):
                if self._account_changed:
                    self._account_changed(True)
                return current.model_copy(update={"error": "账号已变化，正在重新读取额度。"})
            return result
        except (RpcError, ValueError):
            return identity.model_copy(update={"error": "暂时无法读取订阅额度，请重试。"})

    def login_status(self) -> dict:
        return self._login.public() if self._login else idle_login()

    async def logout(self) -> None:
        client = await self._ensure_started()
        account = await client.request("account/read", {"refreshToken": False})
        if not isinstance(account, dict) or not isinstance(account.get("account"), dict) or account["account"].get("type") != "chatgpt":
            raise RpcError("chatgpt_not_connected", "当前未连接 ChatGPT 订阅账号。")
        await client.request("account/logout", omit_params=True)
        self._auth = "required"
        self._auth_mode = "unknown"
        self._login = None

    async def begin_login(self) -> dict:
        """Share one pending attempt; a lost response never starts a second login."""
        async with self._login_lock:
            if self._login and self._login.state in ACTIVE_LOGIN_STATES:
                return self._login.public()
            client = await self._ensure_started()
            attempt = self._login = NativeLogin()
            try:
                reply = await client.request("account/login/start", {"type": "chatgpt"})
                if (not isinstance(reply, dict) or not all(isinstance(reply.get(k), str)
                        and 0 < len(reply[k]) <= limit for k, limit in (("loginId", 512), ("authUrl", 16384)))):
                    raise RpcError("native_protocol_error", "登录回执不兼容，未打开未知链接。", outcome_unknown=True)
                attempt.attach(reply["loginId"], reply["authUrl"])
                return attempt.public()
            except BaseException as exc:
                if isinstance(exc, asyncio.CancelledError) or getattr(exc, "outcome_unknown", False):
                    attempt.disconnected()
                else:
                    attempt.complete(False)
                raise

    async def cancel_login(self, login_id: str) -> dict:
        async with self._login_lock:
            attempt = self._login
            if attempt is None or attempt.login_id != login_id:
                raise RpcError("login_not_current", "登录请求已经变化，未取消其他登录。")
            if attempt.state not in ACTIVE_LOGIN_STATES or attempt.state == "cancelling":
                return attempt.public()
            if not attempt.native_id or self._client is None or self._client.closed:
                attempt.disconnected()
                return attempt.public()
            attempt.state = "cancelling"
            try:
                await self._client.request("account/login/cancel", {"loginId": attempt.native_id})
            except BaseException:
                attempt.disconnected()
                raise
            # The RPC acknowledgement is not the login-completed notification.
            return attempt.public()

    async def create_session(self, start: SessionStart) -> Binding:
        return await self._open(start, None)

    async def attach_session(self, start: SessionStart, binding: Binding) -> Binding:
        """Restore a host-verified persisted binding after process/app restart."""
        self._validate_start(start)
        if (binding.session_id != start.session.id or binding.executor != self.id
                or binding.working_directory != str(start.context.root) or binding.readonly != start.readonly
                or binding.permission_mode != start.session.permission_mode
                or binding.model_provider != start.session.model_provider):
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
        work_mode = start.work_prompt is not None
        if work_mode and self.profile.work_model_catalog is None:
            raise RpcError("work_policy_unverified", "此模型引擎尚未启用普通会话的工具权限。")
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
            skills = await client.request("skills/list", {"cwds": [str(start.context.root)], "forceReload": True}) if not work_mode else {}
            disabled = disabled_skill_overrides(skills, start.context) if not work_mode else []
            approval_policy, approvals_reviewer, sandbox_policy = _thread_permissions(
                start.session.permission_mode, start.readonly or work_mode)
            params: dict[str, Any] = {
                "cwd": str(start.context.root), "approvalPolicy": approval_policy,
                "approvalsReviewer": approvals_reviewer, "sandbox": sandbox_policy,
                "developerInstructions": WORK_DESCRIPTION if work_mode else start.context.model_context(),
                "config": {"skills.config": disabled},
            }
            host_tools = (self._tool_handler is not None and not start.readonly
                          and not start.session.parent_session_id
                          and (binding is None or binding.capabilities.host_subagents))
            design_tools = (not work_mode and self._tool_handler is not None
                            and (binding is None or DESIGN_POLICY_TAG in (binding.context_fingerprint or "")))
            if work_mode:
                params["baseInstructions"] = start.work_prompt
                params["environments"] = []
            elif host_tools:
                params["developerInstructions"] += "\n" + DELEGATION_INSTRUCTIONS
            elif start.session.parent_session_id:
                params["developerInstructions"] += "\n" + SUBAGENT_INSTRUCTIONS
            # Dynamic tools persist at thread/start; resume cannot add them.
            # Legacy contexts gain them only through a safe idle replacement.
            if binding is None and (host_tools or design_tools):
                params["dynamicTools"] = ([{"type": "function", "name": WORK_TOOL if work_mode else HOST_TOOL,
                    "description": WORK_DESCRIPTION if work_mode else HOST_DESCRIPTION,
                    "inputSchema": WorkToolCall.model_json_schema() if work_mode else HostToolCall.model_json_schema()}] if host_tools else [])
                if design_tools:
                    params["dynamicTools"].append({"type": "function", "name": DESIGN_TOOL,
                        "description": DESIGN_DESCRIPTION, "inputSchema": DesignResourceCall.model_json_schema()})
            if start.model:
                params["model"] = start.model
            if start.session.model_provider:
                params["modelProvider"] = "mona_models"
                if start.context_window_tokens:
                    params["config"]["model_context_window"] = start.context_window_tokens
            if binding is not None:
                params["threadId"] = binding.native_session_id
                version = re.search(r"/(\d+)\.(\d+)\.(\d+)(?:[-+ )]|$)", self._version or "")
                if version and tuple(map(int, version.groups())) >= (0, 125, 0):
                    params["excludeTurns"] = True
            self._opening = True
            self._early = []
            try:
                reply = await client.request("thread/resume" if binding else "thread/start", params,
                    classify_error=(lambda error: _missing_resume(error, binding.native_session_id)) if binding else None)
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
                expected_sandbox = {"read-only": "readOnly", "workspace-write": "workspaceWrite",
                                    "danger-full-access": "dangerFullAccess"}[sandbox_policy]
                if not isinstance(sandbox, dict) or sandbox.get("type") != expected_sandbox:
                    raise RpcError("project_policy_violation", "原生会话没有启用要求的文件权限边界。", outcome_unknown=True)
                if (reply.get("approvalPolicy") != approval_policy
                        or reply.get("approvalsReviewer") != approvals_reviewer):
                    raise RpcError("project_policy_violation", "原生会话审批策略未生效。", outcome_unknown=True)
                if native_id in self._threads and binding is None:
                    raise RpcError("binding_mismatch", "新建会话回执重复了已有线程。", outcome_unknown=True)
                active = binding.model_copy(deep=True) if binding else Binding(
                    session_id=start.session.id, executor=self.id, native_session_id=native_id,
                    model_provider=start.session.model_provider,
                    working_directory=str(start.context.root), readonly=start.readonly,
                    permission_mode=start.session.permission_mode, capabilities=_CAPABILITIES,
                )
                active.state = "active"
                active.context_fingerprint = start.context.rules_fingerprint + ":" + start.context.skills_fingerprint
                if design_tools:
                    active.context_fingerprint += DESIGN_POLICY_TAG
                if binding is None or (binding.context_fingerprint or "").endswith(COLLABORATION_POLICY_TAG):
                    active.context_fingerprint += COLLABORATION_POLICY_TAG
                active.protocol_version = self._version
                active.capabilities = _CAPABILITIES.model_copy(deep=True)
                active.capabilities.host_subagents = host_tools
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
                if thread.get("status", {}).get("type") in {"active", "systemError"} and runtime.turn_id is None:
                    runtime.fault("native_turn_state_unverified")
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
        if known is None or (known.session_id, known.native_session_id, known.working_directory, known.executor,
                known.readonly, known.permission_mode, known.model_provider) != (binding.session_id,
                binding.native_session_id, binding.working_directory, binding.executor, binding.readonly,
                binding.permission_mode, binding.model_provider):
            raise RpcError("binding_mismatch", "原生会话绑定未验证或被替换。")
        return known

    def _runtime(self, binding: Binding) -> _Thread:
        known = self._validate_binding(binding)
        runtime = self._threads.get(known.native_session_id)
        if runtime is None:
            raise RpcError("native_not_loaded", "原生会话已停泊，请恢复原绑定后继续。")
        return runtime

    async def send(self, binding: Binding, input_id: str, message: MessageContent) -> DispatchReceipt:
        return await self._dispatch_input(binding, input_id, message, steering=False)

    async def steer(self, binding: Binding, input_id: str, message: MessageContent) -> DispatchReceipt:
        return await self._dispatch_input(binding, input_id, message, steering=True)

    async def _dispatch_input(self, binding: Binding, input_id: str, message: MessageContent, *, steering: bool) -> DispatchReceipt:
        runtime = self._runtime(binding)
        if not input_id or len(input_id) > 200:
            raise RpcError("invalid_input", "请求标识和消息内容不能为空。")
        content = codex_input(message)
        fingerprint = hashlib.sha256((str(steering) + "\x00" + encoded_content(message)).encode()).hexdigest()
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
                "input": content, "clientUserMessageId": input_id}
            if steering:
                params["expectedTurnId"] = previous_turn
            elif runtime.start.session.model_reasoning_effort is not None and not runtime.start.session.model_provider:
                params["effort"] = runtime.start.session.model_reasoning_effort
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

    async def interrupt(self, binding: Binding, *, native_turn_id: str | None = None) -> InterruptReceipt:
        runtime = self._runtime(binding)
        if native_turn_id and runtime.turn_id not in {None, native_turn_id} and runtime.status != "idle":
            raise RpcError("native_turn_mismatch", "任务已变化，未停止其它任务。")
        if runtime.status == "idle" and native_turn_id is None:
            return InterruptReceipt(outcome="already_finished")
        turn_id = native_turn_id or runtime.turn_id
        if not turn_id or self._client is None or self._client.closed:
            return InterruptReceipt(outcome="unknown")
        runtime.turn_id = turn_id
        runtime.status = "interrupting"
        # Receive this turn's stop confirmation even after its event stream was lost.
        runtime.desynchronized = False
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
            return "not_loaded" if runtime.status in {"idle", "not_loaded"} else "unknown"
        reply = await self._client.request("thread/read", {"threadId": binding.native_session_id, "includeTurns": False})
        thread = reply.get("thread", {}) if isinstance(reply, dict) else {}
        if thread.get("id") != binding.native_session_id or not _same_root(thread.get("cwd"), Path(binding.working_directory)):
            raise RpcError("binding_mismatch", "状态回执不属于当前原生会话。")
        if thread.get("status", {}).get("type") in {"active", "systemError"} and runtime.status == "idle":
            runtime.fault("native_turn_state_unverified")
        return "unknown" if runtime.desynchronized else runtime.status

    async def inspect_turn(self, binding: Binding, native_turn_id: str) -> list[NativeEvent]:
        """Explicit read-only recovery of a completed turn; never reruns its prompt."""
        runtime = self._runtime(binding)
        if self._client is None or self._client.closed:
            raise RpcError("native_not_loaded", "请先恢复原生会话，再核对原轮次结果。")
        if runtime.turn_id not in {None, native_turn_id} and runtime.status != "idle":
            raise RpcError("native_busy", "原生会话正在执行另一轮次，未改变其状态。")
        try:
            reply = await self._client.request("thread/read", {"threadId": binding.native_session_id, "includeTurns": True})
        except RemoteRpcError as exc:
            if exc.rpc_code == -32601:
                metadata = await self._client.request("thread/read", {"threadId": binding.native_session_id, "includeTurns": False})
                thread = metadata.get("thread") if isinstance(metadata, dict) else None
                if (not isinstance(thread, dict) or thread.get("id") != binding.native_session_id
                        or not _same_root(thread.get("cwd"), Path(binding.working_directory))):
                    raise RpcError("binding_mismatch", "任务状态不属于当前项目会话。") from exc
                if thread.get("status", {}).get("type") == "idle":
                    raise RpcError("native_history_unavailable_idle", "任务已不在执行，但未收到完成结果。", outcome_unknown=True) from exc
                raise RpcError("native_history_unsupported", "当前 CLI 不支持查询完整轮次历史；原任务仍保留，未自动重新执行。") from exc
            raise
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
            if thread.get("status", {}).get("type") == "idle":
                raise RpcError("native_history_unavailable_idle", "任务已不在执行，但未收到完成结果。", outcome_unknown=True)
            if turn.get("status") == "inProgress" and thread.get("status", {}).get("type") == "active":
                runtime.turn_id, runtime.status = native_turn_id, "running"
                runtime.desynchronized = False
                return [NativeEvent(native_turn_id=native_turn_id, type="run.started", payload={"reconciled": True})]
            raise RpcError("native_turn_not_finished", "原轮次尚未确认结束，请继续观察；未重新执行请求。", outcome_unknown=True)
        items = turn.get("items")
        if not isinstance(items, list) or len(items) > 10000:
            raise RpcError("native_history_incomplete", "原生轮次内容不完整，未标记恢复成功。")
        events: list[NativeEvent] = []
        for item in items:
            event = normalize_codex_event("item/completed", {"threadId": binding.native_session_id,
                                         "turnId": native_turn_id, "item": item},
                                         host_tools=runtime.binding.capabilities.host_subagents,
                                         design_tools=DESIGN_POLICY_TAG in (runtime.binding.context_fingerprint or ""))
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
        details: list[ExecutorModel] = []
        cursor: str | None = None
        seen: set[str] = set()
        for _ in range(20):
            reply = await client.request("model/list", {"cursor": cursor, "limit": 100})
            if not isinstance(reply, dict) or not isinstance(reply.get("data"), list):
                raise RpcError("native_protocol_error", "模型列表回执不兼容。")
            for entry in reply["data"]:
                if isinstance(entry, dict) and isinstance(entry.get("model"), str):
                    models.append(entry["model"])
                    levels = entry.get("supportedReasoningEfforts", [])
                    efforts = list(dict.fromkeys(item["reasoningEffort"] for item in levels
                        if isinstance(item, dict) and isinstance(item.get("reasoningEffort"), str)
                        and 0 < len(item["reasoningEffort"]) <= 32)) if isinstance(levels, list) else []
                    default = entry.get("defaultReasoningEffort")
                    details.append(ExecutorModel(id=entry["model"], label=entry.get("displayName") or entry["model"],
                        description=entry.get("description"), reasoning_efforts=efforts[:16],
                        reasoning_effort=default if default in efforts else None))
            cursor = reply.get("nextCursor")
            if cursor is None:
                self._model_details = list({model.id: model for model in details}.values())
                return list(dict.fromkeys(models))
            if not isinstance(cursor, str) or cursor in seen:
                break
            seen.add(cursor)
        raise RpcError("native_pagination_error", "模型列表未完整返回，未把部分列表当作完整结果。")

    async def close_runtime(self, binding: Binding, *, force: bool = False) -> None:
        runtime = self._runtime(binding)
        if not force and runtime.status != "idle":
            raise RpcError("native_busy", "请先中断并确认当前轮次结束，再释放原生会话。")
        released = False
        try:
            if self._client is None or self._client.closed:
                raise RpcError("native_disconnected", "连接已断开，无法确认原生会话已卸载。", outcome_unknown=True)
            await self._client.request("thread/unsubscribe", {"threadId": binding.native_session_id})
            released = True
        finally:
            if force or released:
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
                if event is not None and event.type == "command.output" and event.native_event_id is None:
                    size = len(event.model_dump_json().encode("utf-8"))
                if event is runtime.queued_output:
                    runtime.queued_output = None
                runtime.queued_bytes -= size
                if event is None:
                    return
                yield event
        finally:
            runtime.receiving = False

    def _on_notification(self, method: str, params: dict[str, Any]) -> None:
        if method in {"account/updated", "account/rateLimits/updated", "account/login/completed"} and self._account_changed:
            self._account_changed(method != "account/rateLimits/updated")
        if method == "account/login/completed":
            if self._login:
                self._login.notify(params.get("loginId"), params.get("success"))
            return
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
        event = normalize_codex_event(method, params, host_tools=runtime.binding.capabilities.host_subagents,
                                      work_tools=runtime.start.work_prompt is not None,
                                      design_tools=DESIGN_POLICY_TAG in (runtime.binding.context_fingerprint or ""))
        if event is None:
            return
        turn_id = event.native_turn_id
        if event.type == "usage.updated" and (runtime.turn_id is None or turn_id != runtime.turn_id):
            return
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
        if method == "item/tool/call":
            value = tool_unavailable()
            design_call = (runtime is not None and params.get("tool") == DESIGN_TOOL
                           and DESIGN_POLICY_TAG in (runtime.binding.context_fingerprint or ""))
            allowed = design_call or (runtime is not None and runtime.binding.capabilities.host_subagents
                and params.get("tool") == (WORK_TOOL if runtime.start.work_prompt is not None else HOST_TOOL))
            if (is_current and runtime is not None and allowed
                    and self._tool_handler is not None
                    and params.get("namespace") is None and isinstance(params.get("arguments"), dict)
                    and isinstance(params.get("callId"), str) and 0 < len(params["callId"]) <= 512):
                arguments = {DESIGN_ENVELOPE: params["arguments"]} if design_call else params["arguments"]
                value = await call_in_turn(self._tool_handler, runtime.binding, turn_id, arguments,
                    lambda: runtime.turn_id == turn_id and runtime.status in {"running", "waiting_user"}
                    and not runtime.desynchronized and self._client is not None and not self._client.closed,
                    timeout_s=None if runtime.start.work_prompt is not None else 90)
            content_items = []
            for item in value["content"]:
                if item.get("type") == "text":
                    content_items.append({"type": "inputText", "text": item["text"]})
                elif item.get("type") == "image":
                    content_items.append({"type": "inputImage", "imageUrl": f"data:{item['mimeType']};base64,{item['data']}"})
            return {"success": not value.get("isError", False), "contentItems": content_items}
        if method == "item/permissions/requestApproval":
            return {"permissions": {}, "scope": "turn"}
        if method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}:
            if not is_current or runtime is None or runtime.start.readonly or runtime.start.work_prompt is not None or self._approval_handler is None:
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
            amendment = similar_command_prefix(params) if decision == "accept_similar" else None
            if decision == "accept_similar" and amendment:
                decision = {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": amendment}}
            elif decision not in {"accept", "decline", "cancel"}:
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
        if self._login:
            self._login.disconnected()
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
