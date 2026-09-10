"""Collect bounded, date-aware statistics from a configured notes vault."""

from __future__ import annotations

import hashlib
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from loguru import logger

_DEFAULT_TIMEZONE = "Asia/Shanghai"
_IGNORED_TAGS = {"草稿", "draft", "Draft", "DRAFT"}


@dataclass
class NotesStats:
    """Aggregated notes statistics and bounded source records."""

    total_notes: int = 0
    total_notebooks: int = 0
    notebook_distribution: list[dict[str, Any]] = field(default_factory=list)
    tag_distribution: list[dict[str, Any]] = field(default_factory=list)
    title_keywords: list[dict[str, Any]] = field(default_factory=list)
    monthly_distribution: dict[str, int] = field(default_factory=dict)
    recent_titles: list[str] = field(default_factory=list)
    note_keywords: list[dict[str, Any]] = field(default_factory=list)
    keyword_first_seen: dict[str, str] = field(default_factory=dict)
    records: list[dict[str, Any]] = field(default_factory=list)
    # Complete in-window records for deterministic local aggregates. Prompt and
    # persisted evidence continue to use the bounded ``records`` projection.
    all_records: list[dict[str, Any]] = field(default_factory=list, repr=False)
    coverage: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_notes": self.total_notes,
            "total_notebooks": self.total_notebooks,
            "notebook_distribution": self.notebook_distribution,
            "tag_distribution": self.tag_distribution,
            "title_keywords": self.title_keywords,
            "monthly_distribution": self.monthly_distribution,
            "recent_titles": self.recent_titles,
            "note_keywords": self.note_keywords,
            "keyword_first_seen": self.keyword_first_seen,
            "records": self.records,
            "coverage": self.coverage,
        }


# 技术关键词（英文小写 + 中文），用于从标题/标签中提取。
_TECH_KEYWORDS = {
    "python", "rust", "typescript", "javascript", "java", "go", "golang",
    "c++", "c#", "swift", "kotlin", "react", "vue", "tauri", "electron",
    "godot", "node", "deno", "sql", "postgres", "postgresql", "mysql",
    "sqlite", "redis", "mongodb", "api", "http", "grpc", "websocket", "rest",
    "graphql", "ai", "ml", "llm", "gpt", "agent", "embedding", "rag", "linux",
    "windows", "macos", "shell", "bash", "powershell", "git", "docker",
    "kubernetes", "nginx", "ci/cd", "vim", "vscode", "css", "html", "npm",
    "vite", "webpack", "架构", "设计模式", "系统设计", "微服务", "分布式",
    "前端", "后端", "全栈", "数据库", "缓存", "邮件", "授权", "认证", "加密",
    "安全", "蒸馏", "画像", "可视化", "图表", "自动化", "工作流", "效率",
    "终端", "命令行", "模型", "降级", "并发", "性能", "提示词", "模板", "笔记",
    "知识库",
}


def _timezone(name: str) -> timezone | ZoneInfo:
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError):
        logger.warning("[notes_collector] invalid timezone {!r}; using UTC", name)
        return timezone.utc


def _parse_date(
    value: str | datetime | None,
    timezone_name: str = _DEFAULT_TIMEZONE,
) -> tuple[datetime | None, bool]:
    if value is None or value == "":
        return None, False
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None, False
    assumed = parsed.tzinfo is None
    if assumed:
        parsed = parsed.replace(tzinfo=_timezone(timezone_name))
    return parsed.astimezone(timezone.utc), assumed


def _bound(value: datetime | None, timezone_name: str) -> datetime | None:
    return _parse_date(value, timezone_name)[0] if value is not None else None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _extract_keywords(title: str) -> list[str]:
    """Extract known keywords in deterministic order."""
    if not title:
        return []
    lowered = title.lower()
    return sorted(kw for kw in _TECH_KEYWORDS if kw in lowered)


def _parse_frontmatter(content: str) -> dict[str, Any]:
    """Parse simple YAML frontmatter and block lists."""
    if not content.startswith("---"):
        return {}
    parts = content.split("---", 2)
    if len(parts) < 3:
        return {}
    result: dict[str, Any] = {}
    last_key: str | None = None
    for line in parts[1].strip().splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("- ") and last_key:
            item = stripped[2:].strip().strip('"').strip("'")
            if isinstance(result.get(last_key), list):
                result[last_key].append(item)
            else:
                result[last_key] = [item]
            continue
        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        result[key] = value if value else []
        last_key = key
    return result


def _stable_note_ref(relative_path: str) -> str:
    return f"note:{hashlib.sha256(relative_path.encode('utf-8')).hexdigest()[:32]}"


