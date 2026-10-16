from __future__ import annotations

import array
import asyncio
import base64
import csv
import json
import math
import os
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

import mona.agent  # noqa: F401
import mona.api.server as server
import mona.api.video_audio as video_audio
from mona.api.video_runtime import VideoRuntime
from mona.materials.auth import SERVICES_TOKEN_HEADER
from mona.video_assets import import_project_asset

_TOKEN = "video-audio-api-test-token"


def _write_tone(path: Path, frequency: float, duration: float = 4.0) -> None:
    sample_rate = 24_000
    frames = bytearray()
    for index in range(round(sample_rate * duration)):
        sample = round(6_000 * math.sin(2 * math.pi * frequency * index / sample_rate))
        frames.extend(struct.pack("<h", sample))
    with wave.open(str(path), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(frames)


def _project(
    project_dir: Path,
    tmp_path: Path,
    *,
    with_audio: bool = True,
) -> tuple[Path, dict[str, dict], str | None]:
    project_dir.mkdir(parents=True)
    for folder in ("assets", "audio", "renders", "scenes"):
        (project_dir / folder).mkdir()
    meta: dict = {
        "name": project_dir.name,
        "resolution": "320x180",
        "phase": "exportable",
        "narrationEnabled": False,
        "subtitleMode": "off",
        "musicPreset": "none",
        "audioTracks": [],
        "requirePlanApproval": True,
        "planRevision": 3,
        "approvedPlanRevision": 3,
        "scenes": [
            {"index": 1, "title": "第一段", "duration": 2, "narration": ""},
            {"index": 2, "title": "第二段", "duration": 2, "narration": ""},
        ],
    }
    assets: dict[str, dict] = {}
    ffmpeg = VideoRuntime().get_ffmpeg_path()
    if with_audio:
        if not ffmpeg:
            pytest.skip("Existing FFmpeg runtime is required")
        for role, frequency, duration in (("music", 220, 4), ("effect", 880, 1)):
            source = tmp_path / f"{role}.wav"
            _write_tone(source, frequency, duration)
            record = import_project_asset(
                project_dir,
                source,
                source_type="user-upload",
                rights_status="owned",
            )
            assets[role] = record
        meta["audioTracks"] = [
            {
                "assetId": assets["music"]["id"],
                "role": "music",
                "startSeconds": 0,
                "sourceStartSeconds": 0,
                "durationSeconds": 4,
                "volume": 0.15,
                "loop": True,
            },
            {
                "assetId": assets["effect"]["id"],
                "role": "effect",
                "startSeconds": 2.5,
                "sourceStartSeconds": 0,
                "durationSeconds": 0.5,
                "volume": 0.9,
                "loop": False,
            },
        ]
    server._save_video_meta(project_dir, meta)
    return project_dir, assets, ffmpeg


def _save_meta(project: Path, meta: dict) -> None:
    server._save_video_meta(project, meta)


def _decode_m4a(ffmpeg: str, path: Path) -> array.array:
    raw = subprocess.check_output(
        [ffmpeg, "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", "24000", "pipe:1"]
    )
    return array.array("f", raw)


def _rms(samples: array.array, start: float, end: float) -> float:
    low, high = round(start * 24_000), round(end * 24_000)
    window = samples[low:high]
    return math.sqrt(sum(value * value for value in window) / max(1, len(window)))


@pytest.fixture
async def services_client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    import mona.services.server as services

    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path / "app-data"))
    monkeypatch.setenv("MONA_SERVICES_TOKEN", _TOKEN)
    monkeypatch.setattr(services.imap_pool_manager, "keepalive", lambda *_args: None)
    monkeypatch.setattr(services._idle_manager, "set_loop", lambda _loop: None)
    app = services.create_services_app()
    async with TestClient(TestServer(app)) as client:
        yield client


