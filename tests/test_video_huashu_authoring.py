"""The director authorizes one film; sync cannot silently edit the approved script."""

import hashlib
import json
from types import SimpleNamespace

import pytest
from aiohttp import web
from test_video_director import OWNER, _request
from test_video_director import project as project_fixture

from mona.api import server
from mona.api.video_director import handle_video_agent

project = project_fixture

SOURCE = '''<!doctype html><html><head></head><body>
<div data-composition-id="film" data-width="320" data-height="180"><div id="subject">Explain</div></div>
<script>const tl=gsap.timeline({paused:true});tl.to('#subject',{x:200,duration:2});window.__timelines={film:tl};</script>
</body></html>'''


def _prepared(project, *, approved=True):
    meta = server._load_video_meta(project)
    meta.update({"authoringMode": "huashu-motion", "requirePlanApproval": True,
                 "planRevision": 1, "approvedPlanRevision": 1 if approved else None,
                 "scenes": [{"index": index, "duration": 1, "title": f"Part {index}",
                             "narration": "", "visual": "one object", "animation": "moves continuously", "assets": []}
                            for index in (1, 2)]})
    server._save_video_meta(project, meta)
    (project / "drafts/film.html").write_text(SOURCE, encoding="utf-8")


async def test_sync_saves_one_film_and_invalidates_every_segment_review(project):
    _prepared(project)
    response = await handle_video_agent(_request({"name": "demo", "action": "sync", "plan_revision": 1, "source_file": "drafts/film.html"}))
    assert response.status == 200
    meta = server._load_video_meta(project)
    assert meta["composition"]["sourcePath"] == "scene_sources/film.html"
    assert [scene["compositionStartSeconds"] for scene in meta["scenes"]] == [0, 1]
    assert {scene["sourcePath"] for scene in meta["scenes"]} == {"scene_sources/film.html"}
    assert {scene["sourceHash"] for scene in meta["scenes"]} == {hashlib.sha256((project / "scene_sources/film.html").read_bytes()).hexdigest()}
    assert all(server._video_scene_ready(project, scene) for scene in meta["scenes"])
    for scene in meta["scenes"]:
        scene.update({"motionReviewSourceHash": scene["sourceHash"], "motionReview": {"distinctVisualStates": 3}, "audioInputHash": "unchanged"})
    server._save_video_meta(project, meta)
    changed = SOURCE.replace('x:200', 'x:240')
    (project / "drafts/film.html").write_text(changed, encoding="utf-8")
    response = await handle_video_agent(_request({"name": "demo", "action": "sync", "plan_revision": 1}))
    assert response.status == 200
    updated = server._load_video_meta(project)
    assert all("motionReview" not in scene and scene["audioInputHash"] == "unchanged" for scene in updated["scenes"])
    assert updated["approvedPlanRevision"] == 1


async def test_sync_requires_current_director_confirmation_before_writing(project):
    _prepared(project, approved=False)
    response = await handle_video_agent(_request({"name": "demo", "action": "sync", "plan_revision": 1}))
    assert response.status == 422
    assert not (project / "scene_sources/film.html").exists()


async def test_sync_rejects_outside_source_and_approved_content_changes(project, tmp_path):
    _prepared(project)
    outside = tmp_path / "outside.html"
    outside.write_text(SOURCE, encoding="utf-8")
    for patch in ({"source_file": str(outside)}, {"scene_index": 1, "scene": {"duration": 8}}):
        response = await handle_video_agent(_request({"name": "demo", "action": "sync", "plan_revision": 1, **patch}))
        assert response.status == 422
    assert not (project / "scene_sources/film.html").exists()


async def test_sync_never_accepts_another_projects_session(project):
    _prepared(project)
    with pytest.raises(web.HTTPForbidden):
        await handle_video_agent(_request({"name": "demo", "action": "sync", "plan_revision": 1}, owner=OWNER + "-other"))
    assert not (project / "scene_sources/film.html").exists()


