from __future__ import annotations

import json
import re
from datetime import UTC, datetime

from loguru import logger

from mona.knowledge.models import (
    Claim,
    GraphEdge,
    GraphNode,
    KnowledgeGraph,
    NodeKind,
    RelationType,
    SourceManifest,
    WikiPage,
)
from mona.knowledge.store import VaultStore


class SourceCompiler:
    """Compiles raw sources into wiki pages and graph nodes using LLM."""

    def __init__(self, store: VaultStore) -> None:
        self.store = store

    def compile_source(
        self, manifest: SourceManifest, llm_generate: callable
    ) -> tuple[WikiPage, GraphNode] | None:
        """Compile a single source into wiki page and graph node."""
        text = manifest.extracted_text or ""
        if not text.strip():
            logger.warning("No extracted text for {}", manifest.id)
            return None

        prompt = _build_compile_prompt(manifest.title, text)
        try:
            response = llm_generate(prompt)
            parsed = _parse_compile_response(response)
        except Exception as e:
            logger.warning("LLM compile failed for {}: {}", manifest.id, e)
            parsed = _fallback_parsing(manifest, text)

        content = _build_wiki_content(parsed, manifest)
        page = WikiPage(
            title=parsed.get("title", manifest.title),
            kind=NodeKind.SOURCE,
            source_ids=[manifest.id],
            tags=parsed.get("tags", []),
            content=content,
        )
        page_path = f"sources/{manifest.id}.md"
        self.store.write_wiki_page(page, page_path)

        claims = [
            Claim(text=c["text"], confidence=c.get("confidence", 0.8), source_id=manifest.id)
            for c in parsed.get("claims", [])
        ]
        node = GraphNode(
            id=f"source:{manifest.id}",
            kind=NodeKind.SOURCE,
            title=page.title,
            page_path=page_path,
            claims=claims,
            source_ids=[manifest.id],
            tags=page.tags,
        )

        logger.info("Compiled source: {} -> {}", manifest.id, page_path)
        return page, node

    def update_graph_with_source(
        self,
        graph: KnowledgeGraph,
        source_node: GraphNode,
        parsed: dict,
    ) -> None:
        """Update graph with concepts and entities from compiled source."""
        graph.add_node(source_node)

        for concept_name in parsed.get("concepts", []):
            concept_id = _slugify(concept_name)
            node_id = f"concept:{concept_id}"
            if node_id not in graph.nodes:
                concept_page = WikiPage(
                    title=concept_name,
                    kind=NodeKind.CONCEPT,
                    content=f"# {concept_name}\n\n待补充概念定义。\n",
                )
                self.store.write_wiki_page(concept_page, f"concepts/{concept_id}.md")
                graph.add_node(GraphNode(
                    id=node_id,
                    kind=NodeKind.CONCEPT,
                    title=concept_name,
                    page_path=f"concepts/{concept_id}.md",
                ))
            graph.add_edge(GraphEdge(
                source=source_node.id,
                target=node_id,
                relation=RelationType.MENTIONS,
            ))

        for entity_name in parsed.get("entities", []):
            entity_id = _slugify(entity_name)
            node_id = f"entity:{entity_id}"
            if node_id not in graph.nodes:
                entity_page = WikiPage(
                    title=entity_name,
                    kind=NodeKind.ENTITY,
                    content=f"# {entity_name}\n\n待补充实体信息。\n",
                )
                self.store.write_wiki_page(entity_page, f"entities/{entity_id}.md")
                graph.add_node(GraphNode(
                    id=node_id,
                    kind=NodeKind.ENTITY,
                    title=entity_name,
                    page_path=f"entities/{entity_id}.md",
                ))
            graph.add_edge(GraphEdge(
                source=source_node.id,
                target=node_id,
                relation=RelationType.MENTIONS,
            ))

    def compile_pending(
        self, llm_generate: callable, max_sources: int = 10
    ) -> int:
        """Compile all pending sources. Returns count compiled."""
        meta = self.store.load_meta()
        graph = self.store.load_graph()
        compiled = 0

        pending = meta.pending_sources[:max_sources]
        for source_id in pending:
            manifest = self.store.load_manifest(source_id)
            if not manifest:
                continue

            result = self.compile_source(manifest, llm_generate)
            if not result:
                continue

            page, node = result
            parsed = {"concepts": [], "entities": [], "claims": []}
            try:
                prompt = _build_compile_prompt(manifest.title, manifest.extracted_text or "")
                response = llm_generate(prompt)
                parsed = _parse_compile_response(response)
            except Exception:
                pass

            self.update_graph_with_source(graph, node, parsed)
            compiled += 1

        meta.pending_sources = [s for s in meta.pending_sources if s not in pending[:compiled]]
        meta.page_count = len(self.store.list_wiki_pages())
        meta.node_count = len(graph.nodes)
        meta.edge_count = len(graph.edges)
        meta.updated_at = datetime.now(UTC)
        self.store.save_meta(meta)
        self.store.save_graph(graph)

        all_pages = [
            self.store.read_wiki_page(p)
            for p in self.store.list_wiki_pages()
        ]
        self.store.update_index([p for p in all_pages if p])

        logger.info("Compiled {} sources, graph now has {} nodes, {} edges",
                    compiled, len(graph.nodes), len(graph.edges))
        return compiled


def _build_compile_prompt(title: str, text: str) -> str:
    truncated = text[:8000] if len(text) > 8000 else text
    return f"""Analyze the following document and extract structured information.

Document title: {title}

Document content:
{truncated}

Please respond with a JSON object in this exact format:
{{
  "title": "A concise title for this document",
  "summary": "A 2-3 sentence summary of the main points",
  "claims": [
    {{"text": "A specific claim made in the document", "confidence": 0.9}}
  ],
  "concepts": ["concept1", "concept2"],
  "entities": ["entity1", "entity2"],
  "tags": ["tag1", "tag2"]
}}

Extract 3-7 key claims, 2-5 concepts, and 2-5 named entities."""


def _parse_compile_response(response: str) -> dict:
    text = response.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if match:
            return json.loads(match.group())
        raise


def _fallback_parsing(manifest: SourceManifest, text: str) -> dict:
    lines = text.splitlines()
    title = manifest.title
    summary = lines[0][:200] if lines else ""
    return {
        "title": title,
        "summary": summary,
        "claims": [],
        "concepts": [],
        "entities": [],
        "tags": [],
    }


def _build_wiki_content(parsed: dict, manifest: SourceManifest) -> str:
    lines = [
        f"# {parsed.get('title', manifest.title)}",
        "",
        "## 摘要",
        "",
        parsed.get("summary", ""),
        "",
        "## 关键声明",
        "",
    ]
    for claim in parsed.get("claims", []):
        lines.append(f"- {claim['text']}")
    lines.extend(["", "## 相关概念", ""])
    for concept in parsed.get("concepts", []):
        lines.append(f"- [[{concept}]]")
    lines.extend(["", "## 相关实体", ""])
    for entity in parsed.get("entities", []):
        lines.append(f"- [[{entity}]]")
    lines.extend(["", "## 来源", "", f"- 原始文件: `{manifest.origin_path}`"])
    return "\n".join(lines)


def _slugify(text: str) -> str:
    return re.sub(r"[^\w\s-]", "", text).strip().lower().replace(" ", "-")
