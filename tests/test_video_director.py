from __future__ import annotations

import hashlib
import io
import json
import math
import os
import struct
import subprocess
import wave
from pathlib import Path

import pytest
from aiohttp import web
from PIL import Image

import mona.agent  # noqa: F401
import mona.api.server as server
from mona.api.video_director import handle_video_agent
from mona.materials.auth import SERVICES_TOKEN_HEADER

OWNER_HEADER = "X-Mona-Video-Chat-Id"
OWNER = "video-chat-123"
TOKEN = "test-services-token"


class _Request:
    def __init__(self, body: dict, headers: dict[str, str] | None = None) -> None:
        self._body = body
        self.headers = headers or {}

    async def json(self) -> dict:
        return self._body


@pytest.fixture
def project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    project_dir = tmp_path / "video_projects" / "demo"
    for name in ("assets", "drafts", "renders", "scenes", "scene_sources", "style"):
        (project_dir / name).mkdir(parents=True)
    (project_dir / ".chat_id").write_text(OWNER, encoding="utf-8")
    (project_dir / "style" / "design-system.json").write_text(
        json.dumps({
            "mode": "dark",
            "tokens": {
                "colors": {
                    "primary": "#204060", "secondary": "#607080", "background": "#101820",
                    "surface": "#182430", "textPrimary": "#ffffff", "textSecondary": "#cccccc",
                    "border": "#304050", "accent": "#00ccaa",
                },
                "typography": {"headingFamily": "Arial", "bodyFamily": "Arial"},
                "shape": {"cardRadius": 4},
                "spacing": {"unit": 8, "contentPadding": 24},
            },
            "motion": {"intensity": "restrained"},
            "subtitle": {"fontSize": 24, "safeAreaBottom": 0.08},
        }),
        encoding="utf-8",
    )
    (project_dir / "meta.json").write_text(
        json.dumps({
            "name": "demo", "resolution": "320x180", "language": "en-US",
            "narrationEnabled": False, "subtitleMode": "off", "scenes": [],
            "phase": "producing",
        }),
        encoding="utf-8",
    )
    monkeypatch.setattr(server, "_video_projects_dir", lambda: tmp_path / "video_projects")
    monkeypatch.setattr(server, "_video_archived_projects_dir", lambda: tmp_path / "archived")
    monkeypatch.setattr(server, "_schedule_video_push", lambda *_args, **_kwargs: None)
    monkeypatch.setenv("MONA_SERVICES_TOKEN", TOKEN)
    return project_dir


def _request(body: dict, *, owner: str = OWNER, token: str = TOKEN) -> _Request:
    headers = {}
    if token:
        headers[SERVICES_TOKEN_HEADER] = token
    if owner:
        headers[OWNER_HEADER] = owner
    return _Request(body, headers)


async def _sync(
    project: Path,
    source: str,
    *,
    scene: dict | None = None,
    extra: dict | None = None,
):
    source_path = project / "drafts" / "scene_01.html"
    source_path.write_text(source, encoding="utf-8")
    return await handle_video_agent(_request({
        "action": "sync", "name": project.name, "scene_index": 1,
        "source_file": "drafts/scene_01.html",
        "scene": {"title": "A scene", "duration": 3, **(scene or {})}, **(extra or {}),
    }))


async def test_video_agent_requires_internal_token_and_bound_chat(project: Path) -> None:
    body = {"action": "inspect", "name": project.name}

    with pytest.raises(web.HTTPUnauthorized):
        await handle_video_agent(_Request(body, {OWNER_HEADER: OWNER}))
    with pytest.raises(web.HTTPForbidden):
        await handle_video_agent(_request(body, owner="another-chat"))

    response = await handle_video_agent(_request(body))
    assert response.status == 200
    assert json.loads(response.body)["ok"] is True