@pytest.fixture
def video_project(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    projects = tmp_path / "video_projects"
    projects.mkdir()
    monkeypatch.setattr(server, "_video_projects_dir", lambda: projects)
    return _project(projects / "demo", tmp_path)


async def test_audio_preview_requires_services_token_and_returns_silent_204(
    services_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    projects = tmp_path / "video_projects"
    projects.mkdir()
    monkeypatch.setattr(server, "_video_projects_dir", lambda: projects)
    project, _assets, _ffmpeg = _project(projects / "silent", tmp_path, with_audio=False)
    body = {"name": project.name}

    denied = await services_client.post("/api/video/project/audio-preview", json=body)
    allowed = await services_client.post(
        "/api/video/project/audio-preview",
        json=body,
        headers={SERVICES_TOKEN_HEADER: _TOKEN},
    )

    assert denied.status == 401
    assert allowed.status == 204


async def test_full_and_scene_previews_share_mix_cache_and_invalidate_all_inputs(
    services_client: TestClient,
    video_project,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    project, assets, ffmpeg = video_project
    assert ffmpeg
    original_mix = video_audio.mix_project_audio
    calls: list[tuple[float, float | None]] = []

    async def observe_real_mix(*args, **kwargs):
        calls.append((kwargs.get("window_start", 0), kwargs.get("window_duration")))
        await original_mix(*args, **kwargs)

    monkeypatch.setattr(video_audio, "mix_project_audio", observe_real_mix)

    full = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name},
        headers={SERVICES_TOKEN_HEADER: _TOKEN},
    )
    assert full.status == 200
    assert full.content_type == "audio/mp4"
    full_bytes = await full.read()
    assert len(full_bytes) > 1_000
    assert calls == [(0, None)]

    cached = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name},
        headers={SERVICES_TOKEN_HEADER: _TOKEN},
    )
    assert cached.status == 200
    assert await cached.read() == full_bytes
    assert calls == [(0, None)]

    scene = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name, "index": 2},
        headers={SERVICES_TOKEN_HEADER: _TOKEN},
    )
    assert scene.status == 200
    assert scene.content_type == "audio/mp4"
    scene_bytes = await scene.read()
    assert len(scene_bytes) > 1_000
    assert calls == [(0, None), (2, 2.0)]

    full_samples = _decode_m4a(ffmpeg, project / "audio" / "preview-mix-full.m4a")
    scene_samples = _decode_m4a(ffmpeg, project / "audio" / "preview-mix-2.m4a")
    envelope_diffs = [
        abs(
            _rms(full_samples, 2 + offset, 2 + offset + 0.1)
            - _rms(scene_samples, offset, offset + 0.1)
        )
        for offset in (i / 10 for i in range(19))
    ]
    assert max(envelope_diffs) < 0.02

    meta = server._load_video_meta(project)
    meta["audioTracks"][0]["volume"] = 0.25
    _save_meta(project, meta)
    changed_track = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name, "index": 2},
        headers={SERVICES_TOKEN_HEADER: _TOKEN},
    )
    assert changed_track.status == 200
    assert len(calls) == 3

    music_path = project / assets["music"]["path"]
    _write_tone(music_path, 330, 4)
    changed_media = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name, "index": 2},
        headers={SERVICES_TOKEN_HEADER: _TOKEN},
    )
    assert changed_media.status == 200
    assert len(calls) == 4

    meta = server._load_video_meta(project)
    meta["scenes"][0]["duration"] = 1.5
    meta["scenes"][1]["duration"] = 2.5
    _save_meta(project, meta)
    changed_window = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name, "index": 2},
        headers={SERVICES_TOKEN_HEADER: _TOKEN},
    )
    assert changed_window.status == 200
    assert calls[-1] == (1.5, 2.5)
    assert len(calls) == 5


