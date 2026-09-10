"""Tool call history collector.

Scans session JSONL files and aggregates tool call patterns. Statistics retain
the historical aggregate fields, while adding explicit agent and execution
attribution so agent activity is never silently presented as a user
preference.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from mona.agent.partners import MONA_AGENT_ID, conversation_from_session_metadata
from mona.session.manager import normalize_message_author


@dataclass
class ToolCallStats:
    """Aggregated tool call statistics."""

    total_sessions: int = 0
    total_calls: int = 0
    # Top N tools by frequency: [{tool, count}]
    top_tools: list[dict[str, Any]] = field(default_factory=list)
    # Tool call chains (A→B→C within same session): [{chain, count}]
    tool_chains: list[dict[str, Any]] = field(default_factory=list)
    # Hourly distribution: {hour: count} (0-23)
    hourly_distribution: dict[str, int] = field(default_factory=dict)
    # Daily distribution: {YYYY-MM-DD: count}
    daily_distribution: dict[str, int] = field(default_factory=dict)
    # Success rate per tool: {tool: {success, total}}
    tool_success: dict[str, dict[str, int]] = field(default_factory=dict)
    # Time range of scanned data
    earliest: str | None = None
    latest: str | None = None
    # Attribution dimensions. ``top_tools`` above remains a compatibility
    # aggregate and is explicitly marked as agent execution data below.
    by_agent: dict[str, dict[str, Any]] = field(default_factory=dict)
    by_conversation_type: dict[str, dict[str, Any]] = field(default_factory=dict)
    attributions: list[dict[str, Any]] = field(default_factory=list)
    tool_usage_scope: str = "agent_execution"
    user_preference_tools: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_sessions": self.total_sessions,
            "total_calls": self.total_calls,
            "top_tools": self.top_tools,
            "tool_chains": self.tool_chains,
            "hourly_distribution": self.hourly_distribution,
            "daily_distribution": self.daily_distribution,
            "tool_success": self.tool_success,
            "earliest": self.earliest,
            "latest": self.latest,
            "by_agent": self.by_agent,
            "by_conversation_type": self.by_conversation_type,
            "attributions": self.attributions,
            "tool_usage_scope": self.tool_usage_scope,
            # Tool usage is evidence of execution, not a user preference.
            "user_preference_tools": self.user_preference_tools,
        }


def _parse_timestamp(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _is_error_content(content: str) -> bool:
    """Heuristic: tool result containing 'Error:' is treated as failure."""
    if not isinstance(content, str):
        return False
    lowered = content.lstrip().lower()
    return lowered.startswith("error") or lowered.startswith("exception")


def _metadata_payload(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _is_background_session(filename: str, metadata: dict[str, Any]) -> bool:
    """Identify scheduled/ephemeral execution without hiding it from stats."""
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


def _text_id(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _new_bucket() -> dict[str, Any]:
    """Create an internal aggregate bucket (Counters are serialized later)."""
    return {
        "total_calls": 0,
        "tool_counter": Counter(),
        "chain_counter": Counter(),
        "hourly": Counter(),
        "daily": Counter(),
        "success_map": defaultdict(lambda: {"success": 0, "total": 0}),
        "sessions": set(),
    }


def _record_call(
    bucket: dict[str, Any],
    name: str,
    timestamp: datetime | None,
    session_name: str,
) -> None:
    bucket["total_calls"] += 1
    bucket["tool_counter"][name] += 1
    bucket["success_map"][name]["total"] += 1
    bucket["sessions"].add(session_name)
    if timestamp is not None:
        bucket["hourly"][timestamp.hour] += 1
        bucket["daily"][timestamp.strftime("%Y-%m-%d")] += 1


def _record_success(bucket: dict[str, Any], name: str, content: Any) -> None:
    if not _is_error_content(content):
        bucket["success_map"][name]["success"] += 1


def _record_success_map(
    success_map: dict[str, dict[str, int]], name: str, content: Any
) -> None:
    if not _is_error_content(content):
        success_map[name]["success"] += 1


def _serialize_bucket(
    bucket: dict[str, Any],
    *,
    top_n: int,
    chain_n: int,
) -> dict[str, Any]:
    return {
        "total_sessions": len(bucket["sessions"]),
        "total_calls": bucket["total_calls"],
        "top_tools": [
            {"tool": name, "count": count}
            for name, count in bucket["tool_counter"].most_common(top_n)
        ],
        "tool_chains": [
            {"chain": chain, "count": count}
            for chain, count in bucket["chain_counter"].most_common(chain_n)
        ],
        "hourly_distribution": {
            str(hour): bucket["hourly"][hour]
            for hour in range(24)
            if bucket["hourly"][hour] > 0
        },
        "daily_distribution": dict(bucket["daily"].most_common(30)),
        "tool_success": {
            tool: dict(counts) for tool, counts in bucket["success_map"].items()
        },
    }


def collect_tool_calls(
    workspace: Path,
    since: datetime | None = None,
    until: datetime | None = None,
    top_n: int = 15,
    chain_n: int = 10,
) -> ToolCallStats:
    """Scan session files and aggregate tool call statistics.

    Args:
        workspace: workspace root containing sessions/ dir
        since: optional start time filter
        until: optional end time filter
        top_n: number of top tools to return
        chain_n: number of top tool chains to return
    """
    sessions_dir = workspace / "sessions"
    stats = ToolCallStats()

    if not sessions_dir.exists():
        logger.debug("[tool_call_collector] no sessions dir")
        return stats

    tool_counter: Counter[str] = Counter()
    chain_counter: Counter[str] = Counter()
    hourly: Counter[int] = Counter()
    daily: Counter[str] = Counter()
    success_map: dict[str, dict[str, int]] = defaultdict(
        lambda: {"success": 0, "total": 0}
    )
    agent_buckets: dict[str, dict[str, Any]] = {}
    conversation_buckets: dict[str, dict[str, Any]] = {}
    attribution_buckets: dict[tuple[str, str, bool, bool, str | None, str | None], dict[str, Any]] = {}
    earliest: datetime | None = None
    latest: datetime | None = None
    total_calls = 0
    sessions_scanned = 0

    for session_file in sessions_dir.glob("*.jsonl"):
        try:
            calls_in_session: list[
                tuple[str, tuple[str, str, bool, bool, str | None, str | None]]
            ] = []
            # tool_call_id → (tool_name, agent_id, attribution key)
            tool_records: dict[
                str, tuple[str, str, tuple[str, str, bool, bool, str | None, str | None]]
            ] = {}
            session_metadata: dict[str, Any] = {}
            conversation = conversation_from_session_metadata(session_metadata)
            background = _is_background_session(session_file.name, session_metadata)

            with session_file.open("r", encoding="utf-8") as f:
                for line_number, line in enumerate(f, start=1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if not isinstance(msg, dict):
                        continue
                    if msg.get("_type") == "metadata":
                        session_metadata = _metadata_payload(msg.get("metadata"))
                        conversation = conversation_from_session_metadata(session_metadata)
                        background = _is_background_session(session_file.name, session_metadata)
                        continue

                    raw_role = msg.get("role")
                    raw_author_id = _text_id(msg.get("author_id"))
                    normalize_message_author(msg)
                    ts = _parse_timestamp(msg.get("timestamp"))

                    # Apply time filter.
                    if ts and (since and ts < since):
                        continue
                    if ts and (until and ts > until):
                        continue

                    if ts:
                        if earliest is None or ts < earliest:
                            earliest = ts
                        if latest is None or ts > latest:
                            latest = ts

                    # Tool calls are attributed from persisted author fields,
                    # never from model-supplied tool arguments. Legacy direct
                    # partner sessions can recover their partner from the
                    # conversation metadata when author_id was not persisted.
                    if (
                        raw_role == "assistant"
                        and msg.get("author_type") == "agent"
                        and "tool_calls" in msg
                    ):
                        agent_id = _text_id(msg.get("author_id"))
                        if (
                            not raw_author_id
                            and conversation.type == "direct"
                            and conversation.direct_agent_id
                        ):
                            agent_id = conversation.direct_agent_id
                        agent_id = agent_id or MONA_AGENT_ID
                        job_id = _text_id(msg.get("job_id")) or _text_id(
                            session_metadata.get("job_id")
                        )
                        workflow_run_id = _text_id(msg.get("workflow_run_id")) or _text_id(
                            session_metadata.get("workflow_run_id")
                        )
                        hidden = bool(conversation.hidden)
                        is_background = bool(background or hidden or job_id or workflow_run_id)
                        attribution_key = (
                            agent_id,
                            conversation.type,
                            hidden,
                            is_background,
                            job_id,
                            workflow_run_id,
                        )
                        tool_calls = msg.get("tool_calls") or []
                        if not isinstance(tool_calls, list):
                            tool_calls = []
                        for index, tc in enumerate(tool_calls):
                            func = tc.get("function", {}) if isinstance(tc, dict) else {}
                            name = (
                                _text_id(func.get("name"))
                                if isinstance(func, dict)
                                else None
                            ) or "unknown"
                            agent_bucket = agent_buckets.setdefault(agent_id, _new_bucket())
                            type_bucket = conversation_buckets.setdefault(
                                conversation.type, _new_bucket()
                            )
                            attribution_bucket = attribution_buckets.setdefault(
                                attribution_key, _new_bucket()
                            )
                            agent_bucket.setdefault("conversation_types", Counter())[conversation.type] += 1
                            if hidden:
                                agent_bucket["hidden_calls"] = agent_bucket.get("hidden_calls", 0) + 1
                            if is_background:
                                agent_bucket["background_calls"] = agent_bucket.get("background_calls", 0) + 1
                            type_bucket.setdefault("agent_ids", set()).add(agent_id)
                            if hidden:
                                type_bucket["hidden_calls"] = type_bucket.get("hidden_calls", 0) + 1
                            if is_background:
                                type_bucket["background_calls"] = type_bucket.get("background_calls", 0) + 1
                            _record_call(agent_bucket, name, ts, session_file.name)
                            _record_call(type_bucket, name, ts, session_file.name)
                            _record_call(attribution_bucket, name, ts, session_file.name)
                            tool_counter[name] += 1
                            total_calls += 1
                            success_map[name]["total"] += 1
                            calls_in_session.append((name, attribution_key))
                            call_id = _text_id(tc.get("id")) if isinstance(tc, dict) else None
                            call_id = call_id or f"{session_file.name}:{line_number}:{index}"
                            tool_records[call_id] = (name, agent_id, attribution_key)
                            if ts:
                                hourly[ts.hour] += 1
                                daily[ts.strftime("%Y-%m-%d")] += 1

                    # Tool results update the exact call bucket when possible.
                    if raw_role == "tool" and "tool_call_id" in msg:
                        call_id = _text_id(msg.get("tool_call_id"))
                        record = tool_records.get(call_id or "")
                        content = msg.get("content", "")
                        if record is not None:
                            name, _agent_id, attribution_key = record
                            _record_success_map(success_map, name, content)
                            _record_success(agent_buckets[attribution_key[0]], name, content)
                            _record_success(
                                conversation_buckets[attribution_key[1]], name, content
                            )
                            _record_success(attribution_buckets[attribution_key], name, content)
                        else:
                            name = _text_id(msg.get("name")) or "unknown"
                            if name in success_map:
                                _record_success_map(success_map, name, content)

            # Build chains from this session for the compatibility aggregate;
            # grouped chains are recorded only when adjacent calls share the
            # same attribution dimensions.
            if len(calls_in_session) >= 2:
                for i in range(len(calls_in_session) - 1):
                    end = min(i + 3, len(calls_in_session))
                    chain = " → ".join(calls_in_session[j][0] for j in range(i, end))
                    chain_counter[chain] += 1
                    keys = [calls_in_session[j][1] for j in range(i, end)]
                    if len(set(keys)) == 1:
                        key = keys[0]
                        attribution_buckets[key]["chain_counter"][chain] += 1
                        agent_buckets[key[0]]["chain_counter"][chain] += 1
                        conversation_buckets[key[1]]["chain_counter"][chain] += 1

            sessions_scanned += 1

        except Exception as e:
            logger.debug(f"[tool_call_collector] failed to read {session_file.name}: {e}")

    stats.total_sessions = sessions_scanned
    stats.total_calls = total_calls
    stats.top_tools = [
        {"tool": name, "count": count}
        for name, count in tool_counter.most_common(top_n)
    ]
    stats.tool_chains = [
        {"chain": chain, "count": count}
        for chain, count in chain_counter.most_common(chain_n)
    ]
    stats.hourly_distribution = {str(h): hourly[h] for h in range(24) if hourly[h] > 0}
    stats.daily_distribution = dict(daily.most_common(30))
    stats.tool_success = {tool: dict(counts) for tool, counts in success_map.items()}
    stats.earliest = earliest.isoformat() if earliest else None
    stats.latest = latest.isoformat() if latest else None

    stats.by_agent = {}
    for agent_id, bucket in sorted(agent_buckets.items()):
        stats.by_agent[agent_id] = {
            "agent_id": agent_id,
            "usage_scope": "agent_execution",
            **_serialize_bucket(bucket, top_n=top_n, chain_n=chain_n),
            "conversation_types": dict(bucket.get("conversation_types", {})),
            "hidden_calls": bucket.get("hidden_calls", 0),
            "background_calls": bucket.get("background_calls", 0),
        }

    stats.by_conversation_type = {}
    for conversation_type, bucket in sorted(conversation_buckets.items()):
        stats.by_conversation_type[conversation_type] = {
            "conversation_type": conversation_type,
            "usage_scope": "agent_execution",
            **_serialize_bucket(bucket, top_n=top_n, chain_n=chain_n),
            "agent_ids": sorted(bucket.get("agent_ids", set())),
            "hidden_calls": bucket.get("hidden_calls", 0),
            "background_calls": bucket.get("background_calls", 0),
        }

    stats.attributions = []
    for key, bucket in sorted(
        attribution_buckets.items(),
        key=lambda item: tuple("" if part is None else str(part) for part in item[0]),
    ):
        agent_id, conversation_type, hidden, is_background, job_id, workflow_run_id = key
        source = (
            "workflow"
            if workflow_run_id
            else "job"
            if job_id
            else "hidden"
            if hidden
            else "background"
            if is_background
            else "interactive"
        )
        stats.attributions.append({
            "agent_id": agent_id,
            "conversation_type": conversation_type,
            "hidden": hidden,
            "background": is_background,
            "source": source,
            "job_id": job_id,
            "workflow_run_id": workflow_run_id,
            "usage_scope": "agent_execution",
            **_serialize_bucket(bucket, top_n=top_n, chain_n=chain_n),
        })

    logger.debug(
        f"[tool_call_collector] scanned {sessions_scanned} sessions, "
        f"{total_calls} tool calls, {len(tool_counter)} unique tools"
    )
    return stats
