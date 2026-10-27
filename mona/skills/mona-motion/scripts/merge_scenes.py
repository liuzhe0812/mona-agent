#!/usr/bin/env python3
"""Merge scene HTML files into a root Hyperframes composition.

Reads ``scenes/scene_*.html`` (sorted by their numeric index) and
``storyboard.md`` (for per-scene duration and overall resolution), then
generates ``index.html`` — the root composition that references every
scene as a sub-composition via ``data-composition-src``.

Usage:
    python merge_scenes.py <project_path>
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import re
import sys
from pathlib import Path

__all__ = ("main", "parse_storyboard", "list_scenes", "build_index_html")

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

GSAP_CDN = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"


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


def _fmt(value: float) -> str:
    """Format a number without a trailing ``.0`` for integer values."""
    if value == int(value):
        return str(int(value))
    return f"{value:.3f}".rstrip("0").rstrip(".")


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


def build_index_html(
    scenes: list[tuple[int, Path]],
    storyboard: dict,
) -> str:
    """Build the root composition HTML referencing all scenes."""
    width, height = storyboard.get("resolution") or (DEFAULT_WIDTH, DEFAULT_HEIGHT)
    timeline, total = compute_timeline(scenes, storyboard)
    transitions = [read_scene_transition(path, duration, storyboard.get("motion")) for _num, path, _start, duration in timeline]

    entries: list[str] = []
    for position, (num, path, start, duration) in enumerate(timeline):
        rel = f"scenes/{path.name}"
        preset, transition_duration = transitions[position]
        hold = transitions[position + 1][1] if position + 1 < len(timeline) else 0
        animation = f"animation:mona-{preset} {_fmt(transition_duration)}s linear both paused;" if position and transition_duration else ""
        entries.append(
            f'    <div id="scene-host-{num}" data-composition-id="scene-host-{num}" '
            f'data-composition-src="{rel}" '
            f'data-start="{_fmt(start)}" data-duration="{_fmt(duration + hold)}" '
            f'data-scene-duration="{_fmt(duration)}" data-track-index="0" '
            f'class="scene-host" style="z-index:{position};{animation}"></div>'
        )
    entries_block = "\n".join(entries)

    lines = [
        "<!DOCTYPE html>",
        '<html lang="zh-CN">',
        "<head>",
        '  <meta charset="UTF-8">',
        "  <title>Video</title>",
        f'  <script src="{GSAP_CDN}"></script>',
        "  <style>",
        f"    html,body {{ margin:0; width:{width}px; height:{height}px; overflow:hidden; background:#000; }}",
        f"    main {{ position:relative; width:{width}px; height:{height}px; overflow:hidden; }}",
        "    .scene-host { position:absolute; inset:0; }",
        "    @keyframes mona-cross-fade { from { opacity:0; } to { opacity:1; } }",
        "    @keyframes mona-fade-rise { from { opacity:0; transform:translateY(5%); } to { opacity:1; transform:translateY(0); } }",
        "    @property --mona-band-0 { syntax:'<number>'; inherits:false; initial-value:0; }",
        "    @property --mona-band-1 { syntax:'<number>'; inherits:false; initial-value:0; }",
        "    @property --mona-band-2 { syntax:'<number>'; inherits:false; initial-value:0; }",
        "    [style*='mona-stagger-rise'] { mask-image:linear-gradient(to right,rgba(0,0,0,var(--mona-band-0)) 0 33.333%,rgba(0,0,0,var(--mona-band-1)) 33.333% 66.667%,rgba(0,0,0,var(--mona-band-2)) 66.667% 100%); }",
        "    @keyframes mona-stagger-rise {",
        "      0% { --mona-band-0:0; --mona-band-1:0; --mona-band-2:0; }",
        "      18% { --mona-band-0:.28125; --mona-band-1:0; --mona-band-2:0; }",
        "      36% { --mona-band-0:.5625; --mona-band-1:.28125; --mona-band-2:0; }",
        "      64% { --mona-band-0:1; --mona-band-1:.71875; --mona-band-2:.4375; }",
        "      82% { --mona-band-0:1; --mona-band-1:1; --mona-band-2:.71875; }",
        "      100% { --mona-band-0:1; --mona-band-1:1; --mona-band-2:1; }",
        "    }",
        "  </style>",
        "</head>",
        "<body>",
        f'  <main data-composition-id="main" data-start="0" '
        f'data-duration="{_fmt(total)}" data-width="{width}" '
        f'data-height="{height}">',
        entries_block,
        "  </main>",
        "  <script>",
        "    window.__timelines = window.__timelines || [];",
        '    window.__timelines["main"] = gsap.timeline({ paused: true });',
        f'    window.__timelines["main"].to({{}}, {{ duration:{_fmt(total)} }});',
        "  </script>",
        "</body>",
        "</html>",
        "",
    ]
    return "\n".join(lines)


def main(project_path: str | Path) -> dict:
    """Generate ``index.html`` for a video project.

    Args:
        project_path: Path to the video project directory.

    Returns a dict with ``ok`` and either the generated index path and
    timeline summary, or an ``error`` message.
    """
    project = Path(project_path)
    if not project.exists():
        return {"ok": False, "error": f"Project not found: {project_path}"}

    scenes_dir = project / "scenes"
    if not scenes_dir.exists():
        return {"ok": False, "error": f"Scenes directory not found: {scenes_dir}"}

    scenes = list_scenes(scenes_dir)
    if not scenes:
        return {"ok": False, "error": "No scene_*.html files found in scenes/"}

    storyboard = parse_storyboard(project / "storyboard.md")
    timeline, total = compute_timeline(scenes, storyboard)
    html = build_index_html(scenes, storyboard)

    index_path = project / "index.html"
    index_path.write_text(html, encoding="utf-8")
    return {
        "ok": True,
        "index": str(index_path),
        "scenes": len(scenes),
        "total_duration": round(total, 3),
        "resolution": storyboard.get("resolution") or (DEFAULT_WIDTH, DEFAULT_HEIGHT),
    }


def _cli() -> None:
    # Only redirect stdout/stderr when run as a CLI script — never when imported
    # as a module (would corrupt the host process's stdout and deadlock aiohttp).
    if os.name == "nt" and hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Merge scene HTML files into a root Hyperframes index.html",
    )
    parser.add_argument(
        "project_path",
        type=Path,
        help="Video project directory containing scenes/ and storyboard.md",
    )
    args = parser.parse_args()
    result = main(args.project_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    _cli()
