from __future__ import annotations

import asyncio
import json

import pytest

from mona.agent.partners import ConversationMetadata
from mona.agent.tools.context import ToolContext
from mona.agent.tools.conversation_history import (
    ConversationReadTool,
    ConversationSearchTool,
)
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.path_utils import reset_current_workspace, set_current_workspace
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.unified_memory import ReadMemoryTool, SearchMemoryTool
from mona.agent.user_config import REQUIRED_AGENT_TOOLS
from mona.config.paths import get_agent_output_dir
from mona.config.schema import ToolsConfig
from mona.session.manager import Session, SessionManager
from mona.webui.transcript import write_transcript_objects


def _context(tmp_path, *, enabled: bool = True, sessions=True) -> ToolContext:
    config = ToolsConfig()
    config.conversation_history.enabled = enabled
    manager = SessionManager(tmp_path / "workspace") if sessions else None
    return ToolContext(
        config=config,
        workspace=str(tmp_path / "workspace"),
        sessions=manager,
        agent_id="mona",
    )


def test_loader_registers_tools_only_with_enabled_session_context(tmp_path):
    classes = [ConversationSearchTool, ConversationReadTool]
    registry = ToolRegistry()
    registered = ToolLoader(test_classes=classes).load(_context(tmp_path), registry)
    assert set(registered) == {"conversation_search", "conversation_read"}
    assert registry.get("conversation_search").read_only is True
    assert registry.get("conversation_read").system_managed is True

    disabled = ToolRegistry()
    assert ToolLoader(test_classes=classes).load(
        _context(tmp_path, enabled=False), disabled
    ) == []
    missing_sessions = ToolRegistry()
    assert ToolLoader(test_classes=classes).load(
        _context(tmp_path, sessions=False), missing_sessions
    ) == []
    subagent = ToolRegistry()
    assert set(ToolLoader(test_classes=classes).load(
        _context(tmp_path), subagent, scope="subagent"
    )) == {"conversation_search", "conversation_read"}
    isolated_subagent = ToolRegistry()
    assert ToolLoader(test_classes=classes).load(
        _context(tmp_path, sessions=False), isolated_subagent, scope="subagent"
    ) == []
    disabled_partner = ToolRegistry()
    assert ToolLoader(test_classes=classes).load(
        _context(tmp_path, enabled=False), disabled_partner, scope="subagent"
    ) == []


