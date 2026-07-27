#!/usr/bin/env python3
"""Postprocess video: mix narration + BGM and mux into silent MP4.

This script is optional — render.py already handles narration-only mux.
Use this when the user adds a bgm.mp3 file later and wants to regenerate
the final video without re-rendering frames.

Usage:
    python postprocess.py <project_path> [--bgm-volume 0.2]
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

if os.name == "nt" and hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


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


def _run_ffmpeg(cmd: list[str]) -> None:
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        raise RuntimeError(f"FFmpeg failed: {stderr.strip()[:500]}") from e


def mix_audio(
    narration_mp3: Path,
    bgm_mp3: Path,
    output_mp3: Path,
    bgm_volume: float = 0.2,
) -> bool:
    """Mix narration and BGM into a single MP3. Returns True on success."""
    ffmpeg = _resolve_ffmpeg()
    if ffmpeg is None:
        return False
    filter_complex = (
        f"[1:a]volume={bgm_volume}[bgm];"
        "[0:a][bgm]amix=inputs=2:duration=first[aout]"
    )
    _run_ffmpeg([
        ffmpeg, "-y",
        "-i", str(narration_mp3),
        "-i", str(bgm_mp3),
        "-filter_complex", filter_complex,
        "-map", "[aout]",
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        str(output_mp3),
    ])
    return True


def mux_video(silent_mp4: Path, audio_mp3: Path, output_mp4: Path) -> bool:
    """Mux audio track into silent MP4. Returns True on success."""
    ffmpeg = _resolve_ffmpeg()
    if ffmpeg is None:
        return False
    _run_ffmpeg([
        ffmpeg, "-y",
        "-i", str(silent_mp4),
        "-i", str(audio_mp3),
        "-c:v", "copy",
        "-c:a", "aac",
        "-b:a", "192k",
        "-shortest",
        "-movflags", "+faststart",
        str(output_mp4),
    ])
    return True


def postprocess_project(
    project_path: str | Path,
    bgm_volume: float = 0.2,
) -> dict:
    """Re-mux audio (narration + optional BGM) into the silent MP4.

    Requires renders/silent.mp4 to exist (produced by render.py).
    """
    project = Path(project_path)
    if not project.exists():
        return {"ok": False, "error": f"Project not found: {project_path}"}

    silent_mp4 = project / "renders" / "silent.mp4"
    if not silent_mp4.is_file():
        return {
            "ok": False,
            "error": "renders/silent.mp4 not found — run render.py first",
        }

    ffmpeg = _resolve_ffmpeg()
    if not ffmpeg:
        return {"ok": False, "error": "FFmpeg not found in PATH"}

    audio_dir = project / "audio"
    narration_mp3 = audio_dir / "narration.mp3"
    bgm_mp3 = audio_dir / "bgm.mp3"
    output_mp4 = project / "renders" / "output.mp4"

    has_narration = narration_mp3.is_file()
    has_bgm = bgm_mp3.is_file()

    if has_narration and has_bgm:
        # Mix narration + BGM → mixed.mp3, then mux
        mixed_mp3 = audio_dir / "mixed.mp3"
        mix_audio(narration_mp3, bgm_mp3, mixed_mp3, bgm_volume=bgm_volume)
        mux_video(silent_mp4, mixed_mp3, output_mp4)
        return {
            "ok": True,
            "output": str(output_mp4.relative_to(project)),
            "audio": "narration+bgm",
            "bgm_volume": bgm_volume,
        }
    if has_narration:
        mux_video(silent_mp4, narration_mp3, output_mp4)
        return {
            "ok": True,
            "output": str(output_mp4.relative_to(project)),
            "audio": "narration",
        }
    if has_bgm:
        mux_video(silent_mp4, bgm_mp3, output_mp4)
        return {
            "ok": True,
            "output": str(output_mp4.relative_to(project)),
            "audio": "bgm",
            "bgm_volume": bgm_volume,
        }
    # No audio at all — just copy silent.mp4 to output.mp4
    shutil.copy2(silent_mp4, output_mp4)
    return {
        "ok": True,
        "output": str(output_mp4.relative_to(project)),
        "audio": "none",
    }


def _cli() -> None:
    parser = argparse.ArgumentParser(
        description="Postprocess video: mix narration + BGM and mux into silent MP4",
    )
    parser.add_argument("project_path", type=Path, help="Video project directory")
    parser.add_argument(
        "--bgm-volume",
        type=float,
        default=0.2,
        help="BGM volume (0.0-1.0, default 0.2)",
    )
    args = parser.parse_args()
    result = postprocess_project(args.project_path, bgm_volume=args.bgm_volume)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    _cli()
