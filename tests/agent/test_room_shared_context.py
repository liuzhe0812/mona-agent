"""Room @-mention context and authored-result projection tests."""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from mona.agent.artifacts import ArtifactRef
from mona.agent.collaboration import (
    MAX_DISCUSSION_ROUNDS,
    DiscussionMode,
    build_discussion_workflow,
)
from mona.agent.jobs import AgentJobStore
from mona.agent.loop import AgentLoop
from mona.agent.partners import (
    CONVERSATION_METADATA_KEY,
    MONA_AGENT_ID,
    AgentRegistry,
    ConversationMetadata,
)
from mona.agent.runner import AgentRunner
from mona.agent.subagent import SubagentManager
from mona.agent.tools.context import RequestContext
from mona.agent.tools.deliver_file import DeliverFileTool
from mona.agent.workflow import (
    RUN_STATUS_SUCCEEDED,
    WorkflowRunner,
    WorkflowRunStore,
    execution_layers,
)
from mona.bus.events import OutboundMessage
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.config.paths import get_agent_output_dir
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.session.manager import SessionManager
from mona.session.task_plan import TASK_PLAN_KEY
from mona.webui.transcript import replay_transcript_to_ui_messages

AGENT_A = "com.example.agent-a"
AGENT_B = "com.example.agent-b"
ROOM_ID = "room-context"


def _write_agent_package(root: Path, agent_id: str, display_name: str) -> None:
    package = root / agent_id
    package.mkdir(parents=True)
    (package / "agent.json").write_text(
        json.dumps(
            {
                "id": agent_id,
                "display_name": display_name,
                "description": f"{display_name} description",
                "prompt": "prompt.md",
                "tool_allowlist": ["read_file"],
            }
        ),
        encoding="utf-8",
    )
    (package / "prompt.md").write_text(f"You are {display_name}.", encoding="utf-8")


def _registry(tmp_path: Path) -> AgentRegistry:
    packages = tmp_path / "agents"
    _write_agent_package(packages, AGENT_A, "分析师 A")
    _write_agent_package(packages, AGENT_B, "分析师 B")
    return AgentRegistry(builtin_dir=packages, installed_dir=tmp_path / "installed")


def _room_session(sessions: SessionManager) -> None:
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    session.metadata[CONVERSATION_METADATA_KEY] = ConversationMetadata.room(
        [MONA_AGENT_ID, AGENT_A, AGENT_B],
        title="协作群",
        goal="完成一份可核验的报告",
    ).to_session_metadata()
    sessions.save(session)


