"""Persisted per-task execution plans for WebUI conversations."""

from __future__ import annotations

from typing import Any, Mapping, MutableMapping

TASK_PLAN_KEY = "task_plan"
ARTIFACT_TASK_STATE_KEY = "artifact_task"
TASK_PLAN_STATUSES = ("pending", "in_progress", "completed")


def _normalize_steps(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    steps: list[dict[str, str]] = []
    for index, item in enumerate(raw[:20]):
        if not isinstance(item, dict):
            continue
        text = str(item.get("step") or item.get("description") or "").strip()[:400]
        status = str(item.get("status") or "pending").strip()
        if not text or status not in TASK_PLAN_STATUSES:
            continue
        step_id = str(item.get("id") or f"step_{index + 1}").strip()[:80]
        steps.append({"id": step_id or f"step_{index + 1}", "step": text, "status": status})
    return steps


def task_plan_ws_blob(metadata: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if not metadata:
        return None
    raw = metadata.get(TASK_PLAN_KEY)
    if not isinstance(raw, dict):
        return None
    task_id = raw.get("task_id")
    revision = raw.get("revision")
    blob: dict[str, Any] = {
        "task_id": task_id if isinstance(task_id, str) and task_id else None,
        "revision": revision if isinstance(revision, int) and revision >= 0 else 0,
        "steps": _normalize_steps(raw.get("steps")),
    }
    explanation = str(raw.get("explanation") or "").strip()[:800]
    if explanation:
        blob["explanation"] = explanation
    source = raw.get("source")
    if source in {"ai", "awaiting_ai"}:
        blob["source"] = source
    else:
        blob["source"] = "legacy"
    return blob


def reset_task_plan(
    metadata: MutableMapping[str, Any],
    task_id: str,
) -> dict[str, Any]:
    plan = {
        "task_id": task_id,
        "revision": 0,
        "steps": [],
        "source": "awaiting_ai",
    }
    metadata[TASK_PLAN_KEY] = plan
    return plan


def task_plan_runtime_lines(metadata: Mapping[str, Any] | None) -> list[str]:
    blob = task_plan_ws_blob(metadata)
    if not blob or blob.get("source") != "ai" or not blob["steps"]:
        return []
    lines = ["Current task plan (keep statuses updated with update_plan):"]
    lines.extend(f"- [{step['status']}] {step['step']}" for step in blob["steps"])
    return lines
