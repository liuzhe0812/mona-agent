"""Native transcript forks keep a new Code thread separate from their source."""
from __future__ import annotations

import json
import sys
from dataclasses import replace

import pytest

from mona.development.contracts import ExecutorId, PermissionMode, RunStatus
from mona.development.fork import fork_session
from tests.development.test_native_workbench import PEER, settle, setup, trace


@pytest.mark.asyncio
async def test_fork_native_reply_starts_independent_thread_with_only_selected_prefix(tmp_path, monkeypatch):
    runtime, project, root, adapter = await setup(tmp_path)
    adapter.profile = replace(adapter.profile, command=(sys.executable, "-u", str(PEER), "complete_requests"))

    def no_model(*args, **kwargs):
        raise AssertionError("Native requests must not call Mona model API")

    monkeypatch.setattr("mona.development.runtime.build_provider_snapshot", no_model)
    source = runtime.store.create_session(project.id, executor=ExecutorId.CODEX, model="example-model",
                                         permission_mode=PermissionMode.AUTO)
    transcript = runtime.sessions.get_or_create(source.transcript_key)
    for index in range(16):
        transcript.add_message("user" if index % 2 == 0 else "assistant", f"EARLY_CONTEXT_{index}", id=f"message_prior_{index}")
    runtime.sessions.save(transcript)
    try:
        first_reply = await runtime.submit(source.id, "source_first", "SOURCE_FIRST_ONLY")
        await settle(runtime)
        first = runtime.store.get_run(first_reply["run"]["id"])
        assert first.status == RunStatus.SUCCEEDED
        assert first.result_message_id

        second_reply = await runtime.submit(source.id, "source_second", "SOURCE_SECOND_ONLY")
        await settle(runtime)
        second = runtime.store.get_run(second_reply["run"]["id"])
        assert second.status == RunStatus.SUCCEEDED
        source = runtime.store.get_session(source.id)
        source_binding = runtime.store.list_bindings(source.id)[0]
        assert source_binding.native_session_id

        before_fork = trace(root)
        child = await fork_session(runtime, source.id, source.revision, "fork_first_reply", first.result_message_id)
        assert trace(root) == before_fork
        assert child.parent_session_id is None
        assert child.fork_source.source_session_id == source.id
        assert child.model == source.model == "example-model"
        assert child.permission_mode == source.permission_mode == PermissionMode.AUTO
        assert runtime.store.list_bindings(child.id) == []
        assert runtime.store.list_runs(child.id) == []
        assert runtime.native.decisions.list_pending(child.id) == []
        child_before_send = runtime.snapshot(child.id)
        assert child_before_send["nativeBinding"] is None
        assert child_before_send["pendingInputs"] == []
        assert "SOURCE_SECOND_ONLY" not in json.dumps(child_before_send["messages"], ensure_ascii=False)

        child_reply = await runtime.submit(child.id, "child_first", "CHILD_INPUT_ONLY")
        await settle(runtime)
        child_run = runtime.store.get_run(child_reply["run"]["id"])
        assert child_run.status == RunStatus.SUCCEEDED
        child_binding = runtime.store.list_bindings(child.id)[0]
        assert child_binding.native_session_id != source_binding.native_session_id
        assert child_binding.permission_mode == source_binding.permission_mode == PermissionMode.AUTO

        calls = trace(root)
        starts = [call for call in calls if call.get("method") == "thread/start"]
        assert len(starts) == 2
        assert not [call for call in calls if call.get("method") == "thread/resume"]
        child_start = next(call for call in calls if call.get("method") == "turn/start"
                           and call["params"]["threadId"] == child_binding.native_session_id)
        handoff = json.dumps(child_start["params"]["input"], ensure_ascii=False)
        assert "SOURCE_FIRST_ONLY" in handoff
        assert "EARLY_CONTEXT_2" in handoff
        assert "SOURCE_SECOND_ONLY" not in handoff
        child_thread_start = starts[-1]["params"]
        assert child_thread_start["model"] == source.model
        assert child_thread_start["approvalPolicy"] == "on-request"
        assert child_thread_start["sandbox"] == "workspace-write"

        source_reply = await runtime.submit(source.id, "source_after_fork", "SOURCE_CONTINUE_ONLY")
        await settle(runtime)
        assert runtime.store.get_run(source_reply["run"]["id"]).status == RunStatus.SUCCEEDED
        assert runtime.store.list_bindings(source.id)[0].native_session_id == source_binding.native_session_id
        calls = trace(root)
        assert len([call for call in calls if call.get("method") == "thread/start"]) == 2
        continued = [call for call in calls if call.get("method") == "turn/start"][-1]
        assert continued["params"]["threadId"] == source_binding.native_session_id
        assert "SOURCE_CONTINUE_ONLY" in json.dumps(continued["params"]["input"], ensure_ascii=False)
    finally:
        await runtime.close()
