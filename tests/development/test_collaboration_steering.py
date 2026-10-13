"""Host corrections reuse the durable original-run input protocol across engines."""
from __future__ import annotations

import asyncio
import json

import pytest
from pydantic import ValidationError
from test_native_collaboration_flow import NATIVE, setup
from test_native_host_tools import enable_bridge
from test_native_workbench import wait_run
from test_workbench_runtime import Model, make_runtime, wait_done

from mona.development.collaboration import DevelopmentDelegate
from mona.development.continuation import CodingContinuation
from mona.development.contracts import ExecutorId, InputState, RunStatus
from mona.development.executors.host_tools import HostToolCall
from mona.development.store import ConflictError, DevelopmentError


def parent_run(runtime, parent):
    run, _ = runtime.store.create_run(parent.id, "parent_request", "parent_message")
    run = runtime.store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    return runtime.store.transition_run(run.id, run.revision, RunStatus.RUNNING)


@pytest.mark.asyncio
async def test_mona_tool_correction_is_bounded_owned_idempotent_and_consumed(tmp_path, monkeypatch):
    model = Model(gate=asyncio.Event())
    runtime, project, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    owner = parent_run(runtime, parent)
    tool = DevelopmentDelegate(runtime.collaboration, parent.id, owner.id)
    try:
        record = await runtime.collaboration.start(parent.id, "child_task", ExecutorId.MONA,
            "Inspect the parser", readonly=True, parent_run_id=owner.id)
        await asyncio.wait_for(model.entered.wait(), 5)
        arguments = {"task_id": record["id"], "request_id": "correction_once", "message": "Preserve parser signatures"}
        first = json.loads(await tool.execute("send_message", **arguments))
        repeated = json.loads(await tool.execute("send_message", **arguments))
        assert first["input"]["state"] == "pending" and not first["consumed"]
        assert not first["input"]["followUpAllowed"] and repeated["reused"]
        assert first["input"]["id"] == repeated["input"]["id"]
        with pytest.raises(ConflictError):
            await tool.execute("send_message", **{**arguments, "message": "Overwrite signatures"})
        with pytest.raises(ValidationError):
            await tool.execute("send_message", **{**arguments, "message": "x" * 8001})
        other = runtime.store.create_session(project.id)
        foreign = DevelopmentDelegate(runtime.collaboration, other.id, parent_run(runtime, other).id)
        with pytest.raises(ConflictError):
            await foreign.execute("send_message", **arguments)
        with pytest.raises(ConflictError):
            await DevelopmentDelegate(runtime.collaboration, parent.id, "run_stale").execute("send_message", **arguments)
        model.gate.set()
        await wait_done(runtime, record["childSessionId"])
        consumed = json.loads(await tool.execute("send_message", **arguments))
        assert consumed["reused"] and consumed["consumed"]
        assert consumed["input"]["state"] == "consumed"
        assert "Preserve parser signatures" in str(model.requests[-1]["messages"])
        assert len(runtime.store.list_runs(record["childSessionId"])) == 1
        assert runtime.store.get_session(record["childSessionId"]).readonly
        assert json.loads(await tool.execute("list"))[0]["steeringInputs"][0]["state"] == "consumed"
        with pytest.raises(ConflictError):
            await tool.execute("send_message", **{**arguments, "request_id": "ended_correction"})
        child_run = runtime.store.list_runs(record["childSessionId"])[0]
        assert len(runtime.store.list_inputs(child_run.id)) == 1
    finally:
        model.gate.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_parent_ending_while_child_input_lock_is_held_prevents_new_delivery(tmp_path, monkeypatch):
    model = Model(gate=asyncio.Event())
    runtime, _, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    owner = parent_run(runtime, parent)
    try:
        record = await runtime.collaboration.start(parent.id, "gated_child", ExecutorId.MONA, "Inspect parser", readonly=True)
        await asyncio.wait_for(model.entered.wait(), 5)
        async with runtime._lock(record["childSessionId"]):
            pending = asyncio.create_task(runtime.collaboration.send_message(parent.id, record["id"],
                "late_parent", "Keep parser", parent_run_id=owner.id))
            await asyncio.sleep(0)
            runtime.store.transition_run(owner.id, owner.revision, RunStatus.SUCCEEDED)
        with pytest.raises(ConflictError):
            await pending
        child = runtime.store.list_runs(record["childSessionId"])[0]
        assert not runtime.store.list_inputs(child.id)
    finally:
        model.gate.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_correction_queue_limit_is_checked_before_persisting_extra_message(tmp_path, monkeypatch):
    model = Model(gate=asyncio.Event())
    runtime, _, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    owner = parent_run(runtime, parent)
    try:
        record = await runtime.collaboration.start(parent.id, "bounded_child", ExecutorId.MONA, "Inspect parser", readonly=True)
        await asyncio.wait_for(model.entered.wait(), 5)
        for index in range(8):
            await runtime.collaboration.send_message(parent.id, record["id"], f"correction_{index}",
                "Keep parser", parent_run_id=owner.id)
        with pytest.raises(DevelopmentError) as error:
            await runtime.collaboration.send_message(parent.id, record["id"], "overflow_correction",
                "OVERFLOW_NOT_SAVED", parent_run_id=owner.id)
        assert error.value.code == "steering_queue_full"
        child = runtime.store.list_runs(record["childSessionId"])[0]
        assert len(runtime.store.list_inputs(child.id)) == 8
        transcript = runtime.sessions.get_or_create(runtime.store.get_session(child.session_id).transcript_key)
        assert "OVERFLOW_NOT_SAVED" not in str(transcript.messages)
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_correction_missing_final_boundary_never_starts_or_moves_to_another_turn(tmp_path, monkeypatch):
    model = Model(gate=asyncio.Event())
    runtime, _, parent, _ = make_runtime(tmp_path, monkeypatch, model)
    owner = parent_run(runtime, parent)
    original_drain = CodingContinuation.drain
    receipt = {}
    record = None

    async def race_final_boundary(continuation, *, limit, phase):
        drained = await original_drain(continuation, limit=limit, phase=phase)
        if phase == "after final response" and not drained and not receipt:
            receipt.update(await runtime.collaboration.send_message(parent.id, record["id"],
                "late_correction", "Keep the parser", parent_run_id=owner.id))
        return drained

    monkeypatch.setattr(CodingContinuation, "drain", race_final_boundary)
    try:
        record = await runtime.collaboration.start(parent.id, "boundary_child", ExecutorId.MONA, "Inspect parser", readonly=True)
        await asyncio.wait_for(model.entered.wait(), 5)
        model.gate.set()
        await wait_done(runtime, record["childSessionId"])
        item = runtime.store.get_input(receipt["input"]["id"])
        original_run = runtime.store.list_runs(record["childSessionId"])[0]
        assert original_run.status == RunStatus.SUCCEEDED and item.state == InputState.CANCELLED
        cancelled = [e for e in runtime.store.events_after(item.session_id, 0, 500) if e.type == "input.cancelled"]
        assert cancelled[-1].payload["reason"] == "turn_finished_before_steering"
        assert len(model.requests) == len(runtime.store.list_runs(record["childSessionId"])) == 1
        with pytest.raises(ConflictError):
            runtime.store.reserve_follow_up(item.id, item.revision)
        new_run, _ = runtime.store.create_run(item.session_id, "explicit_new_task", "new_task_message")
        runtime.store.move_pending_inputs(original_run.id, new_run.id)
        assert runtime.store.get_input(item.id).run_id == original_run.id
        assert not runtime.store.list_inputs(new_run.id)
    finally:
        model.gate.set()
        await runtime.close()


