#!/usr/bin/env python3
"""Compile one structured scene specification into a scene HTML file.

The script is deliberately usable without installing Mona as a package:
``python compile_scene_spec.py --spec ... --style ... --project ...``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _repo_root() -> Path:
    # .../mona/skills/mona-video/scripts/compile_scene_spec.py
    return Path(__file__).resolve().parents[4]


if str(_repo_root()) not in sys.path:
    sys.path.insert(0, str(_repo_root()))

from mona.video_scene_compiler import (  # noqa: E402
    SceneCompileError,
    compile_scene_spec,
)


def _json_file(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SceneCompileError(
            f"无法读取 JSON 文件: {path}",
            code="SCENE_CLI_INPUT_INVALID",
            status_code=400,
        ) from exc
    if not isinstance(value, dict):
        raise SceneCompileError(
            f"JSON 文件必须是对象: {path}",
            code="SCENE_CLI_INPUT_INVALID",
            status_code=400,
        )
    return value


def _scene_payload(path: Path, spec: dict[str, Any]) -> dict[str, Any]:
    if path.is_file():
        return _json_file(path)
    return spec


def _read_project_meta(project: Path) -> dict[str, Any]:
    meta = project / "meta.json"
    return _json_file(meta) if meta.is_file() else {}


def _find_scene_meta(scene_payload: dict[str, Any], spec: dict[str, Any]) -> dict[str, Any]:
    scenes = scene_payload.get("scenes")
    if isinstance(scenes, list):
        wanted = spec.get("sceneIndex")
        for scene in scenes:
            if isinstance(scene, dict) and scene.get("index") == wanted:
                return scene
    return scene_payload


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Compile a Mona scene spec to HTML")
    parser.add_argument("spec_pos", nargs="?", type=Path, help="scene spec JSON")
    parser.add_argument("style_pos", nargs="?", type=Path, help="design system JSON")
    parser.add_argument("scene_pos", nargs="?", type=Path, help="scene metadata JSON")
    parser.add_argument("project_pos", nargs="?", type=Path, help="video project directory")
    parser.add_argument("--spec", "--spec-file", dest="spec_opt", type=Path, help="scene spec JSON")
    parser.add_argument("--style", "--style-file", dest="style_opt", type=Path, help="design system JSON")
    parser.add_argument("--scene", "--scene-file", dest="scene_opt", type=Path, help="scene metadata JSON")
    parser.add_argument("--project", "--project-path", dest="project_opt", type=Path, help="video project directory")
    parser.add_argument("--resolution", help="override resolution, for example 1920x1080")
    parser.add_argument("--background", type=str, help="local relative background path")
    parser.add_argument("--output", type=Path, help="override output HTML path")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    spec_path = args.spec_opt or args.spec_pos
    style_path = args.style_opt or args.style_pos
    project = args.project_opt or args.project_pos
    scene_path = args.scene_opt or args.scene_pos
    if spec_path is None or style_path is None or project is None:
        _parser().error("spec、style 和 project 是必需参数")
    assert spec_path is not None and style_path is not None and project is not None

    try:
        spec = _json_file(spec_path)
        style = _json_file(style_path)
        scene_payload = _scene_payload(scene_path, spec) if scene_path else {}
        scene = _find_scene_meta(scene_payload, spec)
        project_meta = _read_project_meta(project)
        if not scene and isinstance(project_meta.get("scenes"), list):
            scene = _find_scene_meta(project_meta, spec)
        if not scene.get("resolution") and project_meta.get("resolution"):
            scene = {**scene, "resolution": project_meta["resolution"]}
        background = args.background or scene.get("backgroundPath") or scene.get("background_path")
        if background is None:
            bindings = project_meta.get("backgroundBindings")
            if isinstance(bindings, dict):
                background = bindings.get(spec.get("backgroundSlot"))
        html = compile_scene_spec(
            spec,
            style,
            scene=scene,
            resolution=args.resolution,
            background_path=background,
        )
        output = args.output or (project / "scenes" / f"scene_{int(spec['sceneIndex']):02d}.html")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(html, encoding="utf-8")
        print(json.dumps({"ok": True, "path": str(output), "sceneIndex": spec["sceneIndex"]}, ensure_ascii=False))
        return 0
    except SceneCompileError as exc:
        print(json.dumps(exc.to_dict(), ensure_ascii=False), file=sys.stderr)
        return 2
    except OSError as exc:
        error = SceneCompileError(
            "写入场景 HTML 失败",
            code="SCENE_CLI_OUTPUT_FAILED",
            status_code=500,
            details={"reason": str(exc)},
        )
        print(json.dumps(error.to_dict(), ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
