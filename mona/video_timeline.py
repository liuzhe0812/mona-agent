"""Deterministic subtitle and semantic motion timeline contracts for video scenes."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping


class VideoTimelineError(ValueError):
    code = "VIDEO_TIMELINE_INVALID"

    def __init__(self, message: str, *, path: str = "$") -> None:
        super().__init__(message)
        self.message = message
        self.path = path

    def to_dict(self) -> dict[str, Any]:
        return {"error": self.code, "message": self.message, "details": {"path": self.path}}


_SENTENCE_END_RE = re.compile(r"(?<=[。！？!?；;])\s*")
_CLAUSE_END_RE = re.compile(r"(?<=[，,：:])\s*")
_TARGET_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_EFFECTS = {"fade-rise", "stagger-rise", "soft-pulse", "cross-fade", "count-up", "draw-line"}


def _hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _text_weight(value: str) -> int:
    return max(1, sum(1 if ord(char) > 127 else 0.55 for char in value if not char.isspace()))


def _split_long_clause(value: str, max_chars: int) -> list[str]:
    value = value.strip()
    if len(value) <= max_chars:
        return [value] if value else []
    clauses = [item.strip() for item in _CLAUSE_END_RE.split(value) if item.strip()]
    result: list[str] = []
    current = ""
    for clause in clauses or [value]:
        if current and len(current) + len(clause) > max_chars:
            result.append(current)
            current = ""
        while len(clause) > max_chars:
            if current:
                result.append(current)
                current = ""
            result.append(clause[:max_chars])
            clause = clause[max_chars:]
        current += clause
    if current:
        result.append(current)
    return result


def split_subtitle_text(text: str, *, max_chars: int = 18) -> list[str]:
    """Split narration into readable Chinese/English subtitle clauses."""

    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    if not normalized:
        return []
    sentences = [item.strip() for item in _SENTENCE_END_RE.split(normalized) if item.strip()]
    result: list[str] = []
    for sentence in sentences:
        result.extend(_split_long_clause(sentence, max_chars))
    return result


def _normalize_word_timings(values: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    words: list[dict[str, Any]] = []
    for index, value in enumerate(values):
        text = str(value.get("text") or "").strip()
        if not text:
            continue
        try:
            start_ms = int(round(float(value.get("startMs", 0))))
            end_ms = int(round(float(value.get("endMs", start_ms))))
        except (TypeError, ValueError) as exc:
            raise VideoTimelineError("词级时间必须是数字", path=f"$.words[{index}]") from exc
        if start_ms < 0 or end_ms <= start_ms:
            raise VideoTimelineError("词级时间区间无效", path=f"$.words[{index}]")
        words.append({"text": text, "startMs": start_ms, "endMs": end_ms})
    words.sort(key=lambda item: (item["startMs"], item["endMs"]))
    previous_start = -1
    for index, word in enumerate(words):
        if word["startMs"] < previous_start:
            raise VideoTimelineError("词级时间必须单调递增", path=f"$.words[{index}]")
        previous_start = word["startMs"]
    return words


def _cues_from_words(words: list[dict[str, Any]], max_chars: int) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    group: list[dict[str, Any]] = []
    for index, word in enumerate(words):
        group.append(word)
        text = "".join(item["text"] for item in group)
        next_word = words[index + 1] if index + 1 < len(words) else None
        boundary = bool(re.search(r"[。！？!?；;，,：:]$", word["text"]))
        long_gap = bool(next_word and next_word["startMs"] - word["endMs"] >= 450)
        if boundary or long_gap or len(text) >= max_chars or next_word is None:
            cues.append(
                {
                    "id": f"cue-{len(cues) + 1:02d}",
                    "startMs": group[0]["startMs"],
                    "endMs": max(group[-1]["endMs"], group[0]["startMs"] + 300),
                    "text": text,
                    "words": [dict(item) for item in group],
                }
            )
            group = []
    return cues


def _estimated_cues(parts: list[str], duration_ms: int) -> list[dict[str, Any]]:
    if not parts:
        return []
    weights = [_text_weight(part) for part in parts]
    total_weight = sum(weights)
    cursor = 0
    cues: list[dict[str, Any]] = []
    for index, (part, weight) in enumerate(zip(parts, weights)):
        if index == len(parts) - 1:
            end_ms = duration_ms
        else:
            end_ms = cursor + max(320, round(duration_ms * weight / total_weight))
            remaining = len(parts) - index - 1
            end_ms = min(end_ms, duration_ms - remaining * 320)
        cues.append(
            {
                "id": f"cue-{index + 1:02d}",
                "startMs": cursor,
                "endMs": max(cursor + 1, end_ms),
                "text": part,
                "words": [],
            }
        )
        cursor = cues[-1]["endMs"]
    return cues


def build_subtitle_track(
    text: str,
    duration_ms: int,
    *,
    language: str = "zh-CN",
    word_timings: Iterable[Mapping[str, Any]] | None = None,
    audio_hash: str | None = None,
    max_chars: int = 18,
    timing_source: str | None = None,
    alignment_confidence: str | None = None,
) -> dict[str, Any]:
    """Build a validated subtitle track from provider boundaries or estimation."""

    narration = re.sub(r"\s+", " ", str(text or "")).strip()
    if not narration:
        raise VideoTimelineError("字幕源文本不能为空", path="$.sourceText")
    if not isinstance(duration_ms, int) or duration_ms < 300:
        raise VideoTimelineError("字幕轨道时长必须至少为 300ms", path="$.durationMs")
    words = _normalize_word_timings(word_timings or [])
    if words:
        cues = _cues_from_words(words, max_chars)
        duration_ms = max(duration_ms, cues[-1]["endMs"])
        actual_timing_source = timing_source or "provider-boundary"
    else:
        cues = _estimated_cues(split_subtitle_text(narration, max_chars=max_chars), duration_ms)
        actual_timing_source = "estimated"
    track = {
        "schemaVersion": 1,
        "language": language,
        "durationMs": duration_ms,
        "sourceTextHash": _hash_text(narration),
        "audioHash": audio_hash,
        "timingSource": actual_timing_source,
        "alignmentConfidence": alignment_confidence,
        "cues": cues,
    }
    validate_subtitle_track(track)
    return track


def validate_subtitle_track(track: Mapping[str, Any]) -> None:
    if track.get("schemaVersion") != 1:
        raise VideoTimelineError("不支持的字幕轨道版本", path="$.schemaVersion")
    duration_ms = track.get("durationMs")
    if not isinstance(duration_ms, int) or duration_ms <= 0:
        raise VideoTimelineError("字幕轨道时长无效", path="$.durationMs")
    cues = track.get("cues")
    if not isinstance(cues, list) or not cues:
        raise VideoTimelineError("字幕轨道必须包含 cue", path="$.cues")
    previous_end = 0
    for index, cue in enumerate(cues):
        if not isinstance(cue, Mapping) or not str(cue.get("text") or "").strip():
            raise VideoTimelineError("字幕 cue 文本不能为空", path=f"$.cues[{index}]")
        start_ms = cue.get("startMs")
        end_ms = cue.get("endMs")
        if not isinstance(start_ms, int) or not isinstance(end_ms, int):
            raise VideoTimelineError("字幕 cue 时间必须是整数", path=f"$.cues[{index}]")
        if start_ms < previous_end or end_ms <= start_ms or end_ms > duration_ms:
            raise VideoTimelineError("字幕 cue 时间区间无效", path=f"$.cues[{index}]")
        previous_end = end_ms


def _effect(allowed: set[str], *preferences: str) -> str:
    for candidate in preferences:
        if candidate in allowed:
            return candidate
    return "fade-rise"


def _cue_start(cues: list[Mapping[str, Any]], index: int, fallback: int) -> int:
    return int(cues[index]["startMs"]) if index < len(cues) else fallback


def build_motion_plan(
    scene: Mapping[str, Any],
    subtitle_track: Mapping[str, Any],
    *,
    allowed_effects: Iterable[str] = _EFFECTS,
    intensity: str = "standard",
) -> dict[str, Any]:
    """Build semantic, script-aligned motion beats for one scene."""

    validate_subtitle_track(subtitle_track)
    role = str(scene.get("role") or "content").strip().lower()
    duration_ms = int(subtitle_track["durationMs"])
    cues = list(subtitle_track["cues"])
    allowed = {str(item) for item in allowed_effects if str(item) in _EFFECTS}
    if not allowed:
        allowed = {"fade-rise"}
    beats: list[dict[str, Any]] = []

    def add(target: str, effect: str, start_ms: int, length_ms: int, trigger: str) -> None:
        start = max(0, min(start_ms, duration_ms - 1))
        end = max(start + 1, min(duration_ms, start + length_ms))
        beats.append(
            {
                "id": f"beat-{len(beats) + 1:02d}",
                "startMs": start,
                "endMs": end,
                "trigger": trigger,
                "target": target,
                "effect": effect,
                "intensity": intensity,
            }
        )

    add("title", _effect(allowed, "fade-rise", "cross-fade"), 0, 720, "scene-start")
    if role == "cover":
        add("visual", _effect(allowed, "soft-pulse", "fade-rise"), _cue_start(cues, 0, 700), 900, "cue-01")
        add("body", _effect(allowed, "cross-fade", "fade-rise"), _cue_start(cues, 1, 1300), 650, "cue-02")
    elif role in {"data", "comparison"}:
        add("body", _effect(allowed, "cross-fade", "fade-rise"), _cue_start(cues, 0, 600), 550, "cue-01")
        target_prefix = "metric" if role == "data" else "comparison"
        for index in range(min(3, max(1, len(cues)))):
            add(
                f"{target_prefix}.{index}",
                _effect(allowed, "count-up", "stagger-rise", "fade-rise"),
                _cue_start(cues, index, 900 + index * 500),
                700,
                f"cue-{index + 1:02d}",
            )
    elif role == "process":
        for index in range(min(4, max(1, len(cues)))):
            add(
                f"step.{index}",
                _effect(allowed, "stagger-rise", "fade-rise"),
                _cue_start(cues, index, 650 + index * 550),
                650,
                f"cue-{index + 1:02d}",
            )
    elif role == "outro":
        add("brand", _effect(allowed, "soft-pulse", "cross-fade"), _cue_start(cues, 0, 700), 850, "cue-01")
    else:
        add("body", _effect(allowed, "cross-fade", "fade-rise"), _cue_start(cues, 0, 650), 600, "cue-01")
        for index in range(min(3, max(0, len(cues) - 1))):
            add(
                f"item.{index}",
                _effect(allowed, "stagger-rise", "fade-rise"),
                _cue_start(cues, index + 1, 1100 + index * 500),
                600,
                f"cue-{index + 2:02d}",
            )

    plan = {
        "schemaVersion": 1,
        "sceneIndex": int(scene.get("index") or 1),
        "durationMs": duration_ms,
        "scriptHash": str(subtitle_track.get("sourceTextHash") or ""),
        "beats": sorted(beats, key=lambda item: (item["startMs"], item["id"])),
    }
    validate_motion_plan(plan, allowed_effects=allowed)
    return plan


def validate_motion_plan(
    plan: Mapping[str, Any], *, allowed_effects: Iterable[str] = _EFFECTS
) -> None:
    if plan.get("schemaVersion") != 1:
        raise VideoTimelineError("不支持的动画计划版本", path="$.schemaVersion")
    duration_ms = plan.get("durationMs")
    if not isinstance(duration_ms, int) or duration_ms <= 0:
        raise VideoTimelineError("动画计划时长无效", path="$.durationMs")
    allowed = set(allowed_effects)
    beats = plan.get("beats")
    if not isinstance(beats, list) or not beats:
        raise VideoTimelineError("动画计划必须包含节拍", path="$.beats")
    for index, beat in enumerate(beats):
        if not isinstance(beat, Mapping):
            raise VideoTimelineError("动画节拍必须是对象", path=f"$.beats[{index}]")
        target = str(beat.get("target") or "")
        if not _TARGET_RE.fullmatch(target):
            raise VideoTimelineError("动画目标无效", path=f"$.beats[{index}].target")
        if beat.get("effect") not in allowed:
            raise VideoTimelineError("动画效果不在允许列表", path=f"$.beats[{index}].effect")
        start_ms = beat.get("startMs")
        end_ms = beat.get("endMs")
        if not isinstance(start_ms, int) or not isinstance(end_ms, int):
            raise VideoTimelineError("动画时间必须是整数", path=f"$.beats[{index}]")
        if start_ms < 0 or end_ms <= start_ms or end_ms > duration_ms:
            raise VideoTimelineError("动画时间区间无效", path=f"$.beats[{index}]")


def summarize_motion_plan(plan: Mapping[str, Any]) -> str:
    """Return a short user-facing Chinese summary of semantic motion beats."""

    target_names = {
        "title": "标题",
        "body": "正文",
        "visual": "主画面",
        "brand": "品牌",
    }
    effect_names = {
        "fade-rise": "淡入上浮",
        "stagger-rise": "依次出现",
        "soft-pulse": "轻微强调",
        "cross-fade": "柔和淡入",
        "count-up": "数字递增",
        "draw-line": "线条绘制",
    }
    parts: list[str] = []
    for beat in plan.get("beats") or []:
        target = str(beat.get("target") or "")
        prefix = target.split(".", 1)[0]
        target_name = target_names.get(
            target,
            {
                "item": "要点",
                "step": "步骤",
                "metric": "数据",
                "comparison": "对比项",
            }.get(prefix, "元素"),
        )
        effect_name = effect_names.get(str(beat.get("effect") or ""), "出现")
        label = f"{target_name}{effect_name}"
        if label not in parts:
            parts.append(label)
        if len(parts) == 4:
            break
    return " → ".join(parts)


def _subtitle_timestamp(milliseconds: int, *, vtt: bool = False) -> str:
    total = max(0, int(milliseconds))
    hours, remainder = divmod(total, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    separator = "." if vtt else ","
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}{separator}{millis:03d}"


def subtitle_cues_to_srt(cues: Iterable[Mapping[str, Any]]) -> str:
    blocks: list[str] = []
    for index, cue in enumerate(cues, start=1):
        text = str(cue.get("text") or "").strip()
        start_ms = int(cue.get("startMs") or 0)
        end_ms = int(cue.get("endMs") or 0)
        if not text or end_ms <= start_ms:
            continue
        blocks.append(
            f"{index}\n{_subtitle_timestamp(start_ms)} --> "
            f"{_subtitle_timestamp(end_ms)}\n{text}"
        )
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def subtitle_cues_to_vtt(cues: Iterable[Mapping[str, Any]]) -> str:
    blocks = ["WEBVTT"]
    for cue in cues:
        text = str(cue.get("text") or "").strip()
        start_ms = int(cue.get("startMs") or 0)
        end_ms = int(cue.get("endMs") or 0)
        if not text or end_ms <= start_ms:
            continue
        blocks.append(
            f"{_subtitle_timestamp(start_ms, vtt=True)} --> "
            f"{_subtitle_timestamp(end_ms, vtt=True)}\n{text}"
        )
    return "\n\n".join(blocks) + "\n"


def write_timeline_json(path: Path, payload: Mapping[str, Any]) -> None:
    """Atomically write one validated timeline artifact."""

    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


__all__ = [
    "VideoTimelineError",
    "build_motion_plan",
    "build_subtitle_track",
    "split_subtitle_text",
    "subtitle_cues_to_srt",
    "subtitle_cues_to_vtt",
    "summarize_motion_plan",
    "validate_motion_plan",
    "validate_subtitle_track",
    "write_timeline_json",
]
