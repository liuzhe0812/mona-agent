"""The interaction response contract is scoped to the requesting channel."""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.context import ContextBuilder
from mona.agent.loop import AgentLoop
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.channels.interaction_support import RESPONSE_CONTRACT


def test_interaction_contract_is_user_scoped_and_system_stays_stable(tmp_path: Path) -> None:
    builder = ContextBuilder(workspace=tmp_path)
    text = "请帮我整理今天的工作。"
    interaction = builder.build_messages([], text, channel="interaction", chat_id="one")
    next_interaction = builder.build_messages([], "继续", channel="interaction", chat_id="two")
    ordinary = builder.build_messages([], text, channel="websocket", chat_id="one")

    assert interaction[0]["role"] == "system"
    assert interaction[0]["content"] == next_interaction[0]["content"] == ordinary[0]["content"]
    assert RESPONSE_CONTRACT not in interaction[0]["content"]
    assert RESPONSE_CONTRACT in interaction[-1]["content"]
    assert RESPONSE_CONTRACT not in ordinary[-1]["content"]
    assert interaction[-1]["content"].startswith(text + "\n\n")
    assert interaction[-1]["content"].index(RESPONSE_CONTRACT) < interaction[-1]["content"].index(
        ContextBuilder._RUNTIME_CONTEXT_TAG
    )


@pytest.mark.asyncio
async def test_contract_does_not_change_saved_user_text(tmp_path: Path, monkeypatch) -> None:
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.generation.max_tokens = 4096
    loop = AgentLoop(bus=MessageBus(), provider=provider, workspace=tmp_path, model="test-model")
    loop._sync_computer_use_runtime = AsyncMock()
    loop.consolidator.maybe_consolidate_by_tokens = AsyncMock(return_value=10)
    monkeypatch.setattr(ContextBuilder, "_load_shared_user_profile", staticmethod(lambda _fields=None: ""))

    async def run_turn(messages, **_kwargs):
        return "done", [], [*messages, {"role": "assistant", "content": "done"}], "stop", False

    loop._run_agent_loop = run_turn
    text = "  请按原样保存我的话。  "
    inbound = InboundMessage(channel="interaction", sender_id="user", chat_id="one", content=text)
    await loop._process_message(inbound)

    session = loop.sessions.get_or_create(inbound.session_key)
    assert session.messages[0]["content"] == text
    assert RESPONSE_CONTRACT in session.get_history(model_view=True)[0]["content"]
    await loop.close_mcp()
