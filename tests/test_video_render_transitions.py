"""Scene transitions change rendered frames without moving the video timeline."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image


@pytest.fixture
def renderer(monkeypatch):
    scripts = Path(__file__).parents[1] / "mona" / "skills" / "mona-motion" / "scripts"
    monkeypatch.syspath_prepend(str(scripts))
    spec = importlib.util.spec_from_file_location("mona_video_transition_render", scripts / "render.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("preset", ["cross-fade", "fade-rise", "stagger-rise"])
def test_scene_transition_blends_real_frame_pixels(renderer, preset: str) -> None:
    previous = Image.new("RGB", (90, 40), (240, 0, 0))
    current = Image.new("RGB", (90, 40), (0, 0, 240))
    middle = renderer._transition_frame(previous, current, preset, .5)
    assert middle.getpixel((45, 20)) == (120, 0, 120)
    assert renderer._transition_frame(previous, current, preset, 0).tobytes() == previous.tobytes()
    assert renderer._transition_frame(previous, current, preset, 1).tobytes() == current.tobytes()
    if preset == "fade-rise":
        assert middle.getpixel((45, 0)) == (240, 0, 0)
    if preset == "stagger-rise":
        assert middle.getpixel((15, 20))[2] > middle.getpixel((45, 20))[2] > middle.getpixel((75, 20))[2]


def test_root_transition_holds_previous_scene_without_shortening_timeline(renderer, tmp_path) -> None:
    from merge_scenes import build_index_html, compute_timeline, read_scene_transition

    scenes = []
    for index, preset in enumerate(("cross-fade", "fade-rise", "stagger-rise"), start=1):
        path = tmp_path / f"scene_{index:02d}.html"
        path.write_text(f'<div data-duration="2" data-transition-preset="{preset}" data-transition-duration-ms="400"></div>', encoding="utf-8")
        scenes.append((index, path))
    storyboard = {"resolution": (90, 40), "scenes": {1: 2, 2: 2, 3: 2}}
    timeline, total = compute_timeline(scenes, storyboard)
    assert [entry[2] for entry in timeline] == [0, 2, 4]
    assert total == 6
    root = build_index_html(scenes, storyboard)
    assert 'data-composition-id="main" data-start="0" data-duration="6"' in root
    assert root.count('data-duration="2.4" data-scene-duration="2"') == 2
    assert 'animation:mona-fade-rise 0.4s linear both paused;' in root
    assert 'animation:mona-stagger-rise 0.4s linear both paused;' in root
    assert read_scene_transition(scenes[-1][1], .2) == ("stagger-rise", .2)


def test_compatible_export_changes_transition_frames_and_preserves_mp4_duration(renderer, tmp_path) -> None:
    from mona.api.video_runtime import VideoRuntime
    from mona.video_scene_compiler import _fallback_gsap

    runtime = VideoRuntime()
    browser, ffmpeg, ffprobe = runtime.get_chrome_path(), runtime.get_ffmpeg_path(), runtime.get_ffprobe_path()
    if not browser or not ffmpeg or not ffprobe:
        pytest.skip("The existing browser and FFmpeg runtime are required")
    scenes = tmp_path / "scenes"
    scenes.mkdir()
    (tmp_path / "meta.json").write_text(json.dumps({"resolution": "320x180", "scenes": [{"index": index, "duration": 1} for index in range(1, 5)]}), encoding="utf-8")
    for index, preset in enumerate(("cross-fade", "cross-fade", "fade-rise", "stagger-rise"), start=1):
        color = "rgb(240,0,0)" if index % 2 else "rgb(0,0,240)"
        (scenes / f"scene_{index:02d}.html").write_text(
            f'<html><style>html,body{{margin:0;width:320px;height:180px;background:{color}}}</style>'
            f'<body><div data-duration="1" data-transition-preset="{preset}" data-transition-duration-ms="400"></div>'
            f'<script>{_fallback_gsap()}window.__timelines=[window.gsap.timeline()];</script></body></html>',
            encoding="utf-8",
        )
    result = renderer.render_project(tmp_path, fps=4, ffmpeg_path=ffmpeg, browser_path=browser)
    assert result["ok"] is True
    assert result["total_frames"] == 16
    assert len(list((tmp_path / "frames").glob("frame_*.png"))) == 16
    with Image.open(tmp_path / "frames" / "frame_000004.png") as cross:
        assert cross.getpixel((160, 90))[:3] == (165, 0, 75)
    with Image.open(tmp_path / "frames" / "frame_000008.png") as rise:
        assert rise.getpixel((160, 0))[:3] == (0, 0, 240)
        assert rise.getpixel((160, 90))[0] > 0
    with Image.open(tmp_path / "frames" / "frame_000012.png") as stagger:
        assert stagger.getpixel((53, 90))[2] > stagger.getpixel((160, 90))[2] > stagger.getpixel((267, 90))[2]
    probe = subprocess.run([ffprobe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(tmp_path / result["output"])], capture_output=True, text=True, check=True)
    metadata = json.loads(probe.stdout)
    assert float(metadata["format"]["duration"]) == pytest.approx(4, abs=.05)
    assert int(metadata["streams"][0]["nb_frames"]) == 16


@pytest.mark.parametrize("quality, size", [("standard", (640, 360)), ("draft", (320, 180))])
def test_render_quality_scales_the_whole_design_without_cropping(renderer, tmp_path, quality: str, size: tuple[int, int]) -> None:
    from mona.api.video_runtime import VideoRuntime
    from mona.video_scene_compiler import _fallback_gsap

    runtime = VideoRuntime()
    browser, ffmpeg = runtime.get_chrome_path(), runtime.get_ffmpeg_path()
    if not browser or not ffmpeg:
        pytest.skip("The existing browser and FFmpeg runtime are required")
    (tmp_path / "scenes").mkdir()
    (tmp_path / "meta.json").write_text(json.dumps({"resolution": "640x360", "scenes": [{"index": 1, "duration": 1}]}), encoding="utf-8")
    scene = '<html><head><style>html,body{margin:0;width:640px;height:360px;background:red}.marker{position:absolute;right:0;bottom:0;width:20px;height:20px;background:rgb(0,240,0)}</style></head><body><div class="marker"></div>'
    scene += f'<script>{_fallback_gsap()}window.__timelines=[window.gsap.timeline()];</script></body></html>'
    (tmp_path / "scenes" / "scene_01.html").write_text(scene, encoding="utf-8")
    result = renderer.render_project(tmp_path, fps=2, quality=quality, ffmpeg_path=ffmpeg, browser_path=browser)
    assert result["ok"] is True
    assert result["resolution"] == list(size)
    with Image.open(tmp_path / "frames" / "frame_000000.png") as frame:
        assert frame.size == size
        assert frame.getpixel((size[0] - 5, size[1] - 5))[:3] == (0, 240, 0)
