"""Billing must use complete native usage receipts, not guessed token counts."""
import asyncio

import pytest

from mona.config.schema import Config
from mona.hosted_work.codex_usage import CodexUsage
from mona.hosted_work.native_provider import HostedNativeWorkProvider
from mona.providers.base import LLMResponse, ToolCallRequest
from mona.providers.native_work_provider import NativeWorkProvider


def make_provider(tmp_path):
    config = Config()
    config.agents.defaults.executor = "codex"
    return HostedNativeWorkProvider(config, tmp_path)


@pytest.fixture
def no_native_start(monkeypatch):
    async def start(*_args, **_kwargs):
        return None

    monkeypatch.setattr(NativeWorkProvider, "_start", start)


def test_inflight_and_parallel_usage_are_not_complete_until_all_finish():
    usage = CodexUsage()
    usage.begin()
    usage.begin()
    usage.add({"prompt_tokens": 9, "cached_tokens": 2, "completion_tokens": 1})
    usage.finish(True)
    assert usage.snapshot()["complete"] is False
    usage.add({"prompt_tokens": 4, "cached_tokens": 1, "completion_tokens": 2})
    usage.finish(True)
    assert usage.snapshot() == {
        "prompt_tokens": 13, "cached_tokens": 3, "completion_tokens": 3, "complete": True,
    }


@pytest.mark.asyncio
async def test_provider_instances_add_only_native_usage_deltas(tmp_path, monkeypatch, no_native_start):
    root = make_provider(tmp_path)
    first, second = root.for_turn(None), root.for_turn(None)
    assert root.billing_usage is first.billing_usage is second.billing_usage
    events = {
        id(first): iter([
            ({"inputTokens": 1000, "cachedInputTokens": 200, "outputTokens": 30}, False),
            ({"inputTokens": 1000, "cachedInputTokens": 200, "outputTokens": 30}, False),
            ({"inputTokens": 1400, "cachedInputTokens": 250, "outputTokens": 50}, True),
        ]),
        id(second): iter([({"inputTokens": 300, "cachedInputTokens": 0, "outputTokens": 7}, True)]),
    }

    async def chat(self, *_args):
        cumulative, done = next(events[id(self)])
        self._update_usage({"tokenUsage": {"total": cumulative}})
        self._done = done
        calls = [] if done else [ToolCallRequest("tool-call", "tool", {})]
        return self._response("done" if done else "", calls)

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    await first._start([], [], "model", None)
    await second._start([], [], "model", None)
    assert root.billing_usage.snapshot()["complete"] is False
    await first._chat([], [], "model", None)
    duplicate = await first._chat([], [], "model", None)
    assert all(duplicate.usage[key] == 0 for key in ("prompt_tokens", "cached_tokens", "completion_tokens"))
    await first._chat([], [], "model", None)
    assert root.billing_usage.snapshot()["complete"] is False
    await second._chat([], [], "model", None)
    assert root.billing_usage.snapshot() == {
        "prompt_tokens": 1700, "cached_tokens": 250, "completion_tokens": 57, "complete": True,
    }


@pytest.mark.parametrize("value", [-1, True, 1.5, "1", None, 2**63])
def test_invalid_receipt_values_cannot_be_settled(value):
    usage = CodexUsage()
    usage.begin()
    usage.add({"prompt_tokens": 8, "cached_tokens": 1, "completion_tokens": value})
    usage.finish(True)
    assert usage.snapshot()["complete"] is False


