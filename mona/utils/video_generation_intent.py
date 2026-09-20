"""Helpers for WebUI video-generation intent metadata."""

from __future__ import annotations

import re
from typing import Any

VIDEO_GENERATION_METADATA_KEY = "video_generation"

_EXPLICIT_VIDEO_GENERATION_PATTERNS = (
    re.compile(
        r"(?:请|帮我|给我|开始|重新|重试|再试|继续)?"
        r"(?:生成|制作|创建|做)(?:一个|一段|个|段)?[^。！？\n]{0,24}"
        r"(?:视频|影片|短片|动画)"
    ),
    re.compile(
        r"\b(?:generate|create|make|regenerate)\b[^.!?\n]{0,48}"
        r"\b(?:video|clip|animation)\b",
        re.IGNORECASE,
    ),
    re.compile(
        r"\b(?:retry|continue)\b[^.!?\n]{0,48}"
        r"\b(?:generating|generation of)?\s*(?:a\s+)?(?:video|clip|animation)\b",
        re.IGNORECASE,
    ),
)


def is_video_generation_request(
    content: str,
    metadata: dict[str, Any] | None,
) -> bool:
    """Return whether this turn explicitly asks Mona to generate a video."""
    raw = (metadata or {}).get(VIDEO_GENERATION_METADATA_KEY)
    if isinstance(raw, dict) and raw.get("enabled") is True:
        return True
    text = content.strip()
    return bool(text) and any(pattern.search(text) for pattern in _EXPLICIT_VIDEO_GENERATION_PATTERNS)


def video_generation_prompt(
    content: str,
    metadata: dict[str, Any] | None,
    *,
    media: list[str] | None = None,
) -> str:
    """Decorate a user prompt when WebUI video mode is enabled.

    The WebUI no longer asks the user to pick aspect ratio / duration / a
    reference image URL inline. Instead the AI chooses parameters from the
    prompt itself and maps attached images to general references or explicit
    first/last frames according to the user's wording.
    """
    raw = (metadata or {}).get(VIDEO_GENERATION_METADATA_KEY)
    mode_selected = isinstance(raw, dict) and raw.get("enabled") is True
    if not is_video_generation_request(content, metadata):
        return content

    parts: list[str] = [
        (
            "The user selected WebUI video generation mode."
            if mode_selected
            else "The user's message explicitly requests video generation."
        ),
        "Use the generate_video tool directly; do not use terminal tools or manual HTTP requests to invoke the provider.",
        "Choose suitable aspect_ratio and duration yourself based on the prompt.",
    ]
    image_paths = [p for p in (media or []) if isinstance(p, str) and p.strip()]
    if image_paths:
        listed = ", ".join(repr(p) for p in image_paths)
        parts.append(
            "The user attached image(s). Use their local paths as reference_images, "
            "first_frame, or last_frame according to the user's wording: "
            f"[{listed}]. Do not invent HTTP URLs or imply frame order when the user did not."
        )
    instruction = " ".join(parts)
    return f"{content}\n\n[WebUI video generation instruction: {instruction}]"
