from __future__ import annotations

import asyncio
import json
import math
import os
import struct
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

import pytest

from mona.api import server
from mona.api.video_runtime import VideoRuntime


async def _start_sleeping_child(tmp_path: Path, name: str) -> asyncio.subprocess.Process:
    python = sys._base_executable
    assert python, "The base Python executable is required to test child process cleanup"
    pid_file = tmp_path / f"{name}.pid"
    source = (
        "import os, pathlib, sys, time; "
        "pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding='utf-8'); "
        "time.sleep(30)"
    )
    process = await asyncio.create_subprocess_exec(
        python,
        "-u",
        "-c",
        source,
        str(pid_file),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    deadline = asyncio.get_running_loop().time() + 3
    while not pid_file.is_file():
        if process.returncode is not None:
            pytest.fail("sleeping child exited before it could be cancelled")
        if asyncio.get_running_loop().time() >= deadline:
            pytest.fail("sleeping child did not report its PID")
        await asyncio.sleep(0.02)
    assert int(pid_file.read_text(encoding="utf-8")) == process.pid
    return process


async def _ensure_process_stopped(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        process.kill()
        await process.wait()


@pytest.mark.asyncio
async def test_video_subprocess_timeout_stops_python_child(tmp_path: Path) -> None:
    process = await _start_sleeping_child(tmp_path, "timeout")
    try:
        with pytest.raises(TimeoutError, match="视频处理超时"):
            await server._communicate_video_subprocess(process, timeout=0.25)
        assert process.returncode is not None
    finally:
        await _ensure_process_stopped(process)


@pytest.mark.asyncio
async def test_video_subprocess_cancel_event_stops_python_child(tmp_path: Path) -> None:
    process = await _start_sleeping_child(tmp_path, "event-cancel")
    cancel_event = threading.Event()
    timer = asyncio.get_running_loop().call_later(0.25, cancel_event.set)
    try:
        with pytest.raises(server._VideoRenderCancelledError):
            await server._communicate_video_subprocess(process, cancel_event)
        assert process.returncode is not None
    finally:
        timer.cancel()
        await _ensure_process_stopped(process)


@pytest.mark.asyncio
async def test_video_subprocess_task_cancellation_stops_python_child(
    tmp_path: Path,
) -> None:
    process = await _start_sleeping_child(tmp_path, "task-cancel")
    try:
        communicate = asyncio.create_task(
            server._communicate_video_subprocess(process, timeout=30)
        )
        await asyncio.sleep(0.05)
        communicate.cancel()
        with pytest.raises(asyncio.CancelledError):
            await communicate
        assert process.returncode is not None
    finally:
        await _ensure_process_stopped(process)


def _make_video_project(tmp_path: Path) -> tuple[Path, str, str, dict[str, Any]]:
    runtime = VideoRuntime()
    ffmpeg = runtime.get_ffmpeg_path()
    ffprobe = runtime.get_ffprobe_path()
    if not ffmpeg or not ffprobe:
        pytest.skip("Existing VideoRuntime FFmpeg and FFprobe are required")

    project = tmp_path / "video-project"
    audio_dir = project / "audio"
    render_dir = project / "renders"
    for directory in (audio_dir, render_dir, project / "assets"):
        directory.mkdir(parents=True, exist_ok=True)

    video = render_dir / "output.pending.mp4"
    voice = audio_dir / "narration.mp3"
    subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x180:r=12:d=1.25",
            "-an",
            "-c:v",
            "mpeg4",
            "-q:v",
            "5",
            str(video),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=0.55",
            "-c:a",
            "libmp3lame",
            "-q:a",
            "4",
            str(voice),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    meta: dict[str, Any] = {
        "narrationEnabled": True,
        "musicPreset": "none",
        "audioTracks": [],
        "scenes": [{"index": 1, "duration": 1.25, "narration": "test narration"}],
    }
    return project, ffmpeg, ffprobe, meta


def _ffmpeg_calls(monkeypatch: pytest.MonkeyPatch, ffmpeg: str) -> list[dict[str, Any]]:
    original = asyncio.create_subprocess_exec
    expected = os.path.normcase(os.path.abspath(ffmpeg))
    calls: list[dict[str, Any]] = []

    async def record(*args: Any, **kwargs: Any) -> asyncio.subprocess.Process:
        argv = tuple(os.fspath(arg) for arg in args)
        if os.path.normcase(os.path.abspath(argv[0])) == expected:
            calls.append({"argv": argv, "stdin": kwargs.get("stdin")})
        return await original(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", record)
    return calls


def _probe_duration(ffprobe: str, video: Path) -> float:
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(video),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
        text=True,
    )
    return float(json.loads(result.stdout)["format"]["duration"])


def _decoded_audio_rms(ffmpeg: str, video: Path) -> float:
    result = subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(video),
            "-map",
            "0:a:0",
            "-t",
            "0.5",
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            "24000",
            "pipe:1",
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    samples = (sample[0] for sample in struct.iter_unpack("<h", result.stdout))
    squares = [sample * sample for sample in samples]
    return math.sqrt(sum(squares) / len(squares)) if squares else 0.0


@pytest.mark.asyncio
async def test_mix_project_audio_runs_real_ffmpeg_and_preserves_previous_output_on_mux_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project, ffmpeg, ffprobe, meta = _make_video_project(tmp_path)
    video = project / "renders" / "output.pending.mp4"
    render_result: dict[str, Any] = {
        "output": "renders/output.pending.mp4",
        "duration": 1.25,
    }
    calls = _ffmpeg_calls(monkeypatch, ffmpeg)

    await server._mix_project_audio(project, meta, render_result, threading.Event())

    assert len(calls) == 2
    assert all(call["stdin"] == asyncio.subprocess.DEVNULL for call in calls)
    assert all("-nostdin" in call["argv"] for call in calls)
    assert calls[0]["argv"][-1].endswith("audio-mix.pending.m4a")
    assert calls[1]["argv"][-1].endswith("audio-mixed.pending.mp4")
    assert render_result["audio"] is True
    assert 1.0 <= _probe_duration(ffprobe, video) <= 1.4
    assert _decoded_audio_rms(ffmpeg, video) > 100

    original_output = video.read_bytes()
    mux_pending = project / "renders" / "audio-mixed.pending.mp4"
    real_create_subprocess_exec = asyncio.create_subprocess_exec
    failed_mux_process: asyncio.subprocess.Process | None = None

    async def fail_real_mux(*args: Any, **kwargs: Any) -> asyncio.subprocess.Process:
        nonlocal failed_mux_process
        argv = tuple(os.fspath(arg) for arg in args)
        if Path(argv[-1]) == mux_pending:
            argv = (argv[0], "-this-option-does-not-exist", *argv[1:])
        process = await real_create_subprocess_exec(*argv, **kwargs)
        if Path(os.fspath(args[-1])) == mux_pending:
            failed_mux_process = process
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fail_real_mux)
    with pytest.raises(RuntimeError, match="视频导出失败"):
        await server._mix_project_audio(
            project,
            meta,
            {"output": "renders/output.pending.mp4", "duration": 1.25},
            threading.Event(),
        )

    assert failed_mux_process is not None
    assert failed_mux_process.returncode not in (None, 0)
    assert video.read_bytes() == original_output
    assert not (project / "renders" / "audio-mix.pending.m4a").exists()
    assert not mux_pending.exists()
