"""Exact native rebind semantics through production adapters and real test pipes.

The native peer is a protocol fixture, not vendor CLI/account acceptance.
"""
from __future__ import annotations

import json
import sys
from dataclasses import replace

import pytest
from test_native_workbench import settle, setup, trace, wait_run
from test_sdk_workbench import setup as sdk_setup
from test_sdk_workbench import trace as sdk_trace

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.contracts import ExecutorId, RunStatus
from mona.development.executors.codex import CodexExecutor, _missing_resume
from mona.development.executors.host_tools import COLLABORATION_POLICY_TAG, DELEGATION_INSTRUCTIONS
from mona.development.executors.rpc import MissingNativeSessionError, RpcError
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import ConflictError, DevelopmentStore
from mona.session.manager import SessionManager


async def completed(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    await runtime.submit(session.id, "request_initial", "instant")
    await settle(runtime)
    return runtime, root, host, runtime.store.get_session(session.id), runtime.store.list_bindings(session.id)[0]


def fail_resume(root, binding, *, message=None, code=-32600, silence=False):
    (root / "resume-error.json").write_text(json.dumps({"code": code,
        "message": message or f"no rollout found for thread id {binding.native_session_id}", "silence": silence}), encoding="utf8")
    # A real project-resource change requires reattaching with current rules.
    (root / "AGENTS.md").write_text("UPDATED_PROJECT_RULE: preserve current files", encoding="utf8")


@pytest.mark.asyncio
async def test_exact_missing_idle_history_rebinds_once_and_preserves_product(tmp_path):
    runtime, root, _, session, previous = await completed(tmp_path)
    manual = root / "manual.py"
    manual.write_text("# HUMAN_CHANGE\nanswer = 42\n", encoding="utf8")
    before = runtime.sessions.get_or_create(session.transcript_key).messages.copy()
    fail_resume(root, previous)
    try:
        sent = await runtime.submit(session.id, "request_continue", "instant")
        await settle(runtime)
        bindings = runtime.store.list_bindings(session.id)
        active = next(b for b in bindings if b.state == "active")
        assert len(bindings) == 2 and active.replaces_binding_id == previous.id
        assert active.replacement_reason == "history_missing" and active.native_session_id != previous.native_session_id
        assert runtime.store.get_binding(previous.id).state == "stale"
        assert active.handoff.mode == "full" and active.handoff.state == "accepted"
        assert runtime.sessions.get_or_create(session.transcript_key).messages[:len(before)] == before
        assert manual.read_text(encoding="utf8") == "# HUMAN_CHANGE\nanswer = 42\n"
        again = await runtime.submit(session.id, "request_continue", "instant")
        assert again["reused"] and again["run"]["id"] == sent["run"]["id"]
        calls = trace(root)
        assert sum(r.get("method") == "thread/start" for r in calls) == 2
        assert sum(r.get("method") == "turn/start" for r in calls) == 2
        assert len(runtime.store.list_sessions(session.project_id)) == 1
        snap = runtime.snapshot(session.id)
        assert snap["nativeBinding"]["replacesBindingId"] == previous.id
        assert "content" not in snap["nativeBinding"] and "nativeSessionId" not in snap["nativeBinding"]
        assert len([e for e in runtime.store.events_after(session.id) if e.type == "executor.reconnected"]) == 1
    finally:
        await runtime.close()


@pytest.mark.parametrize("message,code,silence", [
    ("failed to load configuration: project settings invalid", -32600, False),
    ("authentication required", -32600, False),
    ("no rollout found for thread id some-other-thread", -32600, False),
    ("unrelated transport error", -32000, False),
    ("no reply", -32600, True),
])
@pytest.mark.asyncio
async def test_other_resume_errors_do_not_create_replacement(tmp_path, message, code, silence):
    runtime, root, _, session, previous = await completed(tmp_path)
    fail_resume(root, previous, message=message, code=code, silence=silence)
    try:
        with pytest.raises(RpcError):
            await runtime.submit(session.id, "request_continue", "instant")
        assert runtime.store.list_bindings(session.id) == [previous]
        assert len(runtime.store.list_runs(session.id)) == 1
        assert sum(r.get("method") == "thread/start" for r in trace(root)) == 1
        assert sum(r.get("method") == "turn/start" for r in trace(root)) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_unknown_run_cannot_be_replaced_even_when_resume_history_is_missing(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(session.id, "request_held", "hold")
        run = await wait_run(runtime, session.id, RunStatus.RUNNING)
        binding = runtime.store.list_bindings(session.id)[0]
        await host._client.close()
        await wait_run(runtime, session.id, RunStatus.UNKNOWN)
        fail_resume(root, binding)
        with pytest.raises(MissingNativeSessionError):
            await runtime.recover_native(session.id, run.id)
        assert runtime.store.get_run(run.id).status == RunStatus.UNKNOWN
        assert len(runtime.store.list_bindings(session.id)) == 1
        assert sum(r.get("method") == "thread/start" for r in trace(root)) == 1
        assert sum(r.get("method") == "turn/start" for r in trace(root)) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_restart_replayed_old_codex_usage_does_not_poison_new_run(tmp_path):
    runtime, project, root, first_host = await setup(tmp_path)
    first_host.profile = replace(first_host.profile,
                                 command=(*first_host.profile.command, "codex_modern"))
    (root / "usage-events.json").write_text(json.dumps({
        "replayedContextTokens": 9001, "currentContextTokens": 222,
    }), encoding="utf8")
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        first = await runtime.submit(session.id, "request_before_restart", "instant")
        await settle(runtime)
        first_run = runtime.store.get_run(first["run"]["id"])
        assert first_run.status == RunStatus.SUCCEEDED
        previous_messages = runtime.sessions.get_or_create(session.transcript_key).messages.copy()
        previous_binding = runtime.store.list_bindings(session.id)[0]
        previous_turn_id = first_run.native_turn_id
    finally:
        await runtime.close()

    config = Config()
    _resolve_tool_config_refs()
    config.development.codex_path = sys.executable
    config.development.enabled_engines = ["codex"]
    restarted = DevelopmentRuntime(
        DevelopmentStore(tmp_path / "state.sqlite3"),
        SessionManager(tmp_path / "history"),
        lambda: config,
    )
    restarted.native.hosts[(project.id, ExecutorId.CODEX)] = CodexExecutor(
        first_host.profile, request_timeout=2,
    )
    try:
        second = await restarted.submit(session.id, "request_after_restart", "instant")
        await settle(restarted)
        second_run = restarted.store.get_run(second["run"]["id"])
        assert second_run.status == RunStatus.SUCCEEDED
        assert second_run.binding_id == previous_binding.id
        assert second_run.native_turn_id != previous_turn_id

        usage = [event.payload for event in restarted.store.events_after(session.id, limit=500)
                 if event.run_id == second_run.id and event.type == "usage.updated"]
        assert [event["contextTokens"] for event in usage] == [222]
        assert 9001 not in [event["contextTokens"] for event in usage]

        calls = trace(root)
        resume = next(call for call in calls if call.get("method") == "thread/resume")
        assert resume["params"]["excludeTurns"] is True
        turn_starts = [call for call in calls if call.get("method") == "turn/start"]
        current_messages = restarted.sessions.get_or_create(
            restarted.store.get_session(session.id).transcript_key,
        ).messages
        assert [call["params"]["clientUserMessageId"] for call in turn_starts] == [
            "request_before_restart", "request_after_restart",
        ]
        restored_bindings = restarted.store.list_bindings(session.id)
        assert len(restored_bindings) == 1
        assert restored_bindings[0].id == previous_binding.id
        assert restored_bindings[0].native_session_id == previous_binding.native_session_id
        assert current_messages[:len(previous_messages)] == previous_messages
    finally:
        await restarted.close()


@pytest.mark.parametrize("executor", list(ExecutorId)[1:])
@pytest.mark.asyncio
async def test_explicit_idle_reconnect_for_each_executor_is_idempotent_and_does_not_send(tmp_path, monkeypatch, executor):
    if executor == ExecutorId.CODEX:
        runtime, project, root, _ = await setup(tmp_path)
        read_trace, start_name, send_name = trace, "thread/start", "turn/start"
    else:
        runtime, project, root, _ = await sdk_setup(tmp_path, monkeypatch, executor)
        read_trace, start_name, send_name = sdk_trace, "connect", "query"
    session = runtime.store.create_session(project.id, executor)
    try:
        await runtime.submit(session.id, "request_first", "instant")
        await settle(runtime)
        before = runtime.store.get_session(session.id)
        previous = runtime.store.list_bindings(session.id)[0]
        result = await runtime.reconnect_native(session.id, before.revision, previous.id)
        active = next(b for b in runtime.store.list_bindings(session.id) if b.state == "active")
        assert result.id == session.id and active.replacement_reason == "user_requested"
        assert active.handoff.mode == "full" and active.handoff.state == "pending"
        duplicate = await runtime.reconnect_native(session.id, before.revision, previous.id)
        assert duplicate == result
        assert sum(r.get("method") == start_name for r in read_trace(root)) == 2
        assert sum(r.get("method") == send_name for r in read_trace(root)) == 1
        await runtime.submit(session.id, "request_after", "instant")
        await settle(runtime)
        assert sum(r.get("method") == send_name for r in read_trace(root)) == 2
        assert len(runtime.store.list_runs(session.id)) == 2
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_reconnect_rejects_wrong_owner_stale_revision_and_busy_session(tmp_path):
    runtime, root, _, session, previous = await completed(tmp_path)
    try:
        other = runtime.store.create_session(session.project_id, ExecutorId.CODEX)
        with pytest.raises(ConflictError):
            await runtime.reconnect_native(other.id, other.revision, previous.id)
        with pytest.raises(ConflictError):
            await runtime.reconnect_native(session.id, session.revision - 1, previous.id)
        await runtime.submit(session.id, "request_hold", "hold")
        await wait_run(runtime, session.id, RunStatus.RUNNING)
        current = runtime.store.get_session(session.id)
        with pytest.raises(ConflictError):
            await runtime.reconnect_native(session.id, current.revision, previous.id)
        assert sum(r.get("method") == "thread/start" for r in trace(root)) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_replacement_commit_failure_retains_old_binding_and_releases_unused_native(tmp_path, monkeypatch):
    runtime, root, _, session, previous = await completed(tmp_path)
    record_event = runtime.store._event
    def fail(db, owner, kind, payload, run=None):
        if kind == "executor.reconnected":
            raise OSError("test-only storage fault during atomic commit")
        return record_event(db, owner, kind, payload, run)
    monkeypatch.setattr(runtime.store, "_event", fail)
    try:
        with pytest.raises(OSError):
            await runtime.reconnect_native(session.id, session.revision, previous.id)
        assert runtime.store.list_bindings(session.id) == [previous]
        assert len(runtime.store.list_runs(session.id)) == 1
        assert sum(r.get("method") == "thread/unsubscribe" for r in trace(root)) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_fallback_keeps_model_selection_and_later_switch_resumes_successor(tmp_path):
    runtime, root, _, session, previous = await completed(tmp_path)
    try:
        await runtime.switch_executor(session.id, session.revision, ExecutorId.MONA, None)
        fail_resume(root, previous)
        selected = runtime.store.get_session(session.id)
        await runtime.switch_executor(session.id, selected.revision, ExecutorId.CODEX, "native-model-two")
        current = runtime.store.get_session(session.id)
        successor = next(b for b in runtime.store.list_bindings(session.id) if b.state == "active")
        assert current.model == "native-model-two" and successor.handoff.mode == "full"
        assert not runtime.store.active_run(session.id)
        assert sum(r.get("method") == "turn/start" for r in trace(root)) == 1
        (root / "resume-error.json").unlink()
        await runtime.submit(session.id, "request_new", "instant")
        await settle(runtime)
        current = runtime.store.get_session(session.id)
        await runtime.switch_executor(session.id, current.revision, ExecutorId.MONA, None)
        current = runtime.store.get_session(session.id)
        await runtime.switch_executor(session.id, current.revision, ExecutorId.CODEX, None)
        latest = next(b for b in runtime.store.list_bindings(session.id) if b.state == "active")
        assert latest.id == successor.id and latest.native_session_id == successor.native_session_id
        assert runtime.store.get_binding(previous.id).state == "stale"
        assert sum(r.get("method") == "thread/start" for r in trace(root)) == 2
    finally:
        await runtime.close()


def test_missing_classifier_is_exact_not_a_generic_rpc_error_classifier():
    error = {"code": -32600, "message": "no rollout found for thread id thread-A"}
    assert isinstance(_missing_resume(error, "thread-A"), MissingNativeSessionError)
    assert _missing_resume(error, "thread-B") is None
    assert _missing_resume({**error, "code": -32603}, "thread-A") is None
    assert _missing_resume({**error, "message": error["message"] + " trailing private data"}, "thread-A") is None


@pytest.mark.asyncio
async def test_idle_legacy_collaboration_policy_renews_once_without_replaying(tmp_path):
    runtime, root, host, session, previous = await completed(tmp_path)
    host._tool_handler = runtime.native_collaboration
    before = runtime.sessions.get_or_create(session.transcript_key).messages.copy()
    legacy = previous.model_copy(update={"context_fingerprint": previous.context_fingerprint.removesuffix(COLLABORATION_POLICY_TAG)})
    runtime.store.refresh_binding(legacy)
    try:
        renewed = await runtime.native.ensure(runtime.store.get_session(session.id))
        assert renewed.replacement_reason == "collaboration_updated"
        assert renewed.replaces_binding_id == previous.id
        assert renewed.context_fingerprint.endswith(COLLABORATION_POLICY_TAG)
        again = await runtime.native.ensure(runtime.store.get_session(session.id))
        assert again.id == renewed.id
        assert sum(call.get("method") == "thread/start" for call in trace(root)) == 2
        assert sum(call.get("method") == "turn/start" for call in trace(root)) == 1
        request = next(call for call in reversed(trace(root)) if call.get("method") == "thread/start")
        assert DELEGATION_INSTRUCTIONS in request["params"]["developerInstructions"]
        assert renewed.handoff.state == "pending"
        assert runtime.sessions.get_or_create(session.transcript_key).messages == before
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_legacy_policy_upgrade_does_not_replace_uncertain_native_work(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(session.id, "held_request", "hold")
        run = await wait_run(runtime, session.id, RunStatus.RUNNING)
        binding = runtime.store.get_binding(run.binding_id)
        runtime.store.refresh_binding(binding.model_copy(update={"context_fingerprint": binding.context_fingerprint.removesuffix(COLLABORATION_POLICY_TAG)}))
        await host._client.close()
        await wait_run(runtime, session.id, RunStatus.UNKNOWN)
        await runtime.native.ensure(runtime.store.get_session(session.id))
        assert len(runtime.store.list_bindings(session.id)) == 1
        assert sum(call.get("method") == "thread/start" for call in trace(root)) == 1
        assert sum(call.get("method") == "turn/start" for call in trace(root)) == 1
        assert runtime.store.get_run(run.id).status == RunStatus.UNKNOWN
    finally:
        await runtime.close()
