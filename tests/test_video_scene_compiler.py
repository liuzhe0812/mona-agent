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
    style_preview_spec,
    validate_scene_spec,
)
from mona.video_style import get_builtin_template
from mona.video_timeline import build_motion_plan, build_subtitle_track

LAYOUTS = [
    "cover-split",
    "chapter-title",
    "content-standard",
    "metric-comparison",
    "comparison-columns",
    "process-steps",
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
                "chapter": {"inherit": "default"},
                "content": {"inherit": "default"},
                "data": {"inherit": "default"},
                "comparison": {"inherit": "default"},
                "process": {"inherit": "default"},
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
    elif layout == "chapter-title":
        spec["role"] = "chapter"
        spec["content"]["chapterNumber"] = 2
    elif layout == "process-steps":
        spec["role"] = "process"
        spec["content"]["steps"] = ["明确目标", "预览修改", "导出交付"]
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


@pytest.mark.parametrize(
    "layout",
    ["process-horizontal", "process-node-line", "process-numbered", "process-step-cards"],
)
def test_process_aliases_compile_as_numbered_connected_steps_and_accept_bullets(
    style: dict, layout: str
) -> None:
    spec = _spec(
        layout,
        bullets=[
            "明确目标",
            {"title": "预览画面", "body": "检查每一幕的内容"},
            "导出交付",
        ],
    )
    spec["role"] = "process"

    normalized = validate_scene_spec(spec, style)
    assert normalized["layout"] == "process-steps"
    landscape = compile_scene_spec(spec, style, resolution="1920x1080")
    assert 'data-layout="process-steps"' in landscape
    assert landscape.count('class="process-step"') == 3
    assert '<span class="process-step-number" aria-hidden="true">1</span>' in landscape
    assert '<h2>明确目标</h2>' in landscape
    assert "检查每一幕的内容" in landscape
    assert "导出交付" in landscape
    assert ".process-step:not(:last-child)::after" in landscape

    portrait = compile_scene_spec(spec, style, resolution="1080x1920")
    assert ".process-step-list { grid-template-columns: 1fr;" in portrait
    assert "left: 1.05em; width: 2px; height: auto;" in portrait


def test_process_layout_rejects_non_list_steps(style: dict) -> None:
    spec = _spec("process-node-line", bullets="明确目标")
    spec["role"] = "process"

    with pytest.raises(SceneCompileError) as exc:
        validate_scene_spec(spec, style)

    assert exc.value.code == "SCENE_SPEC_INVALID_CONTENT"
    assert exc.value.details["path"] == "$.content.bullets"


def test_process_layout_can_turn_existing_body_into_a_single_step(style: dict) -> None:
    spec = _spec("process-numbered", body="输入 & 输出")
    spec["role"] = "process"

    output = compile_scene_spec(spec, style)

    assert "<h2>输入 &amp; 输出</h2>" in output
    assert "&amp;amp;" not in output


@pytest.mark.parametrize(
    "layout",
    ["chapter-numbered", "chapter-glow", "chapter-rule", "chapter-sticker"],
)
def test_chapter_aliases_compile_as_numbered_chapter_titles(
    style: dict, layout: str
) -> None:
    spec = _spec(layout, title="从想法到作品", body="开始新的章节。")
    spec["role"] = "chapter"

    normalized = validate_scene_spec(spec, style)
    output = compile_scene_spec(
        spec, style, scene={"index": 5}, resolution="1920x1080"
    )

    assert normalized["layout"] == "chapter-title"
    assert 'data-layout="chapter-title"' in output
    assert '<div class="chapter-number" data-motion-target="chapter.number">第 5 章</div>' in output
    assert '<h1 data-motion-target="title">从想法到作品</h1>' in output
    assert "开始新的章节。" in output


def test_style_preview_uses_canonical_chapter_and_process_layouts() -> None:
    for template_id in (
        "tech-dark",
        "minimal-business",
        "knowledge-cards",
        "editorial-magazine",
    ):
        style = get_builtin_template(template_id)
        for role, layout in (("chapter", "chapter-title"), ("process", "process-steps")):
            spec = style_preview_spec(style, role)
            assert spec["role"] == role
            assert spec["layout"] == layout
            normalized = validate_scene_spec(spec, style)
            assert normalized["layout"] == layout
            output = compile_scene_spec(spec, style, resolution="1080x1920")
            assert f'data-role="{role}"' in output
            assert f'data-layout="{layout}"' in output


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


def test_cover_consumes_keyword_columns_without_exposing_production_notes(style: dict) -> None:
    spec = _spec("cover-split", columns=[
        {"title": "Journey", "body": "用户旅程"},
        {"title": "Engagement", "text": "深度互动"},
        {"heading": "Value", "items": ["价值转化"]},
    ])
    output = compile_scene_spec(spec, style, scene={"visual": "左侧大标题，右侧三个关键词卡片"})
    assert "左侧大标题" not in output
    assert output.count('class="card keyword-card"') == 3
    for title, text in (("Journey", "用户旅程"), ("Engagement", "深度互动"), ("Value", "价值转化")):
        assert f"<h2>{title}</h2>" in output
        assert text in output
    spec["content"]["columns"] = [{"body": "没有标题"}]
    with pytest.raises(SceneCompileError) as exc:
        compile_scene_spec(spec, style)
    assert exc.value.details["path"] == "$.content.columns[0].title"


def test_style_font_scale_card_style_and_density_change_compiled_layout(style: dict) -> None:
    compact = compile_scene_spec(_spec(), style, resolution="1920x1080")
    style["tokens"]["typography"]["scale"] = "large"
    style["tokens"]["shape"].update({"cardStyle": "none", "density": "spacious"})
    spacious = compile_scene_spec(_spec(), style, resolution="1920x1080")
    assert ".scene h1 { font-size: 86px; }" in compact
    assert ".scene h1 { font-size: 98px; }" in spacious
    assert ".scene .scene-content { padding: 103px 185px; }" in spacious
    assert ".scene .card, .scene .cover-visual, .scene .scene-media { background: transparent; border: 0; box-shadow: none;" in spacious


def test_style_typography_spacing_and_safe_area_are_used(style: dict) -> None:
    style["tokens"]["typography"].update(
        {
            "headingWeight": 800,
            "bodyWeight": 500,
            "headingLineHeight": 1.3,
            "bodyLineHeight": 1.8,
        }
    )
    style["tokens"]["spacing"] = {"unit": 12, "contentPadding": 120}
    style["tokens"]["shape"].update(
        {"borderWidth": 2, "shadow": "soft", "shadowOpacity": 0.2}
    )
    style["backgrounds"]["default"]["safeArea"] = {
        "top": 0.12,
        "right": 0.08,
        "bottom": 0.1,
        "left": 0.1,
    }
    style["backgrounds"]["roles"]["content"] = {"inherit": "default"}
    style["subtitle"] = {
        "fontSize": 42,
        "lineHeight": 1.4,
        "safeAreaTop": 0.1,
        "safeAreaRight": 0.06,
        "safeAreaBottom": 0.12,
        "safeAreaLeft": 0.07,
    }

    output = compile_scene_spec(
        _spec(subtitle="字幕留在安全区"), style, resolution="1920x1080"
    )

    assert "--mona-heading-weight: 800;" in output
    assert "--mona-body-weight: 500;" in output
    assert "--mona-heading-line-height: 1.3;" in output
    assert "--mona-body-line-height: 1.8;" in output
    assert "--mona-spacing-unit: 24px;" in output
    assert "--mona-border-width: 2px;" in output
    assert "--mona-shadow-opacity: 0.2;" in output
    assert ".scene .scene-content { padding: 130px 192px; }" in output
    assert "--mona-subtitle-font-size: 42px;" in output
    assert "--mona-subtitle-safe-bottom: 130px;" in output
    assert "--mona-subtitle-safe-left: 134px;" in output


def test_subtitle_minimum_size_adapts_to_portrait_and_landscape(style: dict) -> None:
    spec = _spec(subtitle="清晰字幕")
    landscape = compile_scene_spec(spec, style, resolution="1920x1080")
    portrait = compile_scene_spec(spec, style, resolution="1080x1920")

    assert "--mona-subtitle-font-size: 36px;" in landscape
    assert "--mona-subtitle-font-size: 48px;" in portrait
    assert "--mona-subtitle-safe-bottom: 86px;" in landscape
    assert "--mona-subtitle-safe-bottom: 154px;" in portrait


def test_cover_without_visuals_uses_clean_title_layout(style: dict) -> None:
    output = compile_scene_spec(
        _spec("cover-split", title="从这里开始", body="用清楚的内容讲解主题。"),
        style,
        resolution="1920x1080",
    )

    assert "cover-simple" in output
    assert 'class="scene-content cover-copy cover-simple-copy"' in output
    assert 'class="scene-visual cover-visual"' not in output
    assert "visual-orbit" not in output


def test_background_preview_accepts_only_controlled_bitmap_data(style: dict) -> None:
    output = compile_scene_spec(_spec(), style, background_data_uri="data:image/webp;base64,UklGRg==")
    assert 'url("data:image/webp;base64,UklGRg==")' in output
    with pytest.raises(SceneCompileError):
        compile_scene_spec(_spec(), style, background_data_uri="data:image/svg+xml;base64,PHN2Zz4=")


def test_motion_plan_and_compiler_consume_style_preferences(style: dict) -> None:
    track = build_subtitle_track("第一句。第二句。", 6000)
    style["motion"] = {"enterPreset": "stagger-rise", "emphasisPreset": "cross-fade", "transitionPreset": "fade-rise", "transitionDurationMs": 300, "intensity": "restrained"}
    plan = build_motion_plan(
        {"index": 1, "role": "cover"}, track,
        allowed_effects=style["allowedAnimations"], motion_preferences=style["motion"],
    )
    assert next(beat for beat in plan["beats"] if beat["target"] == "title")["effect"] == "stagger-rise"
    assert next(beat for beat in plan["beats"] if beat["target"] == "visual")["effect"] == "cross-fade"
    assert all(beat["intensity"] == "restrained" for beat in plan["beats"])
    output = compile_scene_spec(_spec("cover-split"), style, motion_plan=plan, preview=True)
    assert 'data-transition-preset="fade-rise" data-transition-duration-ms="300"' in output
    assert "window.requestAnimationFrame(animatePreview)" in output


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
            assert 'class="template-decor"' not in output
            assert "radial-gradient(" not in output
            assert "visual-orbit" not in output
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
