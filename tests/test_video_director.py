from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import os
import shutil
import struct
import subprocess
import wave
from pathlib import Path

import pytest
from aiohttp import web
from PIL import Image, ImageDraw

import mona.agent  # noqa: F401
import mona.api.server as server
import mona.api.video_director as video_director
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
    monkeypatch.setattr(server, "get_workspace_path", lambda: tmp_path)
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
    meta = server._load_video_meta(project)
    if not meta.get("scenes"):
        planned = await handle_video_agent(_request({"action": "plan", "name": project.name, "scenes": [{
            "title": "A scene", "duration": 3, "visual": "A continuous authored object",
            "animation": "The object follows the narration", "narration": "", "assets": [], **(scene or {}),
        }]}))
        assert planned.status == 200, planned.text
        confirmed = await server.handle_video_project_confirm(_Request({
            "name": project.name, "expectedPlanRevision": json.loads(planned.body)["planRevision"],
        }))
        assert confirmed.status == 200
        meta = server._load_video_meta(project)
    source_path = project / "drafts" / "film.html"
    source_path.write_text(source, encoding="utf-8")
    return await handle_video_agent(_request({
        "action": "sync", "name": project.name, "scene_index": 1,
        "source_file": "drafts/film.html", "plan_revision": meta.get("planRevision", 0), **(extra or {}),
    }))


def _film(content: str, *, animation: str = "") -> str:
    return ('<!doctype html><html><head></head><body><main data-composition-id="film" '
            'data-width="320" data-height="180">' + content + '</main>'
            + ('<script>' + animation + '</script>' if animation else '') + '</body></html>')


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
    _film('<h1>自由构图</h1>'),
    _film('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><circle cx="20" cy="20" r="12" fill="#00aa66"/></svg>'),
    _film('<canvas id="scene" width="80" height="40"></canvas><script>document.querySelector("canvas").getContext("2d").fillRect(0,0,30,30)</script>'),
])
async def test_sync_accepts_authored_html_svg_and_canvas_without_builtin_layout(
    project: Path, source: str
) -> None:
    response = await _sync(project, source)

    assert response.status == 200
    payload = json.loads(response.body)
    assert payload["ok"] is True
    scene = payload["scenes"][0]
    assert scene["layout"] == "authored"
    assert scene["htmlStatus"] == "previewing"
    assert scene["sourcePath"] == "scene_sources/film.html"
    assert (project / scene["sourcePath"]).read_text(encoding="utf-8") == source
    assert (project / scene["htmlPath"]).is_file()
    meta = json.loads((project / "meta.json").read_text(encoding="utf-8"))
    assert meta["authoringMode"] == "huashu-motion"
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
    assert not (project / "scene_sources" / "film.html").exists()
    assert not (project / "scenes" / "scene_01.html").exists()
    assert json.loads((project / "meta.json").read_text(encoding="utf-8"))["scenes"] == []


async def test_syncing_edit_keeps_previous_source_and_rendered_scene_in_version(
    project: Path,
) -> None:
    old_source = _film('<svg id="old-scene"><text>OLD VERSION</text></svg>')
    new_source = _film('<svg id="new-scene"><text>NEW VERSION</text></svg>')

    first = await _sync(project, old_source)
    assert first.status == 200
    old_rendered = (project / json.loads(first.body)["scenes"][0]["htmlPath"]).read_bytes()
    existing_versions = set((project / "versions").iterdir())

    second = await _sync(project, new_source)
    assert second.status == 200
    versions = list(set((project / "versions").iterdir()) - existing_versions)
    assert len(versions) == 1
    snapshot = versions[0]
    assert (snapshot / "scene_sources" / "film.html").read_text(encoding="utf-8") == old_source
    assert (snapshot / "scenes" / "scene_01.html").read_bytes() == old_rendered
    assert (project / "scene_sources" / "film.html").read_text(encoding="utf-8") == new_source
    assert b"NEW VERSION" in (project / "scenes" / "scene_01.html").read_bytes()


