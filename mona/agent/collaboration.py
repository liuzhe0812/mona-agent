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
MAX_DISCUSSION_ROUNDS = 99


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


class DiscussionMode(str, Enum):
    """User-selected shape for a bounded, multi-round room discussion."""

    DEBATE = "debate"
    DISCUSSION = "discussion"


class DebateStyle(str, Enum):
    """Fixed expression presets available to individual debate participants."""

    SHARP_PUNCHLINE = "sharp_punchline"
    VALUE_REFRAME = "value_reframe"
    RATIONAL_EMPATHY = "rational_empathy"
    EVERYDAY_SPICY = "everyday_spicy"
    CONCEPT_DECONSTRUCTION = "concept_deconstruction"
    SIMPLE_ANALOGY = "simple_analogy"


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


def build_discussion_workflow(
    room_id: str,
    topic: str,
    ordered_target_ids: Sequence[str],
    *,
    mode: DiscussionMode | str,
    max_rounds: int,
    positions: Mapping[str, str] | None = None,
    styles: Mapping[str, str] | None = None,
    summary_agent_id: str | None = MONA_AGENT_ID,
) -> WorkflowDefinition:
    """Build a bounded, round-robin debate or free discussion workflow."""

    if not isinstance(room_id, str) or not room_id.strip():
        raise ValueError("room_id must be a non-empty string")
    if not isinstance(topic, str) or not topic.strip():
        raise ValueError("discussion topic must be a non-empty string")
    if isinstance(max_rounds, bool) or not isinstance(max_rounds, int):
        raise ValueError("max_rounds must be an integer")
    if not 1 <= max_rounds <= MAX_DISCUSSION_ROUNDS:
        raise ValueError(
            f"max_rounds must be between 1 and {MAX_DISCUSSION_ROUNDS}"
        )
    try:
        selected_mode = mode if isinstance(mode, DiscussionMode) else DiscussionMode(str(mode).strip().lower())
    except ValueError as exc:
        raise ValueError(f"unsupported discussion mode {mode!r}") from exc

    targets = _normalized_targets(ordered_target_ids)
    summary_agent = (
        normalize_agent_id(summary_agent_id)
        if summary_agent_id is not None
        else None
    )
    raw_positions = positions or {}
    if not isinstance(raw_positions, Mapping):
        raise ValueError("positions must be an object")
    normalized_positions: dict[str, str] = {}
    for agent_id in targets:
        raw_position = raw_positions.get(agent_id, "")
        if raw_position is not None and not isinstance(raw_position, str):
            raise ValueError(f"position for {agent_id!r} must be a string")
        position = (raw_position or "").strip()
        if selected_mode is DiscussionMode.DEBATE and not position:
            raise ValueError(f"debate position is required for {agent_id!r}")
        normalized_positions[agent_id] = position

    raw_styles = styles or {}
    if not isinstance(raw_styles, Mapping):
        raise ValueError("styles must be an object")
    if selected_mode is DiscussionMode.DISCUSSION and raw_styles:
        raise ValueError("debate styles are only available in debate mode")
    for raw_agent_id, raw_style in raw_styles.items():
        if not isinstance(raw_agent_id, str) or raw_agent_id not in targets:
            raise ValueError(f"debate style targets unknown participant {raw_agent_id!r}")
        if not isinstance(raw_style, str):
            raise ValueError(f"debate style for {raw_agent_id!r} must be a string")
        try:
            DebateStyle(raw_style)
        except ValueError as exc:
            raise ValueError(f"unsupported debate style {raw_style!r}") from exc

    text = topic.strip()
    steps: list[WorkflowStep] = []
    previous_step_id: str | None = None
    first_round_step_ids: list[str] = []
    for round_number in range(1, max_rounds + 1):
        for speaker_number, agent_id in enumerate(targets, start=1):
            step_id = f"round-{round_number}-speaker-{speaker_number}"
            if selected_mode is DiscussionMode.DEBATE:
                role = (
                    f"你的唯一立场是：{normalized_positions[agent_id]}。"
                    "第一句话必须直接重申这一选择，之后只能为该立场辩护并反驳对方。"
                    "不得客观分析双方、不得中立、不得改换立场，也不得建议折中或兼得。"
                )
            else:
                if round_number == 1:
                    role = (
                        "这是独立发散阶段。请从自身专业角色出发独立提出不同方向，"
                        "暂不评价其他参与者；给出方案价值、关键组成和主要约束。"
                    )
                elif round_number == max_rounds:
                    role = (
                        "这是方案收敛阶段。停止继续增加无关分支，综合此前有效观点，"
                        "提出推荐方案、关键取舍、实施步骤和仍待确认的问题。"
                    )
                else:
                    role = (
                        "这是交叉评审阶段。明确选择此前至少一个方案进行评价，"
                        "指出优势、风险和冲突，去除重复内容并尝试组合互补部分。"
                    )
            task = (
                f"你正在参加群聊中的结构化{('辩论' if selected_mode is DiscussionMode.DEBATE else '讨论')}。"
                f"议题：{text}\n"
                f"当前是第 {round_number}/{max_rounds} 轮，你是本轮第 {speaker_number}/{len(targets)} 位发言者。"
                f"{role}阅读共享群聊快照中的此前发言后直接发表本轮观点。"
                "不要代替其他 Agent 发言，不要提前生成全场总结。"
                + (
                    "这是最后一轮结辩：请收束本方完整论证，回应对方最关键的攻击，"
                    "比较双方的判断标准并说明本方为何应当获胜；原则上不要引入此前未铺垫的新主论点。"
                    if selected_mode is DiscussionMode.DEBATE and round_number == max_rounds
                    else ""
                )
            )
            if selected_mode is DiscussionMode.DISCUSSION and round_number == 1:
                dependencies: Sequence[str] = ()
            elif (
                selected_mode is DiscussionMode.DISCUSSION
                and round_number == 2
                and speaker_number == 1
            ):
                dependencies = first_round_step_ids
            else:
                dependencies = [previous_step_id] if previous_step_id else ()
            steps.append(
                _step(
                    step_id,
                    agent_id,
                    task,
                    f"第 {round_number} 轮中 {agent_id} 的观点",
                    dependencies,
                )
            )
            if selected_mode is DiscussionMode.DISCUSSION and round_number == 1:
                first_round_step_ids.append(step_id)
            previous_step_id = step_id

    if selected_mode is DiscussionMode.DEBATE:
        final_task = (
            "你是本次结构化辩论的中立裁判。"
            f"议题：{text}\n"
            "请只根据共享群聊中的实际发言完成裁决：先公平综述双方核心主张和主要交锋，"
            "再从论点清晰度、论据质量、回应对方的有效性、前后一致性四个方面进行比较，"
            "最后明确判定哪一方更胜一筹并解释决定性原因。"
            "只有双方确实势均力敌时才可判平；不得回避裁决，也不得补写未出现的观点。"
        )
        final_output = "中立裁判结论（双方综述、比较评估与胜负判定）"
    else:
        final_task = (
            "你是本次结构化方案讨论的总结者。"
            f"议题：{text}\n"
            "请根据共享群聊中各 Agent 的实际发言，整理一份可执行的最终方案，依次说明："
            "目标与约束、候选方向、采用的最终方案、核心组成、关键取舍、实施步骤、"
            "主要风险、待确认问题。不要补写参与者未表达过的观点。"
        )
        final_output = "最终方案（目标、方案、取舍、步骤、风险与待确认问题）"
    if summary_agent is not None:
        final_dependencies = (
            first_round_step_ids
            if selected_mode is DiscussionMode.DISCUSSION and max_rounds == 1
            else [previous_step_id] if previous_step_id else ()
        )
        steps.append(
            _step(
                "summary",
                summary_agent,
                final_task,
                final_output,
                final_dependencies,
            )
        )

    return WorkflowDefinition(
        id=f"discussion-{selected_mode.value}-{uuid.uuid4().hex}",
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
    "DebateStyle",
    "DiscussionMode",
    "MAX_COLLABORATION_TARGETS",
    "MAX_DISCUSSION_ROUNDS",
    "MAX_RUN_COLLABORATION_STEPS",
    "build_collaboration_workflow",
    "build_discussion_workflow",
    "infer_collaboration_mode",
    "parse_collaboration_steps",
    "parse_run_collaboration_steps",
]
