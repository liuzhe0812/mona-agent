"""Keep native model execution separate from the hosted workspace sandbox."""
from __future__ import annotations

import asyncio
import copy
import json
from pathlib import Path

from mona.development.contracts import ExecutorId
from mona.development.executors.host_tools import WORK_TOOL
from mona.development.executors.rpc import RpcError
from mona.hosted_work.codex_usage import CodexUsage
from mona.providers.native_work_provider import NativeWorkProvider
from mona.providers.native_work_tools import NATIVE_BASIC_TOOLS

_PREFIX = "hosted_"
_STOP_CONFIRM_TIMEOUT = 5.0


def _hosted_definitions(definitions):
    result = copy.deepcopy(definitions or [])
    names = set()
    for item in result:
        function = item.get("function", item) if isinstance(item, dict) else {}
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            names.add(function["name"])
    aliases = {}
    for item in result:
        function = item.get("function", item) if isinstance(item, dict) else {}
        if not isinstance(function, dict) or function.get("name") not in NATIVE_BASIC_TOOLS:
            continue
        name = function["name"]
        alias = _PREFIX + name
        if alias in names:
            raise RpcError("native_policy_unavailable", "工作区工具名称冲突，本次任务未开始。")
        function["name"] = alias
        aliases[alias] = name
    return result, aliases