async def test_authored_scene_is_ready_only_while_source_hash_matches_current_bytes(
    project: Path,
) -> None:
    response = await _sync(project, _film('<svg id="authored"></svg>'))
    assert response.status == 200
    scene = json.loads(response.body)["scenes"][0]
    source = project / "scene_sources" / "film.html"

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
    source = _film('''
<svg id="custom-svg" xmlns="http://www.w3.org/2000/svg" width="320" height="180">
<circle cx="90" cy="90" r="40" fill="#00ccaa"/><text x="20" y="30">CUSTOM COMPOSITION</text></svg>
''')
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

    edited = await handle_video_agent(_request({
        "action": "edit", "name": project.name, "scene_index": 1, "plan_revision": 1,
        "instruction": "将旁白更新为新的说法。", "scene": {"narration": changed_narration},
    }))
    assert edited.status == 200
    second = await _sync(project, source)
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
        (project / "scene_sources" / "film.html").read_bytes()
    ).hexdigest()
    assert server._video_scene_ready(project, scene)

    current_html = (project / "scenes" / "scene_01.html").read_text(encoding="utf-8")
    timing = json.loads((project / "audio" / "scene_01.timing.json").read_text(encoding="utf-8"))
    assert 'id=\\"custom-svg\\"' in current_html
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
    source = _film('''
    <svg id="export-authored-scene" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"
         style="position:absolute;inset:0;width:1920px;height:1080px">
      <rect width="1920" height="1080" fill="#102030"/>
      <rect id="evidence" x="20" y="20" width="600" height="600" fill="#ff00ff"/>
      <text x="720" y="450" fill="#ffffff" font-size="72">AUTHORED SVG</text>
</svg>''', animation="const tl=gsap.timeline({paused:true});tl.fromTo('#evidence',{attr:{width:50}},{attr:{width:600},duration:2});window.__timelines={film:tl};")
    sync = await _sync(project, source, scene={
        "title": "Authored scene", "duration": 3, "narration": "本地合成语音用于真实导出验收。",
    })
    assert sync.status == 200
    assert server._video_scene_ready(project, json.loads(sync.body)["scenes"][0])

    class _OfflineToneProvider:
        async def synthesize_with_timings(self, text: str, voice: str = ""):
            return tts.TTSSynthesisResult(
                audio=_tone_wav(1.25),
                boundaries=({"text": text, "startMs": 0, "endMs": 1_000},),
                timing_source="local-export-fixture",
            )

    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: _OfflineToneProvider())
    preview = await handle_video_agent(_request({"action": "preview", "name": project.name, "scene_index": 1, "plan_revision": 1}))
    assert preview.status == 200, preview.text
    assert json.loads(preview.body)["motionReview"]["distinctVisualStates"] >= 2
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
    source = _film(f'''
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
const tl=gsap.timeline({{paused:true}});OM.clock(tl,seek,3);window.__timelines={{film:tl}};seek(0);
fetch({private_url}).then(r=>r.text()).then(text=>{{
  outsideReadable=text.includes("ff00ff");seek(0);
  parent.postMessage({{type:"mona-scene-report",outsideFileReadable:outsideReadable}},"*");
}}).catch(()=>{{
  outsideReadable=false;seek(0);
  parent.postMessage({{type:"mona-scene-report",outsideFileReadable:false}},"*");
}});
</script>''')

    synced = await _sync(project, source)
    assert synced.status == 200
    rendered = project / json.loads(synced.body)["scenes"][0]["htmlPath"]
    rendered_text = rendered.read_text(encoding="utf-8")
    assert "data:image/svg+xml;base64," in rendered_text
    assert 'sandbox="allow-scripts"' in rendered_text
    assert "allow-same-origin" not in rendered_text

    response = await handle_video_agent(_request({
        "action": "preview", "name": project.name, "scene_index": 1, "plan_revision": 1,
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

    selected_response = await handle_video_agent(_request({
        "action": "preview", "name": project.name, "scene_index": 1, "plan_revision": 1, "timestamps": [0.5, 2.25],
    }))
    assert selected_response.status == 200, selected_response.body.decode("utf-8", errors="replace")
    selected = json.loads(selected_response.body)
    assert selected["observationScope"] == "selected-timestamps"
    assert selected["motionReviewUpdated"] is False
    assert "motionReview" not in selected
    assert [frame["timestamp"] for frame in selected["frames"]] == [0.5, 2.25]
    selected_images = [Image.open(frame["path"]) for frame in selected["frames"]]
    try:
        assert [image.size for image in selected_images] == [(320, 180), (320, 180)]
        assert selected_images[0].convert("RGB").getpixel((20, 20))[0] > 200
        assert selected_images[1].convert("RGB").getpixel((20, 20))[2] > 200
    finally:
        for image in selected_images:
            image.close()


async def test_visual_only_edit_keeps_original_voice_and_exact_subtitle_timings(
    project: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import mona.providers.tts as tts

    meta = server._load_video_meta(project)
    meta.update({"narrationEnabled": True, "subtitleMode": "burned", "ttsProvider": "edge"})
    server._save_video_meta(project, meta)
    narration = "保留原来的旁白和字幕。"
    first = await _sync(project, _film('<svg><text>Original visual</text></svg>'), scene={"narration": narration})
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

    updated = await _sync(project, _film('<svg><text>Revised visual</text></svg>'))
    assert updated.status == 200
    assert (project / "audio" / "scene_01.timing.json").read_bytes() == timing
    assert narration in (project / "scenes" / "scene_01.html").read_text(encoding="utf-8")
    meta = server._load_video_meta(project)
    assert await server._synthesize_scene_narration(project, meta["scenes"][0], meta)
    assert calls == [narration]
    assert meta["scenes"][0]["audioTimingSource"] == "provider-boundary"


async def test_old_tts_cache_regroups_subtitles_without_resynthesis_or_reconfirmation(
    project: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import mona.providers.tts as tts

    narration = "权重用于说明每个指标对模型结果的重要程度，以及各项指标在总评分中所占的比例。"
    synced = await _sync(
        project,
        _film('<svg><text>Subtitle regroup cache</text></svg>'),
        scene={"title": "权重", "duration": 15, "narration": narration},
    )
    assert synced.status == 200
    meta = server._load_video_meta(project)
    meta.update({
        "narrationEnabled": True,
        "ttsProvider": "edge",
        "ttsVoice": "zh-CN-YunxiNeural",
        "ttsRate": "+0%",
        "outputStale": False,
    })
    scene = meta["scenes"][0]
    scene.update({
        "confirmedAt": "kept-confirmation",
        "confirmedMtime": 123.0,
        "motionReview": {"distinctVisualStates": 3},
        "motionReviewSourceHash": scene["sourceHash"],
    })

    (project / "audio").mkdir(exist_ok=True)
    (project / "scene_specs").mkdir(exist_ok=True)
    (project / "renders" / "output.mp4").write_bytes(b"old-export")
    audio_path = project / "audio" / "scene_01.mp3"
    audio_path.write_bytes(_tone_wav(0.8))
    words = []
    cursor = 0
    for character in narration:
        if character in "，。！？；：、,.!?;: ":
            continue
        words.append({"text": character, "startMs": cursor, "endMs": cursor + 70})
        cursor += 90
    timing_path = project / "audio" / "scene_01.timing.json"
    timing_path.write_text(json.dumps({
        "schemaVersion": 1,
        "language": "zh-CN",
        "durationMs": 15_000,
        "sourceTextHash": "old-source-hash",
        "audioHash": "old-audio-hash",
        "timingSource": "provider-boundary",
        "alignmentConfidence": "high",
        "cues": [{
            "id": "cue-01",
            "startMs": words[0]["startMs"],
            "endMs": words[-1]["endMs"],
            "text": "旧版分组",
            "words": words,
        }],
    }, ensure_ascii=False), encoding="utf-8")
    scene.update({
        "audioMtime": audio_path.stat().st_mtime,
        "audioInputHash": None,
        "audioTimingPath": "audio/scene_01.timing.json",
        "audioTimingSource": "provider-boundary",
        "audioAlignmentConfidence": "high",
    })
    server._save_video_meta(project, meta)

    async def unexpected_tts(*_args, **_kwargs):
        raise AssertionError("a valid audio cache must be reused")

    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: type("NoTTS", (), {"synthesize_with_timings": unexpected_tts})())
    recompiled: list[int] = []
    original_recompile = server._recompile_series_scene_from_artifacts

    def observe_recompile(project_dir: Path, current_scene: dict, current_meta: dict):
        recompiled.append(current_scene["index"])
        return original_recompile(project_dir, current_scene, current_meta)

    monkeypatch.setattr(server, "_recompile_series_scene_from_artifacts", observe_recompile)
    cached_audio = audio_path.read_bytes()
    result = await server._synthesize_scene_narration(project, scene, meta)
    rebuilt = json.loads(timing_path.read_text(encoding="utf-8"))
    rebuilt_words = [word for cue in rebuilt["cues"] for word in cue["words"]]

    assert result == cached_audio
    assert audio_path.read_bytes() == cached_audio
    from mona.video_timeline import SUBTITLE_GROUPING_VERSION

    assert rebuilt["groupingVersion"] == SUBTITLE_GROUPING_VERSION
    assert all("".join(cue["displayWords"]) == cue["text"] for cue in rebuilt["cues"])
    assert rebuilt_words == words
    assert "".join(cue["text"] for cue in rebuilt["cues"]) == narration
    assert all(len(cue["words"]) > 1 for cue in rebuilt["cues"])
    assert scene["confirmedAt"] == "kept-confirmation"
    assert scene["confirmedMtime"] == 123.0
    assert meta["outputStale"] is True
    assert "motionReview" not in scene
    assert "motionReviewSourceHash" not in scene
    assert recompiled == [1]


async def _plan(project: Path, **extra):
    return await handle_video_agent(_request({"action": "plan", "name": project.name, "scenes": [{
        "title": "比较两种选择", "duration": 3, "visual": "左右显示两个方案",
        "animation": "口播比较时，指标依次增长，优势项被强调",
        "narration": "我们比较这两种选择。", "assets": [],
    }], **extra}))


async def _confirm_and_sync_scenes(project: Path, scenes: list[dict]) -> dict:
    planned = await handle_video_agent(_request({"action": "plan", "name": project.name, "scenes": scenes}))
    assert planned.status == 200, planned.body.decode("utf-8", errors="replace")
    plan_revision = json.loads(planned.body)["planRevision"]
    confirmed = await server.handle_video_project_confirm(_Request({
        "name": project.name, "expectedPlanRevision": plan_revision,
    }))
    assert confirmed.status == 200, confirmed.body.decode("utf-8", errors="replace")
    draft = project / "drafts" / "film.html"
    draft.write_text(_film("".join(f'<section data-om-id="part-{index}">{scene["title"]}</section>' for index, scene in enumerate(scenes, 1))), encoding="utf-8")
    synced = await handle_video_agent(_request({
        "action": "sync", "name": project.name,
        "plan_revision": plan_revision, "source_file": "drafts/film.html",
    }))
    assert synced.status == 200, synced.body.decode("utf-8", errors="replace")
    return server._load_video_meta(project)


def _seed_scene_audio_and_review(project: Path, meta: dict) -> dict[int, dict[str, bytes]]:
    audio_dir = project / "audio"
    specs_dir = project / "scene_specs"
    audio_dir.mkdir(parents=True, exist_ok=True)
    specs_dir.mkdir(parents=True, exist_ok=True)
    snapshots = {}
    for scene in meta["scenes"]:
        index = scene["index"]
        audio_path = audio_dir / f"scene_{index:02d}.mp3"
        timing_path = audio_dir / f"scene_{index:02d}.timing.json"
        audio_path.write_bytes(_tone_wav(.8))
        track = {
            "timingSource": "provider-boundary",
            "cues": [{"text": "原旁白", "startMs": 0, "endMs": 500, "words": [
                {"text": "原", "startMs": 0, "endMs": 200},
                {"text": "旁白", "startMs": 201, "endMs": 500},
            ]}],
        }
        timing_path.write_text(json.dumps(track, ensure_ascii=False), encoding="utf-8")
        motion_path = specs_dir / f"scene_{index:02d}.motion.json"
        motion_path.write_text(json.dumps({"scene": index}), encoding="utf-8")
        scene.update({
            "audioMtime": audio_path.stat().st_mtime,
            "audioInputHash": f"cache-input-{index}", "audioTimingPath": f"audio/{timing_path.name}",
            "audioTimingSource": "provider-boundary", "audioAlignmentConfidence": "high",
            "audioTimingHash": f"timing-hash-{index}", "motionPlanPath": f"scene_specs/{motion_path.name}",
            "motionPlanSummary": f"motion-{index}", "motionReview": {"distinctVisualStates": index + 2},
            "motionReviewSourceHash": scene["sourceHash"],
        })
        snapshots[index] = {
            "audio": audio_path.read_bytes(), "timing": timing_path.read_bytes(),
            "motion": motion_path.read_bytes(),
        }
    server._save_video_meta(project, meta)
    return snapshots


async def test_style_selection_respects_fixed_choice_revision_confirmation_and_safe_ids(project: Path) -> None:
    from mona.video_style import get_builtin_template

    await _plan(project)
    meta = server._load_video_meta(project)
    meta.update({"templateId": "huashu-keynote", "stylePreference": "fixed"})
    server._save_video_meta(project, meta)
    style_path = project / "style" / "design-system.json"
    style_path.write_text(json.dumps(get_builtin_template("huashu-keynote")), encoding="utf-8")
    original_meta = (project / "meta.json").read_bytes()
    original_style = style_path.read_bytes()

    fixed_override = await handle_video_agent(_request({
        "action": "style", "name": project.name, "plan_revision": 1, "style_id": "huashu-whiteboard",
    }))
    assert fixed_override.status == 422
    assert "固定" in json.loads(fixed_override.body)["error"] or "选择" in json.loads(fixed_override.body)["error"]
    assert (project / "meta.json").read_bytes() == original_meta
    assert style_path.read_bytes() == original_style

    explicit_switch = await handle_video_agent(_request({
        "action": "style", "name": project.name, "plan_revision": 1, "style_id": "huashu-whiteboard",
        "instruction": "用户明确要求改用扁平流程图风格。",
    }))
    assert explicit_switch.status == 200, explicit_switch.body.decode("utf-8", errors="replace")
    switched_meta = server._load_video_meta(project)
    assert switched_meta["stylePreference"] == "fixed"
    assert switched_meta["templateId"] == "huashu-whiteboard"
    assert switched_meta["planRevision"] == 2
    assert switched_meta["approvedPlanRevision"] is None

    switched_meta_bytes = (project / "meta.json").read_bytes()
    switched_style_bytes = style_path.read_bytes()
    stale = await handle_video_agent(_request({
        "action": "style", "name": project.name, "plan_revision": 1, "style_id": "huashu-collage",
        "instruction": "用户明确要求改用复古剪纸风格。",
    }))
    assert stale.status == 422
    assert "更新" in json.loads(stale.body)["error"]
    traversal = await handle_video_agent(_request({
        "action": "style", "name": project.name, "plan_revision": 2, "style_id": "../../meta.json",
        "instruction": "用户明确要求切换风格。",
    }))
    assert 400 <= traversal.status < 500
    assert "../../meta.json" not in traversal.body.decode("utf-8", errors="replace")
    assert (project / "meta.json").read_bytes() == switched_meta_bytes
    assert style_path.read_bytes() == switched_style_bytes

    confirmed = await server.handle_video_project_confirm(_Request({
        "name": project.name, "expectedPlanRevision": 2,
    }))
    assert confirmed.status == 200
    approved_meta = (project / "meta.json").read_bytes()
    confirmed_switch = await handle_video_agent(_request({
        "action": "style", "name": project.name, "plan_revision": 2, "style_id": "huashu-collage",
        "instruction": "用户明确要求改用复古剪纸风格。",
    }))
    assert confirmed_switch.status == 422
    assert "已确认" in json.loads(confirmed_switch.body)["error"]
    assert (project / "meta.json").read_bytes() == approved_meta
    assert style_path.read_bytes() == switched_style_bytes


async def test_style_switch_preserves_voice_cache_and_requires_new_plan_confirmation(project: Path) -> None:
    from mona.video_style import get_builtin_template

    await _plan(project)
    meta = server._load_video_meta(project)
    meta.update({"templateId": "huashu-keynote", "stylePreference": "auto", "narrationEnabled": True})
    server._save_video_meta(project, meta)
    style_path = project / "style" / "design-system.json"
    style_path.write_text(json.dumps(get_builtin_template("huashu-keynote")), encoding="utf-8")
    audio_dir = project / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    audio_path = audio_dir / "scene_01.mp3"
    timing_path = audio_dir / "scene_01.timing.json"
    audio_path.write_bytes(_tone_wav(.8))
    timing_path.write_text(json.dumps({
        "timingSource": "provider-boundary",
        "cues": [{"text": "原旁白", "startMs": 0, "endMs": 500}],
    }, ensure_ascii=False), encoding="utf-8")
    scene_before = meta["scenes"][0]
    scene_before.update({
        "audioMtime": audio_path.stat().st_mtime,
        "audioInputHash": "style-switch-audio-cache",
        "audioTimingPath": "audio/scene_01.timing.json",
        "audioTimingSource": "provider-boundary",
        "audioAlignmentConfidence": "high",
        "audioTimingHash": "style-switch-timing-cache",
    })
    server._save_video_meta(project, meta)
    cache_snapshot = {"audio": audio_path.read_bytes(), "timing": timing_path.read_bytes()}
    before = server._load_video_meta(project)["scenes"][0]
    audio_keys = (
        "audioMtime", "audioInputHash", "audioTimingPath", "audioTimingSource",
        "audioAlignmentConfidence", "audioTimingHash",
    )

    switched = await handle_video_agent(_request({
        "action": "style", "name": project.name, "plan_revision": 1, "style_id": "huashu-whiteboard",
    }))
    assert switched.status == 200, switched.body.decode("utf-8", errors="replace")
    after_meta = server._load_video_meta(project)
    scene = after_meta["scenes"][0]
    assert after_meta["templateId"] == "huashu-whiteboard"
    assert after_meta["planRevision"] == 2
    assert after_meta["requirePlanApproval"] is True
    assert after_meta["approvedPlanRevision"] is None
    assert scene["htmlStatus"] == "pending"
    assert {key: scene[key] for key in audio_keys} == {key: before[key] for key in audio_keys}
    assert audio_path.read_bytes() == cache_snapshot["audio"]
    assert timing_path.read_bytes() == cache_snapshot["timing"]

    blocked_audio = await handle_video_agent(_request({
        "action": "audio", "name": project.name, "scene_index": 1, "plan_revision": 2,
    }))
    assert blocked_audio.status == 422
    assert "确认分镜" in json.loads(blocked_audio.body)["error"]
    replanned = await _plan(project)
    assert replanned.status == 200
    replanned_payload = json.loads(replanned.body)
    assert replanned_payload["planRevision"] == 2
    assert replanned_payload["awaitingConfirmation"] is True


async def test_invalid_resolution_does_not_partially_commit_audio_settings(
    project: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    validation_calls = []

    async def validate_assets(_project, _meta):
        validation_calls.append("assets")
        return {"audio-test": 1.0}

    def validate_mix(*_args, **_kwargs):
        validation_calls.append("mix")

    monkeypatch.setattr("mona.api.video_audio.audio_asset_durations", validate_assets)
    monkeypatch.setattr("mona.api.video_runtime.VideoRuntime.get_ffmpeg_path", lambda _self: "ffmpeg")
    monkeypatch.setattr("mona.video_audio.build_audio_mix_command", validate_mix)
    meta_before = (project / "meta.json").read_bytes()
    settings = {
        "resolution": "invalid-ratio",
        "musicPreset": "ambient",
        "musicAssetId": "audio-test",
        "audioTracks": [{
            "assetId": "audio-test", "role": "music", "startSeconds": 0,
            "sourceStartSeconds": 0, "durationSeconds": 1, "volume": 0.2, "loop": False,
        }],
    }

    response = await handle_video_agent(_request({
        "action": "settings", "name": project.name, "settings": settings,
    }))

    assert response.status == 422
    assert "横屏" in json.loads(response.body)["error"]
    assert validation_calls == []
    assert (project / "meta.json").read_bytes() == meta_before
    assert not (project / "versions").exists()
    assert not (project / "audio").exists()




async def test_edit_requires_approved_current_plan_instruction_and_allowed_fields(project: Path) -> None:
    await _plan(project)
    original = server._load_video_meta(project)
    original_bytes = (project / "meta.json").read_bytes()
    requested = {"visual": "把左右方案改成流程图"}

    unconfirmed = await handle_video_agent(_request({
        "action": "edit", "name": project.name, "scene_index": 1, "plan_revision": 1,
        "instruction": "请把画面改成流程图", "scene": requested,
    }))
    assert unconfirmed.status == 422
    assert server._load_video_meta(project)["scenes"][0]["visual"] == original["scenes"][0]["visual"]
    assert (project / "meta.json").read_bytes() == original_bytes

    confirmed = await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))
    assert confirmed.status == 200
    approved_bytes = (project / "meta.json").read_bytes()
    invalid_requests = [
        {"action": "edit", "name": project.name, "scene_index": 1, "plan_revision": 0,
         "instruction": "请把画面改成流程图", "scene": requested},
        {"action": "edit", "name": project.name, "scene_index": 1, "plan_revision": 1,
         "scene": requested},
        {"action": "edit", "name": project.name, "scene_index": 1, "plan_revision": 1,
         "instruction": "请把画面改成流程图", "scene": {**requested, "unapprovedField": "偷偷改内容"}},
    ]
    for body in invalid_requests:
        response = await handle_video_agent(_request(body))
        assert response.status == 422, response.body.decode("utf-8", errors="replace")
        assert (project / "meta.json").read_bytes() == approved_bytes
        assert not (project / "versions").exists()


async def test_scoped_visual_edit_preserves_other_scene_and_audio_then_noop_is_idempotent(project: Path) -> None:
    scenes = [
        {"title": "第一段", "duration": 3, "visual": "左右显示两个方案", "animation": "方案依次出现",
         "narration": "先看两个方案。", "assets": []},
        {"title": "第二段", "duration": 4, "visual": "比较结果显示在表格里", "animation": "表格逐行填入",
         "narration": "再看比较结果。", "assets": []},
    ]
    meta = await _confirm_and_sync_scenes(project, scenes)
    cache_snapshots = _seed_scene_audio_and_review(project, meta)
    before_meta = server._load_video_meta(project)
    first, second = before_meta["scenes"]
    first_source = project / first["sourcePath"]
    first_html = project / first["htmlPath"]
    second_source = project / second["sourcePath"]
    second_html = project / second["htmlPath"]
    source_bytes = first_source.read_bytes()
    html_bytes = first_html.read_bytes()
    other_source_bytes = second_source.read_bytes()
    other_html_bytes = second_html.read_bytes()
    other_scene_before = copy.deepcopy(second)
    original_revision = before_meta["planRevision"]
    instruction = "第一段把左右方案改为一张流程图，并在讲到结果时逐步点亮路径。"
    changes = {"visual": "一张流程图展示两个方案的处理路径", "animation": "路径从起点逐步点亮，结果节点最后强调"}

    response = await handle_video_agent(_request({
        "action": "edit", "name": project.name, "scene_index": 1,
        "plan_revision": original_revision, "instruction": instruction, "scene": changes,
    }))

    assert response.status == 200, response.body.decode("utf-8", errors="replace")
    payload = json.loads(response.body)
    assert payload["changedFields"] == ["animation", "visual"]
    assert payload["planRevision"] == original_revision + 1
    assert payload["awaitingConfirmation"] is False
    after_meta = server._load_video_meta(project)
    edited, other_scene = after_meta["scenes"]
    assert after_meta["approvedPlanRevision"] == after_meta["planRevision"]
    assert after_meta["lastEdit"]["instruction"] == instruction
    assert after_meta["lastEdit"]["sceneId"] == edited["id"]
    assert edited["visual"] == changes["visual"]
    assert edited["animation"] == changes["animation"]
    assert edited["htmlStatus"] == "pending"
    assert "motionReview" not in edited
    assert edited["sourceHash"] == first["sourceHash"]
    assert first_source.read_bytes() == source_bytes
    assert first_html.read_bytes() == html_bytes
    assert second_source.read_bytes() == other_source_bytes
    assert second_html.read_bytes() == other_html_bytes
    assert other_scene["htmlStatus"] == "pending"
    assert "motionReview" not in other_scene
    for key in ("id", "title", "visual", "animation", "narration", "duration", "assets", "sourceHash"):
        assert other_scene[key] == other_scene_before[key]

    audio_keys = ("audioMtime", "audioInputHash", "audioTimingPath", "audioTimingSource",
                  "audioAlignmentConfidence", "audioTimingHash")
    for index in (1, 2):
        audio_path = project / "audio" / f"scene_{index:02d}.mp3"
        timing_path = project / "audio" / f"scene_{index:02d}.timing.json"
        assert audio_path.read_bytes() == cache_snapshots[index]["audio"]
        assert timing_path.read_bytes() == cache_snapshots[index]["timing"]
    assert {key: edited[key] for key in audio_keys} == {key: first[key] for key in audio_keys}
    assert {key: other_scene[key] for key in audio_keys} == {key: other_scene_before[key] for key in audio_keys}

    version_count = len(list((project / "versions").iterdir()))
    last_edit = copy.deepcopy(after_meta["lastEdit"])
    no_op = await handle_video_agent(_request({
        "action": "edit", "name": project.name, "scene_index": 1,
        "plan_revision": after_meta["planRevision"], "instruction": instruction, "scene": changes,
    }))
    assert no_op.status == 200
    no_op_payload = json.loads(no_op.body)
    assert no_op_payload["changedFields"] == []
    assert no_op_payload["planRevision"] == after_meta["planRevision"]
    final_meta = server._load_video_meta(project)
    assert final_meta["approvedPlanRevision"] == after_meta["approvedPlanRevision"]
    assert final_meta["lastEdit"] == last_edit
    assert len(list((project / "versions").iterdir())) == version_count


async def test_narration_edit_invalidates_old_voice_cache_and_rebuilds_word_timing(project: Path, monkeypatch) -> None:
    import mona.providers.tts as tts

    meta = server._load_video_meta(project)
    meta["narrationEnabled"] = True
    meta["ttsProvider"] = "edge"
    server._save_video_meta(project, meta)
    scenes = [{
        "title": "口播段", "duration": 3, "visual": "人物介绍产品", "animation": "产品从人物手中展开",
        "narration": "这是原来的旁白。", "assets": [],
    }]
    meta = await _confirm_and_sync_scenes(project, scenes)
    cache_snapshot = _seed_scene_audio_and_review(project, meta)[1]
    original_scene = server._load_video_meta(project)["scenes"][0]
    original_source = (project / original_scene["sourcePath"]).read_bytes()
    new_narration = "这是修改后的旁白，并保留逐词字幕。"
    instruction = "把这段旁白改成修改后的说法。"

    response = await handle_video_agent(_request({
        "action": "edit", "name": project.name, "scene_index": 1,
        "plan_revision": 1, "instruction": instruction, "scene": {"narration": new_narration},
    }))

    assert response.status == 200, response.body.decode("utf-8", errors="replace")
    updated = server._load_video_meta(project)
    scene = updated["scenes"][0]
    assert updated["planRevision"] == updated["approvedPlanRevision"] == 2
    assert scene["narration"] == new_narration
    for key in ("audioMtime", "audioInputHash", "audioTimingPath", "audioTimingSource",
                "audioAlignmentConfidence", "audioTimingHash"):
        assert key not in scene
    timing_path = project / "audio" / "scene_01.timing.json"
    assert not timing_path.exists()
    audio_path = project / "audio" / "scene_01.mp3"
    assert audio_path.read_bytes() == cache_snapshot["audio"]  # file remains unbound until fresh synthesis
    assert (project / original_scene["sourcePath"]).read_bytes() == original_source

    calls = []

    class Provider:
        async def synthesize_with_timings(self, text, voice=""):
            calls.append((text, voice))
            return tts.TTSSynthesisResult(
                audio=_tone_wav(.4),
                boundaries=({"text": "修改后", "startMs": 0, "endMs": 350},),
                timing_source="provider-boundary",
            )

    monkeypatch.setattr(tts, "EdgeTTSProvider", lambda **_kwargs: Provider())
    audio_response = await handle_video_agent(_request({
        "action": "audio", "name": project.name, "scene_index": 1, "plan_revision": 2,
    }))

    assert audio_response.status == 200, audio_response.body.decode("utf-8", errors="replace")
    audio_payload = json.loads(audio_response.body)
    assert len(calls) == 1
    assert calls[0][0] == new_narration
    assert audio_payload["subtitleTrack"]["cues"][0]["words"][0]["text"] == "修改后"
    assert audio_path.read_bytes() == _tone_wav(.4)
    rebuilt_timing = json.loads(timing_path.read_text(encoding="utf-8"))
    assert rebuilt_timing["timingSource"] == "provider-boundary"
    assert rebuilt_timing["sourceTextHash"] == hashlib.sha256(new_narration.encode("utf-8")).hexdigest()


async def test_sync_can_add_authorized_assets_but_cannot_remove_or_replace_approved_assets(project: Path) -> None:
    from mona.video_assets import import_project_asset

    assets = []
    for name, color in (("approved", "red"), ("addition", "green"), ("replacement", "blue")):
        source = project.parent / f"{name}.png"
        Image.new("RGB", (8, 8), color).save(source, format="PNG")
        assets.append(import_project_asset(project, source, source_type="user-upload", rights_status="owned"))
    approved_asset, added_asset, replacement_asset = assets
    meta = await _confirm_and_sync_scenes(project, [{
        "title": "使用已确认素材", "duration": 3, "visual": "展示已确认素材", "animation": "素材展开",
        "narration": "先展示素材。", "assets": [approved_asset["id"]],
    }])
    assert meta["planRevision"] == meta["approvedPlanRevision"] == 1

    accepted_draft = project / "drafts" / "scene_01_added.html"
    accepted_draft.write_text(_film("<main>Uses both approved assets</main>"), encoding="utf-8")
    appended = await handle_video_agent(_request({
        "action": "sync", "name": project.name, "scene_index": 1, "plan_revision": 1,
        "source_file": "drafts/scene_01_added.html",
        "scene": {"assets": [approved_asset["id"], added_asset["id"]]},
    }))
    assert appended.status == 200, appended.body.decode("utf-8", errors="replace")
    after_append = server._load_video_meta(project)
    assert after_append["scenes"][0]["assets"] == [approved_asset["id"], added_asset["id"]]
    assert after_append["planRevision"] == after_append["approvedPlanRevision"] == 1
    accepted_source = project / after_append["scenes"][0]["sourcePath"]
    accepted_source_bytes = accepted_source.read_bytes()

    for label, asset_ids in (
        ("remove", [added_asset["id"]]),
        ("replace", [replacement_asset["id"]]),
    ):
        draft = project / "drafts" / f"scene_01_{label}_attempt.html"
        draft.write_text(f"<main>{label} attempt</main>", encoding="utf-8")
        rejected = await handle_video_agent(_request({
            "action": "sync", "name": project.name, "scene_index": 1, "plan_revision": 1,
            "source_file": f"drafts/scene_01_{label}_attempt.html", "scene": {"assets": asset_ids},
        }))
        assert rejected.status == 422
        current = server._load_video_meta(project)
        assert current["scenes"][0]["assets"] == [approved_asset["id"], added_asset["id"]]
        assert current["planRevision"] == current["approvedPlanRevision"] == 1
        assert accepted_source.read_bytes() == accepted_source_bytes


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
    draft.write_text(_film("<div>Two alternatives</div>"), encoding="utf-8")
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


@pytest.mark.parametrize("timestamps", [None, [1.25]])
async def test_preview_cannot_overwrite_plan_edits_during_frame_capture(
    project: Path, monkeypatch, timestamps: list[float] | None,
) -> None:
    from mona.api import video_director

    meta = server._load_video_meta(project)
    meta["authoringMode"] = "huashu-motion"
    server._save_video_meta(project, meta)
    await _plan(project)
    await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))
    draft = project / "drafts" / "film.html"
    draft.write_text(_film("<div>Alternatives</div>"), encoding="utf-8")
    synced = await handle_video_agent(_request({"action": "sync", "name": project.name, "scene_index": 1,
                                              "plan_revision": 1, "source_file": "drafts/film.html"}))
    assert synced.status == 200

    async def capture(_project, _scene, _meta, timestamps=None):
        edited = await server.handle_video_project_scene_update(_Request({"name": project.name, "index": 1,
                                                                          "animation": "用户刚调整的动画方案", "expectedPlanRevision": 1}))
        assert edited.status == 200
        return {"frames": [], "motionReview": {"status": "passed"},
                "motionReviewUpdated": timestamps is None, "diagnostics": []}

    monkeypatch.setattr(video_director, "_capture_frames", capture)
    body = {"action": "preview", "name": project.name, "scene_index": 1, "plan_revision": 1}
    if timestamps is not None:
        body["timestamps"] = timestamps
    preview = await handle_video_agent(_request(body))
    assert preview.status == 422
    current = server._load_video_meta(project)
    assert current["planRevision"] == 2
    assert current["approvedPlanRevision"] is None
    assert current["scenes"][0]["animation"] == "用户刚调整的动画方案"
    assert "motionReview" not in current["scenes"][0]


async def test_selected_preview_preserves_existing_complete_motion_review(project: Path, monkeypatch) -> None:
    meta = server._load_video_meta(project)
    meta["authoringMode"] = "huashu-motion"
    server._save_video_meta(project, meta)
    await _plan(project)
    await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))
    draft = project / "drafts" / "film.html"
    draft.write_text(_film("<div>Preview</div>"), encoding="utf-8")
    synced = await handle_video_agent(_request({"action": "sync", "name": project.name, "scene_index": 1,
                                                "plan_revision": 1, "source_file": "drafts/film.html"}))
    assert synced.status == 200
    complete_review = {"distinctVisualStates": 7, "staticVisual": False}
    meta = server._load_video_meta(project)
    scene = meta["scenes"][0]
    scene["motionReview"] = complete_review
    scene["motionReviewSourceHash"] = scene["sourceHash"]
    server._save_video_meta(project, meta)
    requested = [0.5, 2.25]

    async def capture(_project, _scene, _meta, *, timestamps):
        assert timestamps == requested
        frames = [{"timestamp": timestamp, "seconds": timestamp, "path": str(project / f"sample-{index}.png")}
                  for index, timestamp in enumerate(timestamps)]
        return {"frames": frames, "observationScope": "selected-timestamps", "motionReviewUpdated": False}

    monkeypatch.setattr(video_director, "_capture_frames", capture)
    response = await handle_video_agent(_request({
        "action": "preview", "name": project.name, "scene_index": 1,
        "plan_revision": 1, "timestamps": requested,
    }))

    assert response.status == 200
    payload = json.loads(response.body)
    assert payload["observationScope"] == "selected-timestamps"
    assert payload["motionReviewUpdated"] is False
    assert [frame["timestamp"] for frame in payload["frames"]] == requested
    current_scene = server._load_video_meta(project)["scenes"][0]
    assert current_scene["motionReview"] == complete_review
    assert current_scene["motionReviewSourceHash"] == scene["sourceHash"]


