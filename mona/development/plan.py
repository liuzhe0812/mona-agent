"""A small optional plan tool; the UI never invents or auto-completes steps."""
from __future__ import annotations

import json
from typing import Literal

from pydantic import Field, ValidationError, model_validator

from mona.agent.tools.base import Tool
from mona.development.contracts import Contract
from mona.development.store import ConflictError, DevelopmentStore


class PlanStep(Contract):
    step: str = Field(min_length=1, max_length=240)
    status: Literal["pending", "in_progress", "completed"]


class DevelopmentPlan(Contract):
    explanation: str = Field(default="", max_length=2000)
    plan: list[PlanStep] = Field(max_length=30)

    @model_validator(mode="after")
    def check_progress(self):
        if sum(s.status == "in_progress" for s in self.plan) > 1:
            raise ValueError("同一计划只能有一个正在执行的步骤。")
        if any(not s.step.strip() for s in self.plan):
            raise ValueError("计划步骤不能为空。")
        return self


def normalize_plan(payload: dict) -> dict:
    try:
        steps = payload.get("plan")
        if not isinstance(steps, list):
            raise ValueError("Missing plan")
        rows = [{"step": s["step"], "status": "in_progress" if s.get("status") == "inProgress" else s.get("status")} for s in steps]
        return DevelopmentPlan(plan=rows, explanation=payload.get("explanation") or "").model_dump(mode="json")
    except (ValidationError, ValueError, KeyError, TypeError, AttributeError):
        return {"plan": [], "issue": "执行者返回的计划格式不完整，请查看执行记录。"}


class DevelopmentPlanTool(Tool):
    def __init__(self, store: DevelopmentStore, run_id: str):
        self.store, self.run_id = store, run_id

    @property
    def name(self) -> str:
        return "update_plan"

    @property
    def description(self) -> str:
        return "仅在复杂任务需要时记录简短计划及真实进展；简单任务直接执行。完成后明确更新步骤，不因回复结束自动完成。"

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {
            "explanation": {"type": "string", "maxLength": 2000},
            "plan": {"type": "array", "maxItems": 30, "items": {
                "type": "object", "properties": {"step": {"type": "string", "minLength": 1, "maxLength": 240},
                    "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}},
                "required": ["step", "status"], "additionalProperties": False}}},
            "required": ["plan"], "additionalProperties": False}

    async def execute(self, plan: list, explanation: str = "") -> str:
        value = DevelopmentPlan(plan=plan, explanation=explanation)
        if not self.store.append_run_event(self.run_id, "run.plan", value.model_dump(mode="json")):
            raise ConflictError("本轮已经结束，未修改计划。")
        return json.dumps({"ok": True, "plan": value.model_dump(mode="json")}, ensure_ascii=False)
