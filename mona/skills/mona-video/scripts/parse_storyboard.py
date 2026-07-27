#!/usr/bin/env python3
"""Parse ``storyboard.md`` into structured JSON.

Usage:
    python parse_storyboard.py <project_path>

Output (stdout): JSON array of scenes:
    [
      {
        "index": 1,
        "title": "开场",
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
import io
import json
import os
import re
import sys
from pathlib import Path

if os.name == "nt" and hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

SCENE_HEADING_RE = re.compile(r"^###\s+Scene\s+(\d+)\s*:\s*(.+?)\s*$", re.IGNORECASE)
FIELD_RE = re.compile(r"^-\s*([A-Za-z][A-Za-z\s]*?)\s*:\s*(.+?)\s*$")


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
        if field == "duration":
            current["durationRaw"] = value
            current["duration"] = _parse_duration(value)
        elif field == "visual":
            current["visual"] = value
        elif field == "animation":
            current["animation"] = value
        elif field == "narration":
            current["narration"] = value
        elif field == "assets":
            current["assets"] = _split_assets(value)

    if current is not None:
        scenes.append(current)

    # Reindex to ensure sequential 1-based indices
    for i, scene in enumerate(scenes, start=1):
        scene["index"] = i
    return scenes


def _cli() -> None:
    parser = argparse.ArgumentParser(description="Parse storyboard.md into JSON")
    parser.add_argument("project_path", type=Path, help="Video project directory")
    args = parser.parse_args()
    scenes = parse_storyboard(args.project_path / "storyboard.md")
    print(json.dumps(scenes, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    _cli()
