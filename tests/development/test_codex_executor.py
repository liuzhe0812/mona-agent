import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

from mona.development.context import load_project_context
from mona.development.contracts import DevelopmentSession, ExecutorId, PermissionMode, Project
from mona.development.executors.base import NativeEvent, SessionStart
from mona.development.executors.codex import _CAPABILITIES, CodexExecutor, _thread_permissions
from mona.development.executors.codex_policy import CodexProfile
from mona.development.executors.rpc import RemoteRpcError, RpcError

PEER = Path(__file__).with_name("native_peer.py").resolve()


@pytest.mark.asyncio
async def test_queued_command_fragments_are_combined_without_crossing_boundaries(tmp_path):
    adapter, start = setup(tmp_path)
    binding = await adapter.create_session(start)
    runtime = adapter._threads[binding.native_session_id]
    try:
        fragments = ["行一\n", "second\n", "末尾\n"] * 1000
        for delta in fragments:
            runtime.publish(NativeEvent(native_turn_id="turn-output", type="command.output",
                payload={"itemId": "command-a", "delta": delta}))
        runtime.publish(NativeEvent(native_turn_id="turn-output", type="command.completed", payload={"id": "command-a"}))
        runtime.publish(NativeEvent(native_turn_id="turn-output", type="command.output", payload={"itemId": "command-b", "delta": "other"}))
        runtime.queue.put_nowait((None, 0))
        events = [event async for event in adapter.events(binding)]
        boundary = next(index for index, event in enumerate(events) if event.type == "command.completed")
        output = [event for event in events[:boundary] if event.type == "command.output"]
        assert "".join(event.payload["delta"] for event in output) == "".join(fragments)
        assert all(event.payload["itemId"] == "command-a" for event in output)
        assert events[boundary + 1].payload == {"itemId": "command-b", "delta": "other"}
        assert len(events) < 20 and runtime.queued_bytes == 0 and not runtime.desynchronized
    finally:
        await adapter.shutdown()


@pytest.mark.parametrize(("mode", "expected"), [
    (PermissionMode.ASK, ("on-request", "user", "workspace-write")),
    (PermissionMode.AUTO, ("on-request", "user", "workspace-write")),
    (PermissionMode.FULL_ACCESS, ("never", "user", "danger-full-access")),
])
def test_codex_permission_mode_maps_to_native_thread_policy(mode, expected):
    assert _thread_permissions(mode, readonly=False) == expected
    assert _thread_permissions(mode, readonly=True) == ("on-request", "user", "read-only")
    assert _CAPABILITIES.permission_modes == [PermissionMode.ASK, PermissionMode.AUTO, PermissionMode.FULL_ACCESS]


@pytest.mark.asyncio
async def test_full_access_thread_request_is_rejected_when_server_returns_weaker_policy(tmp_path):
    executor, start = setup(tmp_path, mode="weaker_policy")
    start.session.permission_mode = PermissionMode.FULL_ACCESS
    try:
        with pytest.raises(RpcError) as error:
            await executor.create_session(start)
        assert error.value.code == "project_policy_violation"
        request = next(row for row in trace(executor) if row.get("method") == "thread/start")
        assert request["params"]["approvalPolicy"] == "never"
        assert request["params"]["approvalsReviewer"] == "user"
        assert request["params"]["sandbox"] == "danger-full-access"
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_failed_approval_callback_declines_instead_of_wedging_session(tmp_path):
    async def approval(*_):
        raise RuntimeError("private diagnostic")

    executor, start = setup(tmp_path, approval=approval)
    try:
        binding = await executor.create_session(start)
        await executor.send(binding, "approval-fails", "approve")
        await collect_until(executor, binding, "run.completed")
        assert await executor.get_status(binding) == "idle"
        answer = next(r for r in trace(executor) if str(r.get("id", "")).startswith("approve-") and "result" in r)
        assert answer["result"]["decision"] == "decline"
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_explicit_reconnect_keeps_native_identity_without_replaying_task(tmp_path):
    executor, start = setup(tmp_path)
    try:
        binding = await executor.create_session(start)
        await executor.send(binding, "before", "instant")
        await collect_until(executor, binding, "run.completed")
        await executor._client.close()
        restored = await executor.resume_session(binding)
        assert restored.native_session_id == binding.native_session_id
        assert restored.session_id == binding.session_id
        assert len([r for r in trace(executor) if r.get("method") == "turn/start"]) == 1
        assert (await executor.send(restored, "after", "instant")).outcome == "accepted"
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_readonly_binding_cannot_be_upgraded_during_attach(tmp_path):
    executor, start = setup(tmp_path)
    try:
        binding = await executor.create_session(SessionStart(start.session, start.context, readonly=True))
        assert binding.readonly
        with pytest.raises(RpcError, match="不属于"):
            await executor.attach_session(start, binding)
    finally:
        await executor.shutdown()


