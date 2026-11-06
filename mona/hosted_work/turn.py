"""One trusted, short-lived Work host per request; arbitrary commands run only in gVisor."""
from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import inspect
import json
import os
import re
import signal
import sys
from pathlib import Path
from types import SimpleNamespace

from filelock import FileLock

from mona.agent.progress_hook import AgentProgressHook
from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.bus.events import InboundMessage
from mona.config.schema import AgentDefaults, HostedWorkConfig
from mona.hosted_work.auth_client import AuthClient
from mona.hosted_work.contracts import WorkError, identifier, private_directory
from mona.hosted_work.editor_tools import build_editor_tools
from mona.hosted_work.providers import create_provider
from mona.hosted_work.sandbox import DockerSandbox
from mona.hosted_work.tools import HostedTools
from mona.session.webui_turns import build_bus_progress_callback


class WorkHook(AgentProgressHook):
    def __init__(self, emit, authorize=None, payload=None, runtime=None):
        self.emit, self.authorize = emit, authorize
        self.payload, self.runtime = payload or {}, runtime
        self.iteration = -1
        self.last_response = None
        self.max_context_tokens = 0
        self.progress = build_bus_progress_callback(SimpleNamespace(publish_outbound=self._outbound),
            InboundMessage("websocket", "user", self.payload.get("session_id", "direct"), ""))
        super().__init__(on_progress=self.progress, on_stream=self.delta, channel="websocket")

    async def _outbound(self, message):
        meta = message.metadata
        await self._transport_progress(message.content, tool_hint=meta.get("_tool_hint", False),
            tool_events=meta.get("_tool_events"), reasoning=meta.get("_reasoning_delta", False),
            reasoning_end=meta.get("_reasoning_end", False), widget_events=meta.get("_widget_events"),
            file_edit_events=meta.get("_file_edit_events"), token_usage=meta.get("token_usage"),
            context_compacting=meta.get("_context_compacting"))

    async def delta(self, text):
        await self.emit("delta", {"text": text})

    async def _transport_progress(self, content, *, tool_hint=False, tool_events=None, reasoning=False, reasoning_end=False,
                                  widget_events=None, file_edit_events=None, token_usage=None, context_compacting=None):
        if token_usage:
            usage = {**token_usage}
            if self.payload.get("model_id"):
                usage.update(context_model=self.payload["model_id"], context_provider="mona_managed")
            await self.emit("progress", {"kind": "context_usage", "token_usage": usage})
            return
        if context_compacting is not None:
            await self.emit("progress", {"kind": "context_compacting", "active": bool(context_compacting)})
            return
        if file_edit_events:
            await self.emit("progress", {"kind": "file_edit", "edits": file_edit_events})
            return
        if widget_events:
            for event in widget_events:
                if event.get("status") in {"streaming", "complete", "error"}:
                    await self.emit("widget", {**event, "code": ""} if event.get("status") == "streaming" else event)
            return
        if reasoning or reasoning_end:
            await self.emit("progress", {"kind": "reasoning_end" if reasoning_end else "reasoning_delta", "text": content or ""})
            return
        # The desktop hook owns lifecycle, think extraction, names and call IDs.
        # Results remain in execution history, not duplicated in the display log.
        events = []
        for event in tool_events or []:
            value = {key: event[key] for key in ("version", "phase", "call_id", "name", "arguments") if key in event}
            if len(json.dumps(value, ensure_ascii=False).encode()) > 8192:
                value["arguments"] = {key: str(item)[:160] for key, item in event.get("arguments", {}).items()
                                      if key in {"action", "path", "name", "skill", "document_type", "display_name"}}
            value.update(result=None, error="操作未完成，请核对已有结果。" if event.get("phase") == "error" else None,
                         files=[], embeds=[])
            events.append(value)
        await self.emit("progress", {"kind": "tool_hint" if tool_hint else "progress",
                                    "message": "" if events else content or "", "tool_events": events})

    async def flush(self):
        await self.emit_reasoning_end()

    async def retry_wait(self, _content):
        # Provider error bodies may contain private routing information.
        await self.emit("progress", {"kind": "retry_wait", "message": "模型暂时繁忙，正在重试…"})

    async def before_iteration(self, context):
        if self.authorize is not None:
            await self.authorize()
        self.iteration = context.iteration
        await super().before_iteration(context)

    async def before_execute_tools(self, context):
        if self.authorize is not None:
            await self.authorize()
        await super().before_execute_tools(context)

    async def after_iteration(self, context):
        await self.flush()
        self.last_response = context.response
        current = context.usage.get("context_tokens", context.usage.get("prompt_tokens", 0))
        if isinstance(current, int) and not isinstance(current, bool):
            self.max_context_tokens = max(self.max_context_tokens, current)
        await super().after_iteration(context)
        if not context.tool_calls or len(context.tool_results) == len(context.tool_calls):
            messages = self.runtime.history_for_storage(context.messages) if self.runtime else [m for m in context.messages if m.get("role") != "system"]
            await self.emit("history", {"messages": messages})
            if self.runtime:
                await self.runtime.persist_state(context.messages)


