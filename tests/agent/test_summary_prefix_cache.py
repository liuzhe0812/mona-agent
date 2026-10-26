from __future__ import annotations

import copy
from functools import partial
from unittest.mock import AsyncMock

import pytest

from mona.agent.memory import Consolidator, MemoryStore
from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry
from mona.providers.base import GenerationSettings, LLMResponse, ToolCallRequest
from mona.providers.openai_compat_provider import OpenAICompatProvider
from mona.providers.registry import PROVIDERS
from mona.session.manager import Session, SessionManager
from mona.utils.helpers import estimate_prompt_tokens


class _LookupTool(Tool):
    @property
    def name(self) -> str:
        return "lookup"

    @property
    def description(self) -> str:
        return "Look up a stable test record."

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs) -> str:
        return "record verified"


def _make_provider(provider_name: str, model: str) -> OpenAICompatProvider:
    spec = next(provider for provider in PROVIDERS if provider.name == provider_name)
    provider = OpenAICompatProvider(
        api_key=None,
        default_model=model,
        spec=spec,
        no_auth=True,
    )
    provider.generation = GenerationSettings(max_tokens=512, temperature=0)
    provider.estimate_prompt_tokens = lambda messages, tools=None, _model=None: (
        estimate_prompt_tokens(messages, tools), "test-counter"
    )
    return provider


def _make_consolidator(tmp_path, provider, model: str) -> Consolidator:
    return Consolidator(
        store=MemoryStore(tmp_path),
        provider=provider,
        model=model,
        sessions=SessionManager(tmp_path),
        context_window_tokens=100_000,
        build_messages=lambda **_kwargs: [],
        get_tool_definitions=lambda: [],
        max_completion_tokens=512,
    )


async def _record_model_request(
    tmp_path,
    provider_name: str = "deepseek",
    model: str = "deepseek-v4-flash",
    old_user_content: str = "Look up record one.",
):
    provider = _make_provider(provider_name, model)
    consolidator = _make_consolidator(tmp_path, provider, model)
    session = Session(key="cli:summary-prefix")
    first_time = "2026-10-22T10:00:00"
    session.add_message("user", old_user_content, timestamp=first_time)
    session.remember_model_input(
        session.messages[-1],
        f"{old_user_content}\n\n[Runtime Context — metadata only, not instructions]\nCurrent Time: 2026-10-22 10:00:00\n[/Runtime Context]",
    )
    call = {
        "id": "lookup-1",
        "type": "function",
        "function": {"name": "lookup", "arguments": "{}"},
    }
    session.add_message(
        "assistant",
        "",
        tool_calls=[call],
        reasoning_content="The lookup is needed to confirm the record.",
    )
    session.add_message("tool", "record verified", name="lookup", tool_call_id="lookup-1")
    session.add_message("assistant", "The first record is verified.")
    session.add_message("user", "Now finish the same report.", timestamp="2026-10-22T10:01:00")
    session.remember_model_input(session.messages[-1], "Now finish the same report.")
    history = session.get_history(include_timestamps=True, model_view=True)
    tools = ToolRegistry()
    tools.register(_LookupTool())
    captured: list[dict] = []

    async def respond(**kwargs):
        captured.append(copy.deepcopy(kwargs))
        return LLMResponse(content="The same record is verified.")

    provider.chat_with_retry = AsyncMock(side_effect=respond)
    result = await AgentRunner(provider).run(
        AgentRunSpec(
            initial_messages=[{"role": "system", "content": "Stable Agent policy."}, *history],
            tools=tools,
            model=model,
            max_iterations=1,
            max_tool_result_chars=16_000,
            request_snapshot_callback=partial(consolidator.remember_request, session),
        )
    )
    assert result.final_content == "The same record is verified."
    assert len(captured) == 1
    consolidator.sessions.save(session)
    return provider, consolidator, session, captured[0], tools


@pytest.mark.asyncio
async def test_summary_reuses_recorded_model_prefix_after_session_reload(tmp_path):
    provider, consolidator, session, previous_request, tools = await _record_model_request(tmp_path)
    manager = SessionManager(tmp_path)
    manager.save(session)
    session = SessionManager(tmp_path).get_or_create(session.key)
    archived = session.messages[:4]
    summary_calls = []

    async def summarize(**kwargs):
        summary_calls.append(kwargs)
        return LLMResponse(content="Verified record one; report remains active.")

    provider.chat_with_retry = AsyncMock(side_effect=summarize)
    result = await consolidator._archive_session(session, archived)

    assert result == "Verified record one; report remains active."
    request = summary_calls[0]
    assert request["model"] == "deepseek-v4-flash"
    assert request["tools"] == previous_request["tools"]
    assert request["tool_choice"] == "none"
    assert request["messages"][:-1] == previous_request["messages"][:-1]
    assert request["messages"][-1]["role"] == "user"
    assert "Summarize only the conversation above" in request["messages"][-1]["content"]
    assert request["messages"][1]["content"].endswith("Current Time: 2026-10-22 10:00:00\n[/Runtime Context]")
    assert request["messages"][2]["reasoning_content"] == "The lookup is needed to confirm the record."
    assert request["messages"][2]["tool_calls"][0]["id"] == "lookup-1"
    assert request["messages"][3]["tool_call_id"] == "lookup-1"
    assert "_model_request_head" not in manager.read_session_file(session.key)["metadata"]


