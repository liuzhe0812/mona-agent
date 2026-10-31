"""Recovered native completion resumes required results, never the original request."""
import asyncio
from dataclasses import replace

import pytest
from test_native_workbench import setup, trace, wait_run
from test_restart_recovery import restart

from mona.development.contracts import DevelopmentSession, ExecutorId, RunStatus


def finish_required_child(runtime, project, parent, run):
    child = DevelopmentSession(project_id=project.id, parent_session_id=parent.id, readonly=True)
    record, _ = runtime.store.prepare_collaboration(parent.id, "required_child", "fixture-result", child,
        goal="inspect the current project", expected_output="read-only findings", parent_run_id=run.id, required=True)
    child_run, _ = runtime.store.create_run(child.id, record.request_id, "child_message")
    for status in (RunStatus.PREPARING, RunStatus.RUNNING, RunStatus.SUCCEEDED):
        child_run = runtime.store.transition_run(child_run.id, child_run.revision, status)
    transcript = runtime.sessions.get_or_create(child.transcript_key)
    transcript.add_message("assistant", "REQUIRED_CHILD_RESULT", id="child_result", run_id=child_run.id)
    runtime.sessions.save(transcript, fsync=True)
    runtime.store.set_collaboration_state(record.id, "submitted")
    return record


async def await_recovery(runtime, session_id):
    runtime.schedule_recovery(session_id)
    runtime.schedule_recovery(session_id)
    await asyncio.gather(*runtime._recovery_tasks.values())


@pytest.mark.asyncio
async def test_completed_native_recovery_integrates_required_result_once_with_same_leader(tmp_path, monkeypatch):
    runtime, project, root, host = await setup(tmp_path)
    host.profile = replace(host.profile, command=(*host.profile.command, "complete_requests"))
    parent = runtime.store.create_session(project.id, ExecutorId.CODEX)
    await runtime.submit(parent.id, "original_request", "history_only")
    run = await wait_run(runtime, parent.id, RunStatus.RUNNING)
    child = finish_required_child(runtime, project, parent, run)
    runtime = await restart(runtime, root, host, run)

    def no_hidden_model(*args, **kwargs):
        raise AssertionError("Native result integration must use the original native leader")

    monkeypatch.setattr("mona.development.runtime.build_provider_snapshot", no_hidden_model)
    try:
        await await_recovery(runtime, parent.id)
        async with asyncio.timeout(5):
            while len(runtime.store.list_runs(parent.id)) < 2 or runtime.tasks:
                await asyncio.sleep(.01)

        runs = runtime.store.list_runs(parent.id)
        assert len(runs) == 2 and all(value.status == RunStatus.SUCCEEDED for value in runs)
        assert all(value.executor == ExecutorId.CODEX and value.binding_id == run.binding_id for value in runs)
        assert runs[1].id == run.id and runs[1].continuation_input_id == runs[0].request_id
        assert len(runtime.store.list_runs(child.child_session_id)) == 1
        assert runtime.store.get_collaboration(child.id).return_message_id
        calls = [call for call in trace(root) if call.get("method") == "turn/start"]
        assert len(calls) == 2
        assert "REQUIRED_CHILD_RESULT" in calls[-1]["params"]["input"][0]["text"]
        assert (await runtime.submit(parent.id, "original_request", "history_only"))["reused"]
        runtime.schedule_recovery(parent.id)
        assert len([call for call in trace(root) if call.get("method") == "turn/start"]) == 2
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_incomplete_native_history_does_not_start_required_integration(tmp_path, monkeypatch):
    runtime, project, root, host = await setup(tmp_path)
    parent = runtime.store.create_session(project.id, ExecutorId.CODEX)
    await runtime.submit(parent.id, "original_request", "hold")
    run = await wait_run(runtime, parent.id, RunStatus.RUNNING)
    finish_required_child(runtime, project, parent, run)
    runtime = await restart(runtime, root, host, run)
    async def missing_history(*args):
        return []
    adapter = runtime.native.hosts[(project.id, ExecutorId.CODEX)]
    monkeypatch.setattr(adapter, "inspect_turn", missing_history)
    try:
        await await_recovery(runtime, parent.id)
        assert runtime.store.get_run(run.id).status == RunStatus.UNKNOWN
        assert len(runtime.store.list_runs(parent.id)) == 1 and not runtime.tasks
        assert sum(call.get("method") == "turn/start" for call in trace(root)) == 1
    finally:
        await runtime.close()
