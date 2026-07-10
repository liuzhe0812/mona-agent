"""Storage layer for distillation results.

Writes to two stores atomically:
- USER.md (concise, for AI on-demand reading) — section-level update
- profile.rich.json (rich, for frontend visualization) — full structured data
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from mona.distill.base import DistillResult

_RICH_PROFILE_FILENAME = "profile.rich.json"
_USER_FILENAME = "USER.md"
_PROFILE_VERSION = "1.0"

# task_name → profile.rich.json 顶层 key 映射
_TASK_KEY_MAP: dict[str, str] = {
    "work-pattern": "work_patterns",
    "profile": "profile",
}


def get_rich_profile_path(memory_dir: Path) -> Path:
    return memory_dir / _RICH_PROFILE_FILENAME


def read_rich_profile(memory_dir: Path) -> dict[str, Any]:
    """Read profile.rich.json, returning empty structure if not exists."""
    path = get_rich_profile_path(memory_dir)
    if not path.exists():
        return _empty_rich_profile()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return _empty_rich_profile()
        return data
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"[distill.store] failed to read rich profile: {e}")
        return _empty_rich_profile()


def _empty_rich_profile() -> dict[str, Any]:
    return {
        "version": _PROFILE_VERSION,
        "last_distilled_at": None,
        "facts": {},
        "work_patterns": {},
        "profile": {},
        "evidence": {},
        "trajectory": [],
        "visualizations": {},
    }


def write_rich_profile(memory_dir: Path, data: dict[str, Any]) -> None:
    """Write profile.rich.json atomically."""
    path = get_rich_profile_path(memory_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    data["last_distilled_at"] = datetime.now().isoformat()
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def update_user_section(user_path: Path, section: str, content: str) -> None:
    """Update a markdown section in USER.md by heading name.

    Replaces the content under `## {section}` heading (including sub-headings).
    Preserves other sections. If section not found, appends it.
    """
    if not user_path.exists():
        # Create with new section
        full = f"# User Profile\n\n## {section}\n\n{content}\n"
        user_path.write_text(full, encoding="utf-8")
        return

    text = user_path.read_text(encoding="utf-8")
    # Match `## {section}` at start of line, capture until next `## ` or end
    pattern = re.compile(
        r"(^##\s+" + re.escape(section) + r"\s*\n)(.*?)(?=^##\s+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    new_block = f"## {section}\n\n{content.strip()}\n\n"
    if pattern.search(text):
        text = pattern.sub(new_block, text)
    else:
        # Append new section
        if not text.endswith("\n\n"):
            text += "\n\n"
        text += new_block
    user_path.write_text(text, encoding="utf-8")


def append_trajectory_point(memory_dir: Path, point: dict[str, Any]) -> None:
    """Append a trajectory data point to profile.rich.json."""
    profile = read_rich_profile(memory_dir)
    trajectory = profile.setdefault("trajectory", [])
    trajectory.append(point)
    write_rich_profile(memory_dir, profile)


def write_distill_result(memory_dir: Path, result: DistillResult) -> None:
    """Write distill result to both stores.

    - Updates USER.md section if result.user_section is set
    - Merges result.data into profile.rich.json under result.task_name key
    - Appends trajectory point if result.data contains trajectory data
    """
    # 1. Update USER.md
    if result.user_section and result.markdown:
        user_path = memory_dir / _USER_FILENAME
        try:
            update_user_section(user_path, result.user_section, result.markdown)
            logger.debug(f"[distill.store] updated USER.md section: {result.user_section}")
        except Exception as e:
            logger.error(f"[distill.store] failed to update USER.md: {e}")

    # 2. Update profile.rich.json
    profile = read_rich_profile(memory_dir)
    if result.data:
        # 映射 task_name 到 profile.rich.json 的顶层 key
        task_key = _TASK_KEY_MAP.get(result.task_name, result.task_name.replace("-", "_"))
        profile[task_key] = result.data
        # Also populate evidence and visualizations if present
        if "evidence" in result.data:
            profile.setdefault("evidence", {}).update(result.data["evidence"])
        if "visualizations" in result.data:
            profile.setdefault("visualizations", {}).update(result.data["visualizations"])

    # 3. Append trajectory point
    if result.success and result.confidence > 0:
        trajectory_point = {
            "timestamp": datetime.now().isoformat(),
            "task": result.task_name,
            "confidence": result.confidence,
            "data_snapshot": {
                k: v for k, v in result.data.items()
                if k not in ("evidence", "visualizations")
            },
        }
        profile.setdefault("trajectory", []).append(trajectory_point)

    write_rich_profile(memory_dir, profile)
    logger.info(
        f"[distill.store] wrote result for task '{result.task_name}' "
        f"(confidence={result.confidence:.2f})"
    )


def read_user_profile(memory_dir: Path) -> str:
    """Read USER.md content."""
    user_path = memory_dir / _USER_FILENAME
    if not user_path.exists():
        return ""
    return user_path.read_text(encoding="utf-8")