def collect_notes_stats(
    vault: Path | None,
    top_n: int = 15,
    *,
    since: datetime | None = None,
    until: datetime | None = None,
    timezone_name: str = _DEFAULT_TIMEZONE,
    max_records: int = 200,
) -> NotesStats:
    """Scan notes, optionally selecting one half-open date window.

    Counts are calculated over every selected note. ``records`` is a bounded,
    date-sorted source sample for downstream prompts and evidence views.
    """
    stats = NotesStats()
    if vault is None or not vault.exists() or not vault.is_dir():
        stats.coverage = {
            "status": "unavailable",
            "scanned_count": 0,
            "selected_count": 0,
            "unknown_time_count": 0,
            "assumed_timezone_count": 0,
            "truncated_count": 0,
            "earliest": None,
            "latest": None,
            "reason_code": "notes_unavailable",
        }
        logger.debug("[notes_collector] no vault configured")
        return stats

    lower = _bound(since, timezone_name)
    upper = _bound(until, timezone_name)
    has_window = lower is not None or upper is not None
    notebook_counter: Counter[str] = Counter()
    tag_counter: Counter[str] = Counter()
    keyword_counter: Counter[str] = Counter()
    monthly: Counter[str] = Counter()
    keyword_first_seen: dict[str, str] = {}
    selected_records: list[dict[str, Any]] = []
    note_keyword_records: list[dict[str, Any]] = []
    scanned_count = 0
    read_errors = 0
    unknown_time_count = 0
    assumed_timezone_count = 0
    earliest: datetime | None = None
    latest: datetime | None = None

    for md_file in sorted(vault.rglob("*.md"), key=lambda path: path.as_posix()):
        relative = md_file.relative_to(vault)
        if any(part.startswith(".") for part in relative.parts) or "assets" in relative.parts:
            continue
        scanned_count += 1
        try:
            content = md_file.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            read_errors += 1
            continue
        frontmatter = _parse_frontmatter(content)
        title = str(frontmatter.get("title") or md_file.stem)
        rel_parts = relative.parts
        notebook = rel_parts[0] if len(rel_parts) > 1 else vault.name
        tags_raw = frontmatter.get("tags", "")
        if isinstance(tags_raw, list):
            tags = [str(tag).strip() for tag in tags_raw if str(tag).strip()]
        elif tags_raw:
            tags = [tag.strip() for tag in str(tags_raw).replace(",", " ").split() if tag.strip()]
        else:
            tags = []
        tags = list(dict.fromkeys(tags))
        date_raw = frontmatter.get("createdAt") or frontmatter.get("created_at") or frontmatter.get("updated")
        occurred, assumed = _parse_date(date_raw, timezone_name)
        if assumed:
            assumed_timezone_count += 1
        if occurred is None:
            unknown_time_count += 1
        if has_window and occurred is None:
            continue
        if occurred is not None and ((lower is not None and occurred < lower) or (upper is not None and occurred >= upper)):
            continue

        note_keywords = sorted(set(_extract_keywords(title)).union(*(set(_extract_keywords(tag)) for tag in tags)))
        for tag in tags:
            if tag not in _IGNORED_TAGS:
                tag_counter[tag] += 1
        for keyword in note_keywords:
            keyword_counter[keyword] += 1
        month = occurred.astimezone(_timezone(timezone_name)).strftime("%Y-%m") if occurred else None
        if month:
            monthly[month] += 1
            for keyword in note_keywords:
                if keyword not in keyword_first_seen or month < keyword_first_seen[keyword]:
                    keyword_first_seen[keyword] = month
        if occurred is not None:
            earliest = occurred if earliest is None else min(earliest, occurred)
            latest = occurred if latest is None else max(latest, occurred)
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        selected_records.append(
            {
                "ref": _stable_note_ref(relative.as_posix()),
                "relative_path": relative.as_posix(),
                "title": title,
                "tags": tags,
                "notebook": notebook,
                "occurred_at": _iso(occurred),
                "content_hash": content_hash,
                "keywords": note_keywords,
            }
        )
        note_keyword_records.append(
            {
                "ref": _stable_note_ref(relative.as_posix()),
                "title": title,
                "keywords": note_keywords,
                "occurred_at": _iso(occurred),
            }
        )
        notebook_counter[notebook] += 1

    selected_records.sort(key=lambda item: (item.get("occurred_at") or "", item["relative_path"]), reverse=True)
    stats.total_notes = len(selected_records)
    stats.total_notebooks = len(notebook_counter)
    stats.notebook_distribution = [
        {"notebook": notebook, "count": count}
        for notebook, count in notebook_counter.most_common(top_n)
    ]
    stats.tag_distribution = [
        {"tag": tag, "count": count}
        for tag, count in tag_counter.most_common(top_n)
    ]
    stats.title_keywords = [
        {"keyword": keyword, "count": count}
        for keyword, count in keyword_counter.most_common(top_n)
    ]
    stats.monthly_distribution = dict(sorted(monthly.items()))
    stats.recent_titles = [str(item["title"]) for item in selected_records[:50]]
    stats.note_keywords = note_keyword_records
    stats.keyword_first_seen = dict(sorted(keyword_first_seen.items(), key=lambda item: item[1]))
    stats.records = selected_records[: max(0, max_records)]
    stats.all_records = selected_records
    stats.coverage = {
        "status": "partial" if read_errors or (has_window and unknown_time_count) else "available",
        "scanned_count": scanned_count,
        "selected_count": len(selected_records),
        "unknown_time_count": unknown_time_count,
        "assumed_timezone_count": assumed_timezone_count,
        "truncated_count": max(0, len(selected_records) - len(stats.records)),
        "earliest": _iso(earliest),
        "latest": _iso(latest),
        "reason_code": "notes_read_partial" if read_errors else (
            "unknown_note_time" if has_window and unknown_time_count else None
        ),
    }
    logger.info(
        "[notes_collector] scanned {} notes, selected {}, {} notebooks, {} tags",
        scanned_count,
        stats.total_notes,
        stats.total_notebooks,
        len(tag_counter),
    )
    return stats