def setup(tmp_path, *, mode="normal", approval=None, timeout=1):
    root = tmp_path / "项目"
    root.mkdir()
    (root / "AGENTS.md").write_text("Preserve manual edits.", encoding="utf-8")
    home = tmp_path / "home"
    home.mkdir()
    profile = CodexProfile((sys.executable, "-u", str(PEER), mode), home, root, dict(os.environ))
    executor = CodexExecutor(profile, approval_handler=approval, request_timeout=timeout)
    project = Project(root_path=str(root), display_name="项目")
    context = load_project_context(project)
    session = DevelopmentSession(project_id=project.id, executor=ExecutorId.CODEX)
    return executor, SessionStart(session, context)


def trace(executor):
    return [json.loads(s) for s in (executor.profile.project_root / "peer-trace.jsonl").read_text(encoding="utf-8").splitlines()]


async def collect_until(executor, binding, kind):
    events = []
    stream = executor.events(binding)
    try:
        async with asyncio.timeout(3):
            async for event in stream:
                events.append(event)
                if event.type == kind:
                    return events
    finally:
        await stream.aclose()
    raise AssertionError(f"Missing event {kind}")


@pytest.mark.asyncio
async def test_modern_codex_status_and_send_do_not_depend_on_turn_history(tmp_path):
    executor, start = setup(tmp_path, mode="codex_modern")
    try:
        binding = await executor.create_session(start)
        assert await executor.get_status(binding) == "idle"

        receipt = await executor.send(binding, "safe-pipe-input", "instant")
        assert receipt.outcome == "accepted"
        assert receipt.native_turn_id
        events = await collect_until(executor, binding, "run.completed")
        assert any(event.type == "agent.message.completed" for event in events)

        with pytest.raises(RpcError) as error:
            await executor.inspect_turn(binding, receipt.native_turn_id)
        assert error.value.code == "native_history_unavailable_idle"
        assert await executor.get_status(binding) == "idle"

        requests = trace(executor)
        initialize = next(request for request in requests if request.get("method") == "initialize")
        assert initialize["params"]["capabilities"]["experimentalApi"] is True
        reads = [request for request in requests if request.get("method") == "thread/read"]
        assert any(request["params"].get("includeTurns") is False for request in reads)
        assert any(request["params"].get("includeTurns") is True for request in reads)
        assert len([request for request in requests if request.get("method") == "turn/start"]) == 1
        executor._runtime(binding).fault("native_result_unconfirmed")
        assert await executor.get_status(binding) == "unknown"
        assert (await executor.send(binding, "do-not-replay", "instant")).outcome == "unknown"
        assert len([request for request in trace(executor) if request.get("method") == "turn/start"]) == 1
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_metadata_only_resume_preserves_unobserved_native_activity(tmp_path):
    executor, start = setup(tmp_path, mode="codex_modern")
    try:
        binding = await executor.create_session(start)
        assert (await executor.send(binding, "persisted-input", "instant")).outcome == "accepted"
        await collect_until(executor, binding, "run.completed")
        await executor._client.close()
        state_path = executor.profile.project_root / "peer-state.json"
        state = json.loads(state_path.read_text(encoding="utf8"))
        state["threads"][binding.native_session_id]["status"] = {"type": "active"}
        state_path.write_text(json.dumps(state), encoding="utf8")

        restored = await executor.resume_session(binding)
        assert await executor.get_status(restored) == "unknown"
        assert (await executor.send(restored, "blocked-input", "instant")).outcome == "unknown"
        assert len([request for request in trace(executor) if request.get("method") == "turn/start"]) == 1
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_modern_codex_resume_avoids_loading_turn_history(tmp_path):
    executor, start = setup(tmp_path, mode="codex_modern")
    try:
        binding = await executor.create_session(start)
        receipt = await executor.send(binding, "before-restart", "instant")
        assert receipt.outcome == "accepted"
        await collect_until(executor, binding, "run.completed")
        persisted_thread = json.loads((executor.profile.project_root / "peer-state.json").read_text(encoding="utf8"))["threads"][binding.native_session_id]
        assert any(turn.get("id") == receipt.native_turn_id and turn.get("status") == "completed"
                   for turn in persisted_thread["turns"])

        await executor._client.close()
        client = await executor._ensure_started()
        with pytest.raises(RemoteRpcError) as unsupported_resume:
            await client.request("thread/resume", {"threadId": binding.native_session_id})
        assert unsupported_resume.value.rpc_code == -32601

        restored = await executor.resume_session(binding)
        assert restored.id == binding.id
        assert restored.native_session_id == binding.native_session_id
        assert await executor.get_status(restored) == "idle"

        requests = trace(executor)
        resume = next(request for request in reversed(requests) if request.get("method") == "thread/resume")
        assert resume["params"]["excludeTurns"] is True
        assert not any(request.get("method") == "thread/read" and request.get("params", {}).get("includeTurns") is True
                       for request in requests)
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize(("mode", "user_agent"), [
    ("codex_old", "codex_cli_rs/0.124.0"),
    ("codex_unknown", None),
])
async def test_resume_omits_exclude_turns_for_old_or_unknown_cli_version(tmp_path, mode, user_agent):
    executor, start = setup(tmp_path, mode=mode)
    try:
        binding = await executor.create_session(start)
        assert executor._version == user_agent
        receipt = await executor.send(binding, "before-restart", "instant")
        assert receipt.outcome == "accepted"
        await collect_until(executor, binding, "run.completed")
        persisted_thread = json.loads((executor.profile.project_root / "peer-state.json").read_text(encoding="utf8"))["threads"][binding.native_session_id]
        assert any(turn.get("id") == receipt.native_turn_id and turn.get("status") == "completed"
                   for turn in persisted_thread["turns"])

        await executor._client.close()
        restored = await executor.resume_session(binding)
        assert restored.native_session_id == binding.native_session_id

        requests = trace(executor)
        resume = next(request for request in reversed(requests) if request.get("method") == "thread/resume")
        assert "excludeTurns" not in resume["params"]
        assert resume["params"]["threadId"] == binding.native_session_id
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_native_threads_share_host_but_not_input_or_events(tmp_path):
    executor, start = setup(tmp_path)
    try:
        first = await executor.create_session(start)
        second_start = SessionStart(DevelopmentSession(project_id=start.session.project_id, executor=ExecutorId.CODEX), start.context)
        second = await executor.create_session(second_start)
        assert first.native_session_id != second.native_session_id
        receipts = await asyncio.gather(executor.send(first, "one", "instant"), executor.send(second, "two", "instant"))
        assert all(r.outcome == "accepted" for r in receipts)
        first_events = await collect_until(executor, first, "run.completed")
        second_events = await collect_until(executor, second, "run.completed")
        assert first_events[0].type == "session.started"  # before thread/start response
        assert second_events[0].type == "session.started"
        assert next(e for e in first_events if e.type == "agent.message.delta").payload["delta"].endswith(first.native_session_id)
        assert next(e for e in second_events if e.type == "agent.message.delta").payload["delta"].endswith(second.native_session_id)
        assert await executor.get_status(first) == "idle"  # completion preceded dispatch ack
        assert len([r for r in trace(executor) if r.get("method") == "initialize"]) == 1
        await executor.close_runtime(first)
        assert executor._client.process.returncode is None
        assert (await executor.send(second, "three", "instant")).outcome == "accepted"
        await collect_until(executor, second, "run.completed")
        restored = await executor.resume_session(first)
        assert restored.id == first.id and restored.native_session_id == first.native_session_id
        assert not any(r.get("method") == "thread/archive" for r in trace(executor))
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_same_input_id_deduplicates_and_different_payload_rejected(tmp_path):
    executor, start = setup(tmp_path)
    try:
        binding = await executor.create_session(start)
        first, second = await asyncio.gather(executor.send(binding, "idempotent", "instant"), executor.send(binding, "idempotent", "instant"))
        assert first == second
        assert len([r for r in trace(executor) if r.get("method") == "turn/start"]) == 1
        with pytest.raises(RpcError, match="不同内容"):
            await executor.send(binding, "idempotent", "other")
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_steer_and_interrupt_ack_is_not_termination(tmp_path):
    executor, start = setup(tmp_path)
    try:
        binding = await executor.create_session(start)
        receipt = await executor.send(binding, "initial", "hold")
        await collect_until(executor, binding, "run.started")
        steer = await executor.steer(binding, "add", "keep my code")
        assert steer.native_turn_id == receipt.native_turn_id
        interrupted = await executor.interrupt(binding)
        assert interrupted.outcome == "requested"
        assert not interrupted.child_processes_stopped
        await collect_until(executor, binding, "run.interrupted")
        assert await executor.get_status(binding) == "idle"
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_timeout_keeps_same_request_unknown_without_replay(tmp_path):
    executor, start = setup(tmp_path, mode="codex_modern", timeout=1)
    try:
        binding = await executor.create_session(start)
        normal_timeout = executor._client._timeout
        executor._client._timeout = 0.03
        try:
            receipt = await executor.send(binding, "uncertain", "lost_ack")
        finally:
            # Inject a timeout only into dispatch, not the later real status read.
            executor._client._timeout = normal_timeout
        assert receipt.outcome == "unknown"
        assert await executor.get_status(binding) == "unknown"
        assert (await executor.send(binding, "uncertain", "lost_ack")).outcome == "unknown"
        await collect_until(executor, binding, "run.completed")
        assert await executor.get_status(binding) == "idle"
        assert len([r for r in trace(executor) if r.get("method") == "turn/start"]) == 1
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_waiting_approval_does_not_stop_another_session_and_stale_answer_denied(tmp_path):
    started, release = asyncio.Event(), asyncio.Event()

    async def approval(binding, method, params):
        started.set()
        await release.wait()
        return "accept"

    executor, start = setup(tmp_path, approval=approval)
    try:
        first = await executor.create_session(start)
        other = await executor.create_session(SessionStart(DevelopmentSession(project_id=start.context.project_id, executor=ExecutorId.CODEX), start.context))
        await executor.send(first, "approve", "approve")
        await asyncio.wait_for(started.wait(), 1)
        assert (await executor.send(other, "other", "instant")).outcome == "accepted"
        await executor.interrupt(first)
        await collect_until(executor, first, "run.interrupted")
        release.set()
        await asyncio.sleep(0.05)
        answers = [r for r in trace(executor) if str(r.get("id", "")).startswith("approve-") and "result" in r]
        assert answers and answers[-1]["result"]["decision"] == "cancel"
    finally:
        release.set()
        await executor.shutdown()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,code", [("unsafe_config", "project_policy_violation"), ("no_auth", "authentication_required")])
