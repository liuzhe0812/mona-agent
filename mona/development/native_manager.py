"""Product/native session boundary for host ownership, bindings and handoff."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import asynccontextmanager
from functools import wraps
from pathlib import Path
from urllib.parse import urlparse

from loguru import logger

from mona.config.schema import Config
from mona.development.context import load_project_context
from mona.development.contracts import (
    TERMINAL_RUN_STATUSES,
    Binding,
    DevelopmentSession,
    ExecutorId,
    Run,
    RunStatus,
)
from mona.development.decisions import DecisionBroker
from mona.development.executors.base import Executor, SessionStart
from mona.development.executors.codex import CodexExecutor
from mona.development.executors.codex_policy import prepare_codex_profile
from mona.development.executors.diagnostics import failed_probe
from mona.development.executors.discovery import discover_executors
from mona.development.executors.host_tools import COLLABORATION_POLICY_TAG, HostToolHandler
from mona.development.executors.login import ACTIVE_LOGIN_STATES, idle_login
from mona.development.executors.rpc import MissingNativeSessionError, RpcError
from mona.development.executors.sdk import SDKExecutor
from mona.development.executors.sdk_policy import prepare_sdk_profile, sdk_version
from mona.development.handoff import build_handoff
from mona.development.model_bridge import NativeModelBridge
from mona.development.model_selection import resolve_coding_model
from mona.development.native_service import NativeRunService
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore, NotFoundError
from mona.providers.context_window import resolve_model_context_window
from mona.session.manager import SessionManager

_NAMES = {ExecutorId.CODEX: "Codex", ExecutorId.CLAUDE: "Claude Code", ExecutorId.CODEBUDDY: "CodeBuddy"}


def _native_operation(method):
    @wraps(method)
    async def wrapped(self, *args, **kwargs):
        if self._settings_changing:
            raise ConflictError("正在更新执行者设置，请稍后重试本次连接操作。")
        self._preparing += 1
        try:
            return await method(self, *args, **kwargs)
        finally:
            self._preparing -= 1
    return wrapped


class NativeExecutorManager:
    def __init__(self, store: DevelopmentStore, sessions: SessionManager, config_loader: Callable[[], Config],
                 *, tool_handler: HostToolHandler | None = None):
        self.store, self.sessions, self.config_loader = store, sessions, config_loader
        self.tool_handler = tool_handler
        self.permission_handler = None
        self.service = NativeRunService(store, sessions)
        self.decisions = DecisionBroker(store, config_loader().development.decision_timeout_seconds)
        self.model_bridge = NativeModelBridge(config_loader, store.get_session)
        self.hosts: dict[tuple[str, ExecutorId] | tuple[str, ExecutorId, str], Executor] = {}
        self.loaded: dict[str, tuple[Executor, str, str | None, str | None]] = {}
        self.probes: dict[tuple[str, ExecutorId], dict] = {}
        self._login_hosts: dict[ExecutorId, Executor] = {}
        self._login_locks: dict[ExecutorId, asyncio.Lock] = {}
        self._observed_logins: dict[ExecutorId, tuple[str | None, str]] = {}
        self._locks: dict[tuple[str, ExecutorId] | tuple[str, ExecutorId, str], asyncio.Lock] = {}
        self._host_stamps: dict[tuple, tuple[str, int, int]] = {}
        self._preparing = 0
        self._settings_changing = False
        self._usage_revision = 0
        self._usage_identity_revision = 0
        self._usage_changed = asyncio.Event()
        self._usage_reading = False

    def _notify_account_usage(self, identity_changed: bool = False, *, account_host: bool = False) -> None:
        if account_host and self._usage_reading and not identity_changed:
            return
        self._usage_revision += 1
        if identity_changed:
            self._usage_identity_revision = self._usage_revision
        self._usage_changed.set()
        self._usage_changed = asyncio.Event()

    async def account_usage_changes(self, executor: ExecutorId, after: int) -> dict:
        if executor != ExecutorId.CODEX:
            raise DevelopmentError("unsupported_usage", "此本机引擎暂未提供订阅额度查询。")
        if after == self._usage_revision:
            try:
                await asyncio.wait_for(self._usage_changed.wait(), timeout=25)
            except TimeoutError:
                pass
        return {"revision": self._usage_revision, "identityChanged": self._usage_identity_revision > after}

    def describe(self, project_id: str | None = None) -> list[dict]:
        config = self.config_loader().development
        result = []
        for probe in discover_executors(config):
            supported = probe.state == "detected"
            diagnostic = probe
            if supported and probe.executor != ExecutorId.CODEX:
                try:
                    diagnostic.sdk_version = sdk_version(probe.executor)
                except RpcError as exc:
                    supported = False
                    diagnostic = failed_probe(probe.executor, exc, executable=probe.executable)
                    diagnostic.source = probe.source
            known = self.probes.get((project_id or "", probe.executor)) or self.probes.get(("", probe.executor))
            if probe.executor == ExecutorId.CODEBUDDY:
                known = self.probes.get(("", probe.executor))
            if known and known.get("executable") != probe.executable:
                known = None
            current = known if known and supported else diagnostic.model_dump(mode="json", by_alias=True)
            enabled = probe.executor.value in config.enabled_engines
            result.append({"id": probe.executor.value, "name": _NAMES[probe.executor], "available": supported and enabled,
                "programAvailable": probe.state == "detected", "enabled": enabled,
                "reason": current["reason"] if enabled else "此模型来源已停用，账号和模型配置仍保留。",
                "nextAction": current.get("nextAction", "") if enabled else "在模型设置中启用此来源。",
                "detection": probe.state, "executable": probe.executable, "probe": current,
                "models": [{"id": "", "label": "执行者默认模型"}] +
                    (current.get("modelDetails") or
                     [{"id": model, "label": model} for model in current.get("models", [])])})
        return result

    async def _current_host(self, key: tuple, executable: str) -> Executor | None:
        host = self.hosts.get(key)
        path = Path(executable)
        stat = path.stat()
        stamp = (str(path), stat.st_mtime_ns, stat.st_size)
        if host:
            previous_path = host.profile.command[0] if isinstance(host, CodexExecutor) else str(host.profile.executable)
            if previous_path == executable and self._host_stamps.get(key, stamp) == stamp:
                self._host_stamps[key] = stamp
                return host
            if host.login_status()["state"] in ACTIVE_LOGIN_STATES:
                return host
            bindings = [self.store.get_binding(binding_id) for binding_id, loaded in self.loaded.items() if loaded[0] is host]
            if any(self.store.active_run(binding.session_id) for binding in bindings):
                return host
            for binding in bindings:
                if await host.get_status(binding) not in {"idle", "not_loaded"}:
                    return host
            for binding in bindings:
                await self.service.detach(binding.id)
                self.loaded.pop(binding.id, None)
            await host.shutdown()
            self.hosts.pop(key, None)
            if self._login_hosts.get(host.id) is host:
                self._login_hosts.pop(host.id, None)
            self.probes.pop(key[:2], None)
        self._host_stamps[key] = stamp
        return None

    async def _host(self, session: DevelopmentSession) -> Executor:
        config = self.config_loader().development
        key = (session.project_id, session.executor, session.id) if session.model_provider else (session.project_id, session.executor)
        async with self._locks.setdefault(key, asyncio.Lock()):
            endpoint, token = await self.model_bridge.bind(session, refresh=self.store.active_run(session.id) is None) if session.model_provider else (None, None)
            probe = next((p for p in discover_executors(config) if p.executor == session.executor), None)
            if probe is None or probe.state != "detected" or not probe.executable:
                raise DevelopmentError(probe.error_code if probe and probe.error_code else "executable_not_found",
                    probe.reason if probe else "未找到此执行者的原生程序，请先设置程序路径。")
            current = await self._current_host(key, probe.executable)
            if current:
                return current
            project = self.store.get_project(session.project_id)
            context = load_project_context(project, config)
            home = self.store.path.parent / "native" / session.executor.value
            async def approve(binding, _method, params):
                if self.permission_handler is not None:
                    return await self.permission_handler(binding, _method, params)
                return await self.decisions.request(binding, "permission", params)
            async def question(binding, params):
                return await self.decisions.request(binding, "question", params)
            if session.executor == ExecutorId.CODEX:
                profile = prepare_codex_profile(Path(probe.executable), home, context.root,
                                                model_endpoint=endpoint, model_token=token)
                host = CodexExecutor(profile, approval_handler=approve, question_handler=question, tool_handler=self.tool_handler,
                    account_changed=self._notify_account_usage if not session.model_provider else None)
            else:
                sdk_version(session.executor)
                profile = prepare_sdk_profile(session.executor, Path(probe.executable), home, context.root,
                    credential_env=None if session.executor == ExecutorId.CLAUDE else config.codebuddy_api_key_env,
                    codebuddy_environment=config.codebuddy_environment, model_endpoint=endpoint, model_token=token)
                host = SDKExecutor(profile, approval_handler=approve, question_handler=question, tool_handler=self.tool_handler)
            self.hosts[key] = host
            return host

    async def _account_host(self, executor: ExecutorId) -> Executor:
        """Source connection is independent of projects and never creates a task."""
        key = ("", executor)
        async with self._locks.setdefault(key, asyncio.Lock()):
            config = self.config_loader().development
            probe = next((p for p in discover_executors(config) if p.executor == executor), None)
            if not probe or probe.state != "detected" or not probe.executable:
                raise DevelopmentError(probe.error_code if probe and probe.error_code else "executable_not_found", "尚未找到可用的本机执行程序。")
            current = await self._current_host(key, probe.executable)
            if current:
                return current
            root = self.store.path.parent / "provider-context" / executor.value
            root.mkdir(parents=True, exist_ok=True)
            home = self.store.path.parent / "native" / executor.value
            if executor == ExecutorId.CODEX:
                host = CodexExecutor(prepare_codex_profile(Path(probe.executable), home, root),
                    account_changed=lambda identity_changed: self._notify_account_usage(identity_changed, account_host=True))
            else:
                sdk_version(executor)
                host = SDKExecutor(prepare_sdk_profile(executor, Path(probe.executable), home, root,
                    credential_env=None if executor == ExecutorId.CLAUDE else config.codebuddy_api_key_env,
                    codebuddy_environment=config.codebuddy_environment))
            self.hosts[key] = host
            return host

    @_native_operation
    async def probe(self, project_id: str | None, executor: ExecutorId) -> dict:
        if executor in {ExecutorId.CODEX, ExecutorId.CLAUDE, ExecutorId.CODEBUDDY}:
            async with self._login_locks.setdefault(executor, asyncio.Lock()):
                return await self._probe(project_id, executor)
        return await self._probe(project_id, executor)

    async def _probe(self, project_id: str | None, executor: ExecutorId) -> dict:
        project = self.store.get_project(project_id) if project_id else None
        session = DevelopmentSession(project_id=project.id, executor=executor) if project else None
        discovery = next((p for p in discover_executors(self.config_loader().development) if p.executor == executor), None)
        if discovery is None:
            raise DevelopmentError("invalid_executor", "请选择原生开发执行者。")
        if discovery.state != "detected":
            return {**discovery.model_dump(mode="json", by_alias=True), "models": []}
        try:
            host = await self._host(session) if session and executor != ExecutorId.CODEBUDDY else await self._account_host(executor)
            probe = await host.probe()
            models = ([model.id for model in probe.model_details] or await host.list_models()) if probe.protocol_verified else []
        except DevelopmentError as exc:
            probe = failed_probe(executor, exc, executable=discovery.executable)
            models = []
        probe.source = discovery.source
        result = {**probe.model_dump(mode="json", by_alias=True), "models": models}
        self.probes[("" if executor == ExecutorId.CODEBUDDY else project_id or "", executor)] = result
        return result

    @staticmethod
    def _public_login(executor: ExecutorId, result: dict) -> dict:
        if not result.get("authUrl"):
            return result
        parsed = urlparse(result["authUrl"])
        domains = {"auth.openai.com", "chatgpt.com", "auth0.openai.com"} if executor == ExecutorId.CODEX else {"codebuddy.cn", "codebuddy.ai", "tencent.com", "tencentcloud.com"}
        hostname = parsed.hostname or ""
        trusted = any(hostname == domain or executor == ExecutorId.CODEBUDDY and hostname.endswith("." + domain) for domain in domains)
        if parsed.scheme != "https" or not trusted or parsed.username or parsed.password or parsed.port not in {None, 443}:
            raise DevelopmentError("invalid_login_url", "登录回执不是支持的官方认证地址，未打开。")
        return result

    @_native_operation
    async def account_usage(self, executor: ExecutorId) -> dict:
        if executor != ExecutorId.CODEX:
            raise DevelopmentError("unsupported_usage", "此本机引擎暂未提供订阅额度查询。")
        async with self._login_locks.setdefault(executor, asyncio.Lock()):
            host = await self._account_host(executor)
            revision = self._usage_revision
            self._usage_reading = True
            try:
                result = await host.account_usage()
                for (project_id, source), probe in self.probes.items():
                    if source == ExecutorId.CODEX:
                        probe.update(authentication="ready" if result.connected else "required",
                            authMode="chatgpt" if result.connected else "unknown")
                result.revision = revision
                return result.model_dump(mode="json", by_alias=True)
            finally:
                self._usage_reading = False

    @_native_operation
    async def login(self, project_id: str | None, executor: ExecutorId) -> dict:
        if project_id:
            self.store.get_project(project_id)
        if executor not in {ExecutorId.CODEX, ExecutorId.CLAUDE, ExecutorId.CODEBUDDY}:
            raise DevelopmentError("explicit_auth_required", "此执行者使用配置中指定的 API Key 环境变量；不会复制用户级 CLI 配置或模拟登录。")
        # Authentication belongs to the executor's shared managed home, not a
        # project. Two project windows must not start competing account logins.
        async with self._login_locks.setdefault(executor, asyncio.Lock()):
            host = self._login_hosts.get(executor)
            if host and host.login_status()["state"] in ACTIVE_LOGIN_STATES:
                return self._public_login(executor, host.login_status())
            host = await self._host(DevelopmentSession(project_id=project_id, executor=executor)) if project_id and executor != ExecutorId.CLAUDE else await self._account_host(executor)
            self._login_hosts[executor] = host
            return self._public_login(executor, await host.begin_login())

    @_native_operation
    async def logout(self, executor: ExecutorId) -> dict:
        if executor not in {ExecutorId.CODEX, ExecutorId.CLAUDE}:
            raise DevelopmentError("unsupported_logout", "此连接没有受管账户断开操作。")
        async with self._login_locks.setdefault(executor, asyncio.Lock()):
            host = await self._account_host(executor)
            await host.logout()
            self._login_hosts.pop(executor, None)
            self.probes = {key: value for key, value in self.probes.items() if key[1] != executor}
            if executor == ExecutorId.CODEX:
                self._notify_account_usage(True)
        return {"ok": True}

    @_native_operation
    async def login_status(self, project_id: str | None, executor: ExecutorId, *, cancel_id: str | None = None) -> dict:
        if project_id:
            self.store.get_project(project_id)
        if executor not in {ExecutorId.CODEX, ExecutorId.CLAUDE, ExecutorId.CODEBUDDY}:
            raise DevelopmentError("explicit_auth_required", "此执行者没有受管网页登录流程。")
        async with self._login_locks.setdefault(executor, asyncio.Lock()):
            host = self._login_hosts.get(executor)
            if host is None:
                if cancel_id is not None:
                    raise ConflictError("原登录记录已失效，未操作其他登录或账户。")
                return idle_login()
            result = await host.cancel_login(cancel_id) if cancel_id is not None else host.login_status()
            identity = (result.get("loginId"), result["state"])
            if result["state"] not in ACTIVE_LOGIN_STATES and self._observed_logins.get(executor) != identity:
                self._observed_logins[executor] = identity
                self.probes = {key: value for key, value in self.probes.items() if key[1] != executor}
            return self._public_login(executor, result)

    @_native_operation
    async def ensure(self, session: DevelopmentSession, *, handoff: bool = False) -> Binding:
        current = self.store.get_session(session.id)
        if current.revision != session.revision or current.archived:
            raise ConflictError("会话已变化或已归档，未重建执行会话。")
        active_run = self.store.active_run(session.id)
        host = await self._host(session)
        project = self.store.get_project(session.project_id)
        context = load_project_context(project, self.config_loader().development)
        fingerprint = context.rules_fingerprint + ":" + context.skills_fingerprint
        bindings = [b for b in self.store.list_bindings(session.id) if b.executor == session.executor
                    and b.model_provider == session.model_provider and b.state != "stale"]
        binding = max(bindings, key=lambda b: b.last_used_at) if bindings else None
        start = SessionStart(session=session, context=context, model=session.model, readonly=session.readonly,
            resume_history=binding is None or self.store.binding_has_runs(binding.id),
            context_window_tokens=resolve_model_context_window(self.config_loader(),
                resolve_coding_model(self.config_loader(), session.model, session.model_provider)) if session.model_provider else None)
        transcript = self.sessions.get_or_create(session.transcript_key)
        packet = None
        if (handoff or binding is None) and transcript.messages:
            since = min(binding.transcript_cursor, len(transcript.messages)) if binding else 0
            forked = bool(session.fork_source and binding is None)
            evidence = self.store.handoff_evidence(session.id)
            if forked:
                from mona.development.contracts import Event
                from mona.development.fork import history

                evidence = [Event.model_validate(event).model_copy(update={"session_id": session.id})
                            for event in history(transcript)["events"]] + evidence
            packet = build_handoff(context, session, transcript, goal="继续当前开发任务，基于实际文件保留已有成果与人工修改。", since=since,
                evidence=evidence, plan=self.store.latest_plan(session.id),
                max_chars=48_000 if forked else 16_000, full_conversation=forked)
        loaded = self.loaded.get(binding.id) if binding else None
        if (binding and session.executor == ExecutorId.CODEX and not active_run
                and self.tool_handler is not None and not session.readonly and not session.parent_session_id
                and any(preset.enabled for preset in project.subagents)
                and not (binding.context_fingerprint or "").endswith(COLLABORATION_POLICY_TAG)):
            if loaded and await host.get_status(binding) not in {"idle", "not_loaded"}:
                raise ConflictError("原任务状态尚未确认，请先处理原任务。")
            return await self._replace(session, binding, host, start, "collaboration_updated")
        if binding and binding.permission_mode != session.permission_mode:
            if active_run:
                raise ConflictError("原轮次的权限仍待核对，不能用新的权限恢复执行。")
            self.loaded.pop(binding.id, None)
            loaded = None
            binding = binding.model_copy(update={"permission_mode": session.permission_mode}, deep=True)
        latest = next(iter(self.store.list_runs(session.id, 1)), None) if binding and not active_run else None
        if (binding and latest and latest.binding_id == binding.id and latest.status == RunStatus.FAILED
                and latest.error_code == "native_session_not_found"):
            # SDK resume rejection arrives after dispatch. Repair on the next user
            # request without replaying the failed request or replacing uncertain work.
            if loaded and await host.get_status(binding) not in {"idle", "not_loaded"}:
                raise ConflictError("上次任务状态尚未确认，暂时无法继续。")
            return await self._replace(session, binding, host, start, "history_missing")
        if binding and loaded == (host, fingerprint, session.model, session.model_reasoning_effort) and binding.state == "active":
            status = await host.get_status(binding)
            if status != "not_loaded":
                # Unknown/running work is never rebuilt or sent a second time.
                self.service.attach(binding.id, host)
                return binding
            self.loaded.pop(binding.id, None)
        if binding:
            await self.service.detach(binding.id)
            try:
                active = await host.attach_session(start, binding)
            except MissingNativeSessionError:
                # A missing history is not proof that an uncertain prior write
                # never ran. Only an idle product session may acquire a successor.
                if active_run or self.store.active_run(session.id):
                    raise
                return await self._replace(session, binding, host, start, "history_missing")
        else:
            if active_run:
                raise ConflictError("原任务缺少可恢复绑定，不能创建替代会话来重跑。")
            active = await host.create_session(start)
        try:
            if active_run:
                if not binding or active_run.binding_id != active.id:
                    raise ConflictError("恢复必须绑定原运行，不能新建或替换执行者。")
                active = self.store.refresh_binding(active)
            else:
                active = self.store.activate_binding(active, current.revision, handoff=packet,
                    update_model=True, model=session.model, reasoning_effort=session.model_reasoning_effort)
        except NotFoundError:
            # A deletion can complete while native startup is awaiting its reply.
            await host.close_runtime(active, force=True)
            raise
        self.loaded[active.id] = (host, fingerprint, session.model, session.model_reasoning_effort)
        self.service.attach(active.id, host)
        return active

    async def _replace(self, session: DevelopmentSession, previous: Binding, host: Executor,
                       start: SessionStart, reason: str) -> Binding:
        current = self.store.get_session(session.id)
        if current.revision != session.revision or current.archived or self.store.active_run(session.id):
            raise ConflictError("当前任务已变化或仍未结束，未建立替代执行会话。")
        if previous.handoff and previous.handoff.state in {"reserved", "unknown"}:
            raise ConflictError("原交接尚未确认，不自动重新发送。")
        transcript = self.sessions.get_or_create(session.transcript_key)
        packet = build_handoff(start.context, session, transcript,
            goal="在同一个项目任务中继续开发。先核对当前文件与人工修改，不重放已完成操作；此前失败不等于未产生修改。",
            evidence=self.store.handoff_evidence(session.id), plan=self.store.latest_plan(session.id))
        replacement = await host.create_session(start)
        try:
            active = self.store.activate_binding(replacement, session.revision, handoff=packet,
                replaces_binding_id=previous.id, replacement_reason=reason, update_model=True, model=session.model,
                reasoning_effort=session.model_reasoning_effort)
        except BaseException:
            # A failed metadata commit must not steal the original binding. Only
            # release the newly created, still idle execution resource.
            try:
                await host.close_runtime(replacement)
            except Exception as exc:
                logger.warning("Unused native session release failed ({})", type(exc).__name__)
            raise
        await self.service.detach(previous.id)
        self.loaded.pop(previous.id, None)
        fingerprint = start.context.rules_fingerprint + ":" + start.context.skills_fingerprint
        self.loaded[active.id] = (host, fingerprint, session.model, session.model_reasoning_effort)
        self.service.attach(active.id, host)
        try:
            await host.close_runtime(previous)
        except RpcError as exc:
            if exc.code not in {"native_not_loaded", "binding_not_attached", "native_busy", "native_disconnected"}:
                logger.warning("Previous native resource not released ({})", exc.code)
        return active

    @_native_operation
    async def close_unknown(self, session_id: str, run_id: str, revision: int, binding_id: str):
        session = self.store.get_session(session_id)
        run = self.store.get_run(run_id)
        binding = self.store.get_binding(binding_id)
        if run.session_id != session_id or run.binding_id != binding_id or binding.session_id != session_id:
            raise ConflictError("原任务不属于当前会话，未处理。")
        if run.status == RunStatus.CLOSED_UNKNOWN:
            return run
        if (run.revision != revision or run.status != RunStatus.UNKNOWN or session.archived
                or run.executor not in {ExecutorId.CLAUDE, ExecutorId.CODEBUDDY} or binding.state != "active"):
            raise ConflictError("原任务状态已变化，请重新核对。")
        return await self._finish_unknown(run, binding, revision)

    async def _finish_unknown(self, run: Run, binding: Binding, revision: int):
        loaded = self.loaded.get(binding.id)
        if loaded:
            await loaded[0].close_runtime(binding, force=True)
        current = self.store.get_run(run.id)
        if current.status in TERMINAL_RUN_STATUSES:
            return current
        await self.service.detach(binding.id)
        self.decisions.cancel_run(run.id)
        result = self.store.close_unknown(run.session_id, run.id, revision, binding.id)
        self.loaded.pop(binding.id, None)
        return result

    @_native_operation
    async def reconnect(self, session_id: str, revision: int, binding_id: str) -> DevelopmentSession:
        """Explicit idle-session renewal; never resume or rerun uncertain work."""
        session = self.store.get_session(session_id)
        previous = self.store.get_binding(binding_id)
        if previous.session_id != session.id or previous.executor != session.executor:
            raise ConflictError("续接目标不属于当前执行者。")
        successor = next((b for b in self.store.list_bindings(session.id)
                          if b.replaces_binding_id == binding_id and b.state == "active"), None)
        if successor:
            return session  # Lost HTTP acknowledgement: observe the same renewal.
        if session.revision != revision or session.archived or self.store.active_run(session.id) or previous.state != "active":
            raise ConflictError("只能在当前轮次确认结束后重新连接执行者。")
        host = await self._host(session)
        if previous.id in self.loaded and await host.get_status(previous) not in {"idle", "not_loaded"}:
            raise ConflictError("原生执行仍在进行或状态未知，不能重建。")
        context = load_project_context(self.store.get_project(session.project_id), self.config_loader().development)
        await self._replace(session, previous, host,
            SessionStart(session=session, context=context, model=session.model, readonly=session.readonly), "user_requested")
        return self.store.get_session(session_id)

    def validate_effort(self, project_id: str, executor: ExecutorId, model: str | None, effort: str | None) -> None:
        if effort is None:
            return
        source = next((item for item in self.describe(project_id) if item["id"] == executor.value), None)
        choice = next((item for item in source["models"] if item["id"] == model), None) if source else None
        if not choice or effort not in choice.get("reasoningEfforts", []):
            raise DevelopmentError("unsupported_reasoning_effort", "当前模型未声明支持此思考强度，请同步模型后重新选择。")

    async def switch(self, session_id: str, revision: int, executor: ExecutorId, model: str | None,
                     effort: str | None = None, *, provider: str | None = None) -> DevelopmentSession:
        session = self.store.get_session(session_id)
        if session.revision != revision or self.store.active_run(session_id):
            raise ConflictError("当前会话已变化或仍有未结束轮次，请先核对原任务。")
        if executor == ExecutorId.MONA:
            self.config_loader().resolve_preset(model)
            return self.store.select_mona(session_id, revision, model)
        if executor.value not in self.config_loader().development.enabled_engines:
            raise DevelopmentError("engine_disabled", "此模型来源已停用，请在模型设置中启用后再调用。")
        if provider is not None:
            raise DevelopmentError("unsupported_model_route", "原生引擎使用自己的模型来源，请重新选择对应来源的模型。")
        else:
            self.validate_effort(session.project_id, executor, model, effort)
        target = session.model_copy(update={"executor": executor, "model": model,
            "model_provider": provider, "model_reasoning_effort": effort})
        await self.ensure(target, handoff=session.executor != executor or session.model_provider != provider)
        return self.store.get_session(session_id)

    @_native_operation
    async def recover(self, session_id: str, run_id: str):
        run = self.store.get_run(run_id)
        if run.session_id != session_id or run.executor == ExecutorId.MONA:
            raise ConflictError("不是当前会话的原生执行记录。")
        binding = self.store.get_binding(run.binding_id) if run.binding_id else None
        if binding and binding.executor != ExecutorId.CODEX and not binding.capabilities.turn_history:
            raise RpcError("native_history_unsupported", "当前执行者不支持核对这一轮的原生历史。原记录仍保留，不会自动重跑；请核对实际文件和执行进程。")
        await self.ensure(self.store.get_session(session_id))
        if run.executor == ExecutorId.CODEX and run.status == RunStatus.UNKNOWN and not run.native_turn_id:
            # Verified idle releases tracking, without certifying the lost result.
            host = self.loaded[binding.id][0]
            status = await host.get_status(binding)
            if self.service.is_dispatching(run.id) or status != "idle":
                raise RpcError("native_turn_not_finished", "原任务状态仍待核对，未重新发送请求。", outcome_unknown=True)
            current = self.store.get_run(run.id)
            if current.status in TERMINAL_RUN_STATUSES:
                return current
            if current.status != RunStatus.UNKNOWN or current.native_turn_id:
                raise ConflictError("原任务状态已变化，未结束其执行跟踪。")
            return await self._finish_unknown(current, binding, current.revision)
        try:
            return await self.service.recover(run_id)
        except RpcError as exc:
            if run.executor != ExecutorId.CODEX or exc.code != "native_history_unavailable_idle":
                raise
            if self.service.is_dispatching(run.id):
                raise RpcError("native_turn_not_finished", "原任务状态仍待核对，未重新发送请求。", outcome_unknown=True) from exc
            # Native metadata confirms idle, but cannot certify the old result.
            # Release tracking without reusing an uncertain handoff or request.
            current = self.store.get_run(run.id)
            return await self._finish_unknown(current, binding, current.revision)

    @_native_operation
    async def interrupt(self, session_id: str, run_id: str):
        run = self.store.get_run(run_id)
        if run.session_id != session_id or run.executor == ExecutorId.MONA:
            raise ConflictError("任务不属于当前会话，未停止其它任务。")
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        if run.status == RunStatus.UNKNOWN:
            try:
                run = await self.recover(session_id, run_id)
            except RpcError as exc:
                if exc.code not in {"native_history_unsupported", "native_turn_not_finished"}:
                    raise
            if run.status in TERMINAL_RUN_STATUSES:
                self.decisions.cancel_run(run.id)
                return run
        if run.binding_id not in self.loaded:
            await self.ensure(self.store.get_session(session_id))
        result = await self.service.interrupt(run.id)
        self.decisions.cancel_run(run.id)
        if result.status == RunStatus.UNKNOWN:
            try:
                return await self.recover(session_id, run_id)
            except DevelopmentError as exc:
                raise DevelopmentError("native_stop_unconfirmed", "暂时无法确认任务已停止，已有改动可能已生效。请稍后再试。") from exc
        return result

    @asynccontextmanager
    async def managed_program_change(self, executor: ExecutorId, directory: Path):
        if self._settings_changing or self._preparing:
            raise ConflictError("有引擎正在连接或恢复，请稍后删除程序。")
        self._settings_changing = True
        try:
            affected = {key: host for key, host in self.hosts.items() if key[1] == executor and
                Path(host.profile.command[0] if isinstance(host, CodexExecutor) else host.profile.executable).resolve().is_relative_to(directory.resolve())}
            hosts = set(affected.values())
            bindings = [self.store.get_binding(identifier) for identifier, loaded in self.loaded.items() if loaded[0] in hosts]
            if any(host.login_status()["state"] in ACTIVE_LOGIN_STATES for host in hosts):
                raise ConflictError("请先完成或取消当前登录，再删除 Mona 管理的程序。")
            if any(self.store.active_run(binding.session_id) for binding in bindings):
                raise ConflictError("此程序仍有运行中或结果待核对的任务，暂时不能删除。")
            for binding in bindings:
                if await self.loaded[binding.id][0].get_status(binding) not in {"idle", "not_loaded"}:
                    raise ConflictError("此程序的任务状态尚未确认，暂时不能删除。")
            for binding in bindings:
                await self.service.detach(binding.id)
                self.loaded.pop(binding.id, None)
            for key, host in affected.items():
                await host.shutdown()
                self.hosts.pop(key, None)
                self._host_stamps.pop(key, None)
            if self._login_hosts.get(executor) in hosts:
                self._login_hosts.pop(executor, None)
            self.probes = {key: value for key, value in self.probes.items() if key[1] != executor}
            yield
        finally:
            self._settings_changing = False

    @asynccontextmanager
    async def configuration_change(self):
        if self._settings_changing or self._preparing:
            raise ConflictError("有执行者正在连接或恢复，请等待连接操作结束后修改设置。")
        self._settings_changing = True
        try:
            await self.reset_idle_hosts()
            yield
        finally:
            self._settings_changing = False

    async def reset_idle_hosts(self) -> None:
        if any(host.login_status()["state"] in {"starting", "waiting", "cancelling"} for host in self._login_hosts.values()):
            raise ConflictError("请先完成或取消当前官方登录，再修改执行者设置。")
        for binding_id in self.loaded:
            binding = self.store.get_binding(binding_id)
            if any(run.status not in TERMINAL_RUN_STATUSES for run in self.store.list_runs(binding.session_id)):
                raise ConflictError("原生任务仍在运行或状态未知，请先结束或核对任务后修改执行者设置。")
        for binding_id in list(self.loaded):
            await self.service.detach(binding_id)
        for host in self.hosts.values():
            await host.shutdown()
        self.hosts.clear()
        self._host_stamps.clear()
        self.loaded.clear()
        self.probes.clear()
        self._login_hosts.clear()
        await self.model_bridge.close()

    async def close(self) -> None:
        self._usage_changed.set()
        self.decisions.close()
        await self.service.close()
        for host in self.hosts.values():
            await host.shutdown()
        await self.model_bridge.close()
