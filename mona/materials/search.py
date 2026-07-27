"""Keyword search over materials text/ and wiki/ directories.

资料搜索：在 `.mona/materials/text/` 和 `.mona/materials/wiki/` 下做关键词子串匹配。
复用 KB 搜索的打分算法（title +3, content +1, CJK bigram 分词），
但路径解析改为基于 vault 而非 KB project。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")

# 页面解析缓存：(mtime, frontmatter, body, content_lower)
_PAGE_CACHE: dict[Path, tuple[float, dict[str, Any], str, str]] = {}


def _tokenize_query(query: str) -> list[str]:
    """Tokenize query: whitespace split for latin, 2-gram for CJK runs."""
    tokens: list[str] = []
    for raw in query.split():
        if not raw.strip():
            continue
        if _CJK_RE.search(raw):
            cjk_runs = _CJK_RE.findall(raw)
            for run in cjk_runs:
                if len(run) == 1:
                    tokens.append(run.lower())
                else:
                    for i in range(len(run) - 1):
                        tokens.append(run[i : i + 2].lower())
            non_cjk = _CJK_RE.split(raw)
            for part in non_cjk:
                if part.strip():
                    tokens.append(part.lower())
        else:
            tokens.append(raw.lower())
    return tokens


def _parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Parse YAML frontmatter from markdown content.

    Returns (frontmatter_dict, body_text).  Lightweight parser matching
    the behaviour of the legacy KB ingest.parse_frontmatter.
    """
    if not content.startswith("---"):
        return {}, content

    end = content.find("---", 3)
    if end == -1:
        return {}, content

    yaml_text = content[3:end].strip()
    body = content[end + 3 :].strip()

    frontmatter: dict[str, Any] = {}
    current_key: str | None = None
    current_list: list[str] | None = None

    for line in yaml_text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue

        if stripped.startswith("- ") and current_key is not None and current_list is not None:
            current_list.append(stripped[2:].strip())
            continue

        if ":" in stripped:
            if current_key is not None and current_list is not None:
                frontmatter[current_key] = current_list

            key, _, value = stripped.partition(":")
            key = key.strip()
            value = value.strip()

            if value:
                frontmatter[key] = value
                current_key = None
                current_list = None
            else:
                current_key = key
                current_list = []
                frontmatter[key] = current_list

    if current_key is not None and current_list is not None:
        frontmatter[current_key] = current_list

    return frontmatter, body


def _load_page_cached(md_file: Path) -> tuple[dict[str, Any], str, str]:
    """加载并解析 markdown 页面，带 mtime 缓存。"""
    mtime = md_file.stat().st_mtime
    cached = _PAGE_CACHE.get(md_file)
    if cached is not None and cached[0] == mtime:
        return cached[1], cached[2], cached[3]

    content = md_file.read_text(encoding="utf-8")
    frontmatter, body = _parse_frontmatter(content)
    content_lower = content.lower()
    _PAGE_CACHE[md_file] = (mtime, frontmatter, body, content_lower)
    return frontmatter, body, content_lower


def _score_page(tokens: list[str], title_lower: str, content_lower: str) -> int:
    """计算 token 匹配得分：title +3, content +1。"""
    score = 0
    for tok in tokens:
        if tok in title_lower:
            score += 3
        if tok in content_lower:
            score += 1
    return score


def _extract_snippet(body: str, terms: list[str], max_chars: int = 300) -> str:
    if not body:
        return ""
    lower_body = body.lower()
    best_pos = 0
    best_count = 0

    for term in terms:
        term_lower = term.lower()
        start = 0
        while True:
            pos = lower_body.find(term_lower, start)
            if pos == -1:
                break
            window_start = max(0, pos - max_chars // 2)
            window_end = min(len(body), window_start + max_chars)
            window_text = lower_body[window_start:window_end]
            count = sum(1 for t in terms if t.lower() in window_text)
            if count > best_count:
                best_count = count
                best_pos = window_start
            start = pos + 1

    start = best_pos
    end = min(len(body), start + max_chars)
    snippet = body[start:end]
    if start > 0:
        snippet = "..." + snippet
    if end < len(body):
        snippet = snippet + "..."
    return snippet


def search_markdown_dir(
    md_dir: Path,
    query: str,
    count: int = 10,
    kind: str = "material_wiki",
) -> list[dict[str, Any]]:
    """在指定目录下递归搜索 .md 文件。

    Args:
        md_dir: 要搜索的目录（如 `<vault>/.mona/materials/wiki` 或 `.../text`）
        query: 搜索关键词
        count: 返回结果上限
        kind: 返回结果中标记的来源类型（material_source / material_wiki）

    Returns:
        匹配结果列表，每项含 title/path/kind/snippet/score/sources 等字段。
    """
    if not md_dir.exists():
        return []

    tokens = _tokenize_query(query)
    if not tokens:
        return []

    results: list[dict[str, Any]] = []
    for md_file in md_dir.rglob("*.md"):
        try:
            frontmatter, body, content_lower = _load_page_cached(md_file)
        except Exception:
            continue

        rel_path = str(md_file.relative_to(md_dir)).replace("\\", "/")
        title = frontmatter.get("title", rel_path)
        title_lower = title.lower()

        score = _score_page(tokens, title_lower, content_lower)
        if score == 0:
            continue

        sources = frontmatter.get("sources", [])
        if isinstance(sources, str):
            sources = [sources]

        snippet = _extract_snippet(body, tokens)
        results.append({
            "title": title,
            "path": rel_path,
            "kind": kind,
            "snippet": snippet,
            "score": score,
            "sources": sources,
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:count]


def search_materials(
    vault: Path,
    query: str,
    count: int = 10,
    include_text: bool = True,
    include_wiki: bool = True,
) -> list[dict[str, Any]]:
    """在资料库的 text/ 和 wiki/ 目录下搜索。

    Args:
        vault: 笔记 vault 根路径
        query: 搜索关键词
        count: 返回结果上限（text 和 wiki 各自截断后合并再排序取前 count 条）
        include_text: 是否搜索 text/ 目录
        include_wiki: 是否搜索 wiki/ 目录

    Returns:
        合并后的搜索结果列表。
    """
    materials_root = vault / ".mona" / "materials"
    results: list[dict[str, Any]] = []

    if include_text:
        results.extend(
            search_markdown_dir(
                materials_root / "text", query, count=count, kind="material_source"
            )
        )
    if include_wiki:
        results.extend(
            search_markdown_dir(
                materials_root / "wiki", query, count=count, kind="material_wiki"
            )
        )

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:count]
