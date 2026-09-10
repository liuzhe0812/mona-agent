"""Deterministic aggregates for the three user-profile dashboard tabs.

The module deliberately consumes already selected current/previous records.  It
does not read files, call a model, or infer capability from activity counts.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from itertools import combinations
from typing import Any, Iterable
from zoneinfo import ZoneInfo

_DOMAINS = (
    "AI 应用",
    "产品设计",
    "软件开发",
    "知识检索",
    "内容创作",
    "效率工具",
    "其他",
)
_TASKS = ("开发", "分析", "写作", "设计")

# Aliases intentionally live beside the aggregation code.  Values are
# (topic label, profile domain).  An input record may mention several topics,
# but each topic is counted at most once for that record.
_KEYWORD_MAP: dict[str, tuple[str, str]] = {
    "ai": ("AI 应用", "AI 应用"),
    "人工智能": ("AI 应用", "AI 应用"),
    "llm": ("AI 应用", "AI 应用"),
    "gpt": ("AI 应用", "AI 应用"),
    "模型": ("AI 应用", "AI 应用"),
    "agent": ("Agent", "AI 应用"),
    "智能体": ("Agent", "AI 应用"),
    "prompt": ("提示词", "AI 应用"),
    "提示词": ("提示词", "AI 应用"),
    "rag": ("RAG", "知识检索"),
    "检索增强": ("RAG", "知识检索"),
    "retrieval": ("检索评估", "知识检索"),
    "检索": ("检索评估", "知识检索"),
    "召回": ("检索评估", "知识检索"),
    "embedding": ("向量检索", "知识检索"),
    "向量": ("向量检索", "知识检索"),
    "知识库": ("知识库", "知识检索"),
    "knowledge base": ("知识库", "知识检索"),
    "note": ("笔记", "知识检索"),
    "notes": ("笔记", "知识检索"),
    "笔记": ("笔记", "知识检索"),
    "知识管理": ("知识管理", "知识检索"),
    "python": ("Python", "软件开发"),
    "rust": ("Rust", "软件开发"),
    "typescript": ("TypeScript", "软件开发"),
    "javascript": ("JavaScript", "软件开发"),
    "java": ("Java", "软件开发"),
    "golang": ("Go", "软件开发"),
    "go": ("Go", "软件开发"),
    "react": ("React", "软件开发"),
    "vue": ("Vue", "软件开发"),
    "frontend": ("前端", "软件开发"),
    "前端": ("前端", "软件开发"),
    "backend": ("后端", "软件开发"),
    "后端": ("后端", "软件开发"),
    "api": ("API", "软件开发"),
    "接口": ("API", "软件开发"),
    "database": ("数据库", "软件开发"),
    "数据库": ("数据库", "软件开发"),
    "sql": ("SQL", "软件开发"),
    "编程": ("编程", "软件开发"),
    "代码": ("编程", "软件开发"),
    "coding": ("编程", "软件开发"),
    "code": ("编程", "软件开发"),
    "架构": ("架构", "软件开发"),
    "architecture": ("架构", "软件开发"),
    "design pattern": ("设计模式", "软件开发"),
    "设计模式": ("设计模式", "软件开发"),
    "docker": ("Docker", "效率工具"),
    "git": ("Git", "效率工具"),
    "linux": ("Linux", "效率工具"),
    "terminal": ("终端", "效率工具"),
    "终端": ("终端", "效率工具"),
    "shell": ("Shell", "效率工具"),
    "脚本": ("自动化", "效率工具"),
    "automation": ("自动化", "效率工具"),
    "自动化": ("自动化", "效率工具"),
    "workflow": ("工作流", "效率工具"),
    "工作流": ("工作流", "效率工具"),
    "效率": ("效率工具", "效率工具"),
    "工具": ("效率工具", "效率工具"),
    "product": ("产品设计", "产品设计"),
    "产品": ("产品设计", "产品设计"),
    "产品设计": ("产品设计", "产品设计"),
    "requirement": ("需求分析", "产品设计"),
    "requirements": ("需求分析", "产品设计"),
    "需求": ("需求分析", "产品设计"),
    "需求分析": ("需求分析", "产品设计"),
    "ui": ("交互设计", "产品设计"),
    "ux": ("交互设计", "产品设计"),
    "interaction": ("交互设计", "产品设计"),
    "交互": ("交互设计", "产品设计"),
    "交互设计": ("交互设计", "产品设计"),
    "prototype": ("交互设计", "产品设计"),
    "原型": ("交互设计", "产品设计"),
    "visualization": ("数据可视化", "产品设计"),
    "可视化": ("数据可视化", "产品设计"),
    "图表": ("数据可视化", "产品设计"),
    "visual": ("视觉设计", "产品设计"),
    "视觉": ("视觉设计", "产品设计"),
    "写作": ("内容创作", "内容创作"),
    "writing": ("内容创作", "内容创作"),
    "write": ("内容创作", "内容创作"),
    "文章": ("文章", "内容创作"),
    "article": ("文章", "内容创作"),
    "文案": ("文案", "内容创作"),
    "copywriting": ("文案", "内容创作"),
    "报告": ("报告写作", "内容创作"),
    "report": ("报告写作", "内容创作"),
    "教程": ("教程", "内容创作"),
    "tutorial": ("教程", "内容创作"),
    "文档": ("文档", "内容创作"),
    "document": ("文档", "内容创作"),
    "内容": ("内容创作", "内容创作"),
    "content": ("内容创作", "内容创作"),
    "学习": ("学习", "知识检索"),
    "learning": ("学习", "知识检索"),
    "研究": ("研究", "知识检索"),
    "research": ("研究", "知识检索"),
    "论文": ("论文", "知识检索"),
    "paper": ("论文", "知识检索"),
}

_ASCII_ALIAS = re.compile(r"^[a-z0-9][a-z0-9_ +.#/-]*$")


def _tz(name: str) -> timezone | ZoneInfo:
    try:
        return ZoneInfo(name)
    except (KeyError, ValueError):
        return timezone.utc


def _parse_datetime(value: Any, timezone_name: str) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=_tz(timezone_name))
    return parsed.astimezone(timezone.utc)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _as_of(value: datetime, timezone_name: str) -> datetime:
    parsed = _parse_datetime(value, timezone_name)
    if parsed is None:
        raise ValueError("as_of must be a valid datetime")
    return parsed


def _record_key(record: dict[str, Any], index: int, kind: str) -> str:
    for key in ("ref", "event_id", "message_id", "id", "source_ref"):
        value = record.get(key)
        if value:
            return f"{kind}:{key}:{value}"
    if kind == "event":
        fallback = (
            record.get("session_key"),
            record.get("message_index"),
            record.get("occurred_at"),
            record.get("content"),
        )
    else:
        fallback = (
            record.get("relative_path"),
            record.get("title"),
            record.get("occurred_at"),
            record.get("keywords"),
            record.get("tags"),
        )
    return f"{kind}:fallback:{json.dumps(fallback, ensure_ascii=False, sort_keys=True, default=str)}"


def _dedupe(records: Iterable[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            continue
        key = _record_key(record, index, kind)
        if key in seen:
            continue
        seen.add(key)
        result.append(record)
    return result


def _in_window(
    occurred_at: datetime | None,
    start: datetime,
    end: datetime,
) -> bool:
    return occurred_at is not None and start <= occurred_at < end


def _selected_events(
    events: Iterable[dict[str, Any]],
    *,
    start: datetime,
    end: datetime,
    timezone_name: str,
) -> list[tuple[dict[str, Any], datetime | None]]:
    result = []
    for event in _dedupe(events, "event"):
        occurred = _parse_datetime(event.get("occurred_at"), timezone_name)
        if _in_window(occurred, start, end):
            result.append((event, occurred))
    return result


def _selected_notes(
    notes: dict[str, Any] | None,
    *,
    start: datetime,
    end: datetime,
    timezone_name: str,
) -> list[tuple[dict[str, Any], datetime | None]]:
    if not isinstance(notes, dict):
        return []
    records = notes.get("records")
    if not isinstance(records, list):
        records = notes.get("note_keywords") if isinstance(notes.get("note_keywords"), list) else []
    result = []
    for note, occurred in (
        (record, _parse_datetime(record.get("occurred_at"), timezone_name))
        for record in _dedupe(records, "note")
        if isinstance(record, dict)
    ):
        if _in_window(occurred, start, end):
            result.append((note, occurred))
    return result


def _contains(text: str, alias: str) -> bool:
    alias = alias.lower()
    if not alias:
        return False
    if _ASCII_ALIAS.match(alias):
        return re.search(rf"(?<![a-z0-9_]){re.escape(alias)}(?![a-z0-9_])", text) is not None
    return alias in text


def _topics(text: str) -> dict[str, str]:
    lowered = text.lower()
    matched: dict[str, str] = {}
    for alias, (topic, domain) in _KEYWORD_MAP.items():
        if _contains(lowered, alias):
            matched[topic] = domain
    return matched or {"其他": "其他"}


def _event_text(event: dict[str, Any]) -> str:
    return str(event.get("content") or event.get("title") or "")


def _note_text(note: dict[str, Any]) -> str:
    parts = [str(note.get("title") or "")]
    for key in ("tags", "keywords"):
        value = note.get(key)
        if isinstance(value, (list, tuple, set)):
            parts.extend(str(item) for item in value)
        elif value:
            parts.append(str(value))
    return " ".join(parts)


def _topic_records(
    events: list[tuple[dict[str, Any], datetime | None]],
    notes: list[tuple[dict[str, Any], datetime | None]],
) -> list[tuple[set[str], dict[str, str], datetime | None]]:
    result = []
    for event, occurred in events:
        matched = _topics(_event_text(event))
        result.append((set(matched), matched, occurred))
    for note, occurred in notes:
        matched = _topics(_note_text(note))
        result.append((set(matched), matched, occurred))
    return result


def _topic_counts(
    records: list[tuple[set[str], dict[str, str], datetime | None]],
) -> tuple[Counter[str], Counter[str]]:
    topics: Counter[str] = Counter()
    domains: Counter[str] = Counter()
    for labels, mapped, _occurred in records:
        topics.update(labels)
        domains.update({mapped[label] for label in labels})
    return topics, domains


def _sort_topics(counter: Counter[str]) -> list[str]:
    return sorted(counter, key=lambda item: (-counter[item], item))


def _sort_domains(counter: Counter[str], limit: int = 6) -> list[str]:
    rank = {label: index for index, label in enumerate(_DOMAINS)}
    return sorted(counter, key=lambda item: (-counter[item], rank.get(item, len(rank)), item))[:limit]


def _profile_dimensions(counter: Counter[str]) -> list[dict[str, Any]]:
    return [{"axis": domain, "count": counter[domain]} for domain in _sort_domains(counter)]


def _topic_graph(records: list[tuple[set[str], dict[str, str], datetime | None]]) -> dict[str, Any]:
    topic_counts: Counter[str] = Counter()
    topic_domains: dict[str, str] = {}
    links: Counter[tuple[str, str]] = Counter()
    has_named_topic = any("其他" not in labels and labels for labels, _mapped, _occurred in records)
    for labels, mapped, _occurred in records:
        labels = labels - {"其他"}
        if not labels:
            continue
        topic_counts.update(labels)
        for topic in labels:
            topic_domains.setdefault(topic, mapped[topic])
        for first, second in combinations(sorted(labels), 2):
            links[(first, second)] += 1
    if not has_named_topic and records:
        topic_counts["其他"] = len(records)
        topic_domains["其他"] = "其他"
    ordered = _sort_topics(topic_counts)
    nodes = [
        {
            "id": f"topic:{topic}",
            "label": topic,
            "group": topic_domains[topic],
            "count": topic_counts[topic],
        }
        for topic in ordered
    ]
    edge_rows = sorted(
        links.items(),
        key=lambda item: (-item[1], item[0][0], item[0][1]),
    )
    return {
        "nodes": nodes,
        "links": [
            {
                "source": f"topic:{first}",
                "target": f"topic:{second}",
                "weight": weight,
            }
            for (first, second), weight in edge_rows
        ],
    }


def _classify_collaboration(text: str) -> str | None:
    lowered = text.lower()
    terms = {
        "开发": (
            "python", "rust", "typescript", "javascript", "react", "vue", "api", "sql",
            "code", "coding", "编程", "代码", "开发", "调试", "debug", "数据库", "脚本",
        ),
        "分析": (
            "analysis", "analyze", "research", "分析", "研究", "评估", "比较", "数据",
            "检索", "规划", "方案", "总结",
        ),
        "写作": (
            "write", "writing", "文案", "文章", "报告", "总结", "教程", "笔记", "写作",
            "翻译", "markdown", "document", "文档",
        ),
        "设计": (
            "design", "ui", "ux", "视觉", "交互", "原型", "图像", "图片", "海报", "设计",
            "可视化",
        ),
    }
    scores = {
        label: sum(1 for term in values if _contains(lowered, term))
        for label, values in terms.items()
    }
    if not any(scores.values()):
        return None
    return max(_TASKS, key=lambda label: (scores[label], -_TASKS.index(label)))


def _collaboration_types(
    events: list[tuple[dict[str, Any], datetime | None]],
) -> list[dict[str, Any]]:
    counts: Counter[str] = Counter()
    for event, _occurred in events:
        counts[_classify_collaboration(_event_text(event)) or "其他"] += 1
    result = [{"label": label, "count": counts[label]} for label in _TASKS]
    if counts["其他"]:
        result.append({"label": "其他", "count": counts["其他"]})
    return result


def _artifact_key(artifact: dict[str, Any], index: int) -> str:
    for key in ("id", "artifact_id", "source_ref", "ref"):
        value = artifact.get(key)
        if value:
            return f"{key}:{value}"
    identity = (
        artifact.get("mime"),
        artifact.get("first_recorded_at"),
        artifact.get("title"),
        artifact.get("relative_path"),
    )
    return f"fallback:{json.dumps(identity, ensure_ascii=False, sort_keys=True, default=str)}"


def _artifact_type(mime: Any) -> str:
    value = str(mime or "").lower().split(";", 1)[0].strip()
    if value.startswith("image/") or value in {"image/svg+xml", "image/svg"}:
        return "图像"
    if value in {
        "text/markdown", "text/plain", "text/csv", "application/pdf", "application/rtf",
        "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }:
        return "文档"
    if (
        value.startswith("text/x-")
        or value in {
            "text/javascript", "application/javascript", "application/typescript",
            "application/json", "application/xml", "text/html", "text/css",
        }
        or any(token in value for token in ("python", "rust", "shell", "source-code"))
    ):
        return "代码"
    return "其他"


def _artifact_types(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts = Counter()
    seen: set[str] = set()
    for index, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            continue
        key = _artifact_key(artifact, index)
        if key in seen:
            continue
        seen.add(key)
        counts[_artifact_type(artifact.get("mime"))] += 1
    return [{"label": label, "count": counts[label]} for label in ("文档", "代码", "图像", "其他")]


def _domain_task_matrix(
    events: list[tuple[dict[str, Any], datetime | None]],
    domains: list[str],
) -> dict[str, Any]:
    values = [[0 for _ in _TASKS] for _ in domains]
    indexes = {domain: index for index, domain in enumerate(domains)}
    for event, _occurred in events:
        matched = _topics(_event_text(event))
        task = _classify_collaboration(_event_text(event))
        if task is None:
            continue
        task_index = _TASKS.index(task)
        event_domains = {matched[topic] for topic in matched}
        for domain in event_domains:
            if domain in indexes:
                values[indexes[domain]][task_index] += 1
    return {"domains": domains, "tasks": list(_TASKS), "values": values}


def _topic_trends(
    records: list[tuple[set[str], dict[str, str], datetime | None]],
    *,
    as_of: datetime,
    timezone_name: str,
) -> dict[str, Any]:
    starts = [as_of - timedelta(days=28 - index * 7) for index in range(4)]
    ends = [start + timedelta(days=7) for start in starts]
    labels = [start.astimezone(_tz(timezone_name)).date().isoformat() for start in starts]
    total = Counter()
    buckets = [Counter() for _ in starts]
    for topics, _mapped, occurred in records:
        if occurred is None:
            continue
        total.update(topics)
        for index, (start, end) in enumerate(zip(starts, ends)):
            if start <= occurred < end:
                buckets[index].update(topics)
                break
    top_topics = _sort_topics(total)[:3]
    return {
        "labels": labels,
        "series": [
            {"topic": topic, "values": [bucket[topic] for bucket in buckets]}
            for topic in top_topics
        ],
    }


def _topic_comparison(
    current: Counter[str],
    previous: Counter[str],
) -> list[dict[str, Any]]:
    topics = sorted(
        set(current) | set(previous),
        key=lambda topic: (-current[topic], -previous[topic], topic),
    )
    return [
        {
            "topic": topic,
            "current": current[topic],
            "previous": previous[topic],
            "delta": current[topic] - previous[topic],
        }
        for topic in topics
    ]


def _new_topics(
    current_records: list[tuple[set[str], dict[str, str], datetime | None]],
    previous_counts: Counter[str],
) -> list[dict[str, Any]]:
    counts: Counter[str] = Counter()
    first_seen: dict[str, datetime] = {}
    for topics, _mapped, occurred in current_records:
        counts.update(topics)
        if occurred is None:
            continue
        for topic in topics:
            first_seen[topic] = min(first_seen.get(topic, occurred), occurred)
    result = [
        {
            "topic": topic,
            "count": counts[topic],
            "first_seen_at": _iso(first_seen[topic]),
        }
        for topic in counts
        if topic not in previous_counts and topic in first_seen
    ]
    result.sort(key=lambda item: (-item["count"], item["first_seen_at"], item["topic"]))
    return result


def build_profile_charts(
    *,
    current_events: list[dict[str, Any]],
    previous_events: list[dict[str, Any]],
    current_notes: dict[str, Any],
    previous_notes: dict[str, Any],
    artifacts: list[dict[str, Any]],
    as_of: datetime,
    timezone_name: str,
) -> dict[str, Any]:
    """Build the fixed chart contract consumed by the profile dashboard."""
    as_of_utc = _as_of(as_of, timezone_name)
    current_start = as_of_utc - timedelta(days=30)
    previous_start = as_of_utc - timedelta(days=60)
    current_events_selected = _selected_events(
        current_events,
        start=current_start,
        end=as_of_utc,
        timezone_name=timezone_name,
    )
    previous_events_selected = _selected_events(
        previous_events,
        start=previous_start,
        end=current_start,
        timezone_name=timezone_name,
    )
    current_notes_selected = _selected_notes(
        current_notes,
        start=current_start,
        end=as_of_utc,
        timezone_name=timezone_name,
    )
    previous_notes_selected = _selected_notes(
        previous_notes,
        start=previous_start,
        end=current_start,
        timezone_name=timezone_name,
    )
    current_records = _topic_records(current_events_selected, current_notes_selected)
    previous_records = _topic_records(previous_events_selected, previous_notes_selected)
    current_topics, current_domains = _topic_counts(current_records)
    previous_topics, previous_domains = _topic_counts(previous_records)
    profile_dimensions = _profile_dimensions(current_domains)
    previous_profile_dimensions = _profile_dimensions(previous_domains)
    matrix_domains = [item["axis"] for item in profile_dimensions]
    return {
        "profile_dimensions": profile_dimensions,
        "topic_graph": _topic_graph(current_records),
        "collaboration_types": _collaboration_types(current_events_selected),
        "artifact_types": _artifact_types(artifacts),
        "domain_task_matrix": _domain_task_matrix(current_events_selected, matrix_domains),
        "topic_trends": _topic_trends(
            current_records,
            as_of=as_of_utc,
            timezone_name=timezone_name,
        ),
        "topic_comparison": _topic_comparison(current_topics, previous_topics),
        "previous_profile_dimensions": previous_profile_dimensions,
        "new_topics": _new_topics(current_records, previous_topics),
    }


__all__ = ["build_profile_charts"]
