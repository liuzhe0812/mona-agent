"""Materials frontmatter 统一解析与渲染（PyYAML 实现）。

解析入口 `_parse_frontmatter` 是资料库唯一的 frontmatter 读取方式；
渲染入口 `_render_frontmatter` 保证产物可被 `yaml.safe_load` 无损读回。
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

import yaml

__all__ = ["_parse_frontmatter", "_render_frontmatter"]

# YAML 标量需要引号保护的字符/形态
_NEEDS_QUOTE_RE = re.compile(r'[:#\[\]{},&*!|>\'"%@`]|^\s|\s$|^[-?] |^$')
_NUMERIC_RE = re.compile(r"[-+]?\d+(\.\d+)?")
_YAML_KEYWORDS = {"true", "false", "yes", "no", "null", "none", "~", "on", "off"}


def _parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """解析 markdown frontmatter，返回 (字段 dict, 去空白后的 body)。

    解析失败（无 frontmatter / YAML 非法 / 非 mapping）时返回 ({}, 原文或 body)，
    绝不抛异常——调用方处理的都是磁盘上可能被人手编辑过的文件。
    """
    if not content.startswith("---"):
        return {}, content
    end = content.find("\n---", 3)
    if end == -1:
        return {}, content
    yaml_text = content[3:end]
    # 跳过闭合分隔符 "\n---" 及其后的单个换行
    body_start = end + 4
    if body_start < len(content) and content[body_start] == "\n":
        body_start += 1
    body = content[body_start:].strip()
    try:
        data = yaml.safe_load(yaml_text)
    except yaml.YAMLError:
        return {}, content
    if not isinstance(data, dict):
        return {}, body
    return data, body


def _yaml_scalar(value: Any) -> str:
    """把标量渲染为可被 yaml.safe_load 无损读回的形式（必要时加双引号）。"""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value)
    if (
        _NEEDS_QUOTE_RE.search(text)
        or _NUMERIC_RE.fullmatch(text)
        or text.lower() in _YAML_KEYWORDS
    ):
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def _render_frontmatter(fields: Mapping[str, Any] | Iterable[tuple[str, Any]]) -> str:
    """渲染 frontmatter；list 值渲染为 YAML block list。

    接受 dict（按键序）或 (key, value) 列表（显式顺序、允许重复键）。
    """
    items = fields.items() if isinstance(fields, Mapping) else fields
    lines = ["---"]
    for key, value in items:
        if isinstance(value, list):
            lines.append(f"{key}:")
            for item in value:
                lines.append(f"  - {_yaml_scalar(item)}")
        else:
            lines.append(f"{key}: {_yaml_scalar(value)}")
    lines.append("---")
    lines.append("")
    return "\n".join(lines)
