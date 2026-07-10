"""Notes knowledge base HTTP route handlers.

Routes:
  POST /api/notes-kb/embed          - index entire vault
  GET  /api/notes-kb/embed/status   - get chunk count
  POST /api/notes-kb/search          - hybrid search
  GET  /api/notes-kb/related/{id}    - find related notes by embedding

The frontend passes `vaultPath` and the embedding config in the request body.
The embed route also persists the embedding config to `<vault>/.mona/embedding.json`
so the agent tool can read it without needing it passed through context.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from aiohttp import web
from loguru import logger

from mona.kb.embedding import EmbeddingConfig
from mona.notes_kb.indexer import index_vault, index_vault_status
from mona.notes_kb.search import search_notes_hybrid

EMBEDDING_CONFIG_FILE = "embedding.json"


def _embedding_config_path(vault: Path) -> Path:
    return vault / ".mona" / EMBEDDING_CONFIG_FILE


def _save_embedding_config(vault: Path, cfg: EmbeddingConfig) -> None:
    """Persist embedding config to <vault>/.mona/embedding.json."""
    try:
        cfg_file = _embedding_config_path(vault)
        cfg_file.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "enabled": cfg.enabled,
            "endpoint": cfg.endpoint,
            "apiKey": cfg.api_key,
            "model": cfg.model,
            "outputDimensionality": cfg.output_dimensionality,
            "extraHeaders": cfg.extra_headers,
        }
        cfg_file.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8",
        )
    except Exception as e:
        logger.warning(f"[notes_kb] failed to persist embedding config: {e}")


def load_embedding_config(vault: Path) -> EmbeddingConfig | None:
    """Read persisted embedding config from <vault>/.mona/embedding.json.

    Returns None if the file does not exist or is invalid.
    Falls back to global config (config.tools.embedding) when the vault file
    is absent, so users only need to configure embedding once in settings.
    """
    cfg_file = _embedding_config_path(vault)
    if cfg_file.exists():
        try:
            data = json.loads(cfg_file.read_text(encoding="utf-8"))
            return EmbeddingConfig(
                enabled=bool(data.get("enabled", False)),
                endpoint=str(data.get("endpoint", "")),
                api_key=str(data.get("apiKey", "")),
                model=str(data.get("model", "")),
                output_dimensionality=data.get("outputDimensionality"),
                extra_headers=data.get("extraHeaders", {}) or {},
            )
        except Exception as e:
            logger.warning(f"[notes_kb] failed to load embedding config: {e}")
    # Fallback: read from global config so the setting page is the single source.
    try:
        from mona.config.loader import load_config

        cfg = load_config().tools.embedding
        if cfg.enabled or cfg.endpoint or cfg.model:
            return EmbeddingConfig(
                enabled=cfg.enabled,
                endpoint=cfg.endpoint,
                api_key=cfg.api_key,
                model=cfg.model,
                output_dimensionality=cfg.output_dimensionality,
            )
    except Exception as e:
        logger.warning(f"[notes_kb] failed to load global embedding config: {e}")
    return None


def _embedding_config_from_body(body: dict[str, Any]) -> EmbeddingConfig:
    return EmbeddingConfig(
        enabled=bool(body.get("enabled", False)),
        endpoint=str(body.get("endpoint", "")),
        api_key=str(body.get("apiKey", "")),
        model=str(body.get("model", "")),
        output_dimensionality=body.get("outputDimensionality"),
        extra_headers=body.get("extraHeaders", {}) or {},
    )


def _vault_from_body(body: dict[str, Any]) -> Path:
    vault = str(body.get("vaultPath", "")).strip()
    if not vault:
        raise web.HTTPBadRequest(reason="vaultPath is required")
    p = Path(vault)
    if not p.exists():
        raise web.HTTPNotFound(reason=f"Vault not found: {vault}")
    return p


async def handle_notes_kb_embed(req: web.Request) -> web.Response:
    """POST /api/notes-kb/embed -- index entire vault."""
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        vault = _vault_from_body(body)
    except web.HTTPException as e:
        return web.json_response({"error": e.reason}, status=e.status)

    cfg = _embedding_config_from_body(body)
    if not cfg.enabled or not cfg.endpoint or not cfg.model:
        return web.json_response({"error": "Embedding not configured"}, status=400)

    # Persist config so the agent tool can read it later.
    _save_embedding_config(vault, cfg)

    max_chunk = int(body.get("maxChunkChars", 1000))
    overlap_chunk = int(body.get("overlapChunkChars", 200))

    result = await index_vault(
        vault,
        cfg,
        max_chunk_chars=max_chunk,
        overlap_chunk_chars=overlap_chunk,
    )
    return web.json_response(result)


async def handle_notes_kb_embed_status(req: web.Request) -> web.Response:
    """GET /api/notes-kb/embed/status?vaultPath=... -- get chunk count."""
    vault_str = req.query.get("vaultPath", "").strip()
    if not vault_str:
        return web.json_response({"error": "vaultPath is required"}, status=400)
    vault = Path(vault_str)
    if not vault.exists():
        return web.json_response({"error": "Vault not found"}, status=404)

    status = await index_vault_status(vault)
    return web.json_response(status)


async def handle_notes_kb_search(req: web.Request) -> web.Response:
    """POST /api/notes-kb/search -- hybrid search notes."""
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    try:
        vault = _vault_from_body(body)
    except web.HTTPException as e:
        return web.json_response({"error": e.reason}, status=e.status)

    query = str(body.get("query", "")).strip()
    if not query:
        return web.json_response({"error": "query is required"}, status=400)

    count = int(body.get("count", 10))

    # Prefer embedding config from request body; fall back to persisted config.
    if body.get("endpoint") or body.get("model") or body.get("enabled") is not None:
        cfg = _embedding_config_from_body(body)
    else:
        cfg = load_embedding_config(vault)

    result = await search_notes_hybrid(vault, query, cfg, count=count)
    return web.json_response(result)


async def handle_notes_kb_related(req: web.Request) -> web.Response:
    """GET /api/notes-kb/related/{note_id}?vaultPath=...&count=... -- find related notes."""
    note_id = req.match_info["note_id"]
    vault_str = req.query.get("vaultPath", "").strip()
    if not vault_str:
        return web.json_response({"error": "vaultPath is required"}, status=400)
    vault = Path(vault_str)
    if not vault.exists():
        return web.json_response({"error": "Vault not found"}, status=404)

    count = int(req.query.get("count", "5"))

    # Read note's content to use as the query.
    note_file = _find_note_file(vault, note_id)
    if note_file is None:
        return web.json_response({"results": []})

    try:
        content = note_file.read_text(encoding="utf-8")
    except Exception as e:
        return web.json_response({"error": f"Failed to read note: {e}"}, status=500)

    # Use the note's title + first 500 chars as the query.
    from mona.kb.ingest import parse_frontmatter

    fm, body = parse_frontmatter(content)
    title = fm.get("title", note_id)
    query_text = f"{title}\n{body[:500]}"

    cfg = load_embedding_config(vault)
    result = await search_notes_hybrid(vault, query_text, cfg, count=count + 1)

    # Exclude the note itself from results.
    results = [r for r in result.get("results", []) if r.get("path", "").replace(".md", "") != note_id]
    result["results"] = results[:count]
    return web.json_response(result)


def _find_note_file(vault: Path, note_id: str) -> Path | None:
    """Find a note file by its stem (note_id) in the vault (one level deep)."""
    # Direct match at root.
    candidate = vault / f"{note_id}.md"
    if candidate.exists():
        return candidate
    # One level deep.
    for entry in vault.iterdir():
        if entry.is_dir() and entry.name != ".mona" and not entry.name.startswith("."):
            candidate = entry / f"{note_id}.md"
            if candidate.exists():
                return candidate
    return None
