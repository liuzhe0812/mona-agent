"""Profile distillation task.

Aggregates data from notes + email + work patterns and distills
a comprehensive user profile using LLM.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from mona.distill.base import DistillContext, DistillResult, DistillTask
from mona.distill.collectors import (
    collect_email_stats,
    collect_notes_stats,
    collect_session_topics,
)
from mona.distill.store import read_rich_profile, read_user_profile
from mona.utils.prompt_templates import render_template

_TASK_NAME = "profile"
_USER_SECTION = "Profile"
_FOCUS_SECTION = "Current Focus"
_TEMPLATE = "distill/profile.md"


class ProfileTask(DistillTask):
    """Distill user profile from multiple data sources."""

    @property
    def name(self) -> str:
        return _TASK_NAME

    async def collect(self, ctx: DistillContext) -> dict[str, Any]:
        # Get notes vault path
        vault = _get_notes_vault()

        notes_stats = collect_notes_stats(vault)
        email_stats = collect_email_stats()
        session_stats = collect_session_topics(ctx.workspace, since=ctx.since)

        # Read existing work patterns + trajectory from rich profile
        rich = read_rich_profile(ctx.memory_dir)
        work_patterns = rich.get("work_patterns", {})
        prev_trajectory = rich.get("trajectory", [])

        # 读取 USER.md 作为先验（用户手写的偏好不应被 LLM 覆盖）
        user_prior = _extract_user_prior(read_user_profile(ctx.memory_dir))

        return {
            "notes": notes_stats.to_dict(),
            "email": email_stats.to_dict(),
            "work_patterns": work_patterns,
            "sessions": session_stats.to_dict(),
            "user_prior": user_prior,
            "prev_trajectory": prev_trajectory,
            # 历史痛点/开放问题（存在 profile 子键下），供 LLM 继承与更新 last_seen
            "prev_pain_points": rich.get("profile", {}).get("pain_points", []),
            "prev_open_questions": rich.get("profile", {}).get("open_questions", []),
        }

    async def distill(
        self, ctx: DistillContext, data: dict[str, Any]
    ) -> DistillResult:
        notes = data.get("notes", {})
        email = data.get("email", {})
        work_patterns = data.get("work_patterns", {})
        sessions = data.get("sessions", {})
        user_prior = data.get("user_prior", "")

        # If no data at all, skip
        if (
            notes.get("total_notes", 0) == 0
            and email.get("total_emails", 0) == 0
            and sessions.get("total_sessions", 0) == 0
        ):
            return DistillResult(
                task_name=_TASK_NAME,
                success=False,
                error="no notes, email, or session data available",
            )

        try:
            prompt = render_template(
                _TEMPLATE,
                notes=notes,
                email=email,
                work_patterns=work_patterns,
                sessions=sessions,
                user_prior=user_prior,
                prev_pain_points=data.get("prev_pain_points", []),
                prev_open_questions=data.get("prev_open_questions", []),
            )
        except Exception as e:
            return DistillResult(
                task_name=_TASK_NAME,
                success=False,
                error=f"failed to render prompt: {e}",
            )

        if ctx.provider is None:
            # Rule-based fallback
            result_data = _rule_based_profile(data)
            focus_md = _format_current_focus_markdown(
                result_data,
                data.get("prev_trajectory", []),
                data.get("work_patterns", {}),
            )
            extra = [(_FOCUS_SECTION, focus_md)] if focus_md else []
            return DistillResult(
                task_name=_TASK_NAME,
                success=True,
                confidence=result_data.get("confidence", 0.2),
                data=result_data,
                markdown=_format_profile_markdown(result_data),
                user_section=_USER_SECTION,
                extra_sections=extra,
            )

        try:
            from mona.distill.tasks.work_pattern import _call_llm, _parse_llm_response

            response = await _call_llm(ctx, prompt)
            parsed = _parse_llm_response(response)
            if parsed is None:
                return DistillResult(
                    task_name=_TASK_NAME,
                    success=False,
                    error="LLM returned invalid JSON",
                )

            # Enrich with evidence + computed visualizations
            from mona.distill.scoring import (
                build_knowledge_graph,
                build_skill_matrix,
                compute_radar_scores,
                detect_milestones,
                save_snapshot,
            )

            radar_scores = compute_radar_scores(notes, work_patterns, email)
            skill_matrix = build_skill_matrix(notes, radar_scores)
            knowledge_graph = build_knowledge_graph(notes)
            milestones = detect_milestones(notes)

            # Save snapshot for historical comparison
            try:
                save_snapshot(
                    ctx.memory_dir,
                    radar_scores,
                    notes.get("title_keywords", []),
                )
            except Exception as e:
                logger.debug(f"[profile] snapshot save failed: {e}")

            result_data = {
                **parsed,
                "evidence": {
                    "note_distribution": notes.get("notebook_distribution", []),
                    "tag_distribution": notes.get("tag_distribution", []),
                    "title_keywords": notes.get("title_keywords", []),
                    "top_senders": email.get("top_senders", []),
                    "top_subjects": email.get("top_subjects", []),
                    "notes_monthly": notes.get("monthly_distribution", {}),
                    "total_notes": notes.get("total_notes", 0),
                    "keyword_first_seen": notes.get("keyword_first_seen", {}),
                    "session_topics": [
                        {"title": t.get("title", ""), "tools": t.get("tools_used", [])}
                        for t in sessions.get("topics", [])[:20]
                    ],
                    "total_sessions": sessions.get("total_sessions", 0),
                },
                "visualizations": {
                    "radar_scores": radar_scores,
                    "skill_matrix": skill_matrix,
                    "knowledge_graph": knowledge_graph,
                    "milestones": milestones,
                    "tech_stack_radar": _build_tech_radar(parsed),
                    "knowledge_structure_bar": notes.get("notebook_distribution", [])[:10],
                    "relationship_graph": _build_relationship_graph(email),
                    "tag_cloud": notes.get("tag_distribution", [])[:20],
                },
            }

            return DistillResult(
                task_name=_TASK_NAME,
                success=True,
                confidence=parsed.get("confidence", 0.5),
                data=result_data,
                markdown=_format_profile_markdown(parsed),
                user_section=_USER_SECTION,
                extra_sections=_build_focus_extra(
                    parsed,
                    data.get("prev_trajectory", []),
                    data.get("work_patterns", {}),
                ),
            )
        except Exception as e:
            logger.exception("[profile] LLM distillation failed")
            return DistillResult(
                task_name=_TASK_NAME,
                success=False,
                error=str(e),
            )


def _get_notes_vault():
    """Get notes vault path via Tauri IPC if available."""
    try:
        from mona.agent.tools.notes import _get_vault_path
        return _get_vault_path()
    except Exception:
        return None


# USER.md 中对画像蒸馏有价值的 section（手写区，作为先验）
_PRIOR_SECTIONS = {
    "Basic Information",
    "Preferences",
    "Work Context",
    "Topics of Interest",
    "Special Instructions",
}


def _extract_user_prior(user_md: str) -> str:
    """从 USER.md 提取对画像蒸馏有价值的先验段落。

    只保留用户手写的偏好区，distill 写入的 Profile/Work Patterns 区不取。
    """
    if not user_md:
        return ""
    import re

    # 匹配 ## Title 到下一个 ## 或文件末尾
    pattern = re.compile(r"^## (.+?)$", re.MULTILINE)
    matches = list(pattern.finditer(user_md))
    parts: list[str] = []
    for i, m in enumerate(matches):
        section_name = m.group(1).strip()
        if section_name not in _PRIOR_SECTIONS:
            continue
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(user_md)
        section_text = user_md[start:end].strip()
        parts.append(section_text)
    return "\n\n".join(parts)


def _rule_based_profile(data: dict[str, Any]) -> dict[str, Any]:
    """Generate basic profile without LLM."""
    notes = data.get("notes", {})
    keywords = [k["keyword"] for k in notes.get("title_keywords", [])[:5]]
    return {
        "identity": {
            "primary_role": "unknown (insufficient data)",
            "secondary_roles": [],
            "timezone_hint": "",
        },
        "tech_stack": [{"area": "detected", "items": keywords}],
        "interests": keywords,
        # 规则降级无法可靠推断痛点，置空（禁止编造）
        "pain_points": [],
        "open_questions": [],
        "knowledge_structure": {
            "deep_areas": [n["notebook"] for n in notes.get("notebook_distribution", [])[:3]],
            "exploring_areas": [],
        },
        "relationships": {
            "frequent_contacts": [s.get("sender", "") for s in data.get("email", {}).get("top_senders", [])[:3]],
            "collaboration_pattern": "unknown",
        },
        "work_rhythm": {"active_hours": "unknown", "intensity": "unknown"},
        "confidence": 0.2,
    }


def _format_profile_markdown(data: dict[str, Any]) -> str:
    """Format profile as a compact narrative paragraph for USER.md.

    输出为紧凑的自然语言段落而非字段罗列，便于 agent 形成立体认知。
    每个信息簇独立成句，缺失字段跳过，不输出空标签。
    """
    sentences: list[str] = []

    # 身份与技术栈：合并为一句
    identity = data.get("identity", {})
    role = identity.get("primary_role") or ""
    secondary = identity.get("secondary_roles") or []
    role_phrase = role
    if role and secondary:
        role_phrase = f"{role}（兼{'、'.join(secondary[:2])}）"

    tech_stack = data.get("tech_stack", [])
    tech_items: list[str] = []
    for area in tech_stack:
        items = area.get("items") or []
        if items:
            tech_items.extend(items)
    if role_phrase and tech_items:
        sentences.append(
            f"用户是{role_phrase}，技术栈以{'、'.join(tech_items[:6])}为主"
        )
    elif role_phrase:
        sentences.append(f"用户是{role_phrase}")
    elif tech_items:
        sentences.append(f"技术栈以{'、'.join(tech_items[:6])}为主")

    # 知识结构：深度 + 探索
    ks = data.get("knowledge_structure", {})
    deep = ks.get("deep_areas") or []
    exploring = ks.get("exploring_areas") or []
    knowledge_parts: list[str] = []
    if deep:
        knowledge_parts.append(f"深度掌握{'、'.join(deep[:4])}")
    if exploring:
        knowledge_parts.append(f"正在探索{'、'.join(exploring[:3])}")
    if knowledge_parts:
        sentences.append("，".join(knowledge_parts))

    # 兴趣领域
    interests = data.get("interests") or []
    if interests:
        sentences.append(f"关注领域：{'、'.join(interests[:5])}")

    # 近期痛点：只注入 6 个月内仍有信号的，过期的自然降权不写入 USER.md
    pain_topics = _fresh_pain_topics(data.get("pain_points") or [], max_age_months=6)
    if pain_topics:
        sentences.append(f"近期反复困扰的问题：{'；'.join(pain_topics[:3])}")

    # 协作关系
    rel = data.get("relationships", {})
    contacts = rel.get("frequent_contacts") or []
    collab = rel.get("collaboration_pattern") or ""
    collab_parts: list[str] = []
    if contacts:
        collab_parts.append(f"主要协作对象：{'、'.join(contacts[:3])}")
    if collab and collab != "unknown":
        collab_parts.append(collab)
    if collab_parts:
        sentences.append("；".join(collab_parts))

    # 工作节奏
    rhythm = data.get("work_rhythm", {})
    hours = rhythm.get("active_hours") or ""
    intensity = rhythm.get("intensity") or ""
    rhythm_parts: list[str] = []
    if hours and hours != "unknown":
        rhythm_parts.append(f"活跃时段{hours}")
    if intensity and intensity != "unknown":
        rhythm_parts.append(f"强度{intensity}")
    if rhythm_parts:
        sentences.append("，".join(rhythm_parts))

    if not sentences:
        return "(insufficient data)"
    return "。".join(sentences) + "。"


def _fresh_pain_topics(
    pain_points: list[dict[str, Any]], max_age_months: int
) -> list[str]:
    """提取仍在保鲜期内的痛点 topic。

    last_seen 为 YYYY-MM；超过 max_age_months 未再出现的痛点视为已过期，
    保留在 rich.json 中供前端展示，但不再注入 agent 上下文。
    """
    from datetime import datetime

    now = datetime.now()
    current = now.year * 12 + now.month
    topics: list[str] = []
    for p in pain_points:
        if not isinstance(p, dict):
            continue
        topic = (p.get("topic") or "").strip()
        if not topic:
            continue
        last_seen = (p.get("last_seen") or "").strip()
        try:
            year, month = last_seen.split("-")
            seen = int(year) * 12 + int(month)
        except (ValueError, AttributeError):
            # 无有效时间戳时保守保留（由 LLM 每轮继承机制负责淘汰）
            topics.append(topic)
            continue
        if current - seen <= max_age_months:
            topics.append(topic)
    return topics


def _build_focus_extra(
    parsed: dict[str, Any],
    prev_trajectory: list[dict[str, Any]],
    work_patterns: dict[str, Any],
) -> list[tuple[str, str]]:
    """Build extra_sections entry for Current Focus, or empty list if nothing to say."""
    focus_md = _format_current_focus_markdown(parsed, prev_trajectory, work_patterns)
    return [(_FOCUS_SECTION, focus_md)] if focus_md else []


def _format_current_focus_markdown(
    parsed: dict[str, Any],
    prev_trajectory: list[dict[str, Any]],
    work_patterns: dict[str, Any],
) -> str:
    """生成 ## Current Focus 段：反映用户当前的关注点与最近变化。

    数据来源：
    - 当前主要关注领域：本次蒸馏的 interests + deep_areas
    - 最近新学技能：本次 tech_stack 中上次 trajectory 快照未出现的 items
    - 最近工作焦点：rich profile 中 work_patterns.work_focus

    整段控制在 ~150 tokens 以内，无内容时返回空字符串（不写入 USER.md）。
    """
    lines: list[str] = []

    # 1. 当前主要关注领域（合并 interests + deep_areas，最多 3 条）
    interests = parsed.get("interests") or []
    ks = parsed.get("knowledge_structure", {})
    deep = ks.get("deep_areas") or []
    focus_areas: list[str] = []
    for item in interests + deep:
        if item and item not in focus_areas:
            focus_areas.append(item)
        if len(focus_areas) >= 3:
            break
    if focus_areas:
        lines.append(f"- 当前关注：{'、'.join(focus_areas)}")

    # 2. 最近新学技能：对比上次 trajectory 快照（仅当存在历史 profile 快照时）
    prev_tech_items = _extract_prev_tech_items(prev_trajectory)
    if prev_tech_items is not None:
        curr_tech_items: list[str] = []
        for area in parsed.get("tech_stack", []) or []:
            for item in area.get("items") or []:
                if item and item not in curr_tech_items:
                    curr_tech_items.append(item)
        new_skills = [t for t in curr_tech_items if t not in prev_tech_items][:3]
        if new_skills:
            lines.append(f"- 最近新接触：{'、'.join(new_skills)}")

    # 3. 最近工作焦点：直接取 work_patterns.work_focus
    work_focus = work_patterns.get("work_focus") or ""
    if work_focus and work_focus != "unknown":
        lines.append(f"- 工作焦点：{work_focus}")

    if not lines:
        return ""
    return "\n".join(lines)


def _extract_prev_tech_items(
    prev_trajectory: list[dict[str, Any]],
) -> set[str] | None:
    """从 trajectory 历史快照中提取最近一次 profile 快照的 tech_stack items。

    返回 None 表示无历史 profile 快照（首次蒸馏），不应对比"新学技能"。
    返回空 set 表示有历史但 tech_stack 为空。
    """
    if not prev_trajectory:
        return None
    # 反向查找最近一次 profile 任务快照
    for point in reversed(prev_trajectory):
        if point.get("task") != "profile":
            continue
        snapshot = point.get("data_snapshot") or {}
        items: set[str] = set()
        for area in snapshot.get("tech_stack", []) or []:
            for item in area.get("items") or []:
                if item:
                    items.add(item)
        return items
    return None


def _build_tech_radar(parsed: dict[str, Any]) -> dict[str, Any]:
    """Build radar chart data for tech stack visualization."""
    tech_stack = parsed.get("tech_stack", [])
    axes = []
    for area in tech_stack:
        items = area.get("items", [])
        axes.append({
            "axis": area.get("area", "unknown"),
            "value": min(10, len(items) * 2),
        })
    return {"axes": axes}


def _build_relationship_graph(email: dict[str, Any]) -> dict[str, Any]:
    """Build relationship graph data for visualization."""
    senders = email.get("top_senders", [])
    nodes = [{"id": "user", "label": "You", "group": 0, "size": 20}]
    links = []
    for i, s in enumerate(senders[:10]):
        sender_id = f"contact_{i}"
        nodes.append({
            "id": sender_id,
            "label": s.get("sender", f"Contact {i+1}"),
            "group": 1,
            "size": min(20, 5 + s.get("count", 1)),
        })
        links.append({"source": "user", "target": sender_id, "weight": s.get("count", 1)})
    return {"nodes": nodes, "links": links}
