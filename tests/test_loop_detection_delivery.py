"""Regression coverage for loop-stop delivery and mid-turn input provenance."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from mona.agent.loop import AgentLoop
from mona.agent.tools.message import MessageTool
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.providers.base import LLMResponse


def _make_loop(tmp_path):
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    with patch("mona.agent.loop.ContextBuilder"), \
         patch("mona.agent.loop.SessionManager"), \
         patch("mona.agent.loop.SubagentManager"):
        loop = AgentLoop(bus=MessageBus(), provider=provider, workspace=tmp_path)
    loop.tools.get_definitions = MagicMock(return_value=[])
    return loop


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("channel", "sender_id", "expected_source"),
    [("system", "worker", "runtime"), ("cli", "subagent", "runtime"), ("cli", "user", None)],
)
async def test_loop_marks_only_internal_pending_messages_as_runtime(
    tmp_path, channel, sender_id, expected_source,
):
    loop = _make_loop(tmp_path)
    loop.context._build_user_content.side_effect = lambda content, media: content
    loop.provider.chat_with_retry = AsyncMock(side_effect=[
        LLMResponse(content="first answer"),
        LLMResponse(content="second answer"),
    ])
    pending = asyncio.Queue()
    pending.put_nowait(InboundMessage(
        channel=channel, sender_id=sender_id, chat_id="c", content="follow-up",
    ))

    final, _, messages, _, had_injections = await loop._run_agent_loop(
        [{"role": "user", "content": "start"}], pending_queue=pending,
    )

    assert final == "second answer"
    assert had_injections is True
    injected = next(message for message in messages if message.get("content") == "follow-up")
    assert injected.get("source_kind") == expected_source
    if expected_source is None:
        assert injected == {"role": "user", "content": "follow-up"}


@pytest.mark.parametrize("stop_reason", ["loop_detected", "completed"])
def test_loop_stop_notice_survives_an_earlier_message_tool_reply(tmp_path, stop_reason):
    loop = _make_loop(tmp_path)
    message_tool = loop.tools.get("message")
    assert isinstance(message_tool, MessageTool)
    message_tool._sent_in_turn = True
    notice = "重复操作未产生新进展，任务已停止。"

    outbound = loop._assemble_outbound(
        InboundMessage(channel="cli", sender_id="user", chat_id="c", content="start"),
        notice, [], stop_reason, False, None,
    )

    if stop_reason == "loop_detected":
        assert outbound is not None
        assert outbound.content == notice
    else:
        assert outbound is None


@pytest.mark.asyncio
async def test_loop_detection_delivers_the_final_stream_once(tmp_path):
    loop = _make_loop(tmp_path)
    loop.provider.chat_stream_with_retry = AsyncMock(return_value=LLMResponse(
        content="400 InternalError.Algo.InvalidParameter: Repetitive tool calls detected in the conversation history.",
        finish_reason="error",
    ))
    loop.provider.chat_with_retry = AsyncMock(return_value=LLMResponse(content="已有结果已保留。"))
    on_stream = AsyncMock()
    on_stream_end = AsyncMock()

    final, _, _, stop_reason, _ = await loop._run_agent_loop(
        [], on_stream=on_stream, on_stream_end=on_stream_end,
    )

    assert stop_reason == "loop_detected"
    assert "已有结果已保留。" in final
    on_stream.assert_awaited_once_with(final)
    on_stream_end.assert_awaited_once_with(resuming=False)
    loop.provider.chat_with_retry.assert_awaited_once()
    assert loop.provider.chat_with_retry.await_args.kwargs["tools"] is None