def test_preview_timestamps_are_finite_and_within_current_scene_duration() -> None:
    assert video_director._validate_preview_timestamps([0, 1.23456, 2.9999], 3) == [0, 1.2346, 2.9999]

    for timestamps in ([], [0] * 9, [True], [float("nan")], [float("inf")], [10**400], [-0.01], [3], ["0.5"]):
        with pytest.raises(ValueError):
            video_director._validate_preview_timestamps(timestamps, 3)


def test_motion_sampling_covers_representative_cues_through_scene() -> None:
    cues = [
        {"startMs": 400 + index * 600, "endMs": 600 + index * 600, "text": "说明"}
        for index in range(32)
    ]
    times = video_director._motion_sample_times(20, cues)

    assert len(times) <= 8 + video_director._MAX_REPRESENTATIVE_CUES * 3
    assert {14.72, 14.9, 15.12}.issubset(times)
    assert max(times) > 15


def test_motion_review_masks_subtitle_and_reports_real_changes_and_long_holds(tmp_path: Path) -> None:
    before = Image.new("RGB", (320, 180), "white")
    ImageDraw.Draw(before).text((8, 8), "subtitle one", fill="black")
    subtitle_only = before.copy()
    ImageDraw.Draw(subtitle_only).rectangle((0, 0, 120, 40), fill="white")
    ImageDraw.Draw(subtitle_only).text((8, 8), "subtitle two", fill="black")
    actual_change = before.copy()
    ImageDraw.Draw(actual_change).rectangle((200, 80, 280, 160), fill="red")
    frames = []
    for index, image in enumerate((before, subtitle_only, actual_change)):
        path = tmp_path / f"motion-{index}.png"
        image.save(path)
        frames.append({"seconds": index * 1.5, "path": str(path)})

    review = video_director._review_motion_samples(frames, [[0, 0, 120, 40]], 320, 180, 4)

    assert review["distinctVisualStates"] == 2
    assert review["staticVisual"] is False
    assert review["adjacentComparisons"][0]["changedPixelPercent"] == 0
    assert review["adjacentComparisons"][1]["changedPixelPercent"] > 0.1
    assert review["longStillIntervals"] == [{
        "fromSeconds": 0.0, "toSeconds": 1.5, "samplePairs": 1, "durationSeconds": 1.5,
    }]
    assert "审美质量结论" in review["comparisonNotes"]


