"""Video projects bind immutable series styles without breaking legacy projects."""

import json
import types
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

from PIL import Image

import mona.agent  # noqa: F401
import mona.api.server as server
from mona.video_brand import (
    apply_brand_kit,
    create_brand_kit,
    import_brand_logo,
    lock_brand_kit,
    materialize_brand_assets,
)
from mona.video_style import (
    BackgroundAssetInUseError,
    create_series,
    create_style_draft_from_version,
    delete_background_asset,
    import_background_asset,
    lock_style,
    read_style_draft,
    save_style_draft,
    series_directory,
)


def _request(body: dict) -> MagicMock:
    request = MagicMock()
    request.json = AsyncMock(return_value=body)
    return request


def _body(response) -> dict:
    return json.loads(response.body)


def _patch_workspace(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(server, "get_workspace_path", lambda: tmp_path)
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "video_projects")


def _locked_series(tmp_path: Path) -> tuple[dict, dict]:
    series = create_series(
        tmp_path,
        "ai-course",
        "AI 编程实战课",
        template_id="tech-dark",
        default_aspect_ratio="16:9",
    )
    style = lock_style(tmp_path, series["id"], expected_revision=0)
    return series, style


async def test_series_project_copies_immutable_style_and_metadata(
    monkeypatch, tmp_path: Path
) -> None:
    _patch_workspace(monkeypatch, tmp_path)
    series, style = _locked_series(tmp_path)

    response = await server.handle_video_project_create(
        _request(
            {
                "name": "episode-03",
                "resolution": "1080x1920",
                "seriesId": series["id"],
                "styleVersion": style["version"],
                "aspectVariant": "16:9",
                "episodeNumber": 3,
            }
        )
    )

    assert response.status == 200
    project = tmp_path / "video_projects" / "episode-03"
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert meta["resolution"] == "1920x1080"
    assert meta["seriesId"] == "ai-course"
    assert meta["seriesName"] == "AI 编程实战课"
    assert meta["styleVersion"] == 1
    assert meta["episodeNumber"] == 3
    assert (project / "style" / "design-system.json").is_file()
    assert (project / "style" / "theme.css").is_file()

    status = server._get_video_project_status(project)
    assert status["seriesId"] == "ai-course"
    assert status["styleVersion"] == 1


async def test_series_project_rejects_missing_style_version(
    monkeypatch, tmp_path: Path
) -> None:
    _patch_workspace(monkeypatch, tmp_path)
    series, _style = _locked_series(tmp_path)

    response = await server.handle_video_project_create(
        _request({"name": "bad", "seriesId": series["id"], "styleVersion": 9})
    )

    assert response.status == 404
    assert _body(response)["error"] == "STYLE_VERSION_NOT_FOUND"


