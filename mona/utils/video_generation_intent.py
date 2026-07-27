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
    prompt itself, and treats any attached images as image-to-video references.
    Attached image paths are surfaced to the model so it can pass them to
    ``generate_video``; the tool uploads them to Mona's image host and only
    forwards the resulting HTTP URL to the provider.
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
            "The user attached image(s). Pass their local paths as reference_images "
            f"to drive image-to-video generation: [{listed}]. "
            "The tool will upload them automatically — do not invent HTTP URLs."
        )
    instruction = " ".join(parts)
    return f"{content}\n\n[WebUI video generation instruction: {instruction}]"