@pytest.mark.parametrize("leader", NATIVE)
@pytest.mark.asyncio
async def test_native_host_correction_targets_one_codex_turn_and_reports_consumption(tmp_path, monkeypatch, leader):
    runtime, project, root, client, _ = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    parent = runtime.store.create_session(project.id, leader)
    runtime.store.save_subagents(project.id, 0, [{"id": "worker", "name": "Worker", "instructions": "Inspect",
                                               "executor": "codex", "readonly": True}])
    try:
        await runtime.submit(parent.id, "parent_request", "hold")
        owner = await wait_run(runtime, parent.id, RunStatus.RUNNING)
        binding = runtime.store.get_binding(owner.binding_id)
        turn_id = owner.native_turn_id or "sdk:" + owner.request_id
        started = await runtime.native_collaboration(binding, turn_id, {"action": "start", "request_id": "child_task",
            "preset_id": "worker", "goal": "hold", "required": False})
        assert not started["isError"]
        record = json.loads(started["content"][0]["text"])
        child = await wait_run(runtime, record["childSessionId"], RunStatus.RUNNING)
        (root / "steering-behavior.json").write_text(json.dumps({"respond": True}), encoding="utf8")
        arguments = {"action": "send_message", "task_id": record["id"], "request_id": "steer_once", "message": "Keep parser"}
        result = await runtime.native_collaboration(binding, turn_id, arguments)
        assert not result["isError"]
        receipt = json.loads(result["content"][0]["text"])
        assert receipt["input"]["state"] == "accepted" and not receipt["consumed"]
        async with asyncio.timeout(5):
            while runtime.store.get_input(receipt["input"]["id"]).state != InputState.CONSUMED:
                await asyncio.sleep(0.01)
        again = await runtime.native_collaboration(binding, turn_id, arguments)
        assert not again["isError"] and json.loads(again["content"][0]["text"])["consumed"]
        calls = [json.loads(line) for line in (root / "peer-trace.jsonl").read_text(encoding="utf8").splitlines()]
        steering = [call for call in calls if call.get("method") == "turn/steer"]
        assert len(steering) == 1 and steering[0]["params"]["expectedTurnId"] == child.native_turn_id
        assert "Keep parser" in str(steering[0]["params"]["input"])
        assert len(runtime.store.list_runs(child.session_id)) == 1
        schema = HostToolCall.model_json_schema()
        assert "send_message" in schema["properties"]["action"]["enum"]
        assert schema["properties"]["message"]["anyOf"][0]["maxLength"] == 8000
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.parametrize("child_executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
@pytest.mark.asyncio
async def test_sdk_child_explicitly_rejects_correction_without_queuing_follow_up(tmp_path, monkeypatch, child_executor):
    runtime, project, _, client, _ = await setup(tmp_path, monkeypatch)
    parent = runtime.store.create_session(project.id)
    owner = parent_run(runtime, parent)
    try:
        record = await runtime.collaboration.start(parent.id, "sdk_child", child_executor, "hold", readonly=True)
        child = await wait_run(runtime, record["childSessionId"], RunStatus.RUNNING)
        with pytest.raises(DevelopmentError) as error:
            await runtime.collaboration.send_message(parent.id, record["id"], "unsupported_correction", "Keep parser",
                                                     parent_run_id=owner.id)
        assert error.value.code == "steering_unsupported"
        assert not runtime.store.list_inputs(child.id)
        assert len(runtime.store.list_runs(child.session_id)) == 1
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.asyncio
async def test_unknown_codex_correction_retry_observes_original_input_without_resend(tmp_path, monkeypatch):
    runtime, project, root, client, _ = await setup(tmp_path, monkeypatch)
    parent = runtime.store.create_session(project.id)
    owner = parent_run(runtime, parent)
    try:
        record = await runtime.collaboration.start(parent.id, "unknown_child", ExecutorId.CODEX, "hold", readonly=True)
        child = await wait_run(runtime, record["childSessionId"], RunStatus.RUNNING)
        host = runtime.native.hosts[(project.id, ExecutorId.CODEX)]
        host._client._timeout = 0.1
        (root / "steering-behavior.json").write_text(json.dumps({"loseReceipt": True}), encoding="utf8")
        arguments = {"parent_run_id": owner.id}
        with pytest.raises(DevelopmentError) as error:
            await runtime.collaboration.send_message(parent.id, record["id"], "unknown_once", "Keep parser", **arguments)
        assert error.value.code == "native_steering_unknown"
        repeated = await runtime.collaboration.send_message(parent.id, record["id"], "unknown_once", "Keep parser", **arguments)
        assert repeated["reused"] and repeated["input"]["state"] == "unknown" and not repeated["consumed"]
        assert runtime.store.get_run(child.id).status == RunStatus.UNKNOWN
        calls = [json.loads(line) for line in (root / "peer-trace.jsonl").read_text(encoding="utf8").splitlines()]
        assert len([call for call in calls if call.get("method") == "turn/steer"]) == 1
        assert len(runtime.store.list_runs(child.session_id)) == 1
    finally:
        await client.close()
        await runtime.close()
