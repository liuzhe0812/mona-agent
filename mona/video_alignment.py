"""FFmpeg-backed sentence alignment for TTS providers without timestamps."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from mona.video_timeline import split_subtitle_text

_SILENCE_START_RE = re.compile(r"silence_start:\s*([0-9.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*([0-9.]+)")


@dataclass(frozen=True)
class AudioAlignmentResult:
    boundaries: tuple[dict[str, object], ...]
    timing_source: str
    confidence: str
    duration_ms: int


def _creation_flags() -> int:
    return 0x08000000 if sys.platform == "win32" else 0


def _audio_duration_ms(audio_path: Path, ffprobe_path: str) -> int:
    process = subprocess.run(
        [
            ffprobe_path,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(audio_path),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        timeout=30,
        creationflags=_creation_flags(),
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr or "无法读取音频时长")
    duration = float((json.loads(process.stdout).get("format") or {}).get("duration") or 0)
    if duration <= 0:
        raise RuntimeError("音频时长无效")
    return int(round(duration * 1000))


def _speech_intervals(
    audio_path: Path,
    ffmpeg_path: str,
    duration_ms: int,
) -> list[tuple[int, int]]:
    process = subprocess.run(
        [
            ffmpeg_path,
            "-hide_banner",
            "-nostats",
            "-i",
            str(audio_path),
            "-af",
            "silencedetect=noise=-35dB:d=0.12",
            "-f",
            "null",
            "-",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
        timeout=60,
        creationflags=_creation_flags(),
    )
    stderr = process.stderr or ""
    starts = [int(round(float(value) * 1000)) for value in _SILENCE_START_RE.findall(stderr)]
    ends = [int(round(float(value) * 1000)) for value in _SILENCE_END_RE.findall(stderr)]
    silences: list[tuple[int, int]] = []
    end_cursor = 0
    for start in starts:
        end = next((value for value in ends if value >= start and value >= end_cursor), duration_ms)
        silences.append((max(0, start), min(duration_ms, end)))
        end_cursor = end
    if ends and not starts:
        silences.append((0, min(duration_ms, ends[0])))
    cursor = 0
    speech: list[tuple[int, int]] = []
    for start, end in sorted(silences):
        if start - cursor >= 80:
            speech.append((cursor, start))
        cursor = max(cursor, end)
    if duration_ms - cursor >= 80:
        speech.append((cursor, duration_ms))
    return speech or [(0, duration_ms)]


def _text_weight(value: str) -> float:
    return max(
        1.0,
        sum(1.0 if ord(char) > 127 else 0.55 for char in value if not char.isspace()),
    )


def _map_speech_position(intervals: list[tuple[int, int]], position: float) -> int:
    remaining = max(0.0, position)
    for start, end in intervals:
        length = end - start
        if remaining <= length:
            return int(round(start + remaining))
        remaining -= length
    return intervals[-1][1]


def align_tts_audio(
    audio_path: Path | str,
    text: str,
    *,
    ffmpeg_path: str,
    ffprobe_path: str,
    max_chars: int = 18,
) -> AudioAlignmentResult:
    """Align known TTS text to real speech regions at sentence/clause level."""

    path = Path(audio_path)
    parts = split_subtitle_text(text, max_chars=max_chars)
    if not parts:
        raise ValueError("对齐文本不能为空")
    duration_ms = _audio_duration_ms(path, ffprobe_path)
    intervals = _speech_intervals(path, ffmpeg_path, duration_ms)
    if len(parts) == len(intervals):
        boundaries = tuple(
            {"text": part, "startMs": start, "endMs": end}
            for part, (start, end) in zip(parts, intervals)
        )
        confidence = "high"
    else:
        total_speech = sum(end - start for start, end in intervals)
        weights = [_text_weight(part) for part in parts]
        total_weight = sum(weights)
        cursor = 0.0
        values: list[dict[str, object]] = []
        for index, (part, weight) in enumerate(zip(parts, weights)):
            start = _map_speech_position(intervals, cursor)
            cursor = (
                float(total_speech)
                if index == len(parts) - 1
                else cursor + total_speech * weight / total_weight
            )
            end = max(start + 1, _map_speech_position(intervals, cursor))
            values.append({"text": part, "startMs": start, "endMs": end})
        boundaries = tuple(values)
        confidence = "review"
    return AudioAlignmentResult(
        boundaries=boundaries,
        timing_source="acoustic-sentence-alignment",
        confidence=confidence,
        duration_ms=duration_ms,
    )


__all__ = ["AudioAlignmentResult", "align_tts_audio"]
