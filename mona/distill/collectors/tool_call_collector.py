"""Tool call history collector.

Scans session JSONL files and aggregates tool call patterns.
Session format: OpenAI-compatible (assistant messages carry `tool_calls`
array, tool results are `role: "tool"` messages with `tool_call_id`).
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger


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
    success_map: dict[str, dict[str, int]] = defaultdict(lambda: {"success": 0, "total": 0})
    earliest: datetime | None = None
    latest: datetime | None = None
    total_calls = 0
    sessions_scanned = 0

    for session_file in sessions_dir.glob("*.jsonl"):
        try:
            calls_in_session: list[tuple[str, str]] = []  # (tool_name, timestamp)
            tool_results: dict[str, str] = {}  # tool_call_id → content

            with session_file.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    # Skip metadata line
                    if msg.get("_type") == "metadata":
                        continue

                    role = msg.get("role")
                    ts = _parse_timestamp(msg.get("timestamp"))

                    # Apply time filter
                    if ts and (since and ts < since):
                        continue
                    if ts and (until and ts > until):
                        continue

                    if ts:
                        if earliest is None or ts < earliest:
                            earliest = ts
                        if latest is None or ts > latest:
                            latest = ts

                    # Assistant message with tool_calls
                    if role == "assistant" and "tool_calls" in msg:
                        tool_calls = msg.get("tool_calls") or []
                        for tc in tool_calls:
                            func = tc.get("function", {}) if isinstance(tc, dict) else {}
                            name = func.get("name", "unknown")
                            tool_counter[name] += 1
                            total_calls += 1
                            success_map[name]["total"] += 1
                            calls_in_session.append((name, msg.get("timestamp", "")))
                            if ts:
                                hourly[ts.hour] += 1
                                daily[ts.strftime("%Y-%m-%d")] += 1

                    # Tool result message
                    if role == "tool" and "tool_call_id" in msg:
                        tc_id = msg["tool_call_id"]
                        content = msg.get("content", "")
                        tool_results[tc_id] = content
                        name = msg.get("name", "unknown")
                        if name in success_map:
                            if _is_error_content(content):
                                success_map[name]["success"] = max(0, success_map[name]["success"])
                            else:
                                success_map[name]["success"] += 1

            # Build chains from this session
            if len(calls_in_session) >= 2:
                for i in range(len(calls_in_session) - 1):
                    chain = " → ".join(
                        calls_in_session[j][0]
                        for j in range(i, min(i + 3, len(calls_in_session)))
                    )
                    chain_counter[chain] += 1

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
    stats.tool_success = {
        tool: counts for tool, counts in success_map.items()
    }
    stats.earliest = earliest.isoformat() if earliest else None
    stats.latest = latest.isoformat() if latest else None

    logger.debug(
        f"[tool_call_collector] scanned {sessions_scanned} sessions, "
        f"{total_calls} tool calls, {len(tool_counter)} unique tools"
    )
    return stats
