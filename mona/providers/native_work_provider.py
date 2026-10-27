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
    "native_turn_interrupted": "本次模型回复已中断，请核对已有内容和文件结果后继续。",
    "native_policy_violation": "模型请求了当前任务未授权的操作，Mona 已停止本轮。请核对操作授权和已有结果后继续。",
    "native_request_timeout": "等待模型确认超时，本次结果尚未确认。请先核对会话和文件结果，再决定是否继续。",
    "native_transport_lost": "与本机模型程序的连接中断，本次结果尚未确认。请先核对会话和文件结果，再继续。",
    "native_disconnected": "本机模型程序的连接已关闭。请在模型设置中检查连接，并核对本轮已有结果后继续。",
    "native_protocol_error": "模型程序返回的内容格式无法识别。请核对已有结果，并检查配套程序版本后重试。",
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

    def __init__(self, config: Config, workspace: Path):
        super().__init__()
        self.config = config
        self.workspace = workspace.resolve()
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
        self._done = False
        self._turn_progress = False
        self._message_count = 0
        self._catalog_path: Path | None = None
        self._definitions = ""
        self._request_stage = "input"

    def get_capabilities(self, model: str) -> ModelCapabilities:
        return ModelCapabilities(supports_vision=True, supports_tool_calling=True)

    def get_default_model(self) -> str:
        return self.config.agents.defaults.native_model or ""

    @staticmethod
    def _strip_image_content(messages, *, model_supports_vision=None):
        # A failed native turn cannot be safely replayed by removing its images.
        return None

    def for_turn(self, workspace: Path | None):
        provider = NativeWorkProvider(self.config, workspace or self.workspace)
        provider.generation = self.generation
        return provider

    async def _host_tool(self, binding, turn_id: str, arguments: dict) -> dict:
        self._turn_progress = True
        call = WorkToolCall.model_validate(arguments)
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
        history = native_history_input(messages)
        validate_content(history, context_input=True)
        config = self.config.development
        if self.executor.value not in config.enabled_engines:
            raise RpcError("executor_disabled", "此模型来源已停用，请在模型设置中启用或选择其他模型。")
        discovery = next((item for item in discover_executors(config) if item.executor == self.executor), None)
        if discovery is None or discovery.state != "detected" or not discovery.executable:
            raise RpcError("executor_unavailable", "未找到此模型的引擎程序，请在模型设置中检查连接。")
        home = get_data_dir() / "development" / "native" / self.executor.value
        if self.executor == ExecutorId.CODEX:
            profile, self._catalog_path = prepare_codex_work_profile(Path(discovery.executable), home, self.workspace)
            self._host = CodexExecutor(profile, tool_handler=self._host_tool)
        else:
            profile = prepare_sdk_profile(self.executor, Path(discovery.executable), home, self.workspace,
                credential_env=None if self.executor == ExecutorId.CLAUDE else config.codebuddy_api_key_env,
                codebuddy_environment=config.codebuddy_environment)
            self._host = SDKExecutor(profile, tool_handler=self._host_tool)
        prompt = "\n\n".join(str(message.get("content") or "") for message in messages
                              if message.get("role") in {"system", "developer"})
        self._definitions = json.dumps(tools or [], ensure_ascii=False)
        prompt += (f"\n\n所有工具调用使用 {WORK_TOOL}，参数 tool 为工具名、arguments 为该工具的参数。"
                   "仅调用以下 Mona 工具；工具授权与可用性由 Mona 判断。\n"
                   + self._definitions)
        fingerprint = hashlib.sha256(prompt.encode()).hexdigest()
        context = ProjectContext("work", self.workspace, (), (), (), fingerprint, fingerprint)
        session = DevelopmentSession(project_id="work", executor=self.executor, model=model,
                                     model_reasoning_effort=reasoning_effort)
        self._request_stage = "initialization"
        self._binding = await self._host.create_session(SessionStart(session, context, model=model, work_prompt=prompt))
        self._events = self._host.events(self._binding).__aiter__()
        self._request_stage = "dispatch"
        receipt = await self._host.send(self._binding, f"input_{uuid4().hex}", history)
        if receipt.outcome == "rejected":
            raise RpcError("native_dispatch_rejected", "模型连接拒绝了本次派发，未发送模型请求。")
        if receipt.outcome != "accepted":
            raise RpcError("native_dispatch_unconfirmed", "模型请求的结果尚未确认，请核对原会话。", outcome_unknown=True)
        self._request_stage = "response"
        self._event_task = asyncio.create_task(anext(self._events))
        self._tool_task = asyncio.create_task(self._requests.get())
        self._message_count = len(messages)

    def _update_usage(self, payload: dict) -> None:
        usage = payload.get("usage") or (payload.get("tokenUsage") or {}).get("total") or {}
        prompt_tokens = None
        if "inputTokens" in usage:
            prompt_tokens = usage["inputTokens"]
        elif any(name in usage for name in (
            "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
        )):
            prompt_tokens = sum(
                usage.get(name, 0) or 0
                for name in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
            )
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
        self._reported_usage = dict(self._usage)
        usage["total_tokens"] = usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0)
        usage.update(self._context_usage)
        return LLMResponse(content=content or None, tool_calls=calls or [], usage=usage,
                           finish_reason="tool_calls" if calls else "stop")

    def _error_response(self, code: str, *, exc: Exception | None = None,
                        status_code: int | None = None) -> LLMResponse:
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
        return LLMResponse(content=content, finish_reason="error", error_code=code,
                           error_status_code=status_code,
                           error_should_retry=self._done and code == "server_overloaded" and not self._turn_progress)

    async def _chat(self, messages, tools, model, reasoning_effort, on_content_delta=None, on_thinking_delta=None):
        if self._done:
            await self.aclose()
            self._done = False
            self._turn_progress = False
            self._texts.clear()
            self._usage.clear()
            self._reported_usage.clear()
            self._context_usage.clear()
        if self._host is None:
            await self._start(messages, tools, model, reasoning_effort)
        else:
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
        parts = []
        while True:
            await asyncio.wait({self._event_task, self._tool_task}, return_when=asyncio.FIRST_COMPLETED)
            if self._tool_task.done():
                call = self._tool_task.result()
                self._tool_task = asyncio.create_task(self._requests.get())
                return self._response("".join(parts), [call])
            event = self._event_task.result()
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
            elif event.type == "run.completed":
                self._done = True
                return self._response("".join(parts))
            elif event.type == "run.failed":
                self._done = True
                code = payload.get("errorCode") or "native_turn_failed"
                return self._error_response(code, status_code=payload.get("errorStatusCode"))
            elif event.type in {"run.unknown", "run.interrupted", "policy.violation"}:
                code = {"run.unknown": "native_turn_incomplete", "run.interrupted": "native_turn_interrupted",
                        "policy.violation": "native_policy_violation"}[event.type]
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
        for future in self._pending.values():
            if not future.done():
                future.cancel()
        tasks = [task for task in (self._event_task, self._tool_task) if task is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._event_task = self._tool_task = None
        if self._host is not None:
            host, self._host = self._host, None
            try:
                if self._binding is not None and not self._done:
                    async with asyncio.timeout(5):
                        await host.interrupt(self._binding)
            finally:
                await host.shutdown()
        if self._catalog_path is not None:
            self._catalog_path.unlink(missing_ok=True)
            self._catalog_path = None
