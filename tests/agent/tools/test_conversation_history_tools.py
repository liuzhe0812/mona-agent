from __future__ import annotations

import json

import pytest

from mona.agent.partners import ConversationMetadata
from mona.agent.tools.context import ToolContext
from mona.agent.tools.conversation_history import (
    ConversationReadTool,
    ConversationSearchTool,
)
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.registry import ToolRegistry
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


def test_loader_registers_tools_only_for_enabled_core_context(tmp_path):
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
    assert ToolLoader(test_classes=classes).load(
        _context(tmp_path), subagent, scope="subagent"
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
