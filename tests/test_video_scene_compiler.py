"""Tests for the closed, deterministic structured-scene compiler."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from mona.video_scene_compiler import (
    SceneCompileError,
    compile_scene_spec,
    parse_scene_spec,
    validate_scene_spec,
)
from mona.video_style import get_builtin_template
from mona.video_timeline import build_motion_plan, build_subtitle_track

LAYOUTS = [
    "cover-split",
    "content-standard",
    "metric-comparison",
    "comparison-columns",
    "quote-focus",
    "outro-brand",
]


@pytest.fixture
def style() -> dict:
    return {
        "schemaVersion": 1,
        "allowedLayouts": LAYOUTS,
        "allowedAnimations": ["fade-rise", "stagger-rise", "soft-pulse", "cross-fade"],
        "components": {role: f"{role}-v1" for role in ("cover", "content", "data", "comparison", "quote", "outro")},
        "tokens": {
            "colors": {
                "primary": "#2F5BFF",
                "secondary": "#00A88F",
                "background": "#F7F8FA",
                "surface": "#FFFFFF",
                "textPrimary": "#1F2937",
                "textSecondary": "#667085",
                "border": "#D9DEE8",
            },
            "typography": {"headingFamily": "Noto Sans SC", "bodyFamily": "Noto Sans SC"},
            "shape": {"cardRadius": 12},
        },
        "backgrounds": {
            "default": {
                "fit": "cover",
                "focalPoint": {"x": 0.25, "y": 0.75},
                "overlay": {
                    "type": "linear-gradient",
                    "color": "#F7F8FA",
                    "opacity": 0.6,
                    "direction": "left-to-right",
                },
            },
            "roles": {
                "cover": {"inherit": "default"},
                "content": {"inherit": "default"},
                "data": {"inherit": "default"},
                "comparison": {"inherit": "default"},
                "quote": {"inherit": "default"},
                "outro": {"inherit": "default"},
            },
        },
    }


def _spec(layout: str = "content-standard", **content) -> dict:
    return {
        "schemaVersion": 1,
        "sceneIndex": 2,
        "role": "content",
        "layout": layout,
        "backgroundSlot": "content",
        "animationPreset": "fade-rise",
        "duration": 6,
        "start": 1.5,
        "content": {"eyebrow": "本期重点", "title": "稳定的视觉语言", **content},
    }


def test_parse_scene_spec_accepts_json_and_rejects_recursive_style_fields() -> None:
    parsed = parse_scene_spec("```json\n" + json.dumps(_spec(), ensure_ascii=False) + "\n```")
    assert parsed["sceneIndex"] == 2

    for payload in (
        {"content": {"html": "<b>bad</b>"}},
        {"content": {"cards": [{"fontSize": 20}]}},
        {"content": {"nested": {"customColor": "#fff"}}},
        {"content": {"safe": {"script": "alert(1)"}}},
    ):
        with pytest.raises(SceneCompileError) as exc:
            parse_scene_spec(json.dumps({**_spec(), **payload}))
        assert exc.value.code == "SCENE_SPEC_FORBIDDEN_FIELD"
        assert exc.value.status == 422


def test_validate_scene_spec_checks_style_contract(style: dict) -> None:
    assert validate_scene_spec(_spec(), style)["layout"] == "content-standard"
    for field, value, code in (
        ("role", "unknown", "SCENE_SPEC_UNSUPPORTED_ROLE"),
        ("layout", "not-allowed", "SCENE_SPEC_UNSUPPORTED_LAYOUT"),
        ("backgroundSlot", "missing", "SCENE_SPEC_UNSUPPORTED_BACKGROUND_SLOT"),
        ("animationPreset", "not-allowed", "SCENE_SPEC_UNSUPPORTED_ANIMATION"),
    ):
        invalid = _spec()
        invalid[field] = value
        with pytest.raises(SceneCompileError) as exc:
            validate_scene_spec(invalid, style)
        assert exc.value.code == code


@pytest.mark.parametrize("layout", LAYOUTS)
def test_all_supported_layouts_compile(style: dict, layout: str) -> None:
    spec = _spec(layout)
    if layout == "outro-brand":
        spec["role"] = "outro"
        spec["backgroundSlot"] = "outro"
    elif layout == "quote-focus":
        spec["role"] = "quote"
        spec["backgroundSlot"] = "quote"
    elif layout == "metric-comparison":
        spec["role"] = "data"
        spec["backgroundSlot"] = "data"
        spec["content"]["metrics"] = [{"value": "42%", "label": "效率提升"}]
    elif layout == "comparison-columns":
        spec["role"] = "comparison"
        spec["backgroundSlot"] = "comparison"
        spec["content"]["left"] = {"title": "之前", "items": ["手工"]}
        spec["content"]["right"] = {"title": "现在", "items": ["自动"]}
    output = compile_scene_spec(spec, style, resolution="1280x720", background_path="assets/bg.webp")
    assert 'width: 1280px; height: 720px;' in output
    assert f'data-layout="{layout}"' in output
    assert 'data-start="1.5"' in output
    assert 'data-duration="6"' in output
    assert 'url("assets/bg.webp")' in output
    assert "window.__timelines" in output
    assert "gsap.timeline({ paused: true })" in output
    assert "Timeline.prototype.seek" in output
    assert "Timeline.prototype.duration" in output


def test_compile_escapes_all_text_and_is_deterministic(style: dict) -> None:
    spec = _spec(title='<img src=x onerror="bad">', body="<script>alert(1)</script>")
    spec["content"]["bullets"] = ["<b>not markup</b>"]
    first = compile_scene_spec(spec, style, resolution=(1920, 1080))
    second = compile_scene_spec(spec, style, resolution=(1920, 1080))
    assert first == second
    assert "<img src=x" not in first
    assert "&lt;img src=x onerror=&quot;bad&quot;&gt;" in first
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in first
    assert "<b>not markup</b>" not in first


def test_subtitle_uses_locked_position_style_and_line_limit(style: dict) -> None:
    style["subtitle"] = {
        "position": "bottom-left",
        "style": "caption-card",
        "maxLines": 2,
    }
    spec = _spec(subtitle="系列字幕保持一致")
    output = compile_scene_spec(spec, style, resolution="1920x1080")
    assert "系列字幕保持一致" in output
    assert "subtitle-bottom-left style-caption-card" in output
    assert ".scene-subtitle.style-caption-card" in output
    assert "--subtitle-lines:2" in output


def test_script_aligned_motion_and_subtitle_tracks_compile(style: dict) -> None:
    track = build_subtitle_track(
        "先显示标题。再显示内容。",
        3000,
        word_timings=[
            {"text": "先显示标题。", "startMs": 100, "endMs": 900},
            {"text": "再显示内容。", "startMs": 1200, "endMs": 2400},
        ],
    )
    motion = build_motion_plan(
        {"index": 2, "role": "content"},
        track,
        allowed_effects=style["allowedAnimations"],
    )
    output = compile_scene_spec(
        _spec(body="场景内容", bullets=["要点一", "要点二"]),
        style,
        resolution="1280x720",
        motion_plan=motion,
        subtitle_track=track,
    )
    assert 'data-motion-target="title"' in output
    assert 'data-motion-target="item.0 step.0"' in output
    assert 'class="subtitle-cue is-active"' in output
    assert 'data-start-ms="100"' in output
    assert "window.__monaApplySubtitleTime" in output
    assert "[data-motion-target" in output
    assert "timeline.fromTo" in output


def test_registered_image_asset_is_compiled_into_a_controlled_media_slot(
    style: dict,
) -> None:
    output = compile_scene_spec(
        _spec(body="左侧保留讲解，右侧展示真实素材"),
        style,
        resolution="1280x720",
        asset_media=[
            {
                "kind": "image",
                "path": "../assets/library/product image.png",
                "originalName": "产品图.png",
            }
        ],
    )
    assert "scene content-standard" in output
    assert "has-media" in output
    assert 'class="scene-media"' in output
    assert 'src="../assets/library/product%20image.png"' in output
    assert 'alt="产品图.png"' in output
    assert "data-motion-target=\"visual\"" in output

    with pytest.raises(SceneCompileError):
        compile_scene_spec(
            _spec(),
            style,
            asset_media=[{"kind": "image", "path": "https://example.com/a.png"}],
        )


def test_brand_display_name_is_used_by_outro_component(style: dict) -> None:
    style["brand"] = {"displayName": "MONA ENTERPRISE"}
    spec = _spec("outro-brand", title="感谢观看", summary="下一期见")
    spec["role"] = "outro"
    spec["backgroundSlot"] = "outro"
    output = compile_scene_spec(spec, style)
    assert '<span>MONA ENTERPRISE</span>' in output


def test_external_subtitle_mode_keeps_timing_but_hides_burned_caption(
    style: dict,
) -> None:
    track = build_subtitle_track("只导出外挂字幕。", 2_000)
    output = compile_scene_spec(
        _spec(), style, subtitle_track=track, show_subtitles=False
    )
    assert '<div class="scene-subtitle' not in output
    assert "window.__monaApplySubtitleTime" in output


def test_brand_logo_uses_only_controlled_local_asset_path(style: dict) -> None:
    style["brand"] = {
        "displayName": "MONA",
        "logo": {"light": {"assetId": "brand-logo", "alt": "Mona Logo"}},
    }
    spec = _spec("outro-brand", title="感谢观看")
    spec["role"] = "outro"
    spec["backgroundSlot"] = "outro"
    output = compile_scene_spec(
        spec,
        style,
        brand_logo_path="../style/assets/brand-logo.webp",
    )
    assert 'class="brand-logo"' in output
    assert 'src="../style/assets/brand-logo.webp"' in output
    assert 'alt="Mona Logo"' in output
    with pytest.raises(SceneCompileError):
        compile_scene_spec(
            spec,
            style,
            brand_logo_path="https://example.com/logo.png",
        )
    preview = compile_scene_spec(
        spec,
        style,
        brand_logo_data_uri="data:image/webp;base64,UklGRg==",
    )
    assert 'src="data:image/webp;base64,UklGRg=="' in preview
    with pytest.raises(SceneCompileError) as invalid_preview:
        compile_scene_spec(
            spec,
            style,
            brand_logo_data_uri="data:text/html;base64,PGgxPkJvb208L2gxPg==",
        )
    assert invalid_preview.value.code == "SCENE_BRAND_LOGO_DATA_INVALID"


def test_background_overlay_and_focal_point_are_locked_style_values(style: dict) -> None:
    style["backgrounds"]["default"]["blur"] = 4
    style["backgrounds"]["default"]["tint"] = 0.18
    output = compile_scene_spec(_spec(), style, background_path="../assets/cover image.webp")
    assert 'url("../assets/cover%20image.webp")' in output
    assert "background-position: 25% 75%;" in output
    assert "--mona-bg-blur: 4px;" in output
    assert "--mona-bg-tint: 0.18;" in output
    assert 'class="scene-background"' in output
    assert "--mona-overlay: linear-gradient(to right, #F7F8FA, #F7F8FA);" in output
    with pytest.raises(SceneCompileError) as exc:
        compile_scene_spec(_spec(), style, background_path="https://example.com/bg.webp")
    assert exc.value.code == "SCENE_BACKGROUND_PATH_INVALID"


def test_four_builtin_templates_compile_distinct_real_component_packs() -> None:
    expected_themes = {
        "tech-dark": "neon-core",
        "minimal-business": "new-guochao",
        "knowledge-cards": "idea-lab",
        "editorial-magazine": "documentary-collage",
    }
    scenes = (
        ("cover", "cover-split"),
        ("content", "content-standard"),
        ("data", "metric-comparison"),
        ("outro", "outro-brand"),
    )
    outputs: dict[str, str] = {}
    for template_id, theme in expected_themes.items():
        template = get_builtin_template(template_id)
        for role, layout in scenes:
            spec = _spec(layout)
            spec["role"] = role
            spec["backgroundSlot"] = role
            if role == "data":
                spec["content"]["metrics"] = [
                    {"value": "72%", "label": "效率提升"}
                ]
            output = compile_scene_spec(spec, template, resolution="1920x1080")
            assert f'data-template="{theme}"' in output
            assert f'data-component="{template["components"][role]}"' in output
            assert 'class="template-decor"' in output
            outputs[f"{template_id}:{role}"] = output
    assert len({outputs[f"{template_id}:content"] for template_id in expected_themes}) == 4


@pytest.mark.parametrize("template_id", ["tech-dark", "minimal-business", "knowledge-cards", "editorial-magazine"])
def test_builtin_templates_reflow_for_portrait_video(template_id: str) -> None:
    template = get_builtin_template(template_id)
    output = compile_scene_spec(
        {
            "schemaVersion": 1,
            "sceneIndex": 1,
            "role": "data",
            "layout": "metric-comparison",
            "backgroundSlot": "data",
            "animationPreset": "fade-rise",
            "duration": 6,
            "content": {
                "title": "竖屏数据",
                "metrics": [{"value": "72%", "label": "效率"}],
            },
        },
        template,
        resolution="1080x1920",
    )
    assert ".metric-grid { grid-template-columns: 1fr;" in output
    assert "width: 1080px; height: 1920px;" in output


def test_cli_writes_scene_file(tmp_path: Path, style: dict) -> None:
    spec_path = tmp_path / "spec.json"
    style_path = tmp_path / "style.json"
    scene_path = tmp_path / "scene.json"
    project = tmp_path / "project"
    spec_path.write_text(json.dumps(_spec(), ensure_ascii=False), encoding="utf-8")
    style_path.write_text(json.dumps(style, ensure_ascii=False), encoding="utf-8")
    scene_path.write_text(json.dumps({"duration": 7, "resolution": "960x540"}), encoding="utf-8")
    script = Path(__file__).parents[1] / "mona" / "skills" / "mona-video" / "scripts" / "compile_scene_spec.py"
    result = subprocess.run(
        [sys.executable, str(script), "--spec", str(spec_path), "--style", str(style_path), "--scene", str(scene_path), "--project", str(project)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    output = project / "scenes" / "scene_02.html"
    assert output.is_file()
    assert 'data-duration="6"' in output.read_text(encoding="utf-8")
