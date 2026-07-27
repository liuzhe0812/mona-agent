"""Session topic collector.

Scans session JSONL files and extracts conversation content (user messages +
assistant reasoning) for topic distillation. Unlike tool_call_collector which
only counts tool usage, this reads the actual conversation text.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

# 单 session 文本截断上限（字符）
_MAX_SESSION_CHARS = 8000
# 最多扫描的 session 数量
_MAX_SESSIONS = 50
# 单条消息截断
_MAX_MSG_CHARS = 2000


@dataclass
class SessionTopic:
    """一个 session 的对话内容摘要。"""

    title: str
    created_at: str
    updated_at: str
    # 合并后的用户消息文本
    user_messages: str
    # 合并后的 assistant reasoning（思维链）
    reasoning: str
    # 涉及的工具列表
    tools_used: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "user_messages": self.user_messages,
            "reasoning": self.reasoning,
            "tools_used": self.tools_used,
        }


@dataclass
class SessionStats:
    """Aggregated session topics."""

    total_sessions: int = 0
    topics: list[SessionTopic] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_sessions": self.total_sessions,
            "topics": [t.to_dict() for t in self.topics],
        }


def _parse_timestamp(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _truncate(text: str, limit: int = _MAX_MSG_CHARS) -> str:
    if len(text) <= limit:
        return text
    # 保留首尾
    half = limit // 2
    return text[:half] + "\n...(truncated)...\n" + text[-half:]


def _is_skip_file(filename: str) -> bool:
    """跳过临时会话、定时任务等非主动对话。"""
    name = filename.lower()
    return "ephemeral" in name or "cron_" in name or "schedule_" in name


def collect_session_topics(
    workspace: Path,
    since: datetime | None = None,
    max_sessions: int = _MAX_SESSIONS,
) -> SessionStats:
    """扫描 session 文件，提取对话内容用于主题蒸馏。

    Args:
        workspace: workspace 根目录（含 sessions/ 子目录）
        since: 仅处理此时间之后更新的 session
        max_sessions: 最多处理的 session 数量
    """
    sessions_dir = workspace / "sessions"
    stats = SessionStats()

    if not sessions_dir.exists():
        logger.debug("[session_collector] no sessions dir")
        return stats

    # 收集候选文件：[(updated_at, filepath, metadata)]
    candidates: list[tuple[datetime, Path, dict]] = []
    for session_file in sessions_dir.glob("*.jsonl"):
        if _is_skip_file(session_file.name):
            continue
        try:
            # 读第一行 metadata
            with session_file.open("r", encoding="utf-8") as f:
                first_line = f.readline().strip()
            if not first_line:
                continue
            meta = json.loads(first_line)
            if meta.get("_type") != "metadata":
                continue
            updated = _parse_timestamp(meta.get("updated_at"))
            if updated is None:
                continue
            # 时间过滤
            if since and updated < since:
                continue
            candidates.append((updated, session_file, meta))
        except Exception as e:
            logger.debug(f"[session_collector] skip {session_file.name}: {e}")

    # 按 updated_at 倒序，取最近的 N 个
    candidates.sort(key=lambda x: x[0], reverse=True)
    candidates = candidates[:max_sessions]

    total = 0
    for _, session_file, meta in candidates:
        topic = _extract_session_topic(session_file, meta)
        if topic is None:
            continue
        stats.topics.append(topic)
        total += 1

    stats.total_sessions = total
    logger.debug(f"[session_collector] extracted {total} sessions")
    return stats


def _extract_session_topic(
    session_file: Path,
    meta: dict,
) -> SessionTopic | None:
    """从单个 session 文件提取对话内容。"""
    title = meta.get("metadata", {}).get("title", "") or session_file.stem
    created_at = str(meta.get("created_at", ""))
    updated_at = str(meta.get("updated_at", ""))

    user_msgs: list[str] = []
    reasoning_parts: list[str] = []
    tools: set[str] = set()
    total_chars = 0

    try:
        with session_file.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("_type") == "metadata":
                    continue

                role = msg.get("role")

                # 用户消息
                if role == "user":
                    content = msg.get("content", "")
                    if isinstance(content, str) and content.strip():
                        truncated = _truncate(content)
                        user_msgs.append(truncated)
                        total_chars += len(truncated)

                # assistant reasoning + tool_calls
                elif role == "assistant":
                    reasoning = msg.get("reasoning_content", "")
                    if isinstance(reasoning, str) and reasoning.strip():
                        reasoning_parts.append(_truncate(reasoning))
                        total_chars += len(reasoning)

                    # 收集工具调用
                    tool_calls = msg.get("tool_calls") or []
                    for tc in tool_calls:
                        func = tc.get("function", {}) if isinstance(tc, dict) else {}
                        name = func.get("name")
                        if name:
                            tools.add(name)

                # 超过截断上限提前终止
                if total_chars > _MAX_SESSION_CHARS:
                    break
    except Exception as e:
        logger.debug(f"[session_collector] failed to read {session_file.name}: {e}")
        return None

    # 至少要有用户消息
    if not user_msgs:
        return None

    return SessionTopic(
        title=title,
        created_at=created_at,
        updated_at=updated_at,
        user_messages="\n---\n".join(user_msgs)[:_MAX_SESSION_CHARS],
        reasoning="\n---\n".join(reasoning_parts)[:_MAX_SESSION_CHARS // 2],
        tools_used=sorted(tools),
    )
