"""Codex v2 events -> developer-facing events; no reconstruction of reasoning."""

from __future__ import annotations

import math
from typing import Any

from mona.development.design_resources import DESIGN_TOOL
from mona.development.executors.base import NativeEvent
from mona.development.executors.host_tools import HOST_TOOL, WORK_TOOL


def thread_id(method: str, params: dict[str, Any]) -> str | None:
    value = params.get("threadId")
    if method == "thread/started":
        thread = params.get("thread")
        value = thread.get("id") if isinstance(thread, dict) else None
    return value if isinstance(value, str) and 0 < len(value) <= 512 else None


def _nonnegative_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


_CODEX_ERROR_CODES = {
    "serverOverloaded": "server_overloaded",
    "server_overloaded": "server_overloaded",
    "usageLimitExceeded": "usage_limit_exceeded",
    "usage_limit_exceeded": "usage_limit_exceeded",
    "unauthorized": "authentication_required",
    "contextWindowExceeded": "context_window_exceeded",
    "context_window_exceeded": "context_window_exceeded",
    "sessionBudgetExceeded": "session_budget_exceeded",
    "rateLimitExceeded": "rate_limit_exceeded",
    "flexUnavailable": "model_service_unavailable",
    "cyberPolicy": "model_policy_rejected",
    "misalignmentPolicyViolation": "model_policy_rejected",
    "tooManyDenials": "model_permission_denied",
    "internalServerError": "upstream_internal_error",
    "badRequest": "upstream_invalid_request",
    "threadRollbackFailed": "native_rollback_failed",
    "sandboxError": "native_sandbox_error",
    "httpConnectionFailed": "upstream_connection_failed",
    "responseStreamConnectionFailed": "upstream_connection_failed",
    "responseStreamDisconnected": "upstream_stream_disconnected",
    "responseTooManyFailedAttempts": "upstream_retries_exhausted",
}


def _codex_error(error: Any) -> dict[str, Any]:
    fallback = {"errorCode": "native_turn_failed"}
    if not isinstance(error, dict):
        return fallback
    fields = [name for name in ("codexErrorInfo", "codex_error_info") if name in error]
    if len(fields) != 1:
        return fallback
    info = error[fields[0]]
    details = None
    if isinstance(info, dict):
        if len(info) != 1:
            return fallback
        tag, details = next(iter(info.items()))
        if details is not None and not isinstance(details, dict):
            return fallback
    elif isinstance(info, str):
        tag = info
    else:
        return fallback
    code = _CODEX_ERROR_CODES.get(tag) if isinstance(tag, str) else None
    if code is None:
        return fallback
    result = {"errorCode": code}
    status = details.get("httpStatusCode") if isinstance(details, dict) else None
    if tag in {"httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"} and type(status) is int and 100 <= status <= 599:
        result["errorStatusCode"] = status
    return result