async def test_audio_mix_timeout_stops_real_child_and_reports_retryable_error(
    services_client: TestClient,
    video_project,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    project, assets, ffmpeg = video_project
    assert ffmpeg
    meta = server._load_video_meta(project)
    command = video_audio.build_audio_mix_command(
        project,
        meta,
        ffmpeg_path=ffmpeg,
        output_path=project / "audio" / "command-check.m4a",
        timeline_duration=4,
        asset_durations={assets["music"]["id"]: 4, assets["effect"]["id"]: 1},
    )
    assert command[1] == "-nostdin"

    marker = tmp_path / "mix-child-started.txt"
    script = (
        "import os, pathlib, sys, time\n"
        f"pathlib.Path({str(marker)!r}).write_text(str(os.getpid()) + ':' + repr(sys.stdin.read(1)))\n"
        "time.sleep(30)\n"
    )
    spawned: list[tuple[asyncio.subprocess.Process, tuple[str, ...], dict]] = []
    original_spawn = asyncio.create_subprocess_exec

    async def capture_spawn(*command: str, **options):
        process = await original_spawn(*command, **options)
        spawned.append((process, command, options))
        return process

    monkeypatch.setattr(video_audio, "_MIX_SUBPROCESS_TIMEOUT_SECONDS", 0.75)
    monkeypatch.setattr(video_audio, "build_audio_mix_command", lambda *_args, **_kwargs: [sys.executable, "-c", script])
    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture_spawn)

    response = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name},
        headers={SERVICES_TOKEN_HEADER: _TOKEN},
    )

    payload = await response.json()
    assert response.status == 503
    assert payload["retryable"] is True
    assert "声音处理超时" in payload["message"]
    marker_value = marker.read_text(encoding="utf-8")
    assert marker_value.endswith(":''")
    child_pid = int(marker_value.split(":", 1)[0])
    mix_process, _command, options = next(
        entry
        for entry in spawned
        if entry[1][:2] == (sys.executable, "-c") and entry[1][2] == script
    )
    assert options["stdin"] == asyncio.subprocess.DEVNULL
    assert mix_process.returncode is not None
    if sys.platform == "win32":
        processes = subprocess.run(
            ["tasklist", "/FI", f"PID eq {child_pid}", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            check=True,
        )
        child_is_running = any(
            len(row) > 1 and row[1] == str(child_pid)
            for row in csv.reader(processes.stdout.splitlines())
        )
    else:
        try:
            os.kill(child_pid, 0)
        except ProcessLookupError:
            child_is_running = False
        except PermissionError:
            child_is_running = True
        else:
            child_is_running = True
    assert not child_is_running


async def test_audio_preview_rejects_bad_asset_and_scene_window(
    services_client: TestClient,
    video_project,
) -> None:
    project, _assets, _ffmpeg = video_project
    headers = {SERVICES_TOKEN_HEADER: _TOKEN}

    outside_scene = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name, "index": 99},
        headers=headers,
    )
    assert outside_scene.status == 422

    meta = server._load_video_meta(project)
    meta["audioTracks"][0]["assetId"] = "not-in-this-project"
    _save_meta(project, meta)
    unknown_asset = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name},
        headers=headers,
    )
    assert unknown_asset.status == 422
    assert "素材" in (await unknown_asset.json())["message"]

    meta["audioTracks"][0]["assetId"] = _assets["music"]["id"]
    meta["audioTracks"][0]["durationSeconds"] = 4.1
    _save_meta(project, meta)
    beyond_tail = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name},
        headers=headers,
    )
    assert beyond_tail.status == 422


