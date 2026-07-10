"""Hoard ingestion pipeline: fetch metadata → LLM summary → LLM tags → embedding → cross-source relations."""

from __future__ import annotations

import re
from typing import Any

from loguru import logger

from mona.hoard.models import HoardManager
from mona.hoard.prompts import (
    SUMMARY_FROM_TITLE_PROMPT,
    SUMMARY_PROMPT,
    TAGS_PROMPT,
)


async def ingest_hoard(
    manager: HoardManager,
    hoard_id: str,
    *,
    fetch_content: bool = True,
    generate_summary: bool = True,
    generate_tags: bool = True,
    generate_embedding: bool = True,
    embedding_config: Any | None = None,
) -> None:
    """Run async ingestion pipeline for a hoard item.

    Steps:
    1. Fetch URL content (if applicable) via HTTP
    2. Generate LLM summary
    3. Generate LLM tags
    4. Generate embedding vector (if config available)
    5. Build cross-source relations (URL match + semantic match)

    Failures are non-fatal — partial data is stored.
    """
    item = manager.get(hoard_id)
    if item is None:
        logger.warning(f"[hoard] ingest: item {hoard_id} not found")
        return

    content = item.content or ""

    # Step 1: Fetch URL content
    if fetch_content and item.url and not content:
        fetched = await _fetch_url_content(item.url)
        if fetched:
            content = fetched
            manager.update(hoard_id, content=content)

    # Step 2: Generate summary
    if generate_summary and not item.summary:
        summary = await _generate_summary(item.title, item.url, content)
        if summary:
            manager.update(hoard_id, summary=summary)
            item.summary = summary

    # Step 3: Generate tags
    if generate_tags and not item.tags:
        tags = await _generate_tags(item.title, item.summary or "")
        if tags:
            manager.update(hoard_id, tags=tags)
            item.tags = tags

    # Step 4: Generate embedding (if config available)
    if generate_embedding and embedding_config is not None:
        await _generate_and_store_embedding(hoard_id, item, embedding_config)

    # Step 5: Cross-source relations
    if item.url:
        _build_relations(manager, hoard_id, item.url)

    # Semantic relations (if embeddings exist)
    if generate_embedding and embedding_config is not None:
        await _build_semantic_relations(manager, hoard_id, embedding_config)

    logger.info(f"[hoard] ingest complete for {hoard_id}")


async def _fetch_url_content(url: str) -> str:
    """Fetch URL content using the project's HTTP tool with SSRF protection."""
    try:
        from mona.security.network import validate_url_target

        await validate_url_target(url)
    except Exception as e:
        logger.debug(f"[hoard] URL validation failed for {url}: {e}")
        return ""

    try:
        import httpx

        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (compatible; MonaBot/1.0)",
                    "Accept": "text/html,application/xhtml+xml",
                },
            )
            resp.raise_for_status()
            text = resp.text

            # Strip HTML tags, keep text
            text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text).strip()

            # Truncate to first 2000 chars
            return text[:2000]
    except Exception as e:
        logger.debug(f"[hoard] fetch failed for {url}: {e}")
        return ""


async def _generate_summary(title: str, url: str, content: str) -> str:
    """Generate summary via LLM provider."""
    try:
        from mona.providers.factory import load_provider_snapshot

        snapshot = load_provider_snapshot()
        provider = snapshot.provider
        model = snapshot.model

        if content:
            prompt = SUMMARY_PROMPT.format(title=title, url=url, content=content[:2000])
        else:
            prompt = SUMMARY_FROM_TITLE_PROMPT.format(title=title, url=url)

        resp = await provider.chat(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            max_tokens=512,
            temperature=0.3,
        )
        return (resp.content or "").strip()
    except Exception as e:
        logger.warning(f"[hoard] summary generation failed: {e}")
        return ""


async def _generate_tags(title: str, summary: str) -> list[str]:
    """Generate tags via LLM provider."""
    try:
        from mona.providers.factory import load_provider_snapshot

        snapshot = load_provider_snapshot()
        provider = snapshot.provider
        model = snapshot.model

        prompt = TAGS_PROMPT.format(title=title, summary=summary)
        resp = await provider.chat(
            messages=[{"role": "user", "content": prompt}],
            model=model,
            max_tokens=128,
            temperature=0.3,
        )
        raw = (resp.content or "").strip()
        tags = [t.strip() for t in re.split(r"[,，、\s]+", raw) if t.strip()]
        return tags[:5]
    except Exception as e:
        logger.warning(f"[hoard] tags generation failed: {e}")
        return []