async def test_unverified_configuration_or_auth_never_starts_thread(tmp_path, mode, code):
    executor, start = setup(tmp_path, mode=mode)
    try:
        with pytest.raises(RpcError) as error:
            await executor.create_session(start)
        assert error.value.code == code
        assert not any(r.get("method") == "thread/start" for r in trace(executor))
    finally:
        await executor.shutdown()


@pytest.mark.asyncio
async def test_readonly_approval_denied_and_binding_not_forgeable(tmp_path):
    async def approve(*_):
        raise AssertionError("Readonly must never request write approval")

    executor, start = setup(tmp_path, approval=approve)
    try:
        binding = await executor.create_session(SessionStart(start.session, start.context, readonly=True))
        with pytest.raises(RpcError):
            await executor.send(binding.model_copy(update={"session_id": "dev_other"}), "bad", "instant")
        await executor.send(binding, "readonly", "approve")
        await collect_until(executor, binding, "run.completed")
        answer = next(r for r in trace(executor) if str(r.get("id", "")).startswith("approve-") and "result" in r)
        assert answer["result"]["decision"] == "decline"
        request = next(r for r in trace(executor) if r.get("method") == "thread/start")
        assert request["params"]["sandbox"] == "read-only"
        assert request["params"]["approvalPolicy"] == "on-request"
        assert "Preserve manual edits" in request["params"]["developerInstructions"]
    finally:
        await executor.shutdown()
