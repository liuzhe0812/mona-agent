"""Knowledge base API route handlers.

Note: Ingest is now handled by the frontend (ingest.ts calls LLM directly).
This module only provides file/project/graph/search APIs.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aiohttp import web

from mona.kb.ingest import build_graph_from_pages, parse_frontmatter

KB_ROOT = Path.home() / "MonaKB"


def _project_path(project_id: str) -> Path:
    return KB_ROOT / project_id


def _ensure_project(project_id: str) -> Path:
    p = _project_path(project_id)
    if not p.exists():
        raise web.HTTPNotFound(reason=f"Project '{project_id}' not found")
    return p


def _init_project_dirs(path: Path) -> None:
    (path / ".llm-wiki").mkdir(parents=True, exist_ok=True)
    (path / "raw").mkdir(parents=True, exist_ok=True)
    (path / "wiki").mkdir(parents=True, exist_ok=True)


async def handle_kb_list_projects(req: web.Request) -> web.Response:
    """GET /api/kb/projects — list all KB projects."""
    KB_ROOT.mkdir(parents=True, exist_ok=True)
    projects: list[dict[str, Any]] = []
    for child in sorted(KB_ROOT.iterdir()):
        if child.is_dir() and (child / ".llm-wiki").exists():
            projects.append({
                "id": child.name,
                "name": child.name,
                "path": str(child),
            })
    return web.json_response({"projects": projects})


async def handle_kb_create_project(req: web.Request) -> web.Response:
    """POST /api/kb/projects — create a new KB project."""
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    name = body.get("name", "").strip()
    if not name:
        return web.json_response({"error": "Project name is required"}, status=400)

    project_path = KB_ROOT / name
    if project_path.exists():
        return web.json_response({"error": f"Project '{name}' already exists"}, status=409)

    _init_project_dirs(project_path)

    # Write purpose if provided
    purpose = body.get("purpose", "").strip()
    if purpose:
        (project_path / ".llm-wiki" / "purpose.md").write_text(purpose, encoding="utf-8")

    return web.json_response({
        "id": name,
        "name": name,
        "path": str(project_path),
    }, status=201)


async def handle_kb_rename_project(req: web.Request) -> web.Response:
    """POST /api/kb/{id}/rename — rename a KB project."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)

    new_name = req.query.get("name", "").strip()
    if not new_name:
        return web.json_response({"error": "New name is required"}, status=400)

    new_path = KB_ROOT / new_name
    if new_path.exists():
        return web.json_response(
            {"error": f"Project '{new_name}' already exists"}, status=409
        )

    project_path.rename(new_path)
    return web.json_response({
        "id": new_name,
        "name": new_name,
        "path": str(new_path),
    })


async def handle_kb_list_files(req: web.Request) -> web.Response:
    """GET /api/kb/{id}/files — list raw source files in a project."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)
    raw_dir = project_path / "raw"

    files: list[dict[str, Any]] = []
    if raw_dir.exists():
        for f in sorted(raw_dir.rglob("*")):
            if f.is_file():
                rel = str(f.relative_to(raw_dir)).replace("\\", "/")
                files.append({
                    "path": rel,
                    "size": f.stat().st_size,
                })

    return web.json_response({"files": files})


async def handle_kb_import_files(req: web.Request) -> web.Response:
    """POST /api/kb/{id}/import — import source files into a project."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)
    raw_dir = project_path / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    imported: list[str] = []

    content_type = req.content_type or ""
    if content_type.startswith("multipart/"):
        reader = await req.multipart()
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "files":
                filename = part.filename or "unnamed"
                data = await part.read()
                dest = raw_dir / filename
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
                imported.append(filename)
    else:
        try:
            body = await req.json()
        except Exception:
            return web.json_response({"error": "Invalid JSON body or multipart data"}, status=400)

        files = body.get("files", [])
        for file_info in files:
            if isinstance(file_info, dict):
                name = file_info.get("name", "unnamed")
                content = file_info.get("content", "")
                dest = raw_dir / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(content, encoding="utf-8")
                imported.append(name)

    return web.json_response({"imported": imported})