@pytest.mark.parametrize("source", [
    "<!doctype html><html><head><title>自由构图</title></head><body><main>HTML</main></body></html>",
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><circle cx="20" cy="20" r="12" fill="#00aa66"/></svg>',
    '<canvas id="scene" width="80" height="40"></canvas><script>document.querySelector("canvas").getContext("2d").fillRect(0,0,30,30)</script>',
])
async def test_sync_accepts_authored_html_svg_and_canvas_without_builtin_layout(
    project: Path, source: str
) -> None:
    response = await _sync(project, source)

    assert response.status == 200
    payload = json.loads(response.body)
    assert payload["ok"] is True
    scene = payload["scene"]
    assert scene["layout"] == "authored"
    assert scene["htmlStatus"] == "previewing"
    assert scene["sourcePath"] == "scene_sources/scene_01.html"
    assert (project / scene["sourcePath"]).read_text(encoding="utf-8") == source
    assert (project / scene["htmlPath"]).is_file()
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert meta["authoringMode"] == "agent"
    assert meta["phase"] == "exportable"
    assert server._video_scene_ready(project, scene)


async def test_sync_rejects_source_file_outside_project_without_writing(project: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside.html"
    outside.write_text("<h1>temporary external fixture</h1>", encoding="utf-8")

    response = await handle_video_agent(_request({
        "action": "sync", "name": project.name, "scene_index": 1,
        "source_file": str(outside), "scene": {"title": "Unsafe", "duration": 3},
    }))

    assert response.status == 422
    assert json.loads(response.body)["ok"] is False
    assert not (project / "scene_sources" / "scene_01.html").exists()
    assert not (project / "scenes" / "scene_01.html").exists()
    assert json.loads((project / "meta.json").read_text(encoding="utf-8"))["scenes"] == []


async def test_syncing_edit_keeps_previous_source_and_rendered_scene_in_version(
    project: Path,
) -> None:
    old_source = '<!doctype html><html><body><svg id="old-scene"><text>OLD VERSION</text></svg></body></html>'
    new_source = '<!doctype html><html><body><svg id="new-scene"><text>NEW VERSION</text></svg></body></html>'

    first = await _sync(project, old_source)
    assert first.status == 200
    old_rendered = (project / json.loads(first.body)["scene"]["htmlPath"]).read_bytes()

    second = await _sync(project, new_source, scene={"title": "Updated scene"})
    assert second.status == 200
    versions = list((project / "versions").iterdir())
    assert len(versions) == 1
    snapshot = versions[0]
    assert (snapshot / "scene_sources" / "scene_01.html").read_text(encoding="utf-8") == old_source
    assert (snapshot / "scenes" / "scene_01.html").read_bytes() == old_rendered
    assert (project / "scene_sources" / "scene_01.html").read_text(encoding="utf-8") == new_source
    assert b"NEW VERSION" in (project / "scenes" / "scene_01.html").read_bytes()


async def test_authored_scene_is_ready_only_while_source_hash_matches_current_bytes(
    project: Path,
) -> None:
    response = await _sync(project, '<!doctype html><svg id="authored"></svg>')
    assert response.status == 200
    scene = json.loads(response.body)["scene"]
    source = project / "scene_sources" / "scene_01.html"

    assert scene["sourceHash"] == hashlib.sha256(source.read_bytes()).hexdigest()
    assert server._video_scene_ready(project, scene)

    source.write_bytes(source.read_bytes() + b"<!-- uncommitted edit -->\r\n")
    assert not server._video_scene_ready(project, scene)


def _tone_wav(duration: float, *, sample_rate: int = 8_000) -> bytes:
    samples = bytearray()
    for index in range(round(duration * sample_rate)):
        value = round(7_000 * math.sin(2 * math.pi * 440 * index / sample_rate))
        samples.extend(struct.pack("<h", value))
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples)
    return buffer.getvalue()


