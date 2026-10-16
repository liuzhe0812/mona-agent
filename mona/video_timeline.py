"""Deterministic subtitle and semantic motion timeline contracts for video scenes."""

from __future__ import annotations

import hashlib
import json
import math
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
_ALIGNMENT_IGNORED_RE = re.compile(r"[\s，。！？；：、,.!?;:…—“”\"'‘’（）()《》「」『』【】〈〉\[\]]")
_ALIGNMENT_UNIT_RE = re.compile(r"[A-Za-z0-9]+(?:[.'][A-Za-z0-9]+)*|[\s\S]")
_TARGET_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_EFFECTS = {"fade-rise", "stagger-rise", "soft-pulse", "cross-fade", "count-up", "draw-line"}
SUBTITLE_GROUPING_VERSION = 3


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


def _alignment_chars(text: str) -> tuple[list[str], list[int]]:
    characters: list[str] = []
    positions: list[int] = []
    for index, character in enumerate(text):
        if _ALIGNMENT_IGNORED_RE.fullmatch(character):
            continue
        characters.append(character.lower() if character.isascii() else character)
        positions.append(index)
    return characters, positions


def _aligned_word_display_texts(text: str, words: list[dict[str, Any]]) -> list[str] | None:
    """Restore script punctuation/spacing only when provider text aligns exactly."""
    script_chars, script_positions = _alignment_chars(text)
    word_chars = [_alignment_chars(word["text"])[0] for word in words]
    if not script_chars or any(not chars for chars in word_chars):
        return None
    if [character for chars in word_chars for character in chars] != script_chars:
        return None

    display: list[str] = []
    cursor = 0
    for index, chars in enumerate(word_chars):
        next_cursor = cursor + len(chars)
        start = 0 if index == 0 else script_positions[cursor]
        end = len(text) if index == len(words) - 1 else script_positions[next_cursor]
        display.append(text[start:end])
        cursor = next_cursor
    return display


def _subtitle_unit_count(text: str) -> int:
    return sum(
        1
        for unit in _ALIGNMENT_UNIT_RE.findall(text)
        if not _ALIGNMENT_IGNORED_RE.fullmatch(unit)
    )


def _split_overlong_word_group(
    group: list[tuple[dict[str, Any], str]], max_chars: int
) -> list[list[tuple[dict[str, Any], str]]]:
    total = sum(_subtitle_unit_count(display) for _, display in group)
    if total <= max_chars or len(group) < 2:
        return [group]

    lower = math.ceil(total * 0.3)
    upper = math.floor(total * 0.7)
    candidates: list[tuple[int, int, int]] = []
    cumulative = 0
    for index, (word, display) in enumerate(group[:-1], 1):
        cumulative += _subtitle_unit_count(display)
        if lower <= cumulative <= upper:
            next_word = group[index][0]
            pause = int(next_word["startMs"]) - int(word["endMs"])
            candidates.append((index, cumulative, pause))
    if not candidates:
        return [group]

    pauses = [candidate for candidate in candidates if candidate[2] > 0]
    if pauses:
        split_at = max(pauses, key=lambda item: (item[2], -abs(item[1] - total / 2)))[0]
    else:
        split_at = min(candidates, key=lambda item: abs(item[1] - total / 2))[0]
    return _split_overlong_word_group(group[:split_at], max_chars) + _split_overlong_word_group(
        group[split_at:], max_chars
    )


