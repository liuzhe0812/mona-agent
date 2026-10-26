"""Public room handoffs retain constraints and expose bounded frozen sources."""

import asyncio
import json
from copy import deepcopy
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.jobs import AgentJobStore
from mona.agent.loop import AgentLoop
from mona.agent.memory import Consolidator, MemoryStore
from mona.agent.partners import AgentDefinition, ConversationMetadata
from mona.agent.room import CollaborationReadTool
from mona.agent.runner import AgentRunResult
from mona.agent.subagent import SubagentManager
from mona.agent.tools.registry import ToolRegistry
from mona.agent.user_config import AgentUserConfig
from mona.agent.workflow import (
    WorkflowDefinition,
    WorkflowRunStore,
    WorkflowStep,
    compose_step_task,
)
from mona.bus.queue import MessageBus
from mona.providers.base import LLMResponse
from mona.session.manager import SessionManager
from mona.utils.prompt_templates import render_template

PRIVATE_TOOL_MARKER = "PRIVATE_TOOL_MARKER"
RUNTIME_PRIVATE_MARKER = "RUNTIME_PRIVATE_MARKER"
PUBLIC_CONSTRAINT = "Only use the agreed public source and keep the original deadline."


@pytest.fixture
def room_runtime(tmp_path):
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    provider.chat_with_retry = AsyncMock()
    sessions = SessionManager(tmp_path)
    definition = AgentDefinition(id="com.example.researcher", display_name="Researcher")
    registry = MagicMock()
    registry.get.side_effect = lambda agent_id: definition if agent_id == definition.id else None
    session = sessions.get_or_create("websocket:room")
    session.metadata["conversation"] = ConversationMetadata.room(
        ["mona", definition.id], goal="Deliver the agreed report.",
    ).to_session_metadata()
    manager = SubagentManager(
        provider=provider, workspace=tmp_path, bus=MessageBus(), model="test-model",
        max_tool_result_chars=16_000, session_manager=sessions,
    )
    return manager, session, registry, definition


@pytest.mark.parametrize("conversation_type", ["room", "direct", "hidden"])
def test_room_style_is_added_only_to_visible_group_prompts(room_runtime, conversation_type):
    _, session, registry, definition = room_runtime
    if conversation_type == "direct":
        conversation = ConversationMetadata.direct(definition.id)
    else:
        conversation = ConversationMetadata.room(["mona", definition.id])
        conversation.hidden = conversation_type == "hidden"
    session.metadata["conversation"] = conversation.to_session_metadata()
    loop = object.__new__(AgentLoop)
    loop._room_agent_registry = registry
    messages = [{"role": "system", "content": "Fixed identity."}]

    rendered = loop._append_room_members_context(deepcopy(messages), session)

    style = render_template("agent/room_conversation.md")
    assert (style in rendered[0]["content"]) is (conversation_type == "room")
    assert messages[0]["content"] == "Fixed identity."
    if conversation_type == "room":
        assert "发言必须口语化" in rendered[0]["content"]
        assert "禁止书面汇报、文章腔、编号列表、项目符号、分点罗列、标题和表格" in rendered[0]["content"]
    if conversation_type == "direct":
        assert rendered == messages


@pytest.mark.parametrize("conversation_type", ["room", "direct", "hidden"])
def test_named_group_agent_speaks_to_the_room_instead_of_reporting_to_mona(
    room_runtime, monkeypatch, conversation_type,
):
    manager, session, registry, definition = room_runtime
    if conversation_type == "direct":
        conversation = ConversationMetadata.direct(definition.id)
    else:
        conversation = ConversationMetadata.room(["mona", definition.id])
        conversation.hidden = conversation_type == "hidden"
    session.metadata["conversation"] = conversation.to_session_metadata()
    registry.load_prompt.return_value = "You are Researcher."
    registry.resolve_skill_dirs.return_value = []
    monkeypatch.setattr("mona.agent.user_config.load_agent_user_config", lambda _: AgentUserConfig())

    rendered = manager._build_named_agent_prompt(definition, registry, {}, "room")

    group_chat = conversation_type == "room"
    assert (render_template("agent/room_conversation.md") in rendered) is group_chat
    assert ("You are a subagent spawned by the main agent" in rendered) is not group_chat
    assert ("Your final response will be reported back to the main agent" in rendered) is not group_chat
    assert "You are Researcher." in rendered


