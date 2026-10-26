"""Video project workflow tests: phase lifecycle, confirmation binding,
unified invalidation, export gating, and render status contract."""

import asyncio
import base64
import importlib.util
import json
import os
import types
import wave
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

import mona.agent  # noqa: F401  (import first to break the api<->agent import cycle)
import mona.api.server as server


def _make_project(tmp_path: Path, name: str = "proj") -> Path:
    project_dir = tmp_path / "video_projects" / name
    for sub in ("scenes", "renders"):
        (project_dir / sub).mkdir(parents=True, exist_ok=True)
    return project_dir


def _patch_projects_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        server, "_video_projects_dir", lambda: tmp_path / "video_projects"
    )
    monkeypatch.setattr(
        server,
        "_video_archived_projects_dir",
        lambda: tmp_path / "video_projects_archived",
    )


def _write_meta(project_dir: Path, meta: dict) -> None:
    (project_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False), encoding="utf-8"
    )


def _read_meta(project_dir: Path) -> dict:
    return json.loads((project_dir / "meta.json").read_text(encoding="utf-8"))


def _post_request(body: dict) -> MagicMock:
    request = MagicMock()
    request.json = AsyncMock(return_value=body)
    return request


def _body(response) -> dict:
    return json.loads(response.body)


def _confirmed_scene(project_dir: Path, index: int) -> dict:
    """Create a scene HTML file on disk and return a confirmed scene dict
    whose confirmedMtime matches the file version."""
    scene_path = project_dir / "scenes" / f"scene_{index:02d}.html"
    scene_path.write_text(f"<html>scene {index}</html>", encoding="utf-8")
    return {
        "index": index,
        "title": f"场景 {index}",
        "htmlStatus": "confirmed",
        "htmlPath": f"scenes/scene_{index:02d}.html",
        "confirmedAt": "2026-08-05T00:00:00",
        "confirmedMtime": scene_path.stat().st_mtime,
    }


# --- project creation -------------------------------------------------------


async def test_create_project_copies_sources_without_requiring_outline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    source = tmp_path / "brief.md"
    source.write_text("# 原始资料\n\n保留第一章，删除第二章。", encoding="utf-8")
    response = await server.handle_video_project_create(
        _post_request(
            {
                "name": "planned",
                "resolution": "1920x1080",
                "sourcePaths": [str(source)],
            }
        )
    )

    assert response.status == 200
    project = tmp_path / "video_projects" / "planned"
    meta = _read_meta(project)
    assert meta["sourceCount"] == 1
    assert not (project / "outline.json").exists()
    assert not meta.get("outlineLocked")
    assert (project / "sources" / "source-01.md").read_text(encoding="utf-8") == source.read_text(encoding="utf-8")
    source_manifest = json.loads(
        (project / "sources" / "manifest.json").read_text(encoding="utf-8")
    )
    assert source_manifest["sources"][0]["originalName"] == "brief.md"
    assert str(tmp_path) not in json.dumps(source_manifest, ensure_ascii=False)