def test_motion_review_filters_small_pixel_noise_from_sample_comparisons(tmp_path: Path) -> None:
    clean = Image.new("RGB", (160, 90), "white")
    noisy = clean.copy()
    noisy.putpixel((90, 45), (250, 250, 250))
    frames = []
    for index, image in enumerate((clean, noisy)):
        path = tmp_path / f"noise-{index}.png"
        image.save(path)
        frames.append({"seconds": index * 2.0, "path": str(path)})

    review = video_director._review_motion_samples(frames, [], 160, 90, 2)

    assert review["adjacentComparisons"][0]["changedPixelPercent"] == 0
    assert review["longStillIntervals"][0]["durationSeconds"] == 2


def test_speech_timing_observation_reports_trailing_time_and_source() -> None:
    observation = video_director._speech_timing_observation(
        30,
        [{"text": "最后一句", "startMs": 18_000, "endMs": 18_550}],
        "provider-boundary",
    )

    assert observation["status"] == "available"
    assert observation["timingBasis"] == "provider-boundary"
    assert observation["lastCueEndSeconds"] == 18.55
    assert observation["sceneEndSeconds"] == 30
    assert observation["trailingNoNarrationSeconds"] == 11.45
    assert "阅读、过渡或内容动作" in observation["reviewNote"]
    assert "呼吸或闪烁" in observation["reviewNote"]


