"""Ingest utilities for KB wiki pages.

Note: The actual ingest (LLM call + page generation) is now handled by the
frontend (ingest.ts). This module only provides parsing utilities used by
the backend API handlers.
"""

from __future__ import annotations

import re
from typing import Any


def parse_file_blocks(text: str) -> list[tuple[str, str]]:
    """Parse ---FILE: path--- ... ---ENDFILE--- blocks from LLM output.

    Tolerant of CRLF, extra whitespace, and case variations.
    Returns list of (path, content) tuples.
    """
    text = text.replace("\r\n", "\n")
    results: list[tuple[str, str]] = []

    opener = re.compile(r"^---\s*FILE:\s*(.+?)\s*---\s*$", re.MULTILINE | re.IGNORECASE)
    closer = re.compile(r"^---\s*END\s*FILE\s*---\s*$", re.MULTILINE | re.IGNORECASE)

    for match in opener.finditer(text):
        path = match.group(1).strip()
        start = match.end()
        close_match = closer.search(text, start)
        if not close_match:
            continue
        content = text[start:close_match.start()].strip()
        results.append((path, content))

    return results


def parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """Parse YAML frontmatter from markdown content.

    Returns (frontmatter_dict, body_text).
    """
    if not content.startswith("---"):
        return {}, content

    end = content.find("---", 3)
    if end == -1:
        return {}, content

    yaml_text = content[3:end].strip()
    body = content[end + 3:].strip()

    frontmatter: dict[str, Any] = {}
    current_key: str | None = None
    current_list: list[str] | None = None

    for line in yaml_text.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue

        # List item
        if stripped.startswith("- ") and current_key is not None and current_list is not None:
            current_list.append(stripped[2:].strip())
            continue

        # Key-value pair
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


def build_graph_from_pages(pages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build graph nodes and edges from wiki pages."""
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []

    # Build slug -> path mapping for resolving related links
    slug_to_path: dict[str, str] = {}
    for page in pages:
        path = page.get("path", "")
        # Slug is the filename without extension, e.g. "wiki/entities/oe-system.md" -> "oe-system"
        stem = path.rsplit("/", 1)[-1].rsplit(".", 1)[0] if "/" in path else path.rsplit(".", 1)[0]
        slug_to_path[stem] = path

    for page in pages:
        path = page.get("path", "")
        frontmatter = page.get("frontmatter", {})
        title = frontmatter.get("title", path)
        page_type = frontmatter.get("type", "concept")
        tags = frontmatter.get("tags", [])

        nodes.append({
            "id": path,
            "path": path,
            "label": title,
            "type": page_type,
            "tags": tags if isinstance(tags, list) else [tags],
            "sources": frontmatter.get("sources", []),
        })

        related = frontmatter.get("related", [])
        if isinstance(related, str):
            related = [related]
        for target_slug in related:
            target_slug = target_slug.strip()
            # Resolve slug to full path
            resolved = slug_to_path.get(target_slug, target_slug)
            # Only add edge if target node exists
            if resolved in slug_to_path.values():
                edges.append({
                    "source": path,
                    "target": resolved,
                    "type": "related",
                })

    return nodes, edges
