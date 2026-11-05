"""Project an interrupted Work checkpoint into history without executing tools."""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any

from mona.session.manager import _sanitize_native_work, normalize_message_author

if TYPE_CHECKING:
    from mona.session.manager import Session


def checkpoint_message_key(message: dict[str, Any]) -> tuple[Any, ...]:
    """Ignore persistence metadata when matching the retained checkpoint suffix."""
    return (
        message.get("role"),
        message.get("content"),
        message.get("tool_call_id"),
        message.get("name"),
        message.get("tool_calls"),
        message.get("reasoning_content"),
        message.get("thinking_blocks"),
    )


def restore_checkpoint_messages(session: Session, checkpoint: Any) -> bool:
    """Apply the ordinary Work recovery projection to an in-memory Session.

    The caller owns its checkpoint/pending metadata and persistence. This only
    restores recorded messages or explicit not-started/unknown outcomes; it
    never dispatches a pending call or infers success from an interruption.
    """
    if not isinstance(checkpoint, dict):
        return False

    assistant_message = checkpoint.get("assistant_message")
    completed_tool_results = checkpoint.get("completed_tool_results") or []
    pending_tool_calls = checkpoint.get("pending_tool_calls") or []
    started_tool_call_ids = checkpoint.get("started_tool_call_ids")

    restored_messages: list[dict[str, Any]] = [
        {**message, "timestamp": message.get("timestamp") or datetime.now().isoformat()}
        for message in (checkpoint.get("completed_messages") or [])
        if isinstance(message, dict)
    ]
    if isinstance(assistant_message, dict):
        restored = dict(assistant_message)
        restored.setdefault("timestamp", datetime.now().isoformat())
        restored_messages.append(restored)
    for message in completed_tool_results:
        if isinstance(message, dict):
            restored = dict(message)
            restored.setdefault("timestamp", datetime.now().isoformat())
            restored_messages.append(restored)
    for tool_call in pending_tool_calls:
        if not isinstance(tool_call, dict):
            continue
        tool_id = tool_call.get("id")
        name = ((tool_call.get("function") or {}).get("name")) or "tool"
        if started_tool_call_ids is not None and tool_id not in started_tool_call_ids:
            content = "Error: TOOL_NOT_STARTED: This tool call was not dispatched. Retry it if still needed."
        else:
            content = (
                "Error: TOOL_OUTCOME_UNKNOWN: This tool call may have executed, but its result "
                "was not recorded. Retry only read-only or idempotent operations; for side "
                "effects, verify external state or ask the user. Do not retry blindly."
            )
        restored_messages.append({
            "role": "tool",
            "tool_call_id": tool_id,
            "name": name,
            "content": content,
            "timestamp": datetime.now().isoformat(),
        })

    native_work = _sanitize_native_work(checkpoint.get("native_work"))
    native_index = next(
        (index for index in range(len(restored_messages) - 1, -1, -1)
         if restored_messages[index].get("role") == "assistant"),
        None,
    ) if native_work is not None else None
    if native_work is not None and native_index is None:
        native_index = len(restored_messages)
        restored_messages.append({
            "role": "assistant",
            "content": "上次任务已中断，操作结果尚未确认。请先核对会话和文件结果，不要重放未确认的操作。",
            "timestamp": datetime.now().isoformat(),
        })

    overlap = 0
    max_overlap = min(len(session.messages), len(restored_messages))
    for size in range(max_overlap, 0, -1):
        existing = session.messages[-size:]
        restored = restored_messages[:size]
        if all(checkpoint_message_key(left) == checkpoint_message_key(right)
               for left, right in zip(existing, restored)):
            overlap = size
            break
    previous_count = len(session.messages)
    session.messages.extend(restored_messages[overlap:])
    if native_index is not None:
        target_index = previous_count - overlap + native_index
        session.messages[target_index]["native_work"] = native_work
    for restored in restored_messages[overlap:]:
        normalize_message_author(restored)
        session.update_ui_summary(restored)
    return True
