"""Pure, deterministic dashboard aggregation for the user profile."""

from __future__ import annotations

import hashlib
import os
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from mona.distill.collectors.notes_collector import collect_notes_stats
from mona.distill.collectors.session_collector import SessionStats, collect_session_topics

_DEFAULT_TIMEZONE = "Asia/Shanghai"
_DEFAULT_WINDOW_DAYS = 30


def _timezone(name: str) -> timezone | ZoneInfo:
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError):
        return timezone.utc


def _as_utc(value: datetime, timezone_name: str) -> datetime:
    if value.tzinfo is None:
        value = value.replace(tzinfo=_timezone(timezone_name))
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return value.isoformat()


def compute_source_scope_id(workspace: Path, notes_vault: Path | None) -> str:
    """Return an opaque, stable hash for the configured source roots."""
    roots = [os.path.normcase(str(workspace.resolve()))]
    roots.append(os.path.normcase(str(notes_vault.resolve())) if notes_vault else "<no-notes>")
    payload = "\n".join(roots).encode("utf-8")
    return f"scope:{hashlib.sha256(payload).hexdigest()[:32]}"


def _metric(value: int | None, availability: str = "available") -> dict[str, Any]:
    return {"value": value, "availability": availability}


def _unique_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for event in events:
        ref = str(event.get("ref") or "")
        if not ref or ref in seen:
            continue
        seen.add(ref)
        result.append(event)
    return result


def _session_window_metrics(
    stats: SessionStats,
    name: str,
    timezone_name: str,
) -> dict[str, int]:
    events = _unique_events(stats.window_events.get(name, []))
    sessions = {str(event.get("session_key")) for event in events if event.get("session_key")}
    dates: set[str] = set()
    tz = _timezone(timezone_name)
    for event in events:
        occurred = event.get("occurred_at")
        if not occurred:
            continue
        try:
            dates.add(datetime.fromisoformat(str(occurred)).astimezone(tz).date().isoformat())
        except ValueError:
            continue
    return {
        "active_conversations": len(sessions),
        "user_messages": len(events),
        "active_dates": len(dates),
    }


def _has_previous_observation(stats: SessionStats, previous_start: datetime) -> bool:
    earliest = stats.coverage.get("earliest")
    if not earliest:
        return False
    try:
        return datetime.fromisoformat(str(earliest)) < previous_start
    except ValueError:
        return False


def _build_metric_bundle(
    current: dict[str, int],
    previous: dict[str, int],
    *,
    current_available: bool,
    previous_available: bool,
    current_partial: bool = False,
) -> dict[str, Any]:
    metrics: dict[str, Any] = {}
    for name in ("active_conversations", "user_messages", "active_dates"):
        current_value = current[name] if current_available else None
        previous_value = previous[name] if previous_available else None
        metrics[name] = {
            "current": _metric(
                current_value,
                "partial" if current_partial else ("available" if current_available else "unavailable"),
            ),
            "previous": _metric(previous_value, "available" if previous_available else "unavailable"),
            "delta": current_value - previous_value
            if current_value is not None and previous_value is not None
            else None,
        }
    metrics["generated_artifacts"] = {
        "current": _metric(None, "unavailable"),
        "previous": _metric(None, "unavailable"),
        "delta": None,
    }
    return metrics


def _daily_activity(stats: SessionStats, timezone_name: str) -> list[dict[str, Any]]:
    counts: Counter[str] = Counter()
    for event in _unique_events(stats.window_events.get("current", [])):
        occurred = event.get("occurred_at")
        if not occurred:
            continue
        try:
            date = datetime.fromisoformat(str(occurred)).astimezone(_timezone(timezone_name)).date()
        except ValueError:
            continue
        counts[date.isoformat()] += 1
    return [{"date": date, "user_messages": counts[date]} for date in sorted(counts)]


