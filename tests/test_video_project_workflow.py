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


async def test_video_plan_returns_reviewable_outline_before_project_creation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)

    class Provider:
        def get_default_model(self) -> str:
            return "test-model"

        async def chat_with_retry(self, **_kwargs):
            return types.SimpleNamespace(
                content=json.dumps(
                    {
                        "contentSummary": "从问题到解决方案",
                        "estimatedAssetCount": 3,
                        "outline": [
                            {
                                "title": "问题背景",
                                "goal": "解释现状",
                                "keyPoints": ["现状", "影响"],
                                "sourceRefs": [],
                                "estimatedSeconds": 35,
                                "role": "cover",
                            },
                            {
                                "title": "解决方案",
                                "goal": "给出做法",
                                "keyPoints": ["步骤一", "步骤二"],
                                "sourceRefs": [],
                                "estimatedSeconds": 55,
                                "role": "process",
                            },
                        ],
                    },
                    ensure_ascii=False,
                )
            )

    request = _post_request({"topic": "产品改版", "sourcePaths": []})
    request.app = {"agent_loop": None, "request_timeout": 10}
    monkeypatch.setattr(server, "_resolve_llm_provider", lambda _request: Provider())

    response = await server.handle_video_project_plan(request)

    assert response.status == 200
    plan = _body(response)["plan"]
    assert [item["title"] for item in plan["outline"]] == [
        "问题背景",
        "解决方案",
    ]
    assert plan["estimatedSceneCount"] == 2
    assert plan["estimatedDurationSeconds"] == 90
    assert not (tmp_path / "video_projects").exists()


