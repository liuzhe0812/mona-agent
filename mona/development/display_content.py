"""Public message content shared by all coding executors; never projects reasoning."""

from __future__ import annotations

import re


def display_content(value: object) -> tuple[str, list[dict]]:
    if isinstance(value, str):
        return value, []
    texts, media = [], []
    for block in value if isinstance(value, list) else []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type", "")
        if kind in {"text", "output_text", "input_text"}:
            if isinstance(block.get("text"), str):
                texts.append(block["text"])
            continue
        if kind not in {"image", "image_url", "input_image", "audio", "video", "document", "file"}:
            continue
        source = block.get("source")
        source = source if isinstance(source, dict) else {}
        url = block.get("image_url") or block.get("url") or source.get("url")
        if isinstance(url, dict):
            url = url.get("url")
        mime = source.get("media_type", "")
        if source.get("type") == "base64" and isinstance(source.get("data"), str) and isinstance(mime, str):
            if re.fullmatch(r"(?:image/(?:png|jpeg|gif|webp|avif|bmp)|audio/[\w.+-]+|video/[\w.+-]+|application/pdf)", mime):
                url = f"data:{mime};base64,{source['data']}"
        media_kind = "image" if kind in {"image", "image_url", "input_image"} else kind if kind in {"audio", "video"} else "file"
        # Unknown sources remain visible as unavailable attachments, not silently discarded.
        media.append({"kind": media_kind, "url": url if isinstance(url, str) else "",
                      "name": str(block.get("name") or block.get("title") or {"image": "图片", "audio": "音频", "video": "视频", "file": "附件"}[media_kind])})
    return "\n".join(texts), media