def test_new_order_requires_a_fresh_film_without_reusing_old_time_slices(project):
    _prepared(project)
    meta = server._load_video_meta(project)
    meta["composition"] = {"sourcePath": "scene_sources/film.html", "htmlPath": "composition/index.html"}
    for scene in meta["scenes"]:
        scene.update({"authored": True, "authoredRuntime": "huashu-motion", "htmlStatus": "previewing", "motionReview": {"distinctVisualStates": 2}})
    server._replace_video_scene_order(project, meta, list(reversed(meta["scenes"])))
    assert "composition" not in meta
    assert meta["approvedPlanRevision"] is None
    assert all(scene["htmlStatus"] == "pending" and "motionReview" not in scene for scene in meta["scenes"])
    assert meta["scenes"][0]["title"] == "Part 2"


async def test_sync_write_failure_restores_source_full_film_and_every_time_slice(project, monkeypatch):
    import mona.video_authoring as authoring

    _prepared(project)
    request = {"name": "demo", "action": "sync", "plan_revision": 1}
    assert (await handle_video_agent(_request(request))).status == 200
    paths = [project / "scene_sources/film.html", project / "composition/index.html",
             project / "scenes/scene_01.html", project / "scenes/scene_02.html", project / "meta.json"]
    saved = {path: path.read_bytes() for path in paths}
    (project / "drafts/film.html").write_text(SOURCE.replace("Explain", "Different film"), encoding="utf-8")
    original_write = authoring._write_changed

    def fail_second_slice(path, text):
        if path.name == "scene_02.html":
            raise OSError("synthetic file occupation")
        return original_write(path, text)

    monkeypatch.setattr(authoring, "_write_changed", fail_second_slice)
    assert (await handle_video_agent(_request(request))).status == 422
    assert all(path.read_bytes() == data for path, data in saved.items())


async def test_repeated_full_film_refresh_is_successful_for_every_segment(project):
    from mona.video_authoring import refresh_authored_scene

    _prepared(project)
    assert (await handle_video_agent(_request({"name": "demo", "action": "sync", "plan_revision": 1}))).status == 200
    meta = server._load_video_meta(project)
    before = (project / "composition/index.html").stat().st_mtime_ns
    for _ in range(2):
        assert all(refresh_authored_scene(project, scene, meta) for scene in meta["scenes"])
    assert (project / "composition/index.html").stat().st_mtime_ns == before


async def test_full_preview_merges_later_speech_duration_before_rebuilding_offsets(project, monkeypatch):
    import mona.api.video_audio as audio_api
    from mona.video_authoring import refresh_huashu_composition

    _prepared(project)
    meta = server._load_video_meta(project)
    meta["scenes"].append({**meta["scenes"][0], "index": 3, "title": "Part 3"})
    server._save_video_meta(project, meta)
    assert (await handle_video_agent(_request({"name": "demo", "action": "sync", "plan_revision": 1}))).status == 200
    meta = server._load_video_meta(project)
    meta["narrationEnabled"] = True
    for scene in meta["scenes"]:
        scene["narration"] = f"Speech {scene['index']}"
    server._sync_storyboard(project, meta["scenes"])
    server._save_video_meta(project, meta)

    async def synthesize(project_dir, scene, current_meta):
        if scene["index"] == 2:
            scene["duration"] = 4
        (project_dir / "audio").mkdir(exist_ok=True)
        (project_dir / "audio" / f"scene_{scene['index']:02d}.timing.json").write_text(json.dumps({
            "cues": [{"text": scene["narration"], "startMs": 0, "endMs": 500}],
        }), encoding="utf-8")
        refresh_huashu_composition(project_dir, current_meta)
        return b"prepared at the speech service boundary"

    async def mixed_audio(_project):
        return None

    monkeypatch.setattr(server, "_synthesize_scene_narration", synthesize)
    monkeypatch.setattr(audio_api, "prepare_preview_audio", mixed_audio)
    response = await server.handle_video_project_preview_full(SimpleNamespace(query={"name": "demo"}))
    assert response.status == 200, response.body
    final = server._load_video_meta(project)
    assert [scene["compositionStartSeconds"] for scene in final["scenes"]] == [0, 1, 5]
    assert "+5.0,requestId" in (project / "scenes/scene_03.html").read_text(encoding="utf-8")
