from __future__ import annotations

import array
import json
import math
import struct
import subprocess
import wave
from pathlib import Path

import pytest

from mona.video_audio import build_audio_mix_command


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


@pytest.fixture
def project(tmp_path: Path) -> Path:
    project_dir = tmp_path / "video_project"
    assets_dir = project_dir / "assets"
    assets_dir.mkdir(parents=True)
    (project_dir / "renders").mkdir()
    _write_tone(assets_dir / "music.wav", 880)
    _write_tone(assets_dir / "effect.wav", 660)
    (assets_dir / "source.mp4").write_bytes(b"video fixture")
    (assets_dir / "still.png").write_bytes(b"image fixture")
    (assets_dir / "manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "assets": [
                    {
                        "id": "music",
                        "kind": "audio",
                        "mimeType": "audio/wav",
                        "path": "assets/music.wav",
                    },
                    {
                        "id": "effect",
                        "kind": "audio",
                        "mimeType": "audio/wav",
                        "path": "assets/effect.wav",
                    },
                    {
                        "id": "source",
                        "kind": "video",
                        "mimeType": "video/mp4",
                        "path": "assets/source.mp4",
                    },
                    {
                        "id": "still",
                        "kind": "image",
                        "mimeType": "image/png",
                        "path": "assets/still.png",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    return project_dir


def _command(project_dir: Path, meta: dict, **kwargs: object) -> list[str]:
    return build_audio_mix_command(
        project_dir,
        meta,
        ffmpeg_path="ffmpeg",
        output_path=project_dir / "renders" / "mix.m4a",
        timeline_duration=5,
        asset_durations={"music": 4, "effect": 4, "source": 4},
        **kwargs,
    )


def test_global_window_trims_voice_and_offsets_each_track(project: Path) -> None:
    voice = project / "audio" / "narration.mp3"
    voice.parent.mkdir()
    voice.write_bytes(b"voice")
    command = _command(
        project,
        {
            "audioTracks": [
                {
                    "assetId": "music",
                    "role": "music",
                    "startSeconds": 2.75,
                    "sourceStartSeconds": 0.5,
                    "durationSeconds": 1,
                    "volume": 0.4,
                }
            ]
        },
        voice_path=voice,
        window_start=2.5,
        window_duration=1,
    )
    graph = command[command.index("-filter_complex") + 1]

    assert "atrim=duration=3.5" in graph
    assert "atrim=start=0.5:duration=0.75" in graph
    assert "adelay=132000S:all=1[t0]" in graph
    assert "[music][voicekey]sidechaincompress=" in graph
    assert "atrim=start=2.5:duration=1" in graph
    assert [command[index + 1] for index, value in enumerate(command) if value == "-t"] == ["3.5", "1"]


def test_legacy_music_uses_existing_gain_and_deduplicates_explicit_music(project: Path) -> None:
    legacy = _command(
        project,
        {"musicPreset": "rhythmic", "musicAssetId": "music"},
    )
    assert legacy.count(str(project / "assets" / "music.wav")) == 1
    assert "volume=0.15" in legacy[legacy.index("-filter_complex") + 1]
    assert "-stream_loop" in legacy

    explicit = _command(
        project,
        {
            "musicPreset": "rhythmic",
            "musicAssetId": "music",
            "audioTracks": [
                {
                    "assetId": "music",
                    "role": "music",
                    "startSeconds": 0,
                    "durationSeconds": 4,
                    "volume": 0.7,
                    "loop": False,
                }
            ],
        },
    )
    assert explicit.count(str(project / "assets" / "music.wav")) == 1
    assert "volume=0.7" in explicit[explicit.index("-filter_complex") + 1]
    assert "volume=0.15" not in explicit[explicit.index("-filter_complex") + 1]
    assert "-stream_loop" not in explicit


def test_source_role_reads_original_video_audio(project: Path) -> None:
    command = _command(
        project,
        {
            "audioTracks": [
                {
                    "assetId": "source",
                    "role": "source",
                    "startSeconds": 1.25,
                    "sourceStartSeconds": 0.5,
                    "durationSeconds": 1,
                    "volume": 0.8,
                }
            ]
        },
    )
    graph = command[command.index("-filter_complex") + 1]

    assert "-i" in command
    assert "[1:a:0]atrim=start=0.5:duration=1" in graph
    assert "adelay=60000S:all=1[t0]" in graph
    assert "sidechaincompress" not in graph


@pytest.mark.parametrize(
    "track, durations, message",
    [
        ({"assetId": "missing", "role": "music", "startSeconds": 0, "durationSeconds": 1}, {"music": 4}, "台账"),
        ({"assetId": "music", "role": "music", "startSeconds": True, "durationSeconds": 1}, {"music": 4}, "数字"),
        ({"assetId": "music", "role": "music", "startSeconds": 0, "durationSeconds": float("nan")}, {"music": 4}, "数字"),
        ({"assetId": "music", "role": "music", "startSeconds": 4.5, "durationSeconds": 1}, {"music": 4}, "片尾"),
        ({"assetId": "music", "role": "music", "startSeconds": 0, "durationSeconds": 1, "volume": 4.1}, {"music": 4}, "音量"),
        ({"assetId": "music", "role": "music", "startSeconds": 0, "durationSeconds": 1, "extra": 1}, {"music": 4}, "未知字段"),
        ({"assetId": "still", "role": "music", "startSeconds": 0, "durationSeconds": 1}, {"still": 4}, "类型不匹配"),
        ({"assetId": "music", "role": "music", "startSeconds": 0, "durationSeconds": 1}, {"music": 0.5}, "素材时长"),
    ],
)
def test_rejects_invalid_timeline_tracks(
    project: Path, track: dict, durations: dict, message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        build_audio_mix_command(
            project,
            {"audioTracks": [track]},
            ffmpeg_path="ffmpeg",
            output_path=project / "renders" / "mix.m4a",
            timeline_duration=5,
            asset_durations=durations,
        )


def test_rejects_asset_escape_and_voice_outside_project(project: Path, tmp_path: Path) -> None:
    manifest_path = project / "assets" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["assets"][0]["path"] = "assets/../../outside.wav"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="路径无效"):
        _command(
            project,
            {
                "audioTracks": [
                    {"assetId": "music", "role": "music", "startSeconds": 0, "durationSeconds": 1}
                ]
            },
        )

    outside_voice = tmp_path / "voice.mp3"
    outside_voice.write_bytes(b"voice")
    with pytest.raises(ValueError):
        _command(project, {}, voice_path=outside_voice)


def test_ffmpeg_mixes_a_real_window_with_exact_audio_duration(project: Path, tmp_path: Path) -> None:
    from mona.api.video_runtime import VideoRuntime

    ffmpeg = VideoRuntime().get_ffmpeg_path()
    ffprobe = VideoRuntime().get_ffprobe_path()
    if not ffmpeg or not ffprobe:
        pytest.skip("Existing FFmpeg runtime is required")

    voice = project / "audio" / "narration.wav"
    voice.parent.mkdir()
    _write_tone(voice, 440)
    output = project / "renders" / "preview.m4a"
    command = build_audio_mix_command(
        project,
        {
            "audioTracks": [
                {
                    "assetId": "music",
                    "role": "music",
                    "startSeconds": 1,
                    "sourceStartSeconds": 0.5,
                    "durationSeconds": 2,
                    "volume": 0.3,
                }
            ]
        },
        ffmpeg_path=ffmpeg,
        output_path=output,
        timeline_duration=5,
        voice_path=voice,
        window_start=2,
        window_duration=1,
        asset_durations={"music": 4},
    )
    result = subprocess.run(command, capture_output=True)
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    probe = json.loads(
        subprocess.check_output(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(output)]
        )
    )
    assert float(probe["format"]["duration"]) == pytest.approx(1, abs=0.06)
    raw = subprocess.check_output(
        [ffmpeg, "-v", "error", "-i", str(output), "-f", "f32le", "-ac", "1", "-ar", "24000", "pipe:1"]
    )
    samples = array.array("f", raw)
    rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
    assert rms > 0.01


def _rms(samples: array.array, sample_rate: int, start: float, end: float) -> float:
    window = samples[round(start * sample_rate) : round(end * sample_rate)]
    return math.sqrt(sum(sample * sample for sample in window) / max(1, len(window)))


def _decode_m4a(ffmpeg: str, path: Path) -> array.array:
    raw = subprocess.check_output(
        [ffmpeg, "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", "24000", "pipe:1"]
    )
    return array.array("f", raw)


def test_ffmpeg_delay_keeps_first_second_silent_before_effect(project: Path) -> None:
    from mona.api.video_runtime import VideoRuntime

    ffmpeg = VideoRuntime().get_ffmpeg_path()
    if not ffmpeg:
        pytest.skip("Existing FFmpeg runtime is required")
    output = project / "renders" / "delayed-effect.m4a"
    command = build_audio_mix_command(
        project,
        {
            "audioTracks": [
                {
                    "assetId": "effect",
                    "role": "effect",
                    "startSeconds": 1,
                    "sourceStartSeconds": 0,
                    "durationSeconds": 0.3,
                }
            ]
        },
        ffmpeg_path=ffmpeg,
        output_path=output,
        timeline_duration=1.3,
        asset_durations={"effect": 4},
    )
    result = subprocess.run(command, capture_output=True)
    assert result.returncode == 0, result.stderr.decode("utf-8", "replace")
    samples = _decode_m4a(ffmpeg, output)

    assert _rms(samples, 24_000, 0.1, 0.9) < 0.005
    assert _rms(samples, 24_000, 1.05, 1.25) > 0.03


def test_window_mix_matches_full_mix_envelope_after_sidechain_history(project: Path) -> None:
    from mona.api.video_runtime import VideoRuntime

    ffmpeg = VideoRuntime().get_ffmpeg_path()
    if not ffmpeg:
        pytest.skip("Existing FFmpeg runtime is required")
    voice = project / "audio" / "gated-voice.wav"
    voice.parent.mkdir()
    sample_rate = 24_000
    frames = bytearray()
    for index in range(sample_rate * 5):
        time = index / sample_rate
        amplitude = 8_000 if time < 2.0 else 0
        sample = round(amplitude * math.sin(2 * math.pi * 440 * time))
        frames.extend(struct.pack("<h", sample))
    with wave.open(str(voice), "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(frames)

    meta = {
        "audioTracks": [
            {
                "assetId": "music",
                "role": "music",
                "startSeconds": 0,
                "durationSeconds": 5,
                "volume": 0.4,
                "loop": True,
            }
        ]
    }
    common = {
        "ffmpeg_path": ffmpeg,
        "timeline_duration": 5,
        "voice_path": voice,
        "asset_durations": {"music": 4},
    }
    full = project / "renders" / "full.m4a"
    window = project / "renders" / "window.m4a"
    for output, options in ((full, {}), (window, {"window_start": 2.1, "window_duration": 1})):
        command = build_audio_mix_command(
            project, meta, output_path=output, **common, **options
        )
        result = subprocess.run(command, capture_output=True)
        assert result.returncode == 0, result.stderr.decode("utf-8", "replace")

    full_samples = _decode_m4a(ffmpeg, full)
    window_samples = _decode_m4a(ffmpeg, window)
    envelope_diffs = [
        abs(
            _rms(full_samples, 24_000, 2.1 + start, 2.1 + start + 0.1)
            - _rms(window_samples, 24_000, start, start + 0.1)
        )
        for start in (index / 10 for index in range(9))
    ]

    assert max(envelope_diffs) < 0.02