async def test_tts_failure_keeps_previous_voice_cache_and_export(
    services_client: TestClient,
    video_project,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import mona.providers.tts as tts

    project, _assets, ffmpeg = video_project
    assert ffmpeg
    headers = {SERVICES_TOKEN_HEADER: _TOKEN}

    previous_mix = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name},
        headers=headers,
    )
    assert previous_mix.status == 200
    cached_mix_path = project / "audio" / "preview-mix-full.m4a"
    cached_mix = cached_mix_path.read_bytes()
    receipt_path = cached_mix_path.with_suffix(".json")
    cached_receipt = receipt_path.read_bytes()

    previous_video = project / "renders" / "output.mp4"
    subprocess.run(
        [ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=10:d=2", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(previous_video)],
        check=True,
        capture_output=True,
    )
    previous_video_bytes = previous_video.read_bytes()

    old_voice_source = tmp_path / "old-voice.wav"
    old_voice_mp3 = project / "audio" / "scene_01.mp3"
    _write_tone(old_voice_source, 440, 1)
    subprocess.run(
        [ffmpeg, "-v", "error", "-y", "-i", str(old_voice_source), "-c:a", "libmp3lame", str(old_voice_mp3)],
        check=True,
        capture_output=True,
    )
    old_voice_bytes = old_voice_mp3.read_bytes()
    old_voice_mtime = old_voice_mp3.stat().st_mtime

    meta = server._load_video_meta(project)
    meta.update({"narrationEnabled": True, "ttsProvider": "edge", "ttsVoice": "zh-CN-XiaoyiNeural", "ttsRate": "+0%"})
    meta["scenes"][0].update({"narration": "已有旁白缓存", "audioMtime": old_voice_mtime, "audioInputHash": "old-voice-settings"})
    _save_meta(project, meta)

    async def fail_provider(_provider, _text: str, *, voice: str = ""):
        raise tts.TTSError(
            "配音服务暂时不可用；已保留当前声音设置，请稍后重试。",
            code="TTS_SERVICE_UNAVAILABLE",
            retryable=True,
        )

    monkeypatch.setattr(tts.EdgeTTSProvider, "synthesize_with_timings", fail_provider)
    failed = await services_client.post(
        "/api/video/project/audio-preview",
        json={"name": project.name, "index": 1},
        headers=headers,
    )
    payload = await failed.json()

    assert failed.status == 503
    assert payload["code"] == "TTS_SERVICE_UNAVAILABLE"
    assert payload["retryable"] is True
    assert "稍后重试" in payload["error"]
    assert "保留当前声音设置" in payload["error"]
    assert server._load_video_meta(project)["ttsVoice"] == "zh-CN-XiaoyiNeural"
    assert old_voice_mp3.read_bytes() == old_voice_bytes
    assert cached_mix_path.read_bytes() == cached_mix
    assert receipt_path.read_bytes() == cached_receipt
    assert previous_video.read_bytes() == previous_video_bytes


async def test_full_preview_html_embeds_one_master_and_uses_global_audio_time(
    video_project,
) -> None:
    project, _assets, _ffmpeg = video_project
    master = await video_audio.prepare_preview_audio(project)
    assert master is not None
    data_url = "data:audio/mp4;base64," + base64.b64encode(master.read_bytes()).decode("ascii")
    html = server._build_video_preview_html(
        320,
        180,
        4,
        [(1, 2, "<main>第一段</main>"), (2, 2, "<main>第二段</main>")],
        project_name=project.name,
        master_audio=data_url,
    )

    assert f"const masterSource = {json.dumps(data_url)};" in html
    assert "const masterAudio = masterSource ? new Audio(masterSource) : null;" in html
    assert "const audio = masterAudio || (audioUrl ? new Audio(audioUrl) : null);" in html
    assert "audioTracks[index] = audio;" in html
    assert "localTime + (masterAudio ? entries.slice(0, index).reduce((sum, entry) => sum + entry[1], 0) : 0)" in html
    assert "if (masterAudio) currentIndex = position.index;" in html
    assert "masterAudio ? masterAudio.currentTime" in html


async def test_browser_keeps_master_audio_clock_across_scene_boundary(video_project) -> None:
    playwright = pytest.importorskip("playwright.async_api")
    browser_executable = VideoRuntime().get_chrome_path()
    if not browser_executable:
        pytest.skip("The existing browser runtime is required")

    project, _assets, _ffmpeg = video_project
    master = await video_audio.prepare_preview_audio(project)
    assert master is not None
    data_url = "data:audio/mp4;base64," + base64.b64encode(master.read_bytes()).decode("ascii")
    html = server._build_video_preview_html(
        320,
        180,
        4,
        [(1, 2, "<main>第一段</main>"), (2, 2, "<main>第二段</main>")],
        master_audio=data_url,
    )

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch(executable_path=browser_executable, headless=True)
        try:
            page = await browser.new_page()
            await page.set_content(html, wait_until="domcontentloaded")
            await page.wait_for_function("typeof masterAudio !== 'undefined' && masterAudio.readyState >= 1", timeout=10_000)
            assert await page.evaluate("audioTracks[0] === audioTracks[1]") is True
            await page.locator("#play-toggle").click()
            await page.wait_for_function("currentIndex === 1 && playing", timeout=5_000)
            before = await page.evaluate("masterAudio.currentTime")
            await page.wait_for_timeout(200)
            after = await page.evaluate("masterAudio.currentTime")
            assert before >= 2
            assert after > before
            assert after < 3
        finally:
            await browser.close()
