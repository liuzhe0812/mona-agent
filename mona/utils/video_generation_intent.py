"""Helpers for WebUI video-generation intent metadata."""

from __future__ import annotations

from typing import Any

VIDEO_GENERATION_METADATA_KEY = "video_generation"


def video_generation_prompt(content: str, metadata: dict[str, Any] | None) -> str:
    """Decorate a user prompt when WebUI video mode is enabled."""
    raw = (metadata or {}).get(VIDEO_GENERATION_METADATA_KEY)
    if not isinstance(raw, dict) or raw.get("enabled") is not True:
        return content

    aspect_ratio = raw.get("aspect_ratio")
    duration = raw.get("duration")
    reference_image_url = raw.get("reference_image_url")

    parts: list[str] = [
        "The user selected WebUI video generation mode. Use the generate_video tool."
    ]
    if isinstance(aspect_ratio, str) and aspect_ratio.strip():
        parts.append(f"Pass aspect_ratio={aspect_ratio!r}.")
    else:
        parts.append("Choose the most suitable aspect_ratio yourself.")
    if isinstance(duration, int) and duration > 0:
        parts.append(f"Pass duration={duration}.")
    if isinstance(reference_image_url, str) and reference_image_url.strip():
        parts.append(
            f"Pass reference_images=[{reference_image_url!r}] to drive image-to-video generation."
        )
    instruction = " ".join(parts)
    return f"{content}\n\n[WebUI video generation instruction: {instruction}]"