def test_cache_usage_cannot_exceed_total_input():
    usage = CodexUsage()
    usage.begin()
    usage.add({"prompt_tokens": 8, "cached_tokens": 9, "completion_tokens": 1})
    usage.finish(True)
    assert usage.snapshot()["complete"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("missing", ["inputTokens", "cachedInputTokens", "outputTokens"])
async def test_missing_terminal_receipt_field_is_not_zero(tmp_path, monkeypatch, no_native_start, missing):
    hosted = make_provider(tmp_path)
    usage = {"inputTokens": 8, "cachedInputTokens": 1, "outputTokens": 2}
    usage.pop(missing)

    async def chat(self, *_args):
        self._update_usage({"tokenUsage": {"total": usage}})
        self._done = True
        return self._response("done")

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    await hosted._start([], [], "model", None)
    await hosted._chat([], [], "model", None)
    assert hosted.billing_usage.snapshot()["complete"] is False


@pytest.mark.asyncio
async def test_explicit_zero_receipt_is_valid(tmp_path, monkeypatch, no_native_start):
    hosted = make_provider(tmp_path)

    async def chat(self, *_args):
        self._update_usage({"tokenUsage": {"total": {
            "inputTokens": 0, "cachedInputTokens": 0, "outputTokens": 0,
        }}})
        self._done = True
        return self._response("done")

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    await hosted._start([], [], "model", None)
    await hosted._chat([], [], "model", None)
    assert hosted.billing_usage.snapshot() == {
        "prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0, "complete": True,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["cancelled", "error"])
async def test_unfinished_or_failed_turn_never_looks_settled(tmp_path, monkeypatch, no_native_start, outcome):
    hosted = make_provider(tmp_path)

    async def chat(self, *_args):
        if outcome == "cancelled":
            raise asyncio.CancelledError
        self._done = True
        return LLMResponse(content=None, finish_reason="error", usage={
            "prompt_tokens": 8, "cached_tokens": 1, "completion_tokens": 2,
        })

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    await hosted._start([], [], "model", None)
    if outcome == "cancelled":
        with pytest.raises(asyncio.CancelledError):
            await hosted._chat([], [], "model", None)
    else:
        await hosted._chat([], [], "model", None)
    assert hosted.billing_usage.snapshot()["complete"] is False


@pytest.mark.asyncio
async def test_error_without_an_open_turn_cannot_be_reported_as_complete(tmp_path):
    hosted = make_provider(tmp_path)
    hosted._context_reset_failed = True
    response = await hosted._chat([], [], "model", None)
    assert response.finish_reason == "error"
    assert hosted.billing_usage.snapshot()["complete"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("bad_value", [True, -1])
async def test_malformed_raw_native_usage_is_not_normalized_into_valid_tokens(
    tmp_path, monkeypatch, no_native_start, bad_value,
):
    hosted = make_provider(tmp_path)
    calls = 0

    async def chat(self, *_args):
        nonlocal calls
        calls += 1
        self._update_usage({"tokenUsage": {"total": {
            "inputTokens": 8 if calls == 1 else bad_value, "cachedInputTokens": 0, "outputTokens": 1,
        }}})
        self._done = calls == 2
        return self._response("done" if self._done else "", [] if self._done else [ToolCallRequest("call", "tool", {})])

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    await hosted._start([], [], "model", None)
    await hosted._chat([], [], "model", None)
    await hosted._chat([], [], "model", None)
    assert hosted.billing_usage.snapshot()["complete"] is False


@pytest.mark.asyncio
async def test_decreasing_native_cumulative_receipt_cannot_double_count(tmp_path, monkeypatch, no_native_start):
    hosted = make_provider(tmp_path)
    cumulative = iter([(100, False), (50, False), (100, True)])

    async def chat(self, *_args):
        count, done = next(cumulative)
        self._update_usage({"tokenUsage": {"total": {
            "inputTokens": count, "cachedInputTokens": 0, "outputTokens": 1,
        }}})
        self._done = done
        return self._response("done" if done else "", [] if done else [ToolCallRequest("call", "tool", {})])

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    await hosted._start([], [], "model", None)
    for _ in range(3):
        await hosted._chat([], [], "model", None)
    assert hosted.billing_usage.snapshot()["complete"] is False


@pytest.mark.asyncio
async def test_completed_without_a_fresh_final_usage_receipt_remains_unconfirmed(tmp_path, monkeypatch, no_native_start):
    hosted = make_provider(tmp_path)
    calls = 0

    async def chat(self, *_args):
        nonlocal calls
        calls += 1
        if calls == 1:
            self._update_usage({"tokenUsage": {"total": {
                "inputTokens": 100, "cachedInputTokens": 0, "outputTokens": 1,
            }}})
            return self._response("", [ToolCallRequest("call", "tool", {})])
        self._done = True
        return self._response("done")

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    await hosted._start([], [], "model", None)
    await hosted._chat([], [], "model", None)
    await hosted._chat([], [], "model", None)
    assert hosted.billing_usage.snapshot()["complete"] is False


@pytest.mark.asyncio
async def test_replayed_receipt_after_tool_call_does_not_confirm_final_usage(tmp_path, monkeypatch, no_native_start):
    hosted = make_provider(tmp_path)
    calls = 0

    async def chat(self, *_args):
        nonlocal calls
        calls += 1
        self._update_usage({"tokenUsage": {"total": {
            "inputTokens": 100, "cachedInputTokens": 20, "outputTokens": 5,
        }}})
        self._done = calls == 2
        return self._response("done" if self._done else "", [] if self._done else [ToolCallRequest("call", "tool", {})])

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    await hosted._start([], [], "model", None)
    await hosted._chat([], [], "model", None)
    await hosted._chat([], [], "model", None)
    assert hosted.billing_usage.snapshot() == {
        "prompt_tokens": 100, "cached_tokens": 20, "completion_tokens": 5, "complete": False,
    }
