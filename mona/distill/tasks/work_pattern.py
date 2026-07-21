"""Work pattern distillation task.

Analyzes tool call history and distills work patterns using LLM.
Writes results to USER.md (Work Patterns section) and profile.rich.json.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from loguru import logger

from mona.distill.base import DistillContext, DistillResult, DistillTask
from mona.distill.collectors import collect_tool_calls
from mona.utils.prompt_templates import render_template


_TASK_NAME = "work-pattern"
_USER_SECTION = "Work Patterns"
_TEMPLATE = "distill/work_pattern.md"


class WorkPatternTask(DistillTask):
    """Distill user work patterns from tool call history."""

    @property
    def name(self) -> str:
        return _TASK_NAME

    async def collect(self, ctx: DistillContext) -> dict[str, Any]:
        stats = collect_tool_calls(
            workspace=ctx.workspace,
            since=ctx.since,
            until=ctx.until,
        )
        return stats.to_dict()

    async def distill(
        self, ctx: DistillContext, data: dict[str, Any]
    ) -> DistillResult:
        # If no data, return early
        if data.get("total_calls", 0) == 0:
            logger.debug("[work_pattern] no tool calls found, skipping")
            return DistillResult(
                task_name=_TASK_NAME,
                success=False,
                error="no tool call data available",
            )

        # Render prompt
        try:
            prompt = render_template(_TEMPLATE, **data)
        except Exception as e:
            return DistillResult(
                task_name=_TASK_NAME,
                success=False,
                error=f"failed to render prompt: {e}",
            )

        # Call LLM
        if ctx.provider is None:
            # No LLM available — produce a rule-based fallback
            result_data = _rule_based_fallback(data)
            return DistillResult(
                task_name=_TASK_NAME,
                success=True,
                confidence=result_data.get("confidence", 0.3),
                data=result_data,
                markdown=_format_markdown(result_data),
                user_section=_USER_SECTION,
            )

        try:
            response = await _call_llm(ctx, prompt)
            parsed = _parse_llm_response(response)
            if parsed is None:
                return DistillResult(
                    task_name=_TASK_NAME,
                    success=False,
                    error="LLM returned invalid JSON",
                )

            # Enrich with evidence for profile.rich.json
            result_data = {
                **parsed,
                "evidence": {
                    "top_tools": data.get("top_tools", []),
                    "tool_chains": data.get("tool_chains", []),
                    "hourly_distribution": data.get("hourly_distribution", {}),
                    "daily_distribution": data.get("daily_distribution", {}),
                    "tool_success": data.get("tool_success", {}),
                },
                "visualizations": {
                    "top_tools_chart": data.get("top_tools", [])[:10],
                    "tool_chain_sankey": data.get("tool_chains", [])[:10],
                    "active_hours_heatmap": _build_hourly_heatmap(data),
                },
            }

            return DistillResult(
                task_name=_TASK_NAME,
                success=True,
                confidence=parsed.get("confidence", 0.5),
                data=result_data,
                markdown=_format_markdown(parsed),
                user_section=_USER_SECTION,
            )
        except Exception as e:
            logger.exception("[work_pattern] LLM distillation failed")
            return DistillResult(
                task_name=_TASK_NAME,
                success=False,
                error=str(e),
            )


def _build_hourly_heatmap(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Build 24x7 hourly heatmap data (hour x weekday)."""
    hourly = data.get("hourly_distribution", {})
    # We don't have weekday info from collector, so just return hourly
    return [{"hour": int(h), "count": c} for h, c in hourly.items()]


def _rule_based_fallback(data: dict[str, Any]) -> dict[str, Any]:
    """Generate a basic work pattern summary without LLM."""
    top_tools = data.get("top_tools", [])[:5]
    frequent_tasks = [t["tool"] for t in top_tools]
    return {
        "frequent_tasks": frequent_tasks,
        "preferred_tools": frequent_tasks[:3],
        "tool_chains": [c["chain"] for c in data.get("tool_chains", [])[:3]],
        "active_hours": "unknown (rule-based)",
        "output_style": "adaptive",
        "work_focus": f"Primarily uses: {', '.join(frequent_tasks[:3])}",
        "confidence": 0.3,
    }


def _format_markdown(data: dict[str, Any]) -> str:
    """Format work patterns as markdown for USER.md."""
    lines = []
    tasks = data.get("frequent_tasks", [])
    if tasks:
        lines.append("**Frequent Tasks:**")
        for t in tasks:
            lines.append(f"- {t}")
        lines.append("")

    tools = data.get("preferred_tools", [])
    if tools:
        lines.append("**Preferred Tools:**")
        lines.append(", ".join(tools))
        lines.append("")

    chains = data.get("tool_chains", [])
    if chains:
        lines.append("**Common Tool Sequences:**")
        for c in chains:
            lines.append(f"- {c}")
        lines.append("")

    active = data.get("active_hours")
    if active:
        lines.append(f"**Active Hours:** {active}")
        lines.append("")

    style = data.get("output_style")
    if style:
        lines.append(f"**Output Style:** {style}")
        lines.append("")

    focus = data.get("work_focus")
    if focus:
        lines.append(f"**Work Focus:** {focus}")
        lines.append("")

    return "\n".join(lines) if lines else "(insufficient data)"


async def _call_llm(ctx: DistillContext, prompt: str) -> str:
    """Call LLM provider with distillation prompt."""
    messages = [
        {"role": "system", "content": "你是一位用户行为分析师。只输出合法 JSON。"},
        {"role": "user", "content": prompt},
    ]
    response = await ctx.provider.chat(
        messages=messages,
        model=ctx.model_name or None,
        temperature=0.3,
        max_tokens=1024,
    )
    # LLMResponse has .content attribute
    return response.content or ""


def _parse_llm_response(text: str) -> dict[str, Any] | None:
    """Parse LLM JSON response, stripping markdown fences if present."""
    text = text.strip()
    # Strip markdown code fences
    if text.startswith("```"):
        lines = text.splitlines()
        # Remove first and last fence lines
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines)

    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        # Try to extract JSON from surrounding text
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                pass
    return None