def failure_message(reason: str) -> str:
    return {
        "context_limit": "本轮内容已达到模型上下文上限，已保留编辑进度和已有文件。请分步继续任务。",
        "max_iterations": "本轮已达到执行步数上限，已保留进度。请检查已有结果后继续。",
        "loop_detected": "本轮操作出现重复，已停止继续尝试并保留进度。请检查已有结果后调整要求。",
        "empty_final_response": "模型未返回完整的结束答复，已有编辑进度已保留。请检查已有结果后继续。",
        "tool_error": "本轮有操作未能完成，已有编辑进度已保留。请检查已有结果后继续。",
        "subagent_incomplete": "本轮尚未汇总完子任务结果，已有进度已保留。请检查已有结果后继续。",
    }.get(reason, "模型调用未能完成，已有编辑进度已保留。请稍后继续或联系管理员。")


async def run_turn(config: HostedWorkConfig, payload: dict, sandbox, provider, emit, authorize=None, editor_tools=()) -> dict:
    """External dependencies are supplied; production uses the real runner unchanged."""
    selection = config.models[payload["model_id"]]
    history = payload["history"]
    if not isinstance(history, list) or len(json.dumps(history).encode()) > config.max_history_bytes:
        raise WorkError("history_limit", "会话内容超出本轮限制。")
    tools = HostedTools(sandbox, emit, editor_tools,
                        session_id=payload.get("session_id") if payload.get("desktop_ui") else None,
                        history=history, config=config, metadata=payload.get("metadata"), attachments=payload.get("attachments", []))
    def register(tool):
        tools.registry.register(tool)
        tools.skills.allowed_names.add(tool.name)
        tools.skills.initial_names.add(tool.name)
        allowed = tools.registry.get_allowed_tool_names()
        if allowed is not None:
            tools.registry.set_allowed_tool_names(allowed | {tool.name})

    if payload.get("desktop_ui"):
        from mona.hosted_work.question_tool import build_question_tool
        question = build_question_tool(config, payload, sandbox, emit, tools.pending_delivery_files)
        register(question)
    from mona.hosted_work.context import HostedTurnContext
    from mona.hosted_work.planning import build_planning_tools, prepare_planning_entry
    from mona.session.task_plan import ARTIFACT_TASK_STATE_KEY, reset_task_plan

    runtime = HostedTurnContext(config, payload, tools, provider, emit)
    task_id = payload.get("task_id") or payload["run_id"]
    previous_task = runtime.session.metadata.get(ARTIFACT_TASK_STATE_KEY) or {}
    if not isinstance(previous_task, dict) or previous_task.get("id") != task_id:
        reset_task_plan(runtime.session.metadata, task_id)
    runtime.session.metadata[ARTIFACT_TASK_STATE_KEY] = {"id": task_id}
    entry = await prepare_planning_entry(runtime, payload)
    for tool in build_planning_tools(runtime, payload, emit):
        register(tool)
    from mona.hosted_work.owner_memory import build_memory_tools

    for tool in build_memory_tools(runtime):
        register(tool)
    if entry.reply is not None:
        records = [*history, {"role": "assistant", "content": entry.reply}]
        runtime.session.messages = records
        await emit("delta", {"text": entry.reply})
        await emit("history", {"messages": records})
        await runtime.persist_state()
        return {"status": "completed", "content": entry.reply, "message": "", "usage": {}, "final_usage": {}}
    window = runtime.window
    hook = WorkHook(emit, authorize, payload, runtime)
    from mona.hosted_work.subagent_spec import build_subagent_factory
    from mona.hosted_work.subagents import build_subagent_runtime

    child_factory, child_tools = build_subagent_factory(runtime, payload, sandbox, provider, emit,
        authorize, editor_tools, progress_callback=hook.progress)
    children = build_subagent_runtime(runtime, payload, provider, child_factory)
    register(children.spawn_tool)
    await runtime.prepare()
    messages = runtime.messages
    image_bytes = []
    for attachment in payload.get("attachments", []):
        current = await sandbox.file({"action": "stat", "path": attachment["path"]})
        if current["sha256"] != attachment["sha256"] or current["size"] != attachment["size"]:
            raise WorkError("attachment_changed", "附件已被修改，请重新上传确认后的文件。", 409)
        if Path(attachment["path"]).suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            loaded = await sandbox.file({"action": "download", "path": attachment["path"]})
            data = base64.b64decode(loaded["data"], validate=True)
            if (loaded.get("sha256") != attachment["sha256"] or loaded.get("size") != attachment["size"]
                    or len(data) != attachment["size"] or hashlib.sha256(data).hexdigest() != attachment["sha256"]):
                raise WorkError("attachment_changed", "图片已变化，请重新上传后发送。", 409)
            image_bytes.append({"path": attachment["path"], "data": data})
    if image_bytes:
        from mona.hosted_work.steering_attachments import build_image_content

        messages[-1]["content"] = build_image_content(messages[-1]["content"], image_bytes)
        runtime.session.remember_model_input(history[-1], messages[-1]["content"])
        await runtime.persist_state()
    async def checkpoint(value):
        await emit("checkpoint", value)

    injection = None
    if payload.get("desktop_ui"):
        from mona.hosted_work.remote_inputs import RemoteInputs

        injection = RemoteInputs(config, payload, emit, sandbox=sandbox, runtime=runtime).poll
    injection = children.compose_injections(injection)

    async def flush_deliveries():
        for item in [tools, *child_tools]:
            await item.flush_deliveries()

    try:
        try:
            result = await AgentRunner(provider).run(AgentRunSpec(
            initial_messages=messages, tools=tools.registry, model=selection.model,
            max_iterations=config.max_iterations, max_tool_result_chars=100000,
            max_tokens=selection.max_output_tokens, reasoning_effort=selection.reasoning_effort,
            hook=hook, checkpoint_callback=checkpoint,
            progress_callback=hook.progress,
            retry_wait_callback=hook.retry_wait, injection_callback=injection, strict_injections=True,
            preserve_injection_identity=True,
            context_provider="mona_managed", request_snapshot_callback=runtime.request_snapshot_callback,
            context_limit_callback=runtime.context_limit_callback,
            context_window_tokens=window.tokens, context_window_verified=window.source != "default",
            context_block_limit=selection.context_window_tokens, provider_retry_mode="standard",
            concurrent_tools=True, max_parallel_tool_calls=AgentDefaults().max_parallel_tool_calls, fail_on_tool_error=False,
            llm_timeout_s=config.run_timeout_seconds, enforce_llm_timeout_for_streaming=True,
            session_key=runtime.session.key,
            ))
            if result.stop_reason == "completed":
                await children.wait()
                if children.pending_result_count:
                    result.stop_reason = "subagent_incomplete"
                    while children.pending_result_count:
                        result.messages.extend(await children.injection_callback())
        finally:
            await children.close()
        await hook.flush()
        await emit("history", {"messages": runtime.history_for_storage(result.messages)})
        await runtime.persist_state(result.messages)
        if result.stop_reason == "completed" and not result.error and not any(item.fault for item in [tools, *child_tools]):
            if selection.source != "codex":
                from mona.hosted_work.titles import update_title

                await update_title(runtime, payload, provider, emit)
            await runtime.persist_state()
        # The full execution history is now durable, matching ordinary Work's
        # SAVE boundary. Recovery must not append the last completed call again.
        await emit("checkpoint", {})
        await flush_deliveries()
        if result.final_usage:
            await hook.progress("", token_usage=result.final_usage)
        status = "completed" if result.stop_reason == "completed" and not result.error else "failed"
        fault = next((item.fault for item in [tools, *child_tools] if item.fault), None)
        if fault:
            status = "failed"
            result.stop_reason = "workspace_operation_failed"
        return {"status": status, "content": (result.final_content or "") if status == "completed" else "",
                "message": "" if status == "completed" else fault or failure_message(result.stop_reason),
                "usage": result.usage,
                "final_usage": {**result.final_usage, "context_model": payload["model_id"], "context_provider": "mona_managed"},
                "diagnostic": {"stop_reason": result.stop_reason, "iterations": hook.iteration + 1,
                               "context_window_tokens": window.tokens, "context_window_source": window.source,
                               "max_context_tokens": hook.max_context_tokens,
                               "provider_status": getattr(hook.last_response, "error_status_code", None)}}
    except asyncio.CancelledError:
        await hook.flush()
        await flush_deliveries()
        return {"status": "failed" if tools.fault else "cancelled", "content": "",
                "message": tools.fault or "本轮已停止，已有输出保留。",
                "diagnostic": {"stop_reason": "workspace_operation_failed" if tools.fault else "cancelled",
                               "iterations": hook.iteration + 1, "context_window_tokens": window.tokens,
                               "context_window_source": window.source, "max_context_tokens": hook.max_context_tokens}}