def test_speech_timing_observation_marks_estimates_and_handles_missing_or_invalid_cues() -> None:
    estimated = video_director._speech_timing_observation(
        30,
        [{"text": "估算的句子", "startMs": 0, "endMs": 12_000}],
        "acoustic-sentence-alignment",
    )
    invalid = video_director._speech_timing_observation(
        30,
        [None, {"text": "", "startMs": 0, "endMs": 500},
         {"text": "反向时间", "startMs": 900, "endMs": 800},
         {"text": "无效数字", "startMs": "bad", "endMs": 1000},
         {"text": "超大数字", "startMs": 10**400, "endMs": 10**401}],
        "provider-boundary",
    )
    missing = video_director._speech_timing_observation(30, [], None)
    sampled = video_director._motion_sample_times(
        30, [{"startMs": 10**400, "endMs": 10**401}],
    )

    assert estimated["timingBasis"] == "estimated"
    assert estimated["timingBasisLabel"] == "估算的口播时间"
    assert invalid["status"] == "unavailable"
    assert invalid["reason"] == "no-valid-cues"
    assert invalid["sceneEndSeconds"] == 30
    assert "trailingNoNarrationSeconds" not in invalid
    assert missing["timingSource"] == "missing"
    assert missing["timingBasis"] == "unknown"
    assert len(sampled) == 8


