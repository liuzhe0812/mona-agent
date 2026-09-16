"""Shared execution loop for tool-using agents."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import re
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from loguru import logger

from mona.agent.hook import AgentHook, AgentHookContext
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.result_compress import compress_tool_result
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.providers.context_window import context_window_from_error
from mona.utils.file_edit_events import (
    StreamingFileEditTracker,
    build_file_edit_end_event,
    build_file_edit_error_event,
    build_file_edit_start_event,
    prepare_file_edit_trackers,
)
from mona.utils.helpers import (
    IncrementalThinkExtractor,
    build_assistant_message,
    estimate_message_tokens,
    estimate_prompt_tokens_chain,
    extract_reasoning,
    find_legal_message_start,
    maybe_persist_tool_result,
    strip_think,
    truncate_text,
)
from mona.utils.progress_events import (
    invoke_file_edit_progress,
    on_progress_accepts_file_edit_events,
)
from mona.utils.prompt_templates import render_template
from mona.utils.runtime import (
    EMPTY_FINAL_RESPONSE_MESSAGE,
    build_finalization_retry_message,
    build_length_recovery_message,
    ensure_nonempty_tool_result,
    is_blank_text,
    repeated_workspace_violation_error,
)

_DEFAULT_ERROR_MESSAGE = "Sorry, I encountered an error calling the AI model."
_PERSISTED_MODEL_ERROR_PLACEHOLDER = "[Assistant reply unavailable due to model error.]"
_MAX_EMPTY_RETRIES = 2
_MAX_LENGTH_RECOVERIES = 3
_MAX_INJECTIONS_PER_TURN = 3
_MAX_INJECTION_CYCLES = 5
_SNIP_SAFETY_BUFFER = 1024
_MICROCOMPACT_KEEP_RECENT = 10
_MICROCOMPACT_MIN_CHARS = 500
_TOOL_REPEAT_WARNING_AT = 3
_TOOL_REPEAT_BLOCK_AT = 5
_POLLING_REPEAT_WARNING_AT = 5
_POLLING_REPEAT_BLOCK_AT = 10
_POLLING_TOOLS = frozenset(
    {"list_exec_sessions", "stock_research_status", "terminal_output", "write_stdin"}
)
_PAGINATION_ARGUMENTS = frozenset({"cursor", "offset", "pages"})
_GENERATED_MEDIA_TOOLS = frozenset({"generate_image", "generate_video"})
_TOOL_REPEAT_WARNING = (
    "Harness notice: this exact tool call returned the same result repeatedly. "
    "Use the existing result, change the arguments, choose another tool, or answer with the limitation."
)
_TOOL_PATH_BLOCKED = (
    "Error: this unchanged tool-call path is blocked for the rest of the current turn. "
    "Change the arguments, use another tool, or answer from the results already collected."
)
_INLINE_CHART_BLOCK_RE = re.compile(r"```chart[ \t]*\r?\n.*?\r?\n```", re.DOTALL | re.IGNORECASE)


def _extract_inline_chart_blocks(result: Any) -> list[str]:
    """Return complete inline chart fences emitted by the chart tool."""
    if not isinstance(result, str):
        return []
    return [match.group(0).strip() for match in _INLINE_CHART_BLOCK_RE.finditer(result)]


def _append_missing_inline_charts(
    content: str | None,
    blocks: list[str],
) -> tuple[str | None, str]:
    """Append chart fences the model omitted and return ``(content, streamed_suffix)``."""
    if not blocks:
        return content, ""
    text = content or ""
    present_count = len(_INLINE_CHART_BLOCK_RE.findall(text))
    missing = blocks[present_count:]
    if not missing:
        return content, ""
    suffix = "\n\n".join(missing)
    separator = "\n\n" if text.strip() else ""
    streamed_suffix = f"{separator}{suffix}"
    return f"{text}{streamed_suffix}", streamed_suffix


def _definition_matches(definition: Any, names: set[str]) -> bool:
    """Return True if a tool definition's name is in ``names``.

    Handles both OpenAI function-calling schema (``{"function": {"name": ...}}``)
    and flat ``{"name": ...}`` shapes defensively.
    """
    if not isinstance(definition, dict):
        return False
    func = definition.get("function")
    if isinstance(func, dict):
        name = func.get("name")
    else:
        name = definition.get("name")
    return isinstance(name, str) and name in names


_COMPACTABLE_TOOLS = frozenset(
    {
        "read_file",
        "exec",
        "grep",
        "find_files",
        "web_search",
        "web_fetch",
        "list_dir",
        "list_exec_sessions",
    }
)
_BACKFILL_CONTENT = "[Tool result unavailable — call was interrupted or lost]"


@dataclass(slots=True)
class AgentRunSpec:
    """Configuration for a single agent execution."""

    initial_messages: list[dict[str, Any]]
    tools: ToolRegistry
    model: str
    max_iterations: int
    max_tool_result_chars: int
    temperature: float | None = None
    max_tokens: int | None = None
    reasoning_effort: str | None = None
    hook: AgentHook | None = None
    error_message: str | None = _DEFAULT_ERROR_MESSAGE
    max_iterations_message: str | None = None
    concurrent_tools: bool = False
    fail_on_tool_error: bool = False
    max_tool_failures: int = 3
    repeat_guard_enabled: bool = False
    workspace: Path | None = None
    session_key: str | None = None
    context_window_tokens: int | None = None
    context_block_limit: int | None = None
    provider_retry_mode: str = "standard"
    progress_callback: Any | None = None
    stream_progress_deltas: bool = True
    retry_wait_callback: Any | None = None
    checkpoint_callback: Any | None = None
    injection_callback: Any | None = None
    llm_timeout_s: float | None = None
    enforce_llm_timeout_for_streaming: bool = False


@dataclass(slots=True)
class AgentRunResult:
    """Outcome of a shared agent execution."""

    final_content: str | None
    messages: list[dict[str, Any]]
    tools_used: list[str] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    """Cumulative usage across every LLM call in this run (billing view)."""
    final_usage: dict[str, int] = field(default_factory=dict)
    """Usage of the last single LLM call; its ``prompt_tokens`` mirrors the
    context actually sent to the model (context-window view)."""
    stop_reason: str = "completed"
    error: str | None = None
    detected_context_window_tokens: int | None = None
    tool_events: list[dict[str, str]] = field(default_factory=list)
    had_injections: bool = False


class AgentRunner:
    """Run a tool-capable LLM loop without product-layer concerns."""

    def __init__(self, provider: LLMProvider):
        self.provider = provider

    @staticmethod
    def _generated_media_outputs(result: Any) -> list[dict[str, Any]]:
        payload = result if isinstance(result, dict) else None
        if payload is None and isinstance(result, str):
            try:
                payload, _ = json.JSONDecoder().raw_decode(result.lstrip())
            except (TypeError, ValueError, json.JSONDecodeError):
                return []
        if not isinstance(payload, dict):
            return []
        artifacts = payload.get("artifacts") or payload.get("output_files") or []
        if not isinstance(artifacts, list):
            return []
        outputs: list[dict[str, Any]] = []
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            path = artifact.get("path") or artifact.get("local_path") or artifact.get("saved_to")
            if (
                isinstance(path, str)
                and path
                and all(existing.get("path") != path for existing in outputs)
            ):
                outputs.append({**artifact, "path": path})
        return outputs

    async def _register_generated_media(
        self,
        spec: AgentRunSpec,
        tool_name: str,
        tool_call_id: str,
        result: Any,
    ) -> None:
        if tool_name not in _GENERATED_MEDIA_TOOLS:
            return
        outputs = self._generated_media_outputs(result)
        if not outputs:
            return
        try:
            deliver_file = spec.tools.get("deliver_file")
            if deliver_file is None:
                logger.warning(
                    "Generated media could not be registered: deliver_file is unavailable"
                )
                return
            source_ids = [
                str(output.get("id") or f"{tool_call_id}:{index}")
                for index, output in enumerate(outputs)
            ]
            delivery = await deliver_file.execute(
                paths=[str(output["path"]) for output in outputs],
                _artifact_source_ids=source_ids,
            )
            if isinstance(delivery, str) and delivery.startswith("Error"):
                logger.warning("Generated media could not be registered: {}", delivery)
        except Exception:
            logger.exception("Generated media registration failed")

    @staticmethod
    def _merge_message_content(left: Any, right: Any) -> str | list[dict[str, Any]]:
        if isinstance(left, str) and isinstance(right, str):
            return f"{left}\n\n{right}" if left else right

        def _to_blocks(value: Any) -> list[dict[str, Any]]:
            if isinstance(value, list):
                return [
                    item if isinstance(item, dict) else {"type": "text", "text": str(item)}
                    for item in value
                ]
            if value is None:
                return []
            return [{"type": "text", "text": str(value)}]

        return _to_blocks(left) + _to_blocks(right)

    @classmethod
    def _append_injected_messages(
        cls,
        messages: list[dict[str, Any]],
        injections: list[dict[str, Any]],
    ) -> None:
        """Append injected user messages while preserving role alternation."""
        for injection in injections:
            if messages and injection.get("role") == "user" and messages[-1].get("role") == "user":
                merged = dict(messages[-1])
                merged["content"] = cls._merge_message_content(
                    merged.get("content"),
                    injection.get("content"),
                )
                messages[-1] = merged
                continue
            messages.append(injection)

    async def _try_drain_injections(
        self,
        spec: AgentRunSpec,
        messages: list[dict[str, Any]],
        assistant_message: dict[str, Any] | None,
        injection_cycles: int,
        *,
        phase: str = "after error",
        iteration: int | None = None,
    ) -> tuple[bool, int]:
        """Drain pending injections. Returns (should_continue, updated_cycles).

        If injections are found and we haven't exceeded _MAX_INJECTION_CYCLES,
        append them to *messages* (and emit a checkpoint if *assistant_message*
        and *iteration* are both provided) and return (True, cycles+1) so the
        caller continues the iteration loop.  Otherwise return (False, cycles).
        """
        if injection_cycles >= _MAX_INJECTION_CYCLES:
            return False, injection_cycles
        injections = await self._drain_injections(spec)
        if not injections:
            return False, injection_cycles
        injection_cycles += 1
        if assistant_message is not None:
            messages.append(assistant_message)
            if iteration is not None:
                await self._emit_checkpoint(
                    spec,
                    {
                        "phase": "final_response",
                        "iteration": iteration,
                        "model": spec.model,
                        "assistant_message": assistant_message,
                        "completed_tool_results": [],
                        "pending_tool_calls": [],
                    },
                )
        self._append_injected_messages(messages, injections)
        logger.debug(
            "Injected {} follow-up message(s) {} ({}/{})",
            len(injections),
            phase,
            injection_cycles,
            _MAX_INJECTION_CYCLES,
        )
        return True, injection_cycles

    async def _drain_injections(self, spec: AgentRunSpec) -> list[dict[str, Any]]:
        """Drain pending user messages via the injection callback.

        Returns normalized user messages (capped by
        ``_MAX_INJECTIONS_PER_TURN``), or an empty list when there is
        nothing to inject. Messages beyond the cap are logged so they
        are not silently lost.
        """
        if spec.injection_callback is None:
            return []
        try:
            signature = inspect.signature(spec.injection_callback)
            accepts_limit = "limit" in signature.parameters or any(
                parameter.kind is inspect.Parameter.VAR_KEYWORD
                for parameter in signature.parameters.values()
            )
            if accepts_limit:
                items = await spec.injection_callback(limit=_MAX_INJECTIONS_PER_TURN)
            else:
                items = await spec.injection_callback()
        except Exception:
            logger.exception("injection_callback failed")
            return []
        if not items:
            return []
        injected_messages: list[dict[str, Any]] = []
        for item in items:
            if isinstance(item, dict) and item.get("role") == "user" and "content" in item:
                injected_messages.append(item)
                continue
            text = getattr(item, "content", str(item))
            if text.strip():
                injected_messages.append({"role": "user", "content": text})
        if len(injected_messages) > _MAX_INJECTIONS_PER_TURN:
            dropped = len(injected_messages) - _MAX_INJECTIONS_PER_TURN
            logger.warning(
                "Injection callback returned {} messages, capping to {} ({} dropped)",
                len(injected_messages),
                _MAX_INJECTIONS_PER_TURN,
                dropped,
            )
            injected_messages = injected_messages[:_MAX_INJECTIONS_PER_TURN]
        return injected_messages

    async def run(self, spec: AgentRunSpec) -> AgentRunResult:
        hook = spec.hook or AgentHook()
        messages = list(spec.initial_messages)
        final_content: str | None = None
        tools_used: list[str] = []
        usage: dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0}
        raw_usage: dict[str, int] = {}
        error: str | None = None
        detected_context_window_tokens: int | None = None
        stop_reason = "completed"
        tool_events: list[dict[str, str]] = []
        workspace_violation_counts: dict[str, int] = {}
        # Per-turn consecutive-failure counter for tool circuit-breaking.
        tool_failure_counts: dict[str, int] = {}
        disabled_tools: set[str] = set()
        last_tool_step_signature: str | None = None
        repeated_tool_step_count = 0
        blocked_tool_call_signature: str | None = None
        office_edit_failures: dict[str, int] = {}
        blocked_office_edits: set[str] = set()
        inline_chart_blocks: list[str] = []
        empty_content_retries = 0
        length_recovery_count = 0
        had_injections = False
        injection_cycles = 0

        def reset_repeat_guard() -> None:
            nonlocal last_tool_step_signature
            nonlocal repeated_tool_step_count
            nonlocal blocked_tool_call_signature
            last_tool_step_signature = None
            repeated_tool_step_count = 0
            blocked_tool_call_signature = None
            office_edit_failures.clear()
            blocked_office_edits.clear()

        for iteration in range(spec.max_iterations):
            try:
                # Keep the persisted conversation untouched. Context governance
                # may repair or compact historical messages for the model, but
                # those synthetic edits must not shift the append boundary used
                # later when the caller saves only the new turn.
                messages_for_model = self._drop_orphan_tool_results(messages)
                messages_for_model = self._backfill_missing_tool_results(messages_for_model)
                messages_for_model = self._microcompact(messages_for_model)
                messages_for_model = self._apply_tool_result_budget(spec, messages_for_model)
                messages_for_model = self._snip_history(spec, messages_for_model)
                # Snipping may have created new orphans; clean them up.
                messages_for_model = self._drop_orphan_tool_results(messages_for_model)
                messages_for_model = self._backfill_missing_tool_results(messages_for_model)
            except Exception:
                logger.exception(
                    "Context governance failed on turn {} for {}; applying minimal repair",
                    iteration,
                    spec.session_key or "default",
                )
                try:
                    messages_for_model = self._drop_orphan_tool_results(messages)
                    messages_for_model = self._backfill_missing_tool_results(messages_for_model)
                except Exception:
                    messages_for_model = messages
            if not self._fits_context_budget(spec, messages_for_model):
                final_content = "当前请求内容超出模型可用上下文，已保留已完成进度。请缩短输入或新开会话后重试。"
                error = final_content
                stop_reason = "context_limit"
                self._append_final_message(messages, final_content)
                break
            context = AgentHookContext(iteration=iteration, messages=messages)
            await hook.before_iteration(context)
            response = await self._request_model(
                spec,
                messages_for_model,
                hook,
                context,
                disabled_tools=disabled_tools or None,
            )
            raw_usage = self._usage_dict(response.usage)
            context.response = response
            context.usage = dict(raw_usage)
            context.tool_calls = list(response.tool_calls)
            self._accumulate_usage(usage, raw_usage)

            reasoning_text, cleaned_content = extract_reasoning(
                response.reasoning_content,
                response.thinking_blocks,
                response.content,
            )
            response.content = cleaned_content
            if reasoning_text and not context.streamed_reasoning:
                await hook.emit_reasoning(reasoning_text)
                await hook.emit_reasoning_end()
                context.streamed_reasoning = True

            if response.should_execute_tools:
                context.tool_calls = list(response.tool_calls)
                if hook.wants_streaming():
                    await hook.on_stream_end(context, resuming=True)

                from mona.agent.tool_privacy import redact_persisted_tool_call

                persisted_tool_calls = [
                    redact_persisted_tool_call(tc.to_openai_tool_call())
                    for tc in response.tool_calls
                ]
                assistant_message = build_assistant_message(
                    response.content or "",
                    tool_calls=persisted_tool_calls,
                    reasoning_content=response.reasoning_content,
                    thinking_blocks=response.thinking_blocks,
                )
                messages.append(assistant_message)
                tools_used.extend(tc.name for tc in response.tool_calls)
                await self._emit_checkpoint(
                    spec,
                    {
                        "phase": "awaiting_tools",
                        "iteration": iteration,
                        "model": spec.model,
                        "assistant_message": assistant_message,
                        "completed_tool_results": [],
                        "pending_tool_calls": persisted_tool_calls,
                    },
                )

                await hook.before_execute_tools(context)

                partial_results: dict[str, dict[str, Any]] = {}

                async def checkpoint_completed(call: ToolCallRequest, value: Any) -> None:
                    partial_results[call.id] = {
                        "role": "tool", "tool_call_id": call.id, "name": call.name,
                        "content": self._normalize_tool_result(spec, call.id, call.name, value),
                    }
                    await self._emit_checkpoint(spec, {
                        "phase": "tools_partial", "iteration": iteration, "model": spec.model,
                        "assistant_message": assistant_message,
                        "completed_tool_results": [partial_results[tc.id] for tc in response.tool_calls if tc.id in partial_results],
                        "pending_tool_calls": [tc for tc in persisted_tool_calls if tc["id"] not in partial_results],
                    })

                results, new_events, fatal_error = await self._execute_tools(
                    spec,
                    response.tool_calls,
                    workspace_violation_counts,
                    disabled_tools=disabled_tools,
                    blocked_tool_call_signature=(
                        blocked_tool_call_signature if spec.repeat_guard_enabled else None
                    ),
                    blocked_office_edits=blocked_office_edits,
                    checkpoint_completed=checkpoint_completed if spec.checkpoint_callback else None,
                )
                tool_events.extend(new_events)
                context.tool_results = list(results)
                context.tool_events = list(new_events)
                self._update_failure_counts(
                    tool_failure_counts,
                    disabled_tools,
                    response.tool_calls,
                    new_events,
                    spec=spec,
                )
                completed_tool_results: list[dict[str, Any]] = []
                for tool_call, result, event in zip(response.tool_calls, results, new_events):
                    if tool_call.name == "chart":
                        for block in _extract_inline_chart_blocks(result):
                            if block not in inline_chart_blocks:
                                inline_chart_blocks.append(block)
                    normalized_result = self._normalize_tool_result(
                        spec,
                        tool_call.id,
                        tool_call.name,
                        result,
                    )
                    edit_key = self._office_edit_key(tool_call)
                    receipt = self._structured_tool_receipt(result)
                    if spec.repeat_guard_enabled and edit_key and receipt:
                        conflict = isinstance(receipt.get("error"), dict) and receipt["error"].get("code") == "VERSION_CONFLICT"
                        if conflict or (receipt.get("ok") is True and receipt.get("unchanged") is not True):
                            office_edit_failures.pop(edit_key, None)
                            blocked_office_edits.discard(edit_key)
                        elif receipt.get("ok") is False or receipt.get("unchanged") is True:
                            count = office_edit_failures.get(edit_key, 0) + 1
                            office_edit_failures[edit_key] = count
                            if count == _TOOL_REPEAT_WARNING_AT:
                                normalized_result = self._append_tool_guidance(normalized_result,
                                    "Office edits to this target have made no progress. Read the supported fields and exact skill example; stop guessing property names.")
                            elif count >= _TOOL_REPEAT_BLOCK_AT:
                                blocked_office_edits.add(edit_key)
                                normalized_result = self._append_tool_guidance(normalized_result,
                                    "Further edits to this target are paused for this turn. Inspection remains available; explain the limitation using the actual errors.")
                    if spec.repeat_guard_enabled and event.get("detail") != "repeating tool path blocked":
                        step_signature = self._tool_step_signature(tool_call, result)
                        if step_signature == last_tool_step_signature:
                            repeated_tool_step_count += 1
                        else:
                            last_tool_step_signature = step_signature
                            repeated_tool_step_count = 1
                            blocked_tool_call_signature = None
                        warning_at, block_at = self._tool_repeat_thresholds(tool_call)
                        if repeated_tool_step_count == warning_at:
                            normalized_result = self._append_tool_guidance(
                                normalized_result,
                                _TOOL_REPEAT_WARNING,
                            )
                        elif repeated_tool_step_count == block_at:
                            blocked_tool_call_signature = self._tool_call_signature(tool_call)
                            normalized_result = self._append_tool_guidance(
                                normalized_result,
                                _TOOL_PATH_BLOCKED,
                            )
                            logger.warning(
                                "Blocked repeating tool path for {} after {} unchanged results: {}",
                                spec.session_key or "default",
                                repeated_tool_step_count,
                                tool_call.name,
                            )
                    tool_message = {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": tool_call.name,
                        "content": normalized_result,
                    }
                    messages.append(tool_message)
                    completed_tool_results.append(tool_message)
                if fatal_error is not None:
                    error = f"Error: {type(fatal_error).__name__}: {fatal_error}"
                    final_content = error
                    stop_reason = "tool_error"
                    self._append_final_message(messages, final_content)
                    context.final_content = final_content
                    context.error = error
                    context.stop_reason = stop_reason
                    await hook.after_iteration(context)
                    should_continue, injection_cycles = await self._try_drain_injections(
                        spec,
                        messages,
                        None,
                        injection_cycles,
                        phase="after tool error",
                    )
                    if should_continue:
                        had_injections = True
                        reset_repeat_guard()
                        continue
                    break
                await self._emit_checkpoint(
                    spec,
                    {
                        "phase": "tools_completed",
                        "iteration": iteration,
                        "model": spec.model,
                        "assistant_message": assistant_message,
                        "completed_tool_results": completed_tool_results,
                        "pending_tool_calls": [],
                    },
                )
                empty_content_retries = 0
                length_recovery_count = 0
                # Checkpoint 1: drain injections after tools, before next LLM call
                _drained, injection_cycles = await self._try_drain_injections(
                    spec,
                    messages,
                    None,
                    injection_cycles,
                    phase="after tool execution",
                )
                if _drained:
                    had_injections = True
                    reset_repeat_guard()
                await hook.after_iteration(context)
                continue

            if response.has_tool_calls:
                logger.warning(
                    "Ignoring tool calls under finish_reason='{}' for {}",
                    response.finish_reason,
                    spec.session_key or "default",
                )

            clean = hook.finalize_content(context, response.content)
            if response.finish_reason != "error" and is_blank_text(clean):
                empty_content_retries += 1
                if empty_content_retries < _MAX_EMPTY_RETRIES:
                    logger.warning(
                        "Empty response on turn {} for {} ({}/{}); retrying",
                        iteration,
                        spec.session_key or "default",
                        empty_content_retries,
                        _MAX_EMPTY_RETRIES,
                    )
                    if hook.wants_streaming():
                        await hook.on_stream_end(context, resuming=False)
                    await hook.after_iteration(context)
                    continue
                logger.warning(
                    "Empty response on turn {} for {} after {} retries; attempting finalization",
                    iteration,
                    spec.session_key or "default",
                    empty_content_retries,
                )
                if hook.wants_streaming():
                    await hook.on_stream_end(context, resuming=False)
                response = await self._request_finalization_retry(spec, messages_for_model)
                retry_usage = self._usage_dict(response.usage)
                self._accumulate_usage(usage, retry_usage)
                raw_usage = self._merge_usage(raw_usage, retry_usage)
                context.response = response
                context.usage = dict(raw_usage)
                context.tool_calls = list(response.tool_calls)
                clean = hook.finalize_content(context, response.content)

            if response.finish_reason == "length" and not is_blank_text(clean):
                length_recovery_count += 1
                if length_recovery_count <= _MAX_LENGTH_RECOVERIES:
                    logger.info(
                        "Output truncated on turn {} for {} ({}/{}); continuing",
                        iteration,
                        spec.session_key or "default",
                        length_recovery_count,
                        _MAX_LENGTH_RECOVERIES,
                    )
                    if hook.wants_streaming():
                        await hook.on_stream_end(context, resuming=True)
                    messages.append(
                        build_assistant_message(
                            clean,
                            reasoning_content=response.reasoning_content,
                            thinking_blocks=response.thinking_blocks,
                        )
                    )
                    messages.append(build_length_recovery_message())
                    await hook.after_iteration(context)
                    continue

            clean, chart_suffix = _append_missing_inline_charts(clean, inline_chart_blocks)
            if chart_suffix and hook.wants_streaming():
                context.streamed_content = True
                await hook.on_stream(context, chart_suffix)

            assistant_message: dict[str, Any] | None = None
            if response.finish_reason != "error" and not is_blank_text(clean):
                assistant_message = build_assistant_message(
                    clean,
                    reasoning_content=response.reasoning_content,
                    thinking_blocks=response.thinking_blocks,
                )

            # Check for mid-turn injections BEFORE signaling stream end.
            # If injections are found we keep the stream alive (resuming=True)
            # so streaming channels don't prematurely finalize the card.
            should_continue, injection_cycles = await self._try_drain_injections(
                spec,
                messages,
                assistant_message,
                injection_cycles,
                phase="after final response",
                iteration=iteration,
            )
            if should_continue:
                had_injections = True
                reset_repeat_guard()

            if hook.wants_streaming():
                await hook.on_stream_end(context, resuming=should_continue)

            if should_continue:
                await hook.after_iteration(context)
                continue

            if response.finish_reason == "error":
                detected_context_window_tokens = context_window_from_error(
                    response.content,
                    response.error_type,
                    response.error_code,
                )
                if detected_context_window_tokens is not None:
                    final_content = (
                        "模型返回的上下文容量小于当前估算值。"
                        "已保留会话并准备按实际容量重新整理上下文。"
                    )
                    stop_reason = "context_limit"
                else:
                    final_content = clean or spec.error_message or _DEFAULT_ERROR_MESSAGE
                    stop_reason = "error"
                error = final_content
                self._append_model_error_placeholder(messages)
                context.final_content = final_content
                context.error = error
                context.stop_reason = stop_reason
                await hook.after_iteration(context)
                should_continue, injection_cycles = await self._try_drain_injections(
                    spec,
                    messages,
                    None,
                    injection_cycles,
                    phase="after LLM error",
                )
                if should_continue:
                    had_injections = True
                    reset_repeat_guard()
                    continue
                break
            if is_blank_text(clean):
                final_content = EMPTY_FINAL_RESPONSE_MESSAGE
                stop_reason = "empty_final_response"
                error = final_content
                self._append_final_message(messages, final_content)
                context.final_content = final_content
                context.error = error
                context.stop_reason = stop_reason
                await hook.after_iteration(context)
                should_continue, injection_cycles = await self._try_drain_injections(
                    spec,
                    messages,
                    None,
                    injection_cycles,
                    phase="after empty response",
                )
                if should_continue:
                    had_injections = True
                    reset_repeat_guard()
                    continue
                break

            messages.append(
                assistant_message
                or build_assistant_message(
                    clean,
                    reasoning_content=response.reasoning_content,
                    thinking_blocks=response.thinking_blocks,
                )
            )
            await self._emit_checkpoint(
                spec,
                {
                    "phase": "final_response",
                    "iteration": iteration,
                    "model": spec.model,
                    "assistant_message": messages[-1],
                    "completed_tool_results": [],
                    "pending_tool_calls": [],
                },
            )
            final_content = clean
            context.final_content = final_content
            context.stop_reason = stop_reason
            await hook.after_iteration(context)
            break
        else:
            stop_reason = "max_iterations"
            fallback_content = (
                spec.max_iterations_message.format(max_iterations=spec.max_iterations)
                if spec.max_iterations_message
                else render_template(
                    "agent/max_iterations_message.md",
                    strip=True,
                    max_iterations=spec.max_iterations,
                )
            )
            final_content, finalization_usage = await self._finalize_without_tools(
                spec,
                messages,
            )
            self._accumulate_usage(usage, finalization_usage)
            final_content = final_content or fallback_content
            self._append_final_message(messages, final_content)
            # Drain any remaining injections so they are appended to the
            # conversation history instead of being re-published as
            # independent inbound messages by _dispatch's finally block.
            # We ignore should_continue here because the for-loop has already
            # exhausted all iterations.
            drained_after_max_iterations, injection_cycles = await self._try_drain_injections(
                spec,
                messages,
                None,
                injection_cycles,
                phase="after max_iterations",
            )
            if drained_after_max_iterations:
                had_injections = True

        return AgentRunResult(
            final_content=final_content,
            messages=messages,
            tools_used=tools_used,
            usage=usage,
            final_usage=dict(raw_usage),
            stop_reason=stop_reason,
            error=error,
            detected_context_window_tokens=detected_context_window_tokens,
            tool_events=tool_events,
            had_injections=had_injections,
        )

    def _build_request_kwargs(
        self,
        spec: AgentRunSpec,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "messages": messages,
            "tools": tools,
            "model": spec.model,
            "retry_mode": spec.provider_retry_mode,
            "on_retry_wait": spec.retry_wait_callback,
        }
        if spec.temperature is not None:
            kwargs["temperature"] = spec.temperature
        if spec.max_tokens is not None:
            kwargs["max_tokens"] = spec.max_tokens
        if spec.reasoning_effort is not None:
            kwargs["reasoning_effort"] = spec.reasoning_effort
        return kwargs

    async def _request_model(
        self,
        spec: AgentRunSpec,
        messages: list[dict[str, Any]],
        hook: AgentHook,
        context: AgentHookContext,
        *,
        disabled_tools: set[str] | None = None,
    ):
        timeout_s: float | None = spec.llm_timeout_s
        if timeout_s is None:
            # Default to a finite timeout to avoid per-session lock starvation when an LLM
            # request hangs indefinitely (e.g. gateway/network stall).
            # Set mona_LLM_TIMEOUT_S=0 to disable.
            raw = os.environ.get("mona_LLM_TIMEOUT_S", "300").strip()
            try:
                timeout_s = float(raw)
            except (TypeError, ValueError):
                timeout_s = 300.0
        if timeout_s is not None and timeout_s <= 0:
            timeout_s = None

        tool_defs = spec.tools.get_definitions()
        if disabled_tools:
            tool_defs = [d for d in tool_defs if not _definition_matches(d, disabled_tools)]
        kwargs = self._build_request_kwargs(
            spec,
            messages,
            tools=tool_defs,
        )
        wants_streaming = hook.wants_streaming()
        wants_progress_streaming = (
            not wants_streaming
            and spec.stream_progress_deltas
            and spec.progress_callback is not None
            and getattr(self.provider, "supports_progress_deltas", False) is True
        )

        progress_state: dict[str, bool] | None = None
        live_file_edits: StreamingFileEditTracker | None = None

        if spec.progress_callback is not None and on_progress_accepts_file_edit_events(
            spec.progress_callback
        ):

            async def _emit_live_file_edits(events: list[dict[str, Any]]) -> None:
                await invoke_file_edit_progress(spec.progress_callback, events)

            live_file_edits = StreamingFileEditTracker(
                workspace=spec.workspace,
                tools=spec.tools,
                emit=_emit_live_file_edits,
            )

        async def _tool_call_delta(delta: dict[str, Any]) -> None:
            if live_file_edits is not None:
                await live_file_edits.update(delta)

        if wants_streaming:

            async def _stream(delta: str) -> None:
                if delta:
                    context.streamed_content = True
                await hook.on_stream(context, delta)

            async def _thinking(delta: str) -> None:
                if not delta:
                    return
                context.streamed_reasoning = True
                await hook.emit_reasoning(delta)

            coro = self.provider.chat_stream_with_retry(
                **kwargs,
                on_content_delta=_stream,
                on_thinking_delta=_thinking,
                on_tool_call_delta=_tool_call_delta if live_file_edits is not None else None,
            )
        elif wants_progress_streaming:
            stream_buf = ""
            think_extractor = IncrementalThinkExtractor()
            progress_state = {"reasoning_open": False}

            async def _stream_progress(delta: str) -> None:
                nonlocal stream_buf
                if not delta:
                    return
                prev_clean = strip_think(stream_buf)
                stream_buf += delta
                new_clean = strip_think(stream_buf)
                incremental = new_clean[len(prev_clean) :]

                if await think_extractor.feed(stream_buf, hook.emit_reasoning):
                    context.streamed_reasoning = True
                    progress_state["reasoning_open"] = True

                if incremental:
                    if progress_state["reasoning_open"]:
                        await hook.emit_reasoning_end()
                        progress_state["reasoning_open"] = False
                    context.streamed_content = True
                    await spec.progress_callback(incremental)

            coro = self.provider.chat_stream_with_retry(
                **kwargs,
                on_content_delta=_stream_progress,
                on_tool_call_delta=_tool_call_delta if live_file_edits is not None else None,
            )
        else:
            coro = self.provider.chat_with_retry(**kwargs)

        # Regular streaming requests rely on provider-level idle timeouts
        # (mona_STREAM_IDLE_TIMEOUT_S), so healthy long reasoning streams are
        # not killed just because total elapsed time exceeded mona_LLM_TIMEOUT_S.
        # Workflow steps opt into a finite per-call wall-clock cap as well.
        is_streaming = wants_streaming or wants_progress_streaming
        outer_timeout_s = (
            None if is_streaming and not spec.enforce_llm_timeout_for_streaming else timeout_s
        )
        try:
            response = (
                await coro
                if outer_timeout_s is None
                else await asyncio.wait_for(coro, timeout=outer_timeout_s)
            )
            if live_file_edits is not None:
                await live_file_edits.flush()
                if response.should_execute_tools:
                    live_file_edits.apply_final_call_ids(response.tool_calls)
                await live_file_edits.error_unmatched(
                    response.tool_calls if response.should_execute_tools else [],
                    "Tool call did not complete.",
                )
        except asyncio.TimeoutError:
            if outer_timeout_s is None:
                return LLMResponse(
                    content="Error calling LLM: stream stalled",
                    finish_reason="error",
                    error_kind="timeout",
                )
            return LLMResponse(
                content=f"Error calling LLM: timed out after {outer_timeout_s:g}s",
                finish_reason="error",
                error_kind="timeout",
            )
        if progress_state and progress_state.get("reasoning_open"):
            await hook.emit_reasoning_end()
        return response

    async def _request_finalization_retry(
        self,
        spec: AgentRunSpec,
        messages: list[dict[str, Any]],
    ):
        retry_messages = list(messages)
        retry_messages.append(build_finalization_retry_message())
        kwargs = self._build_request_kwargs(spec, retry_messages, tools=None)
        return await self.provider.chat_with_retry(**kwargs)

    async def _finalize_without_tools(
        self,
        spec: AgentRunSpec,
        messages: list[dict[str, Any]],
    ) -> tuple[str | None, dict[str, int]]:
        try:
            response = await self._request_finalization_retry(
                spec,
                self._snip_history(spec, self._microcompact(messages)),
            )
            usage = self._usage_dict(response.usage)
            _, clean = extract_reasoning(
                response.reasoning_content,
                response.thinking_blocks,
                response.content,
            )
            if (
                response.finish_reason != "error"
                and not response.has_tool_calls
                and not is_blank_text(clean)
            ):
                return clean, usage
            return None, usage
        except Exception:
            logger.exception(
                "Tool-free finalization failed for {}",
                spec.session_key or "default",
            )
            return None, {}

    @staticmethod
    def _structured_tool_receipt(result: Any) -> dict[str, Any] | None:
        if isinstance(result, dict):
            return result
        if isinstance(result, str):
            try:
                parsed = json.loads(result)
                return parsed if isinstance(parsed, dict) else None
            except (ValueError, TypeError):
                return None
        return None

    @staticmethod
    def _office_edit_key(call: ToolCallRequest) -> str | None:
        if call.name != "office" or call.arguments.get("action") not in {"apply", "batch"}:
            return None
        ops = call.arguments.get("operations")
        if isinstance(ops, str):
            try:
                ops = json.loads(ops)
            except ValueError:
                return None
        targets: set[str] = set()
        for operation in ops if isinstance(ops, list) else []:
            if not isinstance(operation, dict):
                continue
            payload = operation.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            if operation.get("op") == "slide_apply_txn":
                for op in payload.get("ops") or []:
                    target = op.get("target", {}) if isinstance(op, dict) else {}
                    targets.add(json.dumps(target, sort_keys=True, default=str))
            else:
                target = {key: payload[key] for key in
                    ("blockId", "sheet", "range", "cell") if key in payload}
                if "slideId" in payload:
                    target["slide"] = payload["slideId"]
                if "elementId" in payload:
                    target["el"] = payload["elementId"]
                targets.add(json.dumps(target, sort_keys=True))
        return json.dumps([call.arguments.get("session_id"), sorted(targets)]) if targets else None

    @staticmethod
    def _tool_step_signature(tool_call: ToolCallRequest, result: Any) -> str:
        payload = json.dumps(
            [tool_call.name, tool_call.arguments, result],
            sort_keys=True,
            ensure_ascii=False,
            default=str,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode()).hexdigest()

    @staticmethod
    def _tool_call_signature(tool_call: ToolCallRequest) -> str:
        payload = json.dumps(
            [tool_call.name, tool_call.arguments],
            sort_keys=True,
            ensure_ascii=False,
            default=str,
            separators=(",", ":"),
        )
        return hashlib.sha256(payload.encode()).hexdigest()

    @staticmethod
    def _tool_repeat_thresholds(tool_call: ToolCallRequest) -> tuple[int, int]:
        is_polling = tool_call.name in _POLLING_TOOLS or (
            tool_call.name == "scientific_tool"
            and str(tool_call.arguments.get("action") or "").lower() == "status"
        )
        is_pagination = any(key in tool_call.arguments for key in _PAGINATION_ARGUMENTS)
        if is_polling or is_pagination:
            return _POLLING_REPEAT_WARNING_AT, _POLLING_REPEAT_BLOCK_AT
        return _TOOL_REPEAT_WARNING_AT, _TOOL_REPEAT_BLOCK_AT

    @staticmethod
    def _append_tool_guidance(content: Any, guidance: str) -> Any:
        marker = f"[{guidance}]"
        if isinstance(content, str):
            return f"{content}\n\n{marker}"
        if isinstance(content, list):
            return [*content, {"type": "text", "text": marker}]
        return f"{json.dumps(content, ensure_ascii=False, default=str)}\n\n{marker}"

    @staticmethod
    def _usage_dict(usage: dict[str, Any] | None) -> dict[str, int]:
        if not usage:
            return {}
        result: dict[str, int] = {}
        for key, value in usage.items():
            try:
                result[key] = int(value or 0)
            except (TypeError, ValueError):
                continue
        return result

    @staticmethod
    def _accumulate_usage(target: dict[str, int], addition: dict[str, int]) -> None:
        for key, value in addition.items():
            target[key] = target.get(key, 0) + value

    @staticmethod
    def _merge_usage(left: dict[str, int], right: dict[str, int]) -> dict[str, int]:
        merged = dict(left)
        for key, value in right.items():
            merged[key] = merged.get(key, 0) + value
        return merged

    async def _execute_tools(
        self,
        spec: AgentRunSpec,
        tool_calls: list[ToolCallRequest],
        workspace_violation_counts: dict[str, int],
        *,
        disabled_tools: set[str] | None = None,
        blocked_tool_call_signature: str | None = None,
        blocked_office_edits: set[str] | None = None,
        checkpoint_completed: Any | None = None,
    ) -> tuple[list[Any], list[dict[str, str]], BaseException | None]:
        batches = self._partition_tool_batches(spec, tool_calls)
        tool_results: list[tuple[Any, dict[str, str], BaseException | None]] = []
        async def execute(call: ToolCallRequest):
            outcome = await self._run_tool(
                spec, call, workspace_violation_counts,
                disabled_tools=disabled_tools,
                blocked_tool_call_signature=blocked_tool_call_signature,
                blocked_office_edits=blocked_office_edits,
            )
            if checkpoint_completed is not None:
                await checkpoint_completed(call, outcome[0])
            return outcome

        for batch in batches:
            if spec.concurrent_tools and len(batch) > 1:
                batch_results = await asyncio.gather(
                    *(
                        execute(tool_call)
                        for tool_call in batch
                    )
                )
                tool_results.extend(batch_results)
            else:
                batch_results = []
                for tool_call in batch:
                    result = await execute(tool_call)
                    tool_results.append(result)
                    batch_results.append(result)

        results: list[Any] = []
        events: list[dict[str, str]] = []
        fatal_error: BaseException | None = None
        for result, event, error in tool_results:
            results.append(result)
            events.append(event)
            if error is not None and fatal_error is None:
                fatal_error = error
        return results, events, fatal_error

    @staticmethod
    def _update_failure_counts(
        failure_counts: dict[str, int],
        disabled: set[str],
        tool_calls: list[ToolCallRequest],
        events: list[dict[str, str]],
        *,
        spec: AgentRunSpec,
    ) -> None:
        """Track consecutive tool failures and circuit-break repeat offenders.

        A tool that returns an error event increments its counter; a success
        resets it. When the counter reaches ``spec.max_tool_failures`` the tool
        is added to ``disabled`` for the rest of this turn so the model can no
        longer see it and must pick another path.
        """
        if spec.max_tool_failures <= 0:
            return
        # Collapse events by tool name: any error marks the tool as failed for
        # this iteration, so repeated calls to the same tool in one batch count
        # as a single failure (not N).
        status_by_name: dict[str, str] = {}
        non_retryable: set[str] = set()
        for event in events:
            name = event.get("name")
            if not name:
                continue
            if event.get("status") == "error":
                status_by_name[name] = "error"
                if event.get("retryable") == "false":
                    non_retryable.add(name)
            elif name not in status_by_name:
                status_by_name[name] = event.get("status", "ok")
        newly_disabled: list[str] = []
        for name, status in status_by_name.items():
            if name == "office":
                continue  # Per-target editing guard keeps inspection and conflict recovery available.
            if name in disabled:
                continue
            if status == "error":
                count = (
                    spec.max_tool_failures
                    if name in non_retryable
                    else failure_counts.get(name, 0) + 1
                )
                failure_counts[name] = count
                if count >= spec.max_tool_failures:
                    disabled.add(name)
                    newly_disabled.append(name)
            else:
                failure_counts[name] = 0
        if newly_disabled:
            logger.warning(
                "Tool circuit-breaker: disabling {} after {} consecutive failures",
                ", ".join(newly_disabled),
                spec.max_tool_failures,
            )

    async def _run_tool(
        self,
        spec: AgentRunSpec,
        tool_call: ToolCallRequest,
        workspace_violation_counts: dict[str, int],
        *,
        disabled_tools: set[str] | None = None,
        blocked_tool_call_signature: str | None = None,
        blocked_office_edits: set[str] | None = None,
    ) -> tuple[Any, dict[str, str], BaseException | None]:
        hint = "\n\n[Analyze the error above and try a different approach.]"
        if blocked_office_edits and self._office_edit_key(tool_call) in blocked_office_edits:
            value = json.dumps({"ok": False, "error": {
                "code": "NO_PROGRESS", "message": "Edits to this Office target are paused for this turn after repeated failures. Inspect its capabilities or explain the limitation.",
                "retryable": False,
            }})
            return value, {"name": tool_call.name, "status": "error", "detail": "Office edit target blocked"}, None
        if disabled_tools and tool_call.name in disabled_tools:
            value = json.dumps({"ok": False, "error": {
                "code": "TOOL_DISABLED",
                "message": f"Tool {tool_call.name} is disabled for this turn after repeated failures.",
                "retryable": False,
            }})
            return value, {
                "name": tool_call.name,
                "status": "error",
                "detail": "Tool disabled after repeated failures",
                "retryable": "false",
            }, None
        if (
            blocked_tool_call_signature is not None
            and self._tool_call_signature(tool_call) == blocked_tool_call_signature
        ):
            event = {
                "name": tool_call.name,
                "status": "error",
                "detail": "repeating tool path blocked",
            }
            return _TOOL_PATH_BLOCKED, event, None
        prepare_call = getattr(spec.tools, "prepare_call", None)
        tool, params, prep_error = None, tool_call.arguments, None
        if callable(prepare_call):
            with suppress(Exception):
                prepared = prepare_call(tool_call.name, tool_call.arguments)
                if isinstance(prepared, tuple) and len(prepared) == 3:
                    tool, params, prep_error = prepared
        if prep_error:
            event = {
                "name": tool_call.name,
                "status": "error",
                "detail": prep_error.split(": ", 1)[-1][:120],
            }
            handled = self._classify_violation(
                raw_text=prep_error,
                soft_payload=prep_error + hint,
                event=event,
                tool_call=tool_call,
                workspace_violation_counts=workspace_violation_counts,
            )
            if handled is not None:
                return handled
            return (
                prep_error + hint,
                event,
                (RuntimeError(prep_error) if spec.fail_on_tool_error else None),
            )
        emit_file_edit_events = (
            spec.progress_callback is not None
            and on_progress_accepts_file_edit_events(spec.progress_callback)
        )
        progress_callback = spec.progress_callback if emit_file_edit_events else None
        file_edit_trackers = (
            prepare_file_edit_trackers(
                call_id=tool_call.id,
                tool_name=tool_call.name,
                tool=tool,
                workspace=spec.workspace,
                params=params if isinstance(params, dict) else None,
            )
            if progress_callback is not None
            else None
        )
        if file_edit_trackers and progress_callback is not None:
            await invoke_file_edit_progress(
                progress_callback,
                [
                    build_file_edit_start_event(
                        file_edit_tracker,
                        params if isinstance(params, dict) else None,
                    )
                    for file_edit_tracker in file_edit_trackers
                ],
            )
        try:
            if tool is not None:
                result = await tool.execute(**params)
            else:
                result = await spec.tools.execute(tool_call.name, params)
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            if file_edit_trackers and progress_callback is not None:
                await invoke_file_edit_progress(
                    progress_callback,
                    [
                        build_file_edit_error_event(file_edit_tracker, str(exc))
                        for file_edit_tracker in file_edit_trackers
                    ],
                )
            event = {
                "name": tool_call.name,
                "status": "error",
                "detail": str(exc),
            }
            payload = f"Error: {type(exc).__name__}: {exc}"
            handled = self._classify_violation(
                raw_text=str(exc),
                # Preserve legacy exception payloads without the retry hint.
                soft_payload=payload,
                event=event,
                tool_call=tool_call,
                workspace_violation_counts=workspace_violation_counts,
            )
            if handled is not None:
                return handled
            if spec.fail_on_tool_error:
                return payload, event, exc
            return payload, event, None

        receipt = self._structured_tool_receipt(result)
        if receipt and (receipt.get("ok") is False or receipt.get("isError") is True):
            details = receipt.get("error") or receipt.get("message") or "Tool reported failure"
            message = str(details.get("message") or details.get("code")) if isinstance(details, dict) else str(details)
            conflict = isinstance(details, dict) and details.get("code") == "VERSION_CONFLICT"
            event = {"name": tool_call.name, "status": "conflict" if conflict else "error", "detail": message[:120]}
            if isinstance(details, dict) and details.get("retryable") is False:
                event["retryable"] = "false"
            return result, event, RuntimeError(message) if spec.fail_on_tool_error and not conflict else None

        if isinstance(result, str) and result.startswith("Error"):
            if file_edit_trackers and progress_callback is not None:
                await invoke_file_edit_progress(
                    progress_callback,
                    [
                        build_file_edit_error_event(file_edit_tracker, result)
                        for file_edit_tracker in file_edit_trackers
                    ],
                )
            event = {
                "name": tool_call.name,
                "status": "error",
                "detail": result.replace("\n", " ").strip()[:120],
            }
            handled = self._classify_violation(
                raw_text=result,
                soft_payload=result + hint,
                event=event,
                tool_call=tool_call,
                workspace_violation_counts=workspace_violation_counts,
            )
            if handled is not None:
                return handled
            if spec.fail_on_tool_error:
                return result + hint, event, RuntimeError(result)
            return result + hint, event, None

        if file_edit_trackers and progress_callback is not None:
            await invoke_file_edit_progress(
                progress_callback,
                [
                    build_file_edit_end_event(
                        file_edit_tracker,
                        params if isinstance(params, dict) else None,
                    )
                    for file_edit_tracker in file_edit_trackers
                ],
            )

        await self._register_generated_media(spec, tool_call.name, tool_call.id, result)

        detail = "" if result is None else str(result)
        detail = detail.replace("\n", " ").strip()
        if not detail:
            detail = "(empty)"
        elif len(detail) > 120:
            detail = detail[:120] + "..."
        return result, {"name": tool_call.name, "status": "ok", "detail": detail}, None

    # SSRF is a hard security block at the tool boundary, but the agent turn
    # should recover conversationally instead of aborting the runtime.
    _SSRF_MARKERS: tuple[str, ...] = (
        "internal/private url detected",
        "private/internal address",
        "private address",
    )
    _SSRF_BOUNDARY_NOTE: str = (
        "This is a non-bypassable security boundary. Stop trying to access "
        "private/internal URLs. Do not retry with curl, wget, encoded IPs, "
        "alternate DNS, redirects, proxies, or another tool. Ask the user for "
        "local files, logs, screenshots, or an explicit safe public URL instead. "
        "If the user explicitly trusts this private URL, ask them to whitelist "
        "the exact IP/CIDR via tools.ssrfWhitelist."
    )

    # Non-SSRF boundary markers returned to the LLM as recoverable tool errors.
    _WORKSPACE_VIOLATION_MARKERS: tuple[str, ...] = (
        "outside the configured workspace",
        "outside allowed directory",
        "working_dir is outside",
        "working_dir could not be resolved",
        "path outside working dir",
        "path traversal detected",
    )

    @classmethod
    def _is_ssrf_violation(cls, text: str) -> bool:
        if not text:
            return False
        lowered = text.lower()
        return any(marker in lowered for marker in cls._SSRF_MARKERS)

    @classmethod
    def _is_workspace_violation(cls, text: str) -> bool:
        """True when *text* looks like any policy boundary rejection."""
        if not text:
            return False
        lowered = text.lower()
        if cls._is_ssrf_violation(lowered):
            return True
        return any(marker in lowered for marker in cls._WORKSPACE_VIOLATION_MARKERS)

    def _classify_violation(
        self,
        *,
        raw_text: str,
        soft_payload: str,
        event: dict[str, str],
        tool_call: ToolCallRequest,
        workspace_violation_counts: dict[str, int],
    ) -> tuple[Any, dict[str, str], BaseException | None] | None:
        """Classify safety-boundary failures, or return ``None`` to pass through."""
        if self._is_ssrf_violation(raw_text):
            logger.warning(
                "Tool {} blocked by SSRF guard; returning non-retryable tool error: {}",
                tool_call.name,
                raw_text.replace("\n", " ").strip()[:200],
            )
            event["detail"] = self._event_detail("ssrf_violation: ", raw_text)
            return self._ssrf_soft_payload(raw_text), event, None

        if self._is_workspace_violation(raw_text):
            escalation = repeated_workspace_violation_error(
                tool_call.name,
                tool_call.arguments,
                workspace_violation_counts,
            )
            event["detail"] = self._event_detail("workspace_violation: ", raw_text)
            if escalation is not None:
                logger.warning(
                    "Tool {} hit workspace boundary repeatedly; escalating hint",
                    tool_call.name,
                )
                event["detail"] = self._event_detail(
                    "workspace_violation_escalated: ",
                    raw_text,
                )
                return escalation, event, None
            return soft_payload, event, None

        return None

    @classmethod
    def _ssrf_soft_payload(cls, raw_text: str) -> str:
        text = raw_text.strip() or "Error: request blocked by SSRF guard"
        return f"{text}\n\n{cls._SSRF_BOUNDARY_NOTE}"

    @staticmethod
    def _event_detail(prefix: str, text: str, limit: int = 160) -> str:
        return (prefix + text.replace("\n", " ").strip())[:limit]

    async def _emit_checkpoint(
        self,
        spec: AgentRunSpec,
        payload: dict[str, Any],
    ) -> None:
        callback = spec.checkpoint_callback
        if callback is not None:
            await callback(payload)

    @staticmethod
    def _append_final_message(messages: list[dict[str, Any]], content: str | None) -> None:
        if not content:
            return
        if (
            messages
            and messages[-1].get("role") == "assistant"
            and not messages[-1].get("tool_calls")
        ):
            if messages[-1].get("content") == content:
                return
            messages[-1] = build_assistant_message(content)
            return
        messages.append(build_assistant_message(content))

    @staticmethod
    def _append_model_error_placeholder(messages: list[dict[str, Any]]) -> None:
        if (
            messages
            and messages[-1].get("role") == "assistant"
            and not messages[-1].get("tool_calls")
        ):
            return
        messages.append(build_assistant_message(_PERSISTED_MODEL_ERROR_PLACEHOLDER))

    def _normalize_tool_result(
        self,
        spec: AgentRunSpec,
        tool_call_id: str,
        tool_name: str,
        result: Any,
    ) -> Any:
        result = ensure_nonempty_tool_result(tool_name, result)
        if isinstance(result, str):
            result = compress_tool_result(result, tool_name=tool_name)
        try:
            content = maybe_persist_tool_result(
                spec.workspace,
                spec.session_key,
                tool_call_id,
                result,
                max_chars=spec.max_tool_result_chars,
            )
        except Exception:
            logger.exception(
                "Tool result persist failed for {} in {}; using raw result",
                tool_call_id,
                spec.session_key or "default",
            )
            content = result
        if isinstance(content, str) and len(content) > spec.max_tool_result_chars:
            return truncate_text(content, spec.max_tool_result_chars)
        return content

    @staticmethod
    def _drop_orphan_tool_results(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Drop tool results that have no matching assistant tool_call earlier in the history."""
        declared: set[str] = set()
        updated: list[dict[str, Any]] | None = None
        for idx, msg in enumerate(messages):
            role = msg.get("role")
            if role == "assistant":
                for tc in msg.get("tool_calls") or []:
                    if isinstance(tc, dict) and tc.get("id"):
                        declared.add(str(tc["id"]))
            if role == "tool":
                tid = msg.get("tool_call_id")
                if tid and str(tid) not in declared:
                    if updated is None:
                        updated = [dict(m) for m in messages[:idx]]
                    continue
            if updated is not None:
                updated.append(dict(msg))

        if updated is None:
            return messages
        return updated

    @staticmethod
    def _backfill_missing_tool_results(
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Insert synthetic error results for orphaned tool_use blocks."""
        declared: list[tuple[int, str, str]] = []  # (assistant_idx, call_id, name)
        fulfilled: set[str] = set()
        for idx, msg in enumerate(messages):
            role = msg.get("role")
            if role == "assistant":
                for tc in msg.get("tool_calls") or []:
                    if isinstance(tc, dict) and tc.get("id"):
                        name = ""
                        func = tc.get("function")
                        if isinstance(func, dict):
                            name = func.get("name", "")
                        declared.append((idx, str(tc["id"]), name))
            elif role == "tool":
                tid = msg.get("tool_call_id")
                if tid:
                    fulfilled.add(str(tid))

        missing = [(ai, cid, name) for ai, cid, name in declared if cid not in fulfilled]
        if not missing:
            return messages

        updated = list(messages)
        offset = 0
        for assistant_idx, call_id, name in missing:
            insert_at = assistant_idx + 1 + offset
            while insert_at < len(updated) and updated[insert_at].get("role") == "tool":
                insert_at += 1
            updated.insert(
                insert_at,
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "name": name,
                    "content": _BACKFILL_CONTENT,
                },
            )
            offset += 1
        return updated

    @staticmethod
    def _microcompact(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Replace old compactable tool results with one-line summaries."""
        compactable_indices: list[int] = []
        for idx, msg in enumerate(messages):
            if msg.get("role") == "tool" and msg.get("name") in _COMPACTABLE_TOOLS:
                compactable_indices.append(idx)

        if len(compactable_indices) <= _MICROCOMPACT_KEEP_RECENT:
            return messages

        stale = compactable_indices[: len(compactable_indices) - _MICROCOMPACT_KEEP_RECENT]
        updated: list[dict[str, Any]] | None = None
        for idx in stale:
            msg = messages[idx]
            content = msg.get("content")
            if not isinstance(content, str) or len(content) < _MICROCOMPACT_MIN_CHARS:
                continue
            name = msg.get("name", "tool")
            summary = f"[{name} result omitted from context]"
            if updated is None:
                updated = [dict(m) for m in messages]
            updated[idx]["content"] = summary

        return updated if updated is not None else messages

    def _apply_tool_result_budget(
        self,
        spec: AgentRunSpec,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        updated = messages
        for idx, message in enumerate(messages):
            if message.get("role") != "tool":
                continue
            normalized = self._normalize_tool_result(
                spec,
                str(message.get("tool_call_id") or f"tool_{idx}"),
                str(message.get("name") or "tool"),
                message.get("content"),
            )
            if normalized != message.get("content"):
                if updated is messages:
                    updated = [dict(m) for m in messages]
                updated[idx]["content"] = normalized
        return updated

    def _snip_history(
        self,
        spec: AgentRunSpec,
        messages: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not messages or not spec.context_window_tokens:
            return messages

        budget = self._context_budget(spec)
        if budget is None:
            return messages

        estimate, _ = estimate_prompt_tokens_chain(
            self.provider,
            spec.model,
            messages,
            spec.tools.get_definitions(),
        )
        if estimate <= budget:
            return messages

        system_messages = [dict(msg) for msg in messages if msg.get("role") == "system"]
        non_system = [dict(msg) for msg in messages if msg.get("role") != "system"]
        if not non_system:
            return messages

        system_tokens = sum(estimate_message_tokens(msg) for msg in system_messages)
        remaining_budget = max(128, budget - system_tokens)
        kept: list[dict[str, Any]] = []
        kept_tokens = 0
        for message in reversed(non_system):
            msg_tokens = estimate_message_tokens(message)
            if kept and kept_tokens + msg_tokens > remaining_budget:
                break
            kept.append(message)
            kept_tokens += msg_tokens
        kept.reverse()

        if kept:
            for i, message in enumerate(kept):
                if message.get("role") == "user":
                    kept = kept[i:]
                    break
            else:
                # Recover nearest user message from outside the kept window;
                # GLM rejects system→assistant (error 1214).  Budget is
                # intentionally exceeded — oversized beats invalid.
                for idx in range(len(non_system) - 1, -1, -1):
                    if non_system[idx].get("role") == "user":
                        kept = non_system[idx:]
                        break
                # If no user exists at all, _enforce_role_alternation
                # will insert a synthetic one as a safety net.
            start = find_legal_message_start(kept)
            if start:
                kept = kept[start:]
        if not kept:
            kept = non_system[-min(len(non_system), 4) :]
            start = find_legal_message_start(kept)
            if start:
                kept = kept[start:]
        return system_messages + kept

    def _context_budget(self, spec: AgentRunSpec) -> int | None:
        if not spec.context_window_tokens:
            return None
        provider_max_tokens = getattr(
            getattr(self.provider, "generation", None), "max_tokens", 4096
        )
        max_output = (
            spec.max_tokens
            if isinstance(spec.max_tokens, int)
            else (provider_max_tokens if isinstance(provider_max_tokens, int) else 4096)
        )
        hard_budget = spec.context_window_tokens - max_output - _SNIP_SAFETY_BUFFER
        if hard_budget <= 0:
            return spec.context_block_limit if spec.context_block_limit and spec.context_block_limit > 0 else None
        if spec.context_block_limit is None:
            return hard_budget
        return min(spec.context_block_limit, hard_budget)

    def _fits_context_budget(self, spec: AgentRunSpec, messages: list[dict[str, Any]]) -> bool:
        budget = self._context_budget(spec)
        if budget is None:
            return True
        try:
            estimate, _ = estimate_prompt_tokens_chain(
                self.provider,
                spec.model,
                messages,
                spec.tools.get_definitions(),
            )
        except Exception:
            logger.exception("Final context budget check failed for {}", spec.session_key or "default")
            return True
        return estimate <= budget

    def _partition_tool_batches(
        self,
        spec: AgentRunSpec,
        tool_calls: list[ToolCallRequest],
    ) -> list[list[ToolCallRequest]]:
        if not spec.concurrent_tools:
            return [[tool_call] for tool_call in tool_calls]

        batches: list[list[ToolCallRequest]] = []
        current: list[ToolCallRequest] = []
        for tool_call in tool_calls:
            get_tool = getattr(spec.tools, "get", None)
            tool = get_tool(tool_call.name) if callable(get_tool) else None
            can_batch = bool(tool and tool.concurrency_safe)
            if can_batch:
                current.append(tool_call)
                continue
            if current:
                batches.append(current)
                current = []
            batches.append([tool_call])
        if current:
            batches.append(current)
        return batches
