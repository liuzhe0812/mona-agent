"""Collect attributable user messages from workspace sessions.

The collector keeps deterministic counts separate from the bounded sample that
is suitable for an LLM prompt. Session metadata is only a candidate hint;
window membership is decided from the timestamp on each eligible user message.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from loguru import logger

from mona.agent.partners import conversation_from_session_metadata
from mona.session.manager import normalize_message_author
from mona.utils.helpers import estimate_prompt_tokens_chain

_MAX_SESSION_CHARS = 8000
_MAX_SESSIONS = 50
_MAX_MESSAGES = 200
_MAX_PREVIOUS_MESSAGES = 50
_MAX_MSG_CHARS = 1200
_DEFAULT_TIMEZONE = "Asia/Shanghai"
_TRUNCATION_MARKER = "\n...(truncated)...\n"


@dataclass
class SessionEvent:
    """One real user message with a stable, bounded source reference."""

    ref: str
    session_key: str
    message_index: int
    content: str
    content_hash: str
    occurred_at: str | None
    timestamp: str | None
    title: str
    truncated: bool
    window: str = ""
    message_id: str | None = None
    author_type: str = "user"
    conversation_type: str = "direct"
    agent_ids: list[str] = field(default_factory=list)
    direct_agent_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ref": self.ref,
            "session_key": self.session_key,
            "message_id": self.message_id,
            "message_index": self.message_index,
            "content": self.content,
            "content_hash": self.content_hash,
            "occurred_at": self.occurred_at,
            "timestamp": self.timestamp,
            "title": self.title,
            "truncated": self.truncated,
            "window": self.window,
            "author_type": self.author_type,
            "conversation_type": self.conversation_type,
            "agent_ids": self.agent_ids,
            "direct_agent_id": self.direct_agent_id,
        }


@dataclass
class SessionTopic:
    """A bounded prompt sample for one session and one time window."""

    title: str
    created_at: str
    updated_at: str
    user_messages: str
    tools_used: list[str]
    conversation_type: str = "direct"
    agent_ids: list[str] = field(default_factory=list)
    direct_agent_id: str | None = None
    hidden: bool = False
    background: bool = False
    session_key: str = ""
    window: str = ""
    message_events: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "user_messages": self.user_messages,
            "tools_used": self.tools_used,
            "conversation_type": self.conversation_type,
            "agent_ids": self.agent_ids,
            "direct_agent_id": self.direct_agent_id,
            "hidden": self.hidden,
            "background": self.background,
            "session_key": self.session_key,
            "window": self.window,
            "message_events": self.message_events,
        }


@dataclass
class SessionStats:
    """Deterministic session counts plus a bounded LLM candidate sample."""

    total_sessions: int = 0
    topics: list[SessionTopic] = field(default_factory=list)
    total_messages: int = 0
    message_events: list[dict[str, Any]] = field(default_factory=list)
    coverage: dict[str, Any] = field(default_factory=dict)
    windows: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Full eligible events stay internal to the collector/dashboard and are not
    # serialized into the prompt payload.
    all_events: list[dict[str, Any]] = field(default_factory=list, repr=False)
    window_events: dict[str, list[dict[str, Any]]] = field(default_factory=dict, repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_sessions": self.total_sessions,
            "total_messages": self.total_messages,
            "topics": [t.to_dict() for t in self.topics],
            "message_events": self.message_events,
            "coverage": self.coverage,
            "windows": self.windows,
        }


def _timezone(name: str) -> timezone | ZoneInfo:
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError):
        logger.warning("[session_collector] invalid timezone {!r}; using UTC", name)
        return timezone.utc


def _parse_timestamp_info(
    ts: str | datetime | None,
    timezone_name: str = _DEFAULT_TIMEZONE,
) -> tuple[datetime | None, bool]:
    """Parse a timestamp into UTC and report whether a timezone was assumed."""
    if ts is None or ts == "":
        return None, False
    if isinstance(ts, datetime):
        value = ts
    else:
        try:
            value = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        except (ValueError, AttributeError, TypeError):
            return None, False
    assumed = value.tzinfo is None
    if assumed:
        value = value.replace(tzinfo=_timezone(timezone_name))
    return value.astimezone(timezone.utc), assumed


def _parse_timestamp(ts: str | None) -> datetime | None:
    """Backward-compatible timestamp parser used by existing callers/tests."""
    return _parse_timestamp_info(ts)[0]


def _bound(value: datetime | None, timezone_name: str) -> datetime | None:
    return _parse_timestamp_info(value, timezone_name)[0] if value is not None else None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _truncate_with_flag(text: str, limit: int = _MAX_MSG_CHARS) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    if limit <= len(_TRUNCATION_MARKER):
        return text[:limit], True
    available = limit - len(_TRUNCATION_MARKER)
    left = available // 2
    right = available - left
    return text[:left] + _TRUNCATION_MARKER + text[-right:], True


def _truncate(text: str, limit: int = _MAX_MSG_CHARS) -> str:
    """Return a bounded head/tail excerpt (kept for existing imports)."""
    return _truncate_with_flag(text, limit)[0]


def _is_skip_file(filename: str) -> bool:
    """Skip temporary sessions and scheduled execution containers."""
    name = filename.lower()
    return (
        "ephemeral" in name
        or "cron_" in name
        or "cron-" in name
        or "schedule_" in name
        or "schedule-" in name
    )


def _metadata_payload(meta: dict[str, Any]) -> dict[str, Any]:
    value = meta.get("metadata")
    return value if isinstance(value, dict) else {}


def _is_background_session(filename: str, metadata: dict[str, Any]) -> bool:
    """Identify sessions created by background execution paths."""
    name = filename.lower()
    if any(
        token in name
        for token in ("ephemeral", "cron_", "cron-", "schedule_", "schedule-")
    ):
        return True
    for key in ("background", "is_background", "background_execution"):
        if metadata.get(key) is True:
            return True
    source = str(metadata.get("source") or metadata.get("trigger") or "").lower()
    return source in {"cron", "schedule", "scheduled", "background", "system"}


def _is_profile_user_message(
    message: dict[str, Any],
    agent_ids: set[str],
) -> bool:
    """Return whether a session record is an eligible user-profile signal."""
    if message.get("role") != "user":
        return False
    normalize_message_author(message)
    if message.get("author_type") != "user":
        return False
    if message.get("message_type") != "message":
        return False
    if message.get("_command") or message.get("_ui_only"):
        return False
    if message.get("injected_event"):
        return False
    origin = message.get("origin")
    message_metadata = message.get("metadata")
    if origin == "profile_advice" or (
        isinstance(message_metadata, dict) and message_metadata.get("origin") == "profile_advice"
    ):
        return False
    if any(
        message.get(key)
        for key in (
            "_internal",
            "internal",
            "is_internal",
            "job_id",
            "workflow_run_id",
            "workflow_step_id",
            "subagent_task_id",
        )
    ):
        return False
    author_id = message.get("author_id")
    return not isinstance(author_id, str) or author_id not in agent_ids


def _session_key(meta: dict[str, Any], session_file: Path) -> str:
    value = meta.get("key") or meta.get("session_key")
    return str(value or session_file.stem)


def _message_id(message: dict[str, Any]) -> str | None:
    for key in ("id", "message_id", "event_id"):
        value = message.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _stable_message_ref(
    session_key: str,
    message_id: str | None,
    message_index: int,
    timestamp: str | None,
    content_hash: str,
) -> str:
    identity = (
        "\x1f".join((session_key, message_id))
        if message_id
        else "\x1f".join((session_key, str(message_index), timestamp or "", content_hash))
    )
    return f"session-message:{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:32]}"


def _round_robin_sample(
    events: list[dict[str, Any]],
    max_sessions: int,
    max_messages: int,
) -> list[dict[str, Any]]:
    by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        by_session[str(event["session_key"])].append(event)
    for queue in by_session.values():
        queue.sort(key=lambda item: item.get("occurred_at") or "", reverse=True)
    latest = {
        key: (items[0].get("occurred_at") or "")
        for key, items in by_session.items()
    }
    selected_keys = sorted(by_session, key=lambda key: latest[key], reverse=True)[:max_sessions]
    result: list[dict[str, Any]] = []
    offset = 0
    while len(result) < max_messages:
        added = False
        for key in selected_keys:
            queue = by_session[key]
            if offset < len(queue):
                result.append(queue[offset])
                added = True
                if len(result) >= max_messages:
                    break
        if not added:
            break
        offset += 1
    return result


def _estimate_tokens(events: list[dict[str, Any]]) -> tuple[int, str]:
    messages = [{"role": "user", "content": str(event.get("content") or "")} for event in events]
    return estimate_prompt_tokens_chain(None, None, messages)


def _fit_token_budget(
    events: list[dict[str, Any]],
    max_input_tokens: int,
) -> tuple[list[dict[str, Any]], int, str]:
    selected = list(events)
    estimate, source = _estimate_tokens(selected)
    while len(selected) > 1 and estimate > max_input_tokens:
        selected.pop()
        estimate, source = _estimate_tokens(selected)
    if selected and estimate > max_input_tokens:
        selected = []
        estimate, source = 0, source
    return selected, estimate, source


def collect_session_topics(
    workspace: Path,
    since: datetime | None = None,
    max_sessions: int = _MAX_SESSIONS,
    *,
    until: datetime | None = None,
    periods: dict[str, tuple[datetime | None, datetime | None]] | None = None,
    max_messages: int = _MAX_MESSAGES,
    max_previous_messages: int = _MAX_PREVIOUS_MESSAGES,
    max_message_chars: int = _MAX_MSG_CHARS,
    max_input_tokens: int = 12000,
    timezone_name: str = _DEFAULT_TIMEZONE,
) -> SessionStats:
    """Scan sessions and return full counts plus a bounded round-robin sample.

    ``since``/``until`` preserve the original single-window API. ``periods``
    accepts named half-open windows such as ``{"current": (start, end),
    "previous": (old_start, start)}``; deterministic counts include every
    eligible event while only the bounded sample is exposed to prompt callers.
    """
    sessions_dir = workspace / "sessions"
    stats = SessionStats()
    if not sessions_dir.exists() or not sessions_dir.is_dir():
        stats.coverage = {
            "status": "unavailable",
            "scanned_count": 0,
            "selected_count": 0,
            "unknown_time_count": 0,
            "assumed_timezone_count": 0,
            "truncated_count": 0,
            "earliest": None,
            "latest": None,
            "reason_code": "sessions_unavailable",
        }
        return stats

    if periods is None:
        periods = (
            {"current": (since, until)}
            if since is not None or until is not None
            else {"all": (None, None)}
        )
    normalized_periods = {
        name: (_bound(start, timezone_name), _bound(end, timezone_name))
        for name, (start, end) in periods.items()
    }

    candidates: list[tuple[datetime, Path, dict[str, Any]]] = []
    scan_errors = 0
    for session_file in sessions_dir.glob("*.jsonl"):
        if _is_skip_file(session_file.name):
            continue
        try:
            with session_file.open("r", encoding="utf-8") as handle:
                first_line = handle.readline().strip()
            if not first_line:
                continue
            meta = json.loads(first_line)
            if meta.get("_type") != "metadata":
                continue
            updated = _parse_timestamp_info(meta.get("updated_at"), timezone_name)[0]
            if updated is None:
                scan_errors += 1
                continue
            candidates.append((updated, session_file, meta))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            scan_errors += 1

    candidates.sort(key=lambda item: (item[0], str(item[1])), reverse=True)
    all_events: list[dict[str, Any]] = []
    window_events: dict[str, list[dict[str, Any]]] = {name: [] for name in normalized_periods}
    tools_by_session: dict[str, set[str]] = defaultdict(set)
    session_meta: dict[tuple[str, str], dict[str, Any]] = {}
    unknown_time_count = 0
    assumed_timezone_count = 0
    earliest: datetime | None = None
    latest: datetime | None = None
    session_scanned = 0

    for _, session_file, meta in candidates:
        session_scanned += 1
        metadata = _metadata_payload(meta)
        conversation = conversation_from_session_metadata(metadata)
        background = _is_background_session(session_file.name, metadata)
        if conversation.hidden or background:
            continue
        session_key = _session_key(meta, session_file)
        title = conversation.title or metadata.get("title", "") or session_file.stem
        topic_meta = {
            "title": title,
            "created_at": str(meta.get("created_at", "")),
            "updated_at": str(meta.get("updated_at", "")),
            "tools_used": tools_by_session[session_key],
            "conversation_type": conversation.type,
            "agent_ids": list(conversation.agent_ids),
            "direct_agent_id": conversation.direct_agent_id,
            "hidden": conversation.hidden,
            "background": background,
        }
        agent_ids = set(conversation.agent_ids)
        seen_source_ids: set[str] = set()
        try:
            with session_file.open("r", encoding="utf-8") as handle:
                message_index = -1
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        message = json.loads(line)
                    except json.JSONDecodeError:
                        scan_errors += 1
                        continue
                    if message.get("_type") == "metadata":
                        continue
                    message_index += 1
                    normalize_message_author(message)
                    if message.get("author_type") == "agent" and message.get("role") == "assistant":
                        for tool_call in message.get("tool_calls") or []:
                            function = tool_call.get("function", {}) if isinstance(tool_call, dict) else {}
                            name = function.get("name") if isinstance(function, dict) else None
                            if name:
                                tools_by_session[session_key].add(str(name))
                    if not _is_profile_user_message(message, agent_ids):
                        continue
                    raw_content = message.get("content", "")
                    if not isinstance(raw_content, str) or not raw_content.strip():
                        continue
                    timestamp = message.get("timestamp")
                    occurred, assumed = _parse_timestamp_info(timestamp, timezone_name)
                    if assumed:
                        assumed_timezone_count += 1
                    if occurred is None and any(
                        start is not None or end is not None
                        for start, end in normalized_periods.values()
                    ):
                        unknown_time_count += 1
                        continue
                    if occurred is not None:
                        earliest = occurred if earliest is None else min(earliest, occurred)
                        latest = occurred if latest is None else max(latest, occurred)
                    source_id = _message_id(message)
                    if source_id and source_id in seen_source_ids:
                        continue
                    if source_id:
                        seen_source_ids.add(source_id)
                    content_hash = hashlib.sha256(raw_content.encode("utf-8")).hexdigest()
                    excerpt, truncated = _truncate_with_flag(raw_content, max_message_chars)
                    ref = _stable_message_ref(session_key, source_id, message_index, timestamp, content_hash)
                    event_base = {
                        "ref": ref,
                        "session_key": session_key,
                        "message_id": source_id,
                        "message_index": message_index,
                        "content": excerpt,
                        "content_hash": content_hash,
                        "occurred_at": _iso(occurred),
                        "timestamp": str(timestamp) if timestamp is not None else None,
                        "title": title,
                        "truncated": truncated,
                        "author_type": "user",
                        "conversation_type": conversation.type,
                        "agent_ids": list(conversation.agent_ids),
                        "direct_agent_id": conversation.direct_agent_id,
                    }
                    all_events.append(event_base)
                    for name, (start, end) in normalized_periods.items():
                        if occurred is None:
                            include = start is None and end is None
                        else:
                            include = (start is None or occurred >= start) and (
                                end is None or occurred < end
                            )
                        if include:
                            event = dict(event_base)
                            event["window"] = name
                            window_events[name].append(event)
                            session_meta[(name, session_key)] = topic_meta
        except OSError:
            scan_errors += 1

    sampled_events: list[dict[str, Any]] = []
    for name in normalized_periods:
        limit = max_previous_messages if name.lower() == "previous" else max_messages
        sampled_events.extend(_round_robin_sample(window_events[name], max_sessions, limit))

    sampled_events, input_tokens_estimate, input_tokens_source = _fit_token_budget(
        sampled_events,
        max(1, max_input_tokens),
    )
    for name in normalized_periods:
        full_events = window_events[name]
        session_keys = {str(event["session_key"]) for event in full_events}
        dates = sorted(
            {
                datetime.fromisoformat(event["occurred_at"])
                .astimezone(_timezone(timezone_name))
                .date()
                .isoformat()
                for event in full_events
                if event.get("occurred_at")
            }
        )
        window_sample = [event for event in sampled_events if event.get("window") == name]
        window_tokens, window_token_source = _estimate_tokens(window_sample)
        stats.windows[name] = {
            "total_sessions": len(session_keys),
            "total_messages": len(full_events),
            "active_dates": dates,
            "sampled_sessions": len({str(event["session_key"]) for event in window_sample}),
            "sampled_messages": len(window_sample),
            "input_tokens_estimate": window_tokens,
            "input_tokens_source": window_token_source,
        }

    stats.all_events = all_events
    stats.window_events = window_events
    selected_events = {
        str(event["ref"]): event
        for events in window_events.values()
        for event in events
    }
    stats.total_messages = len(selected_events)
    stats.total_sessions = len({str(event["session_key"]) for event in selected_events.values()})
    stats.message_events = sampled_events
    stats.coverage = {
        "status": "partial" if scan_errors else "available",
        "scanned_count": session_scanned,
        "selected_count": len({str(event["session_key"]) for event in sampled_events}),
        "selected_message_count": len(sampled_events),
        "input_tokens_estimate": input_tokens_estimate,
        "input_tokens_source": input_tokens_source,
        "unknown_time_count": unknown_time_count,
        "assumed_timezone_count": assumed_timezone_count,
        "truncated_count": sum(1 for event in sampled_events if event.get("truncated")),
        "earliest": _iso(earliest),
        "latest": _iso(latest),
        "reason_code": "session_parse_partial" if scan_errors else None,
    }

    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for event in sampled_events:
        grouped[(str(event.get("window") or "all"), str(event["session_key"]))].append(event)
    for (window, session_key), events in grouped.items():
        meta = session_meta.get((window, session_key), {})
        events.sort(key=lambda event: event.get("occurred_at") or "", reverse=True)
        text, _ = _truncate_with_flag(
            "\n---\n".join(str(event.get("content") or "") for event in events),
            _MAX_SESSION_CHARS,
        )
        stats.topics.append(
            SessionTopic(
                title=str(meta.get("title") or session_key),
                created_at=str(meta.get("created_at") or ""),
                updated_at=str(meta.get("updated_at") or ""),
                user_messages=text,
                tools_used=sorted(meta.get("tools_used") or set()),
                conversation_type=str(meta.get("conversation_type") or "direct"),
                agent_ids=list(meta.get("agent_ids") or []),
                direct_agent_id=meta.get("direct_agent_id"),
                hidden=bool(meta.get("hidden")),
                background=bool(meta.get("background")),
                session_key=session_key,
                window=window,
                message_events=events,
            )
        )
    stats.topics.sort(key=lambda topic: (topic.updated_at, topic.session_key), reverse=True)
    window_order = {name: index for index, name in enumerate(normalized_periods)}
    stats.topics.sort(key=lambda topic: window_order.get(topic.window, len(window_order)))
    logger.debug(
        "[session_collector] extracted {} sessions and {} messages ({} sampled)",
        stats.total_sessions,
        stats.total_messages,
        len(stats.message_events),
    )
    return stats