@pytest.mark.parametrize("review_state", ["missing", "static", "stale-source"])
async def test_huashu_export_requires_observed_motion_for_current_source(project: Path, review_state: str) -> None:
    await _plan(project)
    await server.handle_video_project_confirm(_Request({"name": project.name, "expectedPlanRevision": 1}))
    draft = project / "drafts/film.html"
    draft.write_text(_film("<div>Alternatives</div>"), encoding="utf-8")
    synced = await handle_video_agent(_request({"action": "sync", "name": project.name, "scene_index": 1,
                                               "plan_revision": 1, "source_file": "drafts/film.html"}))
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


@pytest.mark.asyncio
async def test_style_sample_plan_keeps_explicit_sample_authorization(project: Path) -> None:
    meta = server._load_video_meta(project)
    meta.update({"styleAuthoring": {"seriesId": "sample-style"}, "requirePlanApproval": False, "planRevision": 0})
    server._save_video_meta(project, meta)
    response = await handle_video_agent(_request({
        "action": "plan", "name": project.name,
        "scenes": [{"title": "过滤", "duration": 8, "visual": "水经过滤层", "animation": "颗粒被截留", "narration": "过滤层留住颗粒。"}],
    }))
    assert response.status == 200
    result = json.loads(response.body)
    assert result["awaitingConfirmation"] is False
    saved = server._load_video_meta(project)
    assert saved["requirePlanApproval"] is False
    server._require_video_plan_approval(saved, result["planRevision"], check_revision=True)
    with pytest.raises(ValueError, match="样片内容已更新"):
        server._require_video_plan_approval(saved, result["planRevision"] - 1, check_revision=True)