def _cues_from_words(
    words: list[dict[str, Any]], max_chars: int, display_texts: list[str]
) -> list[dict[str, Any]]:
    # Adapted from Dashi Animationstyle pipeline/字幕.mjs units()/splitCues() (MIT).
    # Provider word boundaries stay indivisible; overlong lines split at a balanced
    # central word gap, matching Dashi's 30%-70% longest-pause rule.
    cues: list[dict[str, Any]] = []
    groups: list[list[tuple[dict[str, Any], str]]] = []
    group: list[tuple[dict[str, Any], str]] = []
    for word, display in zip(words, display_texts, strict=True):
        group.append((word, display))
        ending = display.rstrip()
        sentence_end = bool(re.search(r"[。！？!?…\n]$", ending))
        clause_end = bool(re.search(r"[，,；;：:]$", ending))
        if sentence_end or clause_end:
            groups.append(group)
            group = []
    if group:
        groups.append(group)

    for boundary_group in groups:
        for part in _split_overlong_word_group(boundary_group, max_chars):
            cue_words = [word for word, _ in part]
            cues.append(
                {
                    "id": f"cue-{len(cues) + 1:02d}",
                    "startMs": cue_words[0]["startMs"],
                    "endMs": max(cue_words[-1]["endMs"], cue_words[0]["startMs"] + 300),
                    "text": "".join(display for _, display in part),
                    "words": [dict(item) for item in cue_words],
                    "displayWords": [display for _, display in part],
                }
            )
    # Provider rounding can make adjacent word groups overlap by a millisecond.
    for cue, following in zip(cues, cues[1:]):
        if cue["startMs"] < following["startMs"] < cue["endMs"]:
            cue["endMs"] = following["startMs"]
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
        display_texts = _aligned_word_display_texts(narration, words)
        cues = _cues_from_words(
            words,
            max_chars,
            display_texts or [word["text"] for word in words],
        )
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
        "groupingVersion": SUBTITLE_GROUPING_VERSION,
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
    return "fade-rise" if "fade-rise" in allowed else sorted(allowed)[0]


def _cue_start(cues: list[Mapping[str, Any]], index: int, fallback: int) -> int:
    return int(cues[index]["startMs"]) if index < len(cues) else fallback


def build_motion_plan(
    scene: Mapping[str, Any],
    subtitle_track: Mapping[str, Any],
    *,
    allowed_effects: Iterable[str] = _EFFECTS,
    intensity: str = "standard",
    motion_preferences: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Build semantic, script-aligned motion beats for one scene."""

    validate_subtitle_track(subtitle_track)
    role = str(scene.get("role") or "content").strip().lower()
    duration_ms = int(subtitle_track["durationMs"])
    cues = list(subtitle_track["cues"])
    allowed = {str(item) for item in allowed_effects if str(item) in _EFFECTS}
    if not allowed:
        allowed = {"fade-rise"}
    preferences = motion_preferences or {}
    enter = str(preferences.get("enterPreset") or "")
    emphasis = str(preferences.get("emphasisPreset") or "")
    intensity = str(preferences.get("intensity") or intensity)
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

    add("title", _effect(allowed, enter, "fade-rise", "cross-fade"), 0, 720, "scene-start")
    if role == "cover":
        add("visual", _effect(allowed, emphasis, "soft-pulse", "fade-rise"), _cue_start(cues, 0, 700), 900, "cue-01")
        add("body", _effect(allowed, enter, "cross-fade", "fade-rise"), _cue_start(cues, 1, 1300), 650, "cue-02")
    elif role in {"data", "comparison"}:
        add("body", _effect(allowed, enter, "cross-fade", "fade-rise"), _cue_start(cues, 0, 600), 550, "cue-01")
        target_prefix = "metric" if role == "data" else "comparison"
        for index in range(min(3, max(1, len(cues)))):
            add(
                f"{target_prefix}.{index}",
                _effect(allowed, emphasis, "count-up", "stagger-rise", "fade-rise"),
                _cue_start(cues, index, 900 + index * 500),
                700,
                f"cue-{index + 1:02d}",
            )
    elif role == "process":
        for index in range(min(4, max(1, len(cues)))):
            add(
                f"step.{index}",
                _effect(allowed, enter, "stagger-rise", "fade-rise"),
                _cue_start(cues, index, 650 + index * 550),
                650,
                f"cue-{index + 1:02d}",
            )
    elif role == "outro":
        add("brand", _effect(allowed, emphasis, "soft-pulse", "cross-fade"), _cue_start(cues, 0, 700), 850, "cue-01")
    else:
        add("body", _effect(allowed, enter, "cross-fade", "fade-rise"), _cue_start(cues, 0, 650), 600, "cue-01")
        for index in range(min(3, max(0, len(cues) - 1))):
            add(
                f"item.{index}",
                _effect(allowed, enter, "stagger-rise", "fade-rise"),
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
    if preferences:
        transition_ms = preferences.get("transitionDurationMs", 420)
        if isinstance(transition_ms, bool) or not isinstance(transition_ms, (int, float)) or not 0 <= transition_ms <= 5000:
            raise VideoTimelineError("场景切换时长必须在 0 到 5000ms 之间", path="$.transitionDurationMs")
        plan["transitionPreset"] = _effect(allowed, str(preferences.get("transitionPreset") or ""), "cross-fade")
        plan["transitionDurationMs"] = min(duration_ms, int(transition_ms))
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
