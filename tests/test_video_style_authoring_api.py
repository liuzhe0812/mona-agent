"""HTTP contracts for binding and previewing authored video style samples."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

from mona.api import video_series
from mona.materials.auth import SERVICES_TOKEN_HEADER, get_services_token
from mona.video_style import (
    create_series,
    get_builtin_template,
    read_style_draft,
    save_style_draft,
    series_directory,
)


@pytest.fixture
async def services_client(monkeypatch: pytest.MonkeyPatch, tmp_path):
    import mona.services.server as services

    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "app-data"))
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "video-style-authoring-test-token")
    monkeypatch.setattr(services.imap_pool_manager, "keepalive", lambda *_args: None)
    monkeypatch.setattr(services._idle_manager, "set_loop", lambda _loop: None)
    async with TestClient(TestServer(services.create_services_app(workspace=tmp_path))) as client:
        yield client


def _auth_headers() -> dict[str, str]:
    return {SERVICES_TOKEN_HEADER: get_services_token()}


def _write_json(path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def _create_saved_sample_version(root, series):
    version = series_directory(root) / series["id"] / "styles" / "v1"
    authoring = version / "authoring"
    source = b"export const Scene = () => <div>saved</div>;"
    files = {
        "scene_sources/scene_01.tsx": source,
        "scenes/scene_01.html": b"<html><body>saved html</body></html>",
        "renders/previews/scene_01/sample_0.png": b"frame zero",
        "renders/previews/scene_01/sample_1.png": b"frame one",
        "audio/scene_01.mp3": b"saved voice",
        "audio/scene_01.timing.json": b"{}",
        "style/theme.css": b"body { color: #123456; }",
    }
    for relative, data in files.items():
        path = authoring / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    asset_path = authoring / "assets" / "saved-background.webp"
    asset_path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (2, 2), (12, 34, 56)).save(asset_path, format="WEBP")
    files["assets/saved-background.webp"] = asset_path.read_bytes()
    asset_record = {
        "schemaVersion": 1,
        "id": "saved-background",
        "kind": "image",
        "path": "assets/saved-background.webp",
        "originalName": "saved-background.webp",
        "mimeType": "image/webp",
        "sourceType": "ai-generated",
        "rightsStatus": "ai-generated",
        "sha256": hashlib.sha256(files["assets/saved-background.webp"]).hexdigest(),
    }
    scene = {
        "index": 1,
        "duration": 2,
        "narration": "Saved narration",
        "authored": True,
        "authoredRuntime": "remotion",
        "sourcePath": "scene_sources/scene_01.tsx",
        "sourceHash": hashlib.sha256(source).hexdigest(),
        "htmlStatus": "previewing",
        "assets": [asset_record["id"]],
    }
    _write_json(authoring / "assets" / "manifest.json", {"schemaVersion": 1, "assets": [asset_record]})
    (authoring / "previews").mkdir(parents=True)
    _write_json(authoring / "sample.json", {
        "schemaVersion": 1,
        "resolution": "640x360",
        "narrationEnabled": True,
        "subtitleMode": "external",
        "scenes": [scene],
        "assets": [asset_record],
        "files": {relative: hashlib.sha256(data).hexdigest() for relative, data in files.items()},
    })
    (authoring / "rules.md").write_text("Saved style rules", encoding="utf-8")
    Image.new("RGB", (2, 2), (1, 2, 3)).save(authoring / "previews" / "poster.png", format="PNG")
    Image.new("RGB", (2, 2), (4, 5, 6)).save(authoring / "previews" / "motion.gif", format="GIF")
    style = get_builtin_template("huashu-ui-space")
    style.update({
        "seriesId": series["id"],
        "version": 1,
        "lockedAt": "2026-10-15T00:00:00Z",
        "authoring": {
            "samplePath": "authoring/sample.json",
            "rulesPath": "authoring/rules.md",
            "poster": "authoring/previews/poster.png",
            "motion": "authoring/previews/motion.gif",
        },
    })
    _write_json(version / "design-system.json", style)
    return scene


def _request(body: dict, series_id: str) -> MagicMock:
    request = MagicMock()
    request.match_info = {"series_id": series_id}
    request.query = {}
    request.json = AsyncMock(return_value=body)
    return request


async def _create_refresh_sample(root, monkeypatch):
    monkeypatch.setattr(video_series, "_root", lambda: root)
    series = create_series(root, "refresh-style", "Refresh Style", template_id="huashu-ui-space")
    project = root / "video_projects" / "refresh-project"
    (project / "style").mkdir(parents=True)
    _write_json(project / "meta.json", {"name": "refresh-project", "resolution": "640x360"})
    bound = await video_series.handle_video_style_sample_bind(
        _request({"projectName": "refresh-project", "revision": 0}, series["id"])
    )
    assert bound.status == 200

    draft = read_style_draft(root, series["id"])
    changed = save_style_draft(
        root,
        series["id"],
        {"revision": draft["revision"], "tokens": {"colors": {"primary": "#123456"}}},
        expected_revision=draft["revision"],
    )
    source = "const style = 'var(--mona-primary)';"
    source_path = project / "scene_sources" / "scene_01.tsx"
    source_path.parent.mkdir(parents=True)
    source_path.write_text(source, encoding="utf-8")
    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
    meta_path = project / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.update({
        "narrationEnabled": False,
        "scenes": [{
            "index": 1,
            "duration": 2,
            "narration": "",
            "authored": True,
            "authoredRuntime": "remotion",
            "sourcePath": "scene_sources/scene_01.tsx",
            "sourceHash": source_hash,
            "htmlStatus": "previewing",
        }],
    })
    _write_json(meta_path, meta)
    scene_html = project / "scenes" / "scene_01.html"
    scene_html.parent.mkdir(parents=True)
    scene_html.write_text("old sample scene", encoding="utf-8")
    preview_dir = project / "renders" / "previews" / "scene_01"
    preview_dir.mkdir(parents=True)
    old_frame = preview_dir / "sample_0.png"
    Image.new("RGB", (2, 2), (1, 2, 3)).save(old_frame, format="PNG")
    return series, project, changed, scene_html, old_frame


async def test_sample_binding_and_preview_use_the_bound_project(
    services_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    series = create_series(tmp_path, "sample-style", "Sample Style", template_id="huashu-ui-space")
    project = tmp_path / "video_projects" / "sample-project"
    (project / "style").mkdir(parents=True)
    _write_json(project / "meta.json", {"name": "sample-project", "resolution": "640x360"})

    bound = await services_client.post(
        f"/api/video/series/{series['id']}/style/sample",
        headers=_auth_headers(),
        json={"projectName": "sample-project", "revision": 0, "description": "纸张质感"},
    )
    assert bound.status == 200
    draft = (await bound.json())["draft"]
    assert draft["revision"] == 1
    assert draft["authoring"]["projectName"] == "sample-project"
    assert draft["authoring"]["description"] == "纸张质感"

    meta_path = project / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta.update({
        "resolution": "640x360",
        "narrationEnabled": True,
        "scenes": [{
            "index": 1, "duration": 2.5, "narration": "样片旁白",
            "authored": True, "authoredRuntime": "remotion",
            "sourcePath": "scene_sources/scene_01.tsx",
        }],
    })
    _write_json(meta_path, meta)
    (project / "scenes").mkdir()
    (project / "scenes" / "scene_01.html").write_text(
        "<!doctype html><html><body><main>Sample scene</main></body></html>",
        encoding="utf-8",
    )
    (project / "scene_sources").mkdir()
    (project / "scene_sources" / "scene_01.tsx").write_text(
        "var(--mona-primary) var(--mona-bg) var(--mona-heading-family)", encoding="utf-8"
    )
    (project / "audio").mkdir()
    audio = b"already-generated narration"
    (project / "audio" / "scene_01.mp3").write_bytes(audio)

    muted = await services_client.get(
        f"/api/video/series/{series['id']}/style/sample?muted=1",
        headers=_auth_headers(),
    )
    assert muted.status == 200
    muted_body = await muted.json()
    assert muted_body["duration"] == 2.5
    assert muted_body["revision"] == 1
    assert muted_body["editableFields"] == ["primaryColor", "backgroundColor", "fontFamily"]
    assert "Sample scene" in muted_body["html"]
    assert "data:audio/mpeg;base64," not in muted_body["html"]

    audible = await services_client.get(
        f"/api/video/series/{series['id']}/style/sample",
        headers=_auth_headers(),
    )
    assert audible.status == 200
    audible_html = (await audible.json())["html"]
    assert "data:audio/mpeg;base64," + base64.b64encode(audio).decode("ascii") in audible_html

    stale = await services_client.post(
        f"/api/video/series/{series['id']}/style/sample",
        headers=_auth_headers(),
        json={"projectName": "sample-project", "revision": 0},
    )
    assert stale.status == 409
    assert (project / "style" / "design-system.json").is_file()
    assert json.loads(meta_path.read_text(encoding="utf-8"))["requirePlanApproval"] is False


async def test_seed_version_restores_saved_sample_into_existing_project(
    services_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    series = create_series(tmp_path, "seed-style", "Seed Style", template_id="huashu-ui-space")
    saved_scene = _create_saved_sample_version(tmp_path, series)
    project = tmp_path / "video_projects" / "seed-project"
    (project / "style").mkdir(parents=True)
    (project / "scene_sources").mkdir()
    (project / "scene_sources" / "scene_01.tsx").write_text("old source", encoding="utf-8")
    (project / "scene_sources" / "scene_02.tsx").write_text("stale source", encoding="utf-8")
    (project / "scenes").mkdir()
    (project / "scenes" / "scene_01.html").write_text("old scene", encoding="utf-8")
    (project / "audio").mkdir()
    (project / "audio" / "scene_02.mp3").write_bytes(b"stale audio")
    (project / "assets").mkdir()
    _write_json(project / "assets" / "manifest.json", {"schemaVersion": 1, "assets": []})
    _write_json(project / "meta.json", {
        "name": "seed-project",
        "projectKey": "preserve-project-key",
        "resolution": "1280x720",
        "scenes": [],
    })
    (project / ".chat_id").write_text("preserve-chat", encoding="utf-8")

    from mona import video_authoring
    from mona.api import video_director

    def refresh(stage_project, scene, _meta):
        assert (stage_project / "scene_sources" / "scene_01.tsx").read_bytes() == b"export const Scene = () => <div>saved</div>;"
        (stage_project / "scenes" / "scene_01.html").write_text("refreshed with current draft", encoding="utf-8")
        return True

    async def capture(stage_project, _scene, _meta):
        preview_dir = stage_project / "renders" / "previews" / "scene_01"
        preview_dir.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (2, 2), (18, 52, 86)).save(preview_dir / "sample_0.png", format="PNG")
        Image.new("RGB", (2, 2), (30, 20, 10)).save(preview_dir / "sample_1.png", format="PNG")
        Image.new("RGB", (2, 2), (10, 20, 30)).save(preview_dir / "motion-review.png", format="PNG")
        return {"motionReviewUpdated": True, "motionReview": {"distinctVisualStates": 2}}

    monkeypatch.setattr(video_authoring, "refresh_authored_scene", refresh)
    monkeypatch.setattr(video_director, "_capture_frames", capture)
    response = await services_client.post(
        f"/api/video/series/{series['id']}/style/sample",
        headers=_auth_headers(),
        json={"projectName": "seed-project", "revision": 0, "seedVersion": 1},
    )
    assert response.status == 200
    body = await response.json()
    assert body["seeded"] is True
    assert body["refreshed"] is True
    assert (project / "scene_sources" / "scene_01.tsx").read_bytes() == b"export const Scene = () => <div>saved</div>;"
    assert not (project / "scene_sources" / "scene_02.tsx").exists()
    assert not (project / "audio" / "scene_02.mp3").exists()
    assert (project / "audio" / "scene_01.mp3").read_bytes() == b"saved voice"
    assert (project / "style" / "authoring" / "sample.json").is_file()
    assert (project / "style" / "authoring" / "assets" / "manifest.json").is_file()
    assert (project / "style" / "theme.css").read_bytes() == b"body { color: #123456; }"
    assert (project / "assets" / "style-sample" / "saved-background.webp").is_file()
    project_assets = json.loads((project / "assets" / "manifest.json").read_text(encoding="utf-8"))["assets"]
    assert next(asset for asset in project_assets if asset["id"] == "saved-background")["path"] == "assets/style-sample/saved-background.webp"
    assert (project / "scenes" / "scene_01.html").read_text(encoding="utf-8") == "refreshed with current draft"
    assert (project / ".chat_id").read_text(encoding="utf-8") == "preserve-chat"
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert meta["name"] == "seed-project"
    assert meta["projectKey"] == "preserve-project-key"
    assert meta["resolution"] == "640x360"
    assert meta["subtitleMode"] == "external"
    assert meta["scenes"][0]["narration"] == saved_scene["narration"]
    assert meta["styleAuthoring"]["seedVersion"] == 1


async def test_seed_version_skips_legacy_snapshot_and_rejects_binding_conflict(
    services_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    legacy = create_series(tmp_path, "legacy-seed", "Legacy Seed", template_id="huashu-ui-space")
    legacy_version = series_directory(tmp_path) / legacy["id"] / "styles" / "v1"
    style = get_builtin_template("huashu-ui-space")
    style.update({"seriesId": legacy["id"], "version": 1})
    _write_json(legacy_version / "design-system.json", style)
    legacy_project = tmp_path / "video_projects" / "legacy-project"
    (legacy_project / "scene_sources").mkdir(parents=True)
    old_source = legacy_project / "scene_sources" / "scene_01.tsx"
    old_source.write_text("keep legacy source", encoding="utf-8")
    _write_json(legacy_project / "meta.json", {"name": "legacy-project", "scenes": []})
    skipped = await services_client.post(
        f"/api/video/series/{legacy['id']}/style/sample",
        headers=_auth_headers(),
        json={"projectName": "legacy-project", "revision": 0, "seedVersion": 1},
    )
    assert skipped.status == 200
    assert (await skipped.json())["seeded"] is False
    assert old_source.read_text(encoding="utf-8") == "keep legacy source"

    conflicting = create_series(tmp_path, "conflict-seed", "Conflict Seed", template_id="huashu-ui-space")
    _create_saved_sample_version(tmp_path, conflicting)
    conflict_project = tmp_path / "video_projects" / "conflict-project"
    conflict_project.mkdir(parents=True)
    marker = conflict_project / "protected.txt"
    marker.write_text("keep conflict source", encoding="utf-8")
    _write_json(conflict_project / "meta.json", {
        "name": "conflict-project",
        "styleAuthoring": {"seriesId": "another-series"},
        "scenes": [],
    })
    rejected = await services_client.post(
        f"/api/video/series/{conflicting['id']}/style/sample",
        headers=_auth_headers(),
        json={"projectName": "conflict-project", "revision": 0, "seedVersion": 1},
    )
    assert rejected.status == 409
    assert (await rejected.json())["error"] == "STYLE_SAMPLE_BINDING_CONFLICT"
    assert marker.read_text(encoding="utf-8") == "keep conflict source"
    assert read_style_draft(tmp_path, conflicting["id"])["revision"] == 0

    tampered = create_series(tmp_path, "tampered-seed", "Tampered Seed", template_id="huashu-ui-space")
    _create_saved_sample_version(tmp_path, tampered)
    source_path = (
        series_directory(tmp_path) / tampered["id"] / "styles" / "v1"
        / "authoring" / "scene_sources" / "scene_01.tsx"
    )
    source_path.write_text("changed after snapshot", encoding="utf-8")
    protected_project = tmp_path / "video_projects" / "tampered-project"
    protected_project.mkdir(parents=True)
    protected_source = protected_project / "source-marker.txt"
    protected_source.write_text("keep tampered target", encoding="utf-8")
    _write_json(protected_project / "meta.json", {"name": "tampered-project", "scenes": []})
    invalid = await services_client.post(
        f"/api/video/series/{tampered['id']}/style/sample",
        headers=_auth_headers(),
        json={"projectName": "tampered-project", "revision": 0, "seedVersion": 1},
    )
    assert invalid.status == 400
    assert (await invalid.json())["error"] == "STYLE_SAMPLE_SNAPSHOT_INVALID"
    assert protected_source.read_text(encoding="utf-8") == "keep tampered target"
    assert read_style_draft(tmp_path, tampered["id"])["revision"] == 0


async def test_refresh_rebuilds_scene_and_motion_review_without_tts(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    series, project, draft, scene_html, old_frame = await _create_refresh_sample(tmp_path, monkeypatch)
    from mona import video_authoring
    from mona.api import server, video_director

    async def capture(stage_project, scene, _meta):
        assert stage_project != project
        color = tuple(int(draft["tokens"]["colors"]["primary"][index:index + 2], 16) for index in (1, 3, 5))
        frames = stage_project / "renders" / "previews" / "scene_01"
        frames.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (2, 2), color).save(frames / "sample_0.png", format="PNG")
        Image.new("RGB", (2, 2), color).save(frames / "sample_1.png", format="PNG")
        Image.new("RGB", (2, 2), color).save(frames / "motion-review.png", format="PNG")
        return {"motionReviewUpdated": True, "motionReview": {"distinctVisualStates": 2}}

    def refresh(stage_project, scene, _meta):
        style = json.loads((stage_project / "style" / "design-system.json").read_text(encoding="utf-8"))
        color = style["tokens"]["colors"]["primary"]
        (stage_project / "scenes" / "scene_01.html").write_text(f"new sample {color}", encoding="utf-8")
        return True

    monkeypatch.setattr(video_authoring, "refresh_authored_scene", refresh)
    monkeypatch.setattr(video_director, "_capture_frames", capture)
    tts = AsyncMock(side_effect=AssertionError("refresh must not request TTS"))
    monkeypatch.setattr(server, "_synthesize_scene_narration", tts)

    response = await video_series.handle_video_style_sample_bind(
        _request({
            "projectName": "refresh-project",
            "revision": draft["revision"],
            "refresh": True,
        }, series["id"])
    )
    assert response.status == 200
    assert json.loads(response.body)["refreshed"] is True
    assert scene_html.read_text(encoding="utf-8") == "new sample #123456"
    with Image.open(old_frame) as frame:
        assert frame.getpixel((0, 0)) == (18, 52, 86)
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    scene = meta["scenes"][0]
    assert scene["motionReview"] == {"distinctVisualStates": 2}
    assert scene["motionReviewSourceHash"] == scene["sourceHash"]
    tts.assert_not_awaited()


async def test_refresh_failure_preserves_previous_sample_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    series, _project, draft, scene_html, old_frame = await _create_refresh_sample(tmp_path, monkeypatch)
    from mona import video_authoring
    from mona.api import video_director

    def refresh(stage_project, _scene, _meta):
        (stage_project / "scenes" / "scene_01.html").write_text("partial replacement", encoding="utf-8")
        return True

    async def fail_capture(*_args):
        raise RuntimeError("capture failed")

    monkeypatch.setattr(video_authoring, "refresh_authored_scene", refresh)
    monkeypatch.setattr(video_director, "_capture_frames", fail_capture)
    before_html = scene_html.read_bytes()
    before_frame = old_frame.read_bytes()
    response = await video_series.handle_video_style_sample_bind(
        _request({
            "projectName": "refresh-project",
            "revision": draft["revision"],
            "refresh": True,
        }, series["id"])
    )
    assert response.status == 503
    assert json.loads(response.body)["error"] == "STYLE_SAMPLE_REFRESH_FAILED"
    assert scene_html.read_bytes() == before_html
    assert old_frame.read_bytes() == before_frame


async def test_cancelled_refresh_preserves_previous_sample_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    series, _project, draft, scene_html, old_frame = await _create_refresh_sample(tmp_path, monkeypatch)
    from mona import video_authoring
    from mona.api import video_director

    monkeypatch.setattr(video_authoring, "refresh_authored_scene", lambda *_args: True)

    async def cancel_capture(*_args):
        raise asyncio.CancelledError

    monkeypatch.setattr(video_director, "_capture_frames", cancel_capture)
    before_html = scene_html.read_bytes()
    before_frame = old_frame.read_bytes()
    with pytest.raises(asyncio.CancelledError):
        await video_series.handle_video_style_sample_bind(
            _request({
                "projectName": "refresh-project",
                "revision": draft["revision"],
                "refresh": True,
            }, series["id"])
        )
    assert scene_html.read_bytes() == before_html
    assert old_frame.read_bytes() == before_frame


async def test_saved_sample_media_urls_are_scoped_to_authoring_snapshots(
    services_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    series = create_series(tmp_path, "saved-style", "Saved Style", template_id="huashu-ui-space")
    version = series_directory(tmp_path) / series["id"] / "styles" / "v1"
    authoring = version / "authoring" / "previews"
    authoring.mkdir(parents=True)
    design = {
        "version": 1,
        "tokens": {"colors": {"primary": "#123456"}},
        "backgrounds": {"default": {}},
        "aspectVariants": {},
        "authoring": {
            "samplePath": "authoring/sample.json",
            "poster": "authoring/previews/poster.png",
            "motion": "authoring/previews/motion.gif",
        },
    }
    _write_json(version / "design-system.json", design)
    snapshot_root = version / "authoring"
    _write_json(snapshot_root / "sample.json", {
        "schemaVersion": 1,
        "resolution": "640x360",
        "narrationEnabled": True,
        "scenes": [{
            "index": 1, "duration": 3, "narration": "captured voice",
            "authored": True, "authoredRuntime": "remotion",
            "sourcePath": "scene_sources/scene_01.tsx",
        }],
    })
    (snapshot_root / "scenes").mkdir(parents=True)
    (snapshot_root / "scenes" / "scene_01.html").write_text(
        "<!doctype html><html><body><main>Saved sample</main></body></html>",
        encoding="utf-8",
    )
    (snapshot_root / "scene_sources").mkdir()
    (snapshot_root / "scene_sources" / "scene_01.tsx").write_text(
        "var(--mona-primary) var(--mona-body-family)", encoding="utf-8"
    )
    snapshot_audio = b"captured voice track"
    (snapshot_root / "audio").mkdir()
    (snapshot_root / "audio" / "scene_01.mp3").write_bytes(snapshot_audio)
    Image.new("RGB", (2, 2), (10, 20, 30)).save(authoring / "poster.png", format="PNG")
    Image.new("RGB", (2, 2), (30, 20, 10)).save(authoring / "motion.gif", format="GIF")

    saved_sample = await services_client.get(
        f"/api/video/series/{series['id']}/style/sample?version=1",
        headers=_auth_headers(),
    )
    assert saved_sample.status == 200
    saved_body = await saved_sample.json()
    assert saved_body["revision"] == 1
    assert saved_body["duration"] == 3
    assert saved_body["editableFields"] == ["primaryColor", "fontFamily"]
    assert "Saved sample" in saved_body["html"]
    assert "data:audio/mpeg;base64," + base64.b64encode(snapshot_audio).decode("ascii") in saved_body["html"]

    poster = await services_client.get(
        f"/api/video/series/{series['id']}/styles/1/preview?kind=poster",
        headers=_auth_headers(),
    )
    assert poster.status == 200
    assert poster.headers["Content-Type"].startswith("image/png")
    assert (await poster.read()).startswith(b"\x89PNG")

    motion = await services_client.get(
        f"/api/video/series/{series['id']}/styles/1/preview?kind=motion",
        headers=_auth_headers(),
    )
    assert motion.status == 200
    assert motion.headers["Content-Type"].startswith("image/gif")
    assert (await motion.read()).startswith(b"GIF")

    invalid = await services_client.get(
        f"/api/video/series/{series['id']}/styles/1/preview?kind=rules",
        headers=_auth_headers(),
    )
    assert invalid.status == 400


async def test_reference_preview_get_requires_token_and_serves_uploaded_image(
    services_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    series = create_series(tmp_path, "reference-preview", "Reference Preview", template_id="huashu-ui-space")
    reference = tmp_path / "uploads" / "chat-1" / "reference.png"
    reference.parent.mkdir(parents=True)
    Image.new("RGB", (4, 3), (12, 34, 56)).save(reference, format="PNG")
    save_style_draft(
        tmp_path,
        series["id"],
        {"authoring": {"referencePaths": [str(reference)]}},
        expected_revision=0,
    )
    url = f"/api/video/series/{series['id']}/style/reference?index=0"

    denied = await services_client.get(url)
    assert denied.status == 401

    response = await services_client.get(url, headers=_auth_headers())
    assert response.status == 200
    assert response.headers["Content-Type"].startswith("image/png")
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert await response.read() == reference.read_bytes()


async def test_reference_preview_rejects_paths_outside_uploads(
    services_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    series = create_series(tmp_path, "reference-path", "Reference Path", template_id="huashu-ui-space")
    outside = tmp_path / "private.png"
    Image.new("RGB", (2, 2), (1, 2, 3)).save(outside, format="PNG")
    uploads = tmp_path / "uploads" / "chat-1"
    uploads.mkdir(parents=True)
    escaped_link = uploads / "escaped.png"
    try:
        escaped_link.symlink_to(outside)
    except OSError:
        escaped_link = None
    paths = [str(outside), str(tmp_path / "uploads" / ".." / "private.png")]
    if escaped_link is not None:
        paths.append(str(escaped_link))
    save_style_draft(
        tmp_path,
        series["id"],
        {"authoring": {"referencePaths": paths}},
        expected_revision=0,
    )

    for index in range(len(paths)):
        response = await services_client.get(
            f"/api/video/series/{series['id']}/style/reference?index={index}",
            headers=_auth_headers(),
        )
        assert response.status == 404
        assert (await response.json())["error"] == "STYLE_REFERENCE_PATH_INVALID"


async def test_reference_preview_rejects_invalid_image_bytes(
    services_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    series = create_series(tmp_path, "reference-image", "Reference Image", template_id="huashu-ui-space")
    reference = tmp_path / "uploads" / "chat-1" / "reference.png"
    reference.parent.mkdir(parents=True)
    reference.write_bytes(b"not an image")
    save_style_draft(
        tmp_path,
        series["id"],
        {"authoring": {"referencePaths": [str(reference)]}},
        expected_revision=0,
    )

    response = await services_client.get(
        f"/api/video/series/{series['id']}/style/reference?index=0",
        headers=_auth_headers(),
    )
    assert response.status == 422
    assert (await response.json())["error"] == "STYLE_REFERENCE_INVALID"


async def test_copy_creates_independent_v1_style_and_sample_snapshot(
    services_client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    source = create_series(tmp_path, "copy-source", "Source Style", template_id="huashu-ui-space")
    source_version = series_directory(tmp_path) / source["id"] / "styles" / "v1"
    source_assets = source_version / "assets"
    source_assets.mkdir(parents=True)
    style = get_builtin_template("huashu-ui-space")
    style.update({"seriesId": source["id"], "version": 1, "lockedAt": "source-lock"})
    style["backgrounds"]["default"]["assetId"] = "copy-bg"
    style["chatId"] = "old-chat"
    style["authoring"] = {
        "projectName": "old-sample-project",
        "chatId": "old-chat",
        "description": "纸张质感",
        "rules": "保留纸张纹理",
        "samplePath": "authoring/sample.json",
        "poster": "authoring/previews/poster.png",
        "motion": "authoring/previews/motion.gif",
        "captureHash": "old-capture",
    }
    _write_json(source_version / "design-system.json", style)
    sample_bytes = json.dumps({"scenes": [{"index": 1}]}, ensure_ascii=False).encode("utf-8")
    (source_version / "authoring" / "scenes").mkdir(parents=True)
    (source_version / "authoring" / "scenes" / "scene_01.html").write_text("captured scene", encoding="utf-8")
    (source_version / "authoring" / "scene_sources").mkdir()
    (source_version / "authoring" / "scene_sources" / "scene_01.tsx").write_text("captured source", encoding="utf-8")
    (source_version / "authoring" / "sample.json").write_bytes(sample_bytes)
    Image.new("RGB", (8, 8), (18, 52, 86)).save(source_assets / "copy-bg.webp", format="WEBP")
    _write_json(source_assets / "copy-bg.json", {"assetId": "copy-bg", "path": "assets/copy-bg.webp"})
    source_series_path = series_directory(tmp_path) / source["id"] / "series.json"
    source_series = json.loads(source_series_path.read_text(encoding="utf-8"))
    source_series["latestStyleVersion"] = 1
    _write_json(source_series_path, source_series)
    original_design = (source_version / "design-system.json").read_bytes()
    original_asset = (source_assets / "copy-bg.webp").read_bytes()

    copied = await services_client.post(
        f"/api/video/series/{source['id']}/copy",
        headers=_auth_headers(),
        json={"name": "Copied Style"},
    )
    assert copied.status == 201
    result = await copied.json()
    copied_id = result["series"]["id"]
    assert copied_id != source["id"]
    assert result["series"]["name"] == "Copied Style"
    assert result["series"]["latestStyleVersion"] == 1
    assert result["draft"]["revision"] == 0
    assert "projectName" not in result["draft"].get("authoring", {})
    assert "chatId" not in result["draft"].get("authoring", {})

    copied_version = series_directory(tmp_path) / copied_id / "styles" / "v1"
    copied_style = json.loads((copied_version / "design-system.json").read_text(encoding="utf-8"))
    assert copied_style["seriesId"] == copied_id
    assert copied_style["version"] == 1
    assert "projectName" not in copied_style["authoring"]
    assert "chatId" not in copied_style["authoring"]
    assert (copied_version / "authoring" / "sample.json").read_bytes() == sample_bytes
    assert (copied_version / "assets" / "copy-bg.webp").read_bytes() == original_asset
    assert (series_directory(tmp_path) / copied_id / "draft" / "assets" / "copy-bg.webp").read_bytes() == original_asset
    assert (source_version / "design-system.json").read_bytes() == original_design
    assert (source_assets / "copy-bg.webp").read_bytes() == original_asset


def test_series_summary_adds_preview_only_for_sampled_style_versions(
    monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    monkeypatch.setattr(video_series, "_root", lambda: tmp_path)
    monkeypatch.setattr(video_series, "_referencing_projects", lambda _series_id: [])
    series = create_series(tmp_path, "summary-style", "Summary Style", template_id="huashu-ui-space")
    version = series_directory(tmp_path) / series["id"] / "styles" / "v1"
    version.mkdir(parents=True)
    _write_json(version / "design-system.json", {
        "version": 1,
        "tokens": {"colors": {"primary": "#123456"}},
        "backgrounds": {"default": {}},
        "aspectVariants": {},
        "authoring": {
            "samplePath": "authoring/sample.json",
            "poster": "authoring/previews/poster.png",
            "motion": "authoring/previews/motion.gif",
        },
    })
    series_path = series_directory(tmp_path) / series["id"] / "series.json"
    metadata = json.loads(series_path.read_text(encoding="utf-8"))
    metadata["latestStyleVersion"] = 1
    _write_json(series_path, metadata)

    summary = video_series._series_summary(metadata)
    assert summary["styleSummary"]["preview"] == {
        "poster": f"/api/video/series/{series['id']}/styles/1/preview?kind=poster",
        "motion": f"/api/video/series/{series['id']}/styles/1/preview?kind=motion",
    }

    legacy = create_series(tmp_path, "legacy-style", "Legacy Style", template_id="huashu-ui-space")
    legacy_version = series_directory(tmp_path) / legacy["id"] / "styles" / "v1"
    legacy_version.mkdir(parents=True)
    _write_json(legacy_version / "design-system.json", {
        "version": 1,
        "tokens": {"colors": {"primary": "#123456"}},
        "backgrounds": {"default": {}},
        "aspectVariants": {},
    })
    legacy_path = series_directory(tmp_path) / legacy["id"] / "series.json"
    legacy_metadata = json.loads(legacy_path.read_text(encoding="utf-8"))
    legacy_metadata["latestStyleVersion"] = 1
    _write_json(legacy_path, legacy_metadata)
    assert "preview" not in video_series._series_summary(legacy_metadata)["styleSummary"]

