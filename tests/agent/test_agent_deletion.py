"""Agent removal follows ownership while retaining historical conversations."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.partners import (
    MONA_AGENT_ID,
    AgentNotFoundError,
    AgentRegistry,
    ConversationMetadata,
)
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.config.paths import get_agent_deletion_marker
from mona.session.manager import SessionManager

AGENT_ID = "com.example.deletable"
CUSTOM_AGENT_ID = "local.custom.deletable"


def _registry(tmp_path: Path, source: str = "installed", agent_id: str = AGENT_ID) -> AgentRegistry:
    root = tmp_path / source
    package = root / agent_id
    if source == "grouped":
        package = root / "expert-package" / agent_id
    package.mkdir(parents=True)
    (package / "agent.json").write_text(
        json.dumps({"id": agent_id, "displayName": "Expert", "prompt": "prompt.md"}),
        encoding="utf-8",
    )
    (package / "prompt.md").write_text("Expert instructions", encoding="utf-8")
    return AgentRegistry(
        builtin_dir=root if source != "installed" else tmp_path / "no-builtin",
        installed_dir=tmp_path / "installed",
        package_store_dir=tmp_path / "packages",
    )


@pytest.mark.parametrize("source", ["installed", "builtin", "grouped"])
def test_delete_hides_agent_after_reload_and_preserves_data(tmp_path: Path, source: str) -> None:
    registry = _registry(tmp_path, source)
    other_registry = AgentRegistry(
        builtin_dir=tmp_path / source if source != "installed" else tmp_path / "no-builtin",
        installed_dir=tmp_path / "installed",
        package_store_dir=tmp_path / "packages",
    )
    private_root = tmp_path / "installed" / AGENT_ID
    private_root.mkdir(parents=True, exist_ok=True)
    private_memory = private_root / "memory" / "MEMORY.md"
    private_memory.parent.mkdir()
    private_memory.write_text("Private memory", encoding="utf-8")
    private_skill = private_root / "skills" / "research" / "SKILL.md"
    private_skill.parent.mkdir(parents=True)
    private_skill.write_text("Private skill", encoding="utf-8")
    history = tmp_path / "sessions" / "chat.jsonl"
    history.parent.mkdir()
    history.write_text("Conversation history", encoding="utf-8")
    profile = tmp_path / "profile" / "USER.md"
    profile.parent.mkdir()
    profile.write_text("Shared profile", encoding="utf-8")

    registry.delete(AGENT_ID)

    for current in (registry, other_registry):
        assert current.get(AGENT_ID) is None
        assert AGENT_ID not in current
        assert [agent.id for agent in current.list_agents()] == [MONA_AGENT_ID]
        assert len(current) == 1
        assert current.package_root(AGENT_ID) is None
        assert current.load_prompt(AGENT_ID) == ""
        assert current.resolve_skill_dirs(AGENT_ID) == []
        with pytest.raises(AgentNotFoundError):
            current.require(AGENT_ID)
        current.reload()
        assert current.get(AGENT_ID) is None
        assert current.require(MONA_AGENT_ID).id == MONA_AGENT_ID
    assert private_memory.read_text(encoding="utf-8") == "Private memory"
    assert private_skill.read_text(encoding="utf-8") == "Private skill"
    assert history.read_text(encoding="utf-8") == "Conversation history"
    assert profile.read_text(encoding="utf-8") == "Shared profile"


def test_custom_deletion_purges_private_data_and_preserves_user_records(tmp_path: Path) -> None:
    registry = _registry(tmp_path, agent_id=CUSTOM_AGENT_ID)
    private_root = tmp_path / "installed" / CUSTOM_AGENT_ID
    for relative in ("config.json", "memory/MEMORY.md", "skills/research/SKILL.md", "knowledge/raw/source.txt"):
        target = private_root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("Private data", encoding="utf-8")
    output = tmp_path / "workspace" / "agent-workspaces" / CUSTOM_AGENT_ID / "output" / "result.txt"
    output.parent.mkdir(parents=True)
    output.write_text("Delivered output", encoding="utf-8")
    history = tmp_path / "sessions" / "chat.jsonl"
    history.parent.mkdir()
    history.write_text("Historical conversation", encoding="utf-8")
    profile = tmp_path / "profile" / "USER.md"
    profile.parent.mkdir()
    profile.write_text("User profile", encoding="utf-8")
    cached_registry = AgentRegistry(
        builtin_dir=tmp_path / "no-builtin", installed_dir=tmp_path / "installed",
        package_store_dir=tmp_path / "packages",
    )

    assert registry.deletion_policy(CUSTOM_AGENT_ID) == "purge_private_data"
    registry.delete(CUSTOM_AGENT_ID)

    assert [child.name for child in private_root.iterdir()] == [".deleted"]
    assert registry.get(CUSTOM_AGENT_ID) is None
    assert cached_registry.get(CUSTOM_AGENT_ID) is None
    registry.reload()
    assert registry.get(CUSTOM_AGENT_ID) is None
    assert output.read_text(encoding="utf-8") == "Delivered output"
    assert history.read_text(encoding="utf-8") == "Historical conversation"
    assert profile.read_text(encoding="utf-8") == "User profile"


def test_custom_prefix_on_bundled_package_does_not_authorize_purging(tmp_path: Path) -> None:
    registry = _registry(tmp_path, "builtin", CUSTOM_AGENT_ID)

    assert registry.deletion_policy(CUSTOM_AGENT_ID) == "retain_private_data"
    registry.delete(CUSTOM_AGENT_ID)

    assert (tmp_path / "builtin" / CUSTOM_AGENT_ID / "agent.json").is_file()


def test_custom_cleanup_failure_is_reported_and_can_be_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registry = _registry(tmp_path, agent_id=CUSTOM_AGENT_ID)
    memory = tmp_path / "installed" / CUSTOM_AGENT_ID / "memory" / "MEMORY.md"
    memory.parent.mkdir()
    memory.write_text("Private memory", encoding="utf-8")

    def fail_cleanup(_path: Path) -> None:
        raise PermissionError("File is in use")

    with monkeypatch.context() as patch:
        patch.setattr("mona.agent.partners.shutil.rmtree", fail_cleanup)
        with pytest.raises(ValueError, match="私人数据尚未清理完成"):
            registry.delete(CUSTOM_AGENT_ID)

    assert registry.get(CUSTOM_AGENT_ID) is None
    assert memory.exists()
    registry.delete(CUSTOM_AGENT_ID)
    assert not memory.exists()


@pytest.mark.parametrize("agent_id", ["mona", " MONA ", "../mona", "unknown.agent"])
def test_delete_rejects_mona_and_invalid_targets(tmp_path: Path, agent_id: str) -> None:
    registry = _registry(tmp_path)

    with pytest.raises(ValueError):
        registry.delete(agent_id)

    assert registry.require(MONA_AGENT_ID).id == MONA_AGENT_ID
    assert registry.require(AGENT_ID).id == AGENT_ID
    assert not list((tmp_path / "installed").rglob(".deleted"))


def test_delete_failure_keeps_agent_available(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    registry = _registry(tmp_path)

    def fail_write(*_args: object) -> None:
        raise PermissionError("Cannot save deletion")

    monkeypatch.setattr("mona.agent.memory_versions.write_text_atomic", fail_write)

    with pytest.raises(PermissionError):
        registry.delete(AGENT_ID)

    assert registry.require(AGENT_ID).id == AGENT_ID


def test_deletion_marker_rejects_linked_agent_directory(tmp_path: Path) -> None:
    agents_dir = tmp_path / "agents"
    agents_dir.mkdir()
    external = tmp_path / "outside"
    external.mkdir()
    try:
        (agents_dir / AGENT_ID).symlink_to(external, target_is_directory=True)
    except OSError:
        if sys.platform != "win32":
            pytest.skip("Directory symlinks are unavailable")
        import _winapi

        _winapi.CreateJunction(str(external), str(agents_dir / AGENT_ID))

    with pytest.raises(ValueError, match="路径已变化"):
        get_agent_deletion_marker(AGENT_ID, agents_dir=agents_dir)

    assert list(external.iterdir()) == []


def test_custom_purge_keeps_external_files_referenced_by_a_directory_link(tmp_path: Path) -> None:
    registry = _registry(tmp_path, agent_id=CUSTOM_AGENT_ID)
    external = tmp_path / "external"
    external.mkdir()
    original = external / "original.txt"
    original.write_text("User-owned original", encoding="utf-8")
    link = tmp_path / "installed" / CUSTOM_AGENT_ID / "linked-files"
    try:
        link.symlink_to(external, target_is_directory=True)
    except OSError:
        if sys.platform != "win32":
            pytest.skip("Directory symlinks are unavailable")
        import _winapi

        _winapi.CreateJunction(str(external), str(link))

    registry.delete(CUSTOM_AGENT_ID)

    assert original.read_text(encoding="utf-8") == "User-owned original"
    assert not link.exists()


async def test_websocket_deletion_routes_request_and_updates_registry(tmp_path: Path) -> None:
    registry = _registry(tmp_path)
    channel = WebSocketChannel({}, MessageBus())
    channel._room_registry = registry
    channel._send_event = AsyncMock()
    channel._broadcast_agent_event = AsyncMock()
    connection = object()

    await channel._dispatch_envelope(
        connection, "client", {"type": "agent_delete", "agent_id": AGENT_ID, "request_id": "delete-1"},
    )

    channel._send_event.assert_awaited_once_with(
        connection, "agent_delete_result", ok=True, agent_id=AGENT_ID, request_id="delete-1",
    )
    channel._broadcast_agent_event.assert_awaited_once_with("agents_updated", agent_id=AGENT_ID)
    assert registry.get(AGENT_ID) is None


@pytest.mark.parametrize("agent_id", [MONA_AGENT_ID, "missing.agent", None])
async def test_websocket_rejects_invalid_deletion_without_broadcast(tmp_path: Path, agent_id) -> None:
    registry = _registry(tmp_path)
    channel = WebSocketChannel({}, MessageBus())
    channel._room_registry = registry
    channel._send_event = AsyncMock()
    channel._broadcast_agent_event = AsyncMock()

    await channel._handle_agent_delete_envelope(
        object(), {"agent_id": agent_id, "request_id": "delete-2"},
    )

    result = channel._send_event.call_args
    assert result.args[1] == "agent_delete_result"
    assert result.kwargs["ok"] is False
    assert result.kwargs["request_id"] == "delete-2"
    channel._broadcast_agent_event.assert_not_awaited()
    assert registry.get(AGENT_ID) is not None
    assert registry.get(MONA_AGENT_ID) is not None


@pytest.mark.parametrize("running", [False, True])
async def test_custom_history_is_retained_and_read_only_after_deletion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, running: bool,
) -> None:
    registry = _registry(tmp_path, agent_id=CUSTOM_AGENT_ID)
    sessions = SessionManager(tmp_path / "workspace")
    session = sessions.get_or_create("websocket:history-chat")
    session.metadata["conversation"] = ConversationMetadata.direct(CUSTOM_AGENT_ID).to_session_metadata()
    session.add_message("user", "Original request")
    session.add_message("assistant", "Original answer")
    sessions.save(session)
    bus = MessageBus()
    bus.publish_inbound = AsyncMock()
    channel = WebSocketChannel({}, bus)
    channel._room_registry = registry
    channel._session_manager = sessions
    channel._send_event = AsyncMock()
    channel._broadcast_agent_event = AsyncMock()
    monkeypatch.setattr(
        "mona.channels.websocket.websocket_turn_wall_started_at", lambda _chat_id: 1.0 if running else None,
    )
    await channel._handle_agent_delete_envelope(
        object(), {"agent_id": CUSTOM_AGENT_ID, "request_id": "delete-custom"},
    )
    if running:
        assert channel._send_event.call_args.kwargs["ok"] is False
        assert "先停止" in channel._send_event.call_args.kwargs["detail"]
        assert registry.get(CUSTOM_AGENT_ID) is not None
        assert (tmp_path / "installed" / CUSTOM_AGENT_ID / "agent.json").exists()
        return

    assert channel._send_event.call_args.kwargs["ok"] is True
    await channel._dispatch_envelope(
        object(), "client", {"type": "message", "chat_id": "history-chat", "content": "New request"},
    )

    assert channel._send_event.call_args.kwargs["code"] == "agent_unavailable"
    bus.publish_inbound.assert_not_awaited()
    saved = sessions.read_session_file("websocket:history-chat")
    assert [message["content"] for message in saved["messages"]] == ["Original request", "Original answer"]


@pytest.mark.parametrize("custom", [False, True])
def test_agent_detail_reports_deletion_policy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, custom: bool) -> None:
    agent_id = CUSTOM_AGENT_ID if custom else AGENT_ID
    channel = WebSocketChannel({}, MessageBus())
    channel._room_registry = _registry(tmp_path, agent_id=agent_id)
    channel._runtime_token = "test-token"
    monkeypatch.setattr("mona.config.paths.get_agents_dir", lambda: tmp_path / "installed")
    monkeypatch.setattr("mona.agent.agent_management.agent_tool_catalog", lambda *_args, **_kwargs: [])
    request = SimpleNamespace(headers={"Authorization": "Bearer test-token"})

    response = channel._handle_agent_management_get(request, f"/api/agents/{agent_id}")

    assert response.status_code == 200
    assert json.loads(response.body)["deletionPolicy"] == (
        "purge_private_data" if custom else "retain_private_data"
    )