async def test_room_preview_and_read_share_only_frozen_public_data(room_runtime):
    manager, session, registry, definition = room_runtime
    session.add_message("user", PUBLIC_CONSTRAINT)
    session.add_message("tool", PRIVATE_TOOL_MARKER)
    session.add_message("user", "internal user injection", injected_event="runtime")
    session.add_message("assistant", "hidden tool call", tool_calls=[{"id": "call"}])
    session.add_message("user", "hidden command", _command=True)
    for internal_flag in [{"source_kind": "runtime"}, {"_runtime_input": True}, {"_input_cancelled": True}]:
        session.add_message("user", RUNTIME_PRIVATE_MARKER, **internal_flag)
    for i in range(60):
        session.add_message("assistant", f"public update {i}", author_id=definition.id)
    session.last_consolidated = 10
    session.metadata["_last_summary"] = {"text": PRIVATE_TOOL_MARKER}
    session.metadata["_shared_room_summary"] = {"text": PUBLIC_CONSTRAINT, "coverage": "complete"}

    snapshot = manager.capture_room_context_snapshot("room", registry)
    reference, full_context = next(iter(snapshot.sources.items()))
    assert PUBLIC_CONSTRAINT in snapshot
    assert "Deliver the agreed report." in snapshot
    assert "Incomplete recent-message preview" in snapshot
    assert "[Researcher]" in snapshot
    for excluded in [
        PRIVATE_TOOL_MARKER, RUNTIME_PRIVATE_MARKER,
        "internal user injection", "hidden tool call", "hidden command",
    ]:
        assert excluded not in snapshot
        assert excluded not in full_context
    assert PUBLIC_CONSTRAINT in full_context

    reader = CollaborationReadTool(snapshot.sources)
    session.add_message("user", "later message")
    page = json.loads(await reader.execute(reference, limit=100))
    assert page["complete"] is False
    assert page["next_offset"] == 100
    recovered = page["content"]
    while page["next_offset"] is not None:
        page = json.loads(await reader.execute(reference, offset=page["next_offset"], limit=100))
        recovered += page["content"]
    assert recovered == full_context
    assert "later message" not in recovered
    assert "not shared" in await reader.execute("room:another-room")
    assert "between 1 and 8000" in await reader.execute(reference, limit=8001)
    assert "between 1 and 8000" in await reader.execute(reference, offset=True)
    assert "between 1 and 8000" in await reader.execute(reference, limit="100")


def test_legacy_room_preserves_retained_public_prefix_without_private_summary(room_runtime):
    manager, session, registry, definition = room_runtime
    session.add_message("user", PUBLIC_CONSTRAINT)
    session.add_message("tool", PRIVATE_TOOL_MARKER)
    session.add_message("assistant", "Recent answer", author_id=definition.id)
    session.last_consolidated = 2
    session.metadata["_last_summary"] = {"text": PRIVATE_TOOL_MARKER}

    snapshot = manager._build_room_context_snapshot("room", definition.id, registry)
    assert PUBLIC_CONSTRAINT in snapshot
    assert "older archived messages may be unavailable" in snapshot
    assert PRIVATE_TOOL_MARKER not in snapshot


