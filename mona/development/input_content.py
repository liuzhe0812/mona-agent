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
MAX_NATIVE_TEXT_CHARS = 200_000


def encoded_content(content: MessageContent) -> str:
    return content if isinstance(content, str) else json.dumps(content, ensure_ascii=False, separators=(",", ":"))


def validate_content(content: MessageContent, *, context_input: bool = False) -> None:
    text_chars = image_bytes = 0
    valid = False
    if isinstance(content, str):
        text_chars, valid = len(content), bool(content.strip())
    elif isinstance(content, list) and content:
        if not context_input and len(content) > 33:
            raise DevelopmentError("input_parts_too_many", "这条消息的附件或内容片段过多，本次内容尚未发送。请减少附件或拆分发送。")
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
            valid = bool(image_bytes or text_chars)
    if not valid:
        raise DevelopmentError("invalid_input_content", "消息内容或图片格式无法识别，本次内容尚未发送。请重新添加附件后重试。")
    if image_bytes > MAX_IMAGE_BYTES:
        raise DevelopmentError("input_images_too_large", "附件图片合计超过 8 MB，本次内容尚未发送。请压缩图片或减少附件后重试。")
    # Work history is model context, not a single user input. The RPC envelope
    # still enforces its byte limit after model token-budget admission.
    if context_input:
        if len(encoded_content(content).encode("utf-8")) > MAX_NATIVE_FRAME_BYTES:
            raise DevelopmentError("rpc_frame_too_large", "会话内容和附件超过单次传输容量，本次内容尚未发送。请减少附件或整理会话后重试。")
    elif text_chars > MAX_NATIVE_TEXT_CHARS:
        raise DevelopmentError("input_text_too_large", "这条消息超过 20 万字符，本次内容尚未发送。请缩短文字或拆分发送。")


def with_context(content: MessageContent, *context: str) -> MessageContent:
    prefix = "\n\n".join(part for part in context if part)
    if isinstance(content, str):
        return "\n\n".join(part for part in (prefix, content) if part)
    return ([{"type": "text", "text": prefix}] if prefix else []) + content


def codex_input(content: MessageContent, *, context_input: bool = False) -> list[dict]:
    validate_content(content, context_input=context_input)
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [{"type": "text", "text": block["text"]} if block["type"] == "text"
            else {"type": "image", "url": block["image_url"]["url"]} for block in content]


def sdk_content(content: MessageContent, *, context_input: bool = False) -> list[dict]:
    validate_content(content, context_input=context_input)
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
