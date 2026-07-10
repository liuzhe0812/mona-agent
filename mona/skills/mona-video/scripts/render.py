#!/usr/bin/env python3
"""Render video from HTML scenes using Hyperframes.

Phase 3 placeholder: actual Hyperframes CLI integration will be added here.
Currently checks for browser availability and reports status.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Add scripts dir to path for check_edge import
sys.path.insert(0, str(Path(__file__).parent))
from check_edge import find_browser  # noqa: E402


def render_project(project_path: str) -> dict:
    """Render all scenes in a project to MP4.

    Args:
        project_path: Path to the video project directory.

    Returns:
        Dict with render status and output path.
    """
    project = Path(project_path)
    if not project.exists():
        return {"ok": False, "error": f"Project not found: {project_path}"}

    browser = find_browser()
    if not browser:
        return {
            "ok": False,
            "error": "No browser found. Please install Edge/Chrome or download Chrome Headless Shell.",
            "need_download": True,
        }

    scenes_dir = project / "scenes"
    if not scenes_dir.exists():
        return {"ok": False, "error": f"Scenes directory not found: {scenes_dir}"}

    output_dir = project / "output"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Phase 3: actual Hyperframes render integration
    # For now, report that the infrastructure is ready
    return {
        "ok": False,
        "error": "Hyperframes render integration pending (Phase 3)",
        "browser": browser,
        "scenes": sorted(str(p) for p in scenes_dir.glob("*.html")),
    }


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: render.py <project_path>"}))
        sys.exit(1)
    result = render_project(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
