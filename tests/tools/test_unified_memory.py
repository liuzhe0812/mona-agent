from __future__ import annotations

import json
from importlib.resources import files as pkg_files
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import mona.agent.agent_management as agent_management
import mona.agent.tools.knowledge_search as knowledge_search
import mona.agent.tools.notes as notes
import mona.config.paths as paths
from mona.agent.partners import AgentDefinition
from mona.agent.tools.context import ToolContext
from mona.agent.tools.conversation_history import ConversationReadTool, ConversationSearchTool
from mona.agent.tools.knowledge_search import (
    KnowledgeReadTool,
    KnowledgeSearchTool,
    NotesSearchTool,
)
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.memory_tools import MemoryReadTool, MemorySearchTool
from mona.agent.tools.notes import NotesReadTool
from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.unified_memory import ReadMemoryTool, SearchMemoryTool
from mona.config.schema import ToolsConfig


@pytest.fixture
def make_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    monkeypatch.setattr(agent_management, "get_agent_memory_dir", paths.get_agent_memory_dir)
    monkeypatch.setattr(agent_management, "get_workspace_path", lambda: tmp_path)
    monkeypatch.setattr(ToolLoader, "_discover_plugins", lambda self: {})

    def make(agent_id: str = "mona", workspace: Path = tmp_path) -> ToolRegistry:
        registry = ToolRegistry()
        context = ToolContext(
            config=ToolsConfig(), workspace=str(workspace), agent_id=agent_id,
            sessions=MagicMock(),
        )
        ToolLoader(test_classes=[
            SearchMemoryTool, ReadMemoryTool, NotesSearchTool, NotesReadTool,
            KnowledgeSearchTool, KnowledgeReadTool, ConversationSearchTool,
            ConversationReadTool, MemoryReadTool, MemorySearchTool,
        ]).load(context, registry, scope="core")
        return registry

    return make


