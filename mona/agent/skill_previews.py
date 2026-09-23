"""Optional, bounded native image references bundled with a skill, never inferred paths."""
from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

from mona.utils.helpers import build_image_content_blocks, detect_image_mime


def with_skill_previews(skill_dir: Path, content: str, reference: str | None = None) -> str | list[dict[str, Any]]:
    root = skill_dir.resolve()
    manifest = root / 'assets' / 'previews.json'
    if not manifest.is_file():
        return content
    try:
        if not manifest.resolve().is_relative_to(root) or manifest.stat().st_size > 16000:
            raise ValueError('预览索引超出范围或大小限制')
        index = json.loads(manifest.read_text(encoding='utf-8'))
        paths = index.get('skill', []) if reference is None else index.get('references', {}).get(reference, [])
        if not isinstance(paths, list) or len(paths) > 2:
            raise ValueError('每次最多返回两张设计参考图')
        blocks: list[dict[str, Any]] = [{'type': 'text', 'text': content}]
        total = 0
        for value in paths:
            if not isinstance(value, str):
                raise ValueError('预览路径无效')
            image = (root / 'assets' / value).resolve()
            if not image.is_relative_to(root / 'assets') or not image.is_file():
                raise ValueError('预览图片不在当前 Skill 的 assets 目录内')
            size = image.stat().st_size
            total += size
            if size > 1_500_000 or total > 2_000_000:
                raise ValueError('预览图片超过大小限制')
            data = image.read_bytes()
            if len(data) > 1_500_000:
                raise ValueError('预览图片读取期间大小发生变化')
            mime = detect_image_mime(data)
            if mime not in {'image/png', 'image/jpeg', 'image/webp'}:
                raise ValueError('预览不是受支持的图片')
            with Image.open(BytesIO(data)) as decoded:
                if decoded.width > 4096 or decoded.height > 8192 or decoded.width * decoded.height > 16_000_000:
                    raise ValueError('预览图片尺寸超过限制')
                decoded.verify()
            blocks.extend(build_image_content_blocks(data, mime, str(image), f'设计参考：{value}。这是组件实际渲染，仅用于理解完成度，不是成品目标或版式清单；请按当前内容自主设计，不能照搬示例事实。'))
        return blocks if paths else content
    except (OSError, ValueError, TypeError, AttributeError, Image.DecompressionBombError) as exc:
        return content + f'\n\n[设计参考加载失败：{exc}。不能把未看到的参考称为已检查；可继续使用原生操作。]'