async def execute_payload(config: HostedWorkConfig, payload: dict, emit):
    owner = payload["owner"]
    if not isinstance(owner, str) or not re.fullmatch(r"[a-f0-9]{64}", owner):
        raise ValueError("invalid owner identity")
    home = private_directory(Path(config.state_dir).resolve(strict=True) / "users" / owner)
    with FileLock(str(home / "execution.lock"), timeout=0):
        await _execute_payload(config, payload, emit)


async def _execute_payload(config: HostedWorkConfig, payload: dict, emit):
    owner, run_id = payload["owner"], identifier(payload["run_id"])
    if not isinstance(owner, str) or not re.fullmatch(r"[a-f0-9]{64}", owner):
        raise ValueError("invalid owner identity")
    root = Path(config.state_dir).resolve(strict=True)
    home = private_directory(root / "users" / owner)
    from mona.config.loader import set_config_path
    set_config_path(private_directory(home / "runtime") / "config.json")
    sandbox = DockerSandbox(config, owner, run_id, home / "workspace.zip")
    selected = config.models.get(payload.get("model_id", "")) if payload.get("action") == "turn" else None
    result = {"status": "failed", "content": "", "message": "在线任务未能完成，请核对已有结果。", "workspace_saved": False}
    provider = None
    offered: list[dict] = []
    async def track_event(kind: str, value: dict):
        if kind == "artifact":
            offered.append(value)
        await emit(kind, value)
    stage = "sandbox_start"
    try:
        await sandbox.start()
        if payload["action"] == "turn":
            selection = config.models.get(payload["model_id"])
            if selection is None:
                raise WorkError("invalid_model", "所选模型未开放。")
            empty_cwd = private_directory(root / "engine-cwd" / owner / run_id)
            auth = AuthClient(config)
            async def authorize():
                if await auth.identity(payload["account_token"]) != owner:
                    raise WorkError("account_changed", "账号身份已变化，已停止本轮。", 401)
            stage = "authorization"
            await authorize()
            if selection.source == "codex" and selection.billing_mode == "wallet":
                provider = create_provider(config, selection, empty_cwd,
                                           billing_authorized=payload.get("billing_authorized") is True)
            else:
                provider = create_provider(config, selection, empty_cwd)
            editor_tools = build_editor_tools(config, payload, track_event) if payload.get("desktop_ui") else ()
            stage = "model_run"
            async with asyncio.timeout(config.run_timeout_seconds):
                if editor_tools:
                    result = await run_turn(config, payload, sandbox, provider, track_event, authorize, editor_tools)
                else:
                    result = await run_turn(config, payload, sandbox, provider, track_event, authorize)
        elif payload["action"] in {"upload", "download"}:
            file_result = await sandbox.file(payload["file_request"])
            result = {"status": "completed", "content": "", "message": "", "file": file_result}
        else:
            raise WorkError("invalid_operation", "此操作不可用。")
    except asyncio.CancelledError:
        result.update(status="cancelled", message="本轮已停止，已有输出保留。")
    except Exception as exc:
        result.update(status="failed", message=exc.message if isinstance(exc, WorkError) else "在线任务未能完成，请核对已有结果。")
        result["diagnostic"] = {"stop_reason": "execution_error", "stage": stage,
                                "exception_type": type(exc).__name__}
        if isinstance(exc, WorkError):
            result["error"] = {"code": exc.code, "status": exc.status}
            if exc.code == "file_operation_unknown":
                result["status"] = "unknown"
    finally:
        if provider is not None:
            closer = getattr(provider, "aclose", None) or getattr(provider, "close", None)
            if closer:
                try:
                    async with asyncio.timeout(15):
                        closing = closer()
                        if inspect.isawaitable(closing):
                            await closing
                except Exception as exc:
                    result.update(status="unknown", message="模型执行状态待核对，本轮不会自动重新执行。")
                    result["diagnostic"] = {"stop_reason": "execution_unknown", "stage": "provider_close", "exception_type": type(exc).__name__}
        if selected is not None and selected.source == "codex":
            usage = getattr(provider, "billing_usage", None)
            result["billing_usage"] = usage.snapshot() if usage is not None else {
                "prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0, "complete": provider is None,
            }
            if usage is not None:
                result["billing_issue_codes"] = usage.diagnostics()
        if sandbox.started:
            try:
                await sandbox.save()
                result["workspace_saved"] = True
                verified = []
                for artifact in offered:
                    current = await sandbox.file({"action": "stat", "path": artifact["path"]})
                    if current["sha256"] != artifact["sha256"] or current["size"] != artifact["size"]:
                        raise WorkError("artifact_changed", "交付后文件发生变化，请重新确认并交付。", 409)
                    verified.append(current)
                result["artifacts"] = verified
            except Exception as exc:
                result.update(status="unknown" if result.get("status") == "unknown" else "failed", workspace_saved=False,
                              message="本轮工作区或交付文件未通过保存校验；请勿将本轮文件视为已交付。")
                result["diagnostic"] = {"stop_reason": "workspace_save_failed", "stage": "workspace_save", "exception_type": type(exc).__name__}
        try:
            await sandbox.close()
        except Exception as exc:
            result.update(status="unknown", message="隔离任务尚未确认结束，已阻止后续执行。")
            result["diagnostic"] = {"stop_reason": "execution_unknown", "stage": "sandbox_close", "exception_type": type(exc).__name__}
        if result.get("status") == "completed" and not result.get("workspace_saved"):
            result.update(status="failed", message="工作区未保存，本轮不能报告成功。")
        await emit("result", result)