def _build_relations(manager: HoardManager, hoard_id: str, url: str) -> None:
    """Build cross-source relations by URL match.

    First version: URL exact match only (no semantic association).
    Scans email/note/browser sources for the same URL.
    """
    try:
        # Find existing hoard items with the same URL (other sources)
        existing = manager.find_by_url(url)
        for other in existing:
            if other.id == hoard_id:
                continue
            # Create bidirectional relation
            manager.add_relation(
                hoard_id,
                related_type=other.source,
                related_id=other.source_ref or other.id,
                related_meta={"title": other.title, "url": url},
            )
            manager.add_relation(
                other.id,
                related_type="hoard",
                related_id=hoard_id,
                related_meta={"title": "关联收藏", "url": url},
            )
    except Exception as e:
        logger.debug(f"[hoard] build_relations failed: {e}")


async def _generate_and_store_embedding(
    hoard_id: str,
    item: Any,
    embedding_config: Any,
) -> None:
    """Generate embedding for a hoard item and store it in the vector table.

    Embeds the concatenation of title + summary + tags + content (truncated).
    Skips silently if embedding fails — keyword search still works.
    """
    try:
        from mona.hoard.vectorstore import upsert_vector
        from mona.kb.embedding import fetch_embedding

        # Build text to embed: title + tags + summary + content
        parts = [item.title]
        if item.tags:
            parts.append(" ".join(item.tags))
        if item.summary:
            parts.append(item.summary)
        if item.content:
            parts.append(item.content[:1000])
        text = " ".join(p for p in parts if p).strip()

        if not text:
            return

        vector = await fetch_embedding(text, embedding_config)
        if vector:
            await upsert_vector(hoard_id, vector)
    except Exception as e:
        logger.debug(f"[hoard] embedding generation failed for {hoard_id}: {e}")


async def _build_semantic_relations(
    manager: HoardManager,
    hoard_id: str,
    embedding_config: Any,
) -> None:
    """Build semantic relations by vector similarity.

    Finds top-K most similar hoard items and creates relations if similarity > threshold.
    Threshold: 0.75 (cosine similarity).
    """
    try:
        from mona.hoard.vectorstore import search_vectors

        # Get the item's own vector and search for similar items
        item = manager.get(hoard_id)
        if item is None:
            return

        # Re-embed the query to search
        from mona.kb.embedding import fetch_embedding

        parts = [item.title]
        if item.tags:
            parts.append(" ".join(item.tags))
        if item.summary:
            parts.append(item.summary)
        if item.content:
            parts.append(item.content[:1000])
        text = " ".join(p for p in parts if p).strip()

        if not text:
            return

        query_vector = await fetch_embedding(text, embedding_config)
        if not query_vector:
            return

        # Search for similar items (top 5)
        similar = await search_vectors(query_vector, limit=6)
        for hit in similar:
            other_id = hit["hoard_id"]
            score = hit["score"]
            if other_id == hoard_id or score < 0.75:
                continue

            other = manager.get(other_id)
            if other is None:
                continue

            # Avoid duplicating URL-match relations
            existing_rels = manager.get_relations(hoard_id)
            already_linked = any(
                r["related_id"] == other_id and r["type"] == "semantic"
                for r in existing_rels
            )
            if already_linked:
                continue

            manager.add_relation(
                hoard_id,
                related_type="semantic",
                related_id=other_id,
                related_meta={
                    "title": other.title,
                    "score": round(score, 3),
                },
            )
            manager.add_relation(
                other_id,
                related_type="semantic",
                related_id=hoard_id,
                related_meta={
                    "title": item.title,
                    "score": round(score, 3),
                },
            )
    except Exception as e:
        logger.debug(f"[hoard] semantic relations failed for {hoard_id}: {e}")


def _load_embedding_config() -> Any | None:
    """Load global embedding config from tools.embedding.

    Returns EmbeddingConfig if configured and enabled, None otherwise.
    """
    try:
        from mona.config.loader import load_config
        from mona.kb.embedding import EmbeddingConfig

        cfg = load_config()
        emb = cfg.tools.embedding
        if emb.enabled and emb.endpoint and emb.model:
            return EmbeddingConfig(
                enabled=True,
                endpoint=emb.endpoint,
                api_key=emb.api_key,
                model=emb.model,
                output_dimensionality=emb.output_dimensionality,
            )
    except Exception as e:
        logger.debug(f"[hoard] could not load embedding config: {e}")
    return None
