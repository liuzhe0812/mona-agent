"""Separate reply text from optional, validated performance decisions."""

import json
import math
import re

_FENCE = re.compile(r"\A```json[ \t]*\r?\n(.*?)\r?\n```\Z", re.DOTALL | re.IGNORECASE)
_TONES = {"neutral", "gentle", "cheerful", "serious", "curious"}
_GAZES = {"user", "left", "right", "down"}
_GESTURES = {"none", "nod", "shake_head", "small_wave"}


def _text(value: object) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 64_000:
        raise ValueError("Reply text must be nonempty and at most 64000 characters.")
    return value


def _unit_number(value: object) -> bool:
    return type(value) in (int, float) and 0 <= value <= 1 and math.isfinite(value)


def _performance(value: object) -> dict | None:
    if not isinstance(value, dict) or set(value) != {"tone", "smile", "gaze", "gesture"}:
        return None
    tone, smile, gaze, gesture = value["tone"], value["smile"], value["gaze"], value["gesture"]
    if not isinstance(tone, str) or tone not in _TONES:
        return None
    if not isinstance(gaze, str) or gaze not in _GAZES or not _unit_number(smile):
        return None
    if not isinstance(gesture, dict) or set(gesture) != {"type", "strength"}:
        return None
    gesture_type, strength = gesture["type"], gesture["strength"]
    if not isinstance(gesture_type, str) or gesture_type not in _GESTURES or not _unit_number(strength):
        return None
    return {
        "tone": tone,
        "smile": float(smile),
        "gaze": gaze,
        "gesture": {"type": gesture_type, "strength": float(strength)},
    }


def parse_reply(content: str) -> dict:
    if not isinstance(content, str):
        raise TypeError("Reply must be text.")
    fenced = _FENCE.fullmatch(content.strip())
    try:
        parsed = json.loads(fenced.group(1) if fenced else content)
    except json.JSONDecodeError:
        if fenced:
            raise ValueError("The JSON reply is invalid.") from None
        return {"text": _text(content), "performance": None, "performance_status": "missing"}

    if not isinstance(parsed, dict) or "text" not in parsed:
        raise ValueError("The JSON reply must be an object containing text.")
    text = _text(parsed["text"])
    if "performance" not in parsed:
        return {"text": text, "performance": None, "performance_status": "missing"}
    performance = _performance(parsed["performance"])
    return {
        "text": text,
        "performance": performance,
        "performance_status": "valid" if performance is not None else "invalid",
    }
