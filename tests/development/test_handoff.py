import json

import pytest

from mona.development.context import load_project_context
from mona.development.contracts import Binding, ExecutorId, RunStatus
from mona.development.handoff import build_handoff
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore
from mona.session.manager import Session


def setup(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "AGENTS.md").write_text("Respect the current files.", encoding="utf-8")
    store = DevelopmentStore(tmp_path / "metadata.sqlite3")
    project = store.open_project(root)
    session = store.create_session(project.id, ExecutorId.CODEX)
    binding = store.activate_binding(Binding(session_id=session.id, executor=ExecutorId.CODEX,
        native_session_id="thread-a", working_directory=str(root)), session.revision)
    transcript = Session(key=session.transcript_key)
    return store, store.get_session(session.id), binding, load_project_context(project), transcript


def test_full_and_delta_are_bounded_and_exclude_tool_privacy(tmp_path):
    _, session, _, context, transcript = setup(tmp_path)
    transcript.add_message("system", "PRIVATE_PERSONA")
    transcript.add_message("tool", "PRIVATE_ENVIRONMENT")
    transcript.add_message("user", "Keep my edits; password=not-a-real-credential")
    transcript.add_message("assistant", "Implemented parser", reasoning_content="PRIVATE_REASONING")
    boundary = len(transcript.messages)
    transcript.add_message("user", "Now review error handling")
    full = build_handoff(context, session, transcript, goal="Improve parser")
    assert "Implemented parser" in full.content and "Now review" in full.content
    assert "PRIVATE_" not in full.content
    assert "not-a-real-credential" not in full.content
    delta = build_handoff(context, session, transcript, goal="Review", since=boundary)
    assert delta.mode == "delta" and "Implemented parser" not in delta.content
    assert delta.source_message_count == len(transcript.messages)
    assert "Now review" in delta.content
    for _ in range(20):
        transcript.add_message("assistant", "Long description " * 1000)
    bounded = build_handoff(context, session, transcript, goal="Review", max_chars=2500)
    assert len(bounded.content) <= 2500
    assert '"omittedConversationEntries":' in bounded.content
    assert "current user request follows" in bounded.content
    with pytest.raises(DevelopmentError):
        build_handoff(context, session, Session(key="another"), goal="Review")


def test_handoff_reserved_survives_restart_as_unknown_and_is_not_consumed(tmp_path):
    store, session, binding, context, transcript = setup(tmp_path)
    packet = build_handoff(context, session, transcript, goal="Continue")
    store.prepare_handoff(binding.id, session.revision, packet)
    run, _ = store.create_run(session.id, "request_one", "message_one", binding.id)
    store.transition_run(run.id, 0, RunStatus.PREPARING)
    reserved = store.reserve_handoff(binding.id, run.id)
    assert reserved.state == "reserved"
    again = DevelopmentStore(store.path)
    assert again.get_binding(binding.id).handoff.content == packet.content
    again.reconcile_after_restart()
    assert again.get_binding(binding.id).handoff.state == "unknown"
    assert again.get_run(run.id).status == RunStatus.UNKNOWN
    with pytest.raises(ConflictError):
        again.reserve_handoff(binding.id, run.id)
    with pytest.raises(ConflictError):
        again.resolve_handoff(binding.id, packet.id, run.request_id, "rejected")
    again.resolve_handoff(binding.id, packet.id, run.request_id, "accepted")
    assert again.get_binding(binding.id).handoff.state == "accepted"
    again.resolve_handoff(binding.id, packet.id, run.request_id, "unknown")
    assert again.get_binding(binding.id).handoff.state == "accepted"


def test_stale_acceptance_cannot_consume_new_handoff_and_adapter_cannot_replace_journal(tmp_path):
    store, session, binding, context, transcript = setup(tmp_path)
    packet = build_handoff(context, session, transcript, goal="First")
    store.prepare_handoff(binding.id, session.revision, packet)
    run, _ = store.create_run(session.id, "request_first", "message_first", binding.id)
    run = store.transition_run(run.id, 0, RunStatus.PREPARING)
    store.reserve_handoff(binding.id, run.id)
    store.resolve_handoff(binding.id, packet.id, run.request_id, "accepted")
    run = store.transition_run(run.id, run.revision, RunStatus.RUNNING)
    store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)
    new_packet = build_handoff(context, session, transcript, goal="Second")
    store.prepare_handoff(binding.id, session.revision, new_packet)
    with pytest.raises(ConflictError):
        store.resolve_handoff(binding.id, packet.id, run.request_id, "accepted")
    restored = store.activate_binding(binding, session.revision)
    assert restored.handoff.id == new_packet.id
    assert restored.handoff.state == "pending"
    with pytest.raises(ConflictError):
        store.prepare_handoff(binding.id, session.revision, packet)


def test_state_and_event_are_committed_together_without_duplicate_or_cross_session(tmp_path):
    store, session, binding, _, _ = setup(tmp_path)
    run, _ = store.create_run(session.id, "request_first", "message_first", binding.id)
    run = store.transition_run(run.id, 0, RunStatus.PREPARING)
    run = store.bind_native_turn(run.id, binding.id, "turn-a")
    assert store.record_native_event(run.id, binding.id, "event_started", "run.started", {"turnId": "turn-a"}, status=RunStatus.RUNNING)
    assert not store.record_native_event(run.id, binding.id, "event_started", "run.started", {"turnId": "turn-a"}, status=RunStatus.RUNNING)
    assert store.get_run(run.id).status == RunStatus.RUNNING
    with pytest.raises(ConflictError):
        store.record_native_event(run.id, binding.id, "event_started", "run.started", {"turnId": "turn-other"})
    with pytest.raises(ConflictError):
        store.bind_native_turn(run.id, binding.id, "turn-other")
    current = store.get_run(run.id)
    store.transition_run(run.id, current.revision, RunStatus.INTERRUPTING)
    assert store.record_native_event(run.id, binding.id, "event_done", "run.interrupted", {}, status=RunStatus.INTERRUPTED)
    assert not store.record_native_event(run.id, binding.id, "event_late", "run.completed", {}, status=RunStatus.SUCCEEDED)
    assert store.get_run(run.id).status == RunStatus.INTERRUPTED
    events = store.events_after(session.id)
    assert len([e for e in events if e.id == "event_done"]) == 1
    assert "turn-other" not in json.dumps([e.payload for e in events])
