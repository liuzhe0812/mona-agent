#!/usr/bin/env python3
"""Lint video scene HTML files using hyperframes lint.

Phase 3 placeholder: validates basic HTML structure.
Actual hyperframes lint integration will be added here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def lint_scene(html_path: Path) -> dict:
    """Validate a single scene HTML file."""
    if not html_path.exists():
        return {"ok": False, "error": f"File not found: {html_path}"}

    content = html_path.read_text(encoding="utf-8")
    errors: list[str] = []

    if "<!DOCTYPE html>" not in content:
        errors.append("Missing <!DOCTYPE html>")
    if "<html" not in content:
        errors.append("Missing <html> tag")
    if "<body" not in content:
        errors.append("Missing <body> tag")
    if 'class="scene"' not in content:
        errors.append('Missing <div class="scene"> element')
    if "data-start" not in content:
        errors.append("Missing data-start attribute on scene element")
    if "data-duration" not in content:
        errors.append("Missing data-duration attribute on scene element")
    if "gsap" not in content.lower():
        errors.append("GSAP library not referenced")

    return {"ok": len(errors) == 0, "errors": errors}


def lint_project(project_path: str) -> dict:
    """Lint all scene files in a project."""
    project = Path(project_path)
    scenes_dir = project / "scenes"
    if not scenes_dir.exists():
        return {"ok": False, "error": f"Scenes directory not found: {scenes_dir}"}

    scene_files = sorted(scenes_dir.glob("*.html"))
    if not scene_files:
        return {"ok": False, "error": "No scene files found"}

    results: list[dict] = []
    all_ok = True
    for scene_file in scene_files:
        result = lint_scene(scene_file)
        result["file"] = scene_file.name
        results.append(result)
        if not result["ok"]:
            all_ok = False

    return {"ok": all_ok, "scenes": results}


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "Usage: lint.py <project_path>"}))
        sys.exit(1)
    result = lint_project(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
