"""Focused contract tests for the video-series style domain module."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from mona.api import video_series
from mona.video_style import (
    BackgroundAssetError,
    BackgroundAssetInUseError,
    RevisionConflictError,
    StyleValidationError,
    create_series,
    create_style_draft_from_version,
    delete_background_asset,
    get_builtin_template,
    import_background_asset,
    list_builtin_templates,
    list_series,
    lock_style,
    read_style_draft,
    read_style_version,
    safe_series_id,
    save_style_draft,
    validate_series_id,
    validate_style,
)


def _image(path: Path, *, size: tuple[int, int] = (1920, 1080), fmt: str = "PNG") -> None:
    Image.new("RGB", size, (28, 36, 52)).save(path, format=fmt)


@pytest.fixture
async def services_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    import mona.services.server as services

    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "app-data"))
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "video-style-preview-test-token")
    monkeypatch.setattr(services.imap_pool_manager, "keepalive", lambda *_args: None)
    monkeypatch.setattr(services._idle_manager, "set_loop", lambda _loop: None)
    async with TestClient(TestServer(services.create_services_app())) as client:
        yield client


def test_templates_are_the_nine_huashu_motion_sources() -> None:
    templates = list_builtin_templates()
    assert {item["id"] for item in templates} == {
        "huashu-keynote", "huashu-whiteboard", "huashu-finance", "huashu-math",
        "huashu-type", "huashu-collage", "huashu-science", "huashu-3d", "huashu-ui-space",
    }
    required = {"cover", "chapter", "content", "data", "comparison", "process", "quote", "outro"}
    skill = Path(__file__).resolve().parents[1] / "mona/skills/mona-motion"
    for item in templates:
        assert required <= set(item["components"])
        assert validate_style(item)["valid"]
        assert item["source"]["kind"] == "huashu-motion"
        assert (skill / item["source"]["templatePath"]).is_file()
        assert (skill / item["source"]["manifestPath"]).is_file()
    assert get_builtin_template("huashu-keynote")["id"] == "huashu-keynote"


async def test_style_template_list_includes_real_huashu_preview_urls(
    services_client: TestClient,
) -> None:
    response = await services_client.get("/api/video/style/templates")
    assert response.status == 200
    templates = {item["id"]: item for item in (await response.json())["templates"]}

    for kind, url in templates["huashu-whiteboard"]["preview"].items():
        parsed = urlsplit(url)
        assert parsed.path == "/api/video/style/templates/huashu-whiteboard/preview"
        assert parse_qs(parsed.query)["kind"] == [kind]
        assert int(parse_qs(parsed.query)["v"][0], 16) > 0
    assert all(set(item["preview"]) == {"poster", "motion"} for item in templates.values())


async def test_updated_style_preview_uses_a_new_cache_url(services_client, tmp_path, monkeypatch) -> None:
    assets = tmp_path / "preview-assets"
    assets.mkdir()
    poster = assets / "poster.png"
    _image(poster, size=(16, 16))
    _image(assets / "motion.gif", size=(16, 16), fmt="GIF")
    monkeypatch.setattr(video_series, "_HUASHU_ASSET_ROOT", assets)
    monkeypatch.setattr(video_series, "_HUASHU_TEMPLATE_PREVIEWS", {
        "huashu-whiteboard": {"poster": ("poster.png", "PNG"), "motion": ("motion.gif", "GIF")},
    })

    async def poster_url():
        response = await services_client.get("/api/video/style/templates")
        assert response.status == 200
        return next(item["preview"]["poster"] for item in (await response.json())["templates"] if item["id"] == "huashu-whiteboard")

    before = await poster_url()
    stamp = poster.stat()
    Image.new("RGB", (16, 16), "green").save(poster)
    os.utime(poster, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1_000_000_000))
    after = await poster_url()
    assert before != after
    updated = await services_client.get(after)
    assert updated.status == 200
    assert await updated.read() == poster.read_bytes()


async def test_huashu_preview_endpoint_serves_real_template_captures(
    services_client: TestClient,
) -> None:
    mime_types = {"PNG": "image/png", "GIF": "image/gif"}
    for template_id, previews in video_series._HUASHU_TEMPLATE_PREVIEWS.items():
        for kind, (relative_path, image_format) in previews.items():
            response = await services_client.get(
                f"/api/video/style/templates/{template_id}/preview",
                params={"kind": kind},
            )
            source = (video_series._HUASHU_ASSET_ROOT / relative_path).read_bytes()
            assert response.status == 200
            assert response.content_type == mime_types[image_format]
            assert await response.read() == source


async def test_huashu_preview_rejects_invalid_ids_kinds_and_escaped_resources(
    services_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unknown = await services_client.get(
        "/api/video/style/templates/not-a-template/preview?kind=poster"
    )
    invalid_kind = await services_client.get(
        "/api/video/style/templates/huashu-whiteboard/preview?kind=html"
    )
    traversal_id = await services_client.get(
        "/api/video/style/templates/%2E%2E%2Foutside/preview?kind=poster"
    )
    ignored_path = await services_client.get(
        "/api/video/style/templates/huashu-whiteboard/preview?kind=poster&path=../../outside"
    )
    assert unknown.status == 404
    assert invalid_kind.status == 400
    assert 400 <= traversal_id.status < 500
    assert ignored_path.status == 200

    monkeypatch.setitem(
        video_series._HUASHU_TEMPLATE_PREVIEWS["huashu-whiteboard"],
        "poster",
        ("../../outside.png", "PNG"),
    )
    escaped_resource = await services_client.get(
        "/api/video/style/templates/huashu-whiteboard/preview?kind=poster"
    )
    assert escaped_resource.status == 404


def test_series_and_draft_revision_are_atomic_and_conflict_safe(tmp_path: Path) -> None:
    series = create_series(tmp_path, name="AI 编程课", template_id="huashu-ui-space")
    assert series["id"] == safe_series_id("AI 编程课")
    assert list_series(tmp_path)[0]["id"] == series["id"]
    assert read_style_draft(tmp_path, series["id"])["revision"] == 0

    saved = save_style_draft(
        tmp_path,
        series["id"],
        {"tokens": {"colors": {"primary": "#123456"}}},
        expected_revision=0,
    )
    assert saved["revision"] == 1
    assert read_style_draft(tmp_path, series["id"])["tokens"]["colors"]["primary"] == "#123456"
    with pytest.raises(RevisionConflictError) as exc_info:
        save_style_draft(tmp_path, series["id"], {"mode": "light"}, expected_revision=0)
    assert exc_info.value.code == "STYLE_DRAFT_REVISION_CONFLICT"
    assert exc_info.value.status_code == 409


def test_series_enables_its_selected_default_aspect_ratio(tmp_path: Path) -> None:
    series = create_series(
        tmp_path,
        series_id="vertical-course",
        template_id="huashu-ui-space",
        default_aspect_ratio="9:16",
    )

    draft = read_style_draft(tmp_path, series["id"])
    assert draft["aspectVariants"]["9:16"]["enabled"] is True
    assert draft["aspectVariants"]["16:9"]["enabled"] is True
    assert draft["aspectVariants"]["1:1"]["enabled"] is True


def test_lock_creates_immutable_version_and_new_draft(tmp_path: Path) -> None:
    create_series(tmp_path, series_id="course", template_id="huashu-keynote")
    first = lock_style(tmp_path, "course", expected_revision=0)
    assert first["version"] == 1
    assert first["tokens"]["colors"]["primaryContrast"]
    assert first["motion"]["enterDurationMs"] > 0
    css = tmp_path / "video_series" / "course" / "styles" / "v1" / "theme.css"
    assert "--mona-colors-primary" in css.read_text(encoding="utf-8")
    previews = css.parent / "previews"
    for role in ("cover", "chapter", "content", "data", "comparison", "process", "quote", "outro"):
        preview = (previews / f"{role}.html").read_text(encoding="utf-8")
        assert f'data-role="{role}"' in preview
        assert "window.__timelines" in preview
    first_snapshot = json.dumps(read_style_version(tmp_path, "course", 1), sort_keys=True)

    draft = create_style_draft_from_version(tmp_path, "course", 1)
    assert draft.get("version") is None
    second_draft = save_style_draft(tmp_path, "course", {"mode": "dark"}, expected_revision=0)
    second = lock_style(tmp_path, "course", expected_revision=second_draft["revision"])
    assert second["version"] == 2
    assert json.dumps(read_style_version(tmp_path, "course", 1), sort_keys=True) == first_snapshot
    assert read_style_version(tmp_path, "course", 1)["version"] == 1


def test_lock_requires_series_default_aspect_to_remain_enabled(tmp_path: Path) -> None:
    series = create_series(tmp_path, series_id="portrait", template_id="huashu-ui-space", default_aspect_ratio="9:16")
    draft = save_style_draft(tmp_path, series["id"], {"aspectVariants": {"9:16": {"enabled": False}}}, expected_revision=0)
    result = validate_style(draft, tmp_path, series["id"])
    assert any(issue["code"] == "DEFAULT_ASPECT_DISABLED" and issue["field"] == "aspectVariants.9:16.enabled" for issue in result["errors"])
    with pytest.raises(StyleValidationError):
        lock_style(tmp_path, series["id"], expected_revision=draft["revision"])
    assert not (tmp_path / "video_series" / series["id"] / "styles" / "v1").exists()


def test_style_rejects_an_unsupported_scene_transition() -> None:
    style = get_builtin_template("huashu-ui-space")
    style["motion"]["transitionPreset"] = "soft-pulse"
    result = validate_style(style)
    assert any(issue["field"] == "motion.transitionPreset" and issue["code"] == "INVALID_TRANSITION_PRESET" for issue in result["errors"])


def test_background_import_normalizes_to_webp_and_snapshot_is_protected(tmp_path: Path) -> None:
    series = create_series(tmp_path, series_id="images", template_id="huashu-ui-space")
    source = tmp_path / "source.png"
    _image(source)
    asset = import_background_asset(
        tmp_path,
        series["id"],
        source,
        asset_id="hero",
        source_type="licensed-library",
        rights_status="licensed",
        license_name="商业图库授权",
    )
    assert asset["mimeType"] == "image/webp"
    assert asset["sha256"]
    assert asset["commercialUse"] is True
    assert (tmp_path / "video_series" / "images" / "draft" / "assets" / "hero.webp").is_file()

    save_style_draft(
        tmp_path,
        "images",
        {
            "backgrounds": {"default": {"assetPolicy": "fixed", "assetId": "hero"}},
            "aspectVariants": {
                "9:16": {"enabled": False},
                "1:1": {"enabled": False},
            },
        },
        expected_revision=0,
    )
    version = lock_style(tmp_path, "images", expected_revision=1)
    assert version["backgrounds"]["default"]["assetPath"] == "assets/hero.webp"
    assert (tmp_path / "video_series" / "images" / "styles" / "v1" / "assets" / "hero.webp").is_file()
    locked_metadata = json.loads(
        (
            tmp_path
            / "video_series"
            / "images"
            / "styles"
            / "v1"
            / "assets"
            / "hero.json"
        ).read_text(encoding="utf-8")
    )
    assert locked_metadata["licenseName"] == "商业图库授权"
    copied_draft = create_style_draft_from_version(tmp_path, "images", 1)
    assert copied_draft["backgrounds"]["default"]["assetId"] == "hero"
    assert (tmp_path / "video_series" / "images" / "draft" / "assets" / "hero.webp").is_file()
    restored_metadata = json.loads(
        (
            tmp_path
            / "video_series"
            / "images"
            / "draft"
            / "assets"
            / "hero.json"
        ).read_text(encoding="utf-8")
    )
    assert restored_metadata["rightsStatus"] == "licensed"
    v2_draft = save_style_draft(tmp_path, "images", {"mode": "dark"}, expected_revision=0)
    assert lock_style(tmp_path, "images", expected_revision=v2_draft["revision"])["version"] == 2
    with pytest.raises(BackgroundAssetInUseError):
        delete_background_asset(tmp_path, "images", "hero")


def test_background_rejects_fake_extension_and_oversize(tmp_path: Path) -> None:
    series = create_series(tmp_path, series_id="safe", template_id="huashu-ui-space")
    fake = tmp_path / "fake.png"
    fake.write_bytes(b"not an image")
    with pytest.raises(BackgroundAssetError) as exc_info:
        import_background_asset(tmp_path, series["id"], fake)
    assert exc_info.value.code == "BACKGROUND_DECODE_FAILED"

    oversized = tmp_path / "oversized.jpg"
    oversized.write_bytes(b"0" * (20 * 1024 * 1024 + 1))
    with pytest.raises(BackgroundAssetError) as exc_info:
        import_background_asset(tmp_path, series["id"], oversized)
    assert exc_info.value.code == "BACKGROUND_FILE_TOO_LARGE"
    assert exc_info.value.status_code == 413


def test_invalid_series_id_and_style_are_rejected() -> None:
    with pytest.raises(Exception) as exc_info:
        validate_series_id("../escape")
    assert getattr(exc_info.value, "code", None) == "INVALID_SERIES_ID"
    result = validate_style({"schemaVersion": 1})
    assert result["valid"] is False
    assert any(item["code"] == "MISSING_TOKENS" for item in result["errors"])


def test_low_resolution_background_is_a_lock_gate(tmp_path: Path) -> None:
    series = create_series(tmp_path, series_id="small", template_id="huashu-ui-space")
    source = tmp_path / "small.png"
    _image(source, size=(64, 64))
    import_background_asset(tmp_path, series["id"], source, asset_id="small")
    draft = save_style_draft(
        tmp_path,
        series["id"],
        {"backgrounds": {"default": {"assetPolicy": "fixed", "assetId": "small"}}},
        expected_revision=0,
    )
    check = validate_style(draft, tmp_path, series["id"])
    assert any(item["code"] == "BACKGROUND_LOW_RESOLUTION" for item in check["errors"])
    with pytest.raises(StyleValidationError):
        lock_style(tmp_path, series["id"], expected_revision=draft["revision"])
