#!/usr/bin/env python3
"""Render video from HTML scenes using headless Chromium + CDP.

Pipeline:
1. Start Chrome headless with --remote-debugging-port
2. For each scene_*.html:
   - Navigate via Page.navigate
   - Wait for GSAP ready
   - Per frame (1/fps second step):
     * Runtime.evaluate: seek gsap.globalTimeline to t
     * Page.captureScreenshot → save PNG
3. FFmpeg encodes PNG sequence → silent MP4
4. (Optional) FFmpeg mux narration.mp3 → final MP4

Usage:
    python render.py <project_path> [--fps 30] [--quality draft|standard|high]
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from check_edge import find_browser  # noqa: E402
from merge_scenes import (  # noqa: E402
    DEFAULT_HEIGHT,
    DEFAULT_WIDTH,
    compute_timeline,
    list_scenes,
    parse_storyboard,
)

__all__ = ("render_project", "render_project_async")

# Quality presets: (fps, width_scale, height_scale, crf)
_QUALITY_PRESETS: dict[str, tuple[int, float, int]] = {
    "draft": (24, 0.5, 28),  # half resolution, lower quality
    "standard": (30, 1.0, 23),
    "high": (60, 1.0, 18),
}


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _resolve_ffmpeg() -> str | None:
    for candidate in ("ffmpeg",):
        try:
            subprocess.run(
                [candidate, "-version"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )
            return candidate
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    return None


# ---------------------------------------------------------------------------
# CDP client
# ---------------------------------------------------------------------------

_cdp_msg_id = 0


def _next_cdp_id() -> int:
    global _cdp_msg_id
    _cdp_msg_id += 1
    return _cdp_msg_id


async def _cdp_call(
    ws,
    method: str,
    params: dict | None = None,
    *,
    timeout: float = 60.0,
) -> dict:
    """Send a CDP command and await its matching result."""
    msg_id = _next_cdp_id()
    payload: dict = {"id": msg_id, "method": method}
    if params:
        payload["params"] = params
    await ws.send(json.dumps(payload))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        data = json.loads(raw)
        if data.get("id") == msg_id:
            if "error" in data:
                raise RuntimeError(f"CDP {method} error: {data['error']}")
            return data.get("result", {})
    raise TimeoutError(f"CDP {method} timed out after {timeout}s")


async def _wait_for_event(ws, event_name: str, *, timeout: float = 30.0) -> dict:
    """Await a specific CDP event."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        data = json.loads(raw)
        if data.get("method") == event_name:
            return data.get("params", {})
    raise TimeoutError(f"Event {event_name} timed out after {timeout}s")


# ---------------------------------------------------------------------------
# Chrome process
# ---------------------------------------------------------------------------


def _start_chrome(browser: str, port: int, width: int, height: int, user_data_dir: Path) -> subprocess.Popen:
    args = [
        browser,
        "--headless=new",
        f"--remote-debugging-port={port}",
        f"--window-size={width},{height}",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        "--disable-extensions",
        "--disable-features=Translate,SiteIsolation",
        "--disable-background-networking",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
        "--force-device-scale-factor=1",
        "--enable-precise-memory-info",
        "about:blank",
    ]
    creationflags = 0
    if os.name == "nt":
        creationflags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
    return subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        creationflags=creationflags,
    )


def _read_devtools_url(proc: subprocess.Popen, port: int, *, timeout: float = 15.0) -> str:
    """Read the DevTools WebSocket URL for a **page-level** target.

    ``/json/version`` returns the browser-level ``webSocketDebuggerUrl``,
    which does NOT support page domains (Page, Runtime, Emulation, etc.).
    We must connect to a page-level target from ``/json/list`` instead.
    """
    deadline = time.monotonic() + timeout
    import urllib.request

    while time.monotonic() < deadline:
        # Query /json/list to find page-level targets
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{port}/json/list", timeout=2
            ) as r:
                targets = json.loads(r.read().decode("utf-8"))
                for target in targets:
                    if target.get("type") == "page":
                        ws_url = target.get("webSocketDebuggerUrl")
                        if ws_url:
                            return ws_url
        except Exception:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"Chrome DevTools page target not found on port {port}")