async def test_create_project_starts_in_storyboard_phase(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    response = await server.handle_video_project_create(
        _post_request({"name": "demo", "resolution": "1920x1080"})
    )
    assert response.status == 200
    meta = _read_meta(tmp_path / "video_projects" / "demo")
    assert meta["phase"] == "storyboard"
    assert meta["outputStale"] is False
    assert meta["structuredCompiler"] is False
    assert meta["authoringMode"] == "huashu-motion"
    assert meta["requirePlanApproval"] is True
    assert meta["planRevision"] == 0
    assert meta["approvedPlanRevision"] is None
    assert (
        tmp_path
        / "video_projects"
        / "demo"
        / "style"
        / "design-system.json"
    ).is_file()


async def test_create_project_never_stores_tts_api_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    response = await server.handle_video_project_create(
        _post_request(
            {
                "name": "demo",
                "narrationEnabled": True,
                "ttsProvider": "edge",
                "ttsVoice": "zh-CN-XiaoyiNeural",
                "ttsApiKey": "should-not-be-persisted",
            }
        )
    )
    assert response.status == 200
    meta = _read_meta(tmp_path / "video_projects" / "demo")
    assert meta["narrationEnabled"] is True
    assert not any("apikey" in key.lower() for key in meta)


async def test_project_music_is_registered_and_enters_commercial_rights_gate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    music = tmp_path / "music.wav"
    with wave.open(str(music), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(8_000)
        stream.writeframes(b"\x00\x00" * 800)

    response = await server.handle_video_project_create(
        _post_request(
            {
                "name": "music-project",
                "music": {
                    "preset": "ambient",
                    "filePath": str(music),
                    "sourceType": "user-upload",
                    "rightsStatus": "unknown",
                },
            }
        )
    )

    assert response.status == 200
    project = tmp_path / "video_projects" / "music-project"
    meta = server._load_video_meta(project)
    assert meta["musicPreset"] == "ambient"
    assert meta["musicAssetId"]
    preflight = server._video_asset_preflight(
        project, [], [meta["musicAssetId"]]
    )
    assert preflight["readyForCommercialUse"] is False
    assert preflight["unconfirmedAssets"][0]["assetId"] == meta["musicAssetId"]


async def test_create_duplicate_project_returns_409(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    _make_project(tmp_path, "demo")
    response = await server.handle_video_project_create(
        _post_request({"name": "demo"})
    )
    assert response.status == 409


async def test_project_rename_copy_archive_and_restore_are_recoverable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    created = await server.handle_video_project_create(
        _post_request({"name": "original", "resolution": "1920x1080"})
    )
    assert created.status == 200
    original = tmp_path / "video_projects" / "original"
    (original / "storyboard.md").write_text(
        "# Storyboard\n\n### Scene 1: 内容\n- Duration: 3s\n", encoding="utf-8"
    )
    (original / "renders" / "output.mp4").write_bytes(b"old-video")

    renamed = await server.handle_video_project_rename(
        _post_request({"name": "original", "newName": "renamed"})
    )
    assert renamed.status == 200
    renamed_dir = tmp_path / "video_projects" / "renamed"
    assert renamed_dir.is_dir() and not original.exists()
    assert server._load_video_meta(renamed_dir)["name"] == "renamed"

    copied = await server.handle_video_project_copy(
        _post_request({"name": "renamed", "newName": "renamed-copy"})
    )
    assert copied.status == 200
    copied_dir = tmp_path / "video_projects" / "renamed-copy"
    assert (copied_dir / "storyboard.md").is_file()
    assert (copied_dir / "style" / "design-system.json").is_file()
    assert not (copied_dir / "renders" / "output.mp4").exists()
    assert server._load_video_meta(copied_dir)["copiedFrom"] == "renamed"

    archived = await server.handle_video_project_archive(
        _post_request({"name": "renamed", "archived": True})
    )
    assert archived.status == 200
    archived_dir = tmp_path / "video_projects_archived" / "renamed"
    assert archived_dir.is_dir() and not renamed_dir.exists()

    list_request = MagicMock()
    list_request.query = {"includeArchived": "true"}
    listed = _body(await server.handle_video_projects(list_request))["projects"]
    archived_item = next(item for item in listed if item["name"] == "renamed")
    assert archived_item["archived"] is True

    restored = await server.handle_video_project_archive(
        _post_request({"name": "renamed", "archived": False})
    )
    assert restored.status == 200
    assert renamed_dir.is_dir() and not archived_dir.exists()


# --- phase normalization for legacy projects ---------------------------------


def test_normalize_legacy_project_defaults_to_storyboard(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    meta = server._normalize_video_meta(project_dir, {})
    assert meta["phase"] == "storyboard"
    assert meta["outputStale"] is False
    assert meta["hasVideo"] is False


def test_normalize_legacy_locked_storyboard_is_producing(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    meta = server._normalize_video_meta(project_dir, {"storyboardLocked": True})
    assert meta["phase"] == "producing"


def test_normalize_legacy_all_confirmed_is_exportable(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    scene = _confirmed_scene(project_dir, 1)
    meta = server._normalize_video_meta(project_dir, {"scenes": [scene]})
    assert meta["phase"] == "exportable"


def test_normalize_legacy_with_output_is_done(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    (project_dir / "renders" / "output.mp4").write_bytes(b"mp4")
    meta = server._normalize_video_meta(project_dir, {})
    assert meta["phase"] == "done"
    assert meta["hasVideo"] is True


def test_normalize_legacy_rendering_state(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    (project_dir / ".render_status.json").write_text(
        json.dumps({"stage": "rendering", "progress": 40}), encoding="utf-8"
    )
    meta = server._normalize_video_meta(project_dir, {})
    assert meta["phase"] == "rendering"


# --- export gating (P3: ready-based, snapshot export) -------------------------


async def test_export_rejected_when_scene_html_not_generated(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    _write_meta(
        project_dir,
        {"phase": "producing", "scenes": [{"index": 1, "htmlStatus": "pending"}]},
    )
    response = await server.handle_video_project_export(
        _post_request({"name": "proj", "quality": "standard"})
    )
    assert response.status == 409
    assert _body(response)["error"] == "SCENES_NOT_READY"


async def test_export_rejected_when_scene_file_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # htmlStatus says previewing but the HTML file is gone → not ready.
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    _write_meta(
        project_dir,
        {"phase": "producing", "scenes": [{"index": 1, "htmlStatus": "previewing"}]},
    )
    response = await server.handle_video_project_export(
        _post_request({"name": "proj", "quality": "standard"})
    )
    assert response.status == 409
    assert _body(response)["error"] == "SCENES_NOT_READY"


async def test_export_allowed_when_previewing_not_confirmed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """P3: scenes need HTML generated (ready), not per-scene confirmation."""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    (project_dir / "scenes" / "scene_01.html").write_text(
        "<html>scene 1</html>", encoding="utf-8"
    )
    _write_meta(
        project_dir,
        {"phase": "producing", "scenes": [{"index": 1, "htmlStatus": "previewing"}]},
    )

    async def _fake_render(*args, **kwargs) -> None:
        return None

    monkeypatch.setattr(server, "_run_render_task", _fake_render)
    response = await server.handle_video_project_export(
        _post_request({"name": "proj", "quality": "standard"})
    )
    assert response.status == 200
    assert _body(response)["ok"] is True
    meta = _read_meta(project_dir)
    assert meta["phase"] == "rendering"


# --- unified invalidation ------------------------------------------------------


def _setup_confirmed_project(tmp_path: Path) -> Path:
    """Two confirmed scenes + an exported MP4, phase=exportable."""
    project_dir = _make_project(tmp_path)
    scenes = [_confirmed_scene(project_dir, 1), _confirmed_scene(project_dir, 2)]
    (project_dir / "renders" / "output.mp4").write_bytes(b"mp4")
    _write_meta(
        project_dir,
        {
            "phase": "exportable",
            "hasVideo": True,
            "outputStale": False,
            "scenes": scenes,
        },
    )
    return project_dir


async def test_scene_update_invalidates_only_target_scene(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "_sync_storyboard", lambda *a, **k: None)
    project_dir = _setup_confirmed_project(tmp_path)
    response = await server.handle_video_project_scene_update(
        _post_request({"name": "proj", "index": 1, "title": "新标题"})
    )
    assert response.status == 200
    meta = _read_meta(project_dir)
    scene1, scene2 = meta["scenes"]
    assert scene1["htmlStatus"] == "pending"
    assert "confirmedMtime" not in scene1
    assert scene2["htmlStatus"] == "confirmed"
    assert "confirmedMtime" in scene2
    assert meta["phase"] == "storyboard"
    assert meta["requirePlanApproval"] is True
    assert meta["planRevision"] == 1
    assert meta["outputStale"] is True


async def test_scene_delete_invalidates_all_scenes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "_sync_storyboard", lambda *a, **k: None)
    project_dir = _setup_confirmed_project(tmp_path)
    request = MagicMock()
    request.query = {"name": "proj", "index": "1"}
    response = await server.handle_video_project_scene_delete(request)
    assert response.status == 200
    meta = _read_meta(project_dir)
    assert len(meta["scenes"]) == 1
    assert meta["scenes"][0]["htmlStatus"] == "pending"
    assert "confirmedMtime" not in meta["scenes"][0]
    assert meta["phase"] == "storyboard"
    assert meta["outputStale"] is True


async def test_scene_add_keeps_existing_scene_previews(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "_sync_storyboard", lambda *a, **k: None)
    project_dir = _setup_confirmed_project(tmp_path)
    response = await server.handle_video_project_scene_add(
        _post_request({"name": "proj", "title": "新场景"})
    )
    assert response.status == 200
    meta = _read_meta(project_dir)
    assert len(meta["scenes"]) == 3
    assert all(s["htmlStatus"] == "confirmed" for s in meta["scenes"][:2])
    assert all("confirmedMtime" in s for s in meta["scenes"][:2])
    assert meta["scenes"][2]["htmlStatus"] == "pending"
    assert meta["phase"] == "storyboard"
    assert meta["outputStale"] is True


async def test_scene_reorder_invalidates_all_scenes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "_sync_storyboard", lambda *a, **k: None)
    project_dir = _setup_confirmed_project(tmp_path)
    response = await server.handle_video_project_scene_reorder(
        _post_request({"name": "proj", "indices": [2, 1]})
    )
    assert response.status == 200
    meta = _read_meta(project_dir)
    assert [s["index"] for s in meta["scenes"]] == [1, 2]
    assert all(s["htmlStatus"] == "pending" for s in meta["scenes"])
    assert meta["phase"] == "storyboard"
    assert meta["outputStale"] is True


# --- render task phase transitions ---------------------------------------------


class _FakeRenderLoader:
    def __init__(self, result: dict, calls: list | None = None) -> None:
        self._result = result
        self._calls = calls

    def create_module(self, spec) -> types.ModuleType:
        return types.ModuleType(spec.name)

    def exec_module(self, module: types.ModuleType) -> None:
        result = self._result
        calls = self._calls

        def _render_project(*args, **kwargs):
            if calls is not None:
                calls.append({"args": args, "kwargs": kwargs})
            if result.get("ok"):
                output = Path(args[0]) / result.get("output", "renders/output.mp4")
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(b"rendered-video-fixture")
            return result

        module.render_project = _render_project


class _FakeRenderSpec:
    def __init__(self, result: dict, calls: list | None = None) -> None:
        self.name = "render"
        self.loader = _FakeRenderLoader(result, calls)
        self.origin = None
        self.parent = None
        self.submodule_search_locations = None
        self.has_location = False


def _patch_render_module(
    monkeypatch: pytest.MonkeyPatch, result: dict, calls: list | None = None
) -> None:
    original = importlib.util.spec_from_file_location
    monkeypatch.setattr(
        importlib.util,
        "spec_from_file_location",
        lambda name, path, **kwargs: _FakeRenderSpec(result, calls)
        if name == "render" else original(name, path, **kwargs),
    )
    monkeypatch.setattr(server, "_validate_rendered_video", AsyncMock())


def _isolate_project_audio_mix(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    """Keep non-media render-task tests outside the real FFmpeg mix boundary.

    Real narration mixing and media validation are covered by
    tests/test_video_audio_render.py; these workflow tests use fake TTS bytes
    and fake rendered video, so they must not pass those fixtures to FFmpeg.
    """
    mixer = AsyncMock()
    monkeypatch.setattr(server, "_mix_project_audio", mixer)
    return mixer


async def test_render_task_success_marks_project_done(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["phase"] = "rendering"
    meta["outputStale"] = True
    _write_meta(project_dir, meta)
    _patch_render_module(
        monkeypatch,
        {
            "ok": True,
            "output": "renders/output.mp4",
            "duration": 12.0,
            "fps": 30,
            "resolution": "1920x1080",
            "total_frames": 360,
            "audio": True,
        },
    )
    await server._run_render_task(project_dir, 0, "standard")
    meta = _read_meta(project_dir)
    assert meta["phase"] == "done"
    assert meta["hasVideo"] is True
    assert meta["outputStale"] is False
    status = json.loads(
        (project_dir / ".render_status.json").read_text(encoding="utf-8")
    )
    assert status["stage"] == "done"
    assert status["progress"] == 100


async def test_render_task_failure_restores_exportable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["phase"] = "rendering"
    _write_meta(project_dir, meta)
    _patch_render_module(monkeypatch, {"ok": False, "error": "boom"})
    await server._run_render_task(project_dir, 0, "standard")
    meta = _read_meta(project_dir)
    assert meta["phase"] == "exportable"
    status = json.loads(
        (project_dir / ".render_status.json").read_text(encoding="utf-8")
    )
    assert status["stage"] == "error"
    assert status["message"] == "boom"


async def test_render_task_uses_hyperframes_when_requested(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    calls: list = []
    _patch_render_module(
        monkeypatch, {"ok": True, "output": "renders/legacy.mp4"}, calls
    )

    async def hyperframes(*_args, **_kwargs):
        (project_dir / "renders" / "output.mp4").write_bytes(b"hyperframes")
        return {
            "ok": True,
            "output": "renders/output.mp4",
            "duration": 2,
            "fps": 30,
            "resolution": [1920, 1080],
            "total_frames": 60,
            "audio": False,
        }

    monkeypatch.setattr(server, "_run_hyperframes_engine", hyperframes)
    await server._run_render_task(
        project_dir, 0, "standard", "hyperframes", True
    )

    assert calls == []
    status = json.loads(
        (project_dir / ".render_status.json").read_text(encoding="utf-8")
    )
    assert status["stage"] == "done"
    assert status["requestedEngine"] == "hyperframes"
    assert status["actualEngine"] == "hyperframes"
    assert status["fallbackReason"] is None


async def test_render_task_falls_back_to_legacy_engine(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    calls: list = []
    _patch_render_module(
        monkeypatch,
        {"ok": True, "output": "renders/output.mp4", "fps": 30},
        calls,
    )

    async def hyperframes(*_args, **_kwargs):
        return {"ok": False, "error": "preflight failed"}

    monkeypatch.setattr(server, "_run_hyperframes_engine", hyperframes)
    await server._run_render_task(project_dir, 0, "standard", "auto", True)

    assert len(calls) == 1
    status = json.loads(
        (project_dir / ".render_status.json").read_text(encoding="utf-8")
    )
    assert status["stage"] == "done"
    assert status["requestedEngine"] == "auto"
    assert status["actualEngine"] == "legacy"
    assert status["fallbackReason"] == "preflight failed"


async def test_render_task_renders_from_scene_snapshot(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """P3: scenes/*.html are snapshotted to renders/snapshot/scenes/ and the
    renderer reads the snapshot, so mid-render edits don't leak into output."""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["phase"] = "rendering"
    _write_meta(project_dir, meta)
    (project_dir / "assets").mkdir(exist_ok=True)
    (project_dir / "assets" / "background-content.webp").write_bytes(b"webp")
    (project_dir / "style").mkdir(exist_ok=True)
    (project_dir / "style" / "design-system.json").write_text("{}", encoding="utf-8")
    calls: list = []
    _patch_render_module(
        monkeypatch, {"ok": True, "output": "renders/output.mp4"}, calls
    )
    await server._run_render_task(project_dir, 0, "standard")
    snapshot_dir = project_dir / "renders" / "snapshot" / "scenes"
    assert (snapshot_dir / "scene_01.html").is_file()
    assert (snapshot_dir / "scene_02.html").is_file()
    assert (
        snapshot_dir.parent / "assets" / "background-content.webp"
    ).is_file()
    assert (snapshot_dir.parent / "style" / "design-system.json").is_file()
    assert (
        (snapshot_dir / "scene_01.html").read_text(encoding="utf-8")
        == "<html>scene 1</html>"
    )
    # render_project receives the snapshot dir, not the live scenes dir
    assert calls, "render_project was not called"
    assert calls[0]["kwargs"].get("scenes_dir") == snapshot_dir
    # Snapshot is an independent copy — deleting it leaves live scenes intact
    (snapshot_dir / "scene_01.html").unlink()
    assert (project_dir / "scenes" / "scene_01.html").is_file()


async def test_render_task_snapshot_drops_stale_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A previous snapshot's leftover files are cleared before copying."""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["phase"] = "rendering"
    _write_meta(project_dir, meta)
    snapshot_dir = project_dir / "renders" / "snapshot" / "scenes"
    snapshot_dir.mkdir(parents=True)
    (snapshot_dir / "scene_99.html").write_text("<html>stale</html>", encoding="utf-8")
    _patch_render_module(monkeypatch, {"ok": True, "output": "renders/output.mp4"})
    await server._run_render_task(project_dir, 0, "standard")
    assert not (snapshot_dir / "scene_99.html").exists()
    assert (snapshot_dir / "scene_01.html").is_file()


# --- status & listing contract -------------------------------------------------


async def test_export_status_response_is_camelcase(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    (project_dir / "renders" / "output.mp4").write_bytes(b"mp4")
    (project_dir / ".render_status.json").write_text(
        json.dumps(
            {
                "stage": "done",
                "progress": 100,
                "total_frames": 360,
                "need_download": False,
                "requestedEngine": "auto",
                "actualEngine": "legacy",
                "fallbackReason": "preflight failed",
                "started_at": "2026-08-05T00:00:00",
                "finished_at": "2026-08-05T00:01:00",
            }
        ),
        encoding="utf-8",
    )
    request = MagicMock()
    request.query = {"name": "proj"}
    response = await server.handle_video_project_export_status(request)
    assert response.status == 200
    payload = _body(response)
    assert payload["totalFrames"] == 360
    assert payload["startedAt"] == "2026-08-05T00:00:00"
    assert payload["finishedAt"] == "2026-08-05T00:01:00"
    assert payload["hasVideo"] is True
    assert "total_frames" not in payload
    assert "started_at" not in payload
    assert payload["needDownload"] is False  # False kept; only None dropped
    assert payload["requestedEngine"] == "auto"
    assert payload["actualEngine"] == "legacy"
    assert payload["fallbackReason"] == "preflight failed"


async def test_cancel_export_sets_cooperative_stop_signal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    _write_meta(project_dir, {"phase": "rendering", "scenes": []})
    server._write_render_status(
        project_dir, {"stage": "rendering", "progress": 42, "message": "渲染中"}
    )
    blocker = asyncio.Event()
    task = asyncio.create_task(blocker.wait())
    cancel_event = server.threading.Event()
    server._video_render_tasks["proj"] = task
    server._video_render_cancel_events["proj"] = cancel_event
    try:
        response = await server.handle_video_project_export_cancel(
            _post_request({"name": "proj"})
        )
        assert response.status == 202
        assert cancel_event.is_set()
        status = server._read_render_status(project_dir)
        assert status["stage"] == "cancelling"
        assert status["progress"] == 42
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        server._video_render_tasks.pop("proj", None)
        server._video_render_cancel_events.pop("proj", None)


async def test_render_task_pre_cancel_restores_exportable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["phase"] = "rendering"
    _write_meta(project_dir, meta)
    cancel_event = server.threading.Event()
    cancel_event.set()

    await server._run_render_task(
        project_dir, 0, "standard", cancel_event=cancel_event
    )

    assert server._read_render_status(project_dir)["stage"] == "cancelled"
    assert _read_meta(project_dir)["phase"] == "exportable"


async def test_export_status_recovers_interrupted_job_after_restart(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    _write_meta(project_dir, {"phase": "rendering", "scenes": []})
    server._write_render_status(
        project_dir, {"stage": "rendering", "progress": 38, "message": "渲染中"}
    )
    server._video_render_tasks.pop("proj", None)

    request = MagicMock()
    request.query = {"name": "proj"}
    response = await server.handle_video_project_export_status(request)

    payload = _body(response)
    assert payload["stage"] == "error"
    assert payload["recoverable"] is True
    assert "应用退出" in payload["message"]
    assert _read_meta(project_dir)["phase"] == "exportable"


async def test_delivery_artifacts_include_video_subtitles_and_report(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import zipfile

    from mona.api.video_runtime import VideoRuntime
    from mona.video_assets import import_project_asset
    from mona.video_timeline import (
        build_motion_plan,
        build_subtitle_track,
        write_timeline_json,
    )

    project_dir = _make_project(tmp_path)
    (project_dir / "scene_specs").mkdir()
    (project_dir / "audio").mkdir()
    pending = project_dir / "renders" / "output.pending.mp4"
    pending.write_bytes(b"video-bytes")
    source_asset = tmp_path / "licensed.png"
    source_asset.write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
    )
    registered_asset = import_project_asset(
        project_dir,
        source_asset,
        rights_status="licensed",
        source_type="licensed-library",
        license_name="商业图库授权",
    )
    track = build_subtitle_track("第一句。第二句。", 4_000)
    motion = build_motion_plan({"index": 1, "role": "content"}, track)
    write_timeline_json(project_dir / "audio" / "scene_01.timing.json", track)
    write_timeline_json(
        project_dir / "scene_specs" / "scene_01.motion.json", motion
    )
    monkeypatch.setattr(VideoRuntime, "get_ffmpeg_path", lambda _self: None)

    delivery = await server._write_video_delivery_artifacts(
        project_dir,
        {
            "styleVersion": 2,
            "scenes": [
                {
                    "index": 1,
                    "role": "content",
                    "duration": 4,
                    "narration": "第一句。第二句。",
                    "assets": [registered_asset["id"]],
                }
            ],
        },
        {
            "output": "renders/output.pending.mp4",
            "duration": 4,
            "fps": 30,
            "resolution": [1920, 1080],
            "total_frames": 120,
            "audio": True,
        },
        "hyperframes",
        server.threading.Event(),
    )

    assert delivery["artifacts"]["package"] == "renders/delivery.zip"
    assert "00:00:00,000" in (
        project_dir / "renders" / "subtitles.srt"
    ).read_text(encoding="utf-8")
    report = json.loads(
        (project_dir / "renders" / "quality-report.json").read_text(
            encoding="utf-8"
        )
    )
    assert report["checks"]["subtitleCueCount"] == 2
    assert report["renderer"]["engine"] == "hyperframes"
    assert report["checks"]["assetRightsIssues"] == []
    rights = json.loads(
        (project_dir / "renders" / "asset-rights.json").read_text(
            encoding="utf-8"
        )
    )
    assert rights["assets"][0]["licenseName"] == "商业图库授权"
    with zipfile.ZipFile(project_dir / "renders" / "delivery.zip") as archive:
        assert {
            "output.mp4",
            "subtitles.srt",
            "subtitles.vtt",
            "quality-report.json",
            "asset-rights.json",
        }.issubset(archive.namelist())


def test_pending_render_output_replaces_final_only_after_commit(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    final_output = project_dir / "renders" / "output.mp4"
    pending_output = project_dir / "renders" / "output.pending.mp4"
    final_output.write_bytes(b"previous-valid-video")
    pending_output.write_bytes(b"new-video")
    result = {"output": "renders/output.pending.mp4"}

    server._commit_render_output(project_dir, result)

    assert final_output.read_bytes() == b"new-video"
    assert not pending_output.exists()
    assert result["output"] == "renders/output.mp4"


async def test_project_version_restore_recovers_scene_and_keeps_video_stale(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    from mona.video_assets import import_project_asset

    source_asset = tmp_path / "versioned.png"
    source_asset.write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
    )
    asset = import_project_asset(
        project_dir, source_asset, rights_status="owned"
    )
    original = _read_meta(project_dir)
    original["scenes"][0]["title"] = "原始标题"
    original["scenes"][0]["assets"] = [asset["id"]]
    _write_meta(project_dir, original)
    version = server._create_video_project_version(
        project_dir,
        label="重写场景 1 前",
        reason="ai-scene-rewrite",
        changed_scene_indices=[1],
    )
    changed = _read_meta(project_dir)
    changed["scenes"][0]["title"] = "错误标题"
    _write_meta(project_dir, changed)
    (project_dir / "scenes" / "scene_01.html").write_text(
        "<html>changed</html>", encoding="utf-8"
    )
    (project_dir / asset["path"]).unlink()

    response = await server.handle_video_project_version_restore(
        _post_request({"name": "proj", "versionId": version["id"]})
    )

    assert response.status == 200
    restored = _read_meta(project_dir)
    assert restored["scenes"][0]["title"] == "原始标题"
    assert restored["outputStale"] is True
    assert restored["hasVideo"] is True
    assert restored["phase"] == "exportable"
    assert (project_dir / asset["path"]).read_bytes() == source_asset.read_bytes()
    assert _body(response)["backupVersionId"] != version["id"]


async def test_scene_timeline_api_returns_motion_and_subtitle_tracks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from mona.video_timeline import (
        build_motion_plan,
        build_subtitle_track,
        write_timeline_json,
    )

    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    (project_dir / "audio").mkdir()
    (project_dir / "scene_specs").mkdir()
    _write_meta(
        project_dir,
        {
            "phase": "producing",
            "scenes": [
                {"index": 1, "duration": 5, "role": "content", "narration": "两句字幕。"}
            ],
        },
    )
    track = build_subtitle_track("两句字幕。", 5_000)
    motion = build_motion_plan({"index": 1, "role": "content"}, track)
    write_timeline_json(project_dir / "audio" / "scene_01.timing.json", track)
    write_timeline_json(
        project_dir / "scene_specs" / "scene_01.motion.json", motion
    )
    request = MagicMock()
    request.query = {"name": "proj", "index": "1"}

    response = await server.handle_video_project_scene_timeline(request)

    payload = _body(response)
    assert payload["durationMs"] == 5_000
    assert payload["subtitleTrack"]["cues"]
    assert payload["motionPlan"]["beats"]


def test_scene_preview_accepts_semantic_seek_messages() -> None:
    preview = server._prepare_scene_html_for_preview(
        "<html><body><div>scene</div></body></html>",
        "proj",
        1920,
        1080,
    )
    assert "mona-video-seek" in preview
    assert "__monaApplySubtitleTime" in preview


def test_scene_preview_embeds_style_and_project_images(tmp_path) -> None:
    from PIL import Image

    (tmp_path / "assets").mkdir()
    (tmp_path / "style" / "assets").mkdir(parents=True)
    Image.new("RGB", (8, 8), "blue").save(tmp_path / "assets" / "cover image.png")
    Image.new("RGB", (8, 8), "green").save(tmp_path / "style" / "assets" / "brand.webp")
    html = '<img src="../assets/cover%20image.png"><img src="../style/assets/brand.webp"><style>.bg{background-image:url("../style/assets/brand.webp")}</style>'
    preview = server._prepare_scene_html_for_preview(html, "项目", 1920, 1080, project_dir=tmp_path)
    assert preview.count("data:image/webp;base64,") == 2
    assert "data:image/png;base64," in preview
    assert "../assets/" not in preview
    assert "../style/assets/" not in preview


def test_scene_preview_rejects_asset_escape(tmp_path) -> None:
    with pytest.raises(ValueError, match="超出项目"):
        server._prepare_scene_html_for_preview('<img src="../assets/../../outside.png">', "项目", 1920, 1080, project_dir=tmp_path)


async def test_review_comments_block_final_but_not_draft_export(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    _setup_confirmed_project(tmp_path)
    create_response = await server.handle_video_project_review_create(
        _post_request(
            {
                "name": "proj",
                "sceneIndex": 1,
                "timeMs": 99_000,
                "text": "这里的数据来源需要复核",
            }
        )
    )
    review = _body(create_response)["review"]
    assert review["timeMs"] == 5_000

    blocked = await server.handle_video_project_export(
        _post_request(
            {"name": "proj", "quality": "draft", "releaseType": "final"}
        )
    )
    assert blocked.status == 409
    assert _body(blocked)["error"] == "OPEN_REVIEWS"

    resolved = await server.handle_video_project_review_resolve(
        _post_request(
            {"name": "proj", "reviewId": review["id"], "resolved": True}
        )
    )
    assert _body(resolved)["review"]["status"] == "resolved"

    async def _fake_render(*_args, **_kwargs) -> None:
        return None

    monkeypatch.setattr(server, "_run_render_task", _fake_render)
    allowed = await server.handle_video_project_export(
        _post_request(
            {"name": "proj", "quality": "draft", "releaseType": "final"}
        )
    )
    assert allowed.status == 200
    assert _body(allowed)["releaseType"] == "final"


async def test_review_list_reports_open_count(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    server._write_video_reviews(
        project_dir,
        [
            {"id": "review-1", "status": "open"},
            {"id": "review-2", "status": "resolved"},
        ],
    )
    request = MagicMock()
    request.query = {"name": "proj"}

    response = await server.handle_video_project_reviews(request)

    assert _body(response)["openCount"] == 1


async def test_final_export_quality_gate_preserves_previous_video(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    previous = project_dir / "renders" / "output.mp4"
    previous.write_bytes(b"previous-valid-video")
    meta = _read_meta(project_dir)
    meta["phase"] = "rendering"
    _write_meta(project_dir, meta)
    _patch_render_module(
        monkeypatch,
        {"ok": True, "output": "renders/output.pending.mp4"},
    )

    await server._run_render_task(
        project_dir,
        0,
        "draft",
        release_type="final",
    )

    status = server._read_render_status(project_dir)
    assert status["stage"] == "error"
    assert "正式版未通过交付检查" in status["message"]
    assert previous.read_bytes() == b"previous-valid-video"


async def test_export_preflight_reports_workload_and_honest_billing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["resolution"] = "1080x1920"
    meta["narrationEnabled"] = True
    meta["ttsProvider"] = "custom"
    meta["scenes"][0]["duration"] = 4
    meta["scenes"][0]["narration"] = "第一段旁白"
    meta["scenes"][1]["duration"] = 6
    meta["scenes"][1]["narration"] = "第二段旁白"
    _write_meta(project_dir, meta)
    request = MagicMock()
    request.query = {"name": "proj", "quality": "draft"}

    response = await server.handle_video_project_export_preflight(request)

    payload = _body(response)
    assert payload["duration"] == 10
    assert payload["fps"] == 24
    assert payload["resolution"] == [540, 960]
    assert payload["estimatedFrames"] == 240
    assert payload["billing"]["monaCredits"] == 0
    assert payload["billing"]["externalProviderBilling"] is True


async def test_project_asset_api_imports_and_updates_rights(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    _make_project(tmp_path)
    source = tmp_path / "product.png"
    source.write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
    )

    imported_response = await server.handle_video_project_asset_import(
        _post_request(
            {
                "name": "proj",
                "sourcePath": str(source),
                "sourceType": "user-upload",
                "rightsStatus": "unknown",
            }
        )
    )
    imported = _body(imported_response)["asset"]
    assert imported["commercialUse"] is False

    updated_response = await server.handle_video_project_asset_update(
        _post_request(
            {
                "name": "proj",
                "assetId": imported["id"],
                "rightsStatus": "owned",
            }
        )
    )
    assert _body(updated_response)["asset"]["commercialUse"] is True

    request = MagicMock()
    request.query = {"name": "proj"}
    listed = _body(await server.handle_video_project_assets(request))
    assert listed["assets"][0]["id"] == imported["id"]
    assert listed["unconfirmedCount"] == 0


async def test_scene_rejects_unregistered_asset_reference(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "_sync_storyboard", lambda *_args, **_kwargs: None)
    _setup_confirmed_project(tmp_path)

    response = await server.handle_video_project_scene_update(
        _post_request(
            {"name": "proj", "index": 1, "assets": ["asset-does-not-exist"]}
        )
    )

    assert response.status == 404
    assert _body(response)["error"] == "VIDEO_ASSET_NOT_FOUND"


async def test_unconfirmed_asset_blocks_final_export_at_preflight(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from mona.video_assets import import_project_asset

    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    source = tmp_path / "unconfirmed.png"
    source.write_bytes(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
    )
    asset = import_project_asset(project_dir, source, rights_status="unknown")
    meta = _read_meta(project_dir)
    meta["scenes"][0]["assets"] = [asset["id"]]
    _write_meta(project_dir, meta)

    preflight_request = MagicMock()
    preflight_request.query = {"name": "proj", "quality": "standard"}
    preflight = _body(
        await server.handle_video_project_export_preflight(preflight_request)
    )
    assert preflight["assetRights"]["readyForCommercialUse"] is False
    assert preflight["assetRights"]["unconfirmedAssets"][0]["assetId"] == asset["id"]

    response = await server.handle_video_project_export(
        _post_request(
            {"name": "proj", "quality": "standard", "releaseType": "final"}
        )
    )
    assert response.status == 409
    assert _body(response)["error"] == "ASSET_RIGHTS_BLOCKED"


async def test_projects_list_returns_has_video(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path, "with-video")
    (project_dir / "renders" / "output.mp4").write_bytes(b"mp4")
    _make_project(tmp_path, "no-video")
    response = await server.handle_video_projects(MagicMock())
    assert response.status == 200
    projects = {p["name"]: p for p in _body(response)["projects"]}
    assert projects["with-video"]["hasVideo"] is True
    assert projects["with-video"]["phase"] == "done"
    assert projects["no-video"]["hasVideo"] is False
    assert projects["no-video"]["phase"] == "storyboard"


# --- quality presets -------------------------------------------------------------


def test_quality_presets_map_to_expected_fps() -> None:
    script = (
        Path(server.__file__).parent.parent
        / "skills"
        / "mona-video"
        / "scripts"
        / "render.py"
    )
    spec = importlib.util.spec_from_file_location("mona_video_render", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module._QUALITY_PRESETS["draft"][0] == 24
    assert module._QUALITY_PRESETS["standard"][0] == 30
    assert module._QUALITY_PRESETS["high"][0] == 60


def test_full_preview_seeks_scene_motion_and_subtitle_timelines() -> None:
    html = server._build_video_preview_html(
        640,
        360,
        2.0,
        [(1, 2.0, "<html><body>scene</body></html>")],
        project_name="preview-project",
        token="preview-token",
        audio_scene_indices={1},
    )
    assert "function seekFrame(frame, time)" in html
    assert "timeline.seek(time)" in html
    assert "win.__monaApplySubtitleTime(time)" in html
    assert "seekFrame(frames[nextIndex], localTime)" in html
    assert "/api/video/project/scene/narration?" in html
    assert "new Audio(audioUrl)" in html
    assert "播放预览" in html


# --- export-time narration synthesis (P0-2) ----------------------------------


async def test_scene_narration_get_serves_cached_preview_audio(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    _write_meta(
        project_dir,
        {
            "narrationEnabled": True,
            "scenes": [{"index": 1, "narration": "预览旁白"}],
        },
    )
    force_values: list[bool] = []

    async def _fake_tts(
        _project_dir: Path,
        _scene: dict,
        _meta: dict,
        *,
        force: bool = False,
    ) -> bytes:
        force_values.append(force)
        return b"preview-audio"

    monkeypatch.setattr(server, "_synthesize_scene_narration", _fake_tts)
    request = MagicMock()
    request.method = "GET"
    request.query = {"name": "proj", "index": "1"}

    response = await server.handle_video_project_scene_narration(request)

    assert response.status == 200
    assert response.body == b"preview-audio"
    assert response.content_type == "audio/mpeg"
    assert force_values == [False]


async def test_render_task_synthesizes_narration_per_scene(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """narrationEnabled 项目导出前自动合成各场景 mp3，并持久化 audioMtime。"""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["narrationEnabled"] = True
    meta["phase"] = "rendering"
    for s in meta["scenes"]:
        s["narration"] = f"旁白 {s['index']}"
    _write_meta(project_dir, meta)
    _patch_render_module(
        monkeypatch, {"ok": True, "output": "renders/output.mp4", "audio": True}
    )
    mixer = _isolate_project_audio_mix(monkeypatch)

    calls: list[int] = []

    async def _fake_tts(pdir: Path, scene: dict, m: dict, *, force: bool = False):
        calls.append(scene["index"])
        audio_dir = pdir / "audio"
        audio_dir.mkdir(exist_ok=True)
        p = audio_dir / f"scene_{scene['index']:02d}.mp3"
        p.write_bytes(b"mp3")
        scene["audioMtime"] = p.stat().st_mtime
        return b"mp3"

    monkeypatch.setattr(server, "_synthesize_scene_narration", _fake_tts)
    await server._run_render_task(project_dir, 0, "standard")

    assert calls == [1, 2]
    mixer.assert_awaited_once()
    assert (project_dir / "audio" / "scene_01.mp3").is_file()
    assert (project_dir / "audio" / "scene_02.mp3").is_file()
    persisted = _read_meta(project_dir)
    assert persisted["scenes"][0]["audioMtime"] is not None
    status = json.loads(
        (project_dir / ".render_status.json").read_text(encoding="utf-8")
    )
    assert status["stage"] == "done"
    assert status["message"] == "导出完成"


@pytest.mark.parametrize(
    ("failed_indices", "failed_audio"),
    [({1, 2}, None), ({1, 2}, b""), ({2}, None)],
)
async def test_render_task_narration_failure_stops_export(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    failed_indices: set[int],
    failed_audio: bytes | None,
) -> None:
    """部分或全部旁白失败都停止导出，保留旧视频和成功场景的音频。"""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["narrationEnabled"] = True
    meta["phase"] = "rendering"
    for s in meta["scenes"]:
        s["narration"] = f"旁白 {s['index']}"
    _write_meta(project_dir, meta)
    previous_output = project_dir / "renders" / "output.mp4"
    previous_output.write_bytes(b"previous-video")
    render_calls: list = []
    _patch_render_module(
        monkeypatch, {"ok": True, "output": "renders/output.mp4"}, render_calls
    )

    async def _fail_tts(pdir: Path, scene: dict, _meta: dict):
        if scene["index"] in failed_indices:
            return failed_audio
        audio_dir = pdir / "audio"
        audio_dir.mkdir(exist_ok=True)
        path = audio_dir / f"scene_{scene['index']:02d}.mp3"
        path.write_bytes(b"mp3")
        scene["audioMtime"] = path.stat().st_mtime
        return b"mp3"

    monkeypatch.setattr(server, "_synthesize_scene_narration", _fail_tts)
    await server._run_render_task(project_dir, 0, "standard")

    status = json.loads(
        (project_dir / ".render_status.json").read_text(encoding="utf-8")
    )
    assert status["stage"] == "error"
    failed_scenes = "、".join(str(index) for index in sorted(failed_indices))
    assert f"场景 {failed_scenes} 的旁白合成失败" in status["message"]
    assert "视频未导出" in status["message"]
    assert render_calls == []
    assert previous_output.read_bytes() == b"previous-video"
    persisted = _read_meta(project_dir)
    assert persisted["phase"] == "exportable"
    if 1 not in failed_indices:
        assert persisted["scenes"][0]["audioMtime"] is not None


async def test_render_task_removes_orphan_and_stale_audio(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """孤儿 scene_*.mp3 与旧 narration.mp3 在导出前被清理。"""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["narrationEnabled"] = True
    meta["phase"] = "rendering"
    for s in meta["scenes"]:
        s["narration"] = f"旁白 {s['index']}"
    _write_meta(project_dir, meta)
    audio_dir = project_dir / "audio"
    audio_dir.mkdir(exist_ok=True)
    (audio_dir / "scene_99.mp3").write_bytes(b"orphan")
    (audio_dir / "narration.mp3").write_bytes(b"stale")
    _patch_render_module(
        monkeypatch, {"ok": True, "output": "renders/output.mp4", "audio": True}
    )
    mixer = _isolate_project_audio_mix(monkeypatch)

    async def _fake_tts(pdir: Path, scene: dict, m: dict, *, force: bool = False):
        p = pdir / "audio" / f"scene_{scene['index']:02d}.mp3"
        p.write_bytes(b"mp3")
        scene["audioMtime"] = p.stat().st_mtime
        return b"mp3"

    monkeypatch.setattr(server, "_synthesize_scene_narration", _fake_tts)
    await server._run_render_task(project_dir, 0, "standard")

    mixer.assert_awaited_once()
    assert not (audio_dir / "scene_99.mp3").exists()
    assert not (audio_dir / "narration.mp3").exists()  # 删除后由 render 重拼
    assert (audio_dir / "scene_01.mp3").is_file()
    assert (audio_dir / "scene_02.mp3").is_file()


async def test_render_task_rejects_output_without_required_narration(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["narrationEnabled"] = True
    for scene in meta["scenes"]:
        scene["narration"] = "旁白"
    _write_meta(project_dir, meta)
    previous_output = project_dir / "renders" / "output.mp4"
    previous_output.write_bytes(b"previous-video")
    _patch_render_module(
        monkeypatch,
        {"ok": True, "output": "renders/output.pending.mp4", "audio": False},
    )
    mixer = _isolate_project_audio_mix(monkeypatch)
    validator = AsyncMock(
        side_effect=RuntimeError("旁白未加入视频，视频未导出。请重试导出。")
    )
    monkeypatch.setattr(server, "_validate_rendered_video", validator)
    monkeypatch.setattr(
        server, "_synthesize_scene_narration", AsyncMock(return_value=b"mp3")
    )

    await server._run_render_task(project_dir, 0, "standard")

    mixer.assert_awaited_once()
    validator.assert_awaited_once()
    status = server._read_render_status(project_dir)
    assert status["stage"] == "error"
    assert "旁白未加入视频" in status["message"]
    assert previous_output.read_bytes() == b"previous-video"
    assert _read_meta(project_dir)["phase"] == "exportable"


async def test_synthesize_scene_narration_rejects_empty_provider_audio(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import mona.providers.tts as tts_mod

    provider = MagicMock()
    provider.synthesize_with_timings = AsyncMock(
        return_value=tts_mod.TTSSynthesisResult(audio=b"")
    )
    monkeypatch.setattr(tts_mod, "EdgeTTSProvider", lambda **_kwargs: provider)
    project_dir = _make_project(tmp_path)
    scene = {"index": 1, "narration": "旁白"}

    audio = await server._synthesize_scene_narration(project_dir, scene, {})

    assert audio is None
    assert not (project_dir / "audio" / "scene_01.mp3").exists()
    assert "audioMtime" not in scene


async def test_synthesize_scene_narration_cache_hit_skips_tts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """audioMtime 与文件 mtime 匹配时读缓存跳过 TTS；force 强制重新合成。"""
    import mona.providers.tts as tts_mod

    project_dir = _make_project(tmp_path)

    class _FakeProvider:
        def __init__(self, **_kwargs) -> None:
            self.calls = 0

        async def synthesize_to_bytes(self, text: str, voice: str = ""):
            self.calls += 1
            return b"audio-bytes"

    provider = _FakeProvider()
    monkeypatch.setattr(tts_mod, "EdgeTTSProvider", lambda **kw: provider)

    scene = {"index": 1, "narration": "你好世界"}
    meta = {"ttsProvider": "edge"}
    first = await server._synthesize_scene_narration(project_dir, scene, meta)
    assert first == b"audio-bytes"
    assert provider.calls == 1
    assert scene["audioMtime"] is not None
    assert scene["audioTimingSource"] == "estimated"
    assert (project_dir / "audio" / "scene_01.timing.json").is_file()
    assert (project_dir / "scene_specs" / "scene_01.motion.json").is_file()

    second = await server._synthesize_scene_narration(project_dir, scene, meta)
    assert second == b"audio-bytes"
    assert provider.calls == 1  # cache hit

    third = await server._synthesize_scene_narration(
        project_dir, scene, meta, force=True
    )
    assert third == b"audio-bytes"
    assert provider.calls == 2


async def test_synthesize_scene_narration_persists_provider_boundaries(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import mona.providers.tts as tts_mod

    project_dir = _make_project(tmp_path)

    class _TimedProvider:
        def __init__(self) -> None:
            self.calls = 0

        async def synthesize_with_timings(self, text: str, voice: str = ""):
            self.calls += 1
            return tts_mod.TTSSynthesisResult(
                audio=b"timed-audio",
                boundaries=(
                    {"text": "你好，", "startMs": 100, "endMs": 500},
                    {"text": "世界。", "startMs": 520, "endMs": 980},
                ),
                timing_source="provider-boundary",
            )

    provider = _TimedProvider()
    monkeypatch.setattr(tts_mod, "EdgeTTSProvider", lambda **_kwargs: provider)
    scene = {"index": 1, "role": "content", "duration": 2, "narration": "你好，世界。"}

    audio = await server._synthesize_scene_narration(
        project_dir, scene, {"ttsProvider": "edge"}, force=True
    )

    assert audio == b"timed-audio"
    assert provider.calls == 1
    timing = json.loads(
        (project_dir / "audio" / "scene_01.timing.json").read_text(encoding="utf-8")
    )
    assert timing["timingSource"] == "provider-boundary"
    assert timing["cues"][0]["words"][0]["startMs"] == 100
    assert scene["audioTimingSource"] == "provider-boundary"


async def test_untimed_tts_uses_acoustic_sentence_alignment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import mona.providers.tts as tts_mod

    project_dir = _make_project(tmp_path)

    class _UntimedProvider:
        async def synthesize_with_timings(self, text: str, voice: str = ""):
            return tts_mod.TTSSynthesisResult(audio=b"untimed-audio")

    async def _align(_path: Path, _text: str):
        return (
            [
                {"text": "第一句。", "startMs": 0, "endMs": 900},
                {"text": "第二句。", "startMs": 1200, "endMs": 2200},
            ],
            "acoustic-sentence-alignment",
            "high",
        )

    monkeypatch.setattr(tts_mod, "EdgeTTSProvider", lambda **_kwargs: _UntimedProvider())
    monkeypatch.setattr(server, "_align_tts_scene_audio", _align)
    scene = {
        "index": 1,
        "role": "content",
        "duration": 3,
        "narration": "第一句。第二句。",
    }

    audio = await server._synthesize_scene_narration(
        project_dir, scene, {"ttsProvider": "edge"}, force=True
    )

    assert audio == b"untimed-audio"
    track = json.loads(
        (project_dir / "audio" / "scene_01.timing.json").read_text(encoding="utf-8")
    )
    assert track["timingSource"] == "acoustic-sentence-alignment"
    assert track["alignmentConfidence"] == "high"
    assert scene["audioTimingSource"] == "acoustic-sentence-alignment"
    assert scene["audioAlignmentConfidence"] == "high"


async def test_provider_audio_extends_scene_instead_of_being_cut(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import mona.providers.tts as tts_mod

    project_dir = _make_project(tmp_path)

    class _TimedProvider:
        async def synthesize_with_timings(self, text: str, voice: str = ""):
            return tts_mod.TTSSynthesisResult(
                audio=b"long-audio",
                boundaries=(
                    {"text": "这段旁白比较长。", "startMs": 0, "endMs": 2_850},
                ),
                timing_source="provider-boundary",
            )

    monkeypatch.setattr(tts_mod, "EdgeTTSProvider", lambda **_kwargs: _TimedProvider())
    scene = {
        "index": 1,
        "role": "content",
        "duration": 2,
        "durationRaw": "2s",
        "narration": "这段旁白比较长。",
    }

    await server._synthesize_scene_narration(
        project_dir, scene, {"ttsProvider": "edge"}, force=True
    )

    assert scene["duration"] == 4
    assert scene["durationRaw"] == "4s"
    timing = json.loads(
        (project_dir / "audio" / "scene_01.timing.json").read_text(encoding="utf-8")
    )
    assert timing["durationMs"] == 4_000


async def test_scene_update_clears_audio_mtime(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """场景内容变更清除 audioMtime，导出时会重新合成旁白。"""
    _patch_projects_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "_sync_storyboard", lambda *a, **k: None)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["scenes"][0]["audioMtime"] = 999.0
    meta["scenes"][0]["audioTimingPath"] = "audio/scene_01.timing.json"
    meta["scenes"][0]["motionPlanPath"] = "scene_specs/scene_01.motion.json"
    (project_dir / "audio").mkdir(exist_ok=True)
    (project_dir / "audio" / "scene_01.timing.json").write_text("{}", encoding="utf-8")
    (project_dir / "scene_specs").mkdir(exist_ok=True)
    (project_dir / "scene_specs" / "scene_01.motion.json").write_text(
        "{}", encoding="utf-8"
    )
    _write_meta(project_dir, meta)

    response = await server.handle_video_project_scene_update(
        _post_request({"name": "proj", "index": 1, "narration": "新旁白"})
    )
    assert response.status == 200
    updated = _read_meta(project_dir)
    scene1 = next(s for s in updated["scenes"] if s["index"] == 1)
    assert "audioMtime" not in scene1
    assert "audioTimingPath" not in scene1
    assert "motionPlanPath" not in scene1
    assert not (project_dir / "audio" / "scene_01.timing.json").exists()
    assert not (project_dir / "scene_specs" / "scene_01.motion.json").exists()
    scene2 = next(s for s in updated["scenes"] if s["index"] == 2)
    assert scene2.get("audioMtime") is None  # 未设置过，保持缺失


# --- frame-level render progress (P1-1) --------------------------------------


def _load_render_module():
    script = (
        Path(server.__file__).parent.parent
        / "skills"
        / "mona-video"
        / "scripts"
        / "render.py"
    )
    spec = importlib.util.spec_from_file_location("mona_video_render", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_frame_progress_maps_to_render_band() -> None:
    """帧进度映射到 15-90% 区间且单调递增。"""
    module = _load_render_module()
    assert module._frame_progress(0, 100) == 15.0
    assert module._frame_progress(50, 100) == 52.5
    assert module._frame_progress(100, 100) == 90.0
    assert module._frame_progress(200, 100) == 90.0  # clamp
    values = [module._frame_progress(i, 300) for i in range(301)]
    assert all(a <= b for a, b in zip(values, values[1:]))


async def test_render_scene_reports_frame_progress(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """_render_scene 每 15 帧 + 末帧触发 frame_cb。"""
    import base64

    module = _load_render_module()
    scene_path = tmp_path / "scene_01.html"
    scene_path.write_text("<html></html>", encoding="utf-8")
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()

    async def _fake_cdp(ws, method, params=None, *, timeout=60.0):
        if method == "Page.enable":
            raise RuntimeError("Page.enable wasn't found")
        if method == "Page.captureScreenshot":
            return {"data": base64.b64encode(b"\x89PNG").decode()}
        if method == "Runtime.evaluate":
            expr = (params or {}).get("expression", "")
            if "readyState" in expr or "gsap" in expr:
                return {"result": {"value": True}}
            return {"result": {}}
        return {}

    monkeypatch.setattr(module, "_cdp_call", _fake_cdp)
    calls: list[int] = []
    total = await module._render_scene(
        None, scene_path, 31 / 30, 30, 100, 100, frames_dir, 0,
        frame_cb=calls.append,
    )
    assert total == 31
    assert calls == [15, 30, 31]


async def test_render_task_forwards_progress_to_status_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """_run_render_task 的 progress 回调把帧级进度写入 .render_status.json。"""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["phase"] = "rendering"
    _write_meta(project_dir, meta)

    snapshots: list[dict] = []

    class _ProgressLoader:
        def create_module(self, spec) -> types.ModuleType:
            return types.ModuleType(spec.name)

        def exec_module(self, module: types.ModuleType) -> None:
            def _render(
                path,
                fps,
                quality,
                progress_cb=None,
                scenes_dir=None,
                cancel_event=None,
                output_name="output.mp4",
                ffmpeg_path=None,
                browser_path=None,
            ):
                if progress_cb is not None:
                    progress_cb("rendering", 20.0, "正在渲染场景 1/2 · 帧 30/300")
                    snapshots.append(
                        json.loads(
                            (project_dir / ".render_status.json").read_text(
                                encoding="utf-8"
                            )
                        )
                    )
                return {"ok": True, "output": "renders/output.mp4"}

            module.render_project = _render

    class _ProgressSpec(_FakeRenderSpec):
        def __init__(self) -> None:
            super().__init__({})
            self.loader = _ProgressLoader()

    original = importlib.util.spec_from_file_location
    monkeypatch.setattr(
        importlib.util,
        "spec_from_file_location",
        lambda name, path, **kwargs: _ProgressSpec()
        if name == "render" else original(name, path, **kwargs),
    )
    monkeypatch.setattr(server, "_validate_rendered_video", AsyncMock())
    await server._run_render_task(project_dir, 0, "standard")

    assert len(snapshots) == 1
    assert snapshots[0]["stage"] == "rendering"
    assert snapshots[0]["progress"] == 20.0
    assert "帧 30/300" in snapshots[0]["message"]
    assert snapshots[0]["started_at"]  # 保留 started_at


# --- storyboard dual-source consistency (P0-1) ------------------------------


@pytest.mark.parametrize("template_id", ["huashu-keynote", "huashu-ui-space", "huashu-collage", "huashu-whiteboard"])
async def test_single_video_uses_selected_template(monkeypatch, tmp_path, template_id) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    response = await server.handle_video_project_create(_post_request({"name": "chosen", "templateId": template_id}))
    assert response.status == 200
    project = tmp_path / "video_projects" / "chosen"
    assert _read_meta(project)["templateId"] == template_id
    style = json.loads((project / "style" / "design-system.json").read_text(encoding="utf-8"))
    assert style["baseTemplateId"] == template_id


async def test_single_video_reuses_style_without_becoming_an_episode(monkeypatch, tmp_path) -> None:
    from mona.video_style import create_series, lock_style

    _patch_projects_dir(monkeypatch, tmp_path)
    monkeypatch.setattr(server, "get_workspace_path", lambda: tmp_path)
    series = create_series(tmp_path, "custom", "个人模板", template_id="huashu-keynote")
    locked = lock_style(tmp_path, series["id"], expected_revision=0)
    response = await server.handle_video_project_create(_post_request({"name": "single", "styleSeriesId": series["id"], "styleVersion": locked["version"], "aspectVariant": "16:9", "narrationEnabled": True, "ttsProvider": "custom"}))
    assert response.status == 200
    project = tmp_path / "video_projects" / "single"
    meta = _read_meta(project)
    assert meta["styleSourceSeriesId"] == "custom"
    assert "seriesId" not in meta
    assert "episodeNumber" not in meta
    assert meta["ttsVoice"] == ""
    assert meta["structuredCompiler"] is False
    assert meta["authoringMode"] == "huashu-motion"
    assert (project / "style" / "design-system.json").is_file()


async def test_narration_cannot_overwrite_edits_made_during_synthesis(monkeypatch, tmp_path) -> None:
    import mona.providers.tts as tts

    _patch_projects_dir(monkeypatch, tmp_path)
    project = _setup_confirmed_project(tmp_path)
    original = _read_meta(project)
    original["scenes"][0]["narration"] = "旧旁白"
    _write_meta(project, original)

    class Provider:
        async def synthesize_with_timings(self, *_args, **_kwargs):
            edited = _read_meta(project)
            edited["scenes"][0]["narration"] = "新旁白"
            _write_meta(project, edited)
            return tts.TTSSynthesisResult(audio=b"old-audio")

    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: Provider())
    with pytest.raises(server._VideoNarrationInputChangedError):
        await server._synthesize_scene_narration(project, original["scenes"][0], original)
    assert _read_meta(project)["scenes"][0]["narration"] == "新旁白"
    assert not (project / "audio" / "scene_01.mp3").exists()


@pytest.mark.parametrize("project_provider,global_provider", [
    ("custom", "custom"), ("custom", "minimax"), ("custom", "cosyvoice"),
    ("minimax", "minimax"), ("cosyvoice", "cosyvoice"),
])
def test_video_narration_resolves_configured_protocol(monkeypatch, project_provider, global_provider) -> None:
    import mona.config.loader as loader
    import mona.providers.tts as tts
    from mona.config.schema import ChannelsConfig

    channels = ChannelsConfig(tts_provider=global_provider, tts_api_base="https://speech.example.test", tts_api_key="test-only", tts_model="test-model", tts_voice="test-voice")
    monkeypatch.setattr(loader, "load_config", lambda: types.SimpleNamespace(channels=channels))
    name, settings = server._video_narration_settings({"ttsProvider": project_provider})
    provider = tts.get_tts_provider(name, **settings)
    assert provider.name == global_provider
    assert provider.voice == "test-voice"
    assert provider.api_key == "test-only"
    assert provider.model == "test-model"
    assert provider.api_url.startswith("https://speech.example.test/")


def test_video_narration_preserves_legacy_local_custom_settings(monkeypatch) -> None:
    import mona.config.loader as loader
    from mona.config.schema import ChannelsConfig

    channels = ChannelsConfig(tts_provider="minimax", tts_api_base="https://global.example.test", tts_api_key="global-test-only", tts_model="global-model", tts_voice="global-voice")
    monkeypatch.setattr(loader, "load_config", lambda: types.SimpleNamespace(channels=channels))
    name, settings = server._video_narration_settings({"ttsProvider": "custom", "ttsApiBase": "https://legacy.example.test", "ttsApiKey": "legacy-test-only", "ttsModel": "legacy-model", "ttsVoice": "legacy-voice"})
    assert name == "custom"
    assert settings == {"api_base": "https://legacy.example.test", "api_key": "legacy-test-only", "model": "legacy-model", "voice": "legacy-voice", "rate": "+0%"}


@pytest.mark.parametrize("field,value", [
    ("tts_api_base", "https://other.example.test"), ("tts_api_key", "changed-test-only"),
    ("tts_model", "other-model"), ("tts_voice", "other-voice"), ("tts_provider", "minimax"),
])
async def test_video_narration_cache_tracks_effective_global_settings(monkeypatch, tmp_path, field, value) -> None:
    import mona.config.loader as loader
    import mona.providers.tts as tts
    from mona.config.schema import ChannelsConfig

    channels = ChannelsConfig(tts_provider="custom", tts_api_base="https://speech.example.test", tts_api_key="test-only", tts_voice="test-voice")
    monkeypatch.setattr(loader, "load_config", lambda: types.SimpleNamespace(channels=channels))
    calls = []

    class Provider:
        async def synthesize_with_timings(self, *_args, **_kwargs):
            return tts.TTSSynthesisResult(audio=b"audio", boundaries=({"text": "旁白", "startMs": 0, "endMs": 500},), timing_source="provider-boundary")

    def create_provider(name, **settings):
        calls.append((name, settings))
        return Provider()

    monkeypatch.setattr(tts, "get_tts_provider", create_provider)
    monkeypatch.setattr(server, "_extend_scene_for_audio", AsyncMock(return_value=False))
    project = _make_project(tmp_path)
    scene = {"index": 1, "duration": 2, "narration": "旁白"}
    meta = {"ttsProvider": "custom", "scenes": [scene]}
    _write_meta(project, meta)
    assert await server._synthesize_scene_narration(project, scene, meta) == b"audio"
    first_hash = scene["audioInputHash"]
    assert await server._synthesize_scene_narration(project, scene, meta) == b"audio"
    assert len(calls) == 1
    setattr(channels, field, value)
    assert await server._synthesize_scene_narration(project, scene, meta) == b"audio"
    assert len(calls) == 2
    assert scene["audioInputHash"] != first_hash
    assert "test-only" not in json.dumps(scene)


async def test_video_narration_drops_audio_after_global_settings_change(monkeypatch, tmp_path) -> None:
    import mona.config.loader as loader
    import mona.providers.tts as tts
    from mona.config.schema import ChannelsConfig

    channels = ChannelsConfig(tts_provider="custom", tts_api_base="https://speech.example.test", tts_api_key="test-only")
    monkeypatch.setattr(loader, "load_config", lambda: types.SimpleNamespace(channels=channels))

    class Provider:
        async def synthesize_with_timings(self, *_args, **_kwargs):
            channels.tts_api_base = "https://changed.example.test"
            return tts.TTSSynthesisResult(audio=b"old-settings-audio")

    monkeypatch.setattr(tts, "get_tts_provider", lambda *_args, **_kwargs: Provider())
    project = _make_project(tmp_path)
    scene = {"index": 1, "duration": 2, "narration": "旁白"}
    meta = {"ttsProvider": "custom", "scenes": [scene]}
    _write_meta(project, meta)
    with pytest.raises(server._VideoNarrationInputChangedError):
        await server._synthesize_scene_narration(project, scene, meta)
    assert not (project / "audio" / "scene_01.mp3").exists()


async def test_pending_scene_does_not_preview_old_html(monkeypatch, tmp_path) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project)
    meta["scenes"][0]["htmlStatus"] = "pending"
    _write_meta(project, meta)
    response = await server.handle_video_project_scene_preview(MagicMock(query={"name": "proj", "index": "1"}))
    assert response.status == 404
    assert _body(response)["needsGeneration"] is True


async def test_project_name_cannot_select_projects_root(monkeypatch, tmp_path) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    (tmp_path / "video_projects").mkdir()
    project, error = server._video_project_dir_or_404(".")
    assert project is None
    assert error.status == 400
    response = await server.handle_video_project_create(_post_request({"name": "."}))
    assert response.status == 400
    assert not (tmp_path / "video_projects" / "meta.json").exists()


def test_merge_unchanged_scene_retains_cache_and_confirmation() -> None:
    content = {"index": 1, "title": "同一个场景", "role": "content", "duration": 5, "assets": []}
    previous = {**content, "htmlStatus": "confirmed", "confirmedMtime": 123, "audioInputHash": "hash"}
    updated = {**content, "duration": 5.0, "visual": "", "animation": "", "narration": ""}
    server._merge_scene_status([previous], [updated])
    assert updated["htmlStatus"] == "confirmed"
    assert updated["confirmedMtime"] == 123
    assert updated["audioInputHash"] == "hash"


async def test_narration_settings_invalidates_audio_without_discarding_scene(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta.update({"narrationEnabled": True, "ttsVoice": "old-voice", "subtitleMode": "burned",
                 "requirePlanApproval": True, "planRevision": 3, "approvedPlanRevision": 3})
    meta["scenes"][0].update({"audioMtime": 123, "audioInputHash": "old-hash"})
    _write_meta(project_dir, meta)
    (project_dir / "audio").mkdir()
    (project_dir / "audio" / "scene_01.mp3").write_bytes(b"old-audio")
    response = await server.handle_video_project_settings(_post_request({"name": "proj", "ttsVoice": "new-voice"}))
    assert response.status == 200
    saved = _read_meta(project_dir)
    assert saved["ttsVoice"] == "new-voice"
    assert saved["outputStale"] is True
    assert saved["phase"] == "exportable"
    assert saved["planRevision"] == saved["approvedPlanRevision"] == 3
    assert saved["scenes"][0]["htmlStatus"] == "previewing"
    assert "audioMtime" not in saved["scenes"][0]
    assert not (project_dir / "audio" / "scene_01.mp3").exists()
    assert (project_dir / "scenes" / "scene_01.html").read_text() == "<html>scene 1</html>"


@pytest.mark.parametrize("settings", [{"narrationEnabled": "false"}, {"ttsProvider": "bad"}, {"subtitleMode": "bad"}, {"ttsRate": "fast"}])
async def test_narration_settings_rejects_invalid_fields(monkeypatch, tmp_path, settings) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    original = (project_dir / "meta.json").read_bytes()
    response = await server.handle_video_project_settings(_post_request({"name": "proj", **settings}))
    assert response.status == 400
    assert (project_dir / "meta.json").read_bytes() == original


async def test_narration_save_over_http_excludes_project_metadata(monkeypatch, tmp_path) -> None:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer

    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = {**_read_meta(project_dir), "name": "proj", "resolution": "1080x1920",
            "narrationEnabled": True, "ttsProvider": "edge", "ttsVoice": "old-voice",
            "ttsRate": "+0%", "subtitleMode": "burned", "requirePlanApproval": True,
            "planRevision": 3, "approvedPlanRevision": 3}
    _write_meta(project_dir, meta)
    original = (project_dir / "meta.json").read_bytes()
    app = web.Application()
    app.router.add_put("/api/video/project/settings", server.handle_video_project_settings)
    async with TestClient(TestServer(app)) as client:
        rejected = await client.put("/api/video/project/settings", json={**meta, "ttsVoice": "zh-CN-XiaoxiaoNeural"})
        assert rejected.status == 400
        assert "导演台" in (await rejected.json())["error"]
        assert (project_dir / "meta.json").read_bytes() == original
        settings = {key: meta[key] for key in ("narrationEnabled", "ttsProvider", "ttsVoice", "ttsRate", "subtitleMode")}
        settings["ttsVoice"] = "zh-CN-XiaoxiaoNeural"
        saved = await client.put("/api/video/project/settings", json={"name": "proj", **settings})
        assert saved.status == 200
        assert (await saved.json())["ok"] is True
    current = _read_meta(project_dir)
    assert current["ttsVoice"] == "zh-CN-XiaoxiaoNeural"
    assert current["resolution"] == "1080x1920"
    assert current["planRevision"] == current["approvedPlanRevision"] == 3


async def test_export_does_not_clear_staleness_after_concurrent_edit(monkeypatch, tmp_path) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    _patch_render_module(monkeypatch, {"ok": True, "output": "renders/output.pending.mp4"})

    async def edit_while_validating(*_args):
        meta = _read_meta(project_dir)
        meta["scenes"][0]["narration"] = "制作期间修改的新旁白"
        meta["scenes"][0]["htmlStatus"] = "pending"
        meta["phase"] = "producing"
        _write_meta(project_dir, meta)

    monkeypatch.setattr(server, "_validate_rendered_video", edit_while_validating)
    await server._run_render_task(project_dir, 30, "standard")
    saved = _read_meta(project_dir)
    assert saved["hasVideo"] is True
    assert saved["outputStale"] is True
    assert saved["phase"] == "producing"
    assert saved["scenes"][0]["narration"] == "制作期间修改的新旁白"


async def test_quality_check_failure_cannot_fall_back(monkeypatch, tmp_path) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    calls: list = []
    _patch_render_module(monkeypatch, {"ok": True}, calls)
    monkeypatch.setattr(server, "_run_hyperframes_engine", AsyncMock(return_value={"ok": False, "error": "HyperFrames check failed"}))
    await server._run_render_task(project_dir, 30, "standard", "auto", True)
    assert calls == []
    assert json.loads((project_dir / ".render_status.json").read_text(encoding="utf-8"))["stage"] == "error"


_STORYBOARD_MD = """# 分镜

### Scene 1: 新开场
- Duration: 6s
- Visual: 新画面
- Animation: 新动画
- Narration: 新旁白

### Scene 2: 新场景二
- Duration: 4s
- Visual: 画面二
- Animation: 动画二
- Narration: 旁白二
"""


def _get_storyboard_request(name: str) -> MagicMock:
    request = MagicMock()
    request.query = {"name": name}
    return request


async def test_storyboard_get_reparses_when_storyboard_md_newer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """AI 改写分镜内容后，旧的画面确认和配音不再属于新内容。"""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    _write_meta(project_dir, {
        "phase": "producing",
        "scenesUpdatedAt": 1000.0,
        "scenes": [
            {
                "index": 1,
                "title": "旧开场",
                "htmlStatus": "confirmed",
                "confirmedMtime": 123.0,
                "audioMtime": 456.0,
            },
            {"index": 2, "title": "旧场景二", "htmlStatus": "ready"},
        ],
    })
    sb = project_dir / "storyboard.md"
    sb.write_text(_STORYBOARD_MD, encoding="utf-8")
    os.utime(sb, (2000.0, 2000.0))

    response = await server.handle_video_project_storyboard(
        _get_storyboard_request("proj")
    )
    assert response.status == 200
    payload = _body(response)
    assert payload["source"] == "storyboard"
    scenes = payload["scenes"]
    assert [s["title"] for s in scenes] == ["新开场", "新场景二"]
    assert scenes[0]["htmlStatus"] == "pending"
    assert "confirmedMtime" not in scenes[0]
    assert "audioMtime" not in scenes[0]
    assert scenes[1]["htmlStatus"] == "pending"
    # 重解析结果缓存回 meta.json
    meta = _read_meta(project_dir)
    assert meta["scenes"][0]["title"] == "新开场"
    assert meta["scenesUpdatedAt"] >= 2000.0


async def test_storyboard_get_uses_meta_cache_when_fresh(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """meta.scenes 比 storyboard.md 新（前端编辑后）→ GET 直接用 meta 缓存。"""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    now = 3000.0
    _write_meta(project_dir, {
        "phase": "producing",
        "scenesUpdatedAt": now,
        "scenes": [{"index": 1, "title": "前端编辑的标题", "htmlStatus": "ready"}],
    })
    sb = project_dir / "storyboard.md"
    sb.write_text(_STORYBOARD_MD, encoding="utf-8")
    os.utime(sb, (1000.0, 1000.0))  # storyboard.md 比 meta 旧

    response = await server.handle_video_project_storyboard(
        _get_storyboard_request("proj")
    )
    assert response.status == 200
    payload = _body(response)
    assert payload["source"] == "meta"
    assert payload["scenes"][0]["title"] == "前端编辑的标题"


async def test_storyboard_get_legacy_project_reparses_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """旧项目无 scenesUpdatedAt（视为 0）→ 首次 GET 重解析，之后走缓存。"""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    _write_meta(project_dir, {
        "phase": "producing",
        "scenes": [{"index": 1, "title": "旧标题", "htmlStatus": "ready"}],
    })
    sb = project_dir / "storyboard.md"
    sb.write_text(_STORYBOARD_MD, encoding="utf-8")

    first = await server.handle_video_project_storyboard(
        _get_storyboard_request("proj")
    )
    assert _body(first)["source"] == "storyboard"
    # 首次重解析后写入了 scenesUpdatedAt >= storyboard.mtime → 第二次走缓存
    second = await server.handle_video_project_storyboard(
        _get_storyboard_request("proj")
    )
    assert _body(second)["source"] == "meta"
    assert _body(second)["scenes"][0]["title"] == "新开场"


async def test_authored_film_reorder_and_remove_require_new_time_slices(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from mona.api.video_director import OWNER_HEADER, handle_video_agent
    from mona.materials.auth import SERVICES_TOKEN_HEADER, get_services_token

    _patch_projects_dir(monkeypatch, tmp_path)
    response = await server.handle_video_project_create(_post_request({"name": "ordered"}))
    assert response.status == 200
    project = tmp_path / "video_projects" / "ordered"
    (project / ".chat_id").write_text("director-chat", encoding="utf-8")

    async def action(payload: dict):
        request = _post_request({"name": "ordered", **payload})
        request.headers = {SERVICES_TOKEN_HEADER: get_services_token(), OWNER_HEADER: "director-chat"}
        return await handle_video_agent(request)

    from test_video_director import _film

    planned = await action({"action": "plan", "scenes": [
        {"title": label, "duration": 3, "visual": f"Show {label}", "animation": "Carry the object into the next segment", "narration": "", "assets": []}
        for label in ("FIRST", "SECOND", "THIRD")
    ]})
    assert planned.status == 200
    assert (await server.handle_video_project_confirm(_post_request({"name": "ordered", "expectedPlanRevision": 1}))).status == 200
    source = _film('<div>FIRST</div><div>SECOND</div><div>THIRD</div>')
    (project / "drafts" / "film.html").write_text(source, encoding="utf-8")
    response = await action({"action": "sync", "source_file": "drafts/film.html", "plan_revision": 1})
    assert response.status == 200
    (project / "audio").mkdir(exist_ok=True)
    for index in (1, 2, 3):
        (project / "audio" / f"scene_{index:02d}.mp3").write_bytes(b"old voice cache")
    meta = _read_meta(project)
    for scene in meta["scenes"]:
        scene.update({"audioInputHash": "old-position", "audioMtime": 1})
    _write_meta(project, meta)
    (project / "renders" / "output.mp4").write_bytes(b"old finished file")

    response = await action({"action": "reorder", "order": [3, 1, 2]})
    assert response.status == 200
    meta = _read_meta(project)
    assert [scene["title"] for scene in meta["scenes"]] == ["THIRD", "FIRST", "SECOND"]
    assert "composition" not in meta
    assert (project / "scene_sources" / "film.html").read_text(encoding="utf-8") == source
    for scene in meta["scenes"]:
        assert scene["htmlStatus"] == "pending"
        assert "audioInputHash" not in scene and "audioMtime" not in scene
        assert not server._video_scene_ready(project, scene)
    assert meta["outputStale"] is True

    response = await action({"action": "remove", "scene_index": 2})
    assert response.status == 200
    meta = _read_meta(project)
    assert [scene["title"] for scene in meta["scenes"]] == ["THIRD", "SECOND"]
    assert "composition" not in meta
    assert all(not server._video_scene_ready(project, scene) for scene in meta["scenes"])
    assert (project / "scene_sources" / "film.html").read_text(encoding="utf-8") == source
    assert meta["phase"] == "storyboard"
    assert meta["requirePlanApproval"] is True


async def test_director_rejects_invalid_combined_settings_without_partial_changes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from mona.api.video_director import OWNER_HEADER, handle_video_agent
    from mona.materials.auth import SERVICES_TOKEN_HEADER, get_services_token

    _patch_projects_dir(monkeypatch, tmp_path)
    await server.handle_video_project_create(_post_request({"name": "settings"}))
    project = tmp_path / "video_projects" / "settings"
    (project / ".chat_id").write_text("director-chat", encoding="utf-8")
    before = (project / "meta.json").read_bytes()
    request = _post_request({"action": "settings", "name": "settings", "settings": {
        "resolution": "1080x1920", "ttsRate": "invalid rate",
    }})
    request.headers = {SERVICES_TOKEN_HEADER: get_services_token(), OWNER_HEADER: "director-chat"}
    response = await handle_video_agent(request)
    assert response.status == 422
    assert (project / "meta.json").read_bytes() == before

    request = _post_request({"action": "assets", "name": "settings", "asset": {
        "name": "another-project", "sourcePath": str(tmp_path / "image.png"),
    }})
    request.headers = {SERVICES_TOKEN_HEADER: get_services_token(), OWNER_HEADER: "director-chat"}
    response = await handle_video_agent(request)
    assert response.status == 422
    assert not (tmp_path / "video_projects" / "another-project").exists()


async def test_style_sample_resolution_settings_preserve_existing_voice(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "video_projects")
    monkeypatch.setattr(server, "_schedule_video_push", lambda *_args: None)
    project = tmp_path / "video_projects" / "style-resolution"
    (project / "audio").mkdir(parents=True)
    audio = project / "audio" / "narration.mp3"
    audio.write_bytes(b"existing sample narration")
    meta = {"name": project.name, "resolution": "1920x1080", "styleAuthoring": {"seriesId": "paper"}, "requirePlanApproval": False, "scenes": []}
    server._save_video_meta(project, meta)
    response = await server.handle_video_project_settings(_post_request({"name": project.name, "resolution": "1080x1920"}))
    assert response.status == 200
    assert server._load_video_meta(project)["resolution"] == "1080x1920"
    assert json.loads(response.body)["meta"]["resolution"] == "1080x1920"
    assert audio.read_bytes() == b"existing sample narration"
    assert server._load_video_meta(project)["requirePlanApproval"] is False
    meta = server._load_video_meta(project)
    meta.pop("styleAuthoring")
    server._save_video_meta(project, meta)
    refused = await server.handle_video_project_settings(_post_request({"name": project.name, "resolution": "1920x1080"}))
    assert refused.status == 400
    assert server._load_video_meta(project)["resolution"] == "1080x1920"


async def test_preview_controls_hide_during_playback_and_wake_on_pointer() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    from mona.api.video_runtime import VideoRuntime

    browser_path = VideoRuntime().get_chrome_path()
    if not browser_path:
        pytest.skip("The existing browser runtime is required")
    html = server._build_video_preview_html(1080, 1920, 5, [(1, 5, "<main>实际动画和字幕</main>")])
    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=browser_path, headless=True)
        try:
            page = await browser.new_page(viewport={"width": 405, "height": 720})
            await page.set_content(html, wait_until="domcontentloaded")
            await page.locator("#play-toggle").click()
            await page.wait_for_function("getComputedStyle(controls).opacity === '0'", timeout=4000)
            assert await page.locator("#wake-controls").is_visible()
            await page.mouse.move(20, 20)
            await page.wait_for_function("getComputedStyle(controls).opacity === '1'")
            await page.locator("#play-toggle").click()
            assert await page.evaluate("playing") is False
            await page.wait_for_timeout(1700)
            assert await page.evaluate("getComputedStyle(controls).opacity") == "1"
            assert not await page.locator("#wake-controls").is_visible()
        finally:
            await browser.close()
