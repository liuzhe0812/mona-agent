"""Video content revisions and the workbench's observable project state."""

from __future__ import annotations

import math
import uuid
from typing import Any, Mapping


def ensure_scene_ids(meta: dict[str, Any], project_key: str) -> None:
    for scene in meta.get("scenes") or []:
        scene.setdefault("id", uuid.uuid5(uuid.NAMESPACE_URL, f"{project_key}/scene/{scene['index']}").hex)


def scene_edit_changes(scene: Mapping[str, Any], values: Any) -> dict[str, Any]:
    allowed = {"title", "duration", "narration", "visual", "animation", "assets"}
    if not isinstance(values, dict) or not values or set(values) - allowed:
        raise ValueError("请指定这个片段需要调整的旁白、画面、动画、时长或素材")
    for key, value in values.items():
        if key == "duration":
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError("片段时长必须大于零")
        elif key == "assets":
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                raise ValueError("片段素材格式无效")
        elif not isinstance(value, str) or key == "title" and not value.strip():
            raise ValueError("片段标题不能为空，旁白与画面要求须使用文字")
    return {key: value for key, value in values.items() if value != scene.get(key)}


def approve_scoped_edit(meta: dict[str, Any], scene: dict[str, Any], changes: dict[str, Any], instruction: str) -> None:
    scene.update(changes)
    if "duration" in changes:
        scene["durationRaw"] = f"{scene['duration']:g}s"
    revision = int(meta.get("planRevision") or 0) + 1
    meta.update({"planRevision": revision, "approvedPlanRevision": revision, "requirePlanApproval": True,
                 "lastEdit": {"sceneId": scene["id"], "sceneIndex": scene["index"],
                              "instruction": instruction, "fields": sorted(changes)}})


def workbench_state(meta: Mapping[str, Any], ready_indices: set[int], audio_ready_indices: set[int]) -> dict[str, Any]:
    scenes = meta.get("scenes") or []
    count = len(scenes)
    awaiting = bool(meta.get("requirePlanApproval")) and meta.get("approvedPlanRevision") != meta.get("planRevision", 0)
    if not count:
        stage = "planning"
    elif awaiting:
        stage = "awaiting-confirmation"
    elif len(ready_indices) == count:
        stage = "preview-ready"
    else:
        stage = "production-pending"
    return {"stage": stage, "sceneCount": count, "readySceneCount": len(ready_indices),
            "audioReadySceneCount": len(audio_ready_indices), "planRevision": meta.get("planRevision", 0),
            "lastEdit": meta.get("lastEdit")}