async def test_workflow_previews_preserve_all_dependencies_artifacts_and_full_results():
    step = WorkflowStep(id="report", agent_id="com.example.researcher", task="Write report.")
    upstream = {
        "first": {"summary": "A" * 5000 + "FIRST_TAIL", "artifacts": ["first.pdf"]},
        "last": {"summary": "B" * 5000 + "LAST_TAIL", "artifacts": ["last.pdf"]},
    }
    sources = {}
    task = compose_step_task(step, upstream, max_chars=100, run_id="run-one", source_documents=sources)
    assert "### first" in task and "### last" in task
    assert "first.pdf" in task and "last.pdf" in task
    assert task.count("Incomplete result preview") == 2
    assert all(reference in task for reference in sources)
    last_ref = next(reference for reference in sources if ":last:" in reference)
    reader = CollaborationReadTool(sources)
    page = json.loads(await reader.execute(last_ref))
    assert json.loads(page["content"])["summary"].endswith("LAST_TAIL")
    other_sources = {}
    compose_step_task(step, upstream, run_id="run-two", source_documents=other_sources)
    assert "not shared" in await CollaborationReadTool(other_sources).execute(last_ref)
    upstream["last"]["summary"] = "changed after launch"
    assert json.loads((await reader.execute(last_ref)))["content"].endswith('"last.pdf"]}')
    assert "LAST_TAIL" in (await reader.execute(last_ref))


def test_many_workflow_artifacts_remain_recoverable_without_unbounded_preview():
    step = WorkflowStep(id="report", agent_id="com.example.researcher", task="Write report.")
    artifacts = [f"report-{i}-{'x' * 200}.pdf" for i in range(100)]
    sources = {}
    task = compose_step_task(
        step, {"research": {"summary": "Ready", "artifacts": artifacts}},
        max_chars=100, run_id="run-one", source_documents=sources,
    )
    assert len(task) < 1000
    assert "100 references omitted" in task
    assert json.loads(next(iter(sources.values())))["artifacts"] == artifacts


def test_artifact_only_stock_agents_do_not_receive_upstream_summary_via_read_reference():
    step = WorkflowStep(id="bull", agent_id="com.mona.stock-bull-researcher", task="Read evidence.")
    sources = {}
    task = compose_step_task(
        step, {"research": {"summary": "UNVERIFIED_CLAIM", "artifacts": ["evidence.json"]}},
        source_documents=sources,
    )
    assert "UNVERIFIED_CLAIM" not in task
    assert "UNVERIFIED_CLAIM" not in next(iter(sources.values()))
    assert "evidence.json" in task


async def test_collaboration_step_gets_room_data_in_user_context_and_read_tool(
    room_runtime, tmp_path, monkeypatch,
):
    manager, session, registry, definition = room_runtime
    session.metadata["_shared_room_summary"] = {"text": PUBLIC_CONSTRAINT, "coverage": "complete"}
    job_store = AgentJobStore(tmp_path / "jobs")
    run_store = WorkflowRunStore(tmp_path / "runs")
    step = WorkflowStep(id="report", agent_id=definition.id, task="Write report.")
    workflow = WorkflowDefinition(id="collab-test", room_id="room", revision=1, steps=[step])
    run = run_store.create(room_id="room", workflow=workflow, user_profile_snapshot={})
    monkeypatch.setattr(manager, "job_store_for_room", lambda _: job_store)
    monkeypatch.setattr(manager, "run_store_for_room", lambda _: run_store)
    monkeypatch.setattr("mona.agent.user_config.load_agent_user_config", lambda _: AgentUserConfig())
    monkeypatch.setattr(manager, "_build_named_agent_tools", lambda *args, **kwargs: ToolRegistry())
    registry.load_prompt.return_value = "You are Researcher."
    registry.resolve_skill_dirs.return_value = []
    manager.runner.run = AsyncMock(return_value=AgentRunResult(
        final_content="Report completed.", messages=[], stop_reason="done",
    ))

    result = await manager.execute_workflow_step(
        run=run, step=step, room_id="room",
        upstream={"research": {"summary": "Evidence summary.", "artifacts": []}}, registry=registry,
    )

    assert result == "Report completed."
    spec = manager.runner.run.call_args.args[0]
    system_prompt = spec.initial_messages[0]["content"]
    assert render_template("agent/room_conversation.md") in system_prompt
    assert "Your final response will be reported back to the main agent" not in system_prompt
    assert PUBLIC_CONSTRAINT not in system_prompt
    assert PUBLIC_CONSTRAINT in spec.initial_messages[1]["content"]
    assert "Runtime Context" in spec.initial_messages[1]["content"]
    reader = spec.tools.get("collaboration_read")
    assert reader is not None
    reference = next(ref for ref in reader._sources if ref.startswith(f"workflow:{run.id}:research:"))
    assert "Evidence summary." in (await reader.execute(reference))


