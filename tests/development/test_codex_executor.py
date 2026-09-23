import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

from mona.development.context import load_project_context
from mona.development.contracts import DevelopmentSession, ExecutorId, Project
from mona.development.executors.base import SessionStart
from mona.development.executors.codex import CodexExecutor
from mona.development.executors.codex_policy import CodexProfile
from mona.development.executors.rpc import RpcError

PEER = Path(__file__).with_name("native_peer.py").resolve()


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
    executor, start = setup(tmp_path, timeout=1)
    try:
        binding = await executor.create_session(start)
        executor._client._timeout = 0.03
        receipt = await executor.send(binding, "uncertain", "lost_ack")
        assert receipt.outcome == "unknown"
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
