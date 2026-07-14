"""Tests for the Agent personal-data subscription gate.

Covers:
- ToolRegistry: subscription_required tools are hidden from the model and
  rejected at execution time when the user has no access.
- Hoard search: exclude_sources filters at the SQL level.
- Tool markers: notes_search/read and email_search/read/action are gated;
  notes_create and notes_save_image are free.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from mona.agent.tools import email_intel as email_module
from mona.agent.tools import notes as notes_module
from mona.agent.tools import tauri_ipc
from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.registry import (
    MEMBERSHIP_REQUIRED_ERROR,
    ToolRegistry,
)
from mona.agent.tools.schema import (
    StringSchema,
    tool_parameters_schema,
)
from mona.hoard.models import HoardManager

# ---------------------------------------------------------------------------
# Test tool fixtures
# ---------------------------------------------------------------------------

_PARAMS = tool_parameters_schema(query=StringSchema("query"))


@tool_parameters(_PARAMS)
class _GatedTool(Tool):
    """A tool marked as subscription_required."""

    name = "test_gated"
    description = "A gated test tool"
    subscription_required = True
    read_only = True

    async def execute(self, **kwargs: Any) -> str:
        return "gated result"


@tool_parameters(_PARAMS)
class _FreeTool(Tool):
    """A tool that is always available."""

    name = "test_free"
    description = "A free test tool"
    subscription_required = False

    async def execute(self, **kwargs: Any) -> str:
        return "free result"


def _make_registry() -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(_GatedTool())
    reg.register(_FreeTool())
    return reg


# ---------------------------------------------------------------------------
# ToolRegistry: definition hiding
# ---------------------------------------------------------------------------


def test_get_definitions_includes_all_tools_when_access_true() -> None:
    reg = _make_registry()
    reg.set_subscription_access(True)
    names = [
        d.get("function", {}).get("name", d.get("name", ""))
        for d in reg.get_definitions()
    ]
    assert "test_gated" in names
    assert "test_free" in names


def test_registry_defaults_to_no_subscription_access() -> None:
    reg = _make_registry()
    names = [
        d.get("function", {}).get("name", d.get("name", ""))
        for d in reg.get_definitions()
    ]
    assert reg.has_subscription_access is False
    assert "test_gated" not in names
    assert "test_free" in names


def test_get_definitions_hides_gated_tools_when_no_access() -> None:
    reg = _make_registry()
    reg.set_subscription_access(False)
    names = [
        d.get("function", {}).get("name", d.get("name", ""))
        for d in reg.get_definitions()
    ]
    assert "test_gated" not in names
    assert "test_free" in names


def test_definitions_cache_invalidated_on_access_change() -> None:
    reg = _make_registry()
    reg.set_subscription_access(True)
    defs_with_access = reg.get_definitions()
    # Same reference from cache
    assert reg.get_definitions() is defs_with_access

    reg.set_subscription_access(False)
    defs_without = reg.get_definitions()
    assert defs_without is not defs_with_access
    names = [
        d.get("function", {}).get("name", d.get("name", ""))
        for d in defs_without
    ]
    assert "test_gated" not in names


# ---------------------------------------------------------------------------
# ToolRegistry: execution-time rejection (defense in depth)
# ---------------------------------------------------------------------------


def test_is_subscription_blocked_true_when_no_access_and_gated() -> None:
    reg = _make_registry()
    reg.set_subscription_access(False)
    assert reg.is_subscription_blocked("test_gated") is True


def test_is_subscription_blocked_false_for_free_tool() -> None:
    reg = _make_registry()
    reg.set_subscription_access(False)
    assert reg.is_subscription_blocked("test_free") is False


def test_is_subscription_blocked_false_when_has_access() -> None:
    reg = _make_registry()
    reg.set_subscription_access(True)
    assert reg.is_subscription_blocked("test_gated") is False


def test_prepare_call_returns_membership_error_when_blocked() -> None:
    reg = _make_registry()
    reg.set_subscription_access(False)
    tool, params, error = reg.prepare_call("test_gated", {"query": "x"})
    assert error is not None
    assert error.startswith(MEMBERSHIP_REQUIRED_ERROR)


def test_prepare_call_succeeds_for_free_tool_when_no_access() -> None:
    reg = _make_registry()
    reg.set_subscription_access(False)
    tool, params, error = reg.prepare_call("test_free", {"query": "x"})
    assert error is None
    assert tool is not None


def test_prepare_call_succeeds_for_gated_tool_when_has_access() -> None:
    reg = _make_registry()
    reg.set_subscription_access(True)
    tool, params, error = reg.prepare_call("test_gated", {"query": "x"})
    assert error is None
    assert tool is not None


@pytest.mark.asyncio
async def test_execute_returns_membership_error_when_blocked() -> None:
    reg = _make_registry()
    reg.set_subscription_access(False)
    result = await reg.execute("test_gated", {"query": "x"})
    assert isinstance(result, str)
    assert MEMBERSHIP_REQUIRED_ERROR in result


@pytest.mark.asyncio
async def test_execute_free_tool_works_when_no_access() -> None:
    reg = _make_registry()
    reg.set_subscription_access(False)
    result = await reg.execute("test_free", {"query": "x"})
    assert result == "free result"


# ---------------------------------------------------------------------------
# Tool markers on real tools
# ---------------------------------------------------------------------------


def test_notes_search_is_subscription_required() -> None:
    assert notes_module.NotesSearchTool.subscription_required is True


def test_notes_read_is_subscription_required() -> None:
    assert notes_module.NotesReadTool.subscription_required is True


def test_notes_create_is_free() -> None:
    assert notes_module.NotesCreateTool.subscription_required is False


def test_notes_save_image_is_free() -> None:
    assert notes_module.NotesSaveImageTool.subscription_required is False


def test_email_search_is_subscription_required() -> None:
    assert email_module.EmailSearchTool.subscription_required is True


def test_email_read_is_subscription_required() -> None:
    assert email_module.EmailReadTool.subscription_required is True


def test_email_action_is_subscription_required() -> None:
    assert email_module.EmailActionTool.subscription_required is True


def test_subscription_access_rejects_non_boolean_ipc_result(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tauri_ipc, "_ACCESS_CACHE", None)
    monkeypatch.setattr(tauri_ipc, "tauri_invoke", lambda _cmd: "false")
    assert tauri_ipc.check_subscription_access() is False


@pytest.mark.asyncio
async def test_agent_turn_forces_subscription_cache_refresh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from mona.agent.loop import AgentLoop

    calls: list[str] = []
    monkeypatch.setattr(
        tauri_ipc,
        "invalidate_subscription_access_cache",
        lambda: calls.append("invalidate"),
    )
    monkeypatch.setattr(
        tauri_ipc,
        "check_subscription_access",
        lambda: calls.append("check") or True,
    )
    loop = object.__new__(AgentLoop)
    loop.tools = ToolRegistry()

    await AgentLoop._refresh_subscription_access(loop)

    assert calls == ["invalidate", "check"]
    assert loop.tools.has_subscription_access is True


# ---------------------------------------------------------------------------
# Hoard search: exclude_sources
# ---------------------------------------------------------------------------


def _make_hoard_manager(tmp_path: Path) -> HoardManager:
    db_path = tmp_path / "hoard.sqlite3"
    mgr = HoardManager(db_path=db_path)
    # Insert items from different sources
    mgr.add(title="Browser result", content="hello world", source="browser")
    mgr.add(title="Chat result", content="hello world", source="chat")
    mgr.add(title="Note result", content="hello world", source="note")
    mgr.add(title="Email result", content="hello world", source="email")
    return mgr


def test_hoard_search_exclude_sources_filters_note_and_email(tmp_path: Path) -> None:
    mgr = _make_hoard_manager(tmp_path)
    results = mgr.search("hello", exclude_sources=["note", "email"])
    sources = {r.source for r in results}
    assert "note" not in sources
    assert "email" not in sources
    assert "browser" in sources
    assert "chat" in sources


def test_hoard_search_without_exclude_returns_all_sources(tmp_path: Path) -> None:
    mgr = _make_hoard_manager(tmp_path)
    results = mgr.search("hello")
    sources = {r.source for r in results}
    assert sources == {"browser", "chat", "note", "email"}


def test_hoard_search_exclusion_takes_precedence_over_source(tmp_path: Path) -> None:
    """A caller cannot override the subscription exclusion with source."""
    mgr = _make_hoard_manager(tmp_path)
    results = mgr.search("hello", source="note", exclude_sources=["note", "email"])
    assert results == []


def test_hoard_search_exclude_none_does_not_filter(tmp_path: Path) -> None:
    mgr = _make_hoard_manager(tmp_path)
    results = mgr.search("hello", exclude_sources=None)
    sources = {r.source for r in results}
    assert "note" in sources
    assert "email" in sources


@pytest.mark.asyncio
async def test_search_hoard_hybrid_excludes_sources_and_filters_relations(
    tmp_path: Path,
) -> None:
    from mona.hoard.search import search_hoard_hybrid

    mgr = _make_hoard_manager(tmp_path)
    # Add a relation of type "note" to the browser item to verify relation filtering
    browser_item = next(r for r in mgr.search("hello") if r.source == "browser")
    mgr.add_relation(
        browser_item.id,
        related_type="note",
        related_id="note-123",
        related_meta={"title": "Linked note"},
    )

    result = await search_hoard_hybrid(
        "hello",
        manager=mgr,
        exclude_sources=["note", "email"],
    )
    results = result["results"]
    sources = {r["source"] for r in results}
    assert "note" not in sources
    assert "email" not in sources

    # Verify that related_sources of type "note" are also filtered out
    for r in results:
        for rel in r["related_sources"]:
            assert rel["type"] not in {"note", "email"}
