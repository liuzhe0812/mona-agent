"""Offline acceptance gates for academic evidence and map delivery.

These tests exercise real local parsing and the persisted ledger.  They do not
pretend that a model response or an unfinished ``academic.py`` tool call is a
black-box pass.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pypdf import PdfReader

from mona.academic.models import (
    EvidenceClaim,
    KnowledgeEdge,
    KnowledgeMap,
    KnowledgeNode,
    SourceRecord,
)
from mona.academic.store import ResearchRecordStore
from mona.agent.tools.context import ToolContext
from mona.agent.tools.document import DocumentTool
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry
from mona.session.manager import SessionManager

FIXTURE_ROOT = Path(__file__).parents[1] / "fixtures" / "academic_research"
PDF_PATH = FIXTURE_ROOT / "papers" / "synthetic-paper.pdf"
AGENT_MANIFEST = (
    Path(__file__).parents[2]
    / "expert-library"
    / "agents"
    / "com.mona.academic-researcher"
    / "agent.json"
)


def _fixture_manifest() -> dict:
    return json.loads((FIXTURE_ROOT / "manifest.json").read_text(encoding="utf-8"))


def _source() -> SourceRecord:
    return SourceRecord(
        source_id="src-pdf-1",
        title="Synthetic PDF paper",
        source_type="paper",
        provider="fixture",
        url="https://example.invalid/synthetic-paper.pdf",
        retrieved_at="2026-08-22T00:00:00Z",
    )


def _claim() -> EvidenceClaim:
    return EvidenceClaim(
        claim_id="claim-pdf-result",
        claim_type="fact",
        claim_text="Both runs report accuracy 0.75.",
        source_ids=["src-pdf-1"],
        evidence_text="Results: Both runs report accuracy 0.75.",
        locator={"kind": "page", "value": "2"},
    )


def test_synthetic_pdf_fixture_is_hash_pinned_and_readable() -> None:
    assert PDF_PATH.is_file()
    expected = _fixture_manifest()["hashes"]["papers/synthetic-paper.pdf"]
    actual = hashlib.sha256(PDF_PATH.read_bytes()).hexdigest()
    assert actual == expected


def test_fixed_pdf_set_is_reproducible_and_contains_page_labels() -> None:
    manifest = _fixture_manifest()
    for relative_path in manifest["papers"]["pdfs"]:
        path = FIXTURE_ROOT / relative_path
        assert path.is_file(), relative_path
        expected = manifest["hashes"][relative_path]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == expected
        reader = PdfReader(str(path))
        assert len(reader.pages) >= 2
        text = "\n".join(page.extract_text() or "" for page in reader.pages)
        assert "Page 1 of" in text


@pytest.mark.asyncio
async def test_existing_document_tool_extracts_pdf_pages_table_and_figure() -> None:
    repo_root = FIXTURE_ROOT.parents[2]
    result = await DocumentTool(workspace=repo_root, restrict_to_workspace=True).execute(
        "tests/fixtures/academic_research/papers/synthetic-paper.pdf"
    )
    assert "<!-- Page 1 -->" in result
    assert "<!-- Page 2 -->" in result
    assert "<!-- Page 3 -->" in result
    assert "Research question: Does a fixed seed" in result
    assert "Table 1: Evaluation metrics" in result
    assert "Accuracy     0.750          0.875" in result
    assert "Figure 1: The candidate metric" in result
    assert "Page 2 of 3" in result


@pytest.mark.asyncio
async def test_unreadable_pdf_is_an_explicit_failure_not_evidence(tmp_path: Path) -> None:
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"not a PDF")
    result = await DocumentTool(workspace=tmp_path).execute(str(broken))
    assert result.startswith("Error parsing broken.pdf")
    assert "accuracy" not in result.lower()


def test_pdf_agent_allowlist_registers_document_tool() -> None:
    manifest = json.loads(AGENT_MANIFEST.read_text(encoding="utf-8"))
    assert "document" in set(manifest["toolAllowlist"])
    ctx = ToolContext(
        config=SimpleNamespace(
            document=SimpleNamespace(enable=True, restrict_to_workspace=False),
            restrict_to_workspace=False,
        ),
        workspace=str(FIXTURE_ROOT.parent.parent),
        sessions=SessionManager(FIXTURE_ROOT.parent.parent / "sessions"),
        agent_id=manifest["id"],
    )
    registered = set(
        ToolLoader(test_classes=[DocumentTool]).load(
            ctx,
            ToolRegistry(),
            scope="subagent",
            tool_allowlist=manifest["toolAllowlist"],
        )
    )
    assert "document" in registered


def test_map_delivery_is_source_and_claim_traceable(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("map-acceptance", "Map acceptance")
    store.source_upsert("map-acceptance", _source())
    store.claim_append("map-acceptance", _claim())
    knowledge_map = store.map_write(
        "map-acceptance",
        KnowledgeMap(
            nodes=[
                KnowledgeNode(
                    node_id="paper-1",
                    node_type="paper",
                    label="Synthetic PDF paper",
                    source_ids=["src-pdf-1"],
                    claim_ids=["claim-pdf-result"],
                ),
                KnowledgeNode(
                    node_id="method-1",
                    node_type="method",
                    label="Fixed seed",
                ),
            ],
            edges=[
                KnowledgeEdge(
                    edge_id="edge-1",
                    source_node_id="paper-1",
                    target_node_id="method-1",
                    relation="uses",
                    source_ids=["src-pdf-1"],
                    claim_ids=["claim-pdf-result"],
                )
            ],
        ),
    )
    assert len(knowledge_map.nodes) == 2
    assert len(knowledge_map.edges) == 1
    payload = json.loads(
        (tmp_path / "research" / "map-acceptance" / "knowledge_map.json").read_text(
            encoding="utf-8"
        )
    )
    markdown = (
        tmp_path / "research" / "map-acceptance" / "knowledge_map.md"
    ).read_text(encoding="utf-8")
    assert len(payload["nodes"]) == markdown.count('["')
    assert len(payload["edges"]) == markdown.count(" -->|")
    assert "src-pdf-1" in markdown
    assert "claim-pdf-result" in markdown
    assert store.validate("map-acceptance")["valid"] is True


def test_large_map_is_split_into_previewable_mermaid_blocks(tmp_path: Path) -> None:
    store = ResearchRecordStore(tmp_path)
    store.init("map-large", "Large map acceptance")
    store.source_upsert("map-large", _source())
    nodes = [
        KnowledgeNode(
            node_id=f"concept-{index}",
            node_type="concept",
            label=f"Concept {index}",
            source_ids=["src-pdf-1"],
        )
        for index in range(61)
    ]
    edges = [
        KnowledgeEdge(
            edge_id=f"edge-{index}",
            source_node_id=f"concept-{index}",
            target_node_id=f"concept-{index + 1}",
            relation="extends",
            source_ids=["src-pdf-1"],
        )
        for index in range(60)
    ]
    store.map_write("map-large", KnowledgeMap(nodes=nodes, edges=edges))
    markdown = (
        tmp_path / "research" / "map-large" / "knowledge_map.md"
    ).read_text(encoding="utf-8")
    assert markdown.count("```mermaid") == 2
    assert markdown.count(" -->|") == 60
    assert markdown.count('["') == 61
