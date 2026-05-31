from __future__ import annotations

from pathlib import Path

from mona.agent.tools.base import BaseTool, ToolResult
from mona.config.paths import get_workspace_path
from mona.knowledge.compiler import SourceCompiler
from mona.knowledge.indexer import WikiIndexer
from mona.knowledge.query import VaultQuery
from mona.knowledge.store import VaultStore


def _get_vault(instance: str = "default") -> tuple[VaultStore, WikiIndexer]:
    workspace = get_workspace_path()
    root = workspace / ".knowledge" / instance
    store = VaultStore(root)
    store.ensure_dirs()
    indexer = WikiIndexer(root / "state" / "search.db")
    indexer.initialize()
    return store, indexer


def _llm_generate(prompt: str) -> str:
    """Generate text using Mona's LLM provider."""
    from mona.llm.provider import get_provider

    provider = get_provider()
    response = provider.generate(prompt)
    return response.content


class KbIngestTool(BaseTool):
    name = "kb_ingest"
    description = "Ingest files into the knowledge vault."

    async def execute(self, paths: list[str], instance: str = "default") -> ToolResult:
        store, _ = _get_vault(instance)
        ingested = 0
        for p in paths:
            path = Path(p)
            if path.is_file():
                if store.ingest_file(path):
                    ingested += 1
            elif path.is_dir():
                for fp in path.rglob("*"):
                    if fp.is_file() and not fp.name.startswith("."):
                        if store.ingest_file(fp):
                            ingested += 1
        return ToolResult(
            success=True,
            content=f"Ingested {ingested} files into vault '{instance}'",
        )


class KbQueryTool(BaseTool):
    name = "kb_query"
    description = "Query the knowledge vault."

    async def execute(self, query: str, instance: str = "default", limit: int = 5) -> ToolResult:
        store, indexer = _get_vault(instance)
        graph = store.load_graph()
        q = VaultQuery(store, indexer, graph)
        results = q.search(query, limit)
        return ToolResult(
            success=True,
            content={"results": results, "query": query},
        )


class KbCompileTool(BaseTool):
    name = "kb_compile"
    description = "Compile pending sources in the knowledge vault."

    async def execute(self, instance: str = "default") -> ToolResult:
        store, _ = _get_vault(instance)
        compiler = SourceCompiler(store)
        count = compiler.compile_pending(_llm_generate)
        return ToolResult(
            success=True,
            content=f"Compiled {count} sources in vault '{instance}'",
        )


class KbStatusTool(BaseTool):
    name = "kb_status"
    description = "Get knowledge vault status."

    async def execute(self, instance: str = "default") -> ToolResult:
        store, indexer = _get_vault(instance)
        meta = store.load_meta()
        graph = store.load_graph()
        return ToolResult(
            success=True,
            content={
                "instance": instance,
                "sources": meta.source_count,
                "pages": meta.page_count,
                "nodes": len(graph.nodes),
                "edges": len(graph.edges),
                "pending": len(meta.pending_sources),
                "indexed": indexer.get_doc_count(),
            },
        )