async def test_changed_narration_and_long_tts_refresh_subtitles_without_replacing_authored_svg(
    project: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import mona.providers.tts as tts

    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    meta.update({"narrationEnabled": True, "subtitleMode": "burned", "ttsProvider": "edge"})
    (project / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    source = '''<!doctype html><html><body>
<svg id="custom-svg" xmlns="http://www.w3.org/2000/svg" width="320" height="180">
<circle cx="90" cy="90" r="40" fill="#00ccaa"/><text x="20" y="30">CUSTOM COMPOSITION</text></svg>
</body></html>'''
    previous_narration = "旧旁白。"
    changed_narration = "更新后的旁白需要完整字幕。"
    first = await _sync(project, source, scene={"narration": previous_narration})
    assert first.status == 200
    meta = server._load_video_meta(project)

    class _LocalToneProvider:
        def __init__(self) -> None:
            self.calls: list[str] = []

        async def synthesize_with_timings(self, text: str, voice: str = ""):
            self.calls.append(text)
            if text == previous_narration:
                duration, end_ms = 0.8, 500
            else:
                duration, end_ms = 4.25, 1_600
            return tts.TTSSynthesisResult(
                audio=_tone_wav(duration),
                boundaries=({"text": text, "startMs": 0, "endMs": end_ms},),
                timing_source="local-tone-fixture",
            )

    provider = _LocalToneProvider()
    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: provider)
    first_scene = meta["scenes"][0]
    assert await server._synthesize_scene_narration(project, first_scene, meta)
    server._save_video_meta(project, meta)
    assert (project / first_scene["audioTimingPath"]).is_file()

    second = await _sync(project, source, scene={"narration": changed_narration})
    assert second.status == 200
    meta = server._load_video_meta(project)
    scene = meta["scenes"][0]
    assert "audioMtime" not in scene
    assert not (project / "audio" / "scene_01.timing.json").exists()

    audio = await server._synthesize_scene_narration(project, scene, meta)
    assert audio
    server._save_video_meta(project, meta)

    audio_duration = await server._scene_audio_duration(project / "audio" / "scene_01.mp3")
    assert audio_duration == pytest.approx(4.25, abs=0.05)
    assert scene["duration"] == 5
    assert provider.calls == [previous_narration, changed_narration]
    assert scene["sourceHash"] == hashlib.sha256(
        (project / "scene_sources" / "scene_01.html").read_bytes()
    ).hexdigest()
    assert server._video_scene_ready(project, scene)

    current_html = (project / "scenes" / "scene_01.html").read_text(encoding="utf-8")
    timing = json.loads((project / "audio" / "scene_01.timing.json").read_text(encoding="utf-8"))
    assert 'id=&quot;custom-svg&quot;' in current_html
    assert "CUSTOM COMPOSITION" in current_html
    assert changed_narration in current_html
    assert timing["cues"][0]["text"] == changed_narration
    assert meta["phase"] == "exportable"


async def test_authored_scene_exports_through_production_edge_ffmpeg_pipeline(
    project: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    import mona.providers.tts as tts
    from mona.api.video_runtime import VideoRuntime

    runtime = VideoRuntime()
    browser = runtime.get_chrome_path()
    ffmpeg = runtime.get_ffmpeg_path()
    ffprobe = runtime.get_ffprobe_path()
    if not browser or not ffmpeg or not ffprobe:
        pytest.skip("VideoRuntime requires a local Edge/Chrome, FFmpeg, and FFprobe")

    meta = server._load_video_meta(project)
    meta.update({
        "resolution": "1920x1080", "narrationEnabled": True,
        "subtitleMode": "burned", "ttsProvider": "edge",
    })
    server._save_video_meta(project, meta)
    source = '''<!doctype html><html><body>
    <svg id="export-authored-scene" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"
         style="position:absolute;inset:0;width:1920px;height:1080px">
      <rect width="1920" height="1080" fill="#102030"/>
      <rect x="20" y="20" width="600" height="600" fill="#ff00ff"/>
      <text x="720" y="450" fill="#ffffff" font-size="72">AUTHORED SVG</text>
</svg></body></html>'''
    sync = await _sync(project, source, scene={
        "title": "Authored scene", "duration": 3, "narration": "本地合成语音用于真实导出验收。",
    })
    assert sync.status == 200
    assert server._video_scene_ready(project, json.loads(sync.body)["scene"])

    class _OfflineToneProvider:
        async def synthesize_with_timings(self, text: str, voice: str = ""):
            return tts.TTSSynthesisResult(
                audio=_tone_wav(1.25),
                boundaries=({"text": text, "startMs": 0, "endMs": 1_000},),
                timing_source="local-export-fixture",
            )

    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: _OfflineToneProvider())
    name = project.name
    assert name not in server._video_render_tasks or server._video_render_tasks[name].done()
    queued = await server.handle_video_project_export(_Request({
        "name": name, "quality": "draft", "renderEngine": "auto", "releaseType": "draft",
    }))
    assert queued.status == 200
    assert json.loads(queued.body)["ok"] is True
    task = server._video_render_tasks[name]
    await task

    status = server._read_render_status(project)
    assert status["stage"] == "done", status
    assert status["requestedEngine"] == "auto"
    assert status["actualEngine"] == "legacy"
    assert status["audio"] is True
    assert status["resolution"] == [960, 540]
    output = project / "renders" / "output.mp4"
    assert output.is_file() and output.stat().st_size > 0
    probe = await server._probe_video_output(output, ffprobe)
    assert probe.get("streams")
    assert float(probe["format"]["duration"]) == pytest.approx(3.0, abs=0.2)
    assert await server._video_output_has_audio(output, ffprobe)

    frame_path = tmp_path / "exported-frame.png"
    extracted = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", str(output),
         "-frames:v", "1", str(frame_path)],
        capture_output=True, timeout=30, check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
    )
    assert extracted.returncode == 0, extracted.stderr.decode("utf-8", errors="replace")
    with Image.open(frame_path) as frame:
        red, green, blue = frame.convert("RGB").getpixel((100, 100))
    assert red > 120 and blue > 120 and green < 120


