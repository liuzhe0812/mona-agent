"""User-safe feedback for failures handled by AgentLoop dispatch."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.loop import AgentLoop
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.channels.manager import ChannelManager
from mona.channels.websocket import WebSocketChannel
from mona.providers.base import LLMResponse, ToolCallRequest
from mona.session.manager import SessionSaveError
from mona.session.webui_turns import WebuiTurnCoordinator
from mona.utils.runtime import EMPTY_FINAL_RESPONSE_MESSAGE
from mona.webui.transcript import (
    append_transcript_object,
    read_transcript_lines,
    replay_transcript_to_ui_messages,
)

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

    async def process_message(active_message: InboundMessage, **_kwargs: object) -> None:
        nonlocal calls
        calls += 1
        await turns.publish_run_status(active_message, "running")
        if failure_kind == "session_save":
            raise SessionSaveError(r"[WinError 5] C:\private\session.jsonl.tmp")
        raise RuntimeError(r"C:\private\internal-stack-path")

    loop._process_message = process_message

    await loop._dispatch(msg)

    outbound = [bus.outbound.get_nowait() for _ in range(bus.outbound_size)]
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


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["streamed", "recovered", "empty"])
async def test_websocket_delivers_the_final_answer_after_tool_activity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
) -> None:
    monkeypatch.setattr("mona.config.loader._current_config_path", tmp_path / "config.json")
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.supports_progress_deltas = True
    loop = AgentLoop(bus=MessageBus(), provider=provider, workspace=tmp_path, model="test-model")
    loop.tools.get_definitions = MagicMock(return_value=[])
    loop.tools.prepare_call = MagicMock(return_value=(None, {"path": "foo.txt"}, None))
    loop.tools.execute = AsyncMock(return_value="file.txt")
    loop.consolidator.maybe_consolidate_by_tokens = AsyncMock(return_value=False)

    tool_call = ToolCallRequest(id="call1", name="custom_tool", arguments={"path": "foo.txt"})
    tool_response = LLMResponse(content="Checking files.", tool_calls=[tool_call])
    final_content = "Streamed final answer" if mode == "streamed" else "Recovered final answer"
    if mode == "empty":
        final_content = EMPTY_FINAL_RESPONSE_MESSAGE
    responses = iter([
        tool_response,
        *([LLMResponse(content=final_content)] if mode == "streamed" else [
            LLMResponse(content=None), LLMResponse(content=None),
        ]),
    ])

    async def chat_stream_with_retry(*, on_content_delta, **_kwargs):
        response = next(responses)
        if response.content:
            await on_content_delta(response.content)
        return response

    provider.chat_stream_with_retry = AsyncMock(side_effect=chat_stream_with_retry)
    provider.chat_with_retry = AsyncMock(return_value=LLMResponse(
        content="Recovered final answer" if mode == "recovered" else None,
    ))

    chat_id = f"final-{mode}"
    session_key = f"websocket:{chat_id}"
    channel = WebSocketChannel({"enabled": True}, loop.bus, session_manager=loop.sessions)
    connection = AsyncMock()
    channel._attach(connection, chat_id)
    append_transcript_object(session_key, {"event": "user", "chat_id": chat_id, "text": "Inspect files"})
    await loop._dispatch(InboundMessage(
        channel="websocket",
        sender_id="u1",
        chat_id=chat_id,
        content="Inspect files",
        metadata={"_wants_stream": True},
    ))
    await loop.close_mcp()

    while loop.bus.outbound_size:
        await ChannelManager._send_once(channel, await loop.bus.consume_outbound())

    frames = [json.loads(call.args[0]) for call in connection.send.await_args_list]
    assert any(frame.get("event") == "delta" and frame.get("text") == "Checking files." for frame in frames)
    assert any(frame.get("kind") in {"tool_hint", "progress"} for frame in frames)
    turn_end = next(frame for frame in frames if frame["event"] == "turn_end")
    final_frames = [frame for frame in frames if frame.get("text") == final_content]
    assert len(final_frames) == 1
    assert frames.index(final_frames[0]) < frames.index(turn_end)
    if mode == "streamed":
        assert final_frames[0]["event"] == "delta"
        assert turn_end["final_stream_id"] == final_frames[0]["stream_id"]
        stream_end = next(frame for frame in frames if frame["event"] == "stream_end"
                          and frame.get("stream_id") == final_frames[0]["stream_id"])
        assert frames.index(final_frames[0]) < frames.index(stream_end) < frames.index(turn_end)
        provider.chat_with_retry.assert_not_awaited()
    else:
        assert final_frames[0]["event"] == "message"
        assert final_frames[0]["final_response"] is True
        assert "final_stream_id" not in turn_end
        provider.chat_with_retry.assert_awaited_once()

    replayed = replay_transcript_to_ui_messages(read_transcript_lines(session_key))
    answers = [message for message in replayed if message.get("isFinalResponse")]
    assert len(answers) == 1
    assert answers[0]["content"] == final_content
    loop.tools.execute.assert_awaited_once()
