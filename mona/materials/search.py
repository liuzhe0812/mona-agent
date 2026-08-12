"""Materials 检索的 snippet 提取工具。

资料检索统一走 `mona.materials.index` 的 FTS5 chunk 索引；
本模块只保留 `_extract_snippet`（index.py 依赖的关键词窗口截取）。
"""

from __future__ import annotations


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
