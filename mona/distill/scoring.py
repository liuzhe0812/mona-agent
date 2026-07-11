"""Capability scoring and milestone detection.

Computes 8-dimension radar scores, skill matrix, knowledge graph,
growth milestones, and historical snapshots.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

# 8 dimensions of capability radar
RADAR_AXES = [
    "architecture",  # 架构
    "creativity",  # 创意
    "communication",  # 沟通
    "learning",  # 学习
    "efficiency",  # 效率
    "tools",  # 工具
    "programming",  # 编程
    "depth",  # 深度
]

# 技术领域关键词 → 维度映射
_TECH_AREA_MAP: dict[str, str] = {
    # programming
    "python": "programming", "rust": "programming", "typescript": "programming",
    "javascript": "programming", "java": "programming", "golang": "programming",
    "c++": "programming", "c#": "programming", "swift": "programming",
    "react": "programming", "vue": "programming", "tauri": "programming",
    "electron": "programming", "kotlin": "programming",
    "前端": "programming", "后端": "programming", "全栈": "programming",
    "编程": "programming",
    # architecture
    "架构": "architecture", "architecture": "architecture",
    "设计模式": "architecture", "系统设计": "architecture",
    "微服务": "architecture", "distributed": "architecture",
    "分布式": "architecture", "授权": "architecture", "认证": "architecture",
    "加密": "architecture", "安全": "architecture",
    # creativity
    "设计": "creativity", "ui": "creativity", "ux": "creativity",
    "创意": "creativity", "灵感": "creativity", "产品": "creativity",
    "game": "creativity", "godot": "creativity",
    "可视化": "creativity", "图表": "creativity",
    # communication
    "邮件": "communication", "email": "communication",
    "沟通": "communication", "会议": "communication",
    "文档": "communication", "报告": "communication",
    # efficiency
    "自动化": "efficiency", "automation": "efficiency",
    "工具": "efficiency", "效率": "efficiency",
    "工作流": "efficiency", "workflow": "efficiency",
    "性能": "efficiency", "并发": "efficiency",
    # tools
    "git": "tools", "docker": "tools", "linux": "tools",
    "shell": "tools", "终端": "tools", "terminal": "tools",
    "vim": "tools", "vscode": "tools", "命令行": "tools",
    "windows": "tools", "macos": "tools",
    # learning / depth
    "蒸馏": "learning", "画像": "learning",
    "模型": "depth", "降级": "depth",
    "提示词": "depth", "模板": "depth",
    "知识库": "depth", "笔记": "depth",
    "agent": "depth", "ai": "depth", "llm": "depth",
    "api": "depth", "http": "depth",
}


def compute_radar_scores(
    notes_stats: dict[str, Any],
    work_patterns: dict[str, Any] | None = None,
    email_stats: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Compute 8-dimension capability scores (0-100).

    Returns [{"axis": "架构", "key": "architecture", "value": 75, "evidence": "..."}]
    """
    # Collect signals per dimension
    signals: dict[str, float] = defaultdict(float)

    # From notes keywords
    keywords = notes_stats.get("title_keywords", [])
    for kw_item in keywords:
        kw = (kw_item.get("keyword") or "").lower()
        count = kw_item.get("count", 1)
        for tech_key, dim in _TECH_AREA_MAP.items():
            if tech_key in kw:
                signals[dim] += count * 3
                break

    # From notebook distribution
    notebook_dist = notes_stats.get("notebook_distribution", [])
    for nb in notebook_dist:
        nb_name = (nb.get("notebook") or "").lower()
        count = nb.get("count", 1)
        for tech_key, dim in _TECH_AREA_MAP.items():
            if tech_key in nb_name:
                signals[dim] += count * 2
                break

    # From work patterns (tool usage → tools/efficiency)
    if work_patterns:
        wp = work_patterns
        preferred = wp.get("preferred_tools", [])
        signals["tools"] += len(preferred) * 8
        tool_chains = wp.get("tool_chains", [])
        signals["efficiency"] += len(tool_chains) * 6
        # output_style detailed → communication
        if wp.get("output_style") == "detailed":
            signals["communication"] += 15

    # From email stats (communication)
    if email_stats:
        total_emails = email_stats.get("total_emails", 0)
        signals["communication"] += min(total_emails * 0.5, 30)

    # From notes depth (all notes → learning, depth)
    total_notes = notes_stats.get("total_notes", 0)
    signals["learning"] += min(total_notes * 2, 40)
    signals["depth"] += min(total_notes * 1.5, 30)

    # Creativity boost from diverse notebooks
    signals["creativity"] += min(len(notebook_dist) * 5, 25)

    # Normalize to 0-100 with soft cap
    max_signal = max(max(signals.values()) if signals else 1, 30)
    results: list[dict[str, Any]] = []
    axis_labels = {
        "architecture": "架构",
        "creativity": "创意",
        "communication": "沟通",
        "learning": "学习",
        "efficiency": "效率",
        "tools": "工具",
        "programming": "编程",
        "depth": "深度",
    }
    for key in RADAR_AXES:
        raw = signals.get(key, 0)
        # Logarithmic scaling to avoid extreme values
        score = min(100, round(20 + (raw / max_signal) * 70 + min(raw, 10)))
        results.append({
            "axis": axis_labels[key],
            "key": key,
            "value": score,
            "raw_signal": round(raw, 1),
        })
    return results


