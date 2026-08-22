"""Room @-mention context and authored-result projection tests."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from mona.agent.jobs import AgentJobStore
from mona.agent.loop import AgentLoop
from mona.agent.partners import (
    CONVERSATION_METADATA_KEY,
    MONA_AGENT_ID,
    AgentRegistry,
    ConversationMetadata,
)
from mona.agent.subagent import SubagentManager
from mona.bus.queue import MessageBus
from mona.bus.events import OutboundMessage
from mona.channels.websocket import WebSocketChannel
from mona.providers.base import LLMProvider, LLMResponse
from mona.session.manager import SessionManager
from mona.webui.transcript import replay_transcript_to_ui_messages

AGENT_A = "com.example.agent-a"
AGENT_B = "com.example.agent-b"
ROOM_ID = "room-context"


def _write_agent_package(root: Path, agent_id: str, display_name: str) -> None:
    package = root / agent_id
    package.mkdir(parents=True)
    (package / "agent.json").write_text(
        json.dumps(
            {
                "id": agent_id,
                "display_name": display_name,
                "description": f"{display_name} description",
                "prompt": "prompt.md",
                "tool_allowlist": ["read_file"],
            }
        ),
        encoding="utf-8",
    )
    (package / "prompt.md").write_text(f"You are {display_name}.", encoding="utf-8")


def _registry(tmp_path: Path) -> AgentRegistry:
    packages = tmp_path / "agents"
    _write_agent_package(packages, AGENT_A, "分析师 A")
    _write_agent_package(packages, AGENT_B, "分析师 B")
    return AgentRegistry(builtin_dir=packages, installed_dir=tmp_path / "installed")


def _room_session(sessions: SessionManager) -> None:
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    session.metadata[CONVERSATION_METADATA_KEY] = ConversationMetadata.room(
        [MONA_AGENT_ID, AGENT_A, AGENT_B],
        title="协作群",
        goal="完成一份可核验的报告",
    ).to_session_metadata()
    sessions.save(session)


def test_room_model_history_keeps_agent_author_labels(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    session.add_message("user", "请先分析数据")
    session.add_message(
        "assistant",
        "A 的结论",
        author_id=AGENT_A,
        message_type="message",
    )

    fake_loop = SimpleNamespace(_room_agent_registry=_registry(tmp_path))
    history = AgentLoop._build_model_history(
        fake_loop,
        session,
        max_messages=50,
        max_tokens=0,
    )

    assert history == [
        {"role": "user", "content": "请先分析数据"},
        {"role": "assistant", "content": "[分析师 A] A 的结论"},
    ]


def test_room_model_context_includes_goal_and_all_members(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    fake_loop = SimpleNamespace(_room_agent_registry=_registry(tmp_path))

    context = AgentLoop._room_members_context(fake_loop, session)

    assert "完成一份可核验的报告" in context
    assert AGENT_A in context and "分析师 A" in context
    assert AGENT_B in context and "分析师 B" in context


def test_room_snapshot_for_agent_b_contains_agent_a_answer(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    session.add_message("user", "请先分析数据")
    session.add_message(
        "assistant",
        "A 的结论",
        author_id=AGENT_A,
        message_type="message",
    )

    manager = SubagentManager(
        provider=_Provider(LLMResponse(content="ok")),
        workspace=tmp_path / "workspace",
        bus=MessageBus(),
        max_tool_result_chars=4000,
        session_manager=sessions,
    )
    snapshot = manager._build_room_context_snapshot(
        ROOM_ID, AGENT_B, _registry(tmp_path)
    )

    assert "完成一份可核验的报告" in snapshot
    assert AGENT_A in snapshot and "分析师 A" in snapshot
    assert AGENT_B in snapshot and "分析师 B" in snapshot
    assert "A 的结论" in snapshot


@pytest.mark.asyncio
async def test_user_mention_result_is_authored_and_does_not_wake_mona(
    tmp_path: Path,
) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    bus = MessageBus()
    manager = SubagentManager(
        provider=_Provider(LLMResponse(content="A 的最终回答")),
        workspace=tmp_path / "workspace",
        bus=bus,
        max_tool_result_chars=4000,
        session_manager=sessions,
    )
    store = AgentJobStore(tmp_path / "jobs")
    registry = _registry(tmp_path)

    await manager.delegate(
        agent_id=AGENT_A,
        task="回答用户问题",
        success_criteria="给出最终回答",
        room_id=ROOM_ID,
        requested_by="user",
        origin_channel="websocket",
        origin_chat_id=ROOM_ID,
        session_key=f"websocket:{ROOM_ID}",
        job_store=store,
        registry=registry,
    )
    job_id = store.list_for_room(ROOM_ID)[0].id
    await manager._running_tasks[job_id]

    authored = [
        message
        for message in sessions.get_or_create(f"websocket:{ROOM_ID}").messages
        if message.get("job_id") == job_id
    ]
    assert len(authored) == 1
    assert authored[0]["author_id"] == AGENT_A
    assert authored[0]["content"] == "A 的最终回答"
    assert bus.inbound_size == 0
    outbound = await bus.consume_outbound()
    assert outbound.metadata["author_id"] == AGENT_A
    assert outbound.metadata["job_id"] == job_id
    sidebar_refresh = await bus.consume_outbound()
    assert sidebar_refresh.chat_id == ROOM_ID
    assert sidebar_refresh.metadata["_session_updated"] is True
    assert sidebar_refresh.metadata["_session_update_scope"] == "thread"


@pytest.mark.asyncio
async def test_same_mention_batch_keeps_start_snapshots_independent(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    session.add_message("user", "同一批任务")
    session.add_message("assistant", "Mona 的既有回答", author_id=MONA_AGENT_ID)
    session.add_message("assistant", "A 的既有回答", author_id=AGENT_A)
    bus = MessageBus()
    manager = SubagentManager(
        provider=_Provider(LLMResponse(content="ok")),
        workspace=tmp_path / "workspace",
        bus=bus,
        max_tool_result_chars=4000,
        session_manager=sessions,
    )
    store = AgentJobStore(tmp_path / "jobs")
    registry = _registry(tmp_path)
    batch_snapshot = manager.capture_room_context_snapshot(ROOM_ID, registry)

    await manager.delegate(
        agent_id=AGENT_A,
        task="并行任务 A",
        success_criteria="完成",
        room_id=ROOM_ID,
        requested_by="user",
        room_context_snapshot=batch_snapshot,
        job_store=store,
        registry=registry,
    )
    await manager.delegate(
        agent_id=AGENT_B,
        task="并行任务 B",
        success_criteria="完成",
        room_id=ROOM_ID,
        requested_by="user",
        room_context_snapshot=batch_snapshot,
        job_store=store,
        registry=registry,
    )

    # Mutate the room only after both jobs were queued. Neither captured
    # snapshot may observe a sibling's later answer.
    assert "[Mona] Mona 的既有回答" in batch_snapshot
    assert "[分析师 A] A 的既有回答" in batch_snapshot
    session.add_message("assistant", "A 后来的回答", author_id=AGENT_A)
    assert "A 后来的回答" not in batch_snapshot

    await asyncio.gather(*manager._running_tasks.values())


@pytest.mark.asyncio
async def test_closed_room_persists_one_authored_result_for_replay() -> None:
    channel = WebSocketChannel(
        {
            "enabled": True,
            "allowFrom": ["*"],
            "host": "127.0.0.1",
            "port": 29877,
            "path": "/ws",
            "websocketRequiresToken": False,
        },
        MessageBus(),
    )
    channel._try_append_webui_transcript = MagicMock()
    await channel.send(
        OutboundMessage(
            channel="websocket",
            chat_id=ROOM_ID,
            content="A 的回答",
            metadata={
                "_agent_job_result": True,
                "author_id": AGENT_A,
                "message_type": "message",
                "job_id": "job-a",
            },
        )
    )

    channel._try_append_webui_transcript.assert_called_once()
    payload = channel._try_append_webui_transcript.call_args.args[1]
    replayed = replay_transcript_to_ui_messages([payload])
    assert len(replayed) == 1
    assert replayed[0]["authorId"] == AGENT_A
    assert replayed[0]["jobId"] == "job-a"


class _Provider(LLMProvider):
    def __init__(self, response: LLMResponse) -> None:
        super().__init__()
        self.response = response

    async def chat(self, messages, tools=None, model=None, **kwargs):
        return self.response

    def get_default_model(self) -> str:
        return "test-model"