async def test_real_browser_preview_seeks_canvas_embeds_local_asset_and_blocks_outside_file(
    project: Path, tmp_path: Path
) -> None:
    from mona.api.video_runtime import VideoRuntime

    browser = VideoRuntime().get_chrome_path()
    if not browser:
        pytest.skip("VideoRuntime did not find a local Edge/Chrome runtime")

    asset = project / "assets" / "swatch.svg"
    asset.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#ffff00"/></svg>',
        encoding="utf-8",
    )
    outside = tmp_path / "outside.svg"
    outside.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#ff00ff"/></svg>',
        encoding="utf-8",
    )
    private_url = json.dumps(outside.as_uri())
    source = f'''<!doctype html><html><head></head><body>
<canvas id="scene" width="320" height="180"></canvas>
<img src="assets/swatch.svg" style="position:absolute;left:150px;top:10px;width:24px;height:24px">
<script>
const canvas=document.getElementById("scene"),ctx=canvas.getContext("2d");
let outsideReadable=false;
function seek(seconds){{
  ctx.clearRect(0,0,320,180);
  ctx.fillStyle=seconds<1?"#ff0000":"#0000ff";ctx.fillRect(10,10,40,40);
  ctx.fillStyle=outsideReadable?"#ff00ff":"#00ff00";ctx.fillRect(70,10,30,30);
}}
window.__monaSeek=seek;seek(0);
fetch({private_url}).then(r=>r.text()).then(text=>{{
  outsideReadable=text.includes("ff00ff");seek(0);
  parent.postMessage({{type:"mona-scene-report",outsideFileReadable:outsideReadable}},"*");
}}).catch(()=>{{
  outsideReadable=false;seek(0);
  parent.postMessage({{type:"mona-scene-report",outsideFileReadable:false}},"*");
}});
</script></body></html>'''

    synced = await _sync(project, source)
    assert synced.status == 200
    rendered = project / json.loads(synced.body)["scene"]["htmlPath"]
    rendered_text = rendered.read_text(encoding="utf-8")
    assert "data:image/svg+xml;base64," in rendered_text
    assert 'sandbox="allow-scripts"' in rendered_text
    assert "allow-same-origin" not in rendered_text

    response = await handle_video_agent(_request({
        "action": "preview", "name": project.name, "scene_index": 1,
    }))
    assert response.status == 200, response.body.decode("utf-8", errors="replace")
    payload = json.loads(response.body)
    frames = payload["frames"]
    assert len(frames) == 3
    assert [frame["seconds"] for frame in frames] == [0.03, 1.5, 2.76]
    images = [Image.open(frame["path"]).convert("RGB") for frame in frames]
    try:
        assert images[0].getpixel((20, 20))[0] > 200
        assert images[1].getpixel((20, 20))[2] > 200
        assert images[2].getpixel((20, 20))[2] > 200
        assert images[1].getpixel((160, 20)) == (255, 255, 0)
        assert images[1].getpixel((80, 20)) == (0, 255, 0)
        assert any(item.get("outsideFileReadable") is False for item in payload["diagnostics"])
    finally:
        for image in images:
            image.close()


