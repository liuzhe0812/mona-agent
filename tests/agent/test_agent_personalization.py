"""Agent persona and memory stay private; user preferences remain shared."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent import agent_management
from mona.agent.agent_management import (
    AgentManagementError,
    list_instructions,
    read_instruction,
    restore_instruction,
    write_instruction,
)
from mona.agent.context import ContextBuilder
from mona.agent.memory import MemoryStore
from mona.agent.tools.memory_tools import MemoryEditTool, MemoryReadTool
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.config import paths
from mona.utils.helpers import sync_global_templates


@pytest.fixture(autouse=True)
def use_isolated_agent_paths(monkeypatch):
    monkeypatch.setattr(agent_management, "get_agent_memory_dir", paths.get_agent_memory_dir)


def test_agent_configuration_only_exposes_persona_and_memory():
    assert [item["key"] for item in list_instructions("agent.one")] == ["soul", "memory"]


def test_fresh_install_does_not_create_private_user_or_rules(tmp_path: Path):
    sync_global_templates(silent=True)
    store = MemoryStore(tmp_path)
    assert store.soul_file.exists()
    assert store.memory_file.exists()
    assert not store.user_file.exists()
    assert not store.agents_file.exists()
    assert not (store.memory_dir / ".git").exists()


@pytest.mark.parametrize("key", ["user", "agents"])
def test_removed_private_configuration_cannot_be_read_or_written(key):
    with pytest.raises(AgentManagementError, match="unsupported instruction"):
        read_instruction("agent.one", key)
    with pytest.raises(AgentManagementError, match="unsupported instruction"):
        write_instruction("agent.one", key, "should not be saved", message="test")


def test_persona_and_long_term_memory_are_agent_private(tmp_path: Path):
    for agent_id, value in [("agent.one", "first"), ("agent.two", "second")]:
        write_instruction(agent_id, "soul", f"{value} persona", message="set persona")
        write_instruction(agent_id, "memory", f"{value} memory", message="set memory")

    for agent_id, value, other in [("agent.one", "first", "second"), ("agent.two", "second", "first")]:
        context = ContextBuilder(tmp_path, agent_id=agent_id)
        assert context.memory.read_soul() == f"{value} persona"
        assert context.memory.read_memory() == f"{value} memory"
        assert other not in context.build_private_bootstrap_context()
        assert not context.memory.user_file.exists()
        assert not context.memory.agents_file.exists()


def test_legacy_rules_are_visible_migrated_and_restorable(tmp_path: Path):
    store = MemoryStore(tmp_path, agent_id="agent.one")
    store.soul_file.write_text("old persona", encoding="utf-8")
    store.agents_file.write_text("old behavior rule", encoding="utf-8")
    store.user_file.write_text("old private preference", encoding="utf-8")
    original = read_instruction("agent.one", "soul")["content"]
    assert "old persona" in original
    assert "old behavior rule" in original
    assert "old private preference" not in original
    assert store.agents_file.read_text(encoding="utf-8") == "old behavior rule"

    saved = write_instruction("agent.one", "soul", original + "\nnew requirement", message="edit persona")
    assert saved["content"] == store.soul_file.read_text(encoding="utf-8")
    assert saved["content"].count("old behavior rule") == 1
    assert store.agents_file.read_text(encoding="utf-8") == ""
    assert store.user_file.read_text(encoding="utf-8") == "old private preference"

    assert store.read_previous("soul") == original
    restored = restore_instruction("agent.one", "soul")
    assert restored["content"] == original
    assert "new requirement" not in restored["content"]
    assert store.agents_file.read_text(encoding="utf-8") == ""
    assert store.read_previous("soul") == saved["content"]


def test_only_one_previous_version_is_kept_and_unchanged_saves_do_not_replace_it(tmp_path: Path):
    first = write_instruction("agent.one", "memory", "first", message="test")
    assert not first["hasPrevious"]
    for value in ("second", "third", "fourth"):
        write_instruction("agent.one", "memory", value, message="test")
    store = MemoryStore(tmp_path, agent_id="agent.one")
    assert store.read_previous("memory") == "third"
    previous_mtime = store.previous_file("memory").stat().st_mtime_ns
    saved = write_instruction("agent.one", "memory", "fourth", message="unchanged")
    assert saved["hasPrevious"]
    assert store.read_previous("memory") == "third"
    assert store.previous_file("memory").stat().st_mtime_ns == previous_mtime
    assert list(store.memory_dir.glob("*.previous")) == [store.previous_file("memory")]
    assert not (store.memory_dir / ".git").exists()


def test_restore_accepts_empty_previous_content_without_rolling_back_dream_cursor(tmp_path: Path):
    store = MemoryStore(tmp_path, agent_id="agent.one")
    store.write_memory("")
    store.write_memory("new memory")
    store.set_last_dream_cursor(42)
    restored = restore_instruction("agent.one", "memory")
    assert restored["content"] == ""
    assert store.read_previous("memory") == "new memory"
    assert store.get_last_dream_cursor() == 42


def test_restore_without_previous_version_fails():
    with pytest.raises(AgentManagementError, match="没有可恢复"):
        restore_instruction("agent.one", "soul")


def test_failed_save_preserves_current_content_and_previous_version(tmp_path: Path, monkeypatch):
    from mona.agent.memory_versions import write_text_atomic

    store = MemoryStore(tmp_path, agent_id="agent.one")
    store.write_memory("previous")
    store.write_memory("current")

    def fail_current_save(path, content):
        if path == store.memory_file:
            raise PermissionError("current file is busy")
        write_text_atomic(path, content)

    monkeypatch.setattr("mona.agent.memory.write_text_atomic", fail_current_save)
    with pytest.raises(PermissionError, match="current file is busy"):
        store.write_memory("unsaved")
    assert store.read_memory() == "current"
    assert store.read_previous("memory") == "previous"


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy_commit", [None, "old-version-id"])
async def test_restore_envelope_only_restores_previous_version_for_the_selected_agent(monkeypatch, legacy_commit):
    write_instruction("agent.one", "memory", "previous", message="test")
    write_instruction("agent.one", "memory", "current", message="test")
    write_instruction("agent.two", "memory", "other agent", message="test")
    channel = WebSocketChannel({}, MessageBus())
    monkeypatch.setattr(channel, "_room_agent_registry", lambda: SimpleNamespace(get=lambda _id: object()))
    monkeypatch.setattr(channel, "_send_event", AsyncMock())
    monkeypatch.setattr(channel, "_broadcast_agent_event", AsyncMock())
    envelope = {"agent_id": "agent.one", "key": "memory", "request_id": "restore-test"}
    if legacy_commit is not None:
        envelope["commit"] = legacy_commit
    await channel._handle_agent_instruction_restore_envelope(object(), envelope)
    response = channel._send_event.call_args.kwargs
    assert response["ok"] is (legacy_commit is None)
    assert read_instruction("agent.one", "memory")["content"] == ("previous" if legacy_commit is None else "current")
    assert read_instruction("agent.two", "memory")["content"] == "other agent"
    if legacy_commit is None:
        assert response["instruction"]["hasPrevious"]
    else:
        assert "仅支持恢复上一版" in response["detail"]


@pytest.mark.asyncio
async def test_memory_tools_read_and_append_the_same_effective_persona(tmp_path: Path):
    store = MemoryStore(tmp_path, agent_id="agent.one")
    store.agents_file.write_text("legacy behavior", encoding="utf-8")
    before = await MemoryReadTool("agent.one").execute(file="soul")
    assert "legacy behavior" in before

    result = await MemoryEditTool("agent.one").execute(file="soul", content="new behavior", mode="append")
    assert result.startswith("Successfully appended")
    after = read_instruction("agent.one", "soul")["content"]
    assert "legacy behavior" in after
    assert "new behavior" in after
    assert after.count("legacy behavior") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("key", ["user", "agents"])
async def test_memory_tools_reject_removed_private_files(tmp_path: Path, key: str):
    store = MemoryStore(tmp_path, agent_id="agent.one")
    path = store.user_file if key == "user" else store.agents_file
    path.write_text("preserve legacy data", encoding="utf-8")
    assert (await MemoryReadTool("agent.one").execute(file=key)).startswith("Error:")
    assert (await MemoryEditTool("agent.one").execute(file=key, content="replace")).startswith("Error:")
    assert path.read_text(encoding="utf-8") == "preserve legacy data"
