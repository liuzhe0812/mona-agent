"""Personal knowledge search tools.

主 Mona 保留统一的 `knowledge_search`；其他 Agent 使用分权的
`notes_search` 与 `wiki_search`。旧 `materials_search/materials_read`
作为证据检索兼容入口保留。

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
from mona.agent.tools.tauri_ipc import tauri_invoke, tauri_invoke_async
from mona.config.paths import get_agent_knowledge_dir, get_data_dir
from mona.materials.access import allowed_library_ids, library_allowed
from mona.materials.catalog import get_library_root, list_libraries, validate_library_id
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


async def _search_notes_async(query: str, limit: int) -> list[dict[str, Any]]:
    """Async note search so the Tauri IPC request cannot block the loop."""
    try:
        results = await tauri_invoke_async(
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
    *,
    agent_id: str = "mona",
    knowledge_base_id: str | None = None,
) -> list[dict[str, Any]]:
    """走 FTS5 chunk 索引检索资料，返回结构化 chunk（ref/location/stale）。

    索引不可用时返回空列表（reconcile 与写入点同步负责索引新鲜度）。
    """
    kinds_map = {
        "text": ("source",),
        "wiki": ("derived",),
    }
    kinds = kinds_map.get(scope, ("source", "derived"))
    from mona.materials.index import MaterialsIndex, sync_index

    if knowledge_base_id:
        # Old callers may still send this field during the UI migration. An
        # Agent Wiki has no selectable sub-library, so it cannot widen scope.
        return []

    results: list[dict[str, Any]] = []
    try:
        root = get_agent_knowledge_dir(agent_id)
        if not (root / "state.json").exists():
            legacy_vault = _get_vault_path()
            if legacy_vault is not None:
                return _search_legacy_materials(
                    legacy_vault,
                    query,
                    limit,
                    scope,
                    agent_id=agent_id,
                )
        index = MaterialsIndex(
            root / "index.db", vault=get_data_dir(), library_root=root
        )
        try:
            sync_index(get_data_dir(), index, library_root=root)
            search_count = min(150, limit * 3) if scope == "materials" else limit
            rows = index.search(query, count=search_count, kinds=kinds)
        finally:
            index.close()
        from mona.materials.knowledge import ready_knowledge_access

        ready_material_ids, ready_evidence_ids = ready_knowledge_access(root)
        for item in rows:
            if item.get("kind") == "material_source":
                if item.get("materialId") not in ready_material_ids:
                    continue
            else:
                location = item.get("location") or {}
                evidence_refs = location.get("evidenceRefs") or []
                if not evidence_refs or any(
                    str(ref) not in ready_evidence_ids for ref in evidence_refs
                ):
                    continue
            item["ref"] = "ak:" + str(item["ref"])
            item["agentId"] = agent_id
            results.append(item)
    except Exception as e:
        logger.warning("knowledge_search: Agent {} search failed: {}", agent_id, e)

    results.sort(
        key=lambda item: (
            item.get("kind") != "material_source" if scope == "materials" else False,
            -float(item.get("score", 0.0)),
        )
    )
    return results[:limit]


def _search_legacy_materials(
    vault: Path,
    query: str,
    limit: int,
    scope: str,
    *,
    agent_id: str,
) -> list[dict[str, Any]]:
    """Read old scoped libraries until that Agent has migrated knowledge state."""
    from mona.materials.index import MaterialsIndex, sync_index

    kinds = {
        "text": ("source",),
        "wiki": ("derived",),
    }.get(scope, ("source", "derived"))
    library_names = {
        str(item["id"]): str(item["name"]) for item in list_libraries(vault)
    }
    results: list[dict[str, Any]] = []
    for library_id in allowed_library_ids(vault, agent_id):
        root = get_library_root(vault, library_id)
        index = MaterialsIndex(root / "index.db", vault=vault, library_root=root)
        try:
            sync_index(vault, index, library_root=root)
            rows = index.search(query, count=limit, kinds=kinds)
        finally:
            index.close()
        for item in rows:
            item["ref"] = _encode_material_ref(library_id, str(item["ref"]))
            item["knowledgeBaseId"] = library_id
            item["knowledgeBaseName"] = library_names.get(library_id, library_id)
            results.append(item)
    results.sort(key=lambda item: -float(item.get("score", 0.0)))
    return results[:limit]


def _encode_material_ref(library_id: str, ref: str) -> str:
    return f"kb:{library_id}:{ref}"


def _decode_material_ref(ref: str) -> tuple[str, str]:
    if not ref.startswith("kb:"):
        return "kb-default", ref
    _, library_id, raw_ref = ref.split(":", 2)
    return validate_library_id(library_id), raw_ref


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

_NOTES_SEARCH_PARAMETERS = tool_parameters_schema(
    query=StringSchema(
        "Search query. Matches note titles and content, including CJK keywords."
    ),
    limit=IntegerSchema("Maximum number of results to return (default 10)."),
    required=["query"],
)

_MATERIALS_SEARCH_PARAMETERS = tool_parameters_schema(
    query=StringSchema(
        "Search query for uploaded materials and AI-compiled wiki pages."
    ),
    scope=StringSchema(
        "Materials scope: 'materials' (default, text + wiki), 'wiki', or 'text'."
    ),
    limit=IntegerSchema("Maximum number of results to return (default 10)."),
    required=["query"],
)

_WIKI_SEARCH_PARAMETERS = tool_parameters_schema(
    query=StringSchema(
        "Search compiled Wiki pages in this Agent's private knowledge."
    ),
    limit=IntegerSchema("Maximum number of Wiki pages to return (default 10)."),
    required=["query"],
)


def _search_limit(value: Any) -> int:
    try:
        return max(1, min(50, int(value))) if value is not None else 10
    except (TypeError, ValueError):
        return 10


def _format_notes_results(query: str, results: list[dict[str, Any]]) -> str:
    if not results:
        return f"No notes found for '{query}'."
    lines = [f"Notes search results for '{query}':"]
    for i, item in enumerate(results, 1):
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
    return "\n".join(lines)


def _format_materials_results(query: str, results: list[dict[str, Any]]) -> str:
    if not results:
        return f"No materials found for '{query}'."
    lines = [f"Materials search results for '{query}':"]
    for i, item in enumerate(results, 1):
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
        knowledge_base = item.get("knowledgeBaseName") or item.get("knowledgeBaseId")
        if knowledge_base:
            lines.append(f"   Knowledge base: {knowledge_base}")
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


# ---------------------------------------------------------------------------
# materials_read
# ---------------------------------------------------------------------------

_READ_PARAMETERS = tool_parameters_schema(
    ref=StringSchema(
        "The chunk Ref returned by materials_search or knowledge_search "
        "(format: 'ak:<material-id>:<seq>')."
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

    def __init__(self, agent_id: str = "mona") -> None:
        self._agent_id = agent_id

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(str(getattr(ctx, "agent_id", "mona") or "mona"))

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return True

    @property
    def name(self) -> str:
        return "materials_read"

    @property
    def description(self) -> str:
        return (
            "Read the full content of a materials chunk located by "
            "materials_search (pass its Ref). Returns the chunk text, its "
            "location (page/slide/sheet/section), neighbor chunks for context, "
            "and a ready-to-use citation label like [报告.pdf, Page 12]. "
            "Always read at least one chunk before answering factual questions "
            "about the user's materials, and cite the label in your answer. "
            "AI-compiled Wiki is navigation-only; when reading a Wiki hit this "
            "tool also returns its original evidence chunks when available."
        )

    async def execute(self, **kwargs: Any) -> Any:
        encoded_ref = str(kwargs.get("ref", "")).strip()
        if not encoded_ref:
            return "Error: ref is required."
        agent_scoped = encoded_ref.startswith("ak:")
        knowledge_base_id: str | None = None
        if agent_scoped:
            ref = encoded_ref[3:]
        else:
            try:
                knowledge_base_id, ref = _decode_material_ref(encoded_ref)
            except ValueError:
                return "Error: invalid materials ref."
        max_chars = _DEFAULT_MAX_CHARS
        raw_max = kwargs.get("max_chars")
        if raw_max is not None:
            try:
                max_chars = max(200, min(50000, int(raw_max)))
            except (TypeError, ValueError):
                pass

        from mona.materials.index import MaterialsIndex

        if agent_scoped:
            vault = get_data_dir()
            root = get_agent_knowledge_dir(self._agent_id)
        else:
            vault = _get_vault_path()
            if vault is None:
                return "Error: Notes vault is not configured."
            if knowledge_base_id is None or not library_allowed(
                vault, self._agent_id, knowledge_base_id
            ):
                return "Error: this Agent is not allowed to read that knowledge base."
            root = get_library_root(vault, knowledge_base_id)
        index = MaterialsIndex(root / "index.db", vault=vault, library_root=root)
        evidence_chunks: list[dict[str, Any]] = []
        missing_evidence_refs: list[str] = []
        try:
            chunk = index.get_chunk(ref)
            if chunk is None:
                return (
                    f"Error: ref '{ref}' not found. It may be stale — "
                    "run materials_search again to get a fresh Ref."
                )
            if agent_scoped:
                from mona.materials.knowledge import ready_knowledge_access

                ready_material_ids, ready_evidence_ids = ready_knowledge_access(root)
                if chunk["kind"] == "material_source":
                    if chunk.get("materialId") not in ready_material_ids:
                        return "Error: this material is not available."
                else:
                    evidence_refs = (chunk.get("location") or {}).get("evidenceRefs") or []
                    if not evidence_refs or any(
                        str(item) not in ready_evidence_ids for item in evidence_refs
                    ):
                        return "Error: this Wiki page has no available source evidence."
            neighbors = index.get_neighbors(ref, before=1, after=1)
            if chunk["kind"] == "material_wiki":
                location = chunk.get("location") or {}
                evidence_refs = location.get("evidenceRefs") or []
                for evidence_ref in evidence_refs[:5]:
                    evidence = index.get_chunk(str(evidence_ref))
                    if evidence is None or evidence["kind"] != "material_source":
                        missing_evidence_refs.append(str(evidence_ref))
                        continue
                    evidence_chunks.append(evidence)
        finally:
            index.close()

        title = chunk["title"]
        label = chunk["locationLabel"] or title
        kind_label = "source" if chunk["kind"] == "material_source" else "wiki"
        citation = f"[{title}, {label}]" if label != title else f"[{title}]"

        lines = [f"# {title}" + (f" — {label}" if label != title else "")]
        meta = [
            f"ref={encoded_ref}",
            f"agentId={self._agent_id}" if agent_scoped else f"knowledgeBaseId={knowledge_base_id}",
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

        if chunk["kind"] == "material_wiki":
            lines.append("")
            lines.append("--- 原文证据（Wiki 仅用于导航，不可单独作为事实依据）---")
            if evidence_chunks:
                for evidence in evidence_chunks:
                    evidence_label = evidence["locationLabel"] or evidence["title"]
                    evidence_content = evidence["content"]
                    if len(evidence_content) > 2000:
                        evidence_content = evidence_content[:2000] + "\n[truncated]"
                    lines.append(
                        f"\n[{'ak:' + evidence['ref'] if agent_scoped else _encode_material_ref(str(knowledge_base_id), evidence['ref'])}] "
                        f"{evidence['title']} — "
                        f"{evidence_label}\n{evidence_content}"
                    )
            else:
                lines.append("该 Wiki 没有可用的原文 evidenceRefs；请重新搜索原始资料后再回答。")
            if missing_evidence_refs:
                lines.append(
                    "缺失或过期 evidenceRefs: " + ", ".join(missing_evidence_refs)
                )

        lines.append("")
        lines.append(f"引用标签: {citation}")
        # 可点击的 markdown 引用链接：前端拦截 mona:material 协议，
        # 打开资料页并滚动到对应位置。模型在回答中原样使用此链接。
        link_path = f"{'wiki' if chunk['kind'] == 'material_wiki' else 'raw'}/{chunk['rawPath']}"
        scope_query = (
            f"agentId={quote(self._agent_id, safe='')}"
            if agent_scoped
            else f"knowledgeBaseId={quote(str(knowledge_base_id), safe='')}"
        )
        cite_link = (
            f"{citation}(mona:material?{scope_query}&"
            f"path={quote(link_path, safe='')}&location={quote(label, safe='')})"
        )
        lines.append(f"引用链接（在回答中原样使用）: {cite_link}")
        return "\n".join(lines)


@tool_parameters(_NOTES_SEARCH_PARAMETERS)
class NotesSearchTool(Tool):
    """Search notes without granting access to the materials library."""

    _scopes = {"subagent"}
    _plugin_discoverable = True
    read_only = True
    subscription_required = True

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        cfg = _notes_config(ctx)
        return cfg is None or bool(getattr(cfg, "enabled", True))

    @property
    def name(self) -> str:
        return "notes_search"

    @property
    def description(self) -> str:
        return (
            "Search notes the user has allowed Agents to access. Returns note "
            "IDs, titles, notebooks, and snippets. Follow up with notes_read "
            "when full content is needed."
        )

    async def execute(self, **kwargs: Any) -> Any:
        query = str(kwargs.get("query", "")).strip()
        if not query:
            return "Error: query is required."
        if not _vault_ready():
            return "Error: Notes vault is not configured."
        return _format_notes_results(
            query,
            await _search_notes_async(query, _search_limit(kwargs.get("limit"))),
        )


@tool_parameters(_MATERIALS_SEARCH_PARAMETERS)
class MaterialsSearchTool(Tool):
    """Search materials without granting access to personal notes."""

    _scopes = {"subagent"}
    _plugin_discoverable = True
    read_only = True
    subscription_required = True

    def __init__(self, agent_id: str = "mona") -> None:
        self._agent_id = agent_id

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(str(getattr(ctx, "agent_id", "mona") or "mona"))

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return True

    @property
    def name(self) -> str:
        return "materials_search"

    @property
    def description(self) -> str:
        return (
            "Search uploaded materials and AI-compiled Wiki pages. Original "
            "source chunks are returned before derived Wiki hits for the default "
            "materials scope. Use Wiki only to navigate or expand a query, then "
            "read and cite original chunks with materials_read."
        )

    async def execute(self, **kwargs: Any) -> Any:
        query = str(kwargs.get("query", "")).strip()
        if not query:
            return "Error: query is required."
        scope = str(kwargs.get("scope", "materials")).strip().lower()
        if scope not in {"materials", "wiki", "text"}:
            return "Error: scope must be one of {'materials', 'wiki', 'text'}."
        return _format_materials_results(
            query,
            _search_materials(
                get_data_dir(),
                query,
                _search_limit(kwargs.get("limit")),
                scope,
                agent_id=self._agent_id,
            ),
        )


@tool_parameters(_WIKI_SEARCH_PARAMETERS)
class WikiSearchTool(Tool):
    """Search compiled, linked pages within the Agent's private Wiki."""

    _scopes = {"core", "subagent"}
    _plugin_discoverable = True
    read_only = True
    subscription_required = True

    def __init__(self, agent_id: str = "mona") -> None:
        self._agent_id = agent_id

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(str(getattr(ctx, "agent_id", "mona") or "mona"))

    @property
    def name(self) -> str:
        return "wiki_search"

    @property
    def description(self) -> str:
        return (
            "Search this Agent's compiled LLM Wiki pages. Read promising pages "
            "with wiki_read and "
            "follow their wikilinks or evidence references as needed."
        )

    async def execute(self, **kwargs: Any) -> Any:
        query = str(kwargs.get("query", "")).strip()
        if not query:
            return "Error: query is required."
        return _format_materials_results(
            query,
            _search_materials(
                get_data_dir(),
                query,
                _search_limit(kwargs.get("limit")),
                "wiki",
                agent_id=self._agent_id,
            ),
        )


