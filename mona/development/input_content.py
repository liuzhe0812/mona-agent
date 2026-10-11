"""Immutable text/image input shared by Coding and the native adapters."""
from __future__ import annotations

import base64
import binascii
import json

from mona.development.store import DevelopmentError
from mona.utils.helpers import detect_image_mime

MessageContent = str | list[dict]
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_NATIVE_FRAME_BYTES = 16 * 1024 * 1024


def encoded_content(content: MessageContent) -> str:
    return content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, separators=(",", ":"))


def validate_content(content: MessageContent) -> None:
    if isinstance(content, str):
        if content.strip() and len(content) <= 200_000:
            return
    elif isinstance(content, list) and 1 <= len(content) <= 33:
        image_bytes = text_chars = 0
        for block in content:
            if not isinstance(block, dict):
                break
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                text_chars += len(block["text"])
            elif block.get("type") == "image_url" and isinstance(block.get("image_url"), dict):
                url = block["image_url"].get("url")
                if not isinstance(url, str) or len(url) > MAX_NATIVE_FRAME_BYTES:
                    break
                header, separator, data = url.partition(",")
                if not separator or header not in {f"data:image/{kind};base64" for kind in ("png", "jpeg", "gif", "webp")}:
                    break
                try:
                    raw = base64.b64decode(data, validate=True)
                except (ValueError, binascii.Error):
                    break
                if not raw or f"data:{detect_image_mime(raw)};base64" != header:
                    break
                image_bytes += len(raw)
            else:
                break
        else:
            if image_bytes <= MAX_IMAGE_BYTES and text_chars <= 200_000 and (image_bytes or text_chars):
                return
    raise DevelopmentError("invalid_input_content", "输入内容无效或超过大小限制，请减少附件后重试。")


def with_context(content: MessageContent, *context: str) -> MessageContent:
    prefix = "\n\n".join(part for part in context if part)
    if isinstance(content, str):
        return "\n\n".join(part for part in (prefix, content) if part)
    return ([{"type": "text", "text": prefix}] if prefix else []) + content


def codex_input(content: MessageContent) -> list[dict]:
    validate_content(content)
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [{"type": "text", "text": block["text"]} if block["type"] == "text"
            else {"type": "image", "url": block["image_url"]["url"]} for block in content]


def sdk_content(content: MessageContent) -> list[dict]:
    validate_content(content)
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    result = []
    for block in content:
        if block["type"] == "text":
            result.append({"type": "text", "text": block["text"]})
        else:
            header, data = block["image_url"]["url"].split(",", 1)
            result.append({"type": "image", "source": {"type": "base64", "media_type": header[5:-7], "data": data}})
    return result
