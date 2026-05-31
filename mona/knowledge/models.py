from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import Field

from mona.config.schema import Base


class SourceKind(StrEnum):
    MARKDOWN = "markdown"
    TEXT = "text"
    CODE = "code"
    PDF = "pdf"
    HTML = "html"
    DOCX = "docx"
    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    BINARY = "binary"


class NodeKind(StrEnum):
    SOURCE = "source"
    CONCEPT = "concept"
    ENTITY = "entity"
    CLAIM = "claim"


class RelationType(StrEnum):
    MENTIONS = "mentions"
    SUPPORTS = "supports"
    CONTRADICTS = "contradicts"
    BUILDS_ON = "builds_on"
    SEMANTICALLY_SIMILAR = "semantically_similar_to"


class EvidenceClass(StrEnum):
    EXTRACTED = "extracted"
    INFERRED = "inferred"
    AMBIGUOUS = "ambiguous"


class Polarity(StrEnum):
    POSITIVE = "positive"
    NEGATIVE = "negative"
    NEUTRAL = "neutral"


class Freshness(StrEnum):
    FRESH = "fresh"
    STALE = "stale"


class PageStatus(StrEnum):
    DRAFT = "draft"
    CANDIDATE = "candidate"
    ACTIVE = "active"
    STALE = "stale"


class Claim(Base):
    text: str
    confidence: float = Field(ge=0.0, le=1.0, default=0.8)
    polarity: Polarity = Polarity.NEUTRAL
    source_id: str


class SourceManifest(Base):
    id: str
    title: str
    origin_path: str
    kind: SourceKind
    content_hash: str
    ingested_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    extracted_text: str | None = None
    word_count: int = 0


class GraphNode(Base):
    id: str
    kind: NodeKind
    title: str
    page_path: str
    claims: list[Claim] = Field(default_factory=list)
    source_ids: list[str] = Field(default_factory=list)
    freshness: Freshness = Freshness.FRESH
    tags: list[str] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class GraphEdge(Base):
    source: str
    target: str
    relation: RelationType
    evidence: EvidenceClass = EvidenceClass.EXTRACTED


class KnowledgeGraph(Base):
    nodes: dict[str, GraphNode] = Field(default_factory=dict)
    edges: list[GraphEdge] = Field(default_factory=list)
    version: str = "1.0"

    def add_node(self, node: GraphNode) -> None:
        self.nodes[node.id] = node

    def add_edge(self, edge: GraphEdge) -> None:
        self.edges.append(edge)

    def get_neighbors(
        self, node_id: str, direction: Literal["out", "in", "both"] = "both"
    ) -> list[GraphEdge]:
        result: list[GraphEdge] = []
        for edge in self.edges:
            if direction in ("out", "both") and edge.source == node_id:
                result.append(edge)
            if direction in ("in", "both") and edge.target == node_id:
                result.append(edge)
        return result

    def get_node_edges(self, node_id: str) -> tuple[list[GraphEdge], list[GraphEdge]]:
        outgoing = [e for e in self.edges if e.source == node_id]
        incoming = [e for e in self.edges if e.target == node_id]
        return outgoing, incoming


class WikiPage(Base):
    title: str
    kind: NodeKind
    source_ids: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    compiled_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    status: PageStatus = PageStatus.ACTIVE
    content: str = ""

    def to_markdown(self) -> str:
        import yaml

        frontmatter = {
            "title": self.title,
            "kind": self.kind.value,
            "source_ids": self.source_ids,
            "tags": self.tags,
            "compiled_at": self.compiled_at.isoformat(),
            "status": self.status.value,
        }
        fm_yaml = yaml.safe_dump(frontmatter, allow_unicode=True, sort_keys=False)
        return f"---\n{fm_yaml}---\n\n{self.content}\n"

    @classmethod
    def from_markdown(cls, text: str, page_path: str) -> WikiPage:
        import yaml

        if text.startswith("---"):
            parts = text.split("---", 2)
            if len(parts) >= 3:
                try:
                    fm = yaml.safe_load(parts[1])
                    content = parts[2].strip()
                    return cls(
                        title=fm.get("title", Path(page_path).stem),
                        kind=NodeKind(fm.get("kind", "source")),
                        source_ids=fm.get("source_ids", []),
                        tags=fm.get("tags", []),
                        compiled_at=datetime.fromisoformat(fm.get("compiled_at", datetime.now(UTC).isoformat())),
                        status=PageStatus(fm.get("status", "active")),
                        content=content,
                    )
                except Exception:
                    pass
        return cls(
            title=Path(page_path).stem,
            kind=NodeKind.SOURCE,
            content=text,
        )


class VaultMeta(Base):
    name: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    source_count: int = 0
    page_count: int = 0
    node_count: int = 0
    edge_count: int = 0
    pending_sources: list[str] = Field(default_factory=list)
    version: str = "1.0"