async def test_collaboration_step_keeps_bound_model_context_metadata(
    room_runtime, tmp_path, monkeypatch,
):
    from mona.agent.user_config import resolve_effective_agent_config
    from mona.providers.factory import ProviderSnapshot

    manager, _, registry, definition = room_runtime
    job_store = AgentJobStore(tmp_path / "jobs")
    run_store = WorkflowRunStore(tmp_path / "runs")
    step = WorkflowStep(id="report", agent_id=definition.id, task="Write report.")
    workflow = WorkflowDefinition(id="collab-bound", room_id="room", revision=1, steps=[step])
    run = run_store.create(room_id="room", workflow=workflow, user_profile_snapshot={})
    monkeypatch.setattr(manager, "job_store_for_room", lambda _: job_store)
    monkeypatch.setattr(manager, "run_store_for_room", lambda _: run_store)
    monkeypatch.setattr(manager, "_build_named_agent_tools", lambda *args, **kwargs: ToolRegistry())
    monkeypatch.setattr(manager, "_build_named_agent_prompt", lambda *args: "Fixed identity.")
    snapshot = ProviderSnapshot(
        provider=manager.provider, model="bound-native", signature=("bound",),
        context_window_tokens=32768, context_window_verified=True, context_provider="native:codex",
    )
    effective = resolve_effective_agent_config(definition, AgentUserConfig())
    manager._agent_runtime_resolver = lambda _: (manager.provider, "bound-native", effective, snapshot)
    manager.runner.run = AsyncMock(return_value=AgentRunResult(
        final_content="Completed.", messages=[], stop_reason="completed",
    ))

    await manager.execute_workflow_step(run=run, step=step, room_id="room", upstream={}, registry=registry)

    spec = manager.runner.run.call_args.args[0]
    assert spec.model == "bound-native"
    assert spec.context_window_tokens == 32768
    assert spec.context_window_verified is True
    assert spec.context_provider == "native:codex"


def _consolidator(manager):
    consolidator = Consolidator(
        store=MemoryStore(manager.workspace), provider=manager.provider, model="test-model",
        sessions=manager._sessions, context_window_tokens=10_000,
        build_messages=lambda **kwargs: kwargs["history"], get_tool_definitions=lambda: [],
        max_completion_tokens=100,
    )
    consolidator.estimate_session_prompt_tokens = MagicMock(return_value=(12_000, "test-pressure"))
    return consolidator


def _add_room_history(session):
    session.add_message("user", PUBLIC_CONSTRAINT)
    session.add_message("assistant", "internal call", tool_calls=[{"id": "call"}])
    session.add_message("tool", PRIVATE_TOOL_MARKER)
    session.add_message("assistant", "Visible answer")
    for internal_flag in [{"source_kind": "runtime"}, {"_runtime_input": True}, {"_input_cancelled": True}]:
        session.add_message("user", RUNTIME_PRIVATE_MARKER, **internal_flag)
    for i in range(12):
        session.add_message("user", f"u{i}")
        session.add_message("assistant", f"a{i}")


