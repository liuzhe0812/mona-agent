"""Pure planning helpers for one-shot multi-agent room collaboration.

The planner only builds a :class:`~mona.agent.workflow.WorkflowDefinition`.
It deliberately reuses the existing workflow model and runner instead of
creating a second execution engine.  Runtime membership, dependency and cycle
checks remain the responsibility of the existing workflow validation layer.
"""

from __future__ import annotations

import re
import uuid
from enum import Enum
from typing import Any, Mapping, Sequence

from mona.agent.partners import MONA_AGENT_ID, normalize_agent_id
from mona.agent.workflow import (
    WorkflowDefinition,
    WorkflowStep,
    WorkflowTrigger,
    WorkflowValidationError,
)

MIN_COLLABORATION_TARGETS = 2
MAX_COLLABORATION_TARGETS = 8
MAX_RUN_COLLABORATION_STEPS = 8


class CollaborationMode(str, Enum):
    """Execution shape for a single natural-language collaboration turn."""

    PARALLEL = "parallel"
    SERIAL = "serial"
    REVIEW = "review"
    SUMMARY = "summary"
    # Lower-case aliases mirror the wire values for callers that prefer them.
    parallel = PARALLEL
    serial = SERIAL
    review = REVIEW
    summary = SUMMARY


# Keep these phrases intentionally small and explicit.  Agent display names
# never participate in routing; the caller supplies already structured IDs.
_SUMMARY_TERMS = ("总结", "汇总", "综合")
_REVIEW_TERMS = ("复核", "审查", "评审", "检查")
_SERIAL_TERMS = ("然后", "接着")
_SERIAL_PATTERN = re.compile(r"先[\s\S]{0,120}(?:再|然后|接着)")


def _normalized_targets(
    ordered_target_ids: Sequence[str],
    *,
    require_count: bool = True,
) -> list[str]:
    """Normalize structured IDs while preserving first-seen order."""

    if isinstance(ordered_target_ids, (str, bytes)):
        raise ValueError("ordered_target_ids must be a sequence of agent IDs")
    if not isinstance(ordered_target_ids, Sequence):
        raise ValueError("ordered_target_ids must be a sequence of agent IDs")

    result: list[str] = []
    for raw_id in ordered_target_ids:
        if not isinstance(raw_id, str):
            raise ValueError("agent IDs must be strings")
        try:
            agent_id = normalize_agent_id(raw_id)
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValueError(f"invalid structured agent ID {raw_id!r}") from exc
        if agent_id not in result:
            result.append(agent_id)

    if require_count and not MIN_COLLABORATION_TARGETS <= len(result) <= MAX_COLLABORATION_TARGETS:
        raise ValueError(
            "collaboration requires 2-8 unique target agent IDs"
        )
    if not require_count and not result:
        raise ValueError("collaboration requires at least one target agent ID")
    if len(result) > MAX_COLLABORATION_TARGETS:
        raise ValueError("collaboration supports at most 8 target agent IDs")
    return result


def _coerce_mode(mode: CollaborationMode | str) -> CollaborationMode:
    if isinstance(mode, CollaborationMode):
        return mode
    try:
        return CollaborationMode(str(mode).strip().lower())
    except ValueError as exc:
        raise ValueError(f"unsupported collaboration mode {mode!r}") from exc


def infer_collaboration_mode(
    content: str,
    ordered_target_ids: Sequence[str],
) -> CollaborationMode:
    """Infer a mode from explicit Chinese intent phrases.

    Priority is summary > review > serial > parallel.  Target IDs are
    validated only as IDs; no display-name or fuzzy matching is attempted.
    """

    if not isinstance(content, str) or not content.strip():
        raise ValueError("collaboration content must be a non-empty string")
    _normalized_targets(ordered_target_ids)
    text = content.strip()
    if any(term in text for term in _SUMMARY_TERMS):
        return CollaborationMode.SUMMARY
    if any(term in text for term in _REVIEW_TERMS):
        return CollaborationMode.REVIEW
    if _SERIAL_PATTERN.search(text) or any(term in text for term in _SERIAL_TERMS):
        return CollaborationMode.SERIAL
    return CollaborationMode.PARALLEL


def _agent_task(agent_id: str, content: str, role: str) -> str:
    return (
        f"你是本步骤的 Agent {agent_id}，职责是{role}。"
        f"只完成属于 {agent_id} 的任务，不要代替其他 Agent 作答。"
        f"用户原始要求：{content}"
    )


def _step(
    step_id: str,
    agent_id: str,
    task: str,
    expected_output: str,
    depends_on: Sequence[str] = (),
) -> WorkflowStep:
    return WorkflowStep(
        id=step_id,
        type="agent",
        agent_id=agent_id,
        task=task,
        expected_output=expected_output,
        depends_on=list(depends_on),
    )