def _coverage(source: str, payload: dict[str, Any], *, reason: str | None = None) -> dict[str, Any]:
    result = {
        "source": source,
        "status": payload.get("status", "unavailable"),
        "scanned_count": int(payload.get("scanned_count", 0) or 0),
        "selected_count": int(payload.get("selected_count", 0) or 0),
        "unknown_time_count": int(payload.get("unknown_time_count", 0) or 0),
        "assumed_timezone_count": int(payload.get("assumed_timezone_count", 0) or 0),
        "truncated_count": int(payload.get("truncated_count", 0) or 0),
        "earliest": payload.get("earliest"),
        "latest": payload.get("latest"),
        "reason_code": reason if reason is not None else payload.get("reason_code"),
    }
    return result


def _evidence_excerpt(value: Any, limit: int = 600) -> tuple[str, bool]:
    text = str(value or "")
    return text[:limit], len(text) > limit


def build_dashboard(
    workspace: Path,
    notes_vault: Path | None,
    *,
    as_of: datetime | None = None,
    timezone_name: str = _DEFAULT_TIMEZONE,
    window_days: int = _DEFAULT_WINDOW_DAYS,
    max_evidence_sessions: int = 50,
    max_evidence_messages: int = 200,
    max_message_chars: int = 1200,
    max_input_tokens: int = 12000,
    source_scope_id: str | None = None,
) -> dict[str, Any]:
    """Build current/previous 30-day deterministic profile dashboard data."""
    if window_days <= 0:
        raise ValueError("window_days must be positive")
    as_of_utc = _as_utc(as_of or datetime.now(timezone.utc), timezone_name)
    current_start = as_of_utc - timedelta(days=window_days)
    previous_start = as_of_utc - timedelta(days=2 * window_days)
    periods = {
        "current": (current_start, as_of_utc),
        "previous": (previous_start, current_start),
    }
    sessions = collect_session_topics(
        workspace,
        periods=periods,
        max_sessions=max_evidence_sessions,
        max_messages=max_evidence_messages,
        max_message_chars=max_message_chars,
        max_input_tokens=max_input_tokens,
        timezone_name=timezone_name,
    )
    current_notes = collect_notes_stats(
        notes_vault,
        since=current_start,
        until=as_of_utc,
        timezone_name=timezone_name,
    )
    previous_notes = collect_notes_stats(
        notes_vault,
        since=previous_start,
        until=current_start,
        timezone_name=timezone_name,
    )
    scope_id = source_scope_id or compute_source_scope_id(workspace, notes_vault)
    current_metrics = _session_window_metrics(sessions, "current", timezone_name)
    previous_metrics = _session_window_metrics(sessions, "previous", timezone_name)
    previous_available = _has_previous_observation(sessions, previous_start)
    session_available = sessions.coverage.get("status") != "unavailable"
    session_partial = sessions.coverage.get("status") == "partial"

    session_coverage = _coverage("sessions", sessions.coverage)
    session_coverage["current"] = sessions.windows.get("current", {})
    session_coverage["previous"] = sessions.windows.get("previous", {})
    notes_coverage = _coverage("notes", current_notes.coverage)
    notes_coverage["previous"] = previous_notes.coverage
    artifact_coverage = _coverage(
        "artifacts",
        {"status": "unavailable", "reason_code": "artifact_collector_unavailable"},
    )
    agent_execution_coverage = _coverage(
        "agent_execution",
        {"status": "unavailable", "reason_code": "agent_execution_not_collected"},
    )
    comparison_reason = None if previous_available else "no_previous_observation"
    if not session_available:
        comparison_reason = "sessions_unavailable"
    elif session_partial or current_notes.coverage.get("status") == "partial":
        comparison_reason = "partial_source"

    selected_session_records = []
    selected_session_evidence = []
    for event in sessions.message_events:
        excerpt, excerpt_truncated = _evidence_excerpt(event.get("content"))
        selected_session_records.append(
            {
                **event,
                "kind": "user_message",
                "source_scope_id": scope_id,
                "excerpt": excerpt,
                "truncated": bool(event.get("truncated")) or excerpt_truncated,
            }
        )
        selected_session_evidence.append(
            {
                "ref": event.get("ref"),
                "kind": "user_message",
                "source_scope_id": scope_id,
                "title": event.get("title", ""),
                "occurred_at": event.get("occurred_at"),
                "excerpt": excerpt,
                "truncated": bool(event.get("truncated")) or excerpt_truncated,
                "session_key": event.get("session_key"),
                "message_id": event.get("message_id"),
                "message_index": event.get("message_index"),
                "content_hash": event.get("content_hash", ""),
            }
        )
    selected_note_records = []
    selected_note_evidence = []
    for record in current_notes.records:
        excerpt, excerpt_truncated = _evidence_excerpt(record.get("title"))
        selected_note_records.append(
            {
                **record,
                "kind": "note",
                "source_scope_id": scope_id,
                "window": "current",
                "note_relative_path": record.get("relative_path"),
                "excerpt": excerpt,
                "truncated": excerpt_truncated,
            }
        )
        selected_note_evidence.append(
            {
                "ref": record.get("ref"),
                "kind": "note",
                "source_scope_id": scope_id,
                "title": record.get("title", ""),
                "occurred_at": record.get("occurred_at"),
                "excerpt": excerpt,
                "truncated": excerpt_truncated,
                "note_relative_path": record.get("relative_path"),
                "content_hash": record.get("content_hash", ""),
            }
        )
    selected_previous_note_records = []
    selected_previous_note_evidence = []
    for record in previous_notes.records:
        excerpt, excerpt_truncated = _evidence_excerpt(record.get("title"))
        selected_previous_note_records.append(
            {
                **record,
                "kind": "note",
                "source_scope_id": scope_id,
                "window": "previous",
                "note_relative_path": record.get("relative_path"),
                "excerpt": excerpt,
                "truncated": excerpt_truncated,
            }
        )
        selected_previous_note_evidence.append(
            {
                "ref": record.get("ref"),
                "kind": "note",
                "source_scope_id": scope_id,
                "title": record.get("title", ""),
                "occurred_at": record.get("occurred_at"),
                "excerpt": excerpt,
                "truncated": excerpt_truncated,
                "note_relative_path": record.get("relative_path"),
                "content_hash": record.get("content_hash", ""),
            }
        )
    return {
        "as_of": _iso(as_of_utc.astimezone(_timezone(timezone_name))),
        "window_start": _iso(current_start.astimezone(_timezone(timezone_name))),
        "window_end": _iso(as_of_utc.astimezone(_timezone(timezone_name))),
        "previous_start": _iso(previous_start.astimezone(_timezone(timezone_name))),
        "previous_end": _iso(current_start.astimezone(_timezone(timezone_name))),
        "source_scope_id": scope_id,
        "timezone": timezone_name,
        "metrics": _build_metric_bundle(
            current_metrics,
            previous_metrics,
            current_available=session_available,
            previous_available=previous_available,
            current_partial=session_partial,
        ),
        "comparison_available": session_available and previous_available and not session_partial,
        "comparison_reason": comparison_reason,
        "coverage": [session_coverage, notes_coverage, artifact_coverage, agent_execution_coverage],
        "daily_activity": _daily_activity(sessions, timezone_name),
        "topic_records": {
            "notes": selected_note_records,
            "previous_notes": selected_previous_note_records,
            "sessions": selected_session_records,
        },
        "selected_evidence": [
            *selected_session_evidence,
            *selected_note_evidence,
            *selected_previous_note_evidence,
        ],
        "source_stats": {
            "notes_current": current_notes.to_dict(),
            "notes_previous": previous_notes.to_dict(),
            "notes_current_all_records": list(current_notes.all_records),
            "notes_previous_all_records": list(previous_notes.all_records),
            "sessions": sessions.to_dict(),
            "visible_session_keys": sorted(
                {
                    str(event.get("session_key"))
                    for event in sessions.all_events
                    if event.get("session_key")
                }
            ),
            "current_events": list(sessions.window_events.get("current", [])),
            "previous_events": list(sessions.window_events.get("previous", [])),
            "all_user_events": list(sessions.all_events),
        },
    }


build_profile_dashboard = build_dashboard


__all__ = ["build_dashboard", "build_profile_dashboard", "compute_source_scope_id"]