async def handle_kb_delete_file(req: web.Request) -> web.Response:
    """DELETE /api/kb/{id}/files/{path:.*} — delete a raw source file."""
    project_id = req.match_info["id"]
    file_rel = req.match_info["path"]
    project_path = _ensure_project(project_id)

    file_path = project_path / "raw" / file_rel
    # Security: ensure path is within raw/
    try:
        file_path.resolve().relative_to((project_path / "raw").resolve())
    except ValueError:
        return web.json_response({"error": "Invalid file path"}, status=400)

    if not file_path.exists():
        raise web.HTTPNotFound(reason=f"File '{file_rel}' not found")

    file_path.unlink()
    return web.json_response({"deleted": file_rel})


async def handle_kb_list_wiki(req: web.Request) -> web.Response:
    """GET /api/kb/{id}/wiki — list wiki pages."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)
    wiki_dir = project_path / "wiki"

    pages: list[dict[str, Any]] = []
    if wiki_dir.exists():
        for f in sorted(wiki_dir.rglob("*.md")):
            rel = str(f.relative_to(wiki_dir)).replace("\\", "/")
            try:
                raw = f.read_text(encoding="utf-8")
                fm, _ = parse_frontmatter(raw)
            except Exception:
                fm = {}
            title = fm.get("title", rel.replace(".md", ""))
            page_type = fm.get("type", "")
            tags = fm.get("tags", [])
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",") if t.strip()]
            pages.append({
                "path": rel,
                "title": title,
                "type": page_type,
                "tags": tags,
            })

    return web.json_response({"pages": pages})


async def handle_kb_get_wiki_page(req: web.Request) -> web.Response:
    """GET /api/kb/{id}/wiki/{path:.*} — get a wiki page."""
    project_id = req.match_info["id"]
    page_rel = req.match_info["path"]
    project_path = _ensure_project(project_id)

    page_path = project_path / "wiki" / page_rel
    # Security: ensure path is within wiki/
    try:
        page_path.resolve().relative_to((project_path / "wiki").resolve())
    except ValueError:
        return web.json_response({"error": "Invalid page path"}, status=400)

    if not page_path.exists():
        raise web.HTTPNotFound(reason=f"Page '{page_rel}' not found")

    content = page_path.read_text(encoding="utf-8")
    fm, body = parse_frontmatter(content)
    return web.json_response({
        "path": page_rel,
        "frontmatter": fm,
        "body": body,
        "raw": content,
    })


async def handle_kb_update_wiki_page(req: web.Request) -> web.Response:
    """PUT /api/kb/{id}/wiki/{path:.*} — update a wiki page."""
    project_id = req.match_info["id"]
    page_rel = req.match_info["path"]
    project_path = _ensure_project(project_id)

    page_path = project_path / "wiki" / page_rel
    # Security: ensure path is within wiki/
    try:
        page_path.resolve().relative_to((project_path / "wiki").resolve())
    except ValueError:
        return web.json_response({"error": "Invalid page path"}, status=400)

    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    content = body.get("content", "")
    page_path.parent.mkdir(parents=True, exist_ok=True)
    page_path.write_text(content, encoding="utf-8")
    return web.json_response({"success": True})


async def handle_kb_lint(req: web.Request) -> web.Response:
    """GET /api/kb/{id}/lint — run wiki quality checks."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)
    wiki_dir = project_path / "wiki"

    if not wiki_dir.exists():
        return web.json_response({"results": []})

    # Collect page data: path + related (outgoing links from frontmatter)
    pages: list[dict[str, Any]] = []
    slug_to_path: dict[str, str] = {}
    page_paths: set[str] = set()

    for f in sorted(wiki_dir.rglob("*.md")):
        rel = str(f.relative_to(wiki_dir)).replace("\\", "/")
        page_paths.add(rel)
        stem = rel.replace(".md", "").split("/")[-1].lower()
        slug_to_path[stem] = rel
        try:
            raw = f.read_text(encoding="utf-8")
            fm, _ = parse_frontmatter(raw)
        except Exception:
            fm = {}
        related = fm.get("related", [])
        if isinstance(related, str):
            related = [r.strip() for r in related.split(",") if r.strip()]
        pages.append({"path": rel, "related": related})

    # Build incoming link map
    incoming = {p: set() for p in page_paths}
    for page in pages:
        for target in page["related"]:
            resolved = slug_to_path.get(target.lower(), target)
            if resolved in incoming:
                incoming[resolved].add(page["path"])

    # Run checks
    results: list[dict[str, Any]] = []
    structural = {"index.md", "overview.md", "log.md"}

    for page in pages:
        path = page["path"]
        is_structural = any(path.endswith(s) for s in structural)

        # Broken links
        for target in page["related"]:
            resolved = slug_to_path.get(target.lower(), target)
            if resolved not in page_paths:
                results.append({
                    "type": "broken-link",
                    "severity": "warning",
                    "page": path,
                    "detail": f"链接到不存在的页面: {target}",
                })

        # Orphan pages
        if not is_structural and not incoming.get(path):
            results.append({
                "type": "orphan",
                "severity": "info",
                "page": path,
                "detail": "没有任何页面链接到此页面",
            })

        # No outlinks
        if not is_structural and len(page["related"]) == 0:
            results.append({
                "type": "no-outlinks",
                "severity": "info",
                "page": path,
                "detail": "此页面没有链接到其他页面",
            })

    return web.json_response({"results": results})