def test_room_model_history_keeps_agent_author_labels(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    session.add_message("user", "请先分析数据")
    session.add_message(
        "assistant",
        "A 的结论",
        author_id=AGENT_A,
        message_type="message",
    )

    fake_loop = SimpleNamespace(_room_agent_registry=_registry(tmp_path))
    history = AgentLoop._build_model_history(
        fake_loop,
        session,
        max_messages=50,
        max_tokens=0,
    )

    assert history == [
        {"role": "user", "content": "请先分析数据"},
        {"role": "assistant", "content": "[分析师 A] A 的结论"},
    ]


def test_room_model_context_includes_goal_and_all_members(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    fake_loop = SimpleNamespace(_room_agent_registry=_registry(tmp_path))

    context = AgentLoop._room_members_context(fake_loop, session)

    assert "完成一份可核验的报告" in context
    assert AGENT_A in context and "分析师 A" in context
    assert AGENT_B in context and "分析师 B" in context
    assert "delegate_agent in the same turn" in context


def test_room_snapshot_for_agent_b_contains_agent_a_answer(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    session.add_message("user", "请先分析数据")
    session.add_message(
        "assistant",
        "A 的结论",
        author_id=AGENT_A,
        message_type="message",
    )

    manager = SubagentManager(
        provider=_Provider(LLMResponse(content="ok")),
        workspace=tmp_path / "workspace",
        bus=MessageBus(),
        max_tool_result_chars=4000,
        session_manager=sessions,
    )
    snapshot = manager._build_room_context_snapshot(ROOM_ID, AGENT_B, _registry(tmp_path))

    assert "完成一份可核验的报告" in snapshot
    assert AGENT_A in snapshot and "分析师 A" in snapshot
    assert AGENT_B in snapshot and "分析师 B" in snapshot
    assert "A 的结论" in snapshot


@pytest.mark.asyncio
async def test_user_mention_result_is_authored_and_does_not_wake_mona(
    tmp_path: Path,
) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    bus = MessageBus()
    manager = SubagentManager(
        provider=_Provider(LLMResponse(content="A 的最终回答")),
        workspace=tmp_path / "workspace",
        bus=bus,
        max_tool_result_chars=4000,
        session_manager=sessions,
    )
    store = AgentJobStore(tmp_path / "jobs")
    registry = _registry(tmp_path)

    await manager.delegate(
        agent_id=AGENT_A,
        task="回答用户问题",
        success_criteria="给出最终回答",
        room_id=ROOM_ID,
        requested_by="user",
        origin_channel="websocket",
        origin_chat_id=ROOM_ID,
        session_key=f"websocket:{ROOM_ID}",
        job_store=store,
        registry=registry,
    )
    job_id = store.list_for_room(ROOM_ID)[0].id
    await manager._running_tasks[job_id]

    authored = [
        message
        for message in sessions.get_or_create(f"websocket:{ROOM_ID}").messages
        if message.get("job_id") == job_id
    ]
    assert len(authored) == 1
    assert authored[0]["author_id"] == AGENT_A
    assert authored[0]["content"] == "A 的最终回答"
    assert bus.inbound_size == 0
    outbound = await bus.consume_outbound()
    assert outbound.metadata["author_id"] == AGENT_A
    assert outbound.metadata["job_id"] == job_id
    sidebar_refresh = await bus.consume_outbound()
    assert sidebar_refresh.chat_id == ROOM_ID
    assert sidebar_refresh.metadata["_session_updated"] is True
    assert sidebar_refresh.metadata["_session_update_scope"] == "thread"


@pytest.mark.asyncio
async def test_parent_turn_ends_when_direct_mentions_do_not_inject_results(tmp_path: Path) -> None:
    from mona.agent.runner import AgentRunResult

    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    loop = AgentLoop(bus=MessageBus(), provider=provider, workspace=tmp_path)
    running = True

    class _Subagents:
        max_iterations = 0

        @staticmethod
        def get_running_count_by_session(_session_key: str) -> int:
            return int(running)

    loop.subagents = _Subagents()

    async def run(spec):
        nonlocal running

        async def finish_job() -> None:
            nonlocal running
            await asyncio.sleep(0.01)
            running = False

        task = asyncio.create_task(finish_job())
        try:
            assert await spec.injection_callback() == []
        finally:
            await task
        return AgentRunResult(final_content="done", messages=[])

    loop.runner.run = run
    session = loop.sessions.get_or_create(f"websocket:{ROOM_ID}")
    result, *_ = await asyncio.wait_for(
        loop._run_agent_loop([], session=session, pending_queue=asyncio.Queue()),
        timeout=1,
    )

    assert result == "done"


@pytest.mark.asyncio
async def test_delegate_tool_remains_visible_after_another_tool_call(tmp_path: Path) -> None:
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    visible_tools: list[set[str]] = []

    async def chat_with_retry(**kwargs):
        visible_tools.append(
            {schema["function"]["name"] for schema in kwargs["tools"] if "function" in schema}
        )
        if len(visible_tools) == 1:
            return LLMResponse(
                content="先检查工作区",
                tool_calls=[
                    ToolCallRequest(
                        id="call-list",
                        name="list_dir",
                        arguments={"path": "."},
                    )
                ],
            )
        return LLMResponse(content="完成")

    provider.chat_with_retry = chat_with_retry
    loop = AgentLoop(bus=MessageBus(), provider=provider, workspace=tmp_path)
    _room_session(loop.sessions)
    session = loop.sessions.get_or_create(f"websocket:{ROOM_ID}")
    loop._set_tool_context(
        "websocket",
        ROOM_ID,
        session_key=f"websocket:{ROOM_ID}",
        session=session,
    )

    result, *_ = await loop._run_agent_loop(
        [],
        session=session,
        channel="websocket",
        chat_id=ROOM_ID,
        session_key=f"websocket:{ROOM_ID}",
    )

    assert result == "完成"
    assert len(visible_tools) == 2
    assert "delegate_agent" in visible_tools[0]
    assert "delegate_agent" in visible_tools[1]


@pytest.mark.asyncio
async def test_same_mention_batch_keeps_start_snapshots_independent(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    _room_session(sessions)
    session = sessions.get_or_create(f"websocket:{ROOM_ID}")
    session.add_message("user", "同一批任务")
    session.add_message("assistant", "Mona 的既有回答", author_id=MONA_AGENT_ID)
    session.add_message("assistant", "A 的既有回答", author_id=AGENT_A)
    bus = MessageBus()
    manager = SubagentManager(
        provider=_Provider(LLMResponse(content="ok")),
        workspace=tmp_path / "workspace",
        bus=bus,
        max_tool_result_chars=4000,
        session_manager=sessions,
    )
    store = AgentJobStore(tmp_path / "jobs")
    registry = _registry(tmp_path)
    batch_snapshot = manager.capture_room_context_snapshot(ROOM_ID, registry)

    await manager.delegate(
        agent_id=AGENT_A,
        task="并行任务 A",
        success_criteria="完成",
        room_id=ROOM_ID,
        requested_by="user",
        room_context_snapshot=batch_snapshot,
        job_store=store,
        registry=registry,
    )
    await manager.delegate(
        agent_id=AGENT_B,
        task="并行任务 B",
        success_criteria="完成",
        room_id=ROOM_ID,
        requested_by="user",
        room_context_snapshot=batch_snapshot,
        job_store=store,
        registry=registry,
    )

    # Mutate the room only after both jobs were queued. Neither captured
    # snapshot may observe a sibling's later answer.
    assert "[Mona] Mona 的既有回答" in batch_snapshot
    assert "[分析师 A] A 的既有回答" in batch_snapshot
    session.add_message("assistant", "A 后来的回答", author_id=AGENT_A)
    assert "A 后来的回答" not in batch_snapshot

    await asyncio.gather(*manager._running_tasks.values())


@pytest.mark.asyncio
async def test_closed_room_persists_one_authored_result_for_replay() -> None:
    channel = WebSocketChannel(
        {
            "enabled": True,
            "allowFrom": ["*"],
            "host": "127.0.0.1",
            "port": 29877,
            "path": "/ws",
            "websocketRequiresToken": False,
        },
        MessageBus(),
    )
    channel._try_append_webui_transcript = MagicMock()
    await channel.send(
        OutboundMessage(
            channel="websocket",
            chat_id=ROOM_ID,
            content="A 的回答",
            metadata={
                "_agent_job_result": True,
                "author_id": AGENT_A,
                "message_type": "message",
                "job_id": "job-a",
            },
        )
    )

    channel._try_append_webui_transcript.assert_called_once()
    payload = channel._try_append_webui_transcript.call_args.args[1]
    replayed = replay_transcript_to_ui_messages([payload])
    assert len(replayed) == 1
    assert replayed[0]["authorId"] == AGENT_A
    assert replayed[0]["jobId"] == "job-a"


@pytest.mark.asyncio
async def test_closed_session_persists_deliverables_for_replay() -> None:
    channel = WebSocketChannel(
        {
            "enabled": True,
            "allowFrom": ["*"],
            "host": "127.0.0.1",
            "port": 29877,
            "path": "/ws",
            "websocketRequiresToken": False,
        },
        MessageBus(),
    )
    channel._try_append_webui_transcript = MagicMock()
    delivered = {
        "name": "final.png",
        "path": "generated/final.png",
        "absolute_path": "C:/workspace/generated/final.png",
        "mime": "image/png",
    }

    await channel.send(
        OutboundMessage(
            channel="websocket",
            chat_id="chat-closed-delivery",
            content="",
            metadata={"_deliver_files": [delivered]},
        )
    )

    channel._try_append_webui_transcript.assert_called_once_with(
        "chat-closed-delivery",
        {
            "event": "deliver_files",
            "chat_id": "chat-closed-delivery",
            "files": [delivered],
        },
    )


@pytest.mark.asyncio
async def test_generated_media_source_id_becomes_stable_artifact_id(tmp_path: Path) -> None:
    output = get_agent_output_dir(tmp_path, "mona")
    image = output / "generated" / "final.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"image")
    bus = MessageBus()
    tool = DeliverFileTool(
        send_callback=bus.publish_outbound,
        workspace=output,
        restrict_to_workspace=True,
    )
    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="chat-stable-artifact",
            session_key="websocket:chat-stable-artifact",
        )
    )

    await tool.execute(
        paths=["generated/final.png"],
        _artifact_source_ids=["img_final_source"],
    )

    message = await bus.consume_outbound()
    expected = uuid.uuid5(
        uuid.NAMESPACE_URL,
        "mona:artifact:websocket:chat-stable-artifact:img_final_source",
    )
    assert message.metadata["_deliver_files"][0]["artifact_ref"]["id"] == (
        f"artifact_{expected.hex}"
    )


@pytest.mark.asyncio
async def test_runner_registers_generated_media_with_structured_source_ids() -> None:
    calls: list[dict] = []

    class _Deliver:
        async def execute(self, **kwargs):
            calls.append(kwargs)
            return "Delivered 1 file(s) to user"

    deliver = _Deliver()
    spec = SimpleNamespace(
        tools=SimpleNamespace(get=lambda name: deliver if name == "deliver_file" else None)
    )
    runner = AgentRunner(MagicMock())

    await runner._register_generated_media(
        spec,
        "generate_image",
        "call-image",
        json.dumps(
            {
                "artifacts": [
                    {
                        "id": "img_final_source",
                        "path": "C:/workspace/generated/final.png",
                        "mime": "image/png",
                    }
                ],
            }
        ),
    )

    assert calls == [
        {
            "paths": ["C:/workspace/generated/final.png"],
            "_artifact_source_ids": ["img_final_source"],
        }
    ]


def test_file_edits_are_process_records_not_session_artifacts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = get_agent_output_dir(tmp_path, "mona")
    script = output / "helpers" / "render.py"
    script.parent.mkdir(parents=True)
    script.write_text("print('render')", encoding="utf-8")
    ref = ArtifactRef.for_path(
        owner_kind="agent",
        owner_id="mona",
        root=output,
        path=script,
        created_by_agent_id="mona",
        session_id="websocket:chat-edit",
    )
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, MessageBus())
    monkeypatch.setattr(
        "mona.webui.transcript.read_transcript_lines",
        lambda _key: [
            {
                "event": "file_edit",
                "edits": [
                    {
                        "status": "done",
                        "absolute_path": str(script),
                        "artifact_ref": ref.model_dump(mode="json"),
                    }
                ],
            }
        ],
    )

    assert channel._artifact_refs_from_session("websocket:chat-edit") == []


def test_explicit_delivery_wins_over_generated_media_history_fallback(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    output = get_agent_output_dir(tmp_path, "mona")
    image = output / "generated" / "cat.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"image")
    explicit_ref = ArtifactRef.for_path(
        owner_kind="agent",
        owner_id="mona",
        root=output,
        path=image,
        created_by_agent_id="mona",
        session_id="websocket:chat-explicit",
    ).model_copy(update={"id": "artifact_explicit"})
    channel = WebSocketChannel({"enabled": True, "allowFrom": ["*"]}, MessageBus())
    channel.workspace = tmp_path
    manager = MagicMock()
    manager.read_session_file.return_value = {"metadata": {}}
    manager.get_or_create.return_value = SessionManager(tmp_path / "sessions").get_or_create(
        "websocket:chat-explicit"
    )
    channel._session_manager = manager
    monkeypatch.setattr(
        "mona.webui.transcript.read_transcript_lines",
        lambda _key: [
            {
                "event": "message",
                "tool_events": [
                    {
                        "phase": "end",
                        "name": "generate_image",
                        "result": json.dumps({"artifacts": [{"path": str(image)}]}),
                        "error": None,
                    }
                ],
            },
            {
                "event": "deliver_files",
                "files": [
                    {
                        "path": "generated/cat.png",
                        "absolute_path": str(image),
                        "name": "cat.png",
                        "mime": "image/png",
                        "artifact_ref": explicit_ref.model_dump(mode="json"),
                    }
                ],
            },
        ],
    )

    refs = channel._artifact_refs_from_session("websocket:chat-explicit")

    assert [ref.id for ref in refs] == ["artifact_explicit"]


def test_deliver_file_tool_event_backfills_streamed_delivery(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    channel = WebSocketChannel(
        {"enabled": True, "allowFrom": ["*"]},
        MessageBus(),
        session_manager=sessions,
    )
    channel.workspace = tmp_path
    channel._start_artifact_task("chat-streamed-delivery", "task-delivery")
    output = get_agent_output_dir(tmp_path, "mona")
    report = output / "report.html"
    report.write_text("<html></html>", encoding="utf-8")
    channel._try_append_webui_transcript(
        "chat-streamed-delivery",
        {
            "event": "message",
            "tool_events": [{
                "phase": "end",
                "name": "deliver_file",
                "arguments": {"paths": [str(report)]},
                "result": "Prepared 1 file(s) for final delivery",
            }],
        },
    )

    refs = channel._artifact_refs_from_session("websocket:chat-streamed-delivery")

    assert [ref.relative_path for ref in refs] == ["report.html"]


def test_artifact_task_tracks_recorded_process_files_without_deleting_workspace(
    tmp_path: Path,
) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    channel = WebSocketChannel(
        {"enabled": True, "allowFrom": ["*"]},
        MessageBus(),
        session_manager=sessions,
    )
    channel.workspace = tmp_path
    output = get_agent_output_dir(tmp_path, "mona")
    existing = output / "existing.md"
    existing.write_text("before", encoding="utf-8")

    assert channel._start_artifact_task("chat-task-files", "task_first") is True
    process_file = output / "helpers" / "render.py"
    process_file.parent.mkdir(parents=True)
    process_file.write_text("print('render')", encoding="utf-8")
    dependency = output / "node_modules" / "package" / "index.js"
    dependency.parent.mkdir(parents=True)
    dependency.write_text("module.exports = {}", encoding="utf-8")
    channel._try_append_webui_transcript(
        "chat-task-files",
        {
            "event": "file_edit",
            "task_id": "task_first",
            "edits": [
                {"status": "done", "absolute_path": str(path)}
                for path in (process_file, dependency)
            ],
        },
    )
    channel._api_tokens["live"] = 1e20
    request = SimpleNamespace(
        headers={"Authorization": "Bearer live"},
        path=(
            "/api/artifacts?session_key=websocket%3Achat-task-files"
            "&task_id=task_first"
        ),
    )

    first = json.loads(channel._handle_artifacts_list(request).body)

    assert [item["path"] for item in first["task_files"]] == ["helpers/render.py"]
    assert first["task_id"] == "task_first"
    session = sessions.get_or_create("websocket:chat-task-files")
    session.metadata[TASK_PLAN_KEY] = {
        "task_id": "task_first",
        "revision": 1,
        "steps": [{"id": "old", "step": "Old task", "status": "in_progress"}],
    }
    sessions.save(session)
    assert channel._start_artifact_task("chat-task-files", "task_second") is True
    second_request = SimpleNamespace(
        headers=request.headers,
        path=(
            "/api/artifacts?session_key=websocket%3Achat-task-files"
            "&task_id=task_second"
        ),
    )
    second = json.loads(channel._handle_artifacts_list(second_request).body)

    assert second["task_files"] == []
    reset_plan = sessions.get_or_create("websocket:chat-task-files").metadata[TASK_PLAN_KEY]
    assert reset_plan == {
        "task_id": "task_second",
        "revision": 0,
        "steps": [],
        "source": "awaiting_ai",
    }
    assert existing.is_file() and process_file.is_file() and dependency.is_file()


def test_artifact_task_waits_for_ai_plan_instead_of_splitting_user_clauses(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    channel = WebSocketChannel(
        {"enabled": True, "allowFrom": ["*"]},
        MessageBus(),
        session_manager=sessions,
    )
    channel.workspace = tmp_path

    assert channel._start_artifact_task(
        "chat-plan-seed",
        "task-seed",
    ) is True

    plan = sessions.get_or_create("websocket:chat-plan-seed").metadata[TASK_PLAN_KEY]
    assert plan["steps"] == []
    assert plan["source"] == "awaiting_ai"


@pytest.mark.asyncio
async def test_task_plan_hydrates_from_session_metadata_after_subscribe(tmp_path: Path) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    session = sessions.get_or_create("websocket:chat-plan-hydrate")
    session.metadata[TASK_PLAN_KEY] = {
        "task_id": "task-plan",
        "revision": 4,
        "steps": [{"id": "verify", "step": "Verify", "status": "in_progress"}],
        "source": "ai",
    }
    sessions.save(session)
    channel = WebSocketChannel(
        {"enabled": True, "allowFrom": ["*"]},
        MessageBus(),
        session_manager=sessions,
    )
    channel.send_task_plan = AsyncMock()

    await channel._maybe_push_task_plan("chat-plan-hydrate")

    channel.send_task_plan.assert_awaited_once_with(
        "chat-plan-hydrate",
        {
            "task_id": "task-plan",
            "revision": 4,
            "steps": [{"id": "verify", "step": "Verify", "status": "in_progress"}],
            "source": "ai",
        },
    )


def test_webui_history_replays_assistant_task_plan_snapshot() -> None:
    replayed = replay_transcript_to_ui_messages([
        {
            "event": "message",
            "text": "Done",
            "task_plan": {
                "task_id": "task-history",
                "revision": 2,
                "steps": [{"id": "one", "step": "Deliver", "status": "completed"}],
            },
        },
    ])
    assert replayed[0]["taskPlan"]["steps"][0]["step"] == "Deliver"


def test_webui_history_keeps_reference_tool_events_on_progress_traces() -> None:
    replayed = replay_transcript_to_ui_messages([
        {
            "event": "message",
            "kind": "progress",
            "text": "web_fetch",
            "tool_events": [{
                "phase": "start",
                "name": "web_fetch",
                "arguments": {"url": "https://github.com/trending"},
            }],
        },
    ])
    assert replayed[0]["toolEvents"][0]["arguments"]["url"] == "https://github.com/trending"


def test_webui_history_keeps_user_task_id_for_injected_followups() -> None:
    replayed = replay_transcript_to_ui_messages([
        {
            "event": "user",
            "text": "only top five",
            "task_id": "task-report",
        },
    ])
    assert replayed[0]["taskId"] == "task-report"


def test_artifact_rename_keeps_an_explicit_delivery_in_the_session_list(
    tmp_path: Path,
) -> None:
    sessions = SessionManager(tmp_path / "sessions")
    channel = WebSocketChannel(
        {"enabled": True, "allowFrom": ["*"]},
        MessageBus(),
        session_manager=sessions,
    )
    channel.workspace = tmp_path
    chat_id = "chat-rename"
    output = get_agent_output_dir(tmp_path, "mona")
    source = output / "final.png"
    source.write_bytes(b"image")
    channel._start_artifact_task(chat_id, "task-rename")
    ref = ArtifactRef.for_path(
        owner_kind="agent",
        owner_id="mona",
        root=output,
        path=source,
        created_by_agent_id="mona",
        session_id=f"websocket:{chat_id}",
    )
    channel._try_append_webui_transcript(
        chat_id,
        {
            "event": "deliver_files",
            "chat_id": chat_id,
            "files": [{
                **ref.as_file(tmp_path),
                "absolute_path": str(source),
            }],
        },
    )
    channel._api_tokens["live"] = 1e20
    request = SimpleNamespace(
        headers={"Authorization": "Bearer live"},
        path=(
            "/api/artifact-rename?scope=shared&session_key=websocket%3Achat-rename"
            "&path=final.png&new_name=renamed.png"
        ),
    )

    response = channel._handle_artifact_rename(request)

    assert response.status_code == 200
    assert not source.exists()
    assert (output / "renamed.png").is_file()
    refs = channel._artifact_refs_from_session(f"websocket:{chat_id}")
    assert any(ref.relative_path == "renamed.png" for ref in refs)


def test_delivered_video_replays_as_session_artifact_and_inline_media() -> None:
    video = {
        "name": "clip.mp4",
        "path": "generated/clip.mp4",
        "absolute_path": "C:/workspace/generated/clip.mp4",
        "mime": "video/mp4",
    }
    replayed = replay_transcript_to_ui_messages(
        [
            {
                "event": "deliver_files",
                "chat_id": "chat-video",
                "files": [video],
            },
            {"event": "message", "chat_id": "chat-video", "text": "done"},
            {"event": "turn_end", "chat_id": "chat-video"},
        ],
        augment_user_media=lambda paths: [
            {"kind": "video", "url": "/api/media/signed/clip", "name": "clip.mp4"}
            for _path in paths
        ],
    )

    assert replayed[0]["deliveredFiles"] == [video]
    assert replayed[0]["media"] == [
        {"kind": "video", "url": "/api/media/signed/clip", "name": "clip.mp4"}
    ]


class _Provider(LLMProvider):
    def __init__(self, response: LLMResponse) -> None:
        super().__init__()
        self.response = response

    async def chat(self, messages, tools=None, model=None, **kwargs):
        return self.response

    def get_default_model(self) -> str:
        return "test-model"


def test_discussion_workflow_rotates_speakers_then_summarizes() -> None:
    workflow = build_discussion_workflow(
        ROOM_ID,
        "增长还是利润？",
        [AGENT_A, AGENT_B],
        mode=DiscussionMode.DEBATE,
        max_rounds=2,
        positions={AGENT_A: "优先增长", AGENT_B: "优先利润"},
        styles={AGENT_A: "value_reframe"},
        summary_agent_id=MONA_AGENT_ID,
    )

    speaker_steps = workflow.steps[:-1]
    assert workflow.id.startswith("discussion-debate-")
    assert [step.agent_id for step in speaker_steps] == [AGENT_A, AGENT_B, AGENT_A, AGENT_B]
    assert [step.depends_on for step in speaker_steps] == [
        [],
        ["round-1-speaker-1"],
        ["round-1-speaker-2"],
        ["round-2-speaker-1"],
    ]
    assert "优先增长" in speaker_steps[0].task
    assert "优先利润" in speaker_steps[1].task
    assert workflow.steps[-1].id == "summary"
    assert workflow.steps[-1].agent_id == MONA_AGENT_ID
    assert "中立裁判" in workflow.steps[-1].task
    assert "明确判定哪一方更胜一筹" in workflow.steps[-1].task


def test_free_discussion_starts_in_parallel_and_waits_for_the_full_first_round() -> None:
    workflow = build_discussion_workflow(
        ROOM_ID,
        "如何改善交付质量",
        [AGENT_A, AGENT_B],
        mode="discussion",
        max_rounds=3,
    )

    first_round = workflow.steps[:2]
    second_round_first = workflow.steps[2]

    assert [step.depends_on for step in first_round] == [[], []]
    assert execution_layers(workflow)[0] == [step.id for step in first_round]
    assert second_round_first.id == "round-2-speaker-1"
    assert second_round_first.depends_on == [step.id for step in first_round]


def test_one_round_discussion_summary_waits_for_all_first_round_steps() -> None:
    workflow = build_discussion_workflow(
        ROOM_ID,
        "如何改善交付质量",
        [AGENT_A, AGENT_B],
        mode="discussion",
        max_rounds=1,
    )

    first_round_ids = [step.id for step in workflow.steps[:2]]
    assert workflow.steps[-1].id == "summary"
    assert workflow.steps[-1].depends_on == first_round_ids


def test_three_round_discussion_prompts_move_from_divergence_to_review_to_convergence() -> None:
    workflow = build_discussion_workflow(
        ROOM_ID,
        "如何改善交付质量",
        [AGENT_A, AGENT_B],
        mode="discussion",
        max_rounds=3,
    )
    run = SimpleNamespace(
        workflow=workflow,
        inputs={
            "discussion": {
                "mode": "discussion",
                "maxRounds": 3,
                "participantIds": [AGENT_A, AGENT_B],
                "positions": {},
                "styles": {},
            }
        },
    )

    first_prompt = SubagentManager._discussion_system_instruction(run, workflow.steps[0])
    review_prompt = SubagentManager._discussion_system_instruction(run, workflow.steps[2])
    convergence_prompt = SubagentManager._discussion_system_instruction(run, workflow.steps[4])

    assert "独立发散阶段" in first_prompt
    assert "交叉评审阶段" in review_prompt
    assert "方案收敛阶段" in convergence_prompt


def test_discussion_summary_requires_constraints_solution_steps_risks_and_questions() -> None:
    workflow = build_discussion_workflow(
        ROOM_ID,
        "如何改善交付质量",
        [AGENT_A, AGENT_B],
        mode="discussion",
        max_rounds=2,
    )

    summary_task = workflow.steps[-1].task
    assert "目标与约束" in summary_task
    assert "最终方案" in summary_task
    assert "实施步骤" in summary_task
    assert "主要风险" in summary_task
    assert "待确认问题" in summary_task


def test_discussion_workflow_validates_positions_and_round_limit() -> None:
    with pytest.raises(ValueError, match="debate position is required"):
        build_discussion_workflow(
            ROOM_ID,
            "需要辩论的议题",
            [AGENT_A, AGENT_B],
            mode="debate",
            max_rounds=1,
            positions={AGENT_A: "支持"},
        )
    with pytest.raises(ValueError, match=f"1 and {MAX_DISCUSSION_ROUNDS}"):
        build_discussion_workflow(
            ROOM_ID,
            "轮次限制",
            [AGENT_A, AGENT_B],
            mode="discussion",
            max_rounds=MAX_DISCUSSION_ROUNDS + 1,
        )
    with pytest.raises(ValueError, match="unsupported debate style"):
        build_discussion_workflow(
            ROOM_ID,
            "不允许自定义风格",
            [AGENT_A, AGENT_B],
            mode="debate",
            max_rounds=1,
            positions={AGENT_A: "支持", AGENT_B: "反对"},
            styles={AGENT_A: "custom_style"},
        )
    maximum = build_discussion_workflow(
        ROOM_ID,
        "九十九轮",
        [AGENT_A, AGENT_B],
        mode="debate",
        max_rounds=MAX_DISCUSSION_ROUNDS,
        positions={AGENT_A: "支持", AGENT_B: "反对"},
    )
    assert len(maximum.steps) == MAX_DISCUSSION_ROUNDS * 2 + 1
    assert "最后一轮结辩" in maximum.steps[-2].task


def test_debate_can_run_without_a_judge_step() -> None:
    workflow = build_discussion_workflow(
        ROOM_ID,
        "不设置裁判",
        [AGENT_A, AGENT_B],
        mode="debate",
        max_rounds=2,
        positions={AGENT_A: "支持", AGENT_B: "反对"},
        summary_agent_id=None,
    )

    assert len(workflow.steps) == 4
    assert all(step.id != "summary" for step in workflow.steps)
    assert workflow.steps[-1].id == "round-2-speaker-2"
    assert "最后一轮结辩" in workflow.steps[-1].task


def test_discussion_replay_keeps_latest_topic_card_state() -> None:
    base = {
        "event": "discussion_updated",
        "chat_id": ROOM_ID,
        "id": "run-topic",
        "roomId": ROOM_ID,
        "workflow": {"id": "discussion-debate-1", "steps": []},
        "steps": {},
    }
    messages = replay_transcript_to_ui_messages([
        {**base, "status": "running"},
        {**base, "status": "succeeded"},
    ])

    assert len(messages) == 1
    assert messages[0]["kind"] == "discussion"
    assert messages[0]["workflowRunId"] == "run-topic"
    assert messages[0]["payload"]["status"] == "succeeded"


def test_discussion_run_broadcasts_topic_event_instead_of_workflow_event() -> None:
    async def main() -> tuple[AsyncMock, AsyncMock]:
        channel = WebSocketChannel(
            {
                "enabled": True,
                "allowFrom": ["*"],
                "host": "127.0.0.1",
                "port": 29877,
                "path": "/ws",
                "websocketRequiresToken": False,
            },
            MessageBus(),
        )
        discussion_send = AsyncMock()
        workflow_send = AsyncMock()
        channel.send_discussion_updated = discussion_send  # type: ignore[method-assign]
        channel.send_workflow_run_updated = workflow_send  # type: ignore[method-assign]
        channel._try_append_webui_transcript = MagicMock()
        channel._on_workflow_run_updated(
            ROOM_ID,
            {
                "id": "run-topic",
                "status": "running",
                "workflow": {"id": "discussion-debate-1", "steps": []},
                "steps": {},
            },
        )
        await asyncio.sleep(0)
        return discussion_send, workflow_send

    discussion_send, workflow_send = asyncio.run(main())
    discussion_send.assert_awaited_once()
    workflow_send.assert_not_awaited()


def test_debate_stance_is_a_system_level_non_neutral_contract() -> None:
    workflow = build_discussion_workflow(
        ROOM_ID,
        "名画和猫只能救一个",
        [AGENT_A, AGENT_B],
        mode="debate",
        max_rounds=1,
        positions={AGENT_A: "必须救名画", AGENT_B: "必须救猫"},
    )
    run = SimpleNamespace(
        workflow=workflow,
        inputs={
            "discussion": {
                "mode": "debate",
                "maxRounds": 1,
                "participantIds": [AGENT_A, AGENT_B],
                "positions": {AGENT_A: "必须救名画", AGENT_B: "必须救猫"},
                "styles": {AGENT_A: "value_reframe"},
            }
        },
    )

    instruction = SubagentManager._discussion_system_instruction(run, workflow.steps[0])

    assert "# 议题活动背景" in instruction
    assert "议题：名画和猫只能救一个" in instruction
    assert "模式：立场辩论" in instruction
    assert "当前进度：第 1/1 轮" in instruction
    assert "必须且只能主张：必须救名画" in instruction
    assert "禁止中立" in instruction
    assert "禁止同时论证双方" in instruction
    assert "没有标准答案" in instruction
    assert "# 可选表达风格（软约束）" in instruction
    assert "重新解释辩题中的关键词" in instruction
    assert "不要模仿任何真人的口头禅" in instruction
    assert "# 当前阶段：结辩" in instruction
    assert "# 结辩要求（最后一轮）" in instruction
    assert "不得临时引入此前未铺垫的新主论点" in instruction
    summary_instruction = SubagentManager._discussion_system_instruction(
        run, workflow.steps[-1]
    )
    assert "# 当前阶段：中立裁判" in summary_instruction
    assert "所有预定轮次均已结束" in summary_instruction
    assert "裁决：<胜方立场>胜" in summary_instruction
    assert "不得以‘各有道理’回避裁决" in summary_instruction
    assert "可选表达风格" not in summary_instruction


def test_free_discussion_system_prompt_explains_context_and_response_duty() -> None:
    workflow = build_discussion_workflow(
        ROOM_ID,
        "如何改善交付质量",
        [AGENT_A, AGENT_B],
        mode="discussion",
        max_rounds=2,
    )
    run = SimpleNamespace(
        workflow=workflow,
        inputs={
            "discussion": {
                "mode": "discussion",
                "maxRounds": 2,
                "participantIds": [AGENT_A, AGENT_B],
                "positions": {},
                "styles": {},
            }
        },
    )

    instruction = SubagentManager._discussion_system_instruction(run, workflow.steps[1])

    assert "模式：自由讨论" in instruction
    assert "第 1/2 轮" in instruction
    assert "独立发散阶段" in instruction
    assert "独立提出多个有明显差异的方案方向" in instruction
    assert "暂不评价其他参与者" in instruction
    assert "不要复述其观点" in instruction
    assert "核心价值、关键组成和主要约束" in instruction


@pytest.mark.asyncio
async def test_six_round_discussion_executes_all_turns_before_summary(tmp_path: Path) -> None:
    workflow = build_discussion_workflow(
        ROOM_ID,
        "名画和猫只能救一个",
        [AGENT_A, AGENT_B],
        mode="debate",
        max_rounds=6,
        positions={AGENT_A: "必须救名画", AGENT_B: "必须救猫"},
    )
    executed: list[str] = []

    async def execute(_run, step, _upstream) -> str:
        executed.append(step.id)
        return step.id

    runner = WorkflowRunner(
        run_store=WorkflowRunStore(tmp_path / "runs"),
        step_executor=execute,
    )
    result = await runner.run(
        room_id=ROOM_ID,
        workflow=workflow,
        conversation=ConversationMetadata.room([MONA_AGENT_ID, AGENT_A, AGENT_B]),
        registry=_registry(tmp_path),
    )

    assert result.status == RUN_STATUS_SUCCEEDED
    assert len(executed) == 13
    assert executed[:4] == [
        "round-1-speaker-1",
        "round-1-speaker-2",
        "round-2-speaker-1",
        "round-2-speaker-2",
    ]
    assert executed[-3:] == ["round-6-speaker-1", "round-6-speaker-2", "summary"]


@pytest.mark.asyncio
async def test_start_discussion_has_a_dedicated_wire_command() -> None:
    channel = WebSocketChannel(
        {
            "enabled": True,
            "allowFrom": ["*"],
            "host": "127.0.0.1",
            "port": 29877,
            "path": "/ws",
            "websocketRequiresToken": False,
        },
        MessageBus(),
    )
    channel._route_room_agent_mentions = AsyncMock(return_value=True)  # type: ignore[method-assign]

    await channel._handle_start_discussion_envelope(
        AsyncMock(),
        sender_id="client-1",
        envelope={
            "type": "start_discussion",
            "chat_id": ROOM_ID,
            "content": "名画和猫只能救一个",
            "target_agent_ids": [AGENT_A, AGENT_B],
            "discussion": {
                "mode": "debate",
                "max_rounds": 6,
                "positions": {AGENT_A: "救画", AGENT_B: "救猫"},
                "summary_agent_id": MONA_AGENT_ID,
            },
            "display_content": "发起议题：名画和猫只能救一个",
            "webui": True,
        },
    )

    channel._route_room_agent_mentions.assert_awaited_once()  # type: ignore[attr-defined]
    kwargs = channel._route_room_agent_mentions.await_args.kwargs  # type: ignore[attr-defined]
    assert kwargs["raw_targets"] == [AGENT_A, AGENT_B]
    assert kwargs["raw_discussion"]["max_rounds"] == 6
    assert kwargs["metadata"]["display_content"].startswith("发起议题")
