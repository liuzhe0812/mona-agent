import pytest
from test_native_service import setup, wait_status

from mona.development.contracts import Binding, ExecutorId, RunStatus
from mona.development.executors.base import NativeEvent
from mona.development.executors.sdk_events import SDKEventProjector
from mona.development.native_service import NativeRunService
from mona.development.store import ConflictError, DevelopmentStore
from mona.session.manager import SessionManager


@pytest.mark.asyncio
async def test_split_sdk_authoritative_envelopes_preserve_tool_identity(tmp_path):
    store = DevelopmentStore(tmp_path / "state.sqlite3")
    project = store.open_project(tmp_path)
    session = store.create_session(project.id, ExecutorId.CODEBUDDY, readonly=True)
    binding = store.activate_binding(Binding(session_id=session.id, executor=ExecutorId.CODEBUDDY,
        native_session_id="synthetic-session", working_directory=str(tmp_path.resolve()), readonly=True), session.revision)
    run, _ = store.create_run(session.id, "split_envelopes", "synthetic-input", binding.id)
    run = store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    run = store.bind_native_turn(run.id, binding.id, "sdk:split_envelopes")
    run = store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    service = NativeRunService(store, SessionManager(tmp_path / "history"))
    projector = SDKEventProjector(binding.native_session_id)
    projector.begin(run.native_turn_id)
    messages = [
        {"type": "stream_event", "event": {"type": "message_start", "message": {"id": "provider-message"}}},
        {"type": "stream_event", "event": {"type": "content_block_start", "index": 0,
            "content_block": {"type": "thinking", "thinking": "Inspect"}}},
        {"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}},
        {"type": "stream_event", "event": {"type": "content_block_start", "index": 1,
            "content_block": {"type": "text", "text": ""}}},
        {"type": "stream_event", "uuid": "text-part", "event": {"type": "content_block_delta", "index": 1,
            "delta": {"type": "text_delta", "text": "Inspecting"}}},
        {"type": "stream_event", "event": {"type": "content_block_start", "index": 2,
            "content_block": {"type": "tool_use", "id": "tool-a", "name": "Glob", "input": {}}}},
        {"type": "stream_event", "event": {"type": "content_block_start", "index": 3,
            "content_block": {"type": "tool_use", "id": "tool-b", "name": "Glob", "input": {}}}},
        {"type": "assistant", "content": [{"type": "thinking", "thinking": "Inspect the project."}]},
        {"type": "assistant", "content": [{"type": "text", "text": "Inspecting files."}]},
        {"type": "assistant", "content": [{"type": "tool_use", "id": "tool-a", "name": "Glob", "input": {"pattern": "*.py"}}]},
        {"type": "assistant", "content": [{"type": "tool_use", "id": "tool-b", "name": "Glob", "input": {"pattern": "*.ts"}}]},
        {"type": "user", "content": [{"type": "tool_result", "tool_use_id": "tool-a", "content": "source.py"},
                                    {"type": "tool_result", "tool_use_id": "tool-b", "content": "source.ts"}]},
        {"type": "assistant", "content": [{"type": "text", "text": "Found the requested source files."}]},
        {"type": "result", "session_id": binding.native_session_id, "subtype": "success", "is_error": False},
    ]
    try:
        for message in messages:
            for event in projector.consume(message):
                service._record(store.get_run(run.id), binding, event)
                service._record(store.get_run(run.id), binding, event)
        assert store.get_run(run.id).status == RunStatus.SUCCEEDED
        events = store.events_after(session.id)
        for tool_id in ("tool-a", "tool-b"):
            starts = [event for event in events if event.type == "tool.started" and event.payload["itemId"] == tool_id]
            assert [event.payload["inputStreaming"] for event in starts] == [True, False]
            assert len([event for event in events if event.type == "tool.completed" and event.payload["itemId"] == tool_id]) == 1
        transcript = service.sessions.get_or_create(session.transcript_key)
        assert transcript.messages[-1]["content"] == "Found the requested source files."
        assert [message["content"] for message in transcript.messages] == ["Inspecting files.", "Found the requested source files."]
        assert len({event.payload["itemId"] for event in events if event.type.startswith("reasoning.")}) == 1
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_context_usage_keeps_model_route_when_replayed(tmp_path):
    service, adapter, store, session, binding, _ = await setup(tmp_path)
    try:
        run = await service.submit(session.id, "request_usage", "hold")
        run = await wait_status(store, run.id, {RunStatus.RUNNING})
        usage = NativeEvent(native_event_id="usage-one", native_turn_id=run.native_turn_id,
            type="usage.updated", payload={"contextTokens": 12000, "contextWindow": 258400})
        service._record(run, binding, usage)
        service._record(run, binding, usage)
        events = [e for e in store.events_after(session.id) if e.type == "usage.updated"]
        assert len(events) == 1
        assert events[0].payload.items() >= {
            "contextTokens": 12000, "contextWindow": 258400, "executor": "codex",
            "selectedModel": session.model, "modelProvider": session.model_provider,
        }.items()
    finally:
        await service.close()
        await adapter.shutdown()


@pytest.mark.asyncio
async def test_event_replay_and_transcript_before_metadata_crash_are_idempotent(tmp_path, monkeypatch):
    service, adapter, store, session, binding, _ = await setup(tmp_path)
    try:
        run = await service.submit(session.id, "request_replay", "hold")
        run = await wait_status(store, run.id, {RunStatus.RUNNING})
        one = NativeEvent(native_event_id="delta-one", native_turn_id=run.native_turn_id,
                          type="agent.message.delta", payload={"itemId": "stream", "delta": "a"})
        service._record(run, binding, one)
        service._record(store.get_run(run.id), binding, one)
        record = store.record_native_event
        monkeypatch.setattr(store, "record_native_event", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("simulated crash boundary")))
        two = NativeEvent(native_event_id="delta-two", native_turn_id=run.native_turn_id,
                          type="agent.message.delta", payload={"itemId": "stream", "delta": "b"})
        with pytest.raises(OSError):
            service._record(store.get_run(run.id), binding, two)
        service.sessions.invalidate(session.transcript_key)
        monkeypatch.setattr(store, "record_native_event", record)
        service._record(store.get_run(run.id), binding, two)
        service._record(store.get_run(run.id), binding, one)
        messages = service.sessions.get_or_create(session.transcript_key).messages
        assert [m["content"] for m in messages if m.get("native_item_id") == "stream"] == ["ab"]
        changed = one.model_copy(update={"payload": {"itemId": "stream", "delta": "different"}})
        with pytest.raises(ConflictError):
            service._record(store.get_run(run.id), binding, changed)
    finally:
        await service.close()
        await adapter.shutdown()