# ---------------------------------------------------------------------------
# Scene rendering
# ---------------------------------------------------------------------------

_SEEK_JS_TEMPLATE = """
(() => {
  const t = __TIME__;
  if (window.__timelines) {
    for (const k in window.__timelines) {
      const tl = window.__timelines[k];
      if (tl && typeof tl.seek === 'function') tl.seek(t);
      if (tl && typeof tl.pause === 'function') tl.pause();
    }
  }
  if (window.gsap && window.gsap.globalTimeline) {
    window.gsap.globalTimeline.pause();
    window.gsap.globalTimeline.seek(t);
  }
  return true;
})();
"""


_WAIT_GSAP_JS = """
(() => {
  if (typeof window.gsap === 'undefined') return false;
  if (window.__timelines) {
    for (const k in window.__timelines) {
      const tl = window.__timelines[k];
      if (tl && typeof tl.seek === 'function') return true;
    }
  }
  if (window.gsap.globalTimeline) return true;
  return false;
})();
"""


def _build_seek_js(t: float) -> str:
    return _SEEK_JS_TEMPLATE.replace("__TIME__", repr(float(t)))


async def _render_scene(
    ws,
    scene_path: Path,
    duration: float,
    fps: int,
    width: int,
    height: int,
    frames_dir: Path,
    frame_offset: int,
) -> int:
    """Render one scene to a sequence of PNGs. Returns frame count."""
    file_url = scene_path.resolve().as_uri()

    # Some Chromium builds (e.g. chrome-headless-shell) do not expose the Page
    # domain. Enable it when available and fall back to ready-state polling.
    page_enabled = False
    try:
        await _cdp_call(ws, "Page.enable")
        page_enabled = True
    except RuntimeError as e:
        if "wasn't found" in str(e):
            print(f"Warning: Page.enable not supported, using polling fallback", file=sys.stderr)
        else:
            raise

    # chrome-headless-shell may not expose the Emulation domain either.
    try:
        await _cdp_call(ws, "Emulation.setDeviceMetricsOverride", {
            "width": width,
            "height": height,
            "deviceScaleFactor": 1,
            "mobile": False,
        })
    except RuntimeError as e:
        if "wasn't found" in str(e):
            print("Warning: Emulation.setDeviceMetricsOverride not supported, relying on --window-size", file=sys.stderr)
        else:
            raise

    # Page.navigate is also missing from chrome-headless-shell. Fall back to
    # a Runtime.evaluate navigation via window.location.
    try:
        await _cdp_call(ws, "Page.navigate", {"url": file_url})
    except RuntimeError as e:
        if "wasn't found" in str(e):
            print("Warning: Page.navigate not supported, using window.location fallback", file=sys.stderr)
            await _cdp_call(ws, "Runtime.evaluate", {
                "expression": f"window.location.href = {json.dumps(file_url)}",
                "returnByValue": True,
            })
        else:
            raise

    if page_enabled:
        await _wait_for_event(ws, "Page.loadEventFired", timeout=30.0)
    else:
        for _ in range(300):
            result = await _cdp_call(ws, "Runtime.evaluate", {
                "expression": "document.readyState === 'complete'",
                "returnByValue": True,
            })
            if result.get("result", {}).get("value") is True:
                break
            await asyncio.sleep(0.1)

    # Wait for GSAP to be ready (poll up to 5s)
    for _ in range(50):
        result = await _cdp_call(ws, "Runtime.evaluate", {
            "expression": _WAIT_GSAP_JS,
            "returnByValue": True,
        })
        if result.get("result", {}).get("value") is True:
            break
        await asyncio.sleep(0.1)
    else:
        # Continue even if GSAP not detected — scenes may have CSS-only animation
        pass

    # Initial pause at t=0
    await _cdp_call(ws, "Runtime.evaluate", {
        "expression": _build_seek_js(0),
        "returnByValue": True,
    })
    await asyncio.sleep(0.1)

    total_frames = max(1, int(round(duration * fps)))
    for i in range(total_frames):
        t = (i + 0.5) / fps  # sample mid-frame
        if t > duration:
            t = duration
        await _cdp_call(ws, "Runtime.evaluate", {
            "expression": _build_seek_js(round(t, 4)),
            "returnByValue": True,
        })
        # Allow layout/paint to settle
        await asyncio.sleep(0.04)
        result = await _cdp_call(ws, "Page.captureScreenshot", {
            "format": "png",
            "captureBeyondViewport": False,
        })
        data_b64 = result.get("data", "")
        if not data_b64:
            continue
        png_bytes = base64.b64decode(data_b64)
        frame_idx = frame_offset + i
        out_path = frames_dir / f"frame_{frame_idx:06d}.png"
        out_path.write_bytes(png_bytes)
    return total_frames