def build_skill_matrix(
    notes_stats: dict[str, Any],
    radar_scores: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Build skill matrix heatmap data.

    Returns [{"area": "Python", "level": 3, "score": 65, "note_count": 12}]

    优先按技术领域分组；若关键词无法匹配已知领域，保留关键词本身。
    同时用 notebook_distribution 补充技能领域。
    """
    area_counts: Counter[str] = Counter()

    # 从 title_keywords 聚合
    keywords = notes_stats.get("title_keywords", [])
    for kw_item in keywords:
        kw_raw = kw_item.get("keyword") or ""
        kw = kw_raw.lower()
        count = kw_item.get("count", 1)
        area = None
        for tech_key, dim in _TECH_AREA_MAP.items():
            if tech_key in kw:
                area = _area_label(dim)
                break
        if area is None:
            # 未匹配映射的关键词保留原文
            area = kw_raw.title() if kw_raw.isascii() else kw_raw
        area_counts[area] += count

    # 从 notebook_distribution 补充（笔记本名通常代表技能领域）
    for nb in notes_stats.get("notebook_distribution", []):
        nb_name = nb.get("notebook") or ""
        count = nb.get("count", 1)
        if not nb_name or nb_name in ("默认分类", "未分类"):
            continue
        # 尝试映射到已知领域
        matched = False
        for tech_key, dim in _TECH_AREA_MAP.items():
            if tech_key in nb_name.lower():
                area_counts[_area_label(dim)] += count
                matched = True
                break
        if not matched:
            area_counts[nb_name] += count

    if not area_counts:
        return []

    max_count = max(area_counts.values()) if area_counts else 1
    results = []
    for area, count in area_counts.most_common(12):
        ratio = count / max_count
        level = min(5, max(1, int(ratio * 4) + 1))
        score = min(100, round(20 + ratio * 80))
        results.append({
            "area": area,
            "level": level,
            "score": score,
            "note_count": count,
        })
    return results


_AREA_LABELS = {
    "programming": "编程语言",
    "architecture": "架构设计",
    "creativity": "创意设计",
    "communication": "沟通协作",
    "efficiency": "效率工具",
    "tools": "开发工具",
    "learning": "学习成长",
    "depth": "深度钻研",
}


def _area_label(dim: str) -> str:
    return _AREA_LABELS.get(dim, dim)


def build_knowledge_graph(
    notes_stats: dict[str, Any],
) -> dict[str, Any]:
    """Build knowledge star graph (keyword co-occurrence network).

    Nodes: user (center) + keywords (outer ring).
    Links: user → keywords (radial), keyword ↔ keyword (co-occurrence in same note).

    Returns {"nodes": [...], "links": [...]}
    """
    keywords = notes_stats.get("title_keywords", [])
    note_keywords = notes_stats.get("note_keywords", [])

    nodes: list[dict[str, Any]] = [{"id": "user", "label": "我", "group": 0, "size": 30}]

    # Add keyword nodes only (no notebook — categories are subjective)
    kw_ids: list[str] = []
    for kw_item in keywords[:15]:
        kw = kw_item.get("keyword", "")
        count = kw_item.get("count", 1)
        if not kw:
            continue
        node_id = f"kw:{kw}"
        kw_ids.append(node_id)
        nodes.append({
            "id": node_id,
            "label": kw,
            "group": 1,
            "size": min(20, 6 + count * 2),
        })

    links: list[dict[str, Any]] = []

    # Radial links: user → each keyword
    for node in nodes[1:]:
        links.append({
            "source": "user",
            "target": node["id"],
            "weight": max(1, (node.get("size") or 10) // 5),
        })

    # Co-occurrence links: keywords appearing in the same note are connected
    kw_id_set = set(kw_ids)
    co_occurrence: Counter[tuple[str, str]] = Counter()
    for record in note_keywords:
        kws = record.get("keywords", [])
        # Normalize to kw IDs, keep only top-15 keywords
        ids = [f"kw:{kw}" for kw in kws if f"kw:{kw}" in kw_id_set]
        # All unique pairs
        for i, a in enumerate(ids):
            for b in ids[i + 1 :]:
                pair = tuple(sorted([a, b]))
                co_occurrence[pair] += 1

    # Add co-occurrence links (top 20 to avoid clutter)
    for (a, b), count in co_occurrence.most_common(20):
        links.append({"source": a, "target": b, "weight": count})

    return {"nodes": nodes, "links": links}


def detect_milestones(
    notes_stats: dict[str, Any],
    history: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Detect growth milestones from real events.

    Uses keyword_first_seen to track when each skill first appeared,
    and monthly_distribution for activity milestones.
    """
    milestones: list[dict[str, Any]] = []

    monthly = notes_stats.get("monthly_distribution", {})
    keywords = notes_stats.get("title_keywords", [])
    keyword_first_seen: dict[str, str] = notes_stats.get("keyword_first_seen", {})

    # 首次记录里程碑
    sorted_months = sorted(monthly.keys()) if monthly else []
    if sorted_months:
        milestones.append({
            "type": "first_note",
            "title": "开始记录",
            "date": sorted_months[0],
            "icon": "sparkles",
            "description": f"在 {sorted_months[0]} 写下第一篇笔记",
        })

    # 技能首次出现里程碑（基于真实首次出现时间）
    # 按时间排序，取前 8 个
    seen_kws = sorted(keyword_first_seen.items(), key=lambda x: x[1])
    kw_count_map = {k.get("keyword"): k.get("count", 0) for k in keywords}
    for kw, month in seen_kws[:8]:
        count = kw_count_map.get(kw, 0)
        milestones.append({
            "type": "first_skill",
            "title": f"接触 {kw}",
            "date": month,
            "icon": "book",
            "description": f"{month} 首次在笔记中出现「{kw}」" + (f"，累计 {count} 篇" if count >= 2 else ""),
        })

    # 产出高峰（真实月度笔记数，阈值降低到 3）
    if len(sorted_months) >= 2:
        peak_month = max(monthly.items(), key=lambda x: x[1])
        if peak_month[1] >= 3:
            milestones.append({
                "type": "peak",
                "title": "高产时刻",
                "date": peak_month[0],
                "icon": "fire",
                "description": f"{peak_month[0]} 写了 {peak_month[1]} 篇笔记",
            })

    return milestones


def compute_growth_comparison(
    current: dict[str, Any],
    previous: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Compare current vs previous snapshot for growth visualization.

    Returns {"current_radar": [...], "previous_radar": [...],
             "new_skills": [...], "skill_progression": [...]}
    """
    if not previous:
        return None

    current_radar = current.get("radar_scores", [])
    previous_radar = previous.get("radar_scores", [])

    # New skills: keywords in current but not in previous
    current_kws = {k.get("keyword") for k in current.get("keywords", [])}
    previous_kws = {k.get("keyword") for k in previous.get("keywords", [])}
    new_skills = list(current_kws - previous_kws)

    # Skill progression: keyword count changes
    prev_kw_counts = {k.get("keyword"): k.get("count", 0) for k in previous.get("keywords", [])}
    progression = []
    for kw in current.get("keywords", []):
        name = kw.get("keyword")
        curr_count = kw.get("count", 0)
        prev_count = prev_kw_counts.get(name, 0)
        if curr_count > prev_count:
            progression.append({
                "skill": name,
                "before": prev_count,
                "after": curr_count,
                "delta": curr_count - prev_count,
            })
    progression.sort(key=lambda x: x["delta"], reverse=True)

    return {
        "current_radar": current_radar,
        "previous_radar": previous_radar,
        "new_skills": new_skills[:10],
        "skill_progression": progression[:10],
        "current_snapshot_date": current.get("snapshot_date"),
        "previous_snapshot_date": previous.get("snapshot_date"),
    }


# ---------------------------------------------------------------------------
# Historical snapshot
# ---------------------------------------------------------------------------

def save_snapshot(
    memory_dir: Path,
    radar_scores: list[dict[str, Any]],
    keywords: list[dict[str, Any]],
    snapshot_date: str | None = None,
) -> dict[str, Any]:
    """Save a snapshot of current radar scores + keywords for historical comparison."""
    import json

    snapshots_dir = memory_dir / "profile_snapshots"
    snapshots_dir.mkdir(parents=True, exist_ok=True)

    date_str = snapshot_date or datetime.now().strftime("%Y-%m-%d")
    snapshot = {
        "date": date_str,
        "radar_scores": radar_scores,
        "keywords": keywords,
        "created_at": datetime.now().isoformat(),
    }

    snapshot_file = snapshots_dir / f"{date_str}.json"
    try:
        snapshot_file.write_text(
            json.dumps(snapshot, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logger.debug(f"[profile] snapshot saved: {snapshot_file}")
    except Exception as e:
        logger.warning(f"[profile] failed to save snapshot: {e}")

    return snapshot


def load_snapshots(memory_dir: Path) -> list[dict[str, Any]]:
    """Load all historical snapshots sorted by date."""
    import json

    snapshots_dir = memory_dir / "profile_snapshots"
    if not snapshots_dir.exists():
        return []

    snapshots = []
    for f in snapshots_dir.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            snapshots.append(data)
        except Exception:
            continue

    snapshots.sort(key=lambda x: x.get("date", ""))
    return snapshots


def get_previous_snapshot(
    memory_dir: Path,
    current_date: str | None = None,
) -> dict[str, Any] | None:
    """Get the most recent snapshot before current_date."""
    snapshots = load_snapshots(memory_dir)
    if not snapshots:
        return None
    if current_date:
        prev = [s for s in snapshots if s.get("date", "") < current_date]
        return prev[-1] if prev else None
    return snapshots[-1] if len(snapshots) >= 2 else None


def compute_active_heatmap(
    work_patterns: dict[str, Any] | None,
) -> list[list[int]]:
    """Build 7×24 activity heatmap (rows=days, cols=hours).

    Returns [[0,0,0,...24],...7 rows] with activity counts.
    """
    # 7 days × 24 hours
    grid = [[0] * 24 for _ in range(7)]

    if not work_patterns:
        return grid

    evidence = work_patterns.get("evidence", {})
    hourly = evidence.get("hourly_distribution", {})
    # If only hourly data, apply to all days equally
    for hour_str, count in hourly.items():
        try:
            h = int(hour_str)
            if 0 <= h < 24:
                for day in range(7):
                    grid[day][h] += count // 7 or (1 if count > 0 else 0)
        except (ValueError, TypeError):
            continue

    return grid


def compute_ai_collaboration_index(
    work_patterns: dict[str, Any] | None,
) -> dict[str, Any]:
    """Compute AI collaboration index (active vs autonomous).

    Returns {"active_seek": 40, "autonomous": 60, "label": "主动求助"}
    """
    if not work_patterns:
        return {"active_seek": 0, "autonomous": 100, "label": "独立完成"}

    # Heuristic: count tool calls that are AI-initiated vs user-initiated
    # For now, use tool diversity as proxy
    preferred = work_patterns.get("preferred_tools", [])
    tool_diversity = len(preferred)

    # If user uses many different tools, they're more autonomous
    active_seek = max(20, min(80, 100 - tool_diversity * 8))
    autonomous = 100 - active_seek

    label = "主动求助" if active_seek > 50 else "混合模式" if active_seek > 30 else "独立完成"

    return {
        "active_seek": active_seek,
        "autonomous": autonomous,
        "label": label,
    }