def test_normal_video_plan_still_requires_director_confirmation() -> None:
    meta = {"requirePlanApproval": False, "planRevision": 0}
    server._video_plan_changed(meta)
    assert meta["requirePlanApproval"] is True
    with pytest.raises(ValueError, match="导演台"):
        server._require_video_plan_approval(meta, 1, check_revision=True)


def _saved_authoring_style(tmp_path: Path, series_id: str = "paper-style") -> tuple[dict, Path]:
    from mona.video_assets import register_project_asset
    from mona.video_style import create_series, save_style_draft
    from mona.video_style_authoring import bind_style_sample, capture_style_sample

    create_series(tmp_path, series_id, f"风格 {series_id}", template_id="huashu-collage")
    draft = save_style_draft(tmp_path, series_id, {"authoring": {"rules": f"{series_id} 的纸张边缘与连续对象运动规则"}}, expected_revision=0)
    sample = tmp_path / "video_projects" / f"sample-{series_id}"
    for name in ("assets", "scene_sources", "scenes", "renders/previews/scene_01"):
        (sample / name).mkdir(parents=True)
    (sample / "meta.json").write_text(json.dumps({"resolution": "1920x1080", "scenes": []}), encoding="utf-8")
    draft = bind_style_sample(tmp_path, series_id, sample.name, draft["revision"], "温暖纸张和蓝色图形")
    image = sample / "assets" / "shape.png"
    Image.new("RGB", (16, 16), "#2478aa").save(image)
    asset_id = f"shape-{series_id}"
    register_project_asset(sample, {"id": asset_id, "path": "assets/shape.png", "sourceType": "user-upload", "rightsStatus": "owned"})
    source = sample / "scene_sources" / "film.html"
    source.write_text(_film(f'<div>{series_id}</div>'), encoding="utf-8")
    rendered = sample / "scenes" / "scene_01.html"
    rendered.write_text("<!doctype html><html><body>sample</body></html>", encoding="utf-8")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    meta = json.loads((sample / "meta.json").read_text(encoding="utf-8"))
    meta["scenes"] = [{"index": 1, "title": "纸张机制图", "duration": 8, "authored": True,
                       "authoredRuntime": "huashu-motion", "sourcePath": "scene_sources/film.html", "htmlStatus": "previewing", "assets": [asset_id],
                       "sourceHash": digest, "motionReviewSourceHash": digest,
                       "motionReview": {"distinctVisualStates": 2}}]
    (sample / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    timestamp = max(source.stat().st_mtime_ns, rendered.stat().st_mtime_ns, (sample / "style/design-system.json").stat().st_mtime_ns) + 1_000_000
    for index, color in enumerate(("white", "blue")):
        frame = sample / "renders" / "previews" / "scene_01" / f"sample_{index}.png"
        Image.new("RGB", (64, 36), color).save(frame)
        os.utime(frame, ns=(timestamp, timestamp))
    return capture_style_sample(tmp_path, series_id, draft["revision"]), sample


async def test_style_rules_is_limited_to_bound_samples_and_tracks_real_draft_revision(project: Path, tmp_path: Path) -> None:
    from mona.video_style import create_series, read_style_draft, save_style_draft
    from mona.video_style_authoring import bind_style_sample, style_visual_hash

    original = (project / "meta.json").read_bytes()
    refused = await handle_video_agent(_request({"action": "style_rules", "name": project.name, "instruction": "更换画法"}))
    assert refused.status == 422
    assert (project / "meta.json").read_bytes() == original
    create_series(tmp_path, "sample-style", "纸张样片")
    bind_style_sample(tmp_path, "sample-style", project.name, 0, "浅纸蓝图")
    response = await handle_video_agent(_request({
        "action": "style_rules", "name": project.name, "instruction": "蓝色图形连续变化，不固定内容布局。",
        "settings": {"tokens": {"colors": {"primary": "#2277AA"}}},
    }))
    assert response.status == 200, response.body.decode()
    draft = read_style_draft(tmp_path, "sample-style")
    meta = server._load_video_meta(project)
    assert draft["revision"] == meta["styleAuthoring"]["draftRevision"] == json.loads(response.body)["draftRevision"]
    assert draft["authoring"]["rules"] == "蓝色图形连续变化，不固定内容布局。"
    assert draft["tokens"]["colors"]["primary"] == "#2277AA"
    assert meta["styleAuthoring"]["styleInputHash"] == style_visual_hash(draft)
    assert meta["requirePlanApproval"] is False
    save_style_draft(tmp_path, "sample-style", {"name": "另一个修改"}, expected_revision=draft["revision"])
    renamed = await handle_video_agent(_request({"action": "style_rules", "name": project.name, "instruction": "保留新名称，继续蓝色风格"}))
    assert renamed.status == 200
    draft = read_style_draft(tmp_path, "sample-style")
    assert draft["name"] == "另一个修改"
    save_style_draft(tmp_path, "sample-style", {"tokens": {"colors": {"primary": "#AA4422"}}}, expected_revision=draft["revision"])
    stale = await handle_video_agent(_request({"action": "style_rules", "name": project.name, "instruction": "不能覆盖新草稿"}))
    assert stale.status == 409
    assert read_style_draft(tmp_path, "sample-style")["authoring"]["rules"] == draft["authoring"]["rules"]


async def test_auto_style_can_select_frozen_saved_style_and_preserves_project_assets_and_output(project: Path, tmp_path: Path) -> None:
    from mona.video_assets import list_project_assets, register_project_asset
    from mona.video_style import create_series

    saved, sample = _saved_authoring_style(tmp_path)
    create_series(tmp_path, "unfinished", "尚未保存的风格")
    image = project / "assets" / "user.png"
    Image.new("RGB", (16, 16), "red").save(image)
    register_project_asset(project, {"id": "user-image", "path": "assets/user.png", "rightsStatus": "owned"})
    output = project / "renders" / "output.mp4"
    output.write_bytes(b"previous-export")
    meta = server._load_video_meta(project)
    meta.update({"templateId": "huashu-keynote", "stylePreference": "auto", "planRevision": 0})
    server._save_video_meta(project, meta)
    inspection = json.loads((await handle_video_agent(_request({"action": "inspect", "name": project.name}))).body)
    available = {item["id"]: item for item in inspection["availableStyles"]}
    assert available["saved:paper-style"]["source"] == "saved"
    assert available["saved:paper-style"]["version"] == 1
    assert available["saved:paper-style"]["name"] == "风格 paper-style"
    assert available["huashu-whiteboard"]["source"] == "builtin"
    assert "saved:unfinished" not in available
    response = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:paper-style", "plan_revision": 0}))
    assert response.status == 200, response.body.decode()
    current = server._load_video_meta(project)
    assert current["styleSourceSeriesId"] == "paper-style"
    assert current["styleVersion"] == 1
    assert current["planRevision"] == 1
    assert current["approvedPlanRevision"] is None
    assert current["requirePlanApproval"] is True
    assert current["outputStale"] is True
    assert output.read_bytes() == b"previous-export"
    assert {item["id"] for item in list_project_assets(project)} == {"user-image", "shape-paper-style"}
    assert image.is_file()
    inspected = json.loads((await handle_video_agent(_request({"action": "inspect", "name": project.name}))).body)
    assert inspected["style"]["id"] == "saved:paper-style"
    assert inspected["style"]["authoring"]["rules"] == saved["authoring"]["rules"]
    examples = [Path(path) for path in inspected["styleExamples"]]
    assert examples == [project / "style" / "authoring" / "scene_sources" / "film.html"]
    assert examples[0].read_bytes() == (sample / "scene_sources" / "film.html").read_bytes()
    shutil.rmtree(sample)
    assert examples[0].is_file()


async def test_fixed_saved_style_identity_is_not_its_shared_builtin_base(project: Path, tmp_path: Path) -> None:
    _saved_authoring_style(tmp_path, "paper-one")
    _saved_authoring_style(tmp_path, "paper-two")
    meta = server._load_video_meta(project)
    meta.update({"templateId": "huashu-keynote", "stylePreference": "auto", "planRevision": 0})
    server._save_video_meta(project, meta)
    first = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:paper-one", "plan_revision": 0}))
    assert first.status == 200
    meta = server._load_video_meta(project)
    meta["stylePreference"] = "fixed"
    server._save_video_meta(project, meta)
    original_meta = (project / "meta.json").read_bytes()
    original_style = (project / "style" / "design-system.json").read_bytes()
    for style_id in ("saved:paper-two", "huashu-collage"):
        refused = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": style_id, "plan_revision": 1}))
        assert refused.status == 422
        assert (project / "meta.json").read_bytes() == original_meta
        assert (project / "style" / "design-system.json").read_bytes() == original_style
    switched = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:paper-two", "plan_revision": 1, "instruction": "用户明确要求使用另一套纸张风格。"}))
    assert switched.status == 200
    assert server._load_video_meta(project)["styleSourceSeriesId"] == "paper-two"
    assert json.loads((project / "style" / "design-system.json").read_text(encoding="utf-8"))["baseTemplateId"] == "huashu-collage"


async def test_builtin_switch_does_not_expose_old_saved_style_examples(project: Path, tmp_path: Path) -> None:
    _saved_authoring_style(tmp_path)
    meta = server._load_video_meta(project)
    meta.update({"stylePreference": "auto", "planRevision": 0})
    server._save_video_meta(project, meta)
    assert (await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:paper-style", "plan_revision": 0}))).status == 200
    switched = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "huashu-collage", "plan_revision": 1}))
    assert switched.status == 200
    assert not (project / "style" / "authoring").exists()
    obsolete = project / "style" / "authoring" / "scene_sources" / "obsolete.html"
    obsolete.parent.mkdir(parents=True)
    obsolete.write_text("obsolete example", encoding="utf-8")
    inspected = json.loads((await handle_video_agent(_request({"action": "inspect", "name": project.name}))).body)
    assert inspected["styleExamples"] == []
    assert inspected["style"]["authoring"] is None
    assert inspected["style"]["id"] == "huashu-collage"


