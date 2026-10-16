"""User-safe feedback for failures handled by AgentLoop dispatch."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from mona.agent.loop import AgentLoop
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.session.manager import SessionSaveError
from mona.session.webui_turns import WebuiTurnCoordinator

SAVE_ERROR = "会话记录暂时无法保存，本次任务已中断。已生成的文件仍保留，请稍后继续。"
GENERIC_ERROR = "本次任务遇到问题，暂时无法完成，请稍后重试。"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure_kind", "expected_message"),
    [("session_save", SAVE_ERROR), ("unexpected", GENERIC_ERROR)],
)
async def test_dispatch_reports_safe_error_and_publishes_idle(
    failure_kind: str,
    expected_message: str,
) -> None:
    bus = MessageBus()
    turns = WebuiTurnCoordinator(
        bus=bus,
        sessions=SimpleNamespace(),
        schedule_background=lambda _coro: None,
    )
    loop = AgentLoop.__new__(AgentLoop)
    loop._unified_session = False
    loop._session_locks = {}
    loop._concurrency_gate = None
    loop._pending_queues = {}
    loop._pending_turn_latency_ms = {}
    loop._pending_turn_usage = {}
    loop.bus = bus
    loop._webui_turns = turns
    msg = InboundMessage(
        channel="websocket",
        sender_id="user",
        chat_id="video-session",
        content="continue the video",
        metadata={"webui": True, "agent_kind": "video"},
    )
    calls = 0

    async def process_message(_msg: InboundMessage, **_kwargs: object) -> None:
        nonlocal calls
        calls += 1
        await turns.publish_run_status(msg, "running")
        if failure_kind == "session_save":
            raise SessionSaveError(r"[WinError 5] C:\private\session.jsonl.tmp")
        raise RuntimeError(r"C:\private\internal-stack-path")

    loop._process_message = process_message

    await loop._dispatch(msg)

    outbound = [await bus.consume_outbound() for _ in range(3)]
    error = next(item for item in outbound if item.content)
    status_messages = [
        item for item in outbound if (item.metadata or {}).get("_goal_status")
    ]
    statuses = [
        (item.metadata or {}).get("goal_status")
        for item in status_messages
    ]

    assert calls == 1
    assert error.channel == msg.channel
    assert error.chat_id == msg.chat_id
    assert error.content == expected_message
    assert "C:\\private" not in error.content
    assert all(
        item.channel == msg.channel and item.chat_id == msg.chat_id
        for item in status_messages
    )
    assert statuses == ["running", "idle"]
