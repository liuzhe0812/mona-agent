from __future__ import annotations

from types import SimpleNamespace

import pytest

from mona.agent import agent_management
from mona.bus.events import InboundMessage
from mona.command.builtin import (
    BUILTIN_COMMAND_SPECS,
    cmd_dream_restore,
    register_builtin_commands,
)
from mona.command.router import CommandContext, CommandRouter

AGENT_ID = "agent.test"


def _configure_agent_memory(tmp_path, monkeypatch):
    def memory_dir(agent_id: str):
        return tmp_path / "agents" / agent_id / "memory"

    monkeypatch.setattr(agent_management, "get_agent_memory_dir", memory_dir)
    monkeypatch.setattr("mona.config.paths.get_agent_memory_dir", memory_dir)
    return memory_dir(AGENT_ID)


def _make_ctx(raw: str, *, args: str = "") -> CommandContext:
    msg = InboundMessage(channel="cli", sender_id="u1", chat_id="direct", content=raw)
    store = SimpleNamespace(agent_id=AGENT_ID)
    loop = SimpleNamespace(consolidator=SimpleNamespace(store=store))
    return CommandContext(msg=msg, session=None, key=msg.session_key, raw=raw, args=args, loop=loop)


@pytest.mark.asyncio
async def test_dream_restore_defaults_to_previous_memory_version(tmp_path, monkeypatch) -> None:
    memory_dir = _configure_agent_memory(tmp_path, monkeypatch)
    agent_management.write_instruction(AGENT_ID, "memory", "previous memory", message="older")
    agent_management.write_instruction(AGENT_ID, "memory", "current memory", message="current")

    out = await cmd_dream_restore(_make_ctx("/dream-restore"))

    assert "previous memory" == (memory_dir / "MEMORY.md").read_text(encoding="utf-8")
    assert "memory" in out.content.lower()


@pytest.mark.asyncio
async def test_dream_restore_selects_previous_persona_without_touching_memory(tmp_path, monkeypatch) -> None:
    memory_dir = _configure_agent_memory(tmp_path, monkeypatch)
    agent_management.write_instruction(AGENT_ID, "soul", "previous persona", message="older")
    agent_management.write_instruction(AGENT_ID, "soul", "current persona", message="current")
    agent_management.write_instruction(AGENT_ID, "memory", "keep this memory", message="memory")

    out = await cmd_dream_restore(_make_ctx("/dream-restore soul", args="soul"))

    assert "previous persona" == (memory_dir / "SOUL.md").read_text(encoding="utf-8")
    assert "keep this memory" == (memory_dir / "MEMORY.md").read_text(encoding="utf-8")
    assert "soul" in out.content.lower()


@pytest.mark.asyncio
async def test_dream_restore_reports_missing_previous_version(tmp_path, monkeypatch) -> None:
    memory_dir = _configure_agent_memory(tmp_path, monkeypatch)
    memory_dir.mkdir(parents=True, exist_ok=True)
    (memory_dir / "MEMORY.md").write_text("current memory", encoding="utf-8")
    with pytest.raises(agent_management.AgentManagementError) as expected:
        agent_management.restore_instruction(AGENT_ID, "memory")

    out = await cmd_dream_restore(_make_ctx("/dream-restore"))

    assert out.content == str(expected.value)
    assert (memory_dir / "MEMORY.md").read_text(encoding="utf-8") == "current memory"


@pytest.mark.asyncio
async def test_dream_restore_rejects_old_sha_parameter(tmp_path, monkeypatch) -> None:
    memory_dir = _configure_agent_memory(tmp_path, monkeypatch)
    agent_management.write_instruction(AGENT_ID, "memory", "previous memory", message="older")
    agent_management.write_instruction(AGENT_ID, "memory", "current memory", message="current")

    out = await cmd_dream_restore(_make_ctx("/dream-restore abc12345", args="abc12345"))

    assert "old version ids are no longer supported" in out.content.lower()
    assert (memory_dir / "MEMORY.md").read_text(encoding="utf-8") == "current memory"


def test_dream_log_is_no_longer_registered() -> None:
    router = CommandRouter()
    register_builtin_commands(router)

    assert not router.is_dispatchable_command("/dream-log")
    assert not router.is_dispatchable_command("/dream-log abc12345")
    assert router.is_dispatchable_command("/dream-restore")
    assert router.is_dispatchable_command("/dream-restore soul")
    assert all(spec.command != "/dream-log" for spec in BUILTIN_COMMAND_SPECS)
    restore_spec = next(spec for spec in BUILTIN_COMMAND_SPECS if spec.command == "/dream-restore")
    assert restore_spec.arg_hint == "[memory|soul]"
