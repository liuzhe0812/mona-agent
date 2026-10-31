from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

import mona.agent.tools.knowledge_search as knowledge_search
import mona.materials.knowledge as knowledge
from mona.agent.tools.context import ToolContext
from mona.agent.tools.knowledge_search import (
    KnowledgeReadTool,
    KnowledgeSearchTool,
    NotesSearchTool,
)
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.notes import NotesReadTool
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.unified_memory import ReadMemoryTool, SearchMemoryTool
from mona.config.schema import ToolsConfig
from mona.utils.document import EXTRACTOR_VERSION


@pytest.fixture
def retrieval_corpus(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    data = tmp_path / "data"
    root = data / "agents" / "mona" / "knowledge"
    for name in ("raw", "text", "wiki", "evidence"):
        (root / name).mkdir(parents=True)

    def write_source(color: str) -> None:
        content = f"小林喜欢的颜色是{color}，平时偏好简洁风格。"
        raw = root / "raw" / "profile.txt"
        raw.write_text(content, encoding="utf-8")
        digest = hashlib.sha256(raw.read_bytes()).hexdigest()
        stat = raw.stat()
        (root / "text" / "profile.txt.md").write_text(
            "---\n"
            "id: material-profile\n"
            "source: profile.txt\n"
            f"sha256: {digest}\n"
            f"size: {stat.st_size}\n"
            f"mtimeNs: {stat.st_mtime_ns}\n"
            f"extractorVersion: {EXTRACTOR_VERSION}\n"
            "status: ok\n---\n\n"
            '<!-- seg {"id":"ev-profile","kind":"block","label":"正文"} -->\n'
            f"## 正文\n\n{content}\n",
            encoding="utf-8",
        )
        (root / "evidence" / "material-profile.json").write_text(json.dumps({
            "schemaVersion": 1, "materialId": "material-profile", "source": "profile.txt",
            "sourceHash": digest, "units": [{"id": "ev-profile", "status": "represented"}],
        }), encoding="utf-8")
        (root / "state.json").write_text(json.dumps({
            "schemaVersion": 1, "documents": [{
                "id": "document-profile", "path": "profile.txt", "sha256": digest, "active": True,
            }],
        }), encoding="utf-8")
        (root / "wiki" / "profile.md").write_text(
            "---\nid: wiki-profile\ntitle: 用户画像\nevidenceRefs:\n  - ev-profile\n"
            "materialIds:\n  - material-profile\nsources:\n  - profile.txt\n---\n\n"
            f"小林喜欢的颜色是{color}。\n",
            encoding="utf-8",
        )

    write_source("宝蓝色")
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    monkeypatch.setattr(knowledge_search, "get_data_dir", lambda: data)
    monkeypatch.setattr(knowledge_search, "get_agent_knowledge_dir", lambda _agent: root)
    monkeypatch.setattr(knowledge, "get_data_dir", lambda: data)
    monkeypatch.setattr(ToolLoader, "_discover_plugins", lambda self: {})
    registry = ToolRegistry()
    context = ToolContext(config=ToolsConfig(), workspace=str(tmp_path), agent_id="mona")
    ToolLoader(test_classes=[
        SearchMemoryTool, ReadMemoryTool, KnowledgeSearchTool, KnowledgeReadTool,
        NotesSearchTool, NotesReadTool,
    ]).load(context, registry, scope="core")
    registry.set_allowed_tool_names({"search_memory", "read_memory", "knowledge_search", "knowledge_read"})
    return registry, write_source


async def _search(registry: ToolRegistry, query: str, **kwargs) -> dict:
    return json.loads(await registry.execute("search_memory", {"query": query, **kwargs}))


async def _read(registry: ToolRegistry, ref: str) -> dict:
    return json.loads(await registry.execute("read_memory", {"ref": ref}))


@pytest.mark.asyncio
@pytest.mark.parametrize(("query", "alternatives"), [
    ("喜欢的颜色", []),
    ("喜欢 的 颜色", []),
    ("喜欢，的颜色", []),
    ("favorite color 喜欢的颜色", []),
    ("我喜欢什么颜色", ["喜欢的颜色", "颜色偏好"]),
])
async def test_representative_queries_recall_source_in_top_three_and_read_it(
    retrieval_corpus, query: str, alternatives: list[str],
) -> None:
    registry, _write_source = retrieval_corpus
    kwargs = {"alternatives": alternatives} if alternatives else {}
    result = await _search(registry, query, sources=["knowledge"], limit=3, **kwargs)
    assert result["status"] == "ok"
    assert len(result["results"]) <= 3
    document = next(
        item for item in result["results"]
        if item["source"] == "knowledge" and item["kind"] == "document"
    )
    assert document["title"] == "profile.txt"
    assert document["matched_queries"]
    assert document["match_mode"]
    source = await _read(registry, document["ref"])
    assert source["status"] == "ok"
    assert "小林喜欢的颜色是宝蓝色" in source["content"]
    assert "mona:material?" in source["content"]


@pytest.mark.asyncio
async def test_source_precedes_wiki_for_same_match(retrieval_corpus) -> None:
    registry, _write_source = retrieval_corpus
    result = await _search(registry, "喜欢的颜色", sources=["knowledge"], limit=3)
    assert [item["kind"] for item in result["results"][:2]] == ["document", "summary"]


@pytest.mark.asyncio
async def test_notes_hit_does_not_block_knowledge_alternative(
    retrieval_corpus, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry, _write_source = retrieval_corpus
    registry.set_allowed_tool_names({
        "search_memory", "read_memory", "knowledge_search", "knowledge_read", "notes_search", "notes_read",
    })
    query = "我喜欢什么颜色"

    async def search_notes(text: str, _limit: int):
        return [{"noteId": "note-noise", "title": "无关的颜色笔记", "snippet": "油漆调色"}] if text == query else []

    monkeypatch.setattr(registry.get("notes_search"), "search_results", search_notes)
    result = await _search(registry, query, alternatives=["喜欢的颜色"], limit=3)
    assert result["status"] == "ok"
    assert len(result["results"]) <= 3
    assert any(item["source"] == "notes" for item in result["results"])
    document = next(
        item for item in result["results"]
        if item["source"] == "knowledge" and item["kind"] == "document"
    )
    assert "宝蓝色" in (await _read(registry, document["ref"]))["content"]
    assert result["sources"]["knowledge"]["count"] >= 1
    assert result["sources"]["knowledge"]["returned_count"] >= 1


@pytest.mark.asyncio
@pytest.mark.parametrize("query", ["护照号码", "火星 国籍"])
async def test_missing_facts_have_no_false_match(retrieval_corpus, query: str) -> None:
    registry, _write_source = retrieval_corpus
    result = await _search(registry, query, sources=["knowledge"], limit=3)
    assert result["status"] == "ok"
    assert result["results"] == []


@pytest.mark.asyncio
async def test_source_update_is_readable_and_revoked_access_is_enforced(retrieval_corpus) -> None:
    registry, write_source = retrieval_corpus
    original = await _search(registry, "喜欢的颜色", sources=["knowledge"], limit=3)
    ref = next(item["ref"] for item in original["results"] if item["kind"] == "document")
    assert "宝蓝色" in (await _read(registry, ref))["content"]

    write_source("靛蓝色")
    updated = await _search(registry, "喜欢的颜色", sources=["knowledge"], limit=3)
    new_ref = next(item["ref"] for item in updated["results"] if item["kind"] == "document")
    content = (await _read(registry, new_ref))["content"]
    assert "靛蓝色" in content and "宝蓝色" not in content
    previous = await _read(registry, ref)
    assert previous["status"] == "unavailable" or "宝蓝色" not in previous["content"]

    registry.set_allowed_tool_names({"search_memory", "read_memory", "knowledge_search"})
    denied = await _read(registry, new_ref)
    assert denied["status"] == "unavailable"
    assert "靛蓝色" not in json.dumps(denied, ensure_ascii=False)
