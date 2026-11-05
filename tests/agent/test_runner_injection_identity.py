"""Input identity retention is independent of a model-context projection."""
from __future__ import annotations

import copy
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.registry import ToolRegistry
from mona.providers.base import LLMResponse

_INPUTS = [
    {"role": "user", "content": "  Keep the first text\nexactly.  ", "id": "input-first", "source_kind": "steering"},
    {"role": "user", "content": "Second input\n\nkeeps its own body.", "id": "input-second", "source_kind": "steering"},
]


@pytest.mark.asyncio
@pytest.mark.parametrize("preserve", [False, True])
async def test_same_batch_keeps_input_ids_only_when_explicitly_enabled(preserve):
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(side_effect=[LLMResponse("Tentative reply"), LLMResponse("Reviewed reply")])
    pending = copy.deepcopy(_INPUTS)

    async def injection(*, limit, phase):
        assert phase == "after final response"
        batch, pending[:] = pending[:limit], pending[limit:]
        return batch

    options = {"preserve_injection_identity": True} if preserve else {}
    spec = AgentRunSpec(
        initial_messages=[{"role": "system", "content": "Stable system"}, {"role": "user", "content": "Original"}],
        tools=ToolRegistry(), model="model", max_iterations=3, max_tool_result_chars=1000,
        injection_callback=injection, strict_injections=True, **options,
    )
    assert spec.model_context_callback is None
    result = await AgentRunner(provider).run(spec)
    assert result.stop_reason == "completed" and result.final_content == "Reviewed reply"
    assert result.had_injections and provider.chat_with_retry.await_count == 2
    identified = [message for message in result.messages if message.get("id")]
    if preserve:
        assert identified == _INPUTS
    else:
        assert spec.preserve_injection_identity is False
        assert identified == [{**_INPUTS[0], "content": _INPUTS[0]["content"] + "\n\n" + _INPUTS[1]["content"]}]


@pytest.mark.asyncio
@pytest.mark.parametrize("preserve", [False, True])
async def test_terminal_balance_path_retains_identified_inputs_without_a_new_model_call(preserve):
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock(return_value=LLMResponse(
        "balance exhausted", finish_reason="error", error_status_code=402,
    ))
    pending = copy.deepcopy(_INPUTS)

    async def injection(*, limit, phase):
        assert phase == "balance exhausted"
        batch, pending[:] = pending[:limit], pending[limit:]
        return batch

    result = await AgentRunner(provider).run(AgentRunSpec(
        initial_messages=[{"role": "user", "content": "Original"}], tools=ToolRegistry(), model="model",
        max_iterations=3, max_tool_result_chars=1000, injection_callback=injection,
        strict_injections=True, preserve_injection_identity=preserve,
    ))
    assert result.stop_reason == "error" and result.had_injections
    assert provider.chat_with_retry.await_count == 1 and pending == []
    if preserve:
        assert [message for message in result.messages if message.get("id")] == _INPUTS
        assert result.messages[0] == {"role": "user", "content": "Original"}
    else:
        assert not any(message.get("id") for message in result.messages)
        assert result.messages[0]["content"] == "Original\n\n" + "\n\n".join(item["content"] for item in _INPUTS)


@pytest.mark.asyncio
async def test_existing_context_projection_still_retains_ids_with_default_flag():
    async def injection():
        return copy.deepcopy(_INPUTS)

    spec = AgentRunSpec([], ToolRegistry(), "model", 1, 1000, injection_callback=injection,
                        model_context_callback=AsyncMock())
    assert spec.preserve_injection_identity is False
    messages = [{"role": "user", "content": "Original"}]
    continued, cycles = await AgentRunner(MagicMock())._try_drain_injections(spec, messages, None, 0)
    assert continued and cycles == 1
    assert messages == [{"role": "user", "content": "Original"}, *_INPUTS]


@pytest.mark.asyncio
@pytest.mark.parametrize("preserve", [False, True])
async def test_runtime_followup_cannot_change_an_identified_user_record_when_preserved(preserve):
    runtime = {"role": "user", "content": "A child result", "source_kind": "runtime"}

    async def injection():
        return [runtime]

    spec = AgentRunSpec([], ToolRegistry(), "model", 1, 1000, injection_callback=injection,
                        preserve_injection_identity=preserve)
    messages = [copy.deepcopy(_INPUTS[0])]
    continued, _cycles = await AgentRunner(MagicMock())._try_drain_injections(spec, messages, None, 0)
    assert continued
    if preserve:
        assert messages == [_INPUTS[0], runtime]
    else:
        assert messages == [{**_INPUTS[0], "content": _INPUTS[0]["content"] + "\n\n" + runtime["content"]}]