async def test_create_project_snapshots_only_the_confirmed_outline_and_sources(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    source = tmp_path / "brief.md"
    source.write_text("# 原始资料\n\n保留第一章，删除第二章。", encoding="utf-8")
    plan = server._video_plan_payload(
        json.dumps(
            {
                "contentSummary": "已删除不需要的章节",
                "estimatedAssetCount": 1,
                "outline": [
                    {
                        "title": "保留的章节",
                        "goal": "讲清核心内容",
                        "keyPoints": ["核心要点"],
                        "sourceRefs": ["brief.md"],
                        "estimatedSeconds": 40,
                        "role": "content",
                    }
                ],
            },
            ensure_ascii=False,
        ),
        {"brief.md"},
    )

    response = await server.handle_video_project_create(
        _post_request(
            {
                "name": "planned",
                "resolution": "1920x1080",
                "plan": plan,
                "sourcePaths": [str(source)],
            }
        )
    )

    assert response.status == 200
    project = tmp_path / "video_projects" / "planned"
    saved_plan = json.loads((project / "outline.json").read_text(encoding="utf-8"))
    assert [item["title"] for item in saved_plan["outline"]] == ["保留的章节"]
    meta = _read_meta(project)
    assert meta["outlineLocked"] is True
    assert meta["outlineSceneCount"] == 1
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
    assert meta["structuredCompiler"] is True
    assert (
        tmp_path
        / "video_projects"
        / "demo"
        / "style"
        / "design-system.json"
    ).is_file()


async def test_single_video_without_narration_still_gets_semantic_motion_plan(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    await server.handle_video_project_create(
        _post_request({"name": "silent-structured", "resolution": "1920x1080"})
    )
    project = tmp_path / "video_projects" / "silent-structured"
    meta = server._load_video_meta(project)
    scene = {
        "index": 1,
        "title": "无旁白也要有动画",
        "role": "content",
        "layout": "content-standard",
        "backgroundSlot": "content",
        "duration": 4,
        "visual": "标题和要点按视觉脚本出现",
        "narration": "",
    }

    class Provider:
        async def chat_with_retry(self, **_kwargs):
            return types.SimpleNamespace(
                content=json.dumps(
                    {
                        "schemaVersion": 1,
                        "sceneIndex": 1,
                        "role": "content",
                        "layout": "content-standard",
                        "backgroundSlot": "content",
                        "animationPreset": "stagger-rise",
                        "duration": 4,
                        "content": {
                            "title": "无旁白也要有动画",
                            "bullets": ["第一点", "第二点"],
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

    html = await server._generate_scene_html_via_llm(project, scene, meta)

    assert "无旁白也要有动画" in html
    assert (project / "scene_specs" / "scene_01.motion.json").is_file()
    assert not (project / "audio" / "scene_01.timing.json").exists()
    motion = json.loads(
        (project / "scene_specs" / "scene_01.motion.json").read_text(
            encoding="utf-8"
        )
    )
    assert motion["beats"]


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


# --- scene confirmation ------------------------------------------------------


async def test_confirm_pending_scene_returns_409(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    _write_meta(
        project_dir,
        {"phase": "producing", "scenes": [{"index": 1, "htmlStatus": "pending"}]},
    )
    response = await server.handle_video_project_scene_confirm(
        _post_request({"name": "proj", "index": 1})
    )
    assert response.status == 409
    assert _body(response)["error"] == "SCENE_NOT_PREVIEWABLE"


async def test_confirm_with_stale_expected_mtime_returns_409(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    scene_path = project_dir / "scenes" / "scene_01.html"
    scene_path.write_text("<html>v1</html>", encoding="utf-8")
    _write_meta(
        project_dir,
        {"phase": "producing", "scenes": [{"index": 1, "htmlStatus": "previewing"}]},
    )
    stale_mtime = scene_path.stat().st_mtime + 100
    response = await server.handle_video_project_scene_confirm(
        _post_request({"name": "proj", "index": 1, "expectedMtime": stale_mtime})
    )
    assert response.status == 409
    assert _body(response)["error"] == "SCENE_VERSION_CHANGED"


async def test_confirm_binds_current_mtime_and_marks_exportable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _make_project(tmp_path)
    scene_path = project_dir / "scenes" / "scene_01.html"
    scene_path.write_text("<html>v1</html>", encoding="utf-8")
    mtime = scene_path.stat().st_mtime
    _write_meta(
        project_dir,
        {"phase": "producing", "scenes": [{"index": 1, "htmlStatus": "previewing"}]},
    )
    response = await server.handle_video_project_scene_confirm(
        _post_request({"name": "proj", "index": 1, "expectedMtime": mtime})
    )
    assert response.status == 200
    payload = _body(response)
    assert payload["allConfirmed"] is True
    assert payload["phase"] == "exportable"
    meta = _read_meta(project_dir)
    assert meta["scenes"][0]["htmlStatus"] == "confirmed"
    assert meta["scenes"][0]["confirmedMtime"] == mtime


def test_confirmation_invalidated_by_html_file_change(tmp_path: Path) -> None:
    project_dir = _make_project(tmp_path)
    scene = _confirmed_scene(project_dir, 1)
    assert server._video_scene_confirmed_current(project_dir, scene) is True
    scene_path = project_dir / "scenes" / "scene_01.html"
    mtime = scene_path.stat().st_mtime
    os.utime(scene_path, (mtime + 10, mtime + 10))
    assert server._video_scene_confirmed_current(project_dir, scene) is False


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
    assert meta["phase"] == "producing"
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
    assert meta["phase"] == "producing"
    assert meta["outputStale"] is True


async def test_scene_add_invalidates_all_scenes(
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
    assert all(s["htmlStatus"] == "pending" for s in meta["scenes"])
    assert all("confirmedMtime" not in s for s in meta["scenes"])
    assert meta["phase"] == "producing"
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
    assert meta["phase"] == "producing"
    assert meta["outputStale"] is True


async def test_scene_regenerate_invalidates_confirmation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)

    async def _fake_llm(project_dir: Path, scene: dict, meta: dict) -> str:
        return "<html>regenerated</html>"

    monkeypatch.setattr(server, "_generate_scene_html_via_llm", _fake_llm)
    response = await server.handle_video_project_scene_regenerate(
        _post_request({"name": "proj", "index": 1})
    )
    assert response.status == 200
    meta = _read_meta(project_dir)
    scene1 = next(s for s in meta["scenes"] if s["index"] == 1)
    assert scene1["htmlStatus"] == "previewing"
    assert "confirmedMtime" not in scene1
    assert meta["phase"] == "producing"
    assert meta["outputStale"] is True
    html = (project_dir / "scenes" / "scene_01.html").read_text(encoding="utf-8")
    assert html == "<html>regenerated</html>"


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
    monkeypatch.setattr(
        importlib.util,
        "spec_from_file_location",
        lambda *args, **kwargs: _FakeRenderSpec(result, calls),
    )


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


async def test_ai_scene_rewrite_returns_undo_version(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    monkeypatch.setattr(server, "_sync_storyboard", lambda *_args, **_kwargs: None)

    async def _rewrite(_project_dir: Path, scene: dict, _requirement: str, _meta: dict):
        return {**scene, "title": "AI 新标题"}

    monkeypatch.setattr(server, "_rewrite_scene_via_llm", _rewrite)
    response = await server.handle_video_ai_scene_rewrite(
        _post_request({"name": "proj", "index": 1, "requirement": "突出重点"})
    )

    payload = _body(response)
    assert response.status == 200
    assert payload["scene"]["title"] == "AI 新标题"
    assert server._VIDEO_VERSION_ID_RE.fullmatch(payload["undoVersionId"])
    versions = server._list_video_project_versions(project_dir)
    assert versions[0]["reason"] == "ai-scene-rewrite"


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


async def test_project_localization_clones_structure_and_translates_content(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import mona.providers.factory as provider_factory

    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta.update(
        {
            "language": "zh-CN",
            "localeGroupId": "course-locales",
            "narrationEnabled": True,
            "ttsProvider": "edge",
            "ttsVoice": "zh-CN-XiaoyiNeural",
        }
    )
    meta["scenes"][0].update(
        {"title": "欢迎", "visual": "产品画面", "narration": "欢迎学习。"}
    )
    meta["scenes"][1].update(
        {"title": "总结", "visual": "总结画面", "narration": "下次再见。"}
    )
    _write_meta(project_dir, meta)
    (project_dir / "assets").mkdir(exist_ok=True)
    (project_dir / "assets" / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "assets": []}), encoding="utf-8"
    )

    class _Provider:
        async def chat_with_retry(self, **_kwargs):
            return types.SimpleNamespace(
                content=json.dumps(
                    {
                        "scenes": [
                            {
                                "index": 1,
                                "title": "Welcome",
                                "visual": "Product visual",
                                "narration": "Welcome to the course.",
                            },
                            {
                                "index": 2,
                                "title": "Summary",
                                "visual": "Summary visual",
                                "narration": "See you next time.",
                            },
                        ]
                    }
                )
            )

    monkeypatch.setattr(
        provider_factory,
        "load_provider_snapshot",
        lambda: types.SimpleNamespace(provider=_Provider(), model="test"),
    )

    response = await server.handle_video_project_localize(
        _post_request({"name": "proj", "targetLanguage": "en-US"})
    )

    assert response.status == 201
    localized_dir = tmp_path / "video_projects" / "proj-en_us"
    localized = _read_meta(localized_dir)
    assert localized["language"] == "en-US"
    assert localized["sourceProject"] == "proj"
    assert localized["localeGroupId"] == "course-locales"
    assert localized["ttsVoice"] == "en-US-JennyNeural"
    assert localized["phase"] == "storyboard"
    assert localized["storyboardLocked"] is False
    assert localized["scenes"][0]["title"] == "Welcome"
    assert localized["scenes"][0]["htmlStatus"] == "pending"
    assert not list((localized_dir / "scenes").glob("*.html"))
    assert (localized_dir / "assets" / "manifest.json").is_file()
    assert "Welcome" in (localized_dir / "storyboard.md").read_text(encoding="utf-8")
    assert _read_meta(project_dir)["scenes"][0]["title"] == "欢迎"


async def test_project_localization_rejects_same_language(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["language"] = "zh-CN"
    _write_meta(project_dir, meta)
    response = await server.handle_video_project_localize(
        _post_request({"name": "proj", "targetLanguage": "zh-CN"})
    )
    assert response.status == 409


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
    _patch_render_module(monkeypatch, {"ok": True, "output": "renders/output.mp4"})

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
    assert (project_dir / "audio" / "scene_01.mp3").is_file()
    assert (project_dir / "audio" / "scene_02.mp3").is_file()
    persisted = _read_meta(project_dir)
    assert persisted["scenes"][0]["audioMtime"] is not None
    status = json.loads(
        (project_dir / ".render_status.json").read_text(encoding="utf-8")
    )
    assert status["stage"] == "done"
    assert status["message"] == "渲染完成"


async def test_render_task_narration_failure_degrades_gracefully(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """全部场景 TTS 失败不阻塞导出；done message 注明无声降级。"""
    _patch_projects_dir(monkeypatch, tmp_path)
    project_dir = _setup_confirmed_project(tmp_path)
    meta = _read_meta(project_dir)
    meta["narrationEnabled"] = True
    meta["phase"] = "rendering"
    for s in meta["scenes"]:
        s["narration"] = f"旁白 {s['index']}"
    _write_meta(project_dir, meta)
    _patch_render_module(monkeypatch, {"ok": True, "output": "renders/output.mp4"})

    async def _fail_tts(*args, **kwargs):
        return None

    monkeypatch.setattr(server, "_synthesize_scene_narration", _fail_tts)
    await server._run_render_task(project_dir, 0, "standard")

    status = json.loads(
        (project_dir / ".render_status.json").read_text(encoding="utf-8")
    )
    assert status["stage"] == "done"
    assert "旁白合成失败，导出为无声视频" in status["message"]


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
    _patch_render_module(monkeypatch, {"ok": True, "output": "renders/output.mp4"})

    async def _fake_tts(pdir: Path, scene: dict, m: dict, *, force: bool = False):
        p = pdir / "audio" / f"scene_{scene['index']:02d}.mp3"
        p.write_bytes(b"mp3")
        scene["audioMtime"] = p.stat().st_mtime
        return b"mp3"

    monkeypatch.setattr(server, "_synthesize_scene_narration", _fake_tts)
    await server._run_render_task(project_dir, 0, "standard")

    assert not (audio_dir / "scene_99.mp3").exists()
    assert not (audio_dir / "narration.mp3").exists()  # 删除后由 render 重拼
    assert (audio_dir / "scene_01.mp3").is_file()
    assert (audio_dir / "scene_02.mp3").is_file()


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
                            (Path(path) / ".render_status.json").read_text(
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

    monkeypatch.setattr(
        importlib.util,
        "spec_from_file_location",
        lambda *args, **kwargs: _ProgressSpec(),
    )
    await server._run_render_task(project_dir, 0, "standard")

    assert len(snapshots) == 1
    assert snapshots[0]["stage"] == "rendering"
    assert snapshots[0]["progress"] == 20.0
    assert "帧 30/300" in snapshots[0]["message"]
    assert snapshots[0]["started_at"]  # 保留 started_at


# --- storyboard dual-source consistency (P0-1) ------------------------------


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
    """AI 裸写 storyboard.md（mtime > scenesUpdatedAt）→ GET 重解析并保留旧状态。"""
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
    # index 1 保留运行状态；index 2 是新解析内容 + 保留旧 ready 状态
    assert scenes[0]["htmlStatus"] == "confirmed"
    assert scenes[0]["confirmedMtime"] == 123.0
    assert scenes[0]["audioMtime"] == 456.0
    assert scenes[1]["htmlStatus"] == "ready"
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
