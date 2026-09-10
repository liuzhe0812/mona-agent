#!/usr/bin/env python3
"""Parse ``storyboard.md`` into structured JSON.

Usage:
    python parse_storyboard.py <project_path>

Output (stdout): JSON array of scenes:
    [
      {
        "index": 1,
        "title": "开场",
        "role": "cover",
        "layout": "cover-split",
        "backgroundSlot": "cover",
        "duration": 5,
        "durationRaw": "5s",
        "visual": "渐入 logo + 粒子动效",
        "animation": "GSAP timeline: logo scale 0→1",
        "narration": "欢迎来到...",
        "assets": ["logo.png"]
      },
      ...
    ]

Scene heading format: ``### Scene N: <title>``
Field format: ``- <FieldName>: <value>`` (FieldName case-insensitive, value to EOL)
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

# Loose scene heading: 2-4 leading #'s, "Scene"/"场景"/"镜头" keyword (optional),
# number, separator (:｜：｜-｜－｜——), title. Examples accepted:
#   ### Scene 1: 开场
#   ## 场景 1：开场
#   ### 1. 开场
#   ### Scene 1 - 开场
SCENE_HEADING_RE = re.compile(
    r"^#{2,4}\s+(?:Scene|场景|镜头)?\s*(\d+)\s*[:：\-－—。\.\s]\s*(.+?)\s*$",
    re.IGNORECASE,
)
FIELD_RE = re.compile(r"^-\s*([A-Za-z\u4e00-\u9fa5][A-Za-z\s\u4e00-\u9fa5]*?)\s*[:：]\s*(.+?)\s*$")


def _parse_duration(raw: str) -> int:
    """Extract seconds from strings like '5s', '5.5s', '5 seconds'. Returns int seconds."""
    m = re.search(r"(\d+(?:\.\d+)?)", raw)
    if not m:
        return 0
    return int(float(m.group(1)))


def _split_assets(raw: str) -> list[str]:
    """Split assets field into list. Handles comma/、 separated and bracketed lists."""
    cleaned = raw.strip().strip("[]")
    if not cleaned:
        return []
    parts = re.split(r"[,\、]\s*", cleaned)
    return [p.strip().strip('"\'') for p in parts if p.strip()]


def parse_storyboard(storyboard_path: Path) -> list[dict]:
    """Parse storyboard.md into a list of scene dicts."""
    if not storyboard_path.exists():
        return []
    text = storyboard_path.read_text(encoding="utf-8")
    scenes: list[dict] = []
    current: dict | None = None

    for line in text.splitlines():
        heading = SCENE_HEADING_RE.match(line)
        if heading:
            if current is not None:
                scenes.append(current)
            current = {
                "index": int(heading.group(1)),
                "title": heading.group(2).strip(),
                "role": "",
                "layout": "",
                "backgroundSlot": "",
                "duration": 0,
                "durationRaw": "",
                "visual": "",
                "animation": "",
                "narration": "",
                "assets": [],
            }
            continue
        if current is None:
            continue
        m = FIELD_RE.match(line)
        if not m:
            continue
        field = m.group(1).strip().lower()
        value = m.group(2).strip()
        if field in ("role", "场景角色", "角色"):
            current["role"] = value
        elif field in ("layout", "布局", "布局类型"):
            current["layout"] = value
        elif field in ("background slot", "backgroundslot", "背景槽位", "背景"):
            current["backgroundSlot"] = value
        elif field in ("duration", "时长", "长度"):
            current["durationRaw"] = value
            current["duration"] = _parse_duration(value)
        elif field in ("visual", "画面", "视觉", "画面描述"):
            current["visual"] = value
        elif field in ("animation", "动画", "动画说明"):
            current["animation"] = value
        elif field in ("narration", "旁白", "旁白文本", "解说"):
            current["narration"] = value
        elif field in ("assets", "素材", "资源", "资产"):
            current["assets"] = _split_assets(value)

    if current is not None:
        scenes.append(current)

    # Reindex to ensure sequential 1-based indices
    for i, scene in enumerate(scenes, start=1):
        scene["index"] = i
        if not scene["role"]:
            if i == 1:
                scene["role"] = "cover"
            elif i == len(scenes):
                scene["role"] = "outro"
            else:
                scene["role"] = "content"
        if not scene["layout"]:
            scene["layout"] = {
                "cover": "cover-split",
                "outro": "outro-brand",
            }.get(scene["role"], "content-standard")
        if not scene["backgroundSlot"]:
            scene["backgroundSlot"] = (
                scene["role"] if scene["role"] in ("cover", "outro") else "content"
            )
    return scenes


def _cli() -> None:
    # Only redirect stdout/stderr when run as a CLI script — never when imported
    # as a module (would corrupt the host process's stdout and deadlock aiohttp).
    import io
    import os
    import sys

    if os.name == "nt" and hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Parse storyboard.md into JSON")
    parser.add_argument("project_path", type=Path, help="Video project directory")
    args = parser.parse_args()
    scenes = parse_storyboard(args.project_path / "storyboard.md")
    print(json.dumps(scenes, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _cli()
