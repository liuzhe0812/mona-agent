"""Codex v2 events -> developer-facing events; no reconstruction of reasoning."""

from __future__ import annotations

from typing import Any

from mona.development.executors.base import NativeEvent


def thread_id(method: str, params: dict[str, Any]) -> str | None:
    value = params.get("threadId")
    if method == "thread/started":
        thread = params.get("thread")
        value = thread.get("id") if isinstance(thread, dict) else None
    return value if isinstance(value, str) and 0 < len(value) <= 512 else None


def normalize_codex_event(method: str, params: dict[str, Any]) -> NativeEvent | None:
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
        return NativeEvent(native_turn_id=turn_id, type=kind,
                           payload={"status": status, "errorCode": "native_turn_failed" if turn.get("error") else None})
    if method == "item/agentMessage/delta":
        return NativeEvent(native_turn_id=turn_id, type="agent.message.delta",
                           payload={"itemId": item_id, "delta": params.get("delta", "")})
    if method == "item/commandExecution/outputDelta":
        return NativeEvent(native_turn_id=turn_id, type="command.output",
                           payload={"itemId": item_id, "delta": params.get("delta", "")})
    if method == "thread/tokenUsage/updated":
        return NativeEvent(native_turn_id=turn_id, type="usage.updated",
                           payload={"tokenUsage": params.get("tokenUsage")})
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
    if item_type == "agentMessage":
        if not done:
            return None
        return NativeEvent(native_turn_id=turn_id, type="agent.message.completed",
                           payload={"itemId": item_id, "text": item.get("text", ""), "replaceDelta": True})
    if item_type == "commandExecution":
        return NativeEvent(native_turn_id=turn_id, type="command.completed" if done else "command.started",
                           payload={k: item.get(k) for k in ("id", "command", "cwd", "status", "exitCode", "aggregatedOutput", "durationMs")})
    if item_type == "fileChange":
        return NativeEvent(native_turn_id=turn_id, type="file.changed" if done else "file.change_proposed",
                           payload={"itemId": item_id, "changes": item.get("changes", []), "status": item.get("status"),
                                    "attribution": "native_report_not_exclusive_workspace_ownership"})
    if item_type in {"mcpToolCall", "dynamicToolCall"}:
        # These capabilities are not part of this product's project-only policy.
        return NativeEvent(native_turn_id=turn_id, type="policy.violation", payload={"kind": item_type})
    if item_type == "reasoning":
        return None
    return NativeEvent(native_turn_id=turn_id, type="tool.completed" if done else "tool.started",
                       payload={"itemId": item_id, "kind": item_type, "status": item.get("status")})