@pytest.mark.parametrize("idle", [False, True])
async def test_room_compaction_saves_separate_public_summary_without_private_tool_data(
    room_runtime, idle,
):
    manager, session, registry, definition = room_runtime
    _add_room_history(session)
    manager._sessions.save(session)
    consolidator = _consolidator(manager)
    manager.provider.chat_with_retry.side_effect = [
        LLMResponse(content=f"Private summary {PRIVATE_TOOL_MARKER}"),
        LLMResponse(content=PUBLIC_CONSTRAINT),
    ]
    consolidator.estimate_session_prompt_tokens.side_effect = [
        (12_000, "test-pressure"), (100, "test-pressure"),
    ]

    if idle:
        await consolidator.compact_idle_session(session.key, max_suffix=4)
    else:
        await consolidator.maybe_consolidate_by_tokens(session)

    calls = manager.provider.chat_with_retry.await_args_list
    assert len(calls) == 2
    assert PRIVATE_TOOL_MARKER in calls[0].kwargs["messages"][1]["content"]
    assert PRIVATE_TOOL_MARKER not in calls[1].kwargs["messages"][1]["content"]
    assert RUNTIME_PRIVATE_MARKER not in calls[1].kwargs["messages"][1]["content"]
    assert PUBLIC_CONSTRAINT in calls[1].kwargs["messages"][1]["content"]
    manager._sessions.invalidate(session.key)
    saved = manager._sessions.get_or_create(session.key)
    assert saved.metadata["_shared_room_summary"]["text"] == PUBLIC_CONSTRAINT
    assert PRIVATE_TOOL_MARKER not in json.dumps(saved.metadata["_shared_room_summary"])
    assert saved.metadata["_shared_room_summary"]["through_cursor"] == saved.last_consolidated
    assert saved.metadata["_shared_room_summary"]["through_timestamp"]
    assert PRIVATE_TOOL_MARKER in saved.metadata["_last_summary"]["text"]
    snapshot = manager._build_room_context_snapshot("room", definition.id, registry)
    assert PUBLIC_CONSTRAINT in snapshot
    assert PRIVATE_TOOL_MARKER not in snapshot
    assert RUNTIME_PRIVATE_MARKER not in snapshot
    assert all(RUNTIME_PRIVATE_MARKER not in source for source in snapshot.sources.values())
    entries = consolidator.store.read_unprocessed_history(since_cursor=0)
    assert len(entries) == 1
    assert PRIVATE_TOOL_MARKER in str(entries)


@pytest.mark.parametrize("public_result", [
    LLMResponse(content="Shared summary unavailable", finish_reason="error"),
    LLMResponse(content="S" * 8001),
])
async def test_public_summary_failure_retains_history_cursor_and_existing_summaries(
    room_runtime, public_result,
):
    manager, session, _registry, _definition = room_runtime
    _add_room_history(session)
    session.metadata["_last_summary"] = {"text": "Previous private summary"}
    session.metadata["_shared_room_summary"] = {"text": "Previous public summary", "coverage": "complete"}
    manager._sessions.save(session)
    original = deepcopy(session.messages)
    consolidator = _consolidator(manager)
    manager.provider.chat_with_retry.side_effect = [
        LLMResponse(content="New private summary"), public_result,
    ]

    await consolidator.maybe_consolidate_by_tokens(session)
    await consolidator.compact_idle_session(session.key, max_suffix=4)

    assert manager.provider.chat_with_retry.await_count == 2
    saved = manager._sessions.get_or_create(session.key)
    assert saved.messages == original
    assert saved.last_consolidated == 0
    assert saved.metadata["_last_summary"]["text"] == "Previous private summary"
    assert saved.metadata["_shared_room_summary"]["text"] == "Previous public summary"
    assert consolidator.store.read_unprocessed_history(since_cursor=0) == []


