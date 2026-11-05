"""Title adaptation shares desktop generation and only uses owned context storage."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.config import loader, paths
from mona.hosted_work.titles import update_title
from mona.providers.base import LLMResponse
from mona.session.webui_turns import TITLE_GENERATION_MAX_TOKENS
from tests.hosted_work.test_context import OWNER, SID, create


@pytest.fixture
async def scene(tmp_path, monkeypatch):
    runtime = tmp_path / "state/users" / OWNER / "runtime"
    (runtime / "agents/mona/memory").mkdir(parents=True)
    monkeypatch.setattr(loader, "_current_config_path", runtime / "config.json")
    monkeypatch.setattr("mona.hosted_work.context.get_agent_memory_dir", lambda agent: paths._get_agent_resource_dir(agent, "memory"))
    monkeypatch.setattr(paths, "get_agent_memory_dir", lambda agent: paths._get_agent_resource_dir(agent, "memory"))

    def forbidden(*_args, **_kwargs):
        pytest.fail("Hosted title generation must not construct desktop storage or read a default workspace")

    monkeypatch.setattr("mona.session.manager.get_legacy_sessions_dir", forbidden)
    monkeypatch.setattr(paths, "get_workspace_path", forbidden)
    context, events, _, payload, _ = await create(tmp_path, owner=OWNER, history=[
        {"role": "user", "content": "帮我把会话区做得更清楚"},
        {"role": "assistant", "content": "已整理会话布局并核对结果。"},
    ])
    payload["desktop_ui"] = True
    events.clear()
    provider = SimpleNamespace(chat_with_retry=AsyncMock(return_value=LLMResponse(content='标题：“优化会话布局。”')))
    return SimpleNamespace(ctx=context, payload=payload, provider=provider, events=events,
                           path=runtime / "_consolidation" / (SID + ".json"))


async def test_shared_generator_cleans_title_saves_owned_metadata_and_emits_once(scene):
    e = scene
    assert await update_title(e.ctx, e.payload, e.provider, e.ctx.emit) is True
    assert e.events == [("title", {"title": "优化会话布局"})]
    stored = json.loads(e.path.read_text(encoding="utf-8"))
    assert stored["owner"] == OWNER and stored["session_id"] == SID
    assert stored["metadata"]["webui"] is True and stored["metadata"]["title"] == "优化会话布局"
    kwargs = e.provider.chat_with_retry.await_args.kwargs
    assert kwargs["model"] == e.ctx.selection.model
    assert kwargs["max_tokens"] == TITLE_GENERATION_MAX_TOKENS and kwargs["reasoning_effort"] == "none"
    assert kwargs["tools"] is None
    assert await update_title(e.ctx, e.payload, e.provider, e.ctx.emit) is False
    assert e.provider.chat_with_retry.await_count == 1


@pytest.mark.parametrize("state", ["payload_edited", "metadata_edited", "generated"])
async def test_existing_or_user_edited_title_is_never_regenerated(scene, state):
    e = scene
    if state == "payload_edited":
        e.payload["title_user_edited"] = True
    elif state == "metadata_edited":
        e.ctx.session.metadata["title_user_edited"] = True
    else:
        e.ctx.session.metadata["title"] = "已有生成标题"
    assert await update_title(e.ctx, e.payload, e.provider, e.ctx.emit) is False
    e.provider.chat_with_retry.assert_not_awaited()
    assert e.events == []
    assert json.loads(e.path.read_text(encoding="utf-8"))["metadata"]["webui"] is True


@pytest.mark.parametrize("change", ["no_desktop", "other_owner", "other_session", "other_run", "unscoped"])
async def test_title_is_skipped_outside_the_exact_desktop_owner_context(scene, change):
    e = scene
    payload = dict(e.payload)
    if change == "no_desktop":
        payload["desktop_ui"] = False
    elif change == "other_owner":
        payload["owner"] = "b" * 64
    elif change == "other_session":
        payload["session_id"] = "c" * 32
    elif change == "other_run":
        payload["run_id"] = "d" * 32
    else:
        e.ctx._runtime = None
    assert await update_title(e.ctx, payload, e.provider, e.ctx.emit) is False
    e.provider.chat_with_retry.assert_not_awaited()
    assert "title" not in e.ctx.session.metadata and e.events == []


@pytest.mark.parametrize("response", [
    LLMResponse(content="私有上游错误详情", finish_reason="error", error_status_code=401),
    LLMResponse(content="配额不足的私有详情", finish_reason="stop", error_kind="quota"),
    LLMResponse(content="private refusal content", finish_reason="content_filter"),
    LLMResponse(content="Error: private connection information"),
])
async def test_provider_error_text_never_becomes_a_title(scene, response):
    e = scene
    e.provider.chat_with_retry.return_value = response
    assert await update_title(e.ctx, e.payload, e.provider, e.ctx.emit) is False
    assert "title" not in e.ctx.session.metadata and e.events == []
    assert "私有" not in e.path.read_text(encoding="utf-8")


async def test_timeout_or_provider_failure_skips_title_without_changing_completed_history(scene, monkeypatch):
    e = scene
    history = list(e.ctx.session.messages)
    monkeypatch.setattr("mona.hosted_work.titles.TITLE_TIMEOUT_SECONDS", 0.01)
    cancelled = asyncio.Event()

    async def slow(*_args, **_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    e.provider.chat_with_retry.side_effect = slow
    assert await update_title(e.ctx, e.payload, e.provider, e.ctx.emit) is False
    assert cancelled.is_set() and e.ctx.session.messages == history and e.events == []
    e.provider.chat_with_retry.side_effect = OSError("private provider exception")
    assert await update_title(e.ctx, e.payload, e.provider, e.ctx.emit) is False
    assert e.ctx.session.messages == history and "title" not in e.ctx.session.metadata and e.events == []


async def test_explicit_cancellation_propagates_instead_of_completing_title(scene):
    e = scene
    started = asyncio.Event()

    async def waiting(*_args, **_kwargs):
        started.set()
        await asyncio.Event().wait()

    e.provider.chat_with_retry.side_effect = waiting
    task = asyncio.create_task(update_title(e.ctx, e.payload, e.provider, e.ctx.emit))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert "title" not in e.ctx.session.metadata and e.events == []
