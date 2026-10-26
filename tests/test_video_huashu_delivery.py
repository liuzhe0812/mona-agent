"""The authored film has one continuous visual timeline in preview and export."""

import asyncio
import base64
import importlib.util
import json
import re
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from PIL import Image

from mona.api import server
from mona.api.video_runtime import VideoRuntime


@pytest.fixture
def film(tmp_path):
    project = tmp_path / "film"
    for directory in ("scenes", "scene_sources", "composition"):
        (project / directory).mkdir(parents=True)
    meta = {
        "authoringMode": "huashu-motion", "resolution": "320x180",
        "composition": {"sourcePath": "scene_sources/film.html", "htmlPath": "composition/index.html", "sourceHash": "current", "planRevision": 1},
        "scenes": [{"index": index, "duration": .5, "htmlStatus": "previewing"} for index in (1, 2)],
    }
    (project / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    source = """<!doctype html><html><head><style>html,body{margin:0;width:320px;height:180px;background:red}</style></head>
<body><script>window.__monaReady=true;window.__monaSeek=async seconds=>{document.body.style.background=seconds<.5?'rgb(240,0,0)':'rgb(0,0,240)';window.lastSeek=seconds;};</script></body></html>"""
    (project / "composition" / "index.html").write_text(source, encoding="utf-8")
    (project / "scene_sources" / "film.html").write_text(source, encoding="utf-8")
    for index in (1, 2):
        (project / "scenes" / f"scene_{index:02d}.html").write_text('<html><body style="background:green" data-duration=".5">slice</body></html>', encoding="utf-8")
    return project, meta


def test_export_snapshot_freezes_composition_and_tracks_its_content(film):
    project, meta = film
    original = server._video_export_input_hash(project, meta)
    snapshot = server._snapshot_video_project(project, meta)
    baked = snapshot / "composition" / "index.html"
    source = snapshot / "scene_sources" / "film.html"
    assert baked.read_bytes() == (project / "composition" / "index.html").read_bytes()
    assert source.read_bytes() == (project / "scene_sources" / "film.html").read_bytes()
    (project / "composition" / "index.html").write_text("changed", encoding="utf-8")
    assert server._video_export_input_hash(project, meta) != original
    assert baked.read_text(encoding="utf-8") != "changed"


@pytest.mark.parametrize("html_path", ["../outside.html", "scenes/scene_01.html", "composition/../composition/index.html"])
def test_composition_path_is_fixed_before_hashing_or_snapshotting(film, html_path):
    project, meta = film
    meta["composition"]["htmlPath"] = html_path
    for operation in (server._video_export_input_hash, server._snapshot_video_project):
        with pytest.raises(ValueError):
            operation(project, meta)
    assert not (project / "renders" / "snapshot").exists()


async def test_full_preview_contains_one_film_entry_without_scene_audio_or_transitions(monkeypatch, film):
    project, _meta = film
    monkeypatch.setattr(server, "_video_projects_dir", lambda: project.parent)
    response = await server.handle_video_project_preview_full(MagicMock(query={"name": "film"}))
    assert response.status == 200
    entries = json.loads(re.search(r"const entries = (.+);", response.text).group(1))
    assert len(entries) == 1
    assert entries[0][1] == 1
    assert "window.lastSeek=seconds" in entries[0][2]
    assert "slice" not in entries[0][2]
    assert entries[0][3:] == ["", "cross-fade", 0]
    assert "const totalDuration = 1.0;" in response.text


async def test_full_preview_does_not_fall_back_to_scene_pages_when_film_is_unprepared(monkeypatch, film):
    project, meta = film
    del meta["composition"]
    (project / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    monkeypatch.setattr(server, "_video_projects_dir", lambda: project.parent)
    response = await server.handle_video_project_preview_full(MagicMock(query={"name": "film"}))
    assert response.status == 409
    assert json.loads(response.body)["error"] == "COMPOSITION_NOT_READY"


@pytest.fixture
def renderer(monkeypatch):
    scripts = Path(__file__).parents[1] / "mona" / "skills" / "mona-video" / "scripts"
    monkeypatch.syspath_prepend(str(scripts))
    spec = importlib.util.spec_from_file_location("mona_video_huashu_render", scripts / "render.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_export_renders_the_film_once_and_keeps_both_narration_segments(monkeypatch, film, renderer):
    runtime = VideoRuntime()
    browser, ffmpeg = runtime.get_chrome_path(), runtime.get_ffmpeg_path()
    if not browser or not ffmpeg:
        pytest.skip("The existing browser and FFmpeg runtime are required")
    project, _meta = film
    (project / "audio").mkdir()
    (project / "scenes" / "scene_03.html").write_text('<div data-duration="5">obsolete slice</div>', encoding="utf-8")
    for index in (1, 2, 3):
        subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency={index * 440}:duration=0.3", str(project / "audio" / f"scene_{index:02d}.mp3")], check=True, capture_output=True)
    navigated, audio_durations = [], []
    render_scene, concat_audio = renderer._render_scene, renderer._concat_scene_audio

    async def capture_scene(ws, path, *args, **kwargs):
        navigated.append(path)
        return await render_scene(ws, path, *args, **kwargs)

    def capture_audio(*args, **kwargs):
        audio_durations.extend(kwargs["durations"])
        return concat_audio(*args, **kwargs)

    monkeypatch.setattr(renderer, "_render_scene", capture_scene)
    monkeypatch.setattr(renderer, "_concat_scene_audio", capture_audio)
    result = renderer.render_project(project, fps=4, ffmpeg_path=ffmpeg, browser_path=browser)
    assert result["ok"] is True
    assert navigated == [(project / "composition" / "index.html").resolve()]
    assert audio_durations == [.5, .5]
    assert result["duration"] == 1
    assert result["total_frames"] == 4
    assert result["audio"] is True
    for number, color in ((0, (240, 0, 0)), (3, (0, 0, 240))):
        with Image.open(project / "frames" / f"frame_{number:06d}.png") as frame:
            assert frame.getpixel((160, 90))[:3] == color


async def test_full_preview_seeks_the_continuous_runtime_in_one_iframe(monkeypatch, film, renderer):
    import websockets

    executable = VideoRuntime().get_chrome_path()
    if not executable:
        pytest.skip("The existing browser runtime is required")
    project, _meta = film
    monkeypatch.setattr(server, "_video_projects_dir", lambda: project.parent)
    response = await server.handle_video_project_preview_full(MagicMock(query={"name": "film"}))
    port = renderer._find_free_port()
    profile = project / ".preview-browser"
    profile.mkdir()
    process = renderer._start_chrome(executable, port, 320, 180, profile)
    try:
        socket_url = renderer._read_devtools_url(process, port)
        async with websockets.connect(socket_url, max_size=64 * 1024 * 1024) as socket:
            page_url = "data:text/html;base64," + base64.b64encode(response.text.encode("utf-8")).decode("ascii")
            await renderer._cdp_call(socket, "Page.navigate", {"url": page_url})

            async def evaluate(expression):
                result = await renderer._cdp_call(socket, "Runtime.evaluate", {"expression": expression, "returnByValue": True})
                return result.get("result", {}).get("value")

            async def wait_for(expression):
                for _ in range(50):
                    if await evaluate(expression):
                        return
                    await asyncio.sleep(.1)
                raise AssertionError(f"Preview did not become ready: {expression}")

            await wait_for("typeof frames!=='undefined' && frames[0]?.contentWindow.__monaReady===true")
            assert await evaluate("document.querySelectorAll('.scene-frame').length") == 1
            await evaluate("window.postMessage({type:'mona-video-seek',seconds:.75}, '*')")
            await wait_for("frames[0].contentWindow.lastSeek===.75")
            assert await evaluate("frames[0].contentWindow.document.body.style.background") == "rgb(0, 0, 240)"
    finally:
        renderer._terminate_process_tree(process)
