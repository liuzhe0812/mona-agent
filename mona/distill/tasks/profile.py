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

        # Read existing work patterns from rich profile
        rich = read_rich_profile(ctx.memory_dir)
        work_patterns = rich.get("work_patterns", {})

        # 读取 USER.md 作为先验（用户手写的偏好不应被 LLM 覆盖）
        user_prior = _extract_user_prior(read_user_profile(ctx.memory_dir))

        return {
            "notes": notes_stats.to_dict(),
            "email": email_stats.to_dict(),
            "work_patterns": work_patterns,
            "sessions": session_stats.to_dict(),
            "user_prior": user_prior,
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
            return DistillResult(
                task_name=_TASK_NAME,
                success=True,
                confidence=result_data.get("confidence", 0.2),
                data=result_data,
                markdown=_format_profile_markdown(result_data),
                user_section=_USER_SECTION,
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
    """Format profile as markdown for USER.md."""
    lines = []
    identity = data.get("identity", {})
    if identity.get("primary_role"):
        lines.append(f"**Role:** {identity['primary_role']}")
        if identity.get("secondary_roles"):
            lines.append(f"**Secondary Roles:** {', '.join(identity['secondary_roles'])}")
        lines.append("")

    tech_stack = data.get("tech_stack", [])
    if tech_stack:
        lines.append("**Tech Stack:**")
        for area in tech_stack:
            items = area.get("items", [])
            if items:
                lines.append(f"- {area.get('area', '')}: {', '.join(items)}")
        lines.append("")

    interests = data.get("interests", [])
    if interests:
        lines.append(f"**Interests:** {', '.join(interests)}")
        lines.append("")

    ks = data.get("knowledge_structure", {})
    if ks.get("deep_areas"):
        lines.append(f"**Deep Knowledge:** {', '.join(ks['deep_areas'])}")
    if ks.get("exploring_areas"):
        lines.append(f"**Exploring:** {', '.join(ks['exploring_areas'])}")
    lines.append("")

    rel = data.get("relationships", {})
    if rel.get("frequent_contacts"):
        lines.append(f"**Frequent Contacts:** {', '.join(rel['frequent_contacts'])}")
    if rel.get("collaboration_pattern"):
        lines.append(f"**Collaboration:** {rel['collaboration_pattern']}")
    lines.append("")

    rhythm = data.get("work_rhythm", {})
    if rhythm.get("active_hours"):
        lines.append(f"**Active Hours:** {rhythm['active_hours']}")
    if rhythm.get("intensity"):
        lines.append(f"**Work Intensity:** {rhythm['intensity']}")

    return "\n".join(lines) if lines else "(insufficient data)"


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
