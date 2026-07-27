"""Unified knowledge search tool.

合并笔记和资料库（materials text + wiki）的搜索能力，替代旧的
`notes_search` 和 `kb_search`。

- 笔记搜索：通过 Tauri IPC 调用 Rust 侧 `notes_search_all`（子串匹配）
- 资料搜索：调用 Python 侧 `mona.materials.search.search_materials`
  （CJK bigram + 关键词打分）
- 结果合并后按相关性排序返回

scope 参数控制搜索范围：
- "all"（默认）：笔记 + 资料（text + wiki）
- "notes"：仅笔记
- "materials"：仅资料（text + wiki）
- "wiki"：仅资料 wiki
- "text"：仅资料 text
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.tools.tauri_ipc import tauri_invoke


def _notes_config(ctx: Any) -> Any:
    return getattr(ctx.config, "notes_tools", None)


def _get_vault_path() -> Path | None:
    """通过 Tauri IPC 获取笔记 vault 路径。"""
    try:
        result = tauri_invoke("notes_vault_get_path")
    except RuntimeError:
        return None
    if result is None:
        return None
    if isinstance(result, str) and result.strip():
        return Path(result.strip())
    if isinstance(result, dict):
        v = result.get("path") or result.get("result")
        if isinstance(v, str) and v.strip():
            return Path(v.strip())
    return None


def _vault_ready() -> bool:
    return _get_vault_path() is not None


def _search_notes(query: str, limit: int) -> list[dict[str, Any]]:
    """通过 Tauri IPC 搜索笔记。"""
    try:
        results = tauri_invoke(
            "notes_search_all",
            {"query": query, "limit": limit},
        )
    except RuntimeError as e:
        logger.warning("knowledge_search: notes_search_all failed: {}", e)
        return []
    if not isinstance(results, list):
        return []
    return [r for r in results if isinstance(r, dict)]


def _search_materials(
    vault: Path,
    query: str,
    limit: int,
    scope: str,
) -> list[dict[str, Any]]:
    """调用 Python 侧 search_materials 搜索资料。"""
    try:
        from mona.materials.search import search_materials

        include_text = scope in ("all", "materials", "text")
        include_wiki = scope in ("all", "materials", "wiki")
        return search_materials(
            vault,
            query,
            count=limit,
            include_text=include_text,
            include_wiki=include_wiki,
        )
    except Exception as e:
        logger.warning("knowledge_search: search_materials failed: {}", e)
        return []


_SEARCH_PARAMETERS = tool_parameters_schema(
    query=StringSchema(
        "Search query. Matches note titles, content, tags, and materials "
        "text/wiki pages. Supports CJK (Chinese/Japanese/Korean) keywords."
    ),
    scope=StringSchema(
        "Search scope: 'all' (default, notes + materials), 'notes' (only notes), "
        "'materials' (materials text + wiki), 'wiki' (only materials wiki), "
        "'text' (only materials extracted text)."
    ),
    limit=IntegerSchema(
        "Maximum number of results to return per source (default 10)."
    ),
    required=["query"],
)


@tool_parameters(_SEARCH_PARAMETERS)
class KnowledgeSearchTool(Tool):
    """Search the user's personal knowledge base (notes + materials)."""

    _scopes = {"core", "subagent"}
    _plugin_discoverable = True
    read_only = True
    subscription_required = True

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        cfg = _notes_config(ctx)
        return cfg is None or bool(getattr(cfg, "enabled", True))

    @property
    def name(self) -> str:
        return "knowledge_search"

    @property
    def description(self) -> str:
        return (
            "Search the user's personal knowledge base — notes vault and "
            "materials library (uploaded documents + AI-compiled wiki pages). "
            "Returns matching entries with title, snippet, and source type. "
            "Use this to find information the user has saved before answering "
            "'I don't know'. For notes, follow up with notes_read to get full "
            "content. For materials wiki, the snippet is usually sufficient."
        )

    async def execute(self, **kwargs: Any) -> Any:
        query = str(kwargs.get("query", "")).strip()
        if not query:
            return "Error: query is required."

        scope = str(kwargs.get("scope", "all")).strip().lower()
        valid_scopes = {"all", "notes", "materials", "wiki", "text"}
        if scope not in valid_scopes:
            return (
                f"Error: scope must be one of {valid_scopes}. Got '{scope}'."
            )

        limit = 10
        raw_limit = kwargs.get("limit")
        if raw_limit is not None:
            try:
                limit = max(1, min(50, int(raw_limit)))
            except (TypeError, ValueError):
                pass

        if not _vault_ready():
            return "Error: Notes vault is not configured."

        vault = _get_vault_path()
        if vault is None:
            return "Error: Notes vault is not configured."

        # 按范围搜索
        notes_results: list[dict[str, Any]] = []
        materials_results: list[dict[str, Any]] = []

        if scope in ("all", "notes"):
            notes_results = _search_notes(query, limit)

        if scope in ("all", "materials", "wiki", "text"):
            materials_results = _search_materials(vault, query, limit, scope)

        # 合并结果
        if not notes_results and not materials_results:
            return f"No results found for '{query}' in scope '{scope}'."

        lines = [f"Knowledge search results for '{query}' (scope: {scope}):"]

        if notes_results:
            lines.append(f"\n## Notes ({len(notes_results)})")
            for i, item in enumerate(notes_results, 1):
                note_id = item.get("noteId", "?")
                title = item.get("title", "(untitled)")
                snippet = item.get("snippet", "")
                notebook = item.get("notebookName", "")
                lines.append(
                    f"\n{i}. [{note_id}] {title}"
                    + (f" ({notebook})" if notebook else "")
                )
                if snippet:
                    lines.append(f"   {snippet}")

        if materials_results:
            lines.append(f"\n## Materials ({len(materials_results)})")
            for i, item in enumerate(materials_results, 1):
                kind = item.get("kind", "")
                title = item.get("title", "(untitled)")
                path = item.get("path", "")
                snippet = item.get("snippet", "")
                kind_label = {
                    "material_source": "source",
                    "material_wiki": "wiki",
                }.get(kind, kind)
                lines.append(f"\n{i}. [{kind_label}] {title}")
                if path:
                    lines.append(f"   Path: {path}")
                if snippet:
                    lines.append(f"   {snippet}")

        return "\n".join(lines)