def build_collaboration_workflow(
    room_id: str,
    content: str,
    ordered_target_ids: Sequence[str],
    mode: CollaborationMode | str,
) -> WorkflowDefinition:
    """Build a one-shot, manually triggered workflow for one room turn."""

    if not isinstance(room_id, str) or not room_id.strip():
        raise ValueError("room_id must be a non-empty string")
    if not isinstance(content, str) or not content.strip():
        raise ValueError("collaboration content must be a non-empty string")

    targets = _normalized_targets(ordered_target_ids)
    selected_mode = _coerce_mode(mode)
    text = content.strip()
    steps: list[WorkflowStep] = []

    if selected_mode is CollaborationMode.SUMMARY:
        partners = [agent_id for agent_id in targets if agent_id != MONA_AGENT_ID]
        if not partners:
            raise ValueError("summary mode requires at least one partner Agent")
        partner_step_ids: list[str] = []
        for index, agent_id in enumerate(partners, start=1):
            step_id = f"partner-{index}"
            partner_step_ids.append(step_id)
            steps.append(
                _step(
                    step_id,
                    agent_id,
                    _agent_task(agent_id, text, "独立产出供 Mona 汇总的专业结果"),
                    f"{agent_id} 的独立分析结果",
                )
            )
        steps.append(
            _step(
                "summary",
                MONA_AGENT_ID,
                (
                    f"你是本步骤的 Agent {MONA_AGENT_ID}，职责是唯一最终总结。"
                    f"只完成属于 {MONA_AGENT_ID} 的任务，不要代替其他 Agent 作答。"
                    f"仅根据上游步骤 {', '.join(partner_step_ids)} 的结果，"
                    "给出一份唯一、清晰的最终结论；保留重要分歧、失败和缺失信息。"
                    "不要重新代答上游 Agent 的独立任务，也不要创建新的协作任务。"
                    f"用户原始要求：{text}"
                ),
                "唯一最终总结（包含分歧与失败信息）",
                partner_step_ids,
            )
        )
    else:
        for index, agent_id in enumerate(targets, start=1):
            step_id = f"agent-{index}"
            dependencies: list[str] = []
            if selected_mode is CollaborationMode.SERIAL and index > 1:
                dependencies = [f"agent-{index - 1}"]
            elif selected_mode is CollaborationMode.REVIEW and index > 1:
                dependencies = ["agent-1"]

            if selected_mode is CollaborationMode.REVIEW and index == 1:
                role = "先产出待复核的原始结果"
            elif selected_mode is CollaborationMode.REVIEW:
                role = "复核上游步骤 agent-1 的结果，指出依据、问题和修正建议"
            elif selected_mode is CollaborationMode.SERIAL and index > 1:
                role = f"在上游步骤 agent-{index - 1} 的结果基础上继续完成当前任务"
            else:
                role = "独立完成当前 Agent 的任务"
            steps.append(
                _step(
                    step_id,
                    agent_id,
                    _agent_task(agent_id, text, role),
                    f"{agent_id} 的{('复核' if selected_mode is CollaborationMode.REVIEW and index > 1 else '任务')}结果",
                    dependencies,
                )
            )

    return WorkflowDefinition(
        id=f"collab-{uuid.uuid4().hex}",
        room_id=room_id.strip(),
        revision=1,
        status="active",
        goal=text,
        trigger=WorkflowTrigger(type="manual"),
        steps=steps,
        created_by="user",
    )


def parse_run_collaboration_steps(
    raw_steps: Sequence[Mapping[str, Any]],
) -> list[WorkflowStep]:
    """Parse ``run_collaboration`` step payloads into existing step models.

    An omitted ``depends_on`` means the immediately preceding declared step;
    an explicit empty list remains parallel.  This parser intentionally does
    not inspect graph validity; ``execution_layers`` and ``validate_workflow``
    remain the single source of truth for unknown dependencies and cycles.
    """

    if isinstance(raw_steps, (str, bytes)) or not isinstance(raw_steps, Sequence):
        raise WorkflowValidationError("steps must be a sequence")
    if not raw_steps:
        raise WorkflowValidationError("steps must be a non-empty list")
    if len(raw_steps) > MAX_RUN_COLLABORATION_STEPS:
        raise WorkflowValidationError("run_collaboration supports at most 8 steps")

    parsed: list[WorkflowStep] = []
    used_ids: set[str] = set()
    for index, raw in enumerate(raw_steps):
        if not isinstance(raw, Mapping):
            raise WorkflowValidationError(f"step {index + 1} must be an object")
        data = dict(raw)
        step_id = str(data.get("id") or f"s{index + 1}").strip().lower()
        if step_id in used_ids:
            raise WorkflowValidationError(f"duplicate step id {step_id!r}")
        used_ids.add(step_id)
        data["id"] = step_id
        if data.get("depends_on") is None:
            data["depends_on"] = [parsed[-1].id] if parsed else []
        try:
            parsed.append(WorkflowStep.model_validate(data))
        except Exception as exc:
            raise WorkflowValidationError(f"step {step_id!r}: {exc}") from exc
    return parsed


# Public aliases keep callers readable while retaining one implementation.
parse_collaboration_steps = parse_run_collaboration_steps


__all__ = [
    "CollaborationMode",
    "MAX_COLLABORATION_TARGETS",
    "MAX_RUN_COLLABORATION_STEPS",
    "build_collaboration_workflow",
    "infer_collaboration_mode",
    "parse_collaboration_steps",
    "parse_run_collaboration_steps",
]
