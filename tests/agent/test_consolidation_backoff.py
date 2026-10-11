"""Regression tests for repeated Work consolidation failures."""

import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from loguru import logger

from mona.agent.memory import Consolidator, MemoryStore
from mona.providers.base import LLMResponse
from mona.session.manager import SessionManager


@pytest.fixture
def store(tmp_path):
    return MemoryStore(tmp_path)


@pytest.fixture
def mock_provider():
    provider = MagicMock()
    provider.chat_with_retry = AsyncMock()
    return provider


class TestConsolidationFailureBackoff:
    @pytest.fixture
    def runtime(self, store, mock_provider, monkeypatch):
        clock = SimpleNamespace(now=100.0)
        monkeypatch.setattr("mona.agent.memory.time", SimpleNamespace(monotonic=lambda: clock.now))
        sessions = SessionManager(store.workspace)
        consolidator = Consolidator(
            store=store,
            provider=mock_provider,
            model="test-model",
            sessions=sessions,
            context_window_tokens=10_000,
            build_messages=lambda **kwargs: kwargs["history"],
            get_tool_definitions=lambda: [],
            max_completion_tokens=100,
        )
        session = sessions.get_or_create("websocket:backoff")
        for i in range(10):
            session.add_message("user", f"u{i}")
            session.add_message("assistant", f"a{i}")
        session.metadata["_last_summary"] = {"text": "Prior handoff"}
        sessions.save(session)
        mock_provider.chat_with_retry.return_value = LLMResponse(
            content="Unavailable", finish_reason="error", error_kind="connection",
        )
        mock_provider.estimate_prompt_tokens.return_value = (12_000, "test")
        return consolidator, session, clock

    async def test_failure_preserves_context_and_retries_after_cooldown(
        self, runtime, mock_provider,
    ):
        consolidator, session, clock = runtime
        original = deepcopy(session.messages)
        progress = AsyncMock()
        for _ in range(2):
            await consolidator.maybe_consolidate_by_tokens(
                session, on_compaction=progress,
            )
        assert mock_provider.chat_with_retry.await_count == 1
        assert [call.args[0] for call in progress.await_args_list] == [True, False]
        consolidator.sessions.invalidate(session.key)
        saved = consolidator.sessions.get_or_create(session.key)
        assert saved.messages == original
        assert saved.last_consolidated == 0
        assert saved.metadata["_last_summary"]["text"] == "Prior handoff"

        clock.now += consolidator._FAILURE_RETRY_DELAY_SECONDS
        mock_provider.chat_with_retry.return_value = LLMResponse(content="Recovered handoff")
        mock_provider.estimate_prompt_tokens.side_effect = [(12_000, "test"), (100, "test")]
        await consolidator.maybe_consolidate_by_tokens(
            saved,
        )
        assert saved.last_consolidated > 0
        assert saved.metadata["_last_summary"]["text"] == "Recovered handoff"
        assert saved.messages == original

    async def test_waiter_does_not_repeat_failed_background_archive(self, runtime, mock_provider):
        consolidator, session, _clock = runtime
        started, release = asyncio.Event(), asyncio.Event()

        async def fail_archive(**kwargs):
            started.set()
            await release.wait()
            return LLMResponse(content="Unavailable", finish_reason="error")

        mock_provider.chat_with_retry.side_effect = fail_archive
        background = asyncio.create_task(
            consolidator.maybe_consolidate_by_tokens(session),
        )
        await asyncio.wait_for(started.wait(), timeout=2)
        foreground = asyncio.create_task(
            consolidator.maybe_consolidate_by_tokens(session),
        )
        await asyncio.sleep(0)
        release.set()
        await asyncio.wait_for(asyncio.gather(background, foreground), timeout=2)
        assert mock_provider.chat_with_retry.await_count == 1
        assert session.last_consolidated == 0

    async def test_other_session_and_changed_model_can_retry(self, runtime, mock_provider):
        consolidator, session, _clock = runtime
        await consolidator.maybe_consolidate_by_tokens(session)
        other = consolidator.sessions.get_or_create("websocket:other")
        other.messages = deepcopy(session.messages)
        mock_provider.chat_with_retry.return_value = LLMResponse(content="Recovered handoff")
        mock_provider.estimate_prompt_tokens.side_effect = [(12_000, "test"), (100, "test")]
        await consolidator.maybe_consolidate_by_tokens(other)
        assert other.last_consolidated > 0
        assert session.last_consolidated == 0

        mock_provider.generation.max_tokens = 100
        consolidator.set_provider(mock_provider, "test-model", 10_000)
        await consolidator.maybe_consolidate_by_tokens(session)
        assert session.last_consolidated == 0
        consolidator.set_provider(mock_provider, "replacement-model", 10_000)
        mock_provider.estimate_prompt_tokens.side_effect = [(12_000, "test"), (100, "test")]
        await consolidator.maybe_consolidate_by_tokens(session)
        assert session.last_consolidated > 0

    async def test_old_model_failure_does_not_delay_replacement(self, runtime, mock_provider):
        consolidator, session, _clock = runtime

        async def fail_after_model_switch(**kwargs):
            consolidator.set_provider(mock_provider, "replacement-model", 10_000)
            return LLMResponse(content="Unavailable", finish_reason="error")

        mock_provider.generation.max_tokens = 100
        mock_provider.chat_with_retry.side_effect = fail_after_model_switch
        await consolidator.maybe_consolidate_by_tokens(session)
        mock_provider.chat_with_retry.side_effect = None
        mock_provider.chat_with_retry.return_value = LLMResponse(content="Recovered handoff")
        mock_provider.estimate_prompt_tokens.side_effect = [(12_000, "test"), (100, "test")]
        await consolidator.maybe_consolidate_by_tokens(session)
        assert session.last_consolidated > 0

    @pytest.mark.parametrize("raises", [False, True])
    async def test_failure_diagnostics_omit_private_content(self, runtime, mock_provider, raises):
        consolidator, session, _clock = runtime
        private_text = "private upstream response body"
        if raises:
            mock_provider.chat_with_retry.side_effect = RuntimeError(private_text)
            expected = "exception=RuntimeError"
        else:
            mock_provider.chat_with_retry.return_value = LLMResponse(
                content=private_text, finish_reason="error", error_status_code=429,
                error_kind="rate_limit",
            )
            expected = "status=429, kind=rate_limit"
        logs = []
        sink = logger.add(logs.append, format="{message}")
        try:
            await consolidator.maybe_consolidate_by_tokens(session)
        finally:
            logger.remove(sink)
        output = "".join(logs)
        assert expected in output
        assert private_text not in output
