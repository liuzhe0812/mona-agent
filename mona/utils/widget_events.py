"""Inline visual payloads and bounded previews of streamed tool arguments."""

from __future__ import annotations

import json
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

from mona.utils.progress_events import _on_progress_accepts


def accepts_widget_events(callback: Callable[..., Any] | None) -> bool:
    return callback is not None and _on_progress_accepts(callback, "widget_events")


async def publish_widget_events(callback: Callable[..., Awaitable[None]], events: list[dict[str, Any]]) -> None:
    if events and accepts_widget_events(callback):
        await callback("", widget_events=events)


def widget_event(call: Any, result: Any = None, *, status: str = "streaming") -> dict[str, Any]:
    args = getattr(call, "arguments", {}) or {}
    source = args if isinstance(args, dict) else {}
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (ValueError, TypeError):
            result = None
    if isinstance(result, dict) and result.get("type") == "visualizer_show_widget_result":
        source = result
    if status == "complete" and not (isinstance(result, dict) and result.get("success") is True):
        status = "error"
    loading = source.get("loading_messages", [])
    if isinstance(loading, str):
        try:
            loading = json.loads(loading)
        except ValueError:
            loading = []
    event = {
        "id": str(getattr(call, "id", "")),
        "title": str(source.get("title") or ""),
        "code": str(source.get("widget_code") or ""),
        "loadingMessages": loading if isinstance(loading, list) else [],
        "status": status,
    }
    if status == "error":
        event["error"] = "图形暂时无法展示，请让 Mona 调整后重试。"
    return event


def _string_prefix(source: str, key: str) -> str | None:
    match = re.search(rf'"{re.escape(key)}"\s*:\s*"', source)
    if match is None:
        return None
    tail = source[match.end():]
    try:
        value, _ = json.JSONDecoder().raw_decode('"' + tail)
    except ValueError:
        if (len(tail) - len(tail.rstrip("\\"))) % 2:
            tail = tail[:-1]
        tail = re.sub(r"\\u[0-9a-fA-F]{0,3}$", "", tail)
        try:
            value = json.loads('"' + tail + '"')
        except ValueError:
            return None
    # A Unicode surrogate may span two deltas; wait for its complete pair.
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return None
    return value


class StreamingWidgetTracker:
    def __init__(self, *, tools: Any, emit: Callable[[list[dict[str, Any]]], Awaitable[None]]) -> None:
        self._tools = tools
        self._emit = emit
        self._states: dict[str, dict[str, Any]] = {}

    async def update(self, delta: dict[str, Any]) -> None:
        key = str(delta.get("index", delta.get("call_id") or ""))
        if not key:
            return
        state = self._states.setdefault(key, {"arguments": "", "last_emit": 0.0})
        for field in ("call_id", "name"):
            if delta.get(field):
                state[field] = str(delta[field])
        if isinstance(delta.get("arguments"), str):
            state["arguments"] = delta["arguments"]
        else:
            state["arguments"] += str(delta.get("arguments_delta") or "")
        if state.get("name") != "show_widget" or not state.get("call_id"):
            return
        if not self._tools.is_visible("show_widget"):
            return
        now = time.monotonic()
        if now - state["last_emit"] < 0.15:
            return
        args = state["arguments"]
        if len(args) > 1024 * 1024:
            return
        code = _string_prefix(args, "widget_code") or ""
        title = _string_prefix(args, "title") or ""
        if state.get("last_value") == (title, code):
            return
        state["last_emit"] = now
        state["last_value"] = (title, code)
        await self._emit([{
            "id": state["call_id"], "title": title, "code": code,
            "loadingMessages": [], "status": "streaming",
        }])
