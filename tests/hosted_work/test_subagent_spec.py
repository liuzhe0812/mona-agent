"""Fresh hosted tools and shared subagent prompts without private desktop I/O."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.hook import AgentHook, AgentHookContext
from mona.agent.runner import AgentRunner
from mona.bus.events import OutboundMessage
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, owner_key
from mona.hosted_work.editor_tools import build_editor_tools
from mona.hosted_work.subagent_spec import build_subagent_factory
from mona.hosted_work.tools import HostedTool, HostedTools
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.providers.context_window import ResolvedContextWindow
from mona.session.manager import Session

SID, RUN = "a" * 32, "b" * 32


def _fixture(tmp_path, *, owner=None, provider=None):
    config = HostedWorkConfig(
        state_dir=str(tmp_path / "state"), public_origin="https://mona-ai.cn", auth_origin="https://mona-ai.cn",
        max_iterations=7, run_timeout_seconds=45,
        models={"free": {"label": "Configured model", "model": "configured-model", "max_output_tokens": 3072,
                          "reasoning_effort": "high", "context_window_tokens": 100_000}},
    )
    payload = {"owner": owner, "session_id": SID, "run_id": RUN, "model_id": "free", "desktop_ui": True,
               "account_token": "synthetic-test-session",
               "metadata": {"ui_theme": "dark", "office_session_id": "office_current",
                            "office_document_type": "slides", "office_display_name": "Current deck",
                            "original_command": "/goal", "goal_started_at": 1},
               "attachments": [{"path": "reference.txt"}],
               "history": [{"role": "user", "content": "Private parent history"}]}
    ctx = SimpleNamespace(
        owner=owner, config=config, selection=config.models["free"], session_id=SID,
        session=Session("websocket:" + SID, metadata={"goal_state": {"objective": "Parent objective"}}),
        provider=provider, window=ResolvedContextWindow(262_144, "catalog"), builder=SimpleNamespace(timezone="UTC"),
    )
    sandbox = SimpleNamespace(config=config, execute=AsyncMock(),
                              file=AsyncMock(return_value={"path": "child.txt", "name": "child.txt",
                                                           "size": 3, "sha256": "c" * 64}))
    return ctx, payload, sandbox, AsyncMock(), {"channel": "websocket", "chat_id": SID,
                                               "session_key": ctx.session.key}


def _editor(name):
    return HostedTool(name, "fixture", {}, [], AsyncMock(return_value="ok"))


@pytest.mark.asyncio
async def test_fresh_child_capabilities_skills_and_shared_prompt_keep_parent_context_private(tmp_path, monkeypatch):
    ctx, payload, sandbox, emit, origin = _fixture(tmp_path)

    def forbidden(*_args, **_kwargs):
        pytest.fail("child specs must not create private desktop context or storage")

    for target in (
        "mona.agent.context.ContextBuilder.__init__", "mona.agent.memory.MemoryStore.__init__",
        "mona.session.manager.SessionManager.__init__", "mona.agent.partners.AgentRegistry.__init__",
        "mona.config.paths.get_agent_skills_dir", "mona.config.paths.get_data_dir",
    ):
        monkeypatch.setattr(target, forbidden)
    clock = ["first time"]
    monkeypatch.setattr("mona.agent.context.current_time_str", lambda _timezone: clock[0])
    editors = (_editor("office"), _editor("canvas"), _editor("ask_user_question"), _editor("spawn"))
    parent = HostedTools(sandbox, emit, editors[:2], session_id=SID, config=ctx.config)
    await parent.registry.execute("load_capability", {"capabilities": ["development"]})
    assert parent.registry.is_visible("write_file")
    factory, children = build_subagent_factory(ctx, payload, sandbox, None, emit, None, editors)
    assert parent.registry.is_visible("write_file") and children == []

    async def first_child():
        spec = await factory("child-1", "Review the deck", origin, AgentHook(), AsyncMock())
        assert not spec.tools.is_visible("write_file")
        await spec.tools.execute("skill_read", {"name": "prd-document"})
        assert spec.tools.is_visible("skill_reference_read")
        return spec

    first = await asyncio.create_task(first_child())
    clock[0] = "second time"
    second = await asyncio.create_task(factory("child-2", "Review the deck", origin, AgentHook(), AsyncMock()))
    assert parent.registry.is_visible("write_file") and not parent.registry.is_visible("skill_reference_read")
    assert not second.tools.is_visible("skill_reference_read")
    assert children[0].skills.loaded == {"prd-document"} and children[1].skills.loaded == set()
    assert children[0].registry.get("read_file") is not children[1].registry.get("read_file")
    assert children[0].pending_delivery_files is not children[1].pending_delivery_files
    assert first.initial_messages[0] == second.initial_messages[0]
    assert "first time" in first.initial_messages[1]["content"]
    assert "second time" in second.initial_messages[1]["content"]
    user_content = first.initial_messages[1]["content"]
    assert "Active Office Document: Current deck" in user_content and "reference.txt" in user_content
    full = str(first.initial_messages)
    assert "Private parent history" not in full and "Parent objective" not in full
    assert "original_command" not in full and payload["account_token"] not in full
    assert str(tmp_path) not in full and "Ubuntu" not in full
    for tool in ("ask_user_question", "long_task", "complete_goal", "update_plan", "spawn", "browser_act", "terminal_exec"):
        assert not first.tools.has(tool)
    assert {row["name"]: row["available"] for row in children[0].skills.catalog()}["long-goal"] is False
    assert list(tmp_path.iterdir()) == []


@pytest.mark.asyncio
async def test_specs_use_parent_verified_limits_and_preserve_shared_callbacks(tmp_path):
    ctx, payload, sandbox, emit, origin = _fixture(tmp_path)
    authorize, checkpoint, progress = AsyncMock(), AsyncMock(), AsyncMock()
    shared = AgentHook()
    shared.before_iteration = AsyncMock()
    factory, children = build_subagent_factory(ctx, payload, sandbox, None, emit, authorize,
                                               progress_callback=progress)
    spec = await factory("child-1", "Inspect", origin, shared, checkpoint)
    assert spec.model == ctx.selection.model
    assert spec.max_tokens == 3072 and spec.reasoning_effort == "high"
    assert spec.context_window_tokens == 262_144 and spec.context_window_verified
    assert spec.context_block_limit == 100_000 and spec.context_provider == "mona_managed"
    assert spec.max_tool_result_chars == 100_000 and spec.max_iterations == 7
    assert spec.concurrent_tools and spec.max_parallel_tool_calls == 10 and not spec.fail_on_tool_error
    assert spec.llm_timeout_s is None and not spec.enforce_llm_timeout_for_streaming
    assert spec.checkpoint_callback is checkpoint and spec.progress_callback is progress
    assert spec.session_key == ctx.session.key and spec.model_context_callback is None
    assert spec.request_snapshot_callback is None and spec.injection_callback is None
    assert not spec.hook.wants_streaming()
    context = AgentHookContext(0, spec.initial_messages)
    await spec.hook.before_iteration(context)
    authorize.assert_awaited_once()
    shared.before_iteration.assert_awaited_once_with(context)
    assert len(children) == 1
    ctx.window = ResolvedContextWindow(1_000_000, "default")
    unknown = await factory("child-2", "Inspect", origin, shared, checkpoint)
    assert unknown.context_window_tokens == 1_000_000 and not unknown.context_window_verified


@pytest.mark.asyncio
async def test_authorization_failure_propagates_before_tool_execution(tmp_path):
    class Provider(LLMProvider):
        async def chat(self, messages, **kwargs):
            return LLMResponse(None, [ToolCallRequest("call-1", "list_dir", {})])

        def get_default_model(self):
            return "configured-model"

    provider = Provider()
    ctx, payload, sandbox, emit, origin = _fixture(tmp_path, provider=provider)
    authorize = AsyncMock(side_effect=[None, WorkError("revoked", "登录已失效。", 401)])
    factory, _children = build_subagent_factory(ctx, payload, sandbox, provider, emit, authorize)
    spec = await factory("child-1", "List files", origin, AgentHook(), AsyncMock())
    with pytest.raises(WorkError, match="登录已失效"):
        await AgentRunner(provider).run(spec)
    assert authorize.await_count == 2
    sandbox.file.assert_not_awaited()


@pytest.mark.asyncio
async def test_production_editors_are_fresh_but_parent_can_deliver_verified_child_export(tmp_path):
    ctx, payload, sandbox, emit, origin = _fixture(tmp_path, owner=owner_key("101"))
    sandbox.owner, sandbox.run_id = ctx.owner, RUN
    parent_editors = build_editor_tools(ctx.config, payload, emit, sandbox=sandbox)
    parent = HostedTools(sandbox, emit, parent_editors, session_id=SID, config=ctx.config)
    factory, children = build_subagent_factory(ctx, payload, sandbox, None, emit, None, parent_editors)
    first = await factory("child-1", "Export deck", origin, AgentHook(), AsyncMock())
    second = await factory("child-2", "Review deck", origin, AgentHook(), AsyncMock())
    main_office, child_office, other_office = parent_editors[1], first.tools.get("office"), second.tools.get("office")
    assert child_office is not main_office and child_office is not other_office
    assert child_office.sandbox is main_office.sandbox is sandbox
    assert child_office._delivery_bus is not main_office._delivery_bus
    assert child_office._delivery_bus.delivered is main_office._delivery_bus.delivered
    assert child_office._working_copies is not main_office._working_copies
    child_office._active_session_id = "different_doc"
    assert main_office._active_session_id == "office_current"
    child_office._delivery_bus.expected_delivery = {"test": (1, "hash")}
    assert main_office._delivery_bus.expected_delivery is None
    child_office._delivery_bus.expected_delivery = None
    exported = main_office.scope.root / "deck.pptx"
    exported.write_bytes(b"synthetic exported document bytes")
    await child_office._delivery_bus.publish_outbound(OutboundMessage(
        "websocket", SID, "", metadata={"_deliver_files": [{"path": str(exported), "name": "deck.pptx"}]},
    ))
    assert "Delivered 1 file" in await parent.deliver_file("/workspace/deck.pptx")
    sandbox.file.assert_not_awaited()
    assert len(children) == 2


@pytest.mark.asyncio
async def test_foreign_editor_run_and_origin_are_rejected_before_child_construction(tmp_path):
    ctx, payload, sandbox, emit, origin = _fixture(tmp_path, owner=owner_key("101"))
    editors = build_editor_tools(ctx.config, {**payload, "run_id": "e" * 32}, emit)
    factory, children = build_subagent_factory(ctx, payload, sandbox, None, emit, None, editors)
    with pytest.raises(WorkError, match="当前会话"):
        await factory("child-1", "Inspect", {**origin, "session_key": "websocket:" + "c" * 32}, AgentHook(), AsyncMock())
    with pytest.raises(WorkError, match="当前会话"):
        await factory("child-1", "Inspect", origin, AgentHook(), AsyncMock())
    assert children == []


@pytest.mark.asyncio
async def test_raw_child_deliveries_remain_pending_until_parent_flushes_after_exit(tmp_path):
    ctx, payload, sandbox, emit, origin = _fixture(tmp_path)
    factory, children = build_subagent_factory(ctx, payload, sandbox, None, emit, None)
    await factory("child-1", "Write a file", origin, AgentHook(), AsyncMock())
    await children[0].deliver_file("child.txt")
    assert not emit.await_count
    assert len(children[0].pending_delivery_files) == 1
    await children[0].flush_deliveries()
    assert emit.await_args.args[0] == "artifact" and not children[0].pending_delivery_files
