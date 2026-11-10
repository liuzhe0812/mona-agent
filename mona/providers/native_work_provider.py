"""Native model turns with all Work tool dispatch kept in Mona's runner."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

from loguru import logger

from mona.config.paths import get_data_dir
from mona.config.schema import Config
from mona.development.context import ProjectContext
from mona.development.contracts import DevelopmentSession, ExecutorId
from mona.development.executors.base import SessionStart
from mona.development.executors.codex import CodexExecutor
from mona.development.executors.codex_policy import prepare_codex_work_profile
from mona.development.executors.discovery import discover_executors
from mona.development.executors.host_tools import WORK_TOOL, WorkToolCall
from mona.development.executors.rpc import RemoteRpcError, RpcError
from mona.development.executors.sdk import SDKExecutor
from mona.development.executors.sdk_policy import prepare_sdk_profile
from mona.development.input_content import validate_content
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.providers.capabilities import ModelCapabilities
from mona.providers.native_work_tools import (
    NATIVE_BASIC_TOOLS,
    NativeWorkToolPolicy,
    filter_native_work_tools,
)

_ERROR_MESSAGES = {
    "server_overloaded": "当前模型繁忙，暂时无法响应。请稍后重试或选择其他模型。",
    "usage_limit_exceeded": "当前账号已达到使用额度。请稍后再试，或在模型设置中查看额度。",
    "authentication_required": "该模型账号需要登录。请在模型设置中完成登录后重试。",
    "context_window_exceeded": "当前会话超过所选模型可处理的容量。请新建会话或选择更大容量的模型。",
    "native_account_check_failed": "模型账号状态检查未能完成，尚未开始本次生成。请稍后重试，或在模型设置中检查连接。",
    "input_text_too_large": "这条消息超过 20 万字符，本次内容尚未发送。请缩短文字或拆分发送。",
    "input_images_too_large": "附件图片合计超过 8 MB，本次内容尚未发送。请压缩图片或减少附件后重试。",
    "input_parts_too_many": "这条消息的附件或内容片段过多，本次内容尚未发送。请减少附件或拆分发送。",
    "invalid_input_content": "消息内容或图片格式无法识别，本次内容尚未发送。请重新添加附件后重试。",
    "rpc_frame_too_large": "会话内容和附件超过单次传输容量，本次内容尚未发送。请减少附件，或新建会话并引用已有工作文件继续。",
    "executor_disabled": "所选模型来源已停用，本次生成尚未开始。请在模型设置中启用该来源或选择其他模型。",
    "executor_unavailable": "未找到所选模型需要的本机程序，本次生成尚未开始。请在模型设置中检查连接。",
    "native_catalog_unavailable": "所选来源的模型列表尚未就绪，本次生成尚未开始。请在模型设置中刷新后重试。",
    "native_launch_failed": "所选模型需要的本机程序未能启动，本次生成尚未开始。请在模型设置中检查程序路径及安装状态。",
    "executable_access_denied": "系统拒绝启动所选模型的本机程序，本次生成尚未开始。请检查程序的访问权限。",
    "invalid_executable_format": "所选模型程序与当前系统不兼容，本次生成尚未开始。请安装适用于当前系统的程序。",
    "native_request_rejected": "模型程序拒绝了本次请求。请核对已有结果，并在模型设置中检查连接及配套程序版本后重试。",
    "native_dispatch_rejected": "模型连接当前无法接受新请求，本次内容尚未发送。请等待当前任务结束，或在模型设置中检查连接后重试。",
    "native_dispatch_unconfirmed": "模型请求未收到明确的接受回执，结果尚未确认。请先核对会话和文件结果，再决定是否继续。",
    "native_turn_incomplete": "模型未返回本轮的完成状态，结果尚未确认。请先核对会话和文件结果，再决定是否继续。",
    "native_policy_unavailable": "所选模型程序无法保证当前工具授权或目录限制，本次任务尚未开始。请使用能满足这些限制的执行方式。",
    "native_turn_interrupted": "本次模型回复已中断，请核对已有内容和文件结果后继续。",
    "native_policy_violation": "模型请求了当前任务未授权的操作，Mona 已停止本轮。请核对操作授权和已有结果后继续。",
    "native_request_timeout": "等待模型确认超时，本次结果尚未确认。请先核对会话和文件结果，再决定是否继续。",
    "native_transport_lost": "与本机模型程序的连接中断，本次结果尚未确认。请先核对会话和文件结果，再继续。",
    "native_disconnected": "本机模型程序的连接已关闭。请在模型设置中检查连接，并核对本轮已有结果后继续。",
    "native_protocol_error": "模型程序返回的内容格式无法识别。请核对已有结果，并检查配套程序版本后重试。",
    "native_exit_unconfirmed": "模型程序尚未确认结束，本轮结果需要核对。请先检查已有会话和文件，不要重复执行。",
    "sdk_contract_incompatible": "模型程序与 Mona 的接口不兼容，本次生成未能开始。请检查配套程序版本。",
    "sdk_not_installed": "所选模型需要的配套组件未安装，本次生成尚未开始。请修复应用安装后重试。",
    "sdk_dependency_missing": "所选模型需要的配套组件不完整，本次生成尚未开始。请修复应用安装后重试。",
    "session_budget_exceeded": "当前模型任务已达到运行预算。请核对已有进度，缩小任务范围后继续。",
    "rate_limit_exceeded": "模型服务的请求频率已达到限制。请稍后重试。",
    "model_service_unavailable": "所选模型服务当前不可用。请稍后重试或选择其他模型。",
    "model_policy_rejected": "模型服务因内容政策拒绝了本次请求。请调整请求内容后重试。",
    "model_permission_denied": "模型连续遇到操作权限拒绝，本次任务已结束。请核对所需操作的授权后继续。",
    "upstream_internal_error": "模型服务发生内部错误。请稍后重试或选择其他模型。",
    "upstream_invalid_request": "模型服务拒绝了请求参数。请检查所选模型是否支持本次输入；若持续发生，请反馈诊断日志。",
    "upstream_input_too_large": "模型服务拒绝了过大的请求。请减少附件或整理上下文后重试。",
    "model_access_denied": "当前账号无权访问所选模型，或请求被模型服务拒绝。请在模型设置中确认账号与模型权限。",
    "upstream_not_found": "模型服务未找到请求地址或所选模型。请检查模型来源配置后重试。",
    "upstream_connection_failed": "未能连接到模型服务。请检查网络，稍后重试。",
    "upstream_timeout": "模型服务响应超时。请核对已有内容后稍后继续。",
    "upstream_stream_disconnected": "模型服务在回复完成前断开了连接。请核对已有内容和文件结果后继续。",
    "upstream_retries_exhausted": "模型服务多次重连仍未能完成回复。请核对已有结果，稍后继续或选择其他模型。",
    "native_rollback_failed": "模型程序未能恢复会话状态。请核对已有结果后新建会话继续。",
    "native_sandbox_error": "模型程序的运行环境发生错误。请检查配套程序状态，核对已有结果后重试。",
    "native_turn_failed": "模型程序明确报告本轮生成失败，但未提供可识别的原因。请核对已有结果，稍后继续；若持续发生，请反馈诊断日志。",
    "native_execution_failed": "模型程序明确报告本轮任务失败。请核对已有内容和文件结果后继续；若持续发生，请反馈诊断日志。",
}


def _native_history_blocks(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep message boundaries and image pixels; history never replays operations."""
    blocks = []
    images: dict[str, int] = {}
    text = ["以下是 Mona 已保存的会话。历史工具调用及结果仅供参考，不要重新执行。继续处理最后的用户请求。"]

    def flush_text():
        if text:
            blocks.append({"type": "text", "text": "\n\n".join(text)})
            text.clear()

    for message in messages:
        if message.get("role") in {"system", "developer"}:
            continue
        header = {key: message[key] for key in ("role", "name", "tool_call_id", "tool_calls") if key in message}
        content = message.get("content")
        if isinstance(content, list):
            text.append(json.dumps(header, ensure_ascii=False))
            for block in content:
                if block.get("type") == "text":
                    text.append(block["text"])
                elif block.get("type") == "image_url":
                    digest = hashlib.sha256(json.dumps(block, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                    if digest in images:
                        text.append(f"[此处图片与前文图像 {images[digest]} 完全相同，请参照该图像。]")
                        continue
                    images[digest] = len(images) + 1
                    text.append(f"[图像 {images[digest]}]")
                    flush_text()
                    blocks.append(block)
        else:
            text.append(json.dumps({**header, "content": content}, ensure_ascii=False))
    flush_text()
    return blocks


def native_history_input(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Pack history losslessly after the runner's model-token budget check."""
    return _native_history_blocks(messages)


class NativeWorkProvider(LLMProvider):
    """One instance per Work runner; native tools cannot bypass Mona permissions."""

    def __init__(self, config: Config, workspace: Path, *, native_home: Path | None = None):
        super().__init__()
        self.config = config
        self.workspace = workspace.resolve()
        self._native_home = native_home.resolve() if native_home is not None else None
        self.executor = ExecutorId(config.agents.defaults.executor)
        self._host = None
        self._binding = None
        self._events = None
        self._event_task = None
        self._tool_task = None
        self._requests: asyncio.Queue[ToolCallRequest] = asyncio.Queue()
        self._pending: dict[str, asyncio.Future] = {}
        self._texts: dict[str, str] = {}
        self._usage: dict[str, int] = {}
        self._reported_usage: dict[str, int] = {}
        self._context_usage: dict[str, Any] = {}
        self._carry_usage: dict[str, int] = {}
        self._done = False
        self._turn_progress = False
        self._message_count = 0
        self._history_digest = ""
        self._work_prompt: str | None = None
        self._initial_definitions = ""
        self._context_reset_failed = False
        self._context_rebuilding = False
        self._catalog_path: Path | None = None
        self._definitions = ""
        self._request_stage = "input"
        self._reconciliation_deadline: float | None = None
        self._native_policy: NativeWorkToolPolicy | None = None
        self._native_checkpoint = None
        self._native_calls: dict[str, dict] = {}
        self._native_permissions: dict[str, tuple[str, asyncio.Task]] = {}
        self._native_status = "dispatching"
        self._native_turn_id: str | None = None
        self._closing = False

    def bind_runtime(self, tools, checkpoint_callback=None) -> None:
        self._native_policy = NativeWorkToolPolicy(tools, self.executor.value, self.workspace)
        self._native_checkpoint = checkpoint_callback

    def native_work_snapshot(self) -> dict:
        previous = next(reversed(self._native_calls.values()), {})
        return {"executor": self.executor.value,
                "native_session_id": self._binding.native_session_id if self._binding else previous.get("native_session_id"),
                "native_turn_id": self._native_turn_id, "status": self._native_status,
                "calls": [dict(call) for call in self._native_calls.values()]}

    async def _checkpoint_native(self) -> None:
        if self._native_checkpoint is not None and self._binding is not None:
            await self._native_checkpoint({"phase": "native_execution", "native_work": self.native_work_snapshot()})

    async def _native_permission(self, turn_id: str, item_id: str, name: str, arguments: dict) -> dict:
        if (self._native_policy is None or self._binding is None or self._closing or self._done
                or self._reconciliation_deadline is not None
                or self._context_rebuilding and item_id not in self._native_permissions):
            return {"allow": False, "message": "当前轮次不能接受新的原生操作。"}
        if self._native_turn_id not in {None, turn_id}:
            return {"allow": False, "message": "操作不属于当前轮次。"}
        reply = self._native_policy.check(name, arguments)
        if reply.get("allow") is not True:
            return reply
        self._native_turn_id = turn_id
        self._turn_progress = True
        safe_args = reply.get("arguments", arguments)
        fingerprint = hashlib.sha256(json.dumps(
            [turn_id, name, safe_args], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        existing = self._native_permissions.get(item_id)
        if existing is not None and existing[0] != fingerprint:
            return {"allow": False, "message": "原生操作标识已绑定其他参数，未接受本次操作。"}

        async def approve():
            record = {"id": item_id, "name": name, "status": "started",
                      "native_session_id": self._binding.native_session_id,
                      "native_turn_id": turn_id}
            path = next((safe_args.get(key) for key in ("file_path", "path", "notebook_path", "cwd", "workdir", "grantRoot")
                         if isinstance(safe_args.get(key), str)), None)
            record["path"] = path or str(self.workspace)
            command = safe_args.get("command", safe_args.get("cmd"))
            if isinstance(command, str):
                record["command_sha256"] = hashlib.sha256(command.encode()).hexdigest()
            self._native_calls[item_id] = record
            try:
                await self._checkpoint_native()
            except BaseException as exc:
                self._native_calls.pop(item_id, None)
                if isinstance(exc, asyncio.CancelledError):
                    raise
                logger.warning("Native Work operation checkpoint failed for {}", self.executor.value)
                return {"allow": False, "message": "操作记录未能保存，本次操作未执行。"}
            return reply

        if existing is None:
            existing = (fingerprint, asyncio.create_task(approve()))
            self._native_permissions[item_id] = existing
        result = await asyncio.shield(existing[1])
        if self._closing or self._done or self._reconciliation_deadline is not None:
            return {"allow": False, "message": "当前轮次不能接受新的原生操作。"}
        current = self._native_policy.check(name, arguments)
        if current.get("allow") is not True or current.get("arguments", arguments) != safe_args:
            return {"allow": False, "message": "操作权限或目标路径已变化，本次操作未执行。"}
        return result

    def _validate_native_policy(self) -> tuple[str, ...]:
        if self._native_policy is None:
            return ()
        names = self._native_policy.native_tools
        registry = self._native_policy.tools
        shell = registry.get("exec")
        if shell is not None and any(name in names for name in ("exec_command", "Bash", "PowerShell")):
            if shell.sandbox or shell.restrict_to_workspace or self.config.tools.restrict_to_workspace:
                raise RpcError("native_policy_unavailable", "原生程序不能复用当前命令沙箱或严格目录限制。")
        if self.executor == ExecutorId.CODEX:
            reads = [registry.get(name) for name in ("read_file", "list_dir", "find_files", "grep")
                     if registry.is_permitted(name) and getattr(registry.get(name), "model_visible", True)
                     and registry.get(name).available_in_context()]
            if any(getattr(tool, "_allowed_dir", None) is not None for tool in reads):
                raise RpcError("native_policy_unavailable", "此原生程序无法保证当前读取目录限制。")
            if reads and "exec_command" not in names:
                raise RpcError("native_policy_unavailable", "此原生程序的文件读取依赖未授权的命令工具。")
            if ("exec_command" in names) != ("write_stdin" in names):
                raise RpcError("native_policy_unavailable", "原生命令与进程续接必须具有同一套授权。")
        return names

    def get_capabilities(self, model: str) -> ModelCapabilities:
        return ModelCapabilities(supports_vision=True, supports_tool_calling=True)

    def get_default_model(self) -> str:
        return self.config.agents.defaults.native_model or ""

    @staticmethod
    def _strip_image_content(messages, *, model_supports_vision=None):
        # A failed native turn cannot be safely replayed by removing its images.
        return None

    def for_turn(self, workspace: Path | None):
        provider = NativeWorkProvider(self.config, workspace or self.workspace, native_home=self._native_home)
        provider.generation = self.generation
        return provider

    async def _host_tool(self, binding, turn_id: str, arguments: dict) -> dict:
        if (self._closing or self._done or self._context_rebuilding
                or self._reconciliation_deadline is not None
                or self._binding is not None and binding.native_session_id != self._binding.native_session_id
                or self._native_turn_id is not None and turn_id != self._native_turn_id):
            return {"content": [{"type": "text", "text": "原轮次已暂停或结束，本次操作未派发。"}], "isError": True}
        self._turn_progress = True
        call = WorkToolCall.model_validate(arguments)
        if call.tool in NATIVE_BASIC_TOOLS:
            return {"content": [{"type": "text", "text": "这项基础操作由当前引擎的原生工具提供，请使用原生工具。"}], "isError": True}
        request = ToolCallRequest(id=f"call_{uuid4().hex}", name=call.tool, arguments=call.arguments)
        future = asyncio.get_running_loop().create_future()
        self._pending[request.id] = future
        await self._requests.put(request)
        try:
            result = await future
            content = []
            for block in result if isinstance(result, list) else [{"type": "text", "text": str(result)}]:
                if block.get("type") == "image_url":
                    header, data = block["image_url"]["url"].split(",", 1)
                    content.append({"type": "image", "mimeType": header[5:-7], "data": data})
                else:
                    content.append(block)
            return {"content": content, "isError": False}
        finally:
            self._pending.pop(request.id, None)

    async def _start(self, messages, tools, model, reasoning_effort) -> None:
        self._request_stage = "input"
        native_tools = self._validate_native_policy()
        self._closing = False
        history = native_history_input(messages)
        self._context_rebuilding = False
        if self._native_calls:
            history.append({"type": "text", "text": (
                "本轮原生操作的历史执行记录，仅供核对，不是新的执行请求：\n"
                + json.dumps(self.native_work_snapshot(), ensure_ascii=False)
                + "\n不要重放已完成的写入；未确认的操作先核对会话和文件结果。"
            )})
        validate_content(history, context_input=True)
        config = self.config.development
        if self.executor.value not in config.enabled_engines:
            raise RpcError("executor_disabled", "此模型来源已停用，请在模型设置中启用或选择其他模型。")
        discovery = next((item for item in discover_executors(config) if item.executor == self.executor), None)
        if discovery is None or discovery.state != "detected" or not discovery.executable:
            raise RpcError("executor_unavailable", "未找到此模型的引擎程序，请在模型设置中检查连接。")
        home = self._native_home or get_data_dir() / "development" / "native" / self.executor.value
        if self.executor == ExecutorId.CODEX:
            if native_tools:
                profile, self._catalog_path = prepare_codex_work_profile(
                    Path(discovery.executable), home, self.workspace, native_tools=native_tools)
            else:
                profile, self._catalog_path = prepare_codex_work_profile(Path(discovery.executable), home, self.workspace)
            self._host = CodexExecutor(profile, tool_handler=self._host_tool)
        else:
            profile = prepare_sdk_profile(self.executor, Path(discovery.executable), home, self.workspace,
                credential_env=None if self.executor == ExecutorId.CLAUDE else config.codebuddy_api_key_env,
                codebuddy_environment=config.codebuddy_environment)
            self._host = SDKExecutor(profile, tool_handler=self._host_tool)
        self._definitions = json.dumps(tools or [], ensure_ascii=False)
        if self._work_prompt is None:
            prompt = "\n\n".join(str(message.get("content") or "") for message in messages
                                  if message.get("role") in {"system", "developer"})
            self._work_prompt = prompt + (
                "\n\n文件、目录、搜索、命令和进程操作使用当前引擎提供的原生工具；不要通过 Mona 工具重复执行。"
                "原生工具同样受当前授权和能力加载约束；提示需要加载时先调用 load_capability。"
                "Office、资料和内置浏览器等业务操作使用 Mona 对应的专属工具。"
                f"\n以下 Mona 专属工具通过 {WORK_TOOL} 调用，参数 tool 为工具名、arguments 为参数。"
                "工具授权与可用性由 Mona 判断。\n" + self._definitions)
            self._initial_definitions = self._definitions
        elif self._definitions != self._initial_definitions:
            history.append({"type": "text", "text": "当前可用 Mona 工具已更新：\n" + self._definitions})
        prompt = self._work_prompt
        fingerprint = hashlib.sha256(prompt.encode()).hexdigest()
        context = ProjectContext("work", self.workspace, (), (), (), fingerprint, fingerprint)
        session = DevelopmentSession(project_id="work", executor=self.executor, model=model,
                                     model_reasoning_effort=reasoning_effort)
        self._request_stage = "initialization"
        self._binding = await self._host.create_session(SessionStart(
            session, context, model=model, work_prompt=prompt,
            work_native_tools=native_tools, work_native_permission=self._native_permission))
        self._events = self._host.events(self._binding).__aiter__()
        self._native_status = "dispatching"
        self._native_turn_id = None
        self._native_permissions.clear()
        await self._checkpoint_native()
        self._request_stage = "dispatch"
        receipt = await self._host.send(self._binding, f"input_{uuid4().hex}", history)
        if receipt.outcome == "rejected":
            raise RpcError("native_dispatch_rejected", "模型连接拒绝了本次派发，未发送模型请求。")
        if receipt.outcome != "accepted":
            raise RpcError("native_dispatch_unconfirmed", "模型请求的结果尚未确认，请核对原会话。", outcome_unknown=True)
        self._request_stage = "response"
        self._native_turn_id = receipt.native_turn_id
        self._native_status = "running"
        self._event_task = asyncio.create_task(anext(self._events))
        self._tool_task = asyncio.create_task(self._requests.get())
        self._message_count = len(messages)
        self._history_digest = self._history_fingerprint(messages)

    @staticmethod
    def _history_fingerprint(messages: list[dict]) -> str:
        return hashlib.sha256(json.dumps(native_history_input(messages), ensure_ascii=False,
                                         sort_keys=True).encode()).hexdigest()

    def _unconfirmed_native_calls(self) -> list[dict]:
        return [call for call in self._native_calls.values()
                if call["status"] in {"started", "unknown"} and self._binding is not None
                and call.get("native_session_id") == self._binding.native_session_id]

    async def _record_native_completion(self, event) -> None:
        payload = event.payload
        record = self._native_calls.get(payload.get("itemId", payload.get("id")))
        if (record is None or self._binding is None
                or record.get("native_session_id") != self._binding.native_session_id
                or event.native_turn_id is not None and event.native_turn_id != record.get("native_turn_id")):
            return
        if event.type == "command.completed" and payload.get("status") in {"inProgress", "running"}:
            record["status"] = "started"
        else:
            record["status"] = ("failed" if payload.get("isError") or event.type == "file.change_failed"
                                or payload.get("status") in {"failed", "declined"}
                                or type(payload.get("exitCode")) is int and payload["exitCode"] != 0
                                else "completed")
        await self._checkpoint_native()

    async def _settle_native_operations(self) -> None:
        # A ready screenshot must not cancel an admitted write. Read original
        # receipts while completed business results remain held at the boundary.
        deadline = asyncio.get_running_loop().time() + self.config.tools.exec.timeout
        approvals = [task for _, task in self._native_permissions.values() if not task.done()]
        if approvals:
            await asyncio.wait_for(asyncio.gather(*(asyncio.shield(task) for task in approvals)),
                                   self.config.development.native_work_reconciliation_timeout_seconds)
        await asyncio.sleep(0)
        while self._unconfirmed_native_calls() or self._event_task is not None and self._event_task.done():
            if self._event_task is None or any(call["status"] == "unknown" for call in self._unconfirmed_native_calls()):
                raise RpcError("native_turn_incomplete", "原生操作结果尚未确认，未重建执行上下文。")
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0 or not (await asyncio.wait({self._event_task}, timeout=remaining))[0]:
                raise RpcError("native_turn_incomplete", "等待原生操作结果超时，未重建执行上下文。")
            event = self._event_task.result()
            self._event_task = asyncio.create_task(anext(self._events))
            if self._native_turn_id is not None and event.native_turn_id not in {None, self._native_turn_id}:
                continue
            if event.type in {"command.completed", "tool.completed", "file.changed", "file.change_failed"}:
                await self._record_native_completion(event)
            elif event.type == "usage.updated":
                self._update_usage(event.payload)
            elif event.type in {"run.completed", "run.failed", "run.interrupted", "run.unknown", "policy.violation"}:
                raise RpcError("native_turn_incomplete", "原生轮次结束前仍有未确认操作，未重建执行上下文。")
            await asyncio.sleep(0)

    async def _reset_context(self) -> None:
        """Close a paused native run before replaying completed records as input."""
        self._context_rebuilding = True
        try:
            await self._settle_native_operations()
        except BaseException:
            self._context_reset_failed = True
            logger.warning("Native Work context rebuild blocked for {} (reason=unconfirmed_native_operations, turn={})",
                           self.executor.value, self._native_turn_id)
            raise
        if self._host is not None and not self._done:
            for future in list(self._pending.values()):
                if not future.done():
                    future.cancel()
            try:
                async with asyncio.timeout(5):
                    await self._host.interrupt(self._binding)
                    while self._event_task is not None:
                        event = await self._event_task
                        self._event_task = asyncio.create_task(anext(self._events))
                        if event.type == "usage.updated":
                            self._update_usage(event.payload)
                        if event.type in {"run.completed", "run.failed", "run.interrupted"}:
                            self._done = True
                            break
            except (TimeoutError, StopAsyncIteration):
                logger.warning("Native Work context ended without a final usage receipt for {}", self.executor.value)
            except BaseException:
                self._context_reset_failed = True
                raise
        try:
            await self.aclose()
        except BaseException:
            self._context_reset_failed = True
            raise
        for key, value in self._usage.items():
            self._carry_usage[key] = self._carry_usage.get(key, 0) + max(0, value - self._reported_usage.get(key, 0))
        self._done = False
        self._reconciliation_deadline = None
        self._native_status = "dispatching"
        self._native_turn_id = None
        self._binding = self._events = None
        self._requests = asyncio.Queue()
        self._pending.clear()
        self._texts.clear()
        self._usage.clear()
        self._reported_usage.clear()
        self._context_usage.pop("context_tokens", None)

    def _update_usage(self, payload: dict) -> None:
        usage = payload.get("usage") or (payload.get("tokenUsage") or {}).get("total") or {}
        prompt_tokens = None
        if "inputTokens" in usage:
            prompt_tokens = usage["inputTokens"]
        elif any(name in usage for name in (
            "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
        )):
            prompt_tokens = (usage.get("input_tokens") if self.executor == ExecutorId.CODEBUDDY else sum(
                usage.get(name, 0) or 0
                for name in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
            ))
        if isinstance(prompt_tokens, int) and prompt_tokens >= 0:
            self._usage["prompt_tokens"] = prompt_tokens
        for name, aliases in {
            "completion_tokens": ("outputTokens", "output_tokens"),
            "cached_tokens": ("cachedInputTokens", "cache_read_input_tokens"),
        }.items():
            value = next((usage[key] for key in aliases if key in usage), None)
            if isinstance(value, int) and value >= 0:
                self._usage[name] = value
        for source, target in (("contextTokens", "context_tokens"), ("contextWindow", "context_window_tokens")):
            if isinstance(payload.get(source), int) and payload[source] > 0:
                self._context_usage[target] = payload[source]

    def _response(self, content: str, calls: list[ToolCallRequest] | None = None) -> LLMResponse:
        usage = {key: max(0, value - self._reported_usage.get(key, 0)) for key, value in self._usage.items()}
        for key, value in self._carry_usage.items():
            usage[key] = usage.get(key, 0) + value
        self._carry_usage.clear()
        self._reported_usage = dict(self._usage)
        if "prompt_tokens" in usage or "completion_tokens" in usage:
            usage["total_tokens"] = usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0)
        usage.update(self._context_usage)
        return LLMResponse(content=content or None, tool_calls=calls or [], usage=usage,
                           finish_reason="tool_calls" if calls else "stop")

    def _error_response(self, code: str, *, exc: Exception | None = None,
                        status_code: int | None = None) -> LLMResponse:
        if not self._done:
            self._native_status = "unknown"
            for record in self._native_calls.values():
                if record["status"] == "started":
                    record["status"] = "unknown"
        if type(status_code) is not int or not 100 <= status_code <= 599:
            status_code = None
        method = exc.rpc_method if isinstance(exc, RemoteRpcError) else None
        rpc_code = exc.rpc_code if isinstance(exc, RemoteRpcError) else None
        if self.executor == ExecutorId.CODEX and method == "account/read" and self._binding is None:
            code = "native_account_check_failed"
        if code in {"upstream_connection_failed", "upstream_stream_disconnected", "upstream_retries_exhausted"}:
            if status_code == 401:
                code = "authentication_required"
            elif status_code == 403:
                code = "model_access_denied"
            elif status_code == 404:
                code = "upstream_not_found"
            elif status_code in {408, 504}:
                code = "upstream_timeout"
            elif status_code == 413:
                code = "upstream_input_too_large"
            elif status_code == 429:
                code = "rate_limit_exceeded"
            elif status_code is not None and status_code >= 500:
                code = "upstream_internal_error"
            elif status_code is not None and status_code >= 400:
                code = "upstream_invalid_request"
        logger.warning("Work native model response failed for {}: {} ({}, stage={}, method={}, rpc_code={}, http_status={})",
                       self.executor.value, code, type(exc).__name__ if exc else "NativeEvent",
                       self._request_stage, method, rpc_code, status_code)
        content = _ERROR_MESSAGES.get(code)
        if content is None:
            preparing = self._request_stage in {"input", "initialization"}
            if exc is None:
                content = _ERROR_MESSAGES["native_turn_failed"]
            elif isinstance(exc, RpcError):
                content = ("所选模型的本机连接未能准备就绪，本次生成尚未开始。请在模型设置中检查连接及配套组件。"
                           if preparing else
                           "与模型程序通信时发生错误，本次结果尚未确认。请先核对会话和文件结果，再继续；若持续发生，请反馈诊断日志。")
            else:
                content = ("Mona 在准备模型请求时发生内部错误，本次生成尚未开始。请重试；若持续发生，请反馈诊断日志。"
                           if preparing else
                           "Mona 在处理模型请求时发生内部错误，尚未收到完整结果。请核对已有内容和文件结果后继续；若持续发生，请反馈诊断日志。")
        if code == "native_request_timeout" and self._request_stage in {"input", "initialization"}:
            content = "连接模型超时，尚未开始本次生成。请检查网络和模型设置后重试。"
        if code == "native_request_rejected" and self._request_stage == "initialization":
            content = "模型连接拒绝了初始化请求，尚未开始本次生成。请在模型设置中检查连接及配套程序版本后重试。"
        if self._turn_progress and code in {"server_overloaded", "usage_limit_exceeded", "rate_limit_exceeded",
                                           "model_service_unavailable", "upstream_internal_error", "authentication_required"}:
            content += "本轮已产生内容或执行过操作，请先核对会话和文件结果后再继续。"
        usage = self._response("").usage if self._usage or self._carry_usage or self._context_usage else {}
        return LLMResponse(content=content, finish_reason="error", error_code=code, usage=usage,
                           error_status_code=status_code,
                           error_should_retry=(self._done and self._reconciliation_deadline is None
                                               and code == "server_overloaded" and not self._turn_progress))

    async def _chat(self, messages, tools, model, reasoning_effort, on_content_delta=None, on_thinking_delta=None):
        tools = filter_native_work_tools(tools or [])
        defer_results = False
        if self._context_reset_failed:
            return self._error_response("native_turn_incomplete")
        if self._reconciliation_deadline is not None and not self._done:
            if self._host is None:
                return self._error_response("native_turn_incomplete")
        elif self._done:
            await self._reset_context()
        elif self._host is not None:
            completed = [message for message in messages if message.get("role") == "tool"
                         and message.get("tool_call_id") in self._pending
                         and not self._pending[message["tool_call_id"]].done()]
            changed = self._history_fingerprint(messages[:self._message_count]) != self._history_digest
            # WorkBuddy's MCP result processor stringifies images. Its user
            # input path preserves pixels; only reseed at a completed-tool pause.
            image_result = self.executor == ExecutorId.CODEBUDDY and any(
                isinstance(message.get("content"), list)
                and any(isinstance(block, dict) and block.get("type") == "image_url"
                        for block in message["content"])
                for message in completed)
            added_images = any(
                message.get("role") == "user" and isinstance(message.get("content"), list)
                and any(isinstance(block, dict) and block.get("type") == "image_url"
                        for block in message["content"])
                for message in messages[self._message_count:])
            if changed or image_result or added_images:
                if not completed:
                    return self._error_response("native_turn_incomplete")
                completed_ids = {message["tool_call_id"] for message in completed}
                defer_results = any(not future.done() and key not in completed_ids for key, future in self._pending.items())
                if not defer_results:
                    await self._reset_context()
        if self._host is None:
            await self._start(messages, tools, model, reasoning_effort)
        elif self._reconciliation_deadline is None and not defer_results:
            if completed:
                self._context_usage.pop("context_tokens", None)
            for message in messages:
                future = self._pending.get(message.get("tool_call_id")) if message.get("role") == "tool" else None
                if future is not None and not future.done():
                    result = message.get("content") or ""
                    additions = []
                    definitions = json.dumps(tools or [], ensure_ascii=False)
                    if definitions != self._definitions:
                        additions.append("当前可用 Mona 工具已更新：\n" + definitions)
                        self._definitions = definitions
                    added = [item for item in messages[self._message_count:] if item.get("role") == "user"]
                    if added:
                        additions.append("新增用户输入：\n" + json.dumps(added, ensure_ascii=False))
                    if additions:
                        text = {"type": "text", "text": "\n\n".join(additions)}
                        result = [*result, text] if isinstance(result, list) else str(result) + "\n\n" + text["text"]
                    future.set_result(result)
            self._message_count = len(messages)
            self._history_digest = self._history_fingerprint(messages)
        parts = []
        while True:
            timeout = None
            waiting = {self._event_task, self._tool_task}
            if self._reconciliation_deadline is not None:
                timeout = max(0, self._reconciliation_deadline - asyncio.get_running_loop().time())
                waiting = {self._event_task}
            ready = set()
            if timeout is None or timeout > 0:
                ready, _ = await asyncio.wait(waiting, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
            if not ready:
                logger.warning("Native Work terminal wait expired for {} (reason=sdk_terminal_wait_timeout)",
                               self.executor.value)
                return self._error_response("native_turn_incomplete")
            if not self._event_task.done() and self._tool_task.done():
                call = self._tool_task.result()
                self._tool_task = asyncio.create_task(self._requests.get())
                return self._response("".join(parts), [call])
            try:
                event = self._event_task.result()
            except StopAsyncIteration:
                logger.warning("Native Work event stream ended for {} (reason=event_stream_ended_without_result)",
                               self.executor.value)
                return self._error_response("native_turn_incomplete")
            self._event_task = asyncio.create_task(anext(self._events))
            payload = event.payload
            if event.type in {"agent.message.delta", "agent.message.completed"}:
                item = str(payload.get("itemId", "message"))
                previous = self._texts.get(item, "")
                if event.type == "agent.message.delta":
                    delta = payload.get("delta") or ""
                    self._texts[item] = previous + delta
                else:
                    text = payload.get("text") or ""
                    delta = text[len(previous):] if text.startswith(previous) else text if not previous else ""
                    self._texts[item] = text
                if delta:
                    self._turn_progress = True
                    parts.append(delta)
                    if on_content_delta:
                        await on_content_delta(delta)
            elif event.type == "reasoning.delta":
                delta = payload.get("delta") or ""
                if delta:
                    self._turn_progress = True
                    if on_thinking_delta:
                        await on_thinking_delta(delta)
            elif event.type == "usage.updated":
                self._update_usage(payload)
            elif event.type in {"command.completed", "tool.completed", "file.changed", "file.change_failed"}:
                await self._record_native_completion(event)
            elif event.type == "run.completed":
                self._done = True
                self._native_status = "completed"
                for record in self._native_calls.values():
                    if record["status"] == "started":
                        record["status"] = "unknown"
                if self._unconfirmed_native_calls() or any(not future.done() for future in self._pending.values()):
                    self._native_status = "unknown"
                    self._context_reset_failed = True
                    await self._checkpoint_native()
                    return self._error_response("native_turn_incomplete")
                await self._checkpoint_native()
                return self._response("".join(parts))
            elif event.type == "run.failed":
                self._done = True
                self._native_status = "failed"
                for record in self._native_calls.values():
                    if record["status"] == "started":
                        record["status"] = "unknown"
                await self._checkpoint_native()
                code = payload.get("errorCode") or "native_turn_failed"
                return self._error_response(code, status_code=payload.get("errorStatusCode"))
            elif event.type in {"run.unknown", "run.interrupted", "policy.violation"}:
                self._native_status = "interrupted" if event.type == "run.interrupted" else "unknown"
                await self._checkpoint_native()
                if event.type == "run.unknown":
                    logger.warning("Native Work state unconfirmed for {} (turn={}, reason={}, exception_type={}, location={}, rejected_tool={}, tool_stage={})",
                                   self.executor.value, event.native_turn_id, payload.get("reason"),
                                   payload.get("exceptionType"), payload.get("errorLocation"),
                                   payload.get("rejectedTool"), payload.get("toolEventStage"))
                    if (self.executor in {ExecutorId.CLAUDE, ExecutorId.CODEBUDDY}
                            and payload.get("reason") == "sdk_error_reported"
                            and payload.get("requiresReconciliation") is True):
                        if self._reconciliation_deadline is None:
                            self._reconciliation_deadline = (asyncio.get_running_loop().time()
                                + self.config.development.native_work_reconciliation_timeout_seconds)
                        continue
                code = {"run.unknown": "native_turn_incomplete", "run.interrupted": "native_turn_interrupted",
                        "policy.violation": "native_policy_violation"}[event.type]
                if event.type == "run.unknown" and payload.get("errorCode") in _ERROR_MESSAGES:
                    code = payload["errorCode"]
                return self._error_response(code)

    async def chat(self, messages, tools=None, model=None, max_tokens=4096, temperature=0.7,
                   reasoning_effort=None, tool_choice=None) -> LLMResponse:
        return await self.chat_stream(messages, tools, model, max_tokens, temperature, reasoning_effort, tool_choice)

    async def chat_stream(self, messages, tools=None, model=None, max_tokens=4096, temperature=0.7,
                          reasoning_effort=None, tool_choice=None, on_content_delta=None,
                          on_thinking_delta=None, on_tool_call_delta=None) -> LLMResponse:
        try:
            return await self._chat(messages, tools, model, reasoning_effort, on_content_delta, on_thinking_delta)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            code = getattr(exc, "code", "native_response_failed")
            return self._error_response(code, exc=exc)

    async def aclose(self) -> None:
        self._closing = True
        approvals = [task for _, task in self._native_permissions.values()]
        for task in approvals:
            if not task.done():
                task.cancel()
        await asyncio.gather(*approvals, return_exceptions=True)
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        tasks = [task for task in (self._event_task, self._tool_task) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._event_task = self._tool_task = None
        if self._host is not None:
            host = self._host
            try:
                if self._binding is not None and not self._done:
                    async with asyncio.timeout(5):
                        await host.interrupt(self._binding)
            finally:
                await host.shutdown()
                self._host = None
        if self._catalog_path is not None:
            self._catalog_path.unlink(missing_ok=True)
            self._catalog_path = None
