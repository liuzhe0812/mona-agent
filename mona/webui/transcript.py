"""Append-only WebUI display transcript (JSONL), separate from agent session."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from loguru import logger

from mona.agent.partners import MONA_AGENT_ID
from mona.config.paths import get_webui_dir
from mona.session.manager import SessionManager

WEBUI_TRANSCRIPT_SCHEMA_VERSION = 3
_MAX_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024
_MAX_PERSISTED_TOOL_VALUE_BYTES = 64 * 1024
_MAX_PERSISTED_TOOL_EVENTS_BYTES = 256 * 1024
_MAX_PERSISTED_TOOL_EVENTS = 500
_OMITTED_INLINE_MEDIA = "[inline media omitted]"
_OMITTED_OVERSIZED_VALUE = {"omitted": "oversized tool value"}

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv", ".3gp"}


def _ui_token_usage(value: Any) -> dict[str, int] | None:
    if not isinstance(value, dict):
        return None
    prompt = int(value.get("prompt_tokens") or 0)
    completion = int(value.get("completion_tokens") or 0)
    cached = int(value.get("cached_tokens") or value.get("cache_read_input_tokens") or 0)
    total = int(value.get("total_tokens") or prompt + completion)
    if max(prompt, completion, cached, total) <= 0:
        return None
    usage = {
        "promptTokens": max(0, prompt),
        "completionTokens": max(0, completion),
        "cachedTokens": max(0, cached),
        "totalTokens": max(0, total),
    }
    # Only carry the last-call prompt size when the backend reported one;
    # a zero would be read as a real measurement by the composer pill.
    context = int(value.get("context_tokens") or 0)
    if context > 0:
        usage["contextTokens"] = context
    return usage


def _infer_media_kind(name: str, url: str) -> str:
    """Infer media kind from file name / URL extension."""
    ext = Path(name).suffix.lower() if name else ""
    if not ext:
        clean = url.split("?", 1)[0].split("#", 1)[0].lower()
        dot = clean.rfind(".")
        if dot >= 0:
            ext = clean[dot:]
    if ext in _IMAGE_EXTS:
        return "image"
    if ext in _VIDEO_EXTS:
        return "video"
    return "file"


def webui_transcript_path(session_key: str) -> Path:
    stem = SessionManager.safe_key(session_key)
    return get_webui_dir() / f"{stem}.jsonl"


def read_transcript_lines(
    session_key: str,
    *,
    compact_tool_events: bool = False,
) -> list[dict[str, Any]]:
    path = webui_transcript_path(session_key)
    if not path.is_file():
        return []
    lines_out: list[dict[str, Any]] = []
    try:
        with open(path, encoding="utf-8") as f:
            for line_no, line in enumerate(f, start=1):
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    logger.warning("bad jsonl at {} line {}", path, line_no)
                    continue
                if isinstance(obj, dict):
                    lines_out.append(
                        compact_transcript_object(obj) if compact_tool_events else obj
                    )
    except OSError as e:
        logger.warning("read transcript failed {}: {}", path, e)
        return []
    return lines_out


def _json_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _remove_inline_media(value: Any) -> Any:
    """Keep transcript records JSON-shaped without persisting inline binary payloads."""
    if isinstance(value, str):
        prefix = value[:128].lower()
        if prefix.startswith("data:") and ";base64," in prefix:
            return _OMITTED_INLINE_MEDIA
        return value
    if isinstance(value, list):
        return [_remove_inline_media(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _remove_inline_media(item) for key, item in value.items()}
    return value


def _bounded_tool_value(value: Any) -> Any:
    compact = _remove_inline_media(value)
    if _json_size(compact) <= _MAX_PERSISTED_TOOL_VALUE_BYTES:
        return compact
    return dict(_OMITTED_OVERSIZED_VALUE)


def _compact_tool_event(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    compact = {
        str(key): _bounded_tool_value(item)
        for key, item in value.items()
        if key != "embeds"
    }
    return compact


def _compact_tool_events(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    events = [event for item in value if (event := _compact_tool_event(item)) is not None]
    events = events[-_MAX_PERSISTED_TOOL_EVENTS:]
    if _json_size(events) <= _MAX_PERSISTED_TOOL_EVENTS_BYTES:
        return events

    # Results are useful for small source/file projections, but the durable UI
    # trail only requires the call identity, arguments and outcome.
    for event in events:
        event.pop("result", None)
        event.pop("files", None)
    while events and _json_size(events) > _MAX_PERSISTED_TOOL_EVENTS_BYTES:
        events.pop(0)
    return events


def compact_transcript_object(obj: dict[str, Any]) -> dict[str, Any]:
    """Return a persistence-only copy; the live WebSocket payload stays intact."""
    compact = dict(obj)
    if "tool_events" in compact:
        tool_events = _compact_tool_events(compact.get("tool_events"))
        if tool_events:
            compact["tool_events"] = tool_events
        else:
            compact.pop("tool_events", None)
    return compact


def append_transcript_object(session_key: str, obj: dict[str, Any]) -> None:
    persisted = dict(obj)
    persisted.setdefault("_event_id", uuid.uuid4().hex)
    persisted.setdefault("_recorded_at", time.time())
    raw = json.dumps(compact_transcript_object(persisted), ensure_ascii=False, separators=(",", ":"))
    if len(raw.encode("utf-8")) > _MAX_TRANSCRIPT_LINE_BYTES:
        msg = "webui transcript line too large"
        raise ValueError(msg)
    path = webui_transcript_path(session_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = raw + "\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(line)
        f.flush()
        os.fsync(f.fileno())


def write_transcript_objects(session_key: str, objects: list[dict[str, Any]]) -> None:
    """Atomically create a WebUI transcript from validated display records."""
    prepared: list[dict[str, Any]] = []
    for obj in objects:
        persisted = dict(obj)
        persisted.setdefault("_event_id", uuid.uuid4().hex)
        persisted.setdefault("_recorded_at", time.time())
        prepared.append(persisted)
    lines = [
        json.dumps(compact_transcript_object(obj), ensure_ascii=False, separators=(",", ":"))
        for obj in prepared
    ]
    raw = "\n".join(lines) + ("\n" if lines else "")
    if any(len(line.encode("utf-8")) > _MAX_TRANSCRIPT_LINE_BYTES for line in lines):
        raise ValueError("webui transcript line too large")
    path = webui_transcript_path(session_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".jsonl.tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(raw)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


def delete_webui_transcript(session_key: str) -> bool:
    from mona.webui.history_cache import delete_cached_thread, thread_history_lock

    path = webui_transcript_path(session_key)
    try:
        with thread_history_lock(session_key):
            delete_cached_thread(session_key)
            if not path.is_file():
                return False
            path.unlink()
            return True
    except OSError as e:
        logger.warning("Failed to delete webui transcript {}: {}", path, e)
        return False


def _format_tool_call_trace(call: Any) -> str | None:
    if not call or not isinstance(call, dict):
        return None
    from mona.agent.tool_privacy import redact_persisted_tool_call

    call = redact_persisted_tool_call(call)
    fn = call.get("function")
    name = fn.get("name") if isinstance(fn, dict) else None
    if not isinstance(name, str) or not name:
        raw_name = call.get("name")
        name = raw_name if isinstance(raw_name, str) else ""
    if not name:
        return None
    args = (fn.get("arguments") if isinstance(fn, dict) else None) or call.get("arguments")
    if isinstance(args, str) and args.strip():
        return f"{name}({args})"
    if args and isinstance(args, dict):
        return f"{name}({json.dumps(args, ensure_ascii=False)})"
    return f"{name}()"


def tool_trace_lines_from_events(events: Any) -> list[str]:
    if not isinstance(events, list):
        return []
    lines: list[str] = []
    seen: set[str] = set()
    for event in events:
        if not event or not isinstance(event, dict):
            continue
        if event.get("phase") not in {"start", "end", "error"}:
            continue
        call_id = event.get("call_id")
        if isinstance(call_id, str) and call_id:
            if call_id in seen:
                continue
            seen.add(call_id)
        t = _format_tool_call_trace(event)
        if t:
            lines.append(t)
    return lines


def _merge_unique_tool_trace_lines(
    previous_traces: list[str],
    lines: list[str],
) -> tuple[list[str], bool]:
    seen_lines = set(previous_traces)
    traces = list(previous_traces)
    added = False
    for line in lines:
        if line in seen_lines:
            continue
        seen_lines.add(line)
        traces.append(line)
        added = True
    return traces, added


def replay_transcript_to_ui_messages(
    lines: list[dict[str, Any]],
    *,
    augment_user_media: Callable[[list[str]], list[dict[str, Any]]] | None = None,
) -> list[dict[str, Any]]:
    """Fold JSONL records into ``UIMessage``-shaped dicts for the WebUI.

    Mirrors the core fold in ``usemonaStream.ts`` (delta, reasoning,
    message+kind, turn_end). ``augment_user_media`` maps persisted filesystem
    paths to ``{url, name?}`` / attachment dicts the client expects.
    """
    messages: list[dict[str, Any]] = []
    buffer_message_index: int | None = None
    buffer_parts: list[str] = []
    buffer_source_index: int | None = None
    buffer_task_id: str | None = None
    reasoning_message_index: int | None = None
    reasoning_parts: list[str] = []
    suppress_until_turn_end = False
    active_activity_segment_id: str | None = None
    active_file_edit_segment_id: str | None = None
    activity_segment_counter = 0
    pending_delivered_files: list[dict[str, Any]] = []
    pending_delivered_media: list[dict[str, Any]] = []
    _ts_base = int(time.time() * 1000)
    id_counts: dict[tuple[str, int], int] = {}

    def _new_id(prefix: str, idx: int) -> str:
        key = (prefix, idx)
        occurrence = id_counts.get(key, 0) + 1
        id_counts[key] = occurrence
        suffix = f"-{occurrence}" if occurrence > 1 else ""
        return f"{prefix}-{idx}{suffix}"

    def _new_activity_segment(*, activate: bool = True) -> str:
        nonlocal active_activity_segment_id, activity_segment_counter
        activity_segment_counter += 1
        segment_id = f"activity-{activity_segment_counter}"
        if activate:
            active_activity_segment_id = segment_id
        return segment_id

    def _ensure_activity_segment() -> str:
        return active_activity_segment_id or _new_activity_segment()

    def close_activity_for_answer() -> None:
        nonlocal active_activity_segment_id, active_file_edit_segment_id
        active_activity_segment_id = None
        active_file_edit_segment_id = None

    def close_file_edit_phase_before_activity() -> None:
        nonlocal active_activity_segment_id, active_file_edit_segment_id
        if active_file_edit_segment_id:
            active_activity_segment_id = None
            active_file_edit_segment_id = None

    def attach_reasoning_chunk(prev: list[dict[str, Any]], chunk: str, idx: int) -> int:
        for i in range(len(prev) - 1, -1, -1):
            candidate = prev[i]
            if candidate.get("role") == "user":
                break
            if candidate.get("kind") == "trace":
                break
            if candidate.get("role") != "assistant":
                continue
            content = str(candidate.get("content") or "")
            has_answer = len(content) > 0
            if (
                candidate.get("reasoningStreaming")
                or candidate.get("reasoning") is not None
                or has_answer
                or candidate.get("isStreaming")
            ):
                prev[i] = {
                    **candidate,
                    "reasoning": (str(candidate.get("reasoning") or "")) + chunk,
                    "reasoningStreaming": True,
                    "activitySegmentId": candidate.get("activitySegmentId") or _ensure_activity_segment(),
                }
                return i
            if not has_answer and candidate.get("isStreaming"):
                prev[i] = {
                    **candidate,
                    "reasoning": chunk,
                    "reasoningStreaming": True,
                    "activitySegmentId": candidate.get("activitySegmentId") or _ensure_activity_segment(),
                }
                return i
            break
        segment = _ensure_activity_segment()
        prev.append(
            {
                "id": _new_id("as", idx),
                "role": "assistant",
                "content": "",
                "isStreaming": True,
                "reasoning": chunk,
                "reasoningStreaming": True,
                "activitySegmentId": segment,
                "createdAt": _ts_base + idx,
            },
        )
        return len(prev) - 1

    def find_active_placeholder(prev: list[dict[str, Any]]) -> int | None:
        last = prev[-1] if prev else None
        if not last:
            return None
        if last.get("role") != "assistant" or last.get("kind") == "trace":
            return None
        if str(last.get("content") or ""):
            return None
        if not last.get("isStreaming"):
            return None
        return len(prev) - 1

    def flush_delta_buffer() -> None:
        nonlocal buffer_parts, buffer_source_index, buffer_task_id
        if buffer_message_index is None or buffer_source_index is None or not buffer_parts:
            return
        message = messages[buffer_message_index]
        update: dict[str, Any] = {
            **message,
            "content": str(message.get("content") or "") + "".join(buffer_parts),
            "isStreaming": True,
            "sourceTranscriptIndex": buffer_source_index,
        }
        if buffer_task_id:
            update["taskId"] = buffer_task_id
        messages[buffer_message_index] = update
        buffer_parts = []
        buffer_source_index = None
        buffer_task_id = None

    def flush_reasoning_buffer() -> None:
        nonlocal reasoning_message_index, reasoning_parts
        if reasoning_message_index is None or not reasoning_parts:
            return
        message = messages[reasoning_message_index]
        messages[reasoning_message_index] = {
            **message,
            "reasoning": str(message.get("reasoning") or "") + "".join(reasoning_parts),
            "reasoningStreaming": True,
        }
        reasoning_message_index = None
        reasoning_parts = []

    def close_reasoning(prev: list[dict[str, Any]]) -> None:
        for i in range(len(prev) - 1, -1, -1):
            if prev[i].get("reasoningStreaming"):
                prev[i] = {**prev[i], "reasoningStreaming": False}
                return

    def is_reasoning_only_placeholder(m: dict[str, Any]) -> bool:
        return (
            m.get("role") == "assistant"
            and m.get("kind") != "trace"
            and not str(m.get("content") or "").strip()
            and bool(m.get("reasoning"))
            and not m.get("reasoningStreaming")
            and not m.get("media")
        )

    def is_tool_trace_at(index: int) -> bool:
        m = messages[index] if 0 <= index < len(messages) else None
        return bool(m and m.get("kind") == "trace")

    def prune_reasoning_only() -> None:
        nonlocal messages
        kept: list[dict[str, Any]] = []
        for i, m in enumerate(messages):
            if is_reasoning_only_placeholder(m) and not is_tool_trace_at(i + 1):
                continue
            kept.append(m)
        messages = kept

    def stamp_turn_end(
        idx: int,
        latency_ms: int | None = None,
        token_usage: dict[str, int] | None = None,
        task_id: str | None = None,
    ) -> None:
        fallback_index: int | None = None
        for i in range(len(messages) - 1, -1, -1):
            candidate = messages[i]
            if candidate.get("role") == "user":
                break
            if candidate.get("role") != "assistant" or candidate.get("kind") == "trace":
                continue
            candidate_task_id = candidate.get("taskId")
            if task_id and candidate_task_id not in (None, task_id):
                continue
            if fallback_index is None:
                fallback_index = i
            if str(candidate.get("content") or "").strip():
                fallback_index = i
                break
        if fallback_index is None:
            return
        for i, candidate in enumerate(messages):
            if (
                i != fallback_index
                and token_usage is not None
                and task_id
                and candidate.get("role") == "assistant"
                and candidate.get("kind") != "trace"
                and candidate.get("taskId") == task_id
            ):
                candidate.pop("tokenUsage", None)
        update: dict[str, Any] = {
            **messages[fallback_index],
            "sourceTranscriptIndex": idx,
            "isStreaming": False,
        }
        if latency_ms is not None:
            update["latencyMs"] = latency_ms
        if token_usage is not None:
            update["tokenUsage"] = token_usage
        if task_id:
            update["taskId"] = task_id
        messages[fallback_index] = update

    def _delivered_file_key(file: dict[str, Any]) -> str:
        return str(file.get("absolute_path") or file.get("path") or file.get("name") or "")

    def merge_delivered_files(
        existing: list[dict[str, Any]] | None,
        incoming: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        out = list(existing or [])
        seen = {_delivered_file_key(file) for file in out if isinstance(file, dict)}
        for file in incoming:
            if not isinstance(file, dict):
                continue
            key = _delivered_file_key(file)
            if key in seen:
                continue
            seen.add(key)
            out.append(dict(file))
        return out

    def merge_media(
        existing: list[dict[str, Any]] | None,
        incoming: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        out = list(existing or [])
        seen = {
            (str(item.get("kind") or ""), str(item.get("name") or item.get("url") or ""))
            for item in out
            if isinstance(item, dict)
        }
        for item in incoming:
            if not isinstance(item, dict):
                continue
            key = (str(item.get("kind") or ""), str(item.get("name") or item.get("url") or ""))
            if key in seen:
                continue
            seen.add(key)
            out.append(dict(item))
        return out

    def append_delivered_files_to_last_assistant(
        files: list[dict[str, Any]],
        idx: int,
        media: list[dict[str, Any]] | None = None,
    ) -> None:
        if not files and not media:
            return
        for i in range(len(messages) - 1, -1, -1):
            message = messages[i]
            if message.get("role") == "user":
                break
            if message.get("role") == "assistant" and message.get("kind") != "trace":
                messages[i] = {
                    **message,
                    "deliveredFiles": merge_delivered_files(
                        message.get("deliveredFiles")
                        if isinstance(message.get("deliveredFiles"), list)
                        else None,
                        files,
                    ),
                    "media": merge_media(
                        message.get("media") if isinstance(message.get("media"), list) else None,
                        media or [],
                    ),
                    "sourceTranscriptIndex": idx,
                }
                return
        messages.append(
            {
                "id": _new_id("as-deliver", idx),
                "role": "assistant",
                "content": "",
                "deliveredFiles": merge_delivered_files(None, files),
                "media": merge_media(None, media or []),
                "createdAt": _ts_base + idx,
                "sourceTranscriptIndex": idx,
            },
        )

    def queue_delivered_files(
        files: list[dict[str, Any]],
        media: list[dict[str, Any]] | None = None,
    ) -> None:
        nonlocal pending_delivered_files, pending_delivered_media
        pending_delivered_files = merge_delivered_files(pending_delivered_files, files)
        pending_delivered_media = merge_media(pending_delivered_media, media or [])

    def flush_pending_delivered_files(idx: int) -> None:
        nonlocal pending_delivered_files, pending_delivered_media
        if not pending_delivered_files and not pending_delivered_media:
            return
        append_delivered_files_to_last_assistant(
            pending_delivered_files,
            idx,
            pending_delivered_media,
        )
        pending_delivered_files = []
        pending_delivered_media = []

    def attach_or_queue_delivered_files(
        files: list[dict[str, Any]],
        media: list[dict[str, Any]] | None = None,
    ) -> None:
        for i in range(len(messages) - 1, -1, -1):
            message = messages[i]
            if message.get("role") == "user":
                break
            if message.get("role") == "assistant" and message.get("kind") != "trace":
                if message.get("isStreaming"):
                    queue_delivered_files(files, media)
                else:
                    messages[i] = {
                        **message,
                        "deliveredFiles": merge_delivered_files(
                            message.get("deliveredFiles")
                            if isinstance(message.get("deliveredFiles"), list)
                            else None,
                            files,
                        ),
                        "media": merge_media(
                            message.get("media") if isinstance(message.get("media"), list) else None,
                            media or [],
                        ),
                    }
                return
        queue_delivered_files(files, media)

    def absorb_complete(extra: dict[str, Any], idx: int) -> None:
        nonlocal active_activity_segment_id, active_file_edit_segment_id
        last = messages[-1] if messages else None
        if last and is_reasoning_only_placeholder(last):
            messages[-1] = {
                **last,
                **extra,
                "isStreaming": False,
                "reasoningStreaming": False,
                "sourceTranscriptIndex": idx,
            }
        else:
            messages.append(
                {
                    "id": _new_id("as", idx),
                    "role": "assistant",
                    "createdAt": _ts_base + idx,
                    "sourceTranscriptIndex": idx,
                    **extra,
                },
            )
        flush_pending_delivered_files(idx)
        active_activity_segment_id = None
        active_file_edit_segment_id = None

    def _file_edit_key(edit: dict[str, Any]) -> str:
        call_id = str(edit.get("call_id") or "")
        tool = str(edit.get("tool") or "")
        if call_id:
            return f"{call_id}|{tool}"
        return f"{tool}|{edit.get('path') or ''}"

    def find_file_edit_trace_index(
        segment: str | None,
        edits: list[dict[str, Any]],
    ) -> int | None:
        incoming_keys = {_file_edit_key(edit) for edit in edits if isinstance(edit, dict)}
        for i in range(len(messages) - 1, -1, -1):
            candidate = messages[i]
            if candidate.get("role") == "user":
                break
            if candidate.get("kind") != "trace" or not candidate.get("fileEdits"):
                continue
            if segment and candidate.get("activitySegmentId") == segment:
                return i
            existing_edits = candidate.get("fileEdits")
            if not isinstance(existing_edits, list):
                continue
            for existing in existing_edits:
                if isinstance(existing, dict) and _file_edit_key(existing) in incoming_keys:
                    return i
        return None

    def upsert_file_edits(edits: list[dict[str, Any]], idx: int) -> None:
        nonlocal active_file_edit_segment_id
        if not edits:
            return
        segment = active_file_edit_segment_id
        target_index = find_file_edit_trace_index(segment, edits)
        if target_index is not None:
            last = messages[target_index]
            segment = str(last.get("activitySegmentId") or segment or _new_activity_segment(activate=False))
            active_file_edit_segment_id = segment
        else:
            if not segment:
                segment = _new_activity_segment(activate=False)
            active_file_edit_segment_id = segment
            messages.append(
                {
                    "id": _new_id("tr", idx),
                    "role": "tool",
                    "kind": "trace",
                    "content": "",
                    "traces": [],
                    "fileEdits": [],
                    "activitySegmentId": segment,
                    "createdAt": _ts_base + idx,
                },
            )
            target_index = len(messages) - 1
            last = messages[target_index]
        if not segment:
            segment = _new_activity_segment(activate=False)
            active_file_edit_segment_id = segment
        existing = list(last.get("fileEdits") or [])
        index_by_key = {
            _file_edit_key(edit): pos
            for pos, edit in enumerate(existing)
            if isinstance(edit, dict)
        }
        for edit in edits:
            if not isinstance(edit, dict):
                continue
            key = _file_edit_key(edit)
            if key in index_by_key:
                pos = index_by_key[key]
                merged = {**existing[pos], **edit}
                if edit.get("path") and not edit.get("pending"):
                    merged.pop("pending", None)
                existing[pos] = merged
            else:
                index_by_key[key] = len(existing)
                existing.append(dict(edit))
        messages[target_index] = {
            **last,
            "fileEdits": existing,
            "activitySegmentId": last.get("activitySegmentId") or segment,
        }

    for idx, rec in enumerate(lines):
        ev = rec.get("event")
        if ev != "delta":
            flush_delta_buffer()
        if ev != "reasoning_delta":
            flush_reasoning_buffer()
        if ev == "user":
            active_activity_segment_id = None
            active_file_edit_segment_id = None
            text = rec.get("text")
            text_s = text if isinstance(text, str) else ""
            media_paths = rec.get("media_paths")
            paths: list[str] = []
            if isinstance(media_paths, list):
                paths = [str(p) for p in media_paths if p]
            media_att: list[dict[str, Any]] | None = None
            if paths and augment_user_media is not None:
                media_att = augment_user_media(paths)
            row: dict[str, Any] = {
                "id": _new_id("u", idx),
                "role": "user",
                "content": text_s,
                "createdAt": _ts_base + idx,
                "authorType": "user",
                "messageType": "message",
                "sourceTranscriptIndex": idx,
            }
            # IMPORTANT: restore displayContent from transcript so history
            # replay shows the short label (e.g. "健康巡检") instead of the
            # full enriched prompt. DO NOT remove.
            dc = rec.get("display_content")
            if isinstance(dc, str) and dc:
                row["displayContent"] = dc
            quote = rec.get("quote")
            if isinstance(quote, dict):
                author = quote.get("author")
                quote_content = quote.get("content")
                if isinstance(author, str) and isinstance(quote_content, str):
                    row["quote"] = {"author": author, "content": quote_content}
            task_id = rec.get("task_id")
            if isinstance(task_id, str) and task_id:
                row["taskId"] = task_id
            if media_att:
                row["media"] = media_att
                if all(m.get("kind") == "image" for m in media_att):
                    row["images"] = [{"url": m.get("url"), "name": m.get("name")} for m in media_att]
            messages.append(row)
            continue

        if ev == "file_edit":
            raw_edits = rec.get("edits")
            if isinstance(raw_edits, list):
                upsert_file_edits([e for e in raw_edits if isinstance(e, dict)], idx)
            continue

        if ev == "deliver_files":
            raw_files = rec.get("files")
            if isinstance(raw_files, list):
                files = [f for f in raw_files if isinstance(f, dict)]
                media: list[dict[str, Any]] = []
                if rec.get("inline_media") is not False and augment_user_media is not None:
                    paths = [
                        str(file.get("absolute_path"))
                        for file in files
                        if file.get("absolute_path")
                        and _infer_media_kind(str(file.get("name") or ""), "") in {"image", "video"}
                    ]
                    if paths:
                        media = augment_user_media(paths)
                attach_or_queue_delivered_files(files, media)
            continue

        if ev in ("workflow_run_updated", "discussion_updated"):
            # Structured room activity cards keep only the latest snapshot per
            # run and stay where the activity first appeared in the transcript.
            run_id = rec.get("id")
            if not isinstance(run_id, str) or not run_id:
                continue
            card_kind = "discussion" if ev == "discussion_updated" else "workflowRun"
            run_payload = {
                k: v for k, v in rec.items() if k not in ("event", "chat_id")
            }
            for i in range(len(messages) - 1, -1, -1):
                candidate = messages[i]
                if (
                    candidate.get("kind") == card_kind
                    and candidate.get("workflowRunId") == run_id
                ):
                    messages[i] = {**candidate, "payload": run_payload}
                    break
            else:
                messages.append(
                    {
                        "id": _new_id("topic" if card_kind == "discussion" else "wfr", idx),
                        "role": "assistant",
                        "kind": card_kind,
                        "content": "",
                        "workflowRunId": run_id,
                        "payload": run_payload,
                        "createdAt": _ts_base + idx,
                    },
                )
            continue

        if ev == "delta":
            if suppress_until_turn_end:
                continue
            chunk = rec.get("text")
            if not isinstance(chunk, str):
                continue
            close_activity_for_answer()
            if buffer_message_index is None:
                adopted = find_active_placeholder(messages)
                if adopted is not None:
                    buffer_message_index = adopted
                else:
                    buffer_author_id = rec.get("author_id")
                    buffer_task_id = rec.get("task_id")
                    messages.append(
                        {
                            "id": _new_id("buf", idx),
                            "role": "assistant",
                            "content": "",
                            "isStreaming": True,
                            "createdAt": _ts_base + idx,
                            "authorType": "agent",
                            "authorId": (
                                buffer_author_id
                                if isinstance(buffer_author_id, str) and buffer_author_id
                                else MONA_AGENT_ID
                            ),
                            "messageType": "message",
                            "sourceTranscriptIndex": idx,
                            **(
                                {"taskId": buffer_task_id}
                                if isinstance(buffer_task_id, str) and buffer_task_id
                                else {}
                            ),
                        },
                    )
                    buffer_message_index = len(messages) - 1
                buffer_task_id = None
            buffer_parts.append(chunk)
            buffer_source_index = idx
            rec_task_id = rec.get("task_id")
            if isinstance(rec_task_id, str) and rec_task_id:
                buffer_task_id = rec_task_id
            continue

        if ev == "stream_end":
            if suppress_until_turn_end:
                buffer_message_index = None
                buffer_parts = []
                buffer_source_index = None
                buffer_task_id = None
                continue
            buffer_message_index = None
            buffer_parts = []
            buffer_source_index = None
            buffer_task_id = None
            continue

        if ev == "reasoning_delta":
            if suppress_until_turn_end:
                continue
            chunk = rec.get("text")
            if not isinstance(chunk, str) or not chunk:
                continue
            close_file_edit_phase_before_activity()
            if reasoning_message_index is None:
                reasoning_message_index = attach_reasoning_chunk(messages, "", idx)
            reasoning_parts.append(chunk)
            continue

        if ev == "reasoning_end":
            if suppress_until_turn_end:
                continue
            close_reasoning(messages)
            continue

        if ev == "message":
            if suppress_until_turn_end and rec.get("kind") in (
                "tool_hint",
                "progress",
                "reasoning",
            ):
                continue
            kind = rec.get("kind")
            if kind == "reasoning":
                line = rec.get("text")
                if not isinstance(line, str) or not line:
                    continue
                close_file_edit_phase_before_activity()
                attach_reasoning_chunk(messages, line, idx)
                close_reasoning(messages)
                continue
            if kind in ("tool_hint", "progress"):
                structured = tool_trace_lines_from_events(rec.get("tool_events"))
                text = rec.get("text")
                trace_lines = structured if structured else ([text] if isinstance(text, str) and text else [])
                if not trace_lines:
                    continue
                segment = _ensure_activity_segment()
                last = messages[-1] if messages else None
                if (
                    last
                    and last.get("kind") == "trace"
                    and not last.get("isStreaming")
                    and (last.get("activitySegmentId") in (None, segment))
                ):
                    prev_traces = list(last.get("traces") or [last.get("content")])
                    if structured:
                        merged_traces, added = _merge_unique_tool_trace_lines(prev_traces, structured)
                        if not added:
                            continue
                    else:
                        merged_traces = prev_traces + trace_lines
                    merged = {
                        **last,
                        "traces": merged_traces,
                        "content": merged_traces[-1],
                        "activitySegmentId": last.get("activitySegmentId") or segment,
                        "toolEvents": [
                            *(last.get("toolEvents") or []),
                            *(rec.get("tool_events") or []),
                        ],
                    }
                    messages[-1] = merged
                else:
                    messages.append(
                        {
                            "id": _new_id("tr", idx),
                            "role": "tool",
                            "kind": "trace",
                            "content": trace_lines[-1],
                            "traces": trace_lines,
                            **({"toolEvents": rec.get("tool_events")} if rec.get("tool_events") else {}),
                            "activitySegmentId": segment,
                            "createdAt": _ts_base + idx,
                        },
                    )
                continue

            buffer_message_index = None
            buffer_parts = []
            buffer_source_index = None
            buffer_task_id = None
            text = rec.get("text")
            content_s = text if isinstance(text, str) else ""
            media: list[dict[str, Any]] = []
            raw_media = rec.get("media")
            if isinstance(raw_media, list) and augment_user_media is not None:
                media = augment_user_media([str(path) for path in raw_media if path])
            media_urls = rec.get("media_urls")
            if not media and isinstance(media_urls, list):
                for m in media_urls:
                    if isinstance(m, dict) and m.get("url"):
                        media.append(
                            {
                                "kind": _infer_media_kind(str(m.get("name") or ""), str(m["url"])),
                                "url": str(m["url"]),
                                "name": str(m.get("name") or ""),
                            },
                        )
            extra: dict[str, Any] = {"content": content_s}
            rec_author_id = rec.get("author_id")
            extra["authorType"] = "agent"
            extra["authorId"] = (
                rec_author_id
                if isinstance(rec_author_id, str) and rec_author_id
                else MONA_AGENT_ID
            )
            rec_message_type = rec.get("message_type")
            extra["messageType"] = (
                rec_message_type
                if isinstance(rec_message_type, str) and rec_message_type
                else "message"
            )
            rec_workflow_run_id = rec.get("workflow_run_id")
            if isinstance(rec_workflow_run_id, str) and rec_workflow_run_id:
                extra["workflowRunId"] = rec_workflow_run_id
            rec_job_id = rec.get("job_id")
            if isinstance(rec_job_id, str) and rec_job_id:
                extra["jobId"] = rec_job_id
            rec_tool_events = rec.get("tool_events")
            if isinstance(rec_tool_events, list) and rec_tool_events:
                extra["toolEvents"] = rec_tool_events
            rec_task_plan = rec.get("task_plan")
            if isinstance(rec_task_plan, dict):
                extra["taskPlan"] = rec_task_plan
            rec_task_id = rec.get("task_id")
            if isinstance(rec_task_id, str) and rec_task_id:
                extra["taskId"] = rec_task_id
            rec_token_usage = _ui_token_usage(rec.get("token_usage"))
            if rec_token_usage is not None:
                extra["tokenUsage"] = rec_token_usage
            if media:
                extra["media"] = media
            lat = rec.get("latency_ms")
            if isinstance(lat, (int, float)) and lat >= 0:
                extra["latencyMs"] = int(lat)
            absorb_complete(extra, idx)
            if media:
                suppress_until_turn_end = True
            continue

        if ev == "turn_end":
            suppress_until_turn_end = False
            active_activity_segment_id = None
            active_file_edit_segment_id = None
            for i, m in enumerate(messages):
                if m.get("isStreaming"):
                    messages[i] = {**m, "isStreaming": False}
            prune_reasoning_only()
            flush_pending_delivered_files(idx)
            lat = rec.get("latency_ms")
            turn_task_id = rec.get("task_id")
            stamp_turn_end(
                idx,
                int(lat) if isinstance(lat, (int, float)) and lat >= 0 else None,
                _ui_token_usage(rec.get("token_usage")),
                turn_task_id if isinstance(turn_task_id, str) else None,
            )
            buffer_message_index = None
            buffer_parts = []
            buffer_source_index = None
            buffer_task_id = None
            continue

    flush_delta_buffer()
    flush_reasoning_buffer()
    for m in messages:
        m.pop("isStreaming", None)
        m.pop("reasoningStreaming", None)
    return messages


def _resolve_legacy_artifact_paths(messages: list[dict[str, Any]]) -> None:
    """Rewrite legacy artifact paths in-place via the migration manifest.

    Per shared-output-workspace-execution-plan §8.4:
    - If ``deliveredFiles.absolute_path`` / ``fileEdits.absolute_path`` no
      longer exists on disk, look up the migration manifest's old→new map.
    - Replace the path only in the UI payload; the on-disk transcript is
      never modified.
    - Unmatched paths are left as-is (caller retains existing "file does not
      exist" behavior).
    """
    try:
        from mona.config.migrate_global import resolve_legacy_path
    except Exception:
        return

    # Cache manifest presence across all messages in one replay.
    manifest_loaded = False
    has_manifest = False

    def _ensure_manifest_loaded() -> bool:
        nonlocal manifest_loaded, has_manifest
        if not manifest_loaded:
            manifest_loaded = True
            try:
                from mona.config.migrate_global import _manifest_path
                has_manifest = _manifest_path().exists()
            except Exception:
                has_manifest = False
        return has_manifest

    def _maybe_rewrite(file: dict[str, Any]) -> None:
        if not isinstance(file, dict):
            return
        abs_path = file.get("absolute_path")
        if not isinstance(abs_path, str) or not abs_path:
            return
        # Only rewrite if the file is missing — preserves newer user files
        # that may have moved manually.
        try:
            if Path(abs_path).exists():
                return
        except Exception:
            return
        if not _ensure_manifest_loaded():
            return
        try:
            new_path = resolve_legacy_path(abs_path)
        except Exception:
            return
        if new_path is None:
            return
        try:
            if not new_path.exists():
                return
        except Exception:
            return
        file["absolute_path"] = str(new_path)
        # Update relative `path` for the final owner root when possible. Old
        # manifests can have a two-hop path map; the absolute path above is
        # still authoritative if a legacy product path has no Agent root.
        rel = file.get("path")
        if isinstance(rel, str) and rel and not Path(rel).is_absolute():
            try:
                from mona.config.paths import get_agent_output_dir, get_workspace_path
                agent_root = get_agent_output_dir(get_workspace_path(), "mona")
                file["path"] = new_path.relative_to(agent_root).as_posix()
            except Exception:
                # Leave the relative path alone; absolute path is sufficient.
                pass

    for message in messages:
        if not isinstance(message, dict):
            continue
        delivered = message.get("deliveredFiles")
        if isinstance(delivered, list):
            for file in delivered:
                _maybe_rewrite(file)
        edits = message.get("fileEdits")
        if isinstance(edits, list):
            for edit in edits:
                _maybe_rewrite(edit)


def build_webui_thread_response(
    session_key: str,
    *,
    augment_user_media: Callable[[list[str]], list[dict[str, Any]]] | None = None,
) -> dict[str, Any] | None:
    """Return a payload compatible with ``WebuiThreadPersistedPayload``."""
    lines = read_transcript_lines(session_key, compact_tool_events=True)
    if not lines:
        return None
    msgs = replay_transcript_to_ui_messages(lines, augment_user_media=augment_user_media)
    # Rewrite legacy artifact paths through the migration manifest so old
    # session cards still open after files have moved into workspace/output/.
    _resolve_legacy_artifact_paths(msgs)
    return {
        "schemaVersion": WEBUI_TRANSCRIPT_SCHEMA_VERSION,
        "sessionKey": session_key,
        "messages": msgs,
    }
