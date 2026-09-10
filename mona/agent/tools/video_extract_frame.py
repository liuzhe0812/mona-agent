"""Agent capability for extracting keyframes from a video at given timestamps.

Used after url2note when the transcript contains visual references
(e.g. "as shown", "look at this interface"). The Agent decides which
timestamps are worth sampling; this tool downloads the video once and
extracts the requested frames, then saves them into the notes vault.
"""

from __future__ import annotations

import shutil
from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    ArraySchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.tools.tauri_ipc import tauri_invoke_async
from mona.api.url2note import Url2NoteError, Url2NoteExtractor


@tool_parameters(
    tool_parameters_schema(
        url=StringSchema(
            "Public video URL (Bilibili/Douyin/Toutiao) to extract frames from. "
            "Must be the same URL passed to url2note."
        ),
        timestamps=ArraySchema(
            StringSchema("Timestamp like 00:01:23 or 02:45"),
            description=(
                "List of timestamps (HH:MM:SS or MM:SS) at which to extract keyframes. "
                "Max 8 frames per call. Pass all timestamps in one call so the video "
                "is downloaded only once."
            ),
            max_items=8,
        ),
        required=["url", "timestamps"],
    )
)
class VideoExtractFrameTool(Tool):
    """Extract keyframes from a video and save them to the notes vault."""

    _scopes = {"core"}
    _plugin_discoverable = True

    def __init__(self, extractor: Url2NoteExtractor | None = None) -> None:
        self._extractor = extractor or Url2NoteExtractor()

    @property
    def name(self) -> str:
        return "video_extract_frame"

    @property
    def description(self) -> str:
        return (
            "Extract keyframes from a public video (Bilibili/Douyin/Toutiao) at specified "
            "timestamps and save them to the notes vault. Returns Markdown reference paths "
            "like 'assets/frame-001-01m23s.png' for embedding in notes_create. "
            "Use after url2note when the transcript contains visual references "
            "('as shown', 'look here', 'this interface', '按照画面'). Pass all timestamps "
            "in one call to download the video only once. Do not extract frames for pure "
            "voice-over segments."
        )

    async def execute(self, **kwargs: Any) -> str:
        url = str(kwargs.get("url") or "").strip()
        timestamps = list(kwargs.get("timestamps") or [])

        if not url:
            return "Error: url is required."
        if not timestamps:
            return "Error: timestamps is required and must not be empty."

        try:
            frames = await self._extractor.extract_frames(url, timestamps)
        except Url2NoteError as exc:
            return f"Error extracting frames: {exc}"

        saved: list[str] = []
        failed: list[str] = []
        try:
            for frame_path, ts in zip(frames, timestamps, strict=False):
                file_name = frame_path.name
                try:
                    rel_path = await tauri_invoke_async(
                        "notes_save_image",
                        {"filePath": str(frame_path), "fileName": file_name},
                    )
                except RuntimeError as exc:
                    logger.warning("notes_save_image failed for {}: {}", frame_path, exc)
                    failed.append(f"{ts}: {exc}")
                    continue
                if isinstance(rel_path, str) and rel_path:
                    saved.append(f"- {ts} → `![]({rel_path})`")
                else:
                    failed.append(f"{ts}: unexpected response {rel_path!r}")
        finally:
            # Frames live in a private temp dir owned by the extractor; clean up
            # the source files regardless of save success.
            for frame in frames:
                try:
                    frame.unlink(missing_ok=True)
                except OSError:
                    pass
            parent = frames[0].parent if frames else None
            if parent is not None and parent.exists():
                shutil.rmtree(parent, ignore_errors=True)

        if not saved:
            failure_detail = "\n".join(failed) if failed else ""
            return (
                "Frame extraction succeeded but no images were saved to the vault. "
                + failure_detail
            )

        lines = ["Saved keyframes (use these Markdown references in notes_create):"]
        lines.extend(saved)
        if failed:
            lines.append("")
            lines.append("Failed to save:")
            lines.extend(f"- {item}" for item in failed)
        return "\n".join(lines)
