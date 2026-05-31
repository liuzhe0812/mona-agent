from __future__ import annotations

from mona.knowledge.indexer import WikiIndexer
from mona.knowledge.models import KnowledgeGraph
from mona.knowledge.store import VaultStore


class VaultQuery:
    """Query engine for vault: FTS5 search + graph traversal."""

    def __init__(self, store: VaultStore, indexer: WikiIndexer, graph: KnowledgeGraph) -> None:
        self.store = store
        self.indexer = indexer
        self.graph = graph

    def search(self, query: str, limit: int = 10) -> list[dict]:
        """Full-text search across wiki pages."""
        return self.indexer.search(query, limit)

    def get_page(self, path: str) -> dict | None:
        """Get a wiki page by path."""
        page = self.store.read_wiki_page(path)
        if not page:
            return None
        return {
            "path": path,
            "title": page.title,
            "kind": page.kind.value,
            "content": page.content,
            "tags": page.tags,
        }

    def get_node(self, node_id: str) -> dict | None:
        """Get a graph node by ID."""
        node = self.graph.nodes.get(node_id)
        if not node:
            return None
        outgoing, incoming = self.graph.get_node_edges(node_id)
        return {
            "id": node.id,
            "kind": node.kind.value,
            "title": node.title,
            "page_path": node.page_path,
            "claims": [
                {"text": c.text, "confidence": c.confidence, "polarity": c.polarity.value}
                for c in node.claims
            ],
            "tags": node.tags,
            "freshness": node.freshness.value,
            "outgoing": [
                {"target": e.target, "relation": e.relation.value, "evidence": e.evidence.value}
                for e in outgoing
            ],
            "incoming": [
                {"source": e.source, "relation": e.relation.value, "evidence": e.evidence.value}
                for e in incoming
            ],
        }

    def get_graph_overview(self) -> dict:
        """Get high-level graph statistics."""
        kind_counts: dict[str, int] = {}
        for node in self.graph.nodes.values():
            kind_counts[node.kind.value] = kind_counts.get(node.kind.value, 0) + 1

        relation_counts: dict[str, int] = {}
        for edge in self.graph.edges:
            relation_counts[edge.relation.value] = relation_counts.get(edge.relation.value, 0) + 1

        return {
            "node_count": len(self.graph.nodes),
            "edge_count": len(self.graph.edges),
            "kind_counts": kind_counts,
            "relation_counts": relation_counts,
            "nodes": [
                {"id": n.id, "kind": n.kind.value, "title": n.title}
                for n in self.graph.nodes.values()
            ],
            "edges": [
                {"source": e.source, "target": e.target, "relation": e.relation.value}
                for e in self.graph.edges
            ],
        }

    def get_related(self, node_id: str) -> list[dict]:
        """Get nodes related to the given node."""
        edges = self.graph.get_neighbors(node_id, "both")
        related_ids = set()
        for edge in edges:
            if edge.source == node_id:
                related_ids.add(edge.target)
            else:
                related_ids.add(edge.source)

        results: list[dict] = []
        for rid in related_ids:
            node = self.graph.nodes.get(rid)
            if node:
                results.append({
                    "id": node.id,
                    "kind": node.kind.value,
                    "title": node.title,
                    "page_path": node.page_path,
                })
        return results