@pytest.mark.asyncio
async def test_search_then_read_tool_returns_original_chat(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    ctx = _context(tmp_path)
    key = "websocket:tool-chat"
    session = Session(
        key=key,
        metadata={
            "conversation": ConversationMetadata.direct("mona").to_session_metadata()
        },
    )
    ctx.sessions.save(session)
    write_transcript_objects(
        key,
        [
            {"event": "user", "text": "记住构建编号 build-2026-09-14"},
            {"event": "message", "text": "已记录。"},
        ],
    )

    search = ConversationSearchTool.create(ctx)
    found = json.loads(await search.execute(query="build-2026-09-14"))
    assert found["status"] == "ok"
    ref = found["results"][0]["ref"]

    read = ConversationReadTool.create(ctx)
    detail = json.loads(await read.execute(ref=ref))
    assert detail["status"] == "ok"
    assert "记住构建编号 build-2026-09-14" in detail["text"]


@pytest.mark.asyncio
async def test_tool_reports_invalid_cursor_without_raising(tmp_path):
    ctx = _context(tmp_path)
    tool = ConversationSearchTool.create(ctx)
    result = json.loads(await tool.execute(query="x", cursor="not-a-cursor"))
    assert result["status"] == "error"
    assert result["error"] == "invalid pagination cursor"


@pytest.mark.asyncio
async def test_partner_memory_search_reads_own_chat_in_current_workspace(tmp_path, monkeypatch):
    monkeypatch.setattr("mona.config.paths.get_data_dir", lambda: tmp_path / "data")
    monkeypatch.setattr(ToolLoader, "_discover_plugins", lambda self: {})
    manager = SessionManager(tmp_path / "workspace")
    agent_id = "com.mona.partner"
    project = tmp_path / "project"
    records = [
        ("websocket:original", agent_id, None, "record 72519 original"),
        ("websocket:copy", agent_id, None, "record 72519 copy"),
        ("websocket:other-agent", "com.mona.other", None, "record 72519 foreign"),
        ("websocket:project", agent_id, project, "record 72519 project"),
    ]
    for key, owner, workspace, content in records:
        conversation = ConversationMetadata.direct(owner, title=owner)
        if key.endswith("copy"):
            conversation.partner_conversation = True
            conversation.partner_conversation_copy = True
        metadata = {"conversation": conversation.to_session_metadata()}
        if workspace is not None:
            metadata["workspace"] = str(workspace)
        manager.save(Session(key=key, metadata=metadata))
        write_transcript_objects(key, [
            {"event": "user", "text": content},
            {"event": "message", "text": f"answer for {content}"},
        ])

    def partner_registry(owner):
        registry = ToolRegistry()
        context = ToolContext(
            config=ToolsConfig(), workspace=str(manager.workspace),
            sessions=manager, agent_id=owner,
        )
        ToolLoader(test_classes=[
            ConversationSearchTool, ConversationReadTool, SearchMemoryTool, ReadMemoryTool,
        ]).load(context, registry, scope="subagent", tool_allowlist=REQUIRED_AGENT_TOOLS)
        return registry

    registry = partner_registry(agent_id)
    assert {definition["function"]["name"] for definition in registry.get_definitions()} == {
        "search_memory", "read_memory",
    }
    token = set_current_workspace(get_agent_output_dir(manager.workspace, agent_id))
    try:
        found = json.loads(await registry.execute("search_memory", {
            "query": "72519", "limit": 20,
        }))
        assert found["status"] == "ok"
        assert found["sources"]["conversations"]["status"] == "ok"
        previews = [row["preview"] for row in found["results"]]
        assert any("original" in text for text in previews)
        assert any("copy" in text for text in previews)
        assert not any("foreign" in text or "project" in text for text in previews)
        original = next(row for row in found["results"] if "original" in row["preview"])
        ref = original["ref"]
        detail = json.loads(await registry.execute("read_memory", {"ref": ref}))
        assert detail["status"] == "ok"
        assert "record 72519 original" in detail["text"]
        assert "answer for record 72519 original" in detail["text"]
        registry.set_allowed_tool_names(set(REQUIRED_AGENT_TOOLS) - {"conversation_read"})
        assert json.loads(await registry.execute("read_memory", {"ref": ref}))["status"] == "unavailable"
        registry.set_allowed_tool_names(None)

        foreign = partner_registry("com.mona.other")
        assert json.loads(await foreign.execute("read_memory", {"ref": ref}))["status"] == "unavailable"

        project_token = set_current_workspace(project)
        try:
            assert json.loads(await registry.execute("read_memory", {"ref": ref}))["status"] == "unavailable"
            project_found = json.loads(await registry.execute("search_memory", {
                "query": "72519", "sources": ["conversations"], "limit": 20,
            }))
            project_previews = [row["preview"] for row in project_found["results"]]
            assert any("project" in text for text in project_previews)
            assert not any("original" in text or "copy" in text or "foreign" in text for text in project_previews)
            project_ref = project_found["results"][0]["ref"]
            assert "record 72519 project" in json.loads(
                await registry.execute("read_memory", {"ref": project_ref})
            )["text"]
        finally:
            reset_current_workspace(project_token)

        async def search_in(workspace):
            workspace_token = set_current_workspace(workspace)
            try:
                result = json.loads(await registry.execute("search_memory", {
                    "query": "72519", "sources": ["conversations"], "limit": 20,
                }))
                return [row["preview"] for row in result["results"]]
            finally:
                reset_current_workspace(workspace_token)

        default_hits, project_hits = await asyncio.gather(
            search_in(get_agent_output_dir(manager.workspace, agent_id)),
            search_in(project),
        )
        assert any("original" in hit for hit in default_hits)
        assert not any("project" in hit for hit in default_hits)
        assert any("project" in hit for hit in project_hits)
        assert not any("original" in hit or "copy" in hit for hit in project_hits)

        assert manager.delete_session("websocket:original") is True
        stale = json.loads(await registry.execute("read_memory", {"ref": ref}))
        assert stale["status"] == "stale_reference"
    finally:
        reset_current_workspace(token)