@pytest.fixture
def notes_io(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def invoke(command: str, args: dict | None = None):
        if command == "notes_search_all":
            return [{"noteId": "note-1", "title": "Meeting", "snippet": "search match"}]
        if command == "notes_vault_get_path":
            return str(tmp_path)
        if command == "notes_read_note_content" and args == {"noteId": "note-1"}:
            return {"title": "Meeting", "contentMarkdown": "Private meeting note", "contextLevel": "full"}
        raise AssertionError(f"Unexpected notes request: {command}")

    monkeypatch.setattr(knowledge_search, "_vault_ready", lambda: True)
    monkeypatch.setattr(knowledge_search, "tauri_invoke_async", invoke)
    monkeypatch.setattr(notes, "tauri_invoke_async", invoke)


async def _search(registry: ToolRegistry, query: str, **kwargs) -> dict:
    return json.loads(await registry.execute("search_memory", {"query": query, **kwargs}))


async def _read(registry: ToolRegistry, ref: str, **kwargs) -> dict:
    return json.loads(await registry.execute("read_memory", {"ref": ref, **kwargs}))


@pytest.mark.asyncio
async def test_unified_visibility_preserves_source_permissions_and_dream_memory(
    make_registry, tmp_path: Path,
) -> None:
    registry = make_registry()
    names = {schema["function"]["name"] for schema in registry.get_definitions()}
    assert names == {"search_memory", "read_memory"}
    assert "search_memory" in await registry.execute("notes_search", {"query": "x"})

    catalog = agent_management.agent_tool_catalog(
        AgentDefinition(id="mona", display_name="Mona", prompt=""),
        workspace=tmp_path, runtime_registry=registry, sessions=MagicMock(),
    )
    by_name = {item["name"]: item for item in catalog}
    assert {"notes_search", "notes_read", "knowledge_search", "knowledge_read"} <= by_name.keys()
    assert by_name["notes_search"]["systemManaged"] is False
    assert by_name["search_memory"]["systemManaged"] is True

    (paths.get_agent_memory_dir("mona") / "MEMORY.md").write_text("Dream memory", encoding="utf-8")
    dream_registry = ToolRegistry()
    dream_registry.register(MemoryReadTool("mona"))
    assert await dream_registry.execute("memory_read", {"file": "memory"}) == "Dream memory"


@pytest.mark.asyncio
async def test_notes_reference_respects_revoked_source_permission(make_registry, notes_io) -> None:
    registry = make_registry()
    result = await _search(registry, "meeting", sources=["notes"])
    assert result["status"] == "ok"
    ref = result["results"][0]["ref"]
    assert (await _read(registry, ref))["content"] == "Private meeting note"

    registry.set_allowed_tool_names({"search_memory", "read_memory", "notes_search"})
    denied = await _read(registry, ref)
    assert denied["status"] == "unavailable"
    assert "Private meeting note" not in json.dumps(denied)
    assert (await _search(registry, "meeting", sources=["notes"]))["sources"]["notes"]["status"] == "not_authorized"


@pytest.mark.asyncio
async def test_references_do_not_cross_agent_registry_or_workspace(
    make_registry, notes_io, tmp_path: Path,
) -> None:
    registry = make_registry()
    other_agent = make_registry(agent_id="other-agent")
    ref = (await _search(registry, "meeting", sources=["notes"]))["results"][0]["ref"]
    assert (await _read(other_agent, ref))["status"] == "unavailable"

    token = set_current_workspace(tmp_path / "other-workspace")
    try:
        assert (await _read(registry, ref))["status"] == "unavailable"
    finally:
        reset_current_workspace(token)
    assert (await _read(registry, ref))["content"] == "Private meeting note"


@pytest.mark.asyncio
async def test_search_reports_partial_coverage_and_one_source_failure(
    make_registry, notes_io, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()

    async def failed_knowledge(*_args, **_kwargs):
        raise RuntimeError("index unavailable")

    monkeypatch.setattr(registry.get("knowledge_search"), "search_results", failed_knowledge)
    monkeypatch.setattr(registry.get("conversation_search")._store, "search", lambda *_args, **_kwargs: {
        "status": "partial", "coverage": {"missing_sessions": 1}, "results": [], "next_cursor": None,
    })
    result = await _search(registry, "meeting", sources=["notes", "knowledge", "conversations"])
    assert result["status"] == "partial"
    assert [item["source"] for item in result["results"]] == ["notes"]
    assert result["sources"]["knowledge"]["status"] == "unavailable"
    assert result["sources"]["conversations"]["status"] == "partial"
    assert result["sources"]["conversations"]["coverage"]["missing_sessions"] == 1


@pytest.mark.asyncio
async def test_conversation_reference_reads_original_with_default_cursor_and_source_limit(
    make_registry, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()
    monkeypatch.setattr(registry.get("conversation_search")._store, "search", lambda *_args, **_kwargs: {
        "status": "ok", "coverage": {}, "results": [{"ref": "conv:one", "preview": "earlier words"}],
        "next_cursor": None,
    })
    calls = []

    def read(ref: str, **kwargs):
        calls.append((ref, kwargs))
        return {"status": "ok", "text": "Original user and assistant exchange", "next_cursor": None}

    monkeypatch.setattr(registry.get("conversation_read")._store, "read", read)
    ref = (await _search(registry, "earlier", sources=["conversations"]))["results"][0]["ref"]
    result = await _read(registry, ref, max_chars=50000)
    assert result["status"] == "ok"
    assert result["text"] == "Original user and assistant exchange"
    assert calls[0][0] == "conv:one"
    assert calls[0][1]["cursor"] is None
    assert calls[0][1]["max_chars"] == 16000


@pytest.mark.asyncio
async def test_events_require_explicit_search_and_stale_refs_fail(make_registry) -> None:
    registry = make_registry()
    registry.set_allowed_tool_names({"search_memory", "read_memory", "memory_read", "memory_search"})
    history = paths.get_agent_memory_dir("mona") / "history.jsonl"
    content = "legacy project outcome " + "more evidence " * 80
    history.write_text(json.dumps({"content": content}) + "\n", encoding="utf-8")

    default = await _search(registry, "legacy project outcome")
    assert "events" not in default["sources"]
    assert not default["results"]
    explicit = await _search(registry, "legacy project outcome", sources=["events"])
    assert explicit["status"] == "ok"
    ref = explicit["results"][0]["ref"]
    result = await _read(registry, ref)
    assert result["content"] == content
    assert result["kind"] == "event_summary"

    history.write_text("", encoding="utf-8")
    assert (await _read(registry, ref))["status"] == "unavailable"


@pytest.mark.asyncio
async def test_default_memory_template_is_not_a_search_result(make_registry) -> None:
    registry = make_registry()
    template = pkg_files("mona") / "templates" / "memory" / "MEMORY.md"
    (paths.get_agent_memory_dir("mona") / "MEMORY.md").write_text(
        template.read_text(encoding="utf-8"), encoding="utf-8",
    )
    result = await _search(registry, "automatically", sources=["memory"])
    assert result["status"] == "ok"
    assert result["results"] == []


@pytest.mark.asyncio
async def test_notes_invalid_read_response_is_not_successful_content(
    make_registry, notes_io, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()
    ref = (await _search(registry, "meeting", sources=["notes"]))["results"][0]["ref"]

    async def invalid_response(command: str, args=None):
        return "vault" if command == "notes_vault_get_path" else []

    monkeypatch.setattr(notes, "tauri_invoke_async", invalid_response)
    result = await _read(registry, ref)
    assert result["status"] == "unavailable"
    assert "content" not in result


@pytest.mark.asyncio
async def test_knowledge_read_preserves_original_evidence_and_citation(
    make_registry, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()
    citation = "[Report, Page 3](mona:material?agentId=mona&path=raw%2Freport.pdf&location=Page%203)"
    evidence = "Original document evidence\n引用链接（在回答中原样使用）: " + citation

    async def search(*_args):
        return [{"ref": "ak:report:3", "kind": "material_source", "title": "Report", "locationLabel": "Page 3"}]

    async def read(**params):
        assert params["ref"] == "ak:report:3"
        return {"content": evidence, "references": [{"ref": "ak:report:4", "title": "Report", "location": "Page 4"}]}

    monkeypatch.setattr(registry.get("knowledge_search"), "search_results", search)
    monkeypatch.setattr(registry.get("knowledge_read"), "read_result", read)
    result = await _search(registry, "report", sources=["knowledge"])
    assert result["results"][0]["kind"] == "document"
    read_result = await _read(registry, result["results"][0]["ref"])
    assert read_result["content"] == evidence
    linked_ref = read_result["references"][0]["ref"]

    async def read_link(**params):
        assert params["ref"] == "ak:report:4"
        return {"content": "More original evidence", "references": []}

    monkeypatch.setattr(registry.get("knowledge_read"), "read_result", read_link)
    assert (await _read(registry, linked_ref))["content"] == "More original evidence"


@pytest.mark.asyncio
async def test_note_pagination_keeps_complete_text_and_rejects_changed_source(
    make_registry, notes_io, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()
    ref = (await _search(registry, "meeting", sources=["notes"]))["results"][0]["ref"]
    content = "first page " * 100 + "last page " * 100

    async def read_note(_note_id):
        return {"title": "Meeting", "contentMarkdown": content, "contextLevel": "full"}

    monkeypatch.setattr(registry.get("notes_read"), "read_result", read_note)
    first = await _read(registry, ref, max_chars=1000)
    assert first["truncated"] is True
    second = await _read(registry, ref, max_chars=50000, cursor=first["next_cursor"])
    assert first["content"] + second["content"] == content
    content += " updated"
    stale = await _read(registry, ref, cursor=first["next_cursor"])
    assert stale["status"] == "unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize("source", ["notes", "memory", "events"])
async def test_error_prefix_is_ordinary_content(
    make_registry, notes_io, monkeypatch: pytest.MonkeyPatch, source: str,
) -> None:
    registry = make_registry()
    content = "Error handling rules are part of this document."
    if source == "notes":
        async def read_note(_note_id):
            return {"title": "Rules", "contentMarkdown": content, "contextLevel": "full"}
        monkeypatch.setattr(registry.get("notes_read"), "read_result", read_note)
    elif source == "memory":
        (paths.get_agent_memory_dir("mona") / "MEMORY.md").write_text(content, encoding="utf-8")
    else:
        (paths.get_agent_memory_dir("mona") / "history.jsonl").write_text(json.dumps({"content": content}) + "\n", encoding="utf-8")
    result = await _search(registry, "Error handling", sources=[source])
    assert result["status"] == "ok"
    assert (await _read(registry, result["results"][0]["ref"]))["content"] == content


@pytest.mark.asyncio
async def test_conversation_continuation_is_bound_to_reference_and_window(
    make_registry, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()
    monkeypatch.setattr(registry.get("conversation_search")._store, "search", lambda query, **_kwargs: {
        "status": "ok", "results": [{"ref": "conv:" + query}],
    })
    calls = []

    def read(ref: str, **kwargs):
        calls.append((ref, kwargs))
        return {"status": "ok", "text": "Original exchange", "next_cursor": "read:1000"}

    monkeypatch.setattr(registry.get("conversation_read")._store, "read", read)
    first_ref = (await _search(registry, "first", sources=["conversations"]))["results"][0]["ref"]
    second_ref = (await _search(registry, "second", sources=["conversations"]))["results"][0]["ref"]
    first = await _read(registry, first_ref)
    assert (await _read(registry, second_ref, cursor=first["next_cursor"]))["status"] == "unavailable"
    assert (await _read(registry, first_ref, cursor=first["next_cursor"], before=1))["status"] == "unavailable"
    assert len(calls) == 1
    assert (await _read(registry, first_ref, cursor=first["next_cursor"]))["status"] == "ok"
    assert calls[-1][1]["cursor"] == "read:1000"


@pytest.mark.asyncio
async def test_mixed_language_search_falls_back_to_terms_and_deduplicates_refs(
    make_registry, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()
    registry.set_allowed_tool_names({"search_memory", "read_memory", "knowledge_search", "knowledge_read"})
    query = "favorite color 喜欢的颜色"
    calls = []
    original = {"ref": "ak:report:1", "kind": "material_source", "title": "Original"}
    wiki = {"ref": "ak:wiki:1", "kind": "material_wiki", "title": "Wiki"}

    async def search(term: str, _limit: int):
        calls.append(term)
        return {
            query: [], "favorite": [original], "color": [original],
            "喜欢的颜色": [original, wiki],
        }[term]

    monkeypatch.setattr(registry.get("knowledge_search"), "search_results", search)
    result = await _search(registry, query)
    assert result["status"] == "ok"
    assert result["match_mode"] == "any_term"
    assert calls == [query, "favorite", "color", "喜欢的颜色"]
    hits = {item["title"]: item for item in result["results"]}
    assert set(hits) == {"Original", "Wiki"}
    assert len(result["results"]) == 2
    assert set(hits["Original"]["matched_terms"]) == {"favorite", "color", "喜欢的颜色"}
    assert hits["Wiki"]["matched_terms"] == ["喜欢的颜色"]


@pytest.mark.asyncio
async def test_original_query_hit_does_not_trigger_fallback(
    make_registry, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()
    registry.set_allowed_tool_names({"search_memory", "read_memory", "knowledge_search", "knowledge_read"})
    query = "favorite color 喜欢的颜色"
    calls = []

    async def search(term: str, _limit: int):
        calls.append(term)
        return [{"ref": "ak:report:1", "kind": "material_source", "title": "Original"}]

    monkeypatch.setattr(registry.get("knowledge_search"), "search_results", search)
    result = await _search(registry, query)
    assert result["status"] == "ok"
    assert len(result["results"]) == 1
    assert calls == [query]


@pytest.mark.asyncio
async def test_fallback_skips_denied_and_failed_sources(
    make_registry, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()
    registry.set_allowed_tool_names({
        "search_memory", "read_memory", "notes_search", "notes_read", "knowledge_search", "knowledge_read",
    })
    query = "favorite color 喜欢的颜色"
    notes_calls = []
    knowledge_calls = []
    conversation_calls = []

    async def search_notes(term: str, _limit: int):
        notes_calls.append(term)
        return [{"noteId": "note-1", "title": "颜色"}] if term == "喜欢的颜色" else []

    async def search_knowledge(term: str, _limit: int):
        knowledge_calls.append(term)
        raise RuntimeError("knowledge index unavailable")

    def search_conversations(*args, **kwargs):
        conversation_calls.append((args, kwargs))
        return {"status": "ok", "results": []}

    monkeypatch.setattr(registry.get("notes_search"), "search_results", search_notes)
    monkeypatch.setattr(registry.get("knowledge_search"), "search_results", search_knowledge)
    monkeypatch.setattr(registry.get("conversation_search")._store, "search", search_conversations)
    result = await _search(registry, query, sources=["notes", "knowledge", "conversations"])
    assert result["status"] == "partial"
    assert result["match_mode"] == "any_term"
    assert [item["title"] for item in result["results"]] == ["颜色"]
    assert notes_calls == [query, "favorite", "color", "喜欢的颜色"]
    assert knowledge_calls == [query]
    assert not conversation_calls
    assert result["sources"]["knowledge"]["status"] == "unavailable"
    assert result["sources"]["conversations"]["status"] == "not_authorized"


@pytest.mark.asyncio
async def test_global_limit_uses_ranked_evidence_and_does_not_skip_omitted_conversations(
    make_registry, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()

    async def knowledge(*_args):
        return [{"ref": "ak:report:1", "kind": "material_source", "title": "Original"}]

    monkeypatch.setattr(registry.get("knowledge_search"), "search_results", knowledge)
    monkeypatch.setattr(registry.get("conversation_search")._store, "search", lambda *_args, **_kwargs: {
        "status": "ok", "results": [{"ref": "conv:one", "role": "assistant", "title": "Earlier reply"}],
        "next_cursor": "search:1",
    })
    result = await _search(registry, "deployment", sources=["conversations", "knowledge"], limit=1)
    assert [item["title"] for item in result["results"]] == ["Original"]
    source = result["sources"]["conversations"]
    assert source["count"] == 1 and source["returned_count"] == 0
    assert source["limited"] is True
    assert "next_cursor" not in source


@pytest.mark.asyncio
async def test_alternative_failure_preserves_primary_evidence_and_reports_partial(
    make_registry, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = make_registry()

    async def search(query: str, _limit: int):
        if query == "deployment":
            return [{"ref": "ak:report:1", "kind": "material_source", "title": "Original"}]
        raise RuntimeError("index unavailable")

    monkeypatch.setattr(registry.get("knowledge_search"), "search_results", search)
    result = await _search(registry, "deployment", sources=["knowledge"], alternatives=["发布"])
    assert result["status"] == "partial"
    assert [item["title"] for item in result["results"]] == ["Original"]
    assert result["sources"]["knowledge"]["error"] == "index unavailable"
