import pytest

from mona.development.contracts import InputState, RunInput, RunStatus
from mona.development.fork import fork_session
from tests.development.test_workbench_runtime import Model, make_runtime


def begin_run(runtime, session, index):
    run, _ = runtime.store.create_run(session.id, f"request_{index}", f"user_{index}")
    for status in (RunStatus.PREPARING, RunStatus.RUNNING):
        run = runtime.store.transition_run(run.id, run.revision, status)
    return run


def finish_run(runtime, session, run, index):
    transcript = runtime.sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", f"request {index}", id=f"user_{index}", run_id=run.id)
    transcript.add_message("assistant", f"result {index}", id=f"assistant_{index}", run_id=run.id)
    assert runtime.store.append_run_event(run.id, "tool.completed", {"itemId": f"tool_{index}"})
    return runtime.store.transition_run(run.id, run.revision, RunStatus.SUCCEEDED)


def add_runs(runtime, session, start, stop):
    return [finish_run(runtime, session, begin_run(runtime, session, index), index)
            for index in range(start, stop)]


def test_old_pending_inputs_keep_identity_source_and_session_scope(tmp_path, monkeypatch):
    runtime, project, session, _ = make_runtime(tmp_path, monkeypatch, Model())
    run = begin_run(runtime, session, 0)
    transcript = runtime.sessions.get_or_create(session.transcript_key)
    items = []
    for name, state in (("pending", InputState.PENDING), ("reserved", InputState.RESERVED),
                        ("unknown", InputState.UNKNOWN), ("delivered", InputState.PENDING)):
        item = runtime.store.enqueue_input(RunInput(id=f"input_{name}", session_id=session.id,
            run_id=run.id, message_id=f"message_{name}"))
        if state != InputState.PENDING:
            item = runtime.store.transition_input(item.id, item.revision, InputState.RESERVED)
        if state == InputState.UNKNOWN:
            item = runtime.store.transition_input(item.id, item.revision, InputState.UNKNOWN)
        transcript.add_message("user", name, id=item.message_id, run_id=run.id, _ui_only=True,
            _input_source={"content": name, "docPaths": ["attachment.png"], "documentNames": ["attachment.png"]},
            _input_delivered=name == "delivered")
        items.append(item)
    finish_run(runtime, session, run, 0)
    add_runs(runtime, session, 1, 27)
    other = runtime.store.create_session(project.id)
    foreign_run = begin_run(runtime, other, "foreign")
    runtime.store.enqueue_input(RunInput(id="input_foreign", session_id=other.id,
        run_id=foreign_run.id, message_id="message_foreign"))
    before = [runtime.store.get_input(item.id) for item in items]

    snapshot = runtime.snapshot(session.id)

    assert [(item["id"], item["state"]) for item in snapshot["pendingInputs"]] == [
        ("input_pending", "pending"), ("input_reserved", "reserved"), ("input_unknown", "unknown")]
    assert snapshot["pendingInputs"][0]["source"] == {
        "content": "pending", "docPaths": ["attachment.png"], "documentNames": ["attachment.png"]}
    assert [runtime.store.get_input(item.id) for item in items] == before


def test_message_pages_and_event_batches_include_only_their_needed_run_identities(tmp_path, monkeypatch):
    runtime, project, session, _ = make_runtime(tmp_path, monkeypatch, Model())
    runs = add_runs(runtime, session, 0, 35)
    other = runtime.store.create_session(project.id)
    foreign = finish_run(runtime, other, begin_run(runtime, other, "foreign"), "foreign")
    all_events = runtime.store.events_after(session.id, 0, 500)
    last_sequence = all_events[-1].sequence

    old_page = runtime.snapshot(session.id, before=2, limit=2, after=last_sequence)
    assert {m["runId"] for m in old_page["messages"]} == {runs[0].id}
    assert runs[0].id in {run["id"] for run in old_page["runs"]}
    assert len(old_page["runs"]) == 21
    assert old_page["runs"][0]["id"] == runs[-1].id

    first_events = runtime.snapshot(session.id, limit=2, after=0)
    needed = {event["runId"] for event in first_events["events"] if event["runId"]}
    returned = {run["id"] for run in first_events["runs"]}
    assert len(first_events["events"]) == 100 and first_events["moreEvents"]
    assert needed <= returned
    assert foreign.id not in returned
    assert len(returned) <= 20 + len(needed) + 2


@pytest.mark.asyncio
async def test_forked_history_is_paged_with_inherited_identity_without_creating_runs(tmp_path, monkeypatch):
    runtime, _, session, _ = make_runtime(tmp_path, monkeypatch, Model())
    runs = add_runs(runtime, session, 0, 30)
    transcript = runtime.sessions.get_or_create(session.transcript_key)
    runtime.sessions.save(transcript)
    child = await fork_session(runtime, session.id, session.revision, "fork_history", "assistant_29")

    page = runtime.snapshot(child.id, before=2, limit=2, after=0)
    referenced = ({message["runId"] for message in page["messages"] if message["runId"]}
                  | {event["runId"] for event in page["events"] if event["runId"]})
    assert runs[0].id in referenced
    assert {run["id"] for run in page["runs"]} == referenced
    assert len(page["events"]) == 100 and page["moreEvents"]

    next_page = runtime.snapshot(child.id, limit=2, after=page["eventCursor"])
    assert {event["runId"] for event in next_page["events"] if event["runId"]} <= {
        run["id"] for run in next_page["runs"]}
    assert runtime.store.list_runs(child.id) == []
    await runtime.close()
