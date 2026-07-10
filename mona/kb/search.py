"""Hybrid search over wiki pages: keyword + vector with RRF fusion."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from loguru import logger

from mona.kb import vectorstore
from mona.kb.embedding import EmbeddingConfig, fetch_embedding
from mona.kb.ingest import parse_frontmatter

RRF_K = 60.0


def _tokenize_query(query: str) -> list[str]:
    """Split query on whitespace into lowercased tokens (non-empty)."""
    return [t.lower() for t in query.split() if t.strip()]


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

    Query is split on whitespace into tokens; each token independently
    matches (title +3, content +1). Total score is summed across tokens.
    Chinese-friendly: no tokenization beyond whitespace splitting.

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
        content = md_file.read_text(encoding="utf-8")
        frontmatter, body = parse_frontmatter(content)
        rel_path = str(md_file.relative_to(md_dir)).replace("\\", "/")
        title = frontmatter.get("title", rel_path)
        title_lower = title.lower()
        content_lower = content.lower()

        score = 0
        for tok in tokens:
            if tok in title_lower:
                score += 3
            if tok in content_lower:
                score += 1
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
    embedding_config: EmbeddingConfig | None = None,
    count: int = 10,
    markdown_dir: Path | str | None = None,
    vectorstore_db: Path | str | None = None,
) -> dict[str, Any]:
    """Hybrid search: keyword + vector with RRF fusion.

    Returns {"mode": "keyword"|"vector"|"hybrid", "results": [...]}.
    Gracefully degrades to keyword-only when embedding is unavailable.

    Pass `markdown_dir` to search a non-default directory (e.g. a notes vault),
    and `vectorstore_db` for the corresponding vectorstore db path.
    """
    md_dir = Path(markdown_dir) if markdown_dir is not None else project_path / "wiki"
    if not md_dir.exists():
        return {"mode": "keyword", "results": []}

    tokens = _tokenize_query(query)
    if not tokens:
        return {"mode": "keyword", "results": []}

    # -- Phase 1: Multi-token LIKE search with additive scoring --
    slug_to_path: dict[str, str] = {}
    keyword_results: list[dict[str, Any]] = []

    for md_file in sorted(md_dir.rglob("*.md")):
        rel = str(md_file.relative_to(md_dir)).replace("\\", "/")
        stem = rel.replace(".md", "").split("/")[-1].lower()
        slug_to_path[stem] = rel

        content = md_file.read_text(encoding="utf-8")
        fm, body = parse_frontmatter(content)
        title = fm.get("title", rel)
        title_lower = title.lower()
        content_lower = content.lower()

        score = 0
        for tok in tokens:
            if tok in title_lower:
                score += 3
            if tok in content_lower:
                score += 1
        if score == 0:
            continue

        tags = fm.get("tags", [])
        if isinstance(tags, str):
            tags = [tags]
        snippet = _extract_snippet(body, tokens)

        keyword_results.append({
            "path": rel, "title": title, "type": fm.get("type", ""),
            "tags": tags, "snippet": snippet, "score": score,
        })

    keyword_results.sort(key=lambda r: r["score"], reverse=True)
    token_rank: dict[str, int] = {r["path"]: idx + 1 for idx, r in enumerate(keyword_results)}

    # -- Phase 2: Vector search --
    vector_rank: dict[str, int] = {}
    vector_score_map: dict[str, float] = {}
    vector_hits = 0

    query_embedding = None
    if embedding_config and embedding_config.enabled and embedding_config.endpoint and embedding_config.model:
        query_embedding = await fetch_embedding(query, embedding_config)

    if query_embedding:
        try:
            raw_chunks = await vectorstore.search_chunks(
                project_path, query_embedding, max(count * 3, 30), db_path=vectorstore_db,
            )
            vector_hits = len(raw_chunks)

            # Group by page_id, compute blended score
            by_page: dict[str, list[dict]] = {}
            for c in raw_chunks:
                by_page.setdefault(c["page_id"], []).append(c)

            page_results: list[tuple[str, float, str, str]] = []
            for page_id, chunks in by_page.items():
                chunks.sort(key=lambda c: c["score"], reverse=True)
                top = chunks[0]["score"]
                tail = sum(c["score"] for c in chunks[1:])
                blended = top + min(tail * 0.3, max(0, 1.0 - top))
                page_results.append((page_id, blended, chunks[0]["chunk_text"], chunks[0]["heading_path"]))

            page_results.sort(key=lambda x: x[1], reverse=True)
            for idx, (page_id, score, chunk_text, heading_path) in enumerate(page_results):
                vector_rank[page_id] = idx + 1
                vector_score_map[page_id] = score

            # Materialize vector-only results
            known_paths = {r["path"] for r in keyword_results}
            for page_id, score, chunk_text, heading_path in page_results:
                rel = slug_to_path.get(page_id)
                if not rel or rel in known_paths:
                    continue
                page_file = md_dir / rel
                if not page_file.exists():
                    continue
                content = page_file.read_text(encoding="utf-8")
                fm, body = parse_frontmatter(content)
                title = fm.get("title", page_id)
                snippet = f"{heading_path}: {chunk_text[:160]}" if heading_path else chunk_text[:160]
                tags = fm.get("tags", [])
                if isinstance(tags, str):
                    tags = [tags]
                keyword_results.append({
                    "path": rel, "title": title, "type": fm.get("type", ""),
                    "tags": tags, "snippet": snippet, "score": 0.0,
                    "vector_score": score,
                })

        except Exception as e:
            logger.warning(f"[Search] vector search failed, falling back to keyword: {e}")

    # -- Phase 3: RRF fusion --
    if vector_hits == 0:
        keyword_results.sort(key=lambda r: r["score"], reverse=True)
        return {"mode": "keyword", "results": keyword_results[:count]}

    for result in keyword_results:
        stem = result["path"].replace(".md", "").split("/")[-1]
        t_rank = token_rank.get(result["path"])
        v_rank = vector_rank.get(stem)
        rrf = 0.0
        if t_rank:
            rrf += 1.0 / (RRF_K + t_rank)
        if v_rank:
            rrf += 1.0 / (RRF_K + v_rank)
        result["score"] = rrf
        if stem in vector_score_map:
            result["vector_score"] = vector_score_map[stem]

    keyword_results.sort(key=lambda r: r["score"], reverse=True)

    mode = "hybrid" if token_rank and vector_hits else ("vector" if vector_hits else "keyword")
    return {"mode": mode, "results": keyword_results[:count]}
