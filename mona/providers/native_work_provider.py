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
from mona.development.input_content import MAX_NATIVE_TEXT_CHARS
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.providers.capabilities import ModelCapabilities

_ERROR_MESSAGES = {
    "server_overloaded": "当前模型繁忙，暂时无法响应。请稍后重试或选择其他模型。",
    "usage_limit_exceeded": "当前账号已达到使用额度。请稍后再试，或在模型设置中查看额度。",
    "authentication_required": "该模型账号需要登录。请在模型设置中完成登录后重试。",
    "context_window_exceeded": "当前会话超过所选模型可处理的容量。请新建会话或选择更大容量的模型。",
    "native_account_check_failed": "模型账号状态检查未能完成，尚未开始本次生成。请稍后重试，或在模型设置中检查连接。",
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
    """Fit older tool text to transport limits without changing saved history."""
    blocks = _native_history_blocks(messages)
    if sum(len(block.get("text", "")) for block in blocks) <= MAX_NATIVE_TEXT_CHARS:
        return blocks
    last_user = max((index for index, message in enumerate(messages) if message.get("role") == "user"), default=0)
    history = list(messages)
    omitted = "[Older tool text omitted to fit input limits. The full result remains saved. Read the current project/files before relying on it; do not replay historical operations.]"
    for index, message in enumerate(messages[:last_user]):
        if message.get("role") != "tool":
            continue
        content = message.get("content")
        if isinstance(content, str) and len(content) > 4096:
            reduced = omitted
        elif isinstance(content, list) and sum(len(item.get("text", "")) for item in content) > 4096:
            reduced = [{**item, "text": omitted} if item.get("type") == "text" else item for item in content]
        else:
            continue
        history[index] = {**message, "content": reduced}
        blocks = _native_history_blocks(history)
        if sum(len(block.get("text", "")) for block in blocks) <= MAX_NATIVE_TEXT_CHARS:
            break
    return blocks


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
        self._binding = await self._host.create_session(SessionStart(session, context, model=model, work_prompt=prompt))
        self._events = self._host.events(self._binding).__aiter__()
        receipt = await self._host.send(self._binding, f"input_{uuid4().hex}", native_history_input(messages))
        if receipt.outcome != "accepted":
            raise RpcError("native_dispatch_unconfirmed", "模型请求的结果尚未确认，请核对原会话。", outcome_unknown=True)
        self._event_task = asyncio.create_task(anext(self._events))
        self._tool_task = asyncio.create_task(self._requests.get())
        self._message_count = len(messages)

    def _update_usage(self, payload: dict) -> None:
        usage = payload.get("usage") or (payload.get("tokenUsage") or {}).get("total") or {}
        for name, aliases in {
            "prompt_tokens": ("inputTokens", "input_tokens"),
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
                raise RpcError(code, _ERROR_MESSAGES.get(code, "模型响应未完成，请核对会话结果后重试或选择其他模型。"))
            elif event.type in {"run.unknown", "run.interrupted", "policy.violation"}:
                raise RpcError("native_turn_incomplete", "模型响应未完成，请核对会话后重试。", outcome_unknown=True)

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
            method = exc.rpc_method if isinstance(exc, RemoteRpcError) else None
            rpc_code = exc.rpc_code if isinstance(exc, RemoteRpcError) else None
            if self.executor == ExecutorId.CODEX and method == "account/read" and self._binding is None:
                code = "native_account_check_failed"
            logger.warning("Work native model response failed for {}: {} ({}, method={}, rpc_code={})",
                           self.executor.value, code, type(exc).__name__, method, rpc_code)
            content = _ERROR_MESSAGES.get(code, "模型响应未完成，请核对会话结果后重试或选择其他模型。")
            if code == "server_overloaded" and self._turn_progress:
                content = "当前模型繁忙，响应已中断。请核对会话结果后稍后继续，或选择其他模型。"
            return LLMResponse(content=content, finish_reason="error", error_code=code,
                               error_should_retry=self._done and code == "server_overloaded" and not self._turn_progress)

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
