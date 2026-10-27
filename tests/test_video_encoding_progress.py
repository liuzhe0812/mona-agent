"""Real-process coverage for video encode progress and render-status saves."""

from __future__ import annotations

import ctypes
import importlib.util
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from PIL import Image

from mona.api import server
from mona.api.video_runtime import VideoRuntime


def _load_renderer():
    script = (
        Path(__file__).parents[1]
        / "mona"
        / "skills"
        / "mona-motion"
        / "scripts"
        / "render.py"
    )
    spec = importlib.util.spec_from_file_location(
        "mona_video_encoding_progress_test", script
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_child(tmp_path: Path, name: str, source: str) -> list[str]:
    script = tmp_path / f"{name}.py"
    script.write_text(source, encoding="utf-8")
    return [sys.executable, "-u", str(script)]


def _process_is_running(pid: int) -> bool:
    if os.name == "nt":
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            error = ctypes.get_last_error()
            if error in {6, 87, 1168}:
                return False
            raise ctypes.WinError(error)
        try:
            exit_code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                raise ctypes.WinError(ctypes.get_last_error())
            return exit_code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _assert_process_stopped(pid: int, *, timeout: float = 4.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _process_is_running(pid):
            return
        time.sleep(0.05)
    pytest.fail(f"renderer child process {pid} was not stopped")


def test_run_ffmpeg_reports_live_frames_without_stalling_on_stderr(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    renderer = _load_renderer()
    monkeypatch.setattr(renderer, "_FFMPEG_STALL_TIMEOUT_SECONDS", 2.0)
    completed = tmp_path / "child-completed"
    script = f"""
import os, sys, time
from pathlib import Path
for frame in range(1, 21):
    print(f"frame={{frame}}", flush=True)
    sys.stderr.write("e" * 65536)
    sys.stderr.flush()
    time.sleep(0.02)
time.sleep(0.1)
Path({json.dumps(str(completed))}).write_text("done", encoding="utf-8")
"""
    callbacks: list[tuple[int, bool]] = []

    renderer._run_ffmpeg(
        _write_child(tmp_path, "progress-and-stderr", script),
        frame_cb=lambda frame: callbacks.append((frame, completed.exists())),
    )

    assert [frame for frame, _finished in callbacks] == list(range(1, 21))
    assert callbacks[0][1] is False
    assert completed.read_text(encoding="utf-8") == "done"


def test_run_ffmpeg_kills_child_when_frame_progress_stalls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    renderer = _load_renderer()
    monkeypatch.setattr(renderer, "_FFMPEG_STALL_TIMEOUT_SECONDS", 0.2)
    pid_file = tmp_path / "stalling-child.pid"
    script = f"""
import os, sys, time
from pathlib import Path
Path({json.dumps(str(pid_file))}).write_text(str(os.getpid()), encoding="utf-8")
print("frame=1", flush=True)
time.sleep(30)
"""
    started = time.monotonic()

    with pytest.raises(TimeoutError, match="stopped making progress"):
        renderer._run_ffmpeg(
            _write_child(tmp_path, "stalling-child", script),
            frame_cb=lambda _frame: None,
        )

    assert time.monotonic() - started < 4
    _assert_process_stopped(int(pid_file.read_text(encoding="utf-8")))


def test_run_ffmpeg_cancellation_stops_child_without_waiting_for_stall_timeout(
    tmp_path: Path,
) -> None:
    renderer = _load_renderer()
    cancel_event = threading.Event()
    pid_file = tmp_path / "cancelled-child.pid"
    script = f"""
import os, sys, time
from pathlib import Path
Path({json.dumps(str(pid_file))}).write_text(str(os.getpid()), encoding="utf-8")
print("frame=1", flush=True)
time.sleep(30)
"""
    timer = threading.Timer(0.25, cancel_event.set)
    timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(renderer.RenderCancelledError):
            renderer._run_ffmpeg(
                _write_child(tmp_path, "cancelled-child", script),
                cancel_event=cancel_event,
                frame_cb=lambda _frame: None,
            )
    finally:
        timer.cancel()
        timer.join(timeout=1)

    assert time.monotonic() - started < 4
    _assert_process_stopped(int(pid_file.read_text(encoding="utf-8")))


def test_encode_mp4_real_ffmpeg_reports_monotonic_progress_and_correct_output(
    tmp_path: Path,
) -> None:
    runtime = VideoRuntime()
    ffmpeg = runtime.get_ffmpeg_path()
    ffprobe = runtime.get_ffprobe_path()
    if not ffmpeg or not ffprobe:
        pytest.skip("Existing FFmpeg and FFprobe runtimes are required")

    renderer = _load_renderer()
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    total_frames = 6
    fps = 5
    for index in range(total_frames):
        Image.new("RGB", (64, 48), (index * 25, 40, 180)).save(
            frames_dir / f"frame_{index + 1:06}.png",
            format="PNG",
        )
    output = tmp_path / "encoded.mp4"
    progress: list[tuple[str, float, str]] = []

    encoded = renderer._encode_mp4(
        frames_dir,
        output,
        fps=fps,
        crf=35,
        ffmpeg_path=ffmpeg,
        total_frames=total_frames,
        progress_cb=lambda stage, percent, message: progress.append(
            (stage, percent, message)
        ),
    )

    assert encoded is True
    assert output.is_file() and output.stat().st_size > 0
    assert progress
    percentages = [percent for _stage, percent, _message in progress]
    assert percentages == sorted(percentages)
    assert percentages[-1] == pytest.approx(95.0)
    assert all(stage == "encoding" for stage, _percent, _message in progress)
    assert f"{total_frames / fps:.1f}/{total_frames / fps:.1f} 秒" in progress[-1][2]

    probe = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames,duration",
            "-of",
            "json",
            str(output),
        ],
        capture_output=True,
        check=True,
        text=True,
        timeout=10,
    )
    stream = json.loads(probe.stdout)["streams"][0]
    assert int(stream["nb_read_frames"]) == total_frames
    assert float(stream["duration"]) == pytest.approx(total_frames / fps, abs=0.05)


@pytest.mark.skipif(os.name != "nt", reason="Windows sharing-deny behavior only")
def test_write_render_status_retries_a_short_windows_reader_lock(tmp_path: Path) -> None:
    from ctypes import wintypes

    project = tmp_path / "video-project"
    project.mkdir()
    status_path = project / ".render_status.json"
    server._write_render_status(project, {"stage": "idle", "progress": 0})

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.CreateFileW(
        str(status_path),
        0x80000000,  # GENERIC_READ
        0x00000001 | 0x00000002,  # FILE_SHARE_READ | FILE_SHARE_WRITE; deny delete
        None,
        3,  # OPEN_EXISTING
        0x80,  # FILE_ATTRIBUTE_NORMAL
        None,
    )
    if not handle or handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())

    released = threading.Event()

    def release_lock() -> None:
        time.sleep(0.12)
        if not kernel32.CloseHandle(handle):
            raise ctypes.WinError(ctypes.get_last_error())
        released.set()

    release_thread = threading.Thread(target=release_lock, daemon=True)
    release_thread.start()
    try:
        server._write_render_status(
            project,
            {"stage": "rendering", "progress": 37, "message": "保存中"},
        )
    finally:
        release_thread.join(timeout=2)

    assert released.is_set()
    assert server._read_render_status(project) == {
        "stage": "rendering",
        "progress": 37,
        "message": "保存中",
    }