async def child_main(config: HostedWorkConfig, payload: dict, parent: int):
    from loguru import logger

    # User/model input and credentials must never reach default diagnostic sinks.
    logger.remove()
    if not config.enabled:
        raise WorkError("disabled", "在线 Work 未开启。", 503)
    if os.getppid() != parent:
        raise WorkError("parent_stopped", "任务所属服务已停止，未执行新任务。", 503)

    async def emit(kind: str, value: dict):
        text = json.dumps({"kind": kind, "data": value}, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        sys.stdout.write(text + "\n")
        sys.stdout.flush()

    task = asyncio.create_task(execute_payload(config, payload, emit))
    async def watch_parent():
        while not task.done():
            await asyncio.sleep(1)
            if os.getppid() != parent:
                cancel_once()
                return
    loop = asyncio.get_running_loop()
    def cancel_once():
        if task.cancelling() == 0:
            task.cancel()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, cancel_once)
    watcher = asyncio.create_task(watch_parent())
    try:
        await task
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent-pid", type=int, required=True)
    args = parser.parse_args()
    if sys.platform != "linux":
        raise SystemExit("Hosted Work execution requires Linux; no host fallback is available.")
    raw = sys.stdin.buffer.read(48 * 1024 * 1024 + 1)
    if len(raw) > 48 * 1024 * 1024:
        raise SystemExit("Hosted input exceeds the bounded protocol.")
    envelope = json.loads(raw)
    config = HostedWorkConfig.model_validate(envelope["config"])
    asyncio.run(child_main(config, envelope["payload"], args.parent_pid))


if __name__ == "__main__":
    main()