async def test_visual_only_edit_keeps_original_voice_and_exact_subtitle_timings(
    project: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import mona.providers.tts as tts

    meta = server._load_video_meta(project)
    meta.update({"narrationEnabled": True, "subtitleMode": "burned", "ttsProvider": "edge"})
    server._save_video_meta(project, meta)
    narration = "保留原来的旁白和字幕。"
    first = await _sync(project, '<svg><text>Original visual</text></svg>', scene={"narration": narration})
    assert first.status == 200
    calls = []

    class Provider:
        async def synthesize_with_timings(self, text, voice=""):
            calls.append(text)
            return tts.TTSSynthesisResult(audio=_tone_wav(.8), boundaries=({"text": text, "startMs": 100, "endMs": 650},), timing_source="provider-boundary")

    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: Provider())
    meta = server._load_video_meta(project)
    assert await server._synthesize_scene_narration(project, meta["scenes"][0], meta)
    server._save_video_meta(project, meta)
    timing = (project / "audio" / "scene_01.timing.json").read_bytes()

    updated = await _sync(project, '<svg><text>Revised visual</text></svg>', scene={"narration": narration})
    assert updated.status == 200
    assert (project / "audio" / "scene_01.timing.json").read_bytes() == timing
    assert narration in (project / "scenes" / "scene_01.html").read_text(encoding="utf-8")
    meta = server._load_video_meta(project)
    assert await server._synthesize_scene_narration(project, meta["scenes"][0], meta)
    assert calls == [narration]
    assert meta["scenes"][0]["audioTimingSource"] == "provider-boundary"


async def _plan(project: Path, **extra):
    return await handle_video_agent(_request({"action": "plan", "name": project.name, "scenes": [{
        "title": "比较两种选择", "duration": 3, "visual": "左右显示两个方案",
        "animation": "口播比较时，指标依次增长，优势项被强调",
        "narration": "我们比较这两种选择。", "assets": [],
    }], **extra}))


async def test_plan_waits_for_user_confirmation_and_rejects_stale_generation(project: Path) -> None:
    response = await _plan(project)
    assert response.status == 200
    assert json.loads(response.body)["planRevision"] == 1
    meta = server._load_video_meta(project)
    assert meta["phase"] == "storyboard"
    assert meta["approvedPlanRevision"] is None
    assert not list((project / "scenes").glob("*"))
    assert not (project / "audio").exists()
    unchanged = await _plan(project)
    assert json.loads(unchanged.body)["planRevision"] == 1

    draft = project / "drafts" / "scene_01.html"
    draft.write_text("<div>Two alternatives</div>", encoding="utf-8")
    request = {"action": "sync", "name": project.name, "scene_index": 1,
               "source_file": "drafts/scene_01.html", "plan_revision": 1}
    blocked = await handle_video_agent(_request(request))
    assert blocked.status == 422
    assert "导演台" in json.loads(blocked.body)["error"]
    wrong = await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 0}))
    assert wrong.status == 409
    confirmed = await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))
    assert confirmed.status == 200
    saved = await handle_video_agent(_request(request))
    assert saved.status == 200
    changed_during_sync = await handle_video_agent(_request({**request, "scene": {"narration": "未经确认的新旁白"}}))
    assert changed_during_sync.status == 422

    update = await server.handle_video_project_scene_update(_Request({"name": project.name, "index": 1, "animation": "比较后把胜出方案移到中央"}))
    assert json.loads(update.body)["planRevision"] == 2
    current = server._load_video_meta(project)
    assert current["phase"] == "storyboard"
    assert current["approvedPlanRevision"] is None
    same = await server.handle_video_project_scene_update(_Request({"name": project.name, "index": 1, "animation": "比较后把胜出方案移到中央"}))
    assert json.loads(same.body)["planRevision"] == 2
    assert (await handle_video_agent(_request(request))).status == 422
    confirmed = await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 2}))
    assert confirmed.status == 200
    assert (await handle_video_agent(_request(request))).status == 422
    assert (await handle_video_agent(_request({**request, "plan_revision": 2}))).status == 200


