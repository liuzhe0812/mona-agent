"""Regression tests for token-based model history replay."""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.loop import AgentLoop
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.config.schema import AgentDefaults
from mona.providers.base import GenerationSettings, LLMResponse
from mona.session.manager import Session


def _populated_session(n: int) -> Session:
    session = Session(key="cli:test")
    for i in range(n):
        session.add_message("user", f"msg-{i}")
        session.add_message("assistant", f"reply-{i}")
    return session


@pytest.mark.parametrize("limit", [20, 25])
def test_explicit_history_count_limit_keeps_a_user_boundary(limit: int) -> None:
    history = _populated_session(80).get_history(max_messages=limit)
    assert len(history) <= limit
    assert history[0]["role"] == "user"


@pytest.mark.asyncio
async def test_low_token_request_replays_the_goal_beyond_120_messages(tmp_path: Path) -> None:
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.generation = GenerationSettings(max_tokens=8192)
    provider.estimate_prompt_tokens.return_value = (31_000, "test-counter")
    response = LLMResponse(content="ok", tool_calls=[])
    provider.chat_with_retry = AsyncMock(return_value=response)
    provider.chat_stream_with_retry = AsyncMock(return_value=response)
    loop = AgentLoop(
        bus=MessageBus(),
        provider=provider,
        workspace=tmp_path,
        model="test-model",
        context_window_tokens=1_000_000,
    )
    loop.tools.get_definitions = MagicMock(return_value=[])
    loop._schedule_background = lambda coro: coro.close()
    session = loop.sessions.get_or_create("cli:test")
    session.messages = _populated_session(80).messages
    loop.sessions.save(session)

    result = await loop._process_message(
        InboundMessage(channel="cli", sender_id="user", chat_id="test", content="continue")
    )

    assert result is not None
    provider.chat_with_retry.assert_awaited_once()
    sent = provider.chat_with_retry.call_args.kwargs["messages"]
    assert any("msg-0" in str(message.get("content")) for message in sent)
    assert any("msg-79" in str(message.get("content")) for message in sent)
    assert session.last_consolidated == 0


def test_obsolete_saved_message_cap_does_not_restore_runtime_truncation() -> None:
    defaults = AgentDefaults.model_validate({"maxMessages": 120})
    assert "maxMessages" not in defaults.model_dump(by_alias=True)
