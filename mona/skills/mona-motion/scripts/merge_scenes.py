#!/usr/bin/env python3
"""Video scene timeline and transition helpers."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path

__all__ = ("parse_storyboard", "list_scenes", "compute_timeline", "read_scene_transition")

# scene_01.html -> 1
SCENE_FILE_RE = re.compile(r"scene_(\d+)\.html$", re.IGNORECASE)
# "### Scene 1:" heading
SCENE_HEADING_RE = re.compile(r"^###\s+Scene\s+(\d+)\s*:", re.IGNORECASE)
# "- Duration: 5s" or "- Duration: 5.5"
DURATION_LINE_RE = re.compile(r"-\s*Duration:\s*([\d.]+)\s*s?", re.IGNORECASE)
# "分辨率: 1920x1080" or "Resolution: 1920×1080"
RESOLUTION_RE = re.compile(
    r"(?:分辨率|Resolution)\s*[:：]\s*(\d+)\s*[x×*]\s*(\d+)", re.IGNORECASE
)
# data-duration="5" inside a scene HTML
DATA_DURATION_RE = re.compile(r'data-duration="([\d.]+)"', re.IGNORECASE)

DEFAULT_WIDTH = 1920
DEFAULT_HEIGHT = 1080
DEFAULT_SCENE_DURATION = 5.0

def parse_storyboard(storyboard_path: Path) -> dict:
    """Parse ``storyboard.md`` for resolution and per-scene durations.

    Returns ``{"resolution": (w, h) | None, "scenes": {num: duration}}``.
    """
    result: dict = {"resolution": None, "scenes": {}}
    text = storyboard_path.read_text(encoding="utf-8") if storyboard_path.exists() else ""

    res_match = RESOLUTION_RE.search(text)
    if res_match:
        result["resolution"] = (int(res_match.group(1)), int(res_match.group(2)))

    current_scene: int | None = None
    for line in text.splitlines():
        heading = SCENE_HEADING_RE.match(line)
        if heading:
            current_scene = int(heading.group(1))
            continue
        if current_scene is not None:
            dur = DURATION_LINE_RE.search(line)
            if dur:
                result["scenes"][current_scene] = float(dur.group(1))
    meta_path = storyboard_path.parent / "meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        for scene in meta.get("scenes") or []:
            index, duration = int(scene.get("index") or 0), float(scene.get("duration") or 0)
            if index > 0 and duration > 0:
                result["scenes"][index] = duration
        resolution = RESOLUTION_RE.search("Resolution: " + str(meta.get("resolution") or ""))
        if resolution:
            result["resolution"] = (int(resolution.group(1)), int(resolution.group(2)))
    style_path = storyboard_path.parent / "style" / "design-system.json"
    if style_path.is_file():
        result["motion"] = json.loads(style_path.read_text(encoding="utf-8")).get("motion") or {}
    return result


def list_scenes(scenes_dir: Path) -> list[tuple[int, Path]]:
    """Return scene files sorted by numeric index."""
    scenes: list[tuple[int, Path]] = []
    for path in scenes_dir.glob("scene_*.html"):
        match = SCENE_FILE_RE.search(path.name)
        if match:
            scenes.append((int(match.group(1)), path))
    scenes.sort(key=lambda item: item[0])
    return scenes


def read_scene_duration(scene_path: Path) -> float | None:
    """Extract ``data-duration`` from a scene HTML file (fallback)."""
    try:
        text = scene_path.read_text(encoding="utf-8")
    except OSError:
        return None
    match = DATA_DURATION_RE.search(text)
    return float(match.group(1)) if match else None


def compute_timeline(
    scenes: list[tuple[int, Path]],
    storyboard: dict,
) -> tuple[list[tuple[int, Path, float, float]], float]:
    """Compute (start, duration) for each scene and the total duration.

    Duration precedence: project metadata > storyboard > scene HTML > default.
    """
    scene_durations: dict[int, float] = storyboard.get("scenes", {})
    timeline: list[tuple[int, Path, float, float]] = []
    start = 0.0
    for num, path in scenes:
        duration = scene_durations.get(num)
        if duration is None:
            duration = read_scene_duration(path) or DEFAULT_SCENE_DURATION
        timeline.append((num, path, start, duration))
        start += duration
    return timeline, start


def read_scene_transition(scene_path: Path, duration: float, motion: dict | None = None) -> tuple[str, float]:
    if motion is None:
        style_path = scene_path.parent.parent / "style" / "design-system.json"
        motion = json.loads(style_path.read_text(encoding="utf-8")).get("motion") or {} if style_path.is_file() else {}
    text = scene_path.read_text(encoding="utf-8")
    preset_match = re.search(r'data-transition-preset=["\']([^"\']+)["\']', text)
    duration_match = re.search(r'data-transition-duration-ms=["\']([^"\']+)["\']', text)
    preset = preset_match.group(1) if preset_match else str(motion.get("transitionPreset") or "cross-fade")
    milliseconds = float(duration_match.group(1) if duration_match else motion.get("transitionDurationMs", 420 if motion else 0))
    if preset not in {"cross-fade", "fade-rise", "stagger-rise"} or not math.isfinite(milliseconds) or not 0 <= milliseconds <= 5000:
        raise ValueError("场景切换配置无效")
    return preset, min(duration, milliseconds / 1000)
