"""Helpers for WebUI video-generation intent metadata."""

from __future__ import annotations

from typing import Any

VIDEO_GENERATION_METADATA_KEY = "video_generation"


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
    if not isinstance(raw, dict) or raw.get("enabled") is not True:
        return content

    parts: list[str] = [
        "The user selected WebUI video generation mode. Use the generate_video tool.",
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
