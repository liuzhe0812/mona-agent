"""Read the explicitly shared Mona design package without importing Work skills."""
from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path, PureWindowsPath
from typing import Any

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

from mona.agent.tools.base import Tool
from mona.utils.helpers import build_image_content_blocks, detect_image_mime

DESIGN_TOOL = "development_design_resource"
DESIGN_PACKAGE = Path(__file__).resolve().parents[1] / "skills" / "mona-design"
DESIGN_POLICY_TAG = ":mona-design-resources-v1"
_READ_ERROR = "设计资源读取失败，请核对包内相对路径、文件类型和分页参数。未读取其它目录。"
DESIGN_DESCRIPTION = (
    "Read Mona Design's shared, read-only design guidance, style images and example source. "
    "Use path='SKILL.md' first for frontend/design tasks; project rules and the existing design system take priority. "
    "Paths are relative to this package, not the project. Empty/directory paths list one level; "
    "offset/limit page text or directory entries. Images return actual image content. "
    "This tool cannot write, execute scripts, install dependencies or access other skills."
)


class DesignResourceCall(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    path: str = Field(default="SKILL.md", max_length=1024)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=16000, ge=1, le=24000)


def design_resource_context() -> dict[str, str]:
    return {"name": "mona-design", "tool": DESIGN_TOOL, "entry": "SKILL.md",
            "description": "前端与视觉设计参考。按需读取说明、真实样张和示例源码；项目规则和已有设计系统优先。",
            "policy": "仅此内置包只读共享；不执行其脚本，不加载私人 Skills、记忆或外部 MCP，不自动复制到项目。"}


def read_design_resource(path: str, *, offset: int = 0, limit: int = 16000,
                         root: Path | None = None) -> str | list[dict[str, Any]]:
    request = DesignResourceCall(path=path, offset=offset, limit=limit)
    relative = Path(request.path)
    if (relative.is_absolute() or PureWindowsPath(request.path).is_absolute()
            or PureWindowsPath(request.path).drive or "\\" in request.path
            or any(part.startswith(".") and part != "." for part in relative.parts)
            or any(ord(char) < 32 for char in request.path)):
        raise ValueError("设计资源路径必须是包内非隐藏资源的相对路径。")
    base = (root if root is not None else DESIGN_PACKAGE).resolve(strict=True)
    target = (base / relative).resolve(strict=True)
    if not target.is_relative_to(base) or any(part.startswith(".") for part in target.relative_to(base).parts):
        raise ValueError("设计资源不在当前包内。")
    if target.is_dir():
        entries = []
        for child in sorted(target.iterdir(), key=lambda item: item.name):
            if child.name.startswith(".") or child.is_symlink():
                continue
            entries.append({"path": child.relative_to(base).as_posix(), "type": "directory" if child.is_dir() else "file"})
        page_size = min(limit, 100)
        return json.dumps({"path": relative.as_posix(), "entries": entries[offset:offset + page_size],
                           "nextOffset": offset + page_size if offset + page_size < len(entries) else None}, ensure_ascii=False)
    if not target.is_file() or target.stat().st_size > 2_000_000:
        raise ValueError("设计资源不是文件或超过读取大小限制。")
    with target.open("rb") as stream:
        raw = stream.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("设计资源超过读取大小限制。")
    mime = detect_image_mime(raw)
    if mime:
        if mime not in {"image/png", "image/jpeg", "image/webp"} or offset:
            raise ValueError("不支持此图片格式或图片分页参数。")
        with Image.open(BytesIO(raw)) as image:
            if image.width > 4096 or image.height > 8192 or image.width * image.height > 16_000_000:
                raise ValueError("设计样张尺寸超过读取限制。")
            image.verify()
        return build_image_content_blocks(raw, mime, str(target),
            f"Mona Design 参考样张：{relative.as_posix()}。仅作视觉参考；按当前内容设计，不照搬示例事实。")
    if b"\0" in raw:
        raise ValueError("设计资源不是受支持的文本或图片。")
    text = raw.decode("utf-8-sig")
    page = json.dumps({"path": relative.as_posix(), "offset": offset, "content": text[offset:offset + limit],
                       "nextOffset": offset + limit if offset + limit < len(text) else None}, ensure_ascii=False)
    if offset == 0 and relative.parts and relative.parts[0] == "references":
        from mona.agent.skill_previews import with_skill_previews

        return with_skill_previews(base, page, Path(*relative.parts[1:]).as_posix())
    return page


def design_resource_result(arguments: dict[str, Any]) -> dict:
    try:
        request = DesignResourceCall.model_validate(arguments)
        value = read_design_resource(**request.model_dump())
        if isinstance(value, str):
            return {"content": [{"type": "text", "text": value}], "isError": False}
        content = []
        for block in value:
            if block["type"] == "text":
                content.append(block)
            elif block["type"] == "image_url":
                header, data = block["image_url"]["url"].split(",", 1)
                content.append({"type": "image", "mimeType": header[5:].split(";", 1)[0], "data": data})
        return {"content": content, "isError": False}
    except (OSError, ValueError, UnicodeError, Image.DecompressionBombError):
        return {"content": [{"type": "text", "text": _READ_ERROR}], "isError": True}


class DesignResourceTool(Tool):
    name = DESIGN_TOOL
    description = DESIGN_DESCRIPTION
    read_only = True
    parameters = DesignResourceCall.model_json_schema()

    async def execute(self, **kwargs: Any) -> str | list[dict[str, Any]]:
        try:
            return read_design_resource(**DesignResourceCall.model_validate(kwargs).model_dump())
        except (OSError, ValueError, UnicodeError, Image.DecompressionBombError):
            return "Error: " + _READ_ERROR
