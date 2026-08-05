#!/usr/bin/env python3
"""Synthesize narration audio for a video project using TTS providers.

Reads ``<project_path>/meta.json`` for TTS config (provider/voice/rate,
defaults to edge + zh-CN-XiaoyiNeural) and ``<project_path>/storyboard.md``
for per-scene narration text, then synthesizes one MP3 per scene into
``<project_path>/audio/scene_NN.mp3`` and concatenates them into
``<project_path>/audio/narration.mp3`` via FFmpeg.

Usage:
    python synthesize_narration.py <project_path>
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# "### Scene 1:" heading
SCENE_HEADING_RE = re.compile(r"^###\s+Scene\s+(\d+)\s*:", re.IGNORECASE)
# "- Narration: <text>" (may span to end of line)
NARRATION_LINE_RE = re.compile(r"-\s*Narration:\s*(.+?)\s*$", re.IGNORECASE)

DEFAULT_TTS_PROVIDER = "edge"
DEFAULT_TTS_VOICE = "zh-CN-XiaoyiNeural"
DEFAULT_TTS_RATE = "+0%"


def _resolve_ffmpeg() -> str | None:
    """Return the ffmpeg executable name if available, else None."""
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


def parse_narrations(storyboard_path: Path) -> dict[int, str]:
    """Parse ``storyboard.md`` and return ``{scene_num: narration_text}``."""
    if not storyboard_path.exists():
        return {}
    text = storyboard_path.read_text(encoding="utf-8")
    narrations: dict[int, str] = {}
    current_scene: int | None = None
    for line in text.splitlines():
        heading = SCENE_HEADING_RE.match(line)
        if heading:
            current_scene = int(heading.group(1))
            continue
        if current_scene is None:
            continue
        m = NARRATION_LINE_RE.search(line)
        if m:
            narrations[current_scene] = m.group(1).strip()
    return narrations


async def synthesize_project(project_path: str | Path) -> dict:
    """Synthesize narration MP3s for a video project.

    Returns a dict with ``ok`` and either a summary of the generated audio
    files, or an ``error`` message.
    """
    project = Path(project_path)
    if not project.exists():
        return {"ok": False, "error": f"Project not found: {project_path}"}

    meta_file = project / "meta.json"
    if not meta_file.is_file():
        return {"ok": False, "error": "meta.json not found — create the project first"}

    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"meta.json parse error: {e}"}

    if not meta.get("narrationEnabled", False):
        return {
            "ok": False,
            "skipped": True,
            "reason": "narrationEnabled is false in meta.json",
        }

    provider_name = str(meta.get("ttsProvider") or DEFAULT_TTS_PROVIDER).strip() or DEFAULT_TTS_PROVIDER
    voice = str(meta.get("ttsVoice") or DEFAULT_TTS_VOICE).strip() or DEFAULT_TTS_VOICE
    rate = str(meta.get("ttsRate") or DEFAULT_TTS_RATE).strip() or DEFAULT_TTS_RATE

    narrations = parse_narrations(project / "storyboard.md")
    if not narrations:
        return {"ok": False, "error": "No narration text found in storyboard.md"}

    # Lazy import to avoid loading edge_tts when narration is disabled.
    from mona.providers.tts import EdgeTTSProvider, get_tts_provider

    if provider_name == "edge":
        # EdgeTTSProvider accepts rate in __init__.
        provider = EdgeTTSProvider(voice=voice, rate=rate)
    elif provider_name == "custom":
        # Custom OpenAI-compatible TTS — user must supply api_base/api_key/model.
        api_base = str(meta.get("ttsApiBase") or "").strip()
        api_key = str(meta.get("ttsApiKey") or "").strip()
        model = str(meta.get("ttsModel") or "tts-1").strip() or "tts-1"
        if not api_base or not api_key:
            return {"ok": False, "error": "custom TTS requires ttsApiBase and ttsApiKey in meta.json"}
        provider = get_tts_provider(
            "custom",
            api_key=api_key,
            api_base=api_base,
            voice=voice,
            model=model,
            rate=rate,
        )
    else:
        provider = get_tts_provider(provider_name, voice=voice)

    audio_dir = project / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    generated: list[dict] = []
    failed: list[dict] = []
    for scene_num in sorted(narrations):
        text = narrations[scene_num]
        out_name = f"scene_{scene_num:02d}.mp3"
        out_path = audio_dir / out_name
        try:
            result = await provider.synthesize(text, out_path, voice=voice)
        except Exception as e:
            failed.append({"scene": scene_num, "error": str(e)})
            continue
        if result is None:
            failed.append({"scene": scene_num, "error": "TTS returned no audio"})
            continue
        generated.append({"scene": scene_num, "file": out_name, "chars": len(text)})

    if not generated:
        return {"ok": False, "error": "No scenes were synthesized"}

    # Concatenate all scene MP3s into narration.mp3 using FFmpeg concat demuxer.
    ffmpeg = _resolve_ffmpeg()
    if ffmpeg is None:
        return {
            "ok": True,
            "scenes": generated,
            "warning": "FFmpeg not found; scene MP3s were generated but narration.mp3 was not concatenated",
        }

    concat_list = audio_dir / "concat_list.txt"
    concat_lines = [f"file '{g['file']}'" for g in generated]
    concat_list.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")

    narration_path = audio_dir / "narration.mp3"
    try:
        subprocess.run(
            [
                ffmpeg,
                "-f", "concat",
                "-safe", "0",
                "-i", str(concat_list),
                "-c", "copy",
                "-y",
                str(narration_path),
            ],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        return {
            "ok": False,
            "error": f"FFmpeg concat failed: {stderr.strip() or e}",
            "scenes": generated,
        }

    return {
        "ok": True,
        "scenes": generated,
        "failed": failed,
        "narration": str(narration_path.relative_to(project)),
        "total_scenes": len(generated),
    }


def _cli() -> None:
    # Only redirect stdout/stderr when run as a CLI script — never when imported
    # as a module (would corrupt the host process's stdout and deadlock aiohttp).
    if os.name == "nt" and hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(
        description="Synthesize narration audio for a video project",
    )
    parser.add_argument(
        "project_path",
        type=Path,
        help="Video project directory containing meta.json and storyboard.md",
    )
    args = parser.parse_args()
    result = asyncio.run(synthesize_project(args.project_path))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    _cli()
