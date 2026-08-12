"""Unified knowledge search tool.

合并笔记和资料库（materials text + wiki）的搜索能力，替代旧的
`notes_search` 和 `kb_search`。

- 笔记搜索：通过 Tauri IPC 调用 Rust 侧 `notes_search_all`（子串匹配）
- 资料搜索：走 `mona.materials.index` 的 FTS5 chunk 索引（结构化 segment、
  位置标记、stale 检测）

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
from urllib.parse import quote

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.tools.tauri_ipc import tauri_invoke
from mona.materials.vault import get_vault_path as _get_vault_path


def _notes_config(ctx: Any) -> Any:
    return getattr(ctx.config, "notes_tools", None)


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
    """走 FTS5 chunk 索引检索资料，返回结构化 chunk（ref/location/stale）。

    索引不可用时返回空列表（reconcile 与写入点同步负责索引新鲜度）。
    """
    kinds_map = {
        "text": ("source",),
        "wiki": ("derived",),
    }
    kinds = kinds_map.get(scope, ("source", "derived"))
    try:
        from mona.materials.index import MaterialsIndex, sync_index

        index = MaterialsIndex(
            vault / ".mona" / "materials" / "index.db", vault=vault
        )
        try:
            # 增量同步：raw/text/wiki 变化在搜索时即刻反映，
            # 保证"删除或修改原文后不再返回旧 chunk"。
            sync_index(vault, index)
            return index.search(query, count=limit, kinds=kinds)
        finally:
            index.close()
    except Exception as e:
        logger.warning("knowledge_search: index search failed: {}", e)
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


# ---------------------------------------------------------------------------
# materials_read
# ---------------------------------------------------------------------------

_READ_PARAMETERS = tool_parameters_schema(
    ref=StringSchema(
        "The chunk Ref returned by knowledge_search (format: '<material-id>:<seq>')."
    ),
    max_chars=IntegerSchema(
        "Maximum characters of the located chunk to return (default 4000). "
        "Neighbor context is not affected."
    ),
    required=["ref"],
)

_DEFAULT_MAX_CHARS = 4000


@tool_parameters(_READ_PARAMETERS)
class MaterialsReadTool(Tool):
    """Read a located materials chunk by ref, with neighbor context."""

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
        return "materials_read"

    @property
    def description(self) -> str:
        return (
            "Read the full content of a materials chunk located by "
            "knowledge_search (pass its Ref). Returns the chunk text, its "
            "location (page/slide/sheet/section), neighbor chunks for context, "
            "and a ready-to-use citation label like [报告.pdf, Page 12]. "
            "Always read at least one chunk before answering factual questions "
            "about the user's materials, and cite the label in your answer."
        )

    async def execute(self, **kwargs: Any) -> Any:
        ref = str(kwargs.get("ref", "")).strip()
        if not ref:
            return "Error: ref is required."
        max_chars = _DEFAULT_MAX_CHARS
        raw_max = kwargs.get("max_chars")
        if raw_max is not None:
            try:
                max_chars = max(200, min(50000, int(raw_max)))
            except (TypeError, ValueError):
                pass

        vault = _get_vault_path()
        if vault is None:
            return "Error: Notes vault is not configured."

        from mona.materials.index import MaterialsIndex

        index = MaterialsIndex(
            vault / ".mona" / "materials" / "index.db", vault=vault
        )
        try:
            chunk = index.get_chunk(ref)
            if chunk is None:
                return (
                    f"Error: ref '{ref}' not found. It may be stale — "
                    "run knowledge_search again to get a fresh Ref."
                )
            neighbors = index.get_neighbors(ref, before=1, after=1)
        finally:
            index.close()

        title = chunk["title"]
        label = chunk["locationLabel"] or title
        kind_label = "source" if chunk["kind"] == "material_source" else "wiki"
        citation = f"[{title}, {label}]" if label != title else f"[{title}]"

        lines = [f"# {title}" + (f" — {label}" if label != title else "")]
        meta = [
            f"ref={ref}",
            f"kind={kind_label}",
            f"path={chunk['rawPath']}",
        ]
        if chunk["kind"] == "material_wiki":
            meta.append("derived=true")
        if chunk["stale"]:
            meta.append("stale=true（原文件已修改，内容可能过时）")
        lines.append(f"({'; '.join(meta)})")
        lines.append("")

        content = chunk["content"]
        truncated = False
        if len(content) > max_chars:
            content = content[:max_chars]
            truncated = True
        lines.append(content)
        if truncated:
            lines.append("")
            lines.append(f"[truncated: 仅显示前 {max_chars} 字符]")

        before = [n for n in neighbors if n["seq"] < chunk["seq"]]
        after = [n for n in neighbors if n["seq"] > chunk["seq"]]
        if before or after:
            lines.append("")
            lines.append("--- 相邻上下文 ---")
            for n in before:
                lines.append(f"\n[上文 {n['locationLabel'] or n['ref']}]\n{n['content']}")
            for n in after:
                lines.append(f"\n[下文 {n['locationLabel'] or n['ref']}]\n{n['content']}")

        lines.append("")
        lines.append(f"引用标签: {citation}")
        # 可点击的 markdown 引用链接：前端拦截 mona:material 协议，
        # 打开资料页并滚动到对应位置。模型在回答中原样使用此链接。
        link_path = f"{'wiki' if chunk['kind'] == 'material_wiki' else 'raw'}/{chunk['rawPath']}"
        cite_link = (
            f"{citation}(mona:material?"
            f"path={quote(link_path, safe='')}&location={quote(label, safe='')})"
        )
        lines.append(f"引用链接（在回答中原样使用）: {cite_link}")
        return "\n".join(lines)


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
            "content. For materials results with a Ref, follow up with "
            "materials_read(ref) to read the full located chunk (page/slide/"
            "sheet/section) before answering, and cite the material name and "
            "location in your answer."
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
                path = item.get("rawPath") or item.get("path", "")
                snippet = item.get("snippet", "")
                kind_label = {
                    "material_source": "source",
                    "material_wiki": "wiki",
                }.get(kind, kind)
                location_label = item.get("locationLabel") or ""
                header = f"\n{i}. [{kind_label}] {title}"
                if location_label and location_label != title:
                    header += f" — {location_label}"
                lines.append(header)
                ref = item.get("ref")
                if ref:
                    lines.append(f"   Ref: {ref}")
                if path:
                    lines.append(f"   Path: {path}")
                if item.get("stale"):
                    lines.append("   [stale: 原文件已修改，内容可能过时]")
                if snippet:
                    lines.append(f"   {snippet}")

        return "\n".join(lines)