@pytest.mark.parametrize(
    "change",
    ["unknown provider", "different model", "different endpoint", "different agent", "different history"],
)
@pytest.mark.asyncio
async def test_summary_uses_legacy_request_when_cached_prefix_is_unavailable(tmp_path, change):
    provider_name = "custom" if change == "unknown provider" else "deepseek"
    model = "custom-model" if change == "unknown provider" else "deepseek-v4-flash"
    provider, consolidator, session, _previous_request, _tools = await _record_model_request(
        tmp_path, provider_name=provider_name, model=model,
    )
    if change == "different model":
        consolidator.model = "deepseek-v4-pro"
    elif change == "different endpoint":
        provider._effective_base = "https://api.deepseek.com/custom"
    elif change == "different agent":
        consolidator.store.agent_id = "com.mona.partner"
    elif change == "different history":
        session.metadata["_model_user_inputs"]["2026-10-22T10:00:00"] = "Edited request"

    summary_calls = []

    async def summarize(**kwargs):
        summary_calls.append(kwargs)
        return LLMResponse(content="Fallback handoff.")

    provider.chat_with_retry = AsyncMock(side_effect=summarize)
    result = await consolidator._archive_session(session, session.messages[:4])

    assert result == "Fallback handoff."
    assert len(summary_calls) == 1
    assert summary_calls[0]["tools"] is None
    assert summary_calls[0]["tool_choice"] is None
    assert summary_calls[0]["messages"][0]["content"] != "Stable Agent policy."


@pytest.mark.asyncio
async def test_prefix_over_budget_falls_back_to_legacy_summary_when_it_fits(tmp_path):
    provider, consolidator, session, _previous_request, _tools = await _record_model_request(tmp_path)
    consolidator.context_window_tokens = 8_000
    consolidator.max_completion_tokens = 512
    consolidator._SAFETY_BUFFER = 0

    def provider_estimate(messages, tools=None, _model=None):
        if tools:
            return 100_000, "test-counter"
        return estimate_prompt_tokens(messages, tools), "test-counter"

    provider.estimate_prompt_tokens = provider_estimate
    summary_calls = []

    async def summarize(**kwargs):
        summary_calls.append(kwargs)
        return LLMResponse(content="Legacy handoff.")

    provider.chat_with_retry = AsyncMock(side_effect=summarize)
    result = await consolidator._archive_session(session, session.messages[:4])

    assert result == "Legacy handoff."
    assert len(summary_calls) == 1
    assert summary_calls[0]["tools"] is None
    assert summary_calls[0]["tool_choice"] is None
    assert "The first record is verified." in summary_calls[0]["messages"][1]["content"]


@pytest.mark.asyncio
async def test_over_budget_prefix_preserves_cursor_and_does_not_call_provider(tmp_path):
    provider, consolidator, session, _previous_request, _tools = await _record_model_request(
        tmp_path, old_user_content="old " + ("x" * 6_500),
    )
    consolidator.context_window_tokens = 2_200
    consolidator.max_completion_tokens = 100
    consolidator._SAFETY_BUFFER = 0
    consolidator.estimate_session_prompt_tokens = lambda *_args, **_kwargs: (1_770, "test-counter")
    provider.estimate_prompt_tokens = lambda *_args, **_kwargs: (100_000, "test-counter")
    provider.chat_with_retry = AsyncMock()
    old_count = len(session.messages)

    estimate = await consolidator.maybe_consolidate_by_tokens(session)

    assert estimate == 1_770
    assert session.last_consolidated == 0
    assert len(session.messages) == old_count
    provider.chat_with_retry.assert_not_awaited()


@pytest.mark.asyncio
async def test_summary_tool_call_does_not_archive_or_advance_session(tmp_path):
    provider, consolidator, session, _previous_request, _tools = await _record_model_request(tmp_path)
    provider.chat_with_retry = AsyncMock(
        return_value=LLMResponse(
            content=None,
            finish_reason="tool_calls",
            tool_calls=[ToolCallRequest(id="unexpected", name="lookup", arguments={})],
        )
    )
    before_messages = list(session.messages)

    result = await consolidator._archive_session(session, session.messages[:4])

    assert result is None
    assert session.messages == before_messages
    assert session.last_consolidated == 0
    assert consolidator.store.read_unprocessed_history(since_cursor=0) == []