class HostedNativeWorkProvider(NativeWorkProvider):
    """Reuse the desktop provider while routing all workspace tools through Mona."""

    def __init__(self, config, workspace: Path, *, native_home: Path | None = None,
                 billing_usage: CodexUsage | None = None):
        super().__init__(config, workspace, native_home=native_home)
        self.billing_usage = billing_usage if billing_usage is not None else CodexUsage()
        self._billing_active = False
        self._billing_not_dispatched = False
        self._billing_fields: set[str] = set()
        self._billing_previous: tuple[int, int, int] | None = None
        self._billing_receipt_serial = 0
        self._billing_tool_serial = 0
        self._billing_tool_snapshot: tuple[int, int, int] | None = None

    def for_turn(self, workspace: Path | None):
        provider = type(self)(self.config, workspace or self.workspace, native_home=self._native_home,
                              billing_usage=self.billing_usage)
        provider.generation = self.generation
        provider._CHAT_RETRY_DELAYS = self._CHAT_RETRY_DELAYS
        return provider

    def bind_runtime(self, tools, checkpoint_callback=None) -> None:
        # Native tools would run in the CLI host, not the user's gVisor workspace.
        self._native_policy = None
        self._native_checkpoint = checkpoint_callback

    async def _start(self, messages, tools, model, reasoning_effort) -> None:
        if self._work_prompt is None:
            definitions = json.dumps(tools or [], ensure_ascii=False)
            prompt = "\n\n".join(str(message.get("content") or "") for message in messages
                                  if message.get("role") in {"system", "developer"})
            self._work_prompt = prompt + (
                f"\n\n文件、目录、命令及其他工作区操作仅使用 {WORK_TOOL} 调用下列工具；"
                "tool 填工具名，arguments 填参数。文件工具可按说明读取、创建和修改当前工作区内容；"
                "不要将当前执行环境的只读限制当成这些工具的限制，操作结果以工具实际返回为准。\n" + definitions)
            self._initial_definitions = definitions
        self.billing_usage.begin()
        self._billing_active = True
        self._billing_not_dispatched = False
        self._billing_fields.clear()
        self._billing_previous = None
        self._billing_receipt_serial = 0
        self._billing_tool_serial = 0
        self._billing_tool_snapshot = None
        try:
            await super()._start(messages, tools, model, reasoning_effort)
        except BaseException:
            # create_session only prepares the native thread. The first model
            # request is sent after its binding exists; setup rejection is zero
            # model usage, rather than an unknown charge that keeps a hold.
            self._billing_not_dispatched = self._binding is None
            self._finish_billing(self._billing_not_dispatched, "start_failed")
            raise

    def _finish_billing(self, complete: bool, reason: str = "incomplete_receipt") -> None:
        if self._billing_active:
            self.billing_usage.finish(complete, reason)
            self._billing_active = False

    def _update_usage(self, payload: dict) -> None:
        total = payload.get("tokenUsage", {}).get("total") if isinstance(payload.get("tokenUsage"), dict) else None
        fields = ("inputTokens", "cachedInputTokens", "outputTokens")
        values = tuple(total.get(key) for key in fields) if isinstance(total, dict) else ()
        if (len(values) != 3 or any(type(value) is not int or value < 0 for value in values)
                or values[1] > values[0]
                or self._billing_previous is not None and any(a < b for a, b in zip(values, self._billing_previous))):
            self.billing_usage.invalidate("invalid_native_usage")
        else:
            self._billing_previous = values
            self._billing_receipt_serial += 1
        super()._update_usage(payload)

    async def _chat(self, messages, tools, model, reasoning_effort, on_content_delta=None, on_thinking_delta=None):
        definitions, aliases = _hosted_definitions(tools)
        try:
            response = await super()._chat(messages, definitions, model, reasoning_effort,
                                           on_content_delta, on_thinking_delta)
        except BaseException:
            self._finish_billing(False, "chat_interrupted")
            raise
        self._billing_fields.update(self.billing_usage.add(response.usage))
        if response.finish_reason == "error":
            if not self._billing_not_dispatched:
                self.billing_usage.invalidate("native_response_error")
                self._finish_billing(False, "native_response_error")
        elif response.finish_reason == "tool_calls":
            self._billing_tool_serial = self._billing_receipt_serial
            self._billing_tool_snapshot = self._billing_previous
        elif self._done:
            self._finish_billing({"prompt_tokens", "cached_tokens", "completion_tokens"} <= self._billing_fields
                                 and self._billing_receipt_serial > self._billing_tool_serial
                                 and (self._billing_tool_snapshot is None or self._billing_previous is not None
                                      and any(a > b for a, b in zip(self._billing_previous, self._billing_tool_snapshot))))
        for call in response.tool_calls:
            if call.name in aliases:
                call.name = aliases[call.name]
        return response

    async def aclose(self) -> None:
        self._finish_billing(False, "unfinished_on_close")
        binding = self._binding
        host = self._host
        unconfirmed = False
        try:
            if self.executor == ExecutorId.CODEX and host is not None and binding is not None and not self._done:
                # Stop accepting new native operations before interrupting this turn.
                # Keep the event reader alive until the exact turn has a terminal
                # receipt; an interrupt acknowledgement alone is not completion.
                self._closing = True
                approvals = [task for _, task in self._native_permissions.values()]
                for task in approvals:
                    if not task.done():
                        task.cancel()
                for future in self._pending.values():
                    if not future.done():
                        future.cancel()
                unconfirmed = not await self._confirm_codex_stop(host, binding)
                if unconfirmed:
                    self._native_status = "unknown"
        finally:
            # We already sent the precise interrupt above. Prevent the desktop
            # cleanup from sending a second uncorrelated interrupt, but always
            # keep its established host/process cleanup and credential cleanup.
            if self.executor == ExecutorId.CODEX and host is not None and binding is not None and not self._done:
                self._binding = None
            try:
                await super().aclose()
            except BaseException:
                self.billing_usage.invalidate("close_failed")
                raise
            finally:
                self._binding = binding
        if unconfirmed:
            self.billing_usage.invalidate("native_stop_unconfirmed")
            raise RpcError("native_stop_unconfirmed", "本轮模型停止状态尚未确认。", outcome_unknown=True)

    async def _confirm_codex_stop(self, host, binding) -> bool:
        turn_id = self._native_turn_id
        if turn_id is None and self._request_stage in {"input", "initialization"}:
            return True  # No model turn has been dispatched yet.
        try:
            async with asyncio.timeout(_STOP_CONFIRM_TIMEOUT):
                receipt = await host.interrupt(binding, native_turn_id=turn_id)
                # Without the dispatched turn identity, even an idle reply is
                # not evidence that this particular request did not start.
                if not isinstance(turn_id, str) or not turn_id:
                    return False
                if receipt.outcome in {"confirmed", "already_finished"}:
                    return True
                if receipt.outcome != "requested":
                    return False
                while self._event_task is not None and self._events is not None:
                    event = await self._event_task
                    self._event_task = asyncio.create_task(anext(self._events))
                    if event.native_turn_id != turn_id:
                        continue
                    if event.type == "usage.updated":
                        self._update_usage(event.payload)
                    elif event.type in {"run.completed", "run.failed", "run.interrupted"}:
                        return True
                    elif event.type in {"run.unknown", "policy.violation"}:
                        return False
        except Exception:
            # The host is still closed by aclose(); missing evidence must not be
            # reported as a confirmed stop or cause the request to be retried.
            return False
        return False
