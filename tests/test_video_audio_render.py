"""Real media checks for aligned narration and complete video delivery."""

import array
import importlib.util
import json
import subprocess
import sys
import threading
from pathlib import Path

import pytest

import mona.agent  # noqa: F401
import mona.api.server as server
from mona.api.video_runtime import VideoRuntime


@pytest.fixture
def media(monkeypatch):
    runtime = VideoRuntime()
    ffmpeg, ffprobe = runtime.get_ffmpeg_path(), runtime.get_ffprobe_path()
    if not ffmpeg or not ffprobe:
        pytest.skip("Existing video runtime is required")
    scripts = Path(__file__).parents[1] / "mona" / "skills" / "mona-motion" / "scripts"
    monkeypatch.syspath_prepend(str(scripts))
    spec = importlib.util.spec_from_file_location("mona_video_audio_render", scripts / "render.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module, ffmpeg, ffprobe


def _ffmpeg(ffmpeg, *args) -> bytes:
    return subprocess.run([ffmpeg, "-v", "error", "-y", *map(str, args)], check=True, capture_output=True).stdout


def test_scene_audio_keeps_silence_and_next_scene_start(media, tmp_path) -> None:
    renderer, ffmpeg, ffprobe = media
    first, last = tmp_path / "first.mp3", tmp_path / "last.mp3"
    _ffmpeg(ffmpeg, "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", first)
    _ffmpeg(ffmpeg, "-f", "lavfi", "-i", "sine=frequency=880:duration=0.35", last)
    output = tmp_path / "narration.mp3"
    assert renderer._concat_scene_audio([first, None, last], output, ffmpeg_path=ffmpeg, durations=[1, .5, 1])
    samples = array.array("f", _ffmpeg(ffmpeg, "-i", output, "-f", "f32le", "-ac", "1", "-ar", "24000", "pipe:1"))

    def energy(start):
        window = samples[int(start * 24000):int((start + .1) * 24000)]
        return sum(value * value for value in window) / len(window)

    assert energy(.1) > .001
    assert energy(.7) < .00001
    assert energy(1.1) < .00001
    assert energy(1.6) > .001
    assert energy(2.2) < .00001
    probe = json.loads(subprocess.check_output([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(output)]))
    assert float(probe["format"]["duration"]) == pytest.approx(2.5, abs=.15)


async def test_short_narration_does_not_truncate_video(media, tmp_path) -> None:
    renderer, ffmpeg, _ffprobe = media
    video, audio = tmp_path / "silent.mp4", tmp_path / "voice.mp3"
    _ffmpeg(ffmpeg, "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=10:d=6.1", "-c:v", "libx264", "-pix_fmt", "yuv420p", video)
    _ffmpeg(ffmpeg, "-f", "lavfi", "-i", "sine=duration=2", audio)
    output = tmp_path / "output.mp4"
    assert renderer._mux_audio(video, audio, output, ffmpeg_path=ffmpeg)
    result = {"output": "output.mp4", "audio": False, "duration": 2}
    await server._validate_rendered_video(tmp_path, {"narrationEnabled": True, "scenes": [{"duration": 6.1, "narration": "有声旁白"}]}, result, threading.Event())
    assert result["audio"] is True
    assert result["duration"] == pytest.approx(6.1, abs=.1)
    assert result["total_frames"] == 61


@pytest.mark.parametrize("duration,narration,error", [(2, False, "时长"), (6, True, "旁白")])
async def test_delivery_rejects_actual_incomplete_file(media, tmp_path, duration, narration, error) -> None:
    _renderer, ffmpeg, _ffprobe = media
    _ffmpeg(ffmpeg, "-f", "lavfi", "-i", f"color=c=blue:s=320x180:r=10:d={duration}", "-c:v", "libx264", "-pix_fmt", "yuv420p", tmp_path / "output.mp4")
    # The renderer's declared audio and duration cannot override the actual file.
    result = {"output": "output.mp4", "audio": True, "duration": 6}
    with pytest.raises(RuntimeError, match=error):
        await server._validate_rendered_video(tmp_path, {"narrationEnabled": narration, "scenes": [{"duration": 6, "narration": "旁白"}]}, result, threading.Event())


def test_all_renderers_read_canonical_metadata_duration(media, tmp_path) -> None:
    from merge_scenes import compute_timeline, parse_storyboard

    (tmp_path / "meta.json").write_text(json.dumps({"resolution": "320x180", "scenes": [{"index": 1, "duration": 12}]}), encoding="utf-8")
    (tmp_path / "storyboard.md").write_text("### Scene 1: 开场\n- Duration: 10s\n", encoding="utf-8")
    html = tmp_path / "scene_01.html"
    html.write_text('<div data-duration="10"></div>', encoding="utf-8")
    timeline, total = compute_timeline([(1, html)], parse_storyboard(tmp_path / "storyboard.md"))
    assert total == 12
    assert timeline[0][3] == 12
