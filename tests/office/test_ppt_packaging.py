from __future__ import annotations

import ast
import json
import tomllib
from pathlib import Path

from mona.office.ppt_packaging import should_include_mona_pptx_package_resource

ROOT = Path(__file__).resolve().parents[2]
PPTX_ASSETS = ROOT / "mona" / "skills" / "mona-pptx" / "assets"
_PREVIEW_DIRECTORIES = ("presets", "design", "scenarios")
_NATIVE_PREVIEW_NAMES = {"editorial-evidence.png", "parallel-five.png", "product-story.png"}


def _package_item(path: Path) -> tuple[str, str]:
    relative = path.relative_to(PPTX_ASSETS).as_posix()
    destination = (PPTX_ASSETS / relative).parent.relative_to(ROOT).as_posix()
    return str(path), destination


def test_skill_package_filter_drops_only_static_ppt_previews() -> None:
    assert not should_include_mona_pptx_package_resource(
        "previews.json", "mona/skills/mona-pptx/assets"
    )

    for directory in _PREVIEW_DIRECTORIES:
        preview_dir = PPTX_ASSETS / directory
        for path in preview_dir.rglob("*.png"):
            assert not should_include_mona_pptx_package_resource(*_package_item(path))

    for path in (PPTX_ASSETS / "native").rglob("*.png"):
        included = should_include_mona_pptx_package_resource(*_package_item(path))
        assert included is (path.relative_to(PPTX_ASSETS).as_posix() not in {
            f"native/{name}" for name in _NATIVE_PREVIEW_NAMES
        })
    assert should_include_mona_pptx_package_resource(
        "product-workspace.png", "mona/skills/mona-pptx/assets/native"
    )
    for path in (PPTX_ASSETS / "native").rglob("*.json"):
        assert should_include_mona_pptx_package_resource(*_package_item(path))
    assert should_include_mona_pptx_package_resource(
        "index.json", "mona/skills/mona-pptx/assets/presets"
    )
    assert should_include_mona_pptx_package_resource(
        "manifest.json", "mona/skills/mona-pptx/assets/dashi"
    )
    assert not should_include_mona_pptx_package_resource(
        "templates.json", "mona/skills/mona-pptx/assets/dashi"
    )
    assert should_include_mona_pptx_package_resource(
        "template-assets.json", "mona/skills/mona-pptx/assets/dashi"
    )
    assert should_include_mona_pptx_package_resource(
        "theme03-3d-01.webp", "mona/skills/mona-pptx/assets/dashi"
    )
    assert should_include_mona_pptx_package_resource(
        "future-preview.png", "mona/skills/mona-pptx/assets/presets/nested"
    ) is False
    assert should_include_mona_pptx_package_resource(
        "preview.webp", "mona/skills/mona-pptx/assets/presets"
    )
    assert should_include_mona_pptx_package_resource("SKILL.md", "mona/skills/mona-docx")
    assert not should_include_mona_pptx_package_resource(
        "previews.json", "mona/skills/mona-pptx/assets"
    )


def test_wheel_includes_lossless_webp_and_excludes_preview_resources() -> None:
    config = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    build = config["tool"]["hatch"]["build"]
    wheel = build["targets"]["wheel"]
    assert "mona/skills/**/*.webp" in build["include"]
    assert "mona/skills/mona-pptx/assets/previews.json" in wheel["exclude"]
    assert "mona/skills/mona-pptx/assets/dashi/templates.json" in wheel["exclude"]
    for name in _NATIVE_PREVIEW_NAMES:
        assert f"mona/skills/mona-pptx/assets/native/{name}" in wheel["exclude"]
    assert "mona/skills/mona-pptx/assets/presets/*.png" in wheel["exclude"]
    assert "mona/skills/mona-pptx/assets/presets/**/*.png" in wheel["exclude"]
    assert "mona/skills/mona-pptx/assets/design/*.png" in wheel["exclude"]
    assert "mona/skills/mona-pptx/assets/design/**/*.png" in wheel["exclude"]
    assert "mona/skills/mona-pptx/assets/scenarios/*.png" in wheel["exclude"]
    assert "mona/skills/mona-pptx/assets/scenarios/**/*.png" in wheel["exclude"]

    manifest = json.loads(
        (PPTX_ASSETS / "dashi" / "manifest.json").read_text(encoding="utf-8")
    )
    webp_files = sorted((PPTX_ASSETS / "dashi").glob("*.webp"))
    assert len(webp_files) == manifest["assetCount"] == len(manifest["assets"])
    assert len(webp_files) >= 12
    assert all(
        should_include_mona_pptx_package_resource(*_package_item(path))
        for path in webp_files
    )


def test_gateway_specs_share_ppt_resource_filter_and_tauri_collects_mona_data() -> None:
    specs = {
        ROOT / "mona-gateway.spec": "collect_all",
        ROOT / "src-tauri" / "mona-gateway.spec": "collect_data_files",
    }
    for path, hook_name in specs.items():
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        calls = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        ]
        assert any(
            node.func.id == "should_include_mona_pptx_package_resource" for node in calls
        )
        if hook_name == "collect_all":
            assert any(node.func.id == hook_name for node in calls)
            assert any(
                isinstance(node, ast.For)
                and any(
                    isinstance(value, ast.Constant) and value.value == "mona"
                    for value in ast.walk(node.iter)
                )
                for node in ast.walk(tree)
            )
        else:
            assert any(
                node.func.id == hook_name
                and node.args
                and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == "mona"
                for node in calls
            )