# ---------------------------------------------------------------------------
# Encoding
# ---------------------------------------------------------------------------


def _encode_mp4(
    frames_dir: Path,
    output_mp4: Path,
    fps: int,
    crf: int,
) -> bool:
    """Encode PNG sequence → MP4 via FFmpeg."""
    ffmpeg = _resolve_ffmpeg()
    if ffmpeg is None:
        return False
    cmd = [
        ffmpeg,
        "-y",
        "-framerate", str(fps),
        "-i", str(frames_dir / "frame_%06d.png"),
        "-c:v", "libx264",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-preset", "medium",
        "-movflags", "+faststart",
        str(output_mp4),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        raise RuntimeError(f"FFmpeg encoding failed: {stderr.strip()[:500]}") from e


def _mux_audio(silent_mp4: Path, narration_mp3: Path, output_mp4: Path) -> bool:
    """Mux narration audio into silent MP4."""
    ffmpeg = _resolve_ffmpeg()
    if ffmpeg is None:
        return False
    cmd = [
        ffmpeg,
        "-y",
        "-i", str(silent_mp4),
        "-i", str(narration_mp3),
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        str(output_mp4),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        raise RuntimeError(f"FFmpeg mux failed: {stderr.strip()[:500]}") from e


def _concat_scene_audio(scene_mp3s: list[Path], output_mp3: Path) -> bool:
    """Concatenate per-scene MP3s into a single narration.mp3 via FFmpeg concat demuxer."""
    ffmpeg = _resolve_ffmpeg()
    if ffmpeg is None or not scene_mp3s:
        return False
    concat_list = output_mp3.parent / "concat_list.txt"
    # 用绝对路径避免 ffmpeg concat demuxer 的相对路径解析问题
    concat_lines = [f"file '{p.resolve().as_posix()}'" for p in scene_mp3s]
    concat_list.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
    cmd = [
        ffmpeg,
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(concat_list),
        "-c", "copy",
        str(output_mp3),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        raise RuntimeError(f"FFmpeg audio concat failed: {stderr.strip()[:500]}") from e


# ---------------------------------------------------------------------------
# Main render entry
# ---------------------------------------------------------------------------


async def render_project_async(
    project_path: str | Path,
    fps: int = 30,
    quality: str = "standard",
) -> dict:
    """Render all scenes in a project to MP4 via headless Chromium + CDP."""
    project = Path(project_path)
    if not project.exists():
        return {"ok": False, "error": f"Project not found: {project_path}"}

    scenes_dir = project / "scenes"
    if not scenes_dir.is_dir():
        return {"ok": False, "error": f"Scenes directory not found: {scenes_dir}"}

    scenes = list_scenes(scenes_dir)
    if not scenes:
        return {"ok": False, "error": "No scene_*.html files found"}

    storyboard = parse_storyboard(project / "storyboard.md")
    width, height = storyboard.get("resolution") or (DEFAULT_WIDTH, DEFAULT_HEIGHT)
    timeline, total_duration = compute_timeline(scenes, storyboard)

    # Apply quality preset
    preset = _QUALITY_PRESETS.get(quality, _QUALITY_PRESETS["standard"])
    preset_fps, scale, crf = preset
    if fps <= 0:
        fps = preset_fps
    if scale != 1.0:
        width = max(2, int(round(width * scale)))
        height = max(2, int(round(height * scale)))

    browser = find_browser()
    if not browser:
        return {
            "ok": False,
            "error": (
                "未找到可用于视频渲染的浏览器。"
                "请安装完整版 Google Chrome 或 Microsoft Edge（chrome-headless-shell 不支持所需 CDP 命令）。"
            ),
            "need_download": True,
        }

    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        return {"ok": False, "error": "FFmpeg not found in PATH", "need_download": True}

    # Prepare output dirs
    frames_dir = project / "frames"
    if frames_dir.exists():
        for f in frames_dir.glob("*.png"):
            try:
                f.unlink()
            except OSError:
                pass
    frames_dir.mkdir(parents=True, exist_ok=True)
    renders_dir = project / "renders"
    renders_dir.mkdir(parents=True, exist_ok=True)
    silent_mp4 = renders_dir / "silent.mp4"
    output_mp4 = renders_dir / "output.mp4"

    # Start Chrome
    port = _find_free_port()
    user_data_dir = project / ".chrome-profile"
    user_data_dir.mkdir(parents=True, exist_ok=True)
    proc = _start_chrome(browser, port, width, height, user_data_dir)
    try:
        ws_url = _read_devtools_url(proc, port)
        # Connect via websockets
        try:
            import websockets
        except ImportError as e:
            return {"ok": False, "error": f"websockets library required: {e}"}

        async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
            frame_offset = 0
            scene_results: list[dict] = []
            for num, path, start, duration in timeline:
                count = await _render_scene(
                    ws, path, duration, fps, width, height,
                    frames_dir, frame_offset,
                )
                scene_results.append({
                    "scene": num,
                    "start": round(start, 3),
                    "duration": round(duration, 3),
                    "frames": count,
                })
                frame_offset += count

        # Encode silent MP4
        _encode_mp4(frames_dir, silent_mp4, fps, crf)

        # Mux audio if narration exists
        narration_mp3 = project / "audio" / "narration.mp3"
        # 若 narration.mp3 不存在但已有分镜音频,自动拼接(synthesize_narration
        # 可能因单场景失败中断而未执行 concat)
        if not narration_mp3.is_file():
            scene_mp3s = sorted((project / "audio").glob("scene_*.mp3"))
            if scene_mp3s:
                _concat_scene_audio(scene_mp3s, narration_mp3)
        if narration_mp3.is_file():
            _mux_audio(silent_mp4, narration_mp3, output_mp4)
        else:
            # Rename silent.mp4 to output.mp4
            # Windows 上 Path.rename 不会覆盖已存在文件(抛 WinError 183),
            # 用 Path.replace 保证覆盖
            silent_mp4.replace(output_mp4)

        return {
            "ok": True,
            "output": str(output_mp4.relative_to(project)),
            "absolute_output": str(output_mp4),
            "duration": round(total_duration, 3),
            "fps": fps,
            "resolution": [width, height],
            "scenes": scene_results,
            "total_frames": frame_offset,
            "audio": narration_mp3.is_file(),
        }
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def render_project(project_path: str | Path, fps: int = 30, quality: str = "standard") -> dict:
    """Sync wrapper around render_project_async."""
    return asyncio.run(render_project_async(project_path, fps=fps, quality=quality))


def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Render video project to MP4 via headless Chromium + CDP",
    )
    parser.add_argument("project_path", type=Path, help="Video project directory")
    parser.add_argument("--fps", type=int, default=0, help="Frames per second (0 = use quality preset)")
    parser.add_argument(
        "--quality",
        choices=["draft", "standard", "high"],
        default="standard",
        help="Quality preset",
    )
    args = parser.parse_args()
    result = render_project(args.project_path, fps=args.fps, quality=args.quality)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    _cli()
