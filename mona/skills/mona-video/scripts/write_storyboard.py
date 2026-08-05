#!/usr/bin/env python3
"""Write structured scenes back to ``storyboard.md``.

Usage:
    python write_storyboard.py <project_path> --scenes <json_file>

Reads scenes JSON from stdin or --scenes file, writes storyboard.md in the
standard format that parse_storyboard.py can re-parse.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def render_storyboard(scenes: list[dict]) -> str:
    """Render scenes list into storyboard.md content."""
    lines: list[str] = []
    lines.append("# Storyboard")
    lines.append("")
    for scene in scenes:
        idx = scene.get("index", 0)
        title = scene.get("title", "")
        lines.append(f"### Scene {idx}: {title}")
        duration_raw = scene.get("durationRaw") or f"{scene.get('duration', 0)}s"
        lines.append(f"- Duration: {duration_raw}")
        if scene.get("visual"):
            lines.append(f"- Visual: {scene['visual']}")
        if scene.get("animation"):
            lines.append(f"- Animation: {scene['animation']}")
        if scene.get("narration") is not None:
            lines.append(f"- Narration: {scene.get('narration', '')}")
        if scene.get("assets"):
            assets = scene["assets"]
            if isinstance(assets, list):
                assets_str = ", ".join(assets)
            else:
                assets_str = str(assets)
            lines.append(f"- Assets: {assets_str}")
        lines.append("")
    return "\n".join(lines) + "\n"


def write_storyboard(project_path: Path, scenes: list[dict]) -> Path:
    """Write scenes to storyboard.md, return the path."""
    content = render_storyboard(scenes)
    out = project_path / "storyboard.md"
    out.write_text(content, encoding="utf-8")
    return out


def _cli() -> None:
    # Only redirect stdout/stderr when run as a CLI script — never when imported
    # as a module (would corrupt the host process's stdout and deadlock aiohttp).
    import io
    import os

    if os.name == "nt" and hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Write structured scenes to storyboard.md")
    parser.add_argument("project_path", type=Path, help="Video project directory")
    parser.add_argument("--scenes", type=Path, default=None, help="JSON file with scenes (default: stdin)")
    args = parser.parse_args()

    if args.scenes:
        scenes = json.loads(args.scenes.read_text(encoding="utf-8"))
    else:
        scenes = json.loads(sys.stdin.read())

    out = write_storyboard(args.project_path, scenes)
    print(json.dumps({"ok": True, "path": str(out.relative_to(args.project_path))}, ensure_ascii=False))


if __name__ == "__main__":
    _cli()
