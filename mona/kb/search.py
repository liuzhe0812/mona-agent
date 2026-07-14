"""Keyword search over wiki pages."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from mona.kb.ingest import parse_frontmatter

_CJK_RE = re.compile(r"[\u4e00-\u9fff]+")

# 页面解析缓存：(mtime, frontmatter, body, content_lower)
# mtime 变化时自动失效，避免每次搜索都 read_text + parse_frontmatter + lower
_PAGE_CACHE: dict[Path, tuple[float, dict[str, Any], str, str]] = {}


def _tokenize_query(query: str) -> list[str]:
    """Tokenize query: whitespace split for latin, 2-gram for CJK runs.

    CJK 连续段切为 bigram（"安装部署" → 安装/装部/部署），单字保留为单 token。
    混合 token（含 CJK 与拉丁）按 CJK 边界拆分后分别处理。
    """
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


def _load_page_cached(md_file: Path) -> tuple[dict[str, Any], str, str]:
    """加载并解析 wiki 页面，带 mtime 缓存。

    返回 (frontmatter, body, content_lower)。
    mtime 未变时直接复用缓存，避免重复 read_text + parse_frontmatter + lower。
    """
    mtime = md_file.stat().st_mtime
    cached = _PAGE_CACHE.get(md_file)
    if cached is not None and cached[0] == mtime:
        return cached[1], cached[2], cached[3]

    content = md_file.read_text(encoding="utf-8")
    frontmatter, body = parse_frontmatter(content)
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


def search_wiki(
    project_path: Path,
    query: str,
    count: int = 10,
    markdown_dir: Path | str | None = None,
) -> list[dict[str, Any]]:
    """Multi-token LIKE substring search over wiki pages with additive scoring.

    Query is tokenized via _tokenize_query (CJK bigram + latin whitespace split);
    each token independently matches (title +3, content +1). Total score is summed.

    Pass `markdown_dir` to search a non-default directory (e.g. a notes vault).
    """
    md_dir = Path(markdown_dir) if markdown_dir is not None else project_path / "wiki"
    if not md_dir.exists():
        return []

    tokens = _tokenize_query(query)
    if not tokens:
        return []

    results: list[dict[str, Any]] = []
    for md_file in md_dir.rglob("*.md"):
        frontmatter, body, content_lower = _load_page_cached(md_file)
        rel_path = str(md_file.relative_to(md_dir)).replace("\\", "/")
        title = frontmatter.get("title", rel_path)
        title_lower = title.lower()

        score = _score_page(tokens, title_lower, content_lower)
        if score == 0:
            continue

        page_type = frontmatter.get("type", "")
        tags = frontmatter.get("tags", [])
        if isinstance(tags, str):
            tags = [tags]
        snippet = _extract_snippet(body, tokens)
        results.append({
            "path": rel_path, "title": title, "type": page_type,
            "tags": tags, "snippet": snippet, "score": score,
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:count]


async def search_wiki_hybrid(
    project_path: Path,
    query: str,
    count: int = 10,
    markdown_dir: Path | str | None = None,
) -> dict[str, Any]:
    """Keyword search over wiki pages. Returns {"mode": "keyword", "results": [...]}.

    委托给 search_wiki 的同步实现，保持单一数据源。
    """
    results = search_wiki(project_path, query, count=count, markdown_dir=markdown_dir)
    return {"mode": "keyword", "results": results}