@tool_parameters(_READ_PARAMETERS)
class WikiReadTool(MaterialsReadTool):
    """Read a compiled Wiki page or its linked evidence."""

    @property
    def name(self) -> str:
        return "wiki_read"

    @property
    def description(self) -> str:
        return (
            "Read a Wiki page Ref returned by wiki_search. The full page includes "
            "wikilinks and source evidence so the Agent can continue traversing "
            "the compiled knowledge structure."
        )


@tool_parameters(_SEARCH_PARAMETERS)
class KnowledgeSearchTool(Tool):
    """Search the user's personal knowledge base (notes + materials)."""

    _scopes = {"core"}
    _plugin_discoverable = True
    read_only = True
    subscription_required = True

    def __init__(self, agent_id: str = "mona") -> None:
        self._agent_id = agent_id

    @classmethod
    def create(cls, ctx: Any) -> Tool:
        return cls(str(getattr(ctx, "agent_id", "mona") or "mona"))

    @classmethod
    def enabled(cls, ctx: Any) -> bool:
        return True

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

        limit = _search_limit(kwargs.get("limit"))

        # 按范围搜索
        notes_results: list[dict[str, Any]] = []
        materials_results: list[dict[str, Any]] = []

        if scope in ("all", "notes") and _vault_ready():
            notes_results = await _search_notes_async(query, limit)

        if scope in ("all", "materials", "wiki", "text"):
            materials_results = _search_materials(
                get_data_dir(),
                query,
                limit,
                scope,
                agent_id=self._agent_id,
            )

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
                knowledge_base = item.get("knowledgeBaseName") or item.get("knowledgeBaseId")
                if knowledge_base:
                    lines.append(f"   Knowledge base: {knowledge_base}")
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