async def test_episode_background_only_binds_replaceable_slot(
    monkeypatch, tmp_path: Path
) -> None:
    _patch_workspace(monkeypatch, tmp_path)
    series, style = _locked_series(tmp_path)
    source = tmp_path / "background.png"
    Image.new("RGB", (1920, 1080), "#1a2440").save(source)
    asset = import_background_asset(
        tmp_path,
        series["id"],
        source,
        rights_status="owned",
    )

    response = await server.handle_video_project_create(
        _request(
            {
                "name": "custom-background",
                "seriesId": series["id"],
                "styleVersion": style["version"],
                "backgroundBindings": {"content": asset["assetId"]},
            }
        )
    )

    assert response.status == 200
    project = tmp_path / "video_projects" / "custom-background"
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert meta["backgroundBindings"]["content"] == "assets/background-content.webp"
    assert meta["backgroundRegistryIds"]["content"] == "background-content"
    assert (project / "assets" / "background-content.webp").is_file()
    manifest = json.loads(
        (project / "assets" / "manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["assets"][0]["rightsStatus"] == "owned"
    try:
        delete_background_asset(tmp_path, series["id"], asset["assetId"])
    except BackgroundAssetInUseError:
        pass
    else:
        raise AssertionError("episode-bound background asset must be deletion-protected")

    rejected = await server.handle_video_project_create(
        _request(
            {
                "name": "fixed-background",
                "seriesId": series["id"],
                "styleVersion": style["version"],
                "backgroundBindings": {"cover": asset["assetId"]},
            }
        )
    )
    assert rejected.status == 409
    assert not (tmp_path / "video_projects" / "fixed-background").exists()


async def test_fixed_series_background_rights_are_snapshotted_into_project(
    monkeypatch, tmp_path: Path
) -> None:
    _patch_workspace(monkeypatch, tmp_path)
    series = create_series(tmp_path, series_id="rights", template_id="tech-dark")
    source = tmp_path / "licensed-background.png"
    Image.new("RGB", (1920, 1080), "#26345a").save(source)
    asset = import_background_asset(
        tmp_path,
        series["id"],
        source,
        source_type="licensed-library",
        rights_status="licensed",
        license_name="商业图库授权",
    )
    draft = save_style_draft(
        tmp_path,
        series["id"],
        {
            "backgrounds": {
                "default": {"assetPolicy": "fixed", "assetId": asset["assetId"]}
            },
            "aspectVariants": {
                "9:16": {"enabled": False},
                "1:1": {"enabled": False},
            },
        },
        expected_revision=0,
    )
    style = lock_style(
        tmp_path, series["id"], expected_revision=draft["revision"]
    )

    response = await server.handle_video_project_create(
        _request(
            {
                "name": "fixed-rights",
                "seriesId": series["id"],
                "styleVersion": style["version"],
            }
        )
    )

    assert response.status == 200
    project = tmp_path / "video_projects" / "fixed-rights"
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    registry_ids = list(meta["backgroundRegistryIds"].values())
    assert len(registry_ids) == 1
    manifest = json.loads(
        (project / "assets" / "manifest.json").read_text(encoding="utf-8")
    )
    registered = next(item for item in manifest["assets"] if item["id"] == registry_ids[0])
    assert registered["rightsStatus"] == "licensed"
    assert registered["licenseName"] == "商业图库授权"
    assert server._video_asset_preflight(
        project, [], registry_ids
    )["readyForCommercialUse"] is True
    create_style_draft_from_version(tmp_path, series["id"], 1)
    next_draft = save_style_draft(
        tmp_path,
        series["id"],
        {"tokens": {"shape": {"cardRadius": 12}}},
        expected_revision=0,
    )
    next_style = lock_style(
        tmp_path, series["id"], expected_revision=next_draft["revision"]
    )
    upgraded = await server.handle_video_project_upgrade_style(
        _request({"name": project.name, "styleVersion": next_style["version"]})
    )
    assert upgraded.status == 200
    upgraded_meta = server._load_video_meta(project)
    upgraded_registry_ids = [
        asset_id
        for key, asset_id in upgraded_meta["backgroundRegistryIds"].items()
        if key.startswith("style:")
    ]
    assert upgraded_registry_ids == registry_ids
    assert server._video_asset_preflight(
        project, [], upgraded_registry_ids
    )["readyForCommercialUse"] is True
    upgraded_manifest = json.loads(
        (project / "assets" / "manifest.json").read_text(encoding="utf-8")
    )
    upgraded_background = next(
        item for item in upgraded_manifest["assets"] if item["id"] == registry_ids[0]
    )
    assert (project / upgraded_background["path"]).is_file()


async def test_brand_logo_is_snapshotted_renderable_and_rights_checked(
    monkeypatch, tmp_path: Path
) -> None:
    _patch_workspace(monkeypatch, tmp_path)
    kit = create_brand_kit(
        tmp_path,
        "商业品牌",
        display_name="MONA LAB",
        tokens={
            "colors": {"primary": "#275DFF", "secondary": "#00A88F"},
            "typography": {
                "headingFamily": "Noto Sans SC",
                "bodyFamily": "Noto Sans SC",
            },
        },
    )
    source = tmp_path / "logo.png"
    Image.new("RGBA", (160, 80), (39, 93, 255, 255)).save(source)
    _logo, draft_kit = import_brand_logo(
        tmp_path,
        kit["id"],
        source,
        variant="light",
        rights_status="owned",
        alt="MONA LAB",
    )
    brand = lock_brand_kit(
        tmp_path, kit["id"], expected_revision=draft_kit["revision"]
    )
    series = create_series(tmp_path, series_id="brand-logo", template_id="tech-dark")
    series_root = series_directory(tmp_path) / series["id"]
    materialized = materialize_brand_assets(tmp_path, brand, series_root)
    branded = save_style_draft(
        tmp_path,
        series["id"],
        apply_brand_kit(read_style_draft(tmp_path, series["id"]), materialized),
        expected_revision=0,
        allow_brand_binding_change=True,
    )
    style = lock_style(
        tmp_path, series["id"], expected_revision=branded["revision"]
    )

    response = await server.handle_video_project_create(
        _request(
            {
                "name": "brand-logo-project",
                "seriesId": series["id"],
                "styleVersion": style["version"],
            }
        )
    )

    assert response.status == 200
    project = tmp_path / "video_projects" / "brand-logo-project"
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    registry_ids = list(meta["styleAssetRegistryIds"].values())
    assert len(registry_ids) == 1
    manifest = json.loads(
        (project / "assets" / "manifest.json").read_text(encoding="utf-8")
    )
    registered = next(item for item in manifest["assets"] if item["id"] == registry_ids[0])
    assert registered["usage"]["type"] == "brand-logo"
    assert registered["rightsStatus"] == "owned"
    assert server._style_brand_logo_path(style).startswith("../style/assets/")
    assert server._video_asset_preflight(
        project, [], registry_ids
    )["readyForCommercialUse"] is True
    create_style_draft_from_version(tmp_path, series["id"], 1)
    next_draft = save_style_draft(
        tmp_path,
        series["id"],
        {"tokens": {"shape": {"cardRadius": 12}}},
        expected_revision=0,
    )
    next_style = lock_style(
        tmp_path, series["id"], expected_revision=next_draft["revision"]
    )
    upgraded = await server.handle_video_project_upgrade_style(
        _request({"name": project.name, "styleVersion": next_style["version"]})
    )
    assert upgraded.status == 200
    upgraded_meta = server._load_video_meta(project)
    upgraded_registry_ids = list(upgraded_meta["styleAssetRegistryIds"].values())
    assert upgraded_registry_ids == registry_ids
    assert server._video_asset_preflight(
        project, [], upgraded_registry_ids
    )["readyForCommercialUse"] is True
    upgraded_manifest = json.loads(
        (project / "assets" / "manifest.json").read_text(encoding="utf-8")
    )
    upgraded_logo = next(
        item for item in upgraded_manifest["assets"] if item["id"] == registry_ids[0]
    )
    assert (project / upgraded_logo["path"]).is_file()


async def test_series_scene_generates_spec_then_compiles_fixed_html(
    monkeypatch, tmp_path: Path
) -> None:
    _patch_workspace(monkeypatch, tmp_path)
    series, style = _locked_series(tmp_path)
    response = await server.handle_video_project_create(
        _request(
            {
                "name": "structured",
                "seriesId": series["id"],
                "styleVersion": style["version"],
            }
        )
    )
    assert response.status == 200
    project = tmp_path / "video_projects" / "structured"
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    scene = {
        "index": 1,
        "title": "认识 AI 编程",
        "role": "content",
        "layout": "content-outline",
        "backgroundSlot": "content",
        "duration": 5,
        "visual": "标题与三个要点",
        "narration": "AI 编程让需求更快变成页面。",
    }

    class Provider:
        async def chat_with_retry(self, **_kwargs):
            return types.SimpleNamespace(
                content=json.dumps(
                    {
                        "schemaVersion": 1,
                        "sceneIndex": 1,
                        "role": "content",
                        "layout": "content-outline",
                        "backgroundSlot": "content",
                        "animationPreset": "fade-rise",
                        "duration": 5,
                        "content": {
                            "title": "认识 AI 编程",
                            "bullets": ["理解需求", "生成页面", "持续优化"],
                        },
                    },
                    ensure_ascii=False,
                )
            )

    import mona.providers.factory as factory

    monkeypatch.setattr(
        factory,
        "load_provider_snapshot",
        lambda: types.SimpleNamespace(provider=Provider(), model="test"),
    )

    html = await server._generate_series_scene_html(project, scene, meta)

    assert "认识 AI 编程" in html
    assert "window.__timelines" in html
    assert "window.__monaApplySubtitleTime" in html
    assert 'data-motion-target="title"' in html
    assert "data-layout=\"content-standard\"" in html
    spec = json.loads(
        (project / "scene_specs" / "scene_01.json").read_text(encoding="utf-8")
    )
    assert spec["layout"] == "content-standard"
    timing_path = project / "audio" / "scene_01.timing.json"
    motion_path = project / "scene_specs" / "scene_01.motion.json"
    assert timing_path.is_file()
    assert motion_path.is_file()
    assert json.loads(timing_path.read_text(encoding="utf-8"))["timingSource"] == "estimated"

    (project / "scenes" / "scene_01.html").write_text(html, encoding="utf-8")
    server._write_scene_timeline_artifacts(
        project,
        scene,
        scene["narration"],
        b"audio",
        boundaries=[
            {"text": "AI 编程", "startMs": 100, "endMs": 650},
            {"text": "让需求更快变成页面。", "startMs": 680, "endMs": 1900},
        ],
    )
    assert server._recompile_series_scene_from_artifacts(project, scene, meta) is True
    recompiled = (project / "scenes" / "scene_01.html").read_text(encoding="utf-8")
    assert 'data-start-ms="100"' in recompiled
    assert 'data-motion-target="title"' in recompiled


async def test_detached_episode_keeps_using_local_style_snapshot(
    monkeypatch, tmp_path: Path
) -> None:
    project = tmp_path / "video_projects" / "detached"
    (project / "style").mkdir(parents=True)
    (project / "style" / "design-system.json").write_text("{}", encoding="utf-8")
    generate = AsyncMock(return_value="<html>detached</html>")
    monkeypatch.setattr(server, "_generate_series_scene_html", generate)

    html = await server._generate_scene_html_via_llm(
        project,
        {"index": 1},
        {"styleVersion": 1, "detachedFromSeries": True},
    )

    assert html == "<html>detached</html>"
    generate.assert_awaited_once()


async def test_existing_episode_upgrades_to_new_immutable_style(
    monkeypatch, tmp_path: Path
) -> None:
    _patch_workspace(monkeypatch, tmp_path)
    series, first = _locked_series(tmp_path)
    response = await server.handle_video_project_create(
        _request(
            {
                "name": "episode-old-style",
                "seriesId": series["id"],
                "styleVersion": first["version"],
            }
        )
    )
    assert response.status == 200
    project = tmp_path / "video_projects" / "episode-old-style"
    meta = server._load_video_meta(project)
    meta["scenes"] = [{"index": 1, "htmlStatus": "previewing"}]
    server._save_video_meta(project, meta)

    create_style_draft_from_version(tmp_path, series["id"], 1)
    draft = save_style_draft(
        tmp_path,
        series["id"],
        {"tokens": {"colors": {"primary": "#2563EB"}}},
        expected_revision=0,
    )
    second = lock_style(
        tmp_path, series["id"], expected_revision=draft["revision"]
    )

    upgraded = await server.handle_video_project_upgrade_style(
        _request({"name": "episode-old-style", "styleVersion": second["version"]})
    )

    assert upgraded.status == 200
    meta = server._load_video_meta(project)
    assert meta["styleVersion"] == 2
    assert meta["scenes"][0]["htmlStatus"] == "pending"
    copied = json.loads(
        (project / "style" / "design-system.json").read_text(encoding="utf-8")
    )
    assert copied["version"] == 2
    assert copied["tokens"]["colors"]["primary"] == "#2563EB"


async def test_series_projects_can_be_batch_upgraded_with_recovery_versions(
    monkeypatch, tmp_path: Path
) -> None:
    _patch_workspace(monkeypatch, tmp_path)
    series, first = _locked_series(tmp_path)
    for name in ("episode-one", "episode-two"):
        response = await server.handle_video_project_create(
            _request(
                {
                    "name": name,
                    "seriesId": series["id"],
                    "styleVersion": first["version"],
                }
            )
        )
        assert response.status == 200
        (tmp_path / "video_projects" / name / "renders" / "output.mp4").write_bytes(
            b"previous-video"
        )
    create_style_draft_from_version(tmp_path, series["id"], 1)
    draft = save_style_draft(
        tmp_path,
        series["id"],
        {"tokens": {"colors": {"primary": "#7C3AED"}}},
        expected_revision=0,
    )
    second = lock_style(
        tmp_path, series["id"], expected_revision=draft["revision"]
    )
    request = _request(
        {
            "styleVersion": second["version"],
            "projectNames": ["episode-one", "episode-two"],
        }
    )
    request.match_info = {"series_id": series["id"]}

    response = await server.handle_video_series_projects_upgrade(request)

    assert response.status == 200
    result = _body(response)
    assert result["updatedProjectNames"] == ["episode-one", "episode-two"]
    for name in result["updatedProjectNames"]:
        project = tmp_path / "video_projects" / name
        meta = server._load_video_meta(project)
        assert meta["styleVersion"] == 2
        assert meta["outputStale"] is True
        versions = list((project / "versions").iterdir())
        assert len(versions) == 1
        old_style = json.loads(
            (versions[0] / "style" / "design-system.json").read_text(
                encoding="utf-8"
            )
        )
        assert old_style["version"] == 1


async def test_series_project_switches_aspect_without_losing_audio_timeline(
    monkeypatch, tmp_path: Path
) -> None:
    _patch_workspace(monkeypatch, tmp_path)
    series, style = _locked_series(tmp_path)
    response = await server.handle_video_project_create(
        _request(
            {
                "name": "responsive-episode",
                "seriesId": series["id"],
                "styleVersion": style["version"],
                "aspectVariant": "16:9",
            }
        )
    )
    assert response.status == 200
    project = tmp_path / "video_projects" / "responsive-episode"
    meta = server._load_video_meta(project)
    meta.update(
        {
            "phase": "done",
            "hasVideo": True,
            "scenes": [
                {
                    "index": 1,
                    "title": "响应式场景",
                    "htmlStatus": "confirmed",
                    "confirmedAt": "2026-08-28T00:00:00",
                }
            ],
        }
    )
    server._save_video_meta(project, meta)
    (project / "audio" / "scene_01.timing.json").write_text(
        json.dumps({"schemaVersion": 1, "cues": []}), encoding="utf-8"
    )
    (project / "renders" / "output.mp4").write_bytes(b"previous-video")

    changed = await server.handle_video_project_change_aspect(
        _request({"name": project.name, "aspectVariant": "9:16"})
    )

    assert changed.status == 200
    result = _body(changed)
    assert result["resolution"] == "1080x1920"
    updated = server._load_video_meta(project)
    assert updated["aspectVariant"] == "9:16"
    assert updated["scenes"][0]["htmlStatus"] == "pending"
    assert "confirmedAt" not in updated["scenes"][0]
    assert updated["outputStale"] is True
    assert (project / "audio" / "scene_01.timing.json").is_file()
    assert len(list((project / "versions").iterdir())) == 1