async def handle_kb_delete_source_cascade(
    req: web.Request,
) -> web.Response:
    """DELETE /api/kb/{id}/source/cascade — delete source file + associated wiki pages."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)

    source_rel = req.query.get("path", "").strip()
    if not source_rel:
        return web.json_response({"error": "path is required"}, status=400)

    # Delete the source file
    file_path = project_path / "raw" / source_rel
    try:
        file_path.resolve().relative_to((project_path / "raw").resolve())
    except ValueError:
        return web.json_response({"error": "Invalid file path"}, status=400)

    if not file_path.exists():
        raise web.HTTPNotFound(reason=f"File '{source_rel}' not found")

    file_path.unlink()

    # Find and delete wiki pages that reference this source
    deleted_pages: list[str] = []
    wiki_dir = project_path / "wiki"
    if wiki_dir.exists():
        source_lower = source_rel.lower()
        pages_to_delete: list[Path] = []
        for f in sorted(wiki_dir.rglob("*.md")):
            try:
                raw = f.read_text(encoding="utf-8")
                fm, _ = parse_frontmatter(raw)
            except Exception:
                continue
            sources = fm.get("sources", [])
            if not isinstance(sources, list):
                continue
            for src in sources:
                if isinstance(src, str) and src.lower() == source_lower:
                    rel = str(f.relative_to(wiki_dir)).replace("\\", "/")
                    pages_to_delete.append(f)
                    deleted_pages.append(rel)
                    break
        for f in pages_to_delete:
            f.unlink()

    # Clean up vector embeddings for deleted pages
    try:
        from mona.kb import vectorstore
        for page_rel in deleted_pages:
            stem = page_rel.replace(".md", "").split("/")[-1]
            try:
                await vectorstore.delete_page(project_path, stem)
            except Exception:
                pass  # non-critical
    except ImportError:
        pass  # vectorstore not available

    return web.json_response({
        "deletedSource": source_rel,
        "deletedPages": deleted_pages,
    })


async def handle_kb_graph(req: web.Request) -> web.Response:
    """GET /api/kb/{id}/graph — get the knowledge graph (built dynamically from wiki pages)."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)

    wiki_dir = project_path / "wiki"
    if not wiki_dir.exists():
        return web.json_response({"nodes": [], "edges": []})

    # Collect all wiki pages with their frontmatter
    pages: list[dict[str, Any]] = []
    for f in sorted(wiki_dir.rglob("*.md")):
        rel = str(f.relative_to(wiki_dir)).replace("\\", "/")
        try:
            raw = f.read_text(encoding="utf-8")
            fm, _ = parse_frontmatter(raw)
        except Exception:
            fm = {}
        pages.append({"path": rel, "frontmatter": fm})

    nodes, edges = build_graph_from_pages(pages)
    return web.json_response({"nodes": nodes, "edges": edges})