async def test_unconfirmed_plan_blocks_direct_narration_and_export_entry_points(project: Path) -> None:
    await _plan(project)
    meta = server._load_video_meta(project)
    meta["narrationEnabled"] = True
    server._save_video_meta(project, meta)
    request = _Request({"name": project.name, "index": 1})
    request.method = "POST"
    narration = await server.handle_video_project_scene_narration(request)
    assert narration.status == 409
    assert json.loads(narration.body)["code"] == "PLAN_CONFIRMATION_REQUIRED"
    exported = await server.handle_video_project_export(_Request({"name": project.name}))
    assert exported.status == 409
    assert json.loads(exported.body)["code"] == "PLAN_CONFIRMATION_REQUIRED"
    agent_confirm = await handle_video_agent(_request({"action": "confirm", "name": project.name}))
    assert agent_confirm.status == 422


async def test_audio_returns_real_word_track_and_duration_extension_keeps_approval(project: Path, monkeypatch) -> None:
    import mona.providers.tts as tts

    await _plan(project)
    meta = server._load_video_meta(project)
    meta.update({"narrationEnabled": True, "ttsProvider": "edge"})
    server._save_video_meta(project, meta)
    await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))

    class Provider:
        async def synthesize_with_timings(self, text, voice=""):
            return tts.TTSSynthesisResult(audio=_tone_wav(.8), boundaries=({"text": text, "startMs": 100, "endMs": 4200},), timing_source="provider-boundary")

    async def audio_duration(_path):
        return 4.5

    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: Provider())
    monkeypatch.setattr(server, "_scene_audio_duration", audio_duration)
    response = await handle_video_agent(_request({"action": "audio", "name": project.name, "scene_index": 1, "plan_revision": 1}))
    assert response.status == 200
    payload = json.loads(response.body)
    assert payload["subtitleTrack"]["timingSource"] == "provider-boundary"
    assert payload["subtitleTrack"]["cues"][0]["words"][0]["startMs"] == 100
    meta = server._load_video_meta(project)
    assert meta["scenes"][0]["duration"] == 5
    assert meta["planRevision"] == meta["approvedPlanRevision"] == 1


async def test_audio_cannot_write_back_after_user_changes_plan_revision(project: Path, monkeypatch) -> None:
    import mona.providers.tts as tts

    await _plan(project)
    meta = server._load_video_meta(project)
    meta["narrationEnabled"] = True
    server._save_video_meta(project, meta)
    await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))

    class Provider:
        async def synthesize_with_timings(self, text, voice=""):
            current = server._load_video_meta(project)
            server._video_plan_changed(current)
            server._save_video_meta(project, current)
            return tts.TTSSynthesisResult(audio=_tone_wav(.8), boundaries=({"text": text, "startMs": 100, "endMs": 650},), timing_source="provider-boundary")

    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: Provider())
    response = await handle_video_agent(_request({"action": "audio", "name": project.name, "scene_index": 1, "plan_revision": 1}))
    assert response.status == 409
    assert json.loads(response.body)["code"] == "NARRATION_INPUT_CHANGED"
    meta = server._load_video_meta(project)
    assert meta["planRevision"] == 2
    assert meta["approvedPlanRevision"] is None
    assert not (project / "audio" / "scene_01.mp3").exists()


async def test_scene_editor_cannot_write_over_unseen_plan_revision(project: Path) -> None:
    await _plan(project)
    before = (project / "meta.json").read_bytes()
    response = await server.handle_video_project_scene_update(_Request({"name": project.name, "index": 1, "title": "未见最新方案的编辑", "expectedPlanRevision": 0}))
    assert response.status == 409
    assert json.loads(response.body)["planRevision"] == 1
    assert (project / "meta.json").read_bytes() == before


