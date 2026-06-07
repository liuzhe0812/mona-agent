"""kb_search agent tool: search the knowledge base wiki pages."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema
from mona.kb.search import search_wiki


@tool_parameters(
    tool_parameters_schema(
        query=StringSchema("Search query for knowledge base"),
        count=IntegerSchema(5, description="Number of results (1-10)", minimum=1, maximum=10),
        required=["query"],
    )
)
class KbSearchTool(Tool):
    """Search knowledge base wiki pages and return matching titles and snippets."""

    name = "kb_search"
    description = "搜索知识库 Wiki 页面，返回匹配的页面标题和内容片段"

    _scopes = {"core", "subagent"}

    @property
    def read_only(self) -> bool:
        return True

    async def execute(self, query: str, count: int = 5, **kwargs: Any) -> str:
        project_path = self._resolve_project_path()
        if project_path is None:
            return "No knowledge base project found. Please create a project first."

        results = search_wiki(project_path, query, count=count)

        if not results:
            return f"No results found for: {query}"

        lines = [f"Knowledge base search results for: {query}\n"]
        for i, item in enumerate(results, 1):
            lines.append(f"{i}. [{item['type']}] {item['title']}")
            lines.append(f"   Path: {item['path']}")
            if item["tags"]:
                lines.append(f"   Tags: {', '.join(item['tags'])}")
            if item["snippet"]:
                lines.append(f"   {item['snippet']}")
            lines.append("")

        return "\n".join(lines)

    @staticmethod
    def _resolve_project_path() -> Path | None:
        """Resolve the first available KB project path."""
        kb_root = Path.home() / "MonaKB"
        if not kb_root.exists():
            return None

        for child in sorted(kb_root.iterdir()):
            if child.is_dir() and (child / "wiki").exists():
                return child

        return None