def normalize_codex_event(method: str, params: dict[str, Any], *, host_tools: bool = False,
                          work_tools: bool = False, design_tools: bool = False) -> NativeEvent | None:
    turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
    turn_id = params.get("turnId") or turn.get("id")
    turn_id = turn_id if isinstance(turn_id, str) else None
    item_id = params.get("itemId")
    if method == "thread/started":
        return NativeEvent(type="session.started", payload={"nativeSessionId": thread_id(method, params)})
    if method in {"turn/started", "turn/completed"}:
        status = turn.get("status")
        kind = "run.started" if method.endswith("started") else {
            "completed": "run.completed", "interrupted": "run.interrupted", "failed": "run.failed",
        }.get(status, "run.unknown")
        error = turn.get("error")
        error_info = (_codex_error(error) if error is not None else {"errorCode":
                      "native_turn_failed" if method == "turn/completed" and status == "failed" else None})
        return NativeEvent(native_turn_id=turn_id, type=kind,
                           payload={"status": status, **error_info})
    if method == "item/agentMessage/delta":
        return NativeEvent(native_turn_id=turn_id, type="agent.message.delta",
                           payload={"itemId": item_id, "delta": params.get("delta", "")})
    if method == "item/reasoning/summaryTextDelta":
        return NativeEvent(native_turn_id=turn_id, type="reasoning.delta",
                           payload={"itemId": item_id, "delta": params.get("delta", ""),
                                    "summaryIndex": params.get("summaryIndex", 0)})
    if method == "item/commandExecution/outputDelta":
        return NativeEvent(native_turn_id=turn_id, type="command.output",
                           payload={"itemId": item_id, "delta": params.get("delta", "")})
    if method == "thread/tokenUsage/updated":
        token_usage = params.get("tokenUsage")
        payload = {"tokenUsage": token_usage}
        if isinstance(token_usage, dict):
            last = token_usage.get("last")
            if isinstance(last, dict):
                context_tokens = _nonnegative_int(last.get("totalTokens"))
                if context_tokens is not None:
                    payload["contextTokens"] = context_tokens
            context_window = _nonnegative_int(token_usage.get("modelContextWindow"))
            if context_window:
                payload["contextWindow"] = context_window
        return NativeEvent(native_turn_id=turn_id, type="usage.updated",
                           payload=payload)
    if method in {"turn/diff/updated", "turn/plan/updated"}:
        field = "diff" if method == "turn/diff/updated" else "plan"
        return NativeEvent(native_turn_id=turn_id, type=f"run.{field}", payload={field: params.get(field)})
    if method not in {"item/started", "item/completed"}:
        return None
    item = params.get("item")
    if not isinstance(item, dict):
        return None
    item_id = item.get("id")
    done = method == "item/completed"
    item_type = item.get("type")
    if item_type == "userMessage":
        # Mona already stores the submitted message; Codex echoes are not tools.
        return None
    if item_type == "agentMessage":
        if not done:
            return NativeEvent(native_turn_id=turn_id, type="agent.message.started", payload={"itemId": item_id})
        return NativeEvent(native_turn_id=turn_id, type="agent.message.completed",
                           payload={"itemId": item_id, "text": item.get("text", ""), "replaceDelta": True})
    if item_type == "imageGeneration":
        payload = {"itemId": item_id, "kind": item_type, "status": item.get("status")}
        if done and item.get("status") == "completed" and isinstance(item_id, str) and item_id:
            source = item.get("savedPath") or item.get("result") or ""
            payload.update(text="", content=[{"type": "image", "url": source if isinstance(source, str) else "",
                                               "name": "生成的图片"}])
        return NativeEvent(native_turn_id=turn_id, native_event_id=f"image:{method}:{item_id}",
                           type="tool.completed" if done else "tool.started", payload=payload)
    if item_type == "commandExecution":
        return NativeEvent(native_turn_id=turn_id, type="command.completed" if done else "command.started",
                           payload={k: item.get(k) for k in ("id", "command", "cwd", "status", "exitCode", "aggregatedOutput", "durationMs")})
    if item_type == "fileChange":
        kind = "file.change_failed" if done and item.get("status") in {"failed", "declined"} else "file.changed" if done else "file.change_proposed"
        return NativeEvent(native_turn_id=turn_id, type=kind,
                           payload={"itemId": item_id, "changes": item.get("changes", []), "status": item.get("status"),
                                    "attribution": "native_report_not_exclusive_workspace_ownership"})
    host_tool = WORK_TOOL if work_tools else HOST_TOOL
    allowed_tool = host_tools and item.get("tool") == host_tool or design_tools and item.get("tool") == DESIGN_TOOL
    if item_type == "dynamicToolCall" and allowed_tool and item.get("namespace") is None:
        content = "\n".join(str(c.get("text", "")) for c in (item.get("contentItems") or []) if isinstance(c, dict))
        return NativeEvent(native_turn_id=turn_id, type="tool.completed" if done else "tool.started",
                           payload={"itemId": item_id, "name": item["tool"], "arguments": item.get("arguments", {}),
                                    "content": content, "isError": item.get("success") is False})
    if item_type in {"mcpToolCall", "dynamicToolCall"}:
        # These capabilities are not part of this product's project-only policy.
        return NativeEvent(native_turn_id=turn_id, type="policy.violation", payload={"kind": item_type})
    if item_type == "reasoning":
        if not isinstance(item_id, str) or not item_id:
            return None
        payload = {"itemId": item_id}
        # The protocol's public summary is displayable; raw content/encrypted
        # reasoning and provider signatures remain outside the UI contract.
        if done and isinstance(item.get("summary"), list):
            summary = "\n\n".join(part for part in item["summary"] if isinstance(part, str))
            if summary.strip():
                payload["text"] = summary
        duration = item.get("durationMs")
        valid_duration = (isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0
                          or isinstance(duration, float) and math.isfinite(duration) and duration >= 0)
        if done and valid_duration:
            payload["durationMs"] = duration
        return NativeEvent(native_turn_id=turn_id, type="reasoning.completed" if done else "reasoning.started",
                           payload=payload)
    return NativeEvent(native_turn_id=turn_id, type="tool.completed" if done else "tool.started",
                       payload={"itemId": item_id, "kind": item_type, "status": item.get("status")})