async def test_preview_cannot_overwrite_plan_edits_during_frame_capture(project: Path, monkeypatch) -> None:
    from mona.api import video_director

    meta = server._load_video_meta(project)
    meta["authoringMode"] = "remotion"
    server._save_video_meta(project, meta)
    await _plan(project)
    await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))
    draft = project / "drafts" / "scene_01.tsx"
    draft.write_text("export default function Scene() { return <div>Alternatives</div>; }", encoding="utf-8")
    synced = await handle_video_agent(_request({"action": "sync", "name": project.name, "scene_index": 1,
                                              "plan_revision": 1, "source_file": "drafts/scene_01.tsx"}))
    assert synced.status == 200

    async def capture(_project, _scene, _meta):
        edited = await server.handle_video_project_scene_update(_Request({"name": project.name, "index": 1,
                                                                          "animation": "用户刚调整的动画方案", "expectedPlanRevision": 1}))
        assert edited.status == 200
        return {"frames": [], "motionReview": {"status": "passed"}, "diagnostics": []}

    monkeypatch.setattr(video_director, "_capture_frames", capture)
    preview = await handle_video_agent(_request({"action": "preview", "name": project.name, "scene_index": 1, "plan_revision": 1}))
    assert preview.status == 422
    current = server._load_video_meta(project)
    assert current["planRevision"] == 2
    assert current["approvedPlanRevision"] is None
    assert current["scenes"][0]["animation"] == "用户刚调整的动画方案"
    assert "motionReview" not in current["scenes"][0]


@pytest.mark.parametrize("review_state", ["missing", "static", "stale-source"])
async def test_remotion_export_requires_observed_motion_for_current_source(project: Path, review_state: str) -> None:
    await _plan(project)
    await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))
    draft = project / "drafts/scene_01.tsx"
    draft.write_text("export default function Scene(){return <div>Alternatives</div>}", encoding="utf-8")
    synced = await handle_video_agent(_request({"action": "sync", "name": project.name, "scene_index": 1,
                                               "plan_revision": 1, "source_file": "drafts/scene_01.tsx"}))
    assert synced.status == 200
    meta = server._load_video_meta(project)
    scene = meta["scenes"][0]
    if review_state != "missing":
        scene["motionReview"] = {"distinctVisualStates": 1 if review_state == "static" else 2}
        scene["motionReviewSourceHash"] = scene["sourceHash"] if review_state == "static" else "previous-source"
        server._save_video_meta(project, meta)
    result = await server.handle_video_project_export(_Request({"name": project.name}))
    assert result.status == 409
    assert json.loads(result.body)["code"] == "MOTION_REVIEW_REQUIRED"
    assert project.name not in server._video_render_tasks


async def test_audio_component_failure_preserves_confirmed_plan_and_voice(project: Path, monkeypatch) -> None:
    import mona.providers.tts as tts

    await _plan(project)
    await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))
    meta = server._load_video_meta(project)
    meta.update({"narrationEnabled": True, "ttsVoice": "zh-CN-XiaoyiNeural"})
    server._save_video_meta(project, meta)

    class Provider:
        async def synthesize_with_timings(self, _text, voice=""):
            raise tts.TTSError("配音组件未准备好，请更新应用后重试。", code="TTS_COMPONENT_MISSING")

    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: Provider())
    response = await handle_video_agent(_request({"action": "audio", "name": project.name, "scene_index": 1, "plan_revision": 1}))
    assert response.status == 503
    payload = json.loads(response.body)
    assert payload["code"] == "TTS_COMPONENT_MISSING"
    assert payload["retryable"] is False
    assert "配音组件未准备好" in payload["error"]
    current = server._load_video_meta(project)
    assert current["ttsVoice"] == "zh-CN-XiaoyiNeural"
    assert current["planRevision"] == current["approvedPlanRevision"] == 1
    assert not (project / "audio/scene_01.mp3").exists()