async def handle_kb_search(req: web.Request) -> web.Response:
    """GET /api/kb/{id}/search -- hybrid search wiki pages."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)

    query = req.query.get("q", "").strip()
    if not query:
        return web.json_response({"error": "Query parameter 'q' is required"}, status=400)

    count = int(req.query.get("count", "10"))

    from mona.kb.embedding import load_global_embedding_config
    from mona.kb.search import search_wiki_hybrid

    cfg = load_global_embedding_config()

    result = await search_wiki_hybrid(project_path, query, cfg, count)
    return web.json_response(result)


async def handle_kb_get_reviews(req: web.Request) -> web.Response:
    """GET /api/kb/{id}/reviews — get persisted review items."""
    import json

    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)
    reviews_file = project_path / ".llm-wiki" / "reviews.json"
    if not reviews_file.exists():
        return web.json_response({"items": []})
    try:
        data = json.loads(reviews_file.read_text(encoding="utf-8"))
        return web.json_response({"items": data.get("items", [])})
    except Exception:
        return web.json_response({"items": []})


async def handle_kb_save_reviews(req: web.Request) -> web.Response:
    """PUT /api/kb/{id}/reviews — persist review items."""
    import json

    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)
    try:
        body = await req.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)
    items = body.get("items", [])
    reviews_file = project_path / ".llm-wiki" / "reviews.json"
    reviews_file.write_text(
        json.dumps({"items": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return web.json_response({"success": True})


async def handle_kb_embed(req: web.Request) -> web.Response:
    """POST /api/kb/{id}/embed -- trigger embedding for all wiki pages."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)
    wiki_dir = project_path / "wiki"

    try:
        body = await req.json()
    except Exception:
        body = {}

    from mona.kb import vectorstore
    from mona.kb.chunker import ChunkingOptions, chunk_markdown
    from mona.kb.embedding import fetch_embedding, load_global_embedding_config

    cfg = load_global_embedding_config()

    if cfg is None or not cfg.enabled or not cfg.endpoint or not cfg.model:
        return web.json_response({"error": "Embedding not configured"}, status=400)

    chunk_opts = ChunkingOptions(
        target_chars=body.get("maxChunkChars", 1000),
        overlap_chars=body.get("overlapChunkChars", 200),
    )

    if not wiki_dir.exists():
        return web.json_response({"indexed": 0, "failed": 0})

    indexed = 0
    failed = 0
    for md_file in sorted(wiki_dir.rglob("*.md")):
        rel = str(md_file.relative_to(wiki_dir)).replace("\\", "/")
        stem = rel.replace(".md", "").split("/")[-1]
        if stem in ("index", "log", "overview", "purpose", "schema"):
            continue

        content = md_file.read_text(encoding="utf-8")
        fm, _ = parse_frontmatter(content)
        title = fm.get("title", stem)

        chunks = chunk_markdown(content, chunk_opts)
        if not chunks:
            continue

        rows: list[dict] = []
        for chunk in chunks:
            embed_text = (
                f"{title}\n\n{chunk.heading_path}\n\n{chunk.text}"
                if chunk.heading_path
                else f"{title}\n\n{chunk.text}"
            )
            vec = await fetch_embedding(embed_text, cfg)
            if vec:
                rows.append({
                    "chunk_index": chunk.index,
                    "chunk_text": chunk.text,
                    "heading_path": chunk.heading_path,
                    "embedding": vec,
                })
            else:
                failed += 1

        if rows:
            await vectorstore.upsert_chunks(project_path, stem, rows)
            indexed += 1

    return web.json_response({"indexed": indexed, "failed": failed})


async def handle_kb_embed_status(req: web.Request) -> web.Response:
    """GET /api/kb/{id}/embed/status -- get embedding status."""
    project_id = req.match_info["id"]
    project_path = _ensure_project(project_id)

    from mona.kb import vectorstore
    from mona.kb.embedding import get_last_embedding_error

    count = await vectorstore.count_chunks(project_path)
    return web.json_response({
        "chunkCount": count,
        "lastError": get_last_embedding_error(),
    })