async def test_saved_style_switch_preserves_fixed_snapshot_version_and_sample_direction(project: Path, tmp_path: Path) -> None:
    _saved_authoring_style(tmp_path)
    meta = server._load_video_meta(project)
    meta.update({"stylePreference": "auto", "planRevision": 0})
    server._save_video_meta(project, meta)
    assert (await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:paper-style", "plan_revision": 0}))).status == 200
    meta = server._load_video_meta(project)
    meta["stylePreference"] = "fixed"
    server._save_video_meta(project, meta)
    before = (project / "style" / "design-system.json").read_bytes()
    series_directory = tmp_path / "video_series" / "paper-style"
    shutil.copytree(series_directory / "styles" / "v1", series_directory / "styles" / "v2")
    newer_path = series_directory / "styles" / "v2" / "design-system.json"
    newer = json.loads(newer_path.read_text(encoding="utf-8"))
    newer["version"] = 2
    newer["authoring"]["rules"] = "新版本画法，不应悄悄替换已选风格"
    newer_path.write_text(json.dumps(newer), encoding="utf-8")
    series_path = series_directory / "series.json"
    series = json.loads(series_path.read_text(encoding="utf-8"))
    series["latestStyleVersion"] = 2
    series_path.write_text(json.dumps(series), encoding="utf-8")
    unchanged = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:paper-style", "plan_revision": 1}))
    assert unchanged.status == 200
    assert json.loads(unchanged.body)["style"]["version"] == 1
    assert (project / "style" / "design-system.json").read_bytes() == before
    upgraded = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:paper-style", "plan_revision": 1, "instruction": "用户要求使用这套风格的新版本。"}))
    assert upgraded.status == 200
    assert json.loads(upgraded.body)["style"]["version"] == 2
    before = (project / "style" / "design-system.json").read_bytes()
    meta = server._load_video_meta(project)
    meta["styleAuthoring"] = {"seriesId": "paper-style"}
    meta["stylePreference"] = "auto"
    server._save_video_meta(project, meta)
    refused = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "huashu-whiteboard", "plan_revision": meta["planRevision"], "instruction": "自动推荐另一套。"}))
    assert refused.status == 422
    assert (project / "style" / "design-system.json").read_bytes() == before


async def test_saved_style_asset_conflict_restores_previous_style_and_registry(project: Path, tmp_path: Path) -> None:
    from mona.video_assets import register_project_asset

    _saved_authoring_style(tmp_path)
    image = project / "assets" / "user.png"
    Image.new("RGB", (16, 16), "red").save(image)
    register_project_asset(project, {"id": "shape-paper-style", "path": "assets/user.png", "rightsStatus": "owned"})
    meta = server._load_video_meta(project)
    meta.update({"stylePreference": "auto", "planRevision": 0})
    server._save_video_meta(project, meta)
    old_style = (project / "style" / "design-system.json").read_bytes()
    old_manifest = (project / "assets" / "manifest.json").read_bytes()
    old_meta = (project / "meta.json").read_bytes()
    old_image = image.read_bytes()
    response = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:paper-style", "plan_revision": 0}))
    assert response.status == 422
    assert (project / "style" / "design-system.json").read_bytes() == old_style
    assert (project / "assets" / "manifest.json").read_bytes() == old_manifest
    assert (project / "meta.json").read_bytes() == old_meta
    assert image.read_bytes() == old_image
    assert not list(project.glob(".style-selection-*"))


async def test_saved_style_selection_rejects_unsafe_series_id(project: Path) -> None:
    meta = server._load_video_meta(project)
    meta.update({"stylePreference": "auto", "planRevision": 0})
    server._save_video_meta(project, meta)
    old_style = (project / "style" / "design-system.json").read_bytes()
    response = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:../../outside", "plan_revision": 0}))
    assert response.status == 400
    assert (project / "style" / "design-system.json").read_bytes() == old_style


async def test_saved_style_catalog_omits_incomplete_snapshot_and_selection_preserves_project(project: Path, tmp_path: Path) -> None:
    _saved_authoring_style(tmp_path)
    (tmp_path / "video_series" / "paper-style" / "styles" / "v1" / "authoring" / "previews" / "poster.png").unlink()
    meta = server._load_video_meta(project)
    meta.update({"stylePreference": "auto", "planRevision": 0})
    server._save_video_meta(project, meta)
    old_style = (project / "style" / "design-system.json").read_bytes()
    inspected = json.loads((await handle_video_agent(_request({"action": "inspect", "name": project.name}))).body)
    assert "saved:paper-style" not in {item["id"] for item in inspected["availableStyles"]}
    response = await handle_video_agent(_request({"action": "style", "name": project.name, "style_id": "saved:paper-style", "plan_revision": 0}))
    assert response.status == 422
    assert (project / "style" / "design-system.json").read_bytes() == old_style
