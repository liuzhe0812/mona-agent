"""Hoard agent tools: search and capture cross-source memories.

hoard_search: Search the hoard memory layer for URLs/fragments the user
  has collected from browser, email, notes, or chat.
hoard_capture: Proactively save a URL or text fragment to the hoard during
  conversation (source_strength=0.8, user can delete in UI).
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    IntegerSchema,
    StringSchema,
    tool_parameters_schema,
)

# ---------------------------------------------------------------------------
# hoard_search
# ---------------------------------------------------------------------------

_SEARCH_PARAMETERS = tool_parameters_schema(
    query=StringSchema("Search query - what to look for in collected memories"),
    source=StringSchema(
        "Filter by source: 'browser', 'email', 'note', 'chat', or omit for all sources",
    ),
    count=IntegerSchema(
        5, description="Number of results (1-20)", minimum=1, maximum=20
    ),
    required=["query"],
)


@tool_parameters(_SEARCH_PARAMETERS)
class HoardSearchTool(Tool):
    """Search the hoard memory layer for collected URLs and fragments."""

    name = "hoard_search"
    description = (
        "搜索Mona记忆库(Hoard),召回用户在浏览器、邮件、笔记、对话中收藏过的内容。"
        "返回标题、摘要、标签、来源和相关联的其他信息源。"
        "适用场景:用户问'之前看过的''上周聊到的''邮件里提到的'等需要回忆历史内容的问题。"
    )

    _scopes = {"core", "subagent"}

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, query: str, **kwargs: Any) -> str:
        source = kwargs.get("source")
        count = kwargs.get("count", 5)

        try:
            from mona.hoard.ingest import _load_embedding_config
            from mona.hoard.search import search_hoard_hybrid

            embedding_config = _load_embedding_config()
            result = await search_hoard_hybrid(
                query,
                source=source,
                limit=count,
                embedding_config=embedding_config,
            )
            results = result.get("results", [])
            mode = result.get("mode", "keyword")
        except Exception as e:
            logger.warning(f"[hoard_search] failed: {e}")
            return f"Error searching hoard: {e}"

        if not results:
            return f"No memories found for: {query}"

        lines = [f"Memory search results for: {query} (mode: {mode})\n"]
        for i, item in enumerate(results, 1):
            title = item.get("title", "(untitled)")
            url = item.get("url", "")
            summary = item.get("summary", "")
            tags = item.get("tags", [])
            src = item.get("source", "")
            related = item.get("related_sources", [])

            lines.append(f"{i}. [{src}] {title}")
            if url:
                lines.append(f"   URL: {url}")
            if summary:
                lines.append(f"   摘要: {summary[:200]}")
            if tags:
                lines.append(f"   标签: {', '.join(tags)}")
            if related:
                rel_descs = []
                for r in related[:3]:
                    r_type = r.get("type", "?")
                    r_meta = r.get("meta", {})
                    r_title = r_meta.get("title", "") if isinstance(r_meta, dict) else ""
                    rel_descs.append(f"{r_type}:{r_title}" if r_title else r_type)
                lines.append(f"   关联: {', '.join(rel_descs)}")
            lines.append("")

        return "\n".join(lines)


# ---------------------------------------------------------------------------
# hoard_capture
# ---------------------------------------------------------------------------

_CAPTURE_PARAMETERS = tool_parameters_schema(
    url=StringSchema("URL to save (optional for fragment-type captures)"),
    title=StringSchema("Title describing this content"),
    content=StringSchema("Text content/snippet to save (optional for URL captures)"),
    source=StringSchema(
        "Source type: 'chat' (default for agent captures), 'browser', 'email', 'note'",
    ),
    source_ref=StringSchema("Reference ID from the source (e.g. email_id, note_id, session_id)"),
    required=["title"],
)


@tool_parameters(_CAPTURE_PARAMETERS)
class HoardCaptureTool(Tool):
    """Save a URL or text fragment to the hoard memory layer."""

    name = "hoard_capture"
    description = (
        "把一条URL或文本片段收藏到Mona记忆库(Hoard),供未来对话召回。"
        "触发条件:当用户在对话中表达对某URL/文件/邮件的**关注意图**时调用"
        "(如'记一下''收藏下''这个有用''回头要看'),"
        "或当Agent判断某内容对**未来对话有潜在价值**时调用。"
        "不要为用户随口提及、负面评价、临时示例的URL调用。"
        "入库后source_strength=0.8(低于用户主动收藏的1.0),用户可在UI删除。"
    )

    _scopes = {"core"}

    @property
    def read_only(self) -> bool:
        return False

    async def execute(self, title: str, **kwargs: Any) -> str:
        url = kwargs.get("url")
        content = kwargs.get("content")
        source = kwargs.get("source", "chat")
        source_ref = kwargs.get("source_ref")

        try:
            from mona.hoard.ingest import _load_embedding_config, ingest_hoard
            from mona.hoard.models import HoardManager

            manager = HoardManager()
            hoard_id = manager.add(
                url=url,
                title=title,
                content=content,
                source=source,
                source_ref=source_ref,
                source_strength=0.8,
            )

            # Load embedding config (None if not configured — keyword-only mode)
            embedding_config = _load_embedding_config()

            # Run ingestion pipeline asynchronously (don't block the conversation)
            import asyncio

            asyncio.create_task(
                ingest_hoard(
                    manager,
                    hoard_id,
                    fetch_content=bool(url),
                    generate_summary=True,
                    generate_tags=True,
                    generate_embedding=embedding_config is not None,
                    embedding_config=embedding_config,
                )
            )
        except Exception as e:
            logger.warning(f"[hoard_capture] failed: {e}")
            return f"Error capturing to hoard: {e}"

        return f"Saved to memory: {title}" + (f" ({url})" if url else "")