@pytest.mark.parametrize("idle", [False, True])
async def test_room_summary_save_failure_rolls_back_metadata_cursor_and_messages(
    room_runtime, monkeypatch, idle,
):
    manager, session, _registry, _definition = room_runtime
    _add_room_history(session)
    session.metadata["_last_summary"] = {"text": "Previous private summary"}
    session.metadata["_shared_room_summary"] = {"text": "Previous public summary", "coverage": "complete"}
    manager._sessions.save(session)
    original_messages = deepcopy(session.messages)
    original_time = session.updated_at
    consolidator = _consolidator(manager)
    manager.provider.chat_with_retry.side_effect = [
        LLMResponse(content="New private summary"), LLMResponse(content="New public summary"),
    ]
    monkeypatch.setattr(manager._sessions, "save", MagicMock(side_effect=OSError("Disk unavailable")))

    with pytest.raises(OSError, match="Disk unavailable"):
        if idle:
            await consolidator.compact_idle_session(session.key, max_suffix=4)
        else:
            await consolidator.maybe_consolidate_by_tokens(session)

    cached = manager._sessions.get_or_create(session.key)
    assert cached.messages == original_messages
    assert cached.last_consolidated == 0
    assert cached.updated_at == original_time
    assert cached.metadata["_last_summary"]["text"] == "Previous private summary"
    assert cached.metadata["_shared_room_summary"]["text"] == "Previous public summary"
    assert session.key not in consolidator._pending_room_summaries
    manager._sessions.invalidate(session.key)
    saved = manager._sessions.get_or_create(session.key)
    assert saved.metadata["_shared_room_summary"]["text"] == "Previous public summary"
    assert saved.messages == original_messages


async def test_private_history_write_failure_does_not_commit_public_summary(
    room_runtime, monkeypatch,
):
    manager, session, _registry, _definition = room_runtime
    _add_room_history(session)
    manager._sessions.save(session)
    consolidator = _consolidator(manager)
    manager.provider.chat_with_retry.side_effect = [
        LLMResponse(content="New private summary"), LLMResponse(content="New public summary"),
    ]
    monkeypatch.setattr(consolidator.store, "append_history", MagicMock(side_effect=OSError("Disk unavailable")))

    await consolidator.maybe_consolidate_by_tokens(session)

    assert session.last_consolidated == 0
    assert "_shared_room_summary" not in session.metadata
    assert session.key not in consolidator._pending_room_summaries


async def test_legacy_room_summary_uses_retained_public_prefix_and_marks_coverage_gap(room_runtime):
    manager, session, _registry, _definition = room_runtime
    _add_room_history(session)
    session.last_consolidated = 4
    session.metadata["_last_summary"] = {"text": PRIVATE_TOOL_MARKER}
    manager._sessions.save(session)
    consolidator = _consolidator(manager)
    manager.provider.chat_with_retry.side_effect = [
        LLMResponse(content="New private summary"), LLMResponse(content=PUBLIC_CONSTRAINT),
    ]
    consolidator.estimate_session_prompt_tokens.side_effect = [
        (12_000, "test-pressure"), (100, "test-pressure"),
    ]

    await consolidator.maybe_consolidate_by_tokens(session)

    public_request = manager.provider.chat_with_retry.await_args_list[1].kwargs["messages"][1]["content"]
    assert PUBLIC_CONSTRAINT in public_request
    assert PRIVATE_TOOL_MARKER not in public_request
    assert session.metadata["_shared_room_summary"]["coverage"] == "retained_history"


async def test_room_summary_cancellation_does_not_leave_a_pending_shared_commit(room_runtime):
    manager, session, _registry, _definition = room_runtime
    _add_room_history(session)
    manager._sessions.save(session)
    consolidator = _consolidator(manager)
    manager.provider.chat_with_retry.side_effect = [
        LLMResponse(content="Private summary"), LLMResponse(content="Public summary"),
    ]

    async def on_compaction(active):
        if not active:
            raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await consolidator.maybe_consolidate_by_tokens(session, on_compaction=on_compaction)

    assert session.last_consolidated == 0
    assert "_shared_room_summary" not in session.metadata
    assert session.key not in consolidator._pending_room_summaries
