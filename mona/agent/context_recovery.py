"""Recover older tool images without rewriting the execution history."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mona.utils.artifacts import decode_image_data_url
from mona.utils.helpers import _TOOL_RESULTS_DIR, safe_filename
from mona.utils.media_store import store_media_bytes


def _inline_image_url(block: Any) -> str | None:
    if not isinstance(block, dict) or block.get("type") != "image_url":
        return None
    image = block.get("image_url")
    url = image.get("url") if isinstance(image, dict) else None
    return url if isinstance(url, str) and url.startswith("data:image/") else None


def _store_image(url: str, workspace: Path, session_key: str | None) -> Path:
    root = workspace.resolve()
    image_dir = (root / _TOOL_RESULTS_DIR / safe_filename(session_key or "default") / "images").resolve()
    if not image_dir.is_relative_to(root):
        raise ValueError("Tool image storage escaped the workspace")
    raw, mime = decode_image_data_url(url)
    suffix = ".jpg" if mime == "image/jpeg" else "." + mime.split("/")[-1]
    return store_media_bytes(raw, image_dir, suffix)


def persist_tool_images(content: Any, workspace: Path | None, session_key: str | None) -> Any:
    """Give volatile tool images a recoverable path before checkpointing."""
    if workspace is None or not isinstance(content, list):
        return content
    saved = []
    for block in content:
        url = _inline_image_url(block)
        meta = block.get("_meta") or {} if isinstance(block, dict) else {}
        if url and not meta.get("path"):
            path = _store_image(url, workspace, session_key)
            block = {**block, "_meta": {**meta, "path": str(path)}}
        saved.append(block)
    return saved


def project_tool_images(messages: list[dict], replacements: dict[int, list[dict]]) -> list[dict]:
    if not replacements:
        return messages
    return [
        {**message, "content": replacements[index]}
        if message.get("role") == "tool" and index in replacements
        else message
        for index, message in enumerate(messages)
    ]


def offload_tool_images(
    messages: list[dict], workspace: Path | None, session_key: str | None,
) -> dict[int, list[dict[str, Any]]]:
    """Save older inline screenshots; keep the newest image result attached."""
    if workspace is None:
        return {}
    candidates = [
        (index, message) for index, message in enumerate(messages)
        if message.get("role") == "tool" and message.get("tool_call_id")
        and isinstance(message.get("content"), list)
        and any(_inline_image_url(block) for block in message["content"])
    ]
    if len(candidates) < 2:
        return {}
    replacements = {}
    for index, message in candidates[:-1]:
        content = []
        for block in message["content"]:
            url = _inline_image_url(block)
            if url:
                path = _store_image(url, workspace, session_key)
                content.append({
                    "type": "text",
                    "text": f"[Earlier tool image saved outside the active context. Read with read_file if needed: {path}]",
                })
            else:
                content.append(block)
        replacements[index] = content
    return replacements
