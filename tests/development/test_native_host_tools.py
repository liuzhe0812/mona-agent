"""Native-initiated delegation through production adapters, worker and durable store.

Vendor responses are explicit protocol/SDK peers, not live account/model acceptance.
"""
from __future__ import annotations

import asyncio
import hashlib
import itertools
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from test_native_collaboration_flow import NATIVE, setup, wire_inputs
from test_native_workbench import settle, wait_run

from mona.development.context import ProjectContext
from mona.development.contracts import DevelopmentSession, ExecutorId, ReviewSource, RunStatus
from mona.development.executors.base import SessionStart
from mona.development.executors.codex_events import normalize_codex_event
from mona.development.executors.host_tools import (
    HOST_SERVER,
    HOST_TOOL,
    SDK_HOST_TOOL,
    SDK_WORK_TOOL,
    SUBAGENT_INSTRUCTIONS,
    WORK_DESCRIPTION,
    WORK_SERVER,
    WORK_TOOL,
    HostToolCall,
    WorkToolCall,
    call_in_turn,
    host_servers_valid,
)
from mona.development.executors.rpc import RpcError
from mona.development.executors.sdk import SDKExecutor
from mona.development.executors.sdk_events import SDKEventProjector
from mona.development.executors.sdk_policy import prepare_sdk_profile


def enable_bridge(runtime):
    for host in runtime.native.hosts.values():
        if host.id == ExecutorId.CODEX:
            host._tool_handler = runtime.native_collaboration
        else:
            host.tool_handler = runtime.native_collaboration


@pytest.mark.asyncio
async def test_wait_validation_error_and_wait_timeout_do_not_fail_the_running_child(tmp_path, monkeypatch):
    from test_native_workbench import setup as native_setup
    from test_workbench_runtime import Model

    runtime, project, _, _ = await native_setup(tmp_path)
    model = Model(gate=asyncio.Event())
    monkeypatch.setattr("mona.webui.settings_api._managed_model_catalog", lambda: {"available": False, "models": []})
    monkeypatch.setattr("mona.development.runtime.build_provider_snapshot", lambda *args, **kwargs:
        SimpleNamespace(provider=model, model="test-coding", context_window_tokens=65536))
    runtime.config_loader().development.enabled_engines.append("mona")
    enable_bridge(runtime)
    runtime.store.save_subagents(project.id, 0, [{"id": "reviewer", "name": "Reviewer", "instructions": "Read only",
        "executor": "mona", "readonly": True}])
    parent = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(parent.id, "waiting_parent", "hold")
        owner = await wait_run(runtime, parent.id, RunStatus.RUNNING)
        binding = runtime.store.get_binding(owner.binding_id)
        started = await runtime.native_collaboration(binding, owner.native_turn_id, {
            "action": "start", "request_id": "child_once", "preset_id": "reviewer", "goal": "Inspect source"})
        assert not started["isError"]
        record = json.loads(started["content"][0]["text"])
        async with asyncio.timeout(3):
            await model.entered.wait()
        rejected = await runtime.native_collaboration(binding, owner.native_turn_id, {
            "action": "wait", "task_id": record["id"], "seconds": 50})
        assert rejected["isError"] and "invalid_host_tool_arguments" in rejected["content"][0]["text"]
        timed = await runtime.native_collaboration(binding, owner.native_turn_id, {
            "action": "wait", "task_id": record["id"], "seconds": 1})
        assert not timed["isError"] and json.loads(timed["content"][0]["text"])["status"] == "still_running"
        child = runtime.store.find_run_request(record["childSessionId"], record["requestId"])
        assert child.status == RunStatus.RUNNING
        assert runtime.store.get_run(owner.id).status == RunStatus.RUNNING
        assert runtime.store.get_collaboration(record["id"]).return_message_id is None
        model.gate.set()
        await wait_run(runtime, record["childSessionId"])
        observed = (await runtime.collaboration.observe(parent.id))[0]
        assert observed["latestRun"]["status"] == "succeeded" and observed["returnMessageId"]
        assert len(runtime.store.list_runs(record["childSessionId"])) == 1
    finally:
        model.gate.set()
        await runtime.close()


@pytest.mark.parametrize("lead,child", tuple(itertools.product(NATIVE, repeat=2)))
@pytest.mark.asyncio
async def test_native_leader_delegates_and_consumes_result_in_original_turn(tmp_path, monkeypatch, lead, child):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    runtime.store.save_subagents(project.id, 0, [{"id": "reviewer", "name": "Reviewer", "description": "ROUTING_DESCRIPTION", "instructions": "CHILD_PRIVATE_INSTRUCTIONS: Read only",
        "executor": child.value, "readonly": True}])
    parent = runtime.store.create_session(project.id, lead)
    try:
        sent = await runtime.submit(parent.id, "root_request", "delegate_host")
        await wait_run(runtime, parent.id)
        await settle(runtime)
        records = await runtime.collaboration.observe(parent.id)
        assert len(records) == 1 and records[0]["executor"] == child.value
        assert records[0]["returnMessageId"] and records[0]["latestRun"]["status"] == "succeeded"
        assert len(runtime.store.list_runs(parent.id)) == 1
        assert len(runtime.store.list_runs(records[0]["childSessionId"])) == 1
        assert runtime.store.get_run(sent["run"]["id"]).status == RunStatus.SUCCEEDED
        messages = runtime.snapshot(parent.id)["messages"]
        assert any("HOST_RESULT_CONSUMED:" in m["content"] for m in messages if m["role"] == "assistant")
        parent_binding = runtime.store.list_bindings(parent.id)[0]
        child_binding = runtime.store.list_bindings(records[0]["childSessionId"])[0]
        assert parent_binding.capabilities.host_subagents and not child_binding.capabilities.host_subagents
        assert "ROUTING_DESCRIPTION" in wire_inputs(root, parent_binding)[0]
        assert "CHILD_PRIVATE_INSTRUCTIONS" not in wire_inputs(root, parent_binding)[0]
        assert "CHILD_PRIVATE_INSTRUCTIONS" in wire_inputs(root, child_binding)[0]
        assert "developmentSubagents" not in wire_inputs(root, child_binding)[0]
        assert not model_calls and (root / "manual.txt").read_text() == "MANUAL_CONTENT"
        assert records[0]["followUp"] is None  # Result consumed in the original turn, no automatic new run.
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.asyncio
async def test_codex_leader_routes_builtins_to_configured_engine_and_model(tmp_path, monkeypatch):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    async def unexpected_diff_scan(*args):
        raise AssertionError("Plain exploration must not prepare a repository diff")
    monkeypatch.setattr("mona.development.collaboration.read_review_diff", unexpected_diff_scan)
    routes = {"builtin_explorer": (ExecutorId.CLAUDE, "exploration-model"),
              "builtin_worker": (ExecutorId.CODEBUDDY, "implementation-model")}
    configured = runtime.store.save_subagents(project.id, 0, [
        preset.model_copy(update={"inherit_model": False, "executor": routes[preset.id][0].value,
                                  "model": routes[preset.id][1]}) for preset in project.subagents])
    parent = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(parent.id, "configured_parent", "hold")
        run = await wait_run(runtime, parent.id, RunStatus.RUNNING)
        binding = runtime.store.get_binding(run.binding_id)
        for preset in configured.subagents:
            result = await runtime.native_collaboration(binding, run.native_turn_id, {
                "action": "start", "request_id": preset.id, "preset_id": preset.id, "goal": "Inspect this task"})
            assert not result["isError"], result
            record = json.loads(result["content"][0]["text"])
            assert record["sourceDiffSha"] is None and record["reviewSource"] is None
            observed = await runtime.native_collaboration(binding, run.native_turn_id, {
                "action": "wait", "task_id": record["id"], "seconds": 5})
            assert not observed["isError"]
            child = runtime.store.get_session(record["childSessionId"])
            assert (child.executor, child.model) == routes[preset.id]
            assert child.readonly == (preset.id == "builtin_explorer")
            assert child.permission_mode == parent.permission_mode
            child_binding = runtime.store.list_bindings(child.id)[0]
            assert not child_binding.capabilities.host_subagents
            assert all(preset.instructions not in content for content in wire_inputs(root, child_binding))
            trace = [json.loads(line) for line in (root / "sdk-peer-trace.jsonl").read_text(encoding="utf8").splitlines()]
            connected = next(row for row in trace if row.get("method") == "connect" and row["nativeId"] == child_binding.native_session_id)
            assert connected["model"] == routes[preset.id][1]
            system = connected["system"]
            assert SUBAGENT_INSTRUCTIONS in (system.get("append", "") if isinstance(system, dict) else system)
        runtime.store.save_subagents(project.id, configured.subagents_revision, [
            preset.model_copy(update={"enabled": False}) for preset in configured.subagents])
        disabled = await runtime.native_collaboration(binding, run.native_turn_id, {
            "action": "start", "request_id": "disabled_worker", "preset_id": "builtin_worker", "goal": "Inspect this task"})
        assert disabled["isError"] and len(runtime.store.list_collaborations(parent.id)) == 2
        assert len(runtime.store.list_runs(parent.id)) == 1 and not model_calls
    finally:
        active = runtime.store.active_run(parent.id)
        if active:
            await runtime.interrupt(parent.id, active.id)
        await client.close()
        await runtime.close()


@pytest.mark.asyncio
async def test_codebuddy_split_result_is_consumed_by_codex_parent_before_completion(tmp_path, monkeypatch):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    runtime.store.save_subagents(project.id, 0, [{"id": "reviewer", "name": "Reviewer",
        "instructions": "SPLIT_ENVELOPE_PROTOCOL_FIXTURE", "executor": "codebuddy", "readonly": True}])
    parent = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        sent = await runtime.submit(parent.id, "split_parent", "delegate_host")
        await wait_run(runtime, parent.id)
        await settle(runtime)
        records = await runtime.collaboration.observe(parent.id)
        assert len(records) == 1
        record = records[0]
        assert record["latestRun"]["status"] == "succeeded"
        assert record["returnMessageId"] and record["resultReceivedByRunId"] == sent["run"]["id"]
        assert runtime.store.get_run(sent["run"]["id"]).status == RunStatus.SUCCEEDED
        messages = runtime.snapshot(record["childSessionId"])["messages"]
        assert [message["content"] for message in messages if message["role"] == "assistant"] == [
            "Inspecting source.", "SPLIT_RESULT_VERIFIED"]
        assert any("HOST_RESULT_CONSUMED:SPLIT_RESULT_VERIFIED" in message["content"]
                   for message in runtime.snapshot(parent.id)["messages"] if message["role"] == "assistant")
        assert len(runtime.store.list_runs(parent.id)) == 1 and len(runtime.store.list_runs(record["childSessionId"])) == 1
        assert not model_calls and (root / "manual.txt").read_text(encoding="utf8") == "MANUAL_CONTENT"
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.parametrize("child", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
@pytest.mark.asyncio
async def test_readonly_sdk_child_continues_after_tool_denial_and_returns_result_to_original_parent(tmp_path, monkeypatch, child):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    runtime.store.save_subagents(project.id, 0, [{"id": "reviewer", "name": "Reviewer",
        "instructions": "READONLY_NATIVE_TOOLS_FIXTURE", "executor": child.value, "readonly": True}])
    parent = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        sent = await runtime.submit(parent.id, "readonly_parent", "delegate_host")
        await wait_run(runtime, parent.id)
        await settle(runtime)
        record, = await runtime.collaboration.observe(parent.id)
        assert record["latestRun"]["status"] == "succeeded"
        assert record["returnMessageId"] and record["resultReceivedByRunId"] == sent["run"]["id"]
        assert runtime.store.get_run(sent["run"]["id"]).status == RunStatus.SUCCEEDED
        assert any("HOST_RESULT_CONSUMED:PROJECT_RULE: keep user edits" in message["content"]
                   for message in runtime.snapshot(parent.id)["messages"] if message["role"] == "assistant")
        assert len(runtime.store.list_runs(record["childSessionId"])) == 1
        assert not model_calls and (root / "manual.txt").read_text(encoding="utf8") == "MANUAL_CONTENT"
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.parametrize("lead", NATIVE)
@pytest.mark.asyncio
async def test_bound_bridge_idempotence_and_stale_or_foreign_access(tmp_path, monkeypatch, lead):
    runtime, project, root, client, _ = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    runtime.store.save_subagents(project.id, 0, [{"id": "reviewer", "name": "Reviewer", "instructions": "Read only",
        "executor": "claude", "readonly": True}])
    parent = runtime.store.create_session(project.id, lead)
    try:
        await runtime.submit(parent.id, "root_request", "hold")
        run = await wait_run(runtime, parent.id, RunStatus.RUNNING)
        binding = runtime.store.get_binding(run.binding_id)
        args = {"action": "start", "request_id": "same_request", "preset_id": "reviewer", "goal": "Read only"}
        a, b = await asyncio.gather(*(runtime.native_collaboration(binding, run.native_turn_id, args) for _ in range(2)))
        assert not a["isError"] and not b["isError"]
        record = json.loads(a["content"][0]["text"])
        assert record["id"] == json.loads(b["content"][0]["text"])["id"]
        assert len(runtime.store.list_collaborations(parent.id)) == 1
        mismatch = await runtime.native_collaboration(binding, run.native_turn_id, {**args, "goal": "different"})
        assert mismatch["isError"]
        stale = await runtime.native_collaboration(binding, "old_turn", {"action": "presets"})
        assert stale["isError"]
        foreign = runtime.store.create_session(project.id, lead)
        await runtime.submit(foreign.id, "foreign_request", "hold")
        other = await wait_run(runtime, foreign.id, RunStatus.RUNNING)
        denied = await runtime.native_collaboration(runtime.store.get_binding(other.binding_id), other.native_turn_id,
            {"action": "wait", "task_id": record["id"], "seconds": 1})
        assert denied["isError"] and record["goal"] not in denied["content"][0]["text"]
        await runtime.interrupt(parent.id, run.id)
        await wait_run(runtime, parent.id, RunStatus.INTERRUPTED)
        assert (await runtime.native_collaboration(binding, run.native_turn_id, args))["isError"]
        await runtime.interrupt(foreign.id, other.id)
        await settle(runtime)
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.asyncio
async def test_native_start_short_title_preserves_goal_and_is_stable_on_retry(tmp_path, monkeypatch):
    runtime, project, _, client, _ = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    runtime.store.save_subagents(project.id, 0, [{"id": "worker", "name": "Worker",
        "instructions": "Follow the delegated task", "executor": "claude", "readonly": False}])
    parent = runtime.store.create_session(project.id, ExecutorId.CODEX)
    goal = "请你检查 MCP 工具路由、参数传递和结果回传；完整目标需要保留。"
    title = "检查 MCP 工具路由"
    try:
        await runtime.submit(parent.id, "title_parent_request", "hold")
        run = await wait_run(runtime, parent.id, RunStatus.RUNNING)
        binding = runtime.store.get_binding(run.binding_id)
        arguments = {"action": "start", "request_id": "title_retry", "preset_id": "worker",
            "title": title, "goal": goal, "required": False}

        first_result = await runtime.native_collaboration(binding, run.native_turn_id, arguments)
        assert not first_result["isError"]
        first = json.loads(first_result["content"][0]["text"])
        child = runtime.store.get_session(first["childSessionId"])
        record = runtime.store.get_collaboration(first["id"])
        transcript = runtime.sessions.get_or_create(child.transcript_key)
        assert first["title"] == child.title == title
        assert first["goal"] == record.goal == goal
        assert any(goal in message.get("content", "") for message in transcript.messages)

        repeated_result = await runtime.native_collaboration(binding, run.native_turn_id,
            {**arguments, "title": "另一个标题"})
        assert not repeated_result["isError"]
        repeated = json.loads(repeated_result["content"][0]["text"])
        assert repeated["id"] == first["id"]
        assert repeated["childSessionId"] == first["childSessionId"]
        assert repeated["title"] == title
        assert len(runtime.store.list_runs(child.id)) == 1
    finally:
        active = runtime.store.active_run(parent.id)
        if active:
            await runtime.interrupt(parent.id, active.id)
            await wait_run(runtime, parent.id, RunStatus.INTERRUPTED)
        await client.close()
        await runtime.close()


@pytest.mark.parametrize("lead,mode", tuple(itertools.product(NATIVE, ("readonly", "child"))))
@pytest.mark.asyncio
async def test_restricted_sessions_never_receive_or_use_host_delegation(tmp_path, monkeypatch, lead, mode):
    runtime, project, _, client, _ = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    parent = runtime.store.create_session(project.id, lead)
    restricted = runtime.store.create_session(project.id, lead, readonly=mode == "readonly",
        parent_session_id=parent.id if mode == "child" else None)
    try:
        await runtime.submit(restricted.id, "restricted_request", "hold")
        run = await wait_run(runtime, restricted.id, RunStatus.RUNNING)
        binding = runtime.store.get_binding(run.binding_id)
        assert not binding.capabilities.host_subagents
        assert (await runtime.native_collaboration(binding, run.native_turn_id, {"action": "presets"}))["isError"]
        assert not runtime.store.list_collaborations(restricted.id)
        await runtime.interrupt(restricted.id, run.id)
        await settle(runtime)
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.asyncio
async def test_leader_ending_during_source_read_does_not_create_a_child(tmp_path, monkeypatch):
    from mona.development.store import DevelopmentError
    runtime, project, _, client, _ = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    runtime.store.save_subagents(project.id, 0, [{"id": "reviewer", "name": "Reviewer", "instructions": "Read only", "executor": "claude"}])
    parent = runtime.store.create_session(project.id, ExecutorId.CLAUDE)
    try:
        await runtime.submit(parent.id, "root_request", "hold")
        run = await wait_run(runtime, parent.id, RunStatus.RUNNING)
        binding = runtime.store.get_binding(run.binding_id)
        source = ReviewSource(path="source.py", version="a" * 64)
        async def ended_while_reading(*args):
            latest = runtime.store.get_run(run.id)
            runtime.store.transition_run(run.id, latest.revision, RunStatus.SUCCEEDED)
            return {"source": source.model_dump(mode="json"), "sha256": "b" * 64, "diff": "+answer = 2\n"}
        monkeypatch.setattr("mona.development.collaboration.read_review_diff", ended_while_reading)
        with pytest.raises(DevelopmentError) as error:
            await runtime.collaboration.start_preset(parent.id, "only_once", "reviewer", "Review",
                review_source=source, parent_run_id=run.id, required=True,
                authorize=lambda: runtime.native_collaboration._owner(binding, run.native_turn_id))
        assert error.value.code == "host_tool_unavailable" and not runtime.store.list_collaborations(parent.id)
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.parametrize("args", [
    {"action": "start", "executor": "mona", "goal": "x"},
    {"action": "presets", "session_id": "dev_foreign"},
    {"action": "start", "request_id": "ok", "preset_id": "test", "goal": " "},
    {"action": "wait", "task_id": "valid_id", "seconds": True},
    {"action": "wait", "task_id": "valid_id", "seconds": 1000},
])
def test_native_schema_rejects_unscoped_or_malformed_actions(args):
    with pytest.raises(ValidationError):
        HostToolCall.model_validate(args)


def test_exact_host_allowlist_never_enables_ambient_mcp():
    assert host_servers_valid([{ "name": HOST_SERVER }], True)
    assert not host_servers_valid([{ "name": HOST_SERVER }], False)
    assert not host_servers_valid([{ "name": HOST_SERVER }, {"name": "foreign"}], True)
    projector = SDKEventProjector("native", host_collaboration=True)
    projector.begin("turn")
    event = {"type": "assistant", "content": [{"type": "tool_use", "id": "c1", "name": SDK_HOST_TOOL, "input": {"action": "list"}}]}
    assert projector.consume(event)[0].type == "tool.started"
    event["content"][0]["name"] = SDK_HOST_TOOL + "_forged"
    with pytest.raises(RpcError):
        projector.consume(event)
    params = {"turnId": "turn", "item": {"type": "dynamicToolCall", "id": "call", "tool": HOST_TOOL, "contentItems": None}}
    assert normalize_codex_event("item/started", params).type == "policy.violation"
    assert normalize_codex_event("item/started", params, host_tools=True).type == "tool.started"
    params["item"]["namespace"] = "foreign"
    assert normalize_codex_event("item/started", params, host_tools=True).type == "policy.violation"


@pytest.mark.asyncio
async def test_turn_change_cancels_only_pending_observation():
    from mona.development.contracts import Binding
    current = True
    entered, cancelled = asyncio.Event(), asyncio.Event()
    async def handler(*args):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()
    binding = Binding(session_id="parent_id", executor=ExecutorId.CODEX, native_session_id="native", working_directory=".")
    task = asyncio.create_task(call_in_turn(handler, binding, "turn", {}, lambda: current))
    await entered.wait()
    current = False
    value = await asyncio.wait_for(task, 1)
    assert value["isError"] and cancelled.is_set()


@pytest.mark.parametrize("executor", ["claude", "codebuddy"])
@pytest.mark.asyncio
async def test_missing_sdk_host_api_is_reported_before_client_creation(tmp_path, monkeypatch, executor):
    import io
    from types import SimpleNamespace

    from sdk_peer import Options

    from mona.development.executors import sdk_worker
    from mona.development.executors.diagnostics import failed_probe
    worker = sdk_worker.Worker()
    worker.output = io.StringIO()
    sdk = SimpleNamespace(ClaudeAgentOptions=Options, CodeBuddyAgentOptions=Options,
                          AppendSystemPrompt=lambda **kwargs: kwargs)
    original_import = sdk_worker.importlib.import_module
    monkeypatch.setattr(sdk_worker, "sdk_version", lambda _: "test-peer")
    monkeypatch.setattr(sdk_worker.importlib, "import_module", lambda name, *args:
                        sdk if name in {"claude_agent_sdk", "codebuddy_agent_sdk"} else original_import(name, *args))
    await worker.request({"id": "initialize", "method": "initialize", "params": {
        "executor": executor, "cwd": str(tmp_path), "executable": "test-only",
        "nativeSessionId": "test-session", "readonly": False, "context": "", "model": None,
        "resume": False, "hostCollaboration": True, "permissionMode": "ask"}})
    reply = json.loads(worker.output.getvalue())
    assert reply["error"]["data"]["monaCode"] == "sdk_host_tools_unsupported"
    assert worker.client is None and worker.owner.done()
    probe = failed_probe(ExecutorId(executor), RpcError("sdk_host_tools_unsupported", "private SDK detail"))
    assert probe.stage == "dependency" and "宿主协作" in probe.reason
    assert "private" not in probe.model_dump_json()


@pytest.mark.asyncio
async def test_existing_codex_binding_only_gains_host_tools_after_explicit_reconnect(tmp_path, monkeypatch):
    from test_native_collaboration_flow import wire_inputs
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    parent = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(parent.id, "before_bridge", "instant")
        await wait_run(runtime, parent.id)
        await settle(runtime)
        original = runtime.store.list_bindings(parent.id)[0]
        assert not original.capabilities.host_subagents
        assert runtime.snapshot(parent.id)["nativeBinding"]["hostSubagents"] is False
        enable_bridge(runtime)
        await runtime.submit(parent.id, "keep_existing", "instant")
        await settle(runtime)
        assert runtime.store.get_binding(original.id).state == "active"
        assert not runtime.store.get_binding(original.id).capabilities.host_subagents
        assert len(runtime.store.list_runs(parent.id)) == 2
        before_inputs = wire_inputs(root, original)
        session = runtime.store.get_session(parent.id)
        await runtime.native.reconnect(parent.id, session.revision, original.id)
        replacement = next(b for b in runtime.store.list_bindings(parent.id) if b.state == "active")
        assert replacement.id != original.id and replacement.replaces_binding_id == original.id
        assert replacement.capabilities.host_subagents
        assert runtime.snapshot(parent.id)["nativeBinding"]["hostSubagents"] is True
        assert len(runtime.store.list_runs(parent.id)) == 2 and wire_inputs(root, original) == before_inputs
        assert not wire_inputs(root, replacement)  # A reconnect does not submit a model task.
        await runtime.native.reconnect(parent.id, session.revision, original.id)
        assert next(b.id for b in runtime.store.list_bindings(parent.id) if b.state == "active") == replacement.id
        runtime.store.save_subagents(project.id, 0, [{"id": "reviewer", "name": "Reviewer", "instructions": "Read only",
            "executor": "claude", "readonly": True}])
        await runtime.submit(parent.id, "after_reconnect", "delegate_host")
        await wait_run(runtime, parent.id)
        await settle(runtime)
        assert len(runtime.store.list_runs(parent.id)) == 3
        assert len(runtime.store.list_collaborations(parent.id)) == 1
        assert (root / "manual.txt").read_text() == "MANUAL_CONTENT" and not model_calls
    finally:
        await client.close()
        await runtime.close()


@pytest.mark.parametrize("lead", NATIVE)
@pytest.mark.asyncio
async def test_enabled_host_capability_survives_idle_transport_restore(tmp_path, monkeypatch, lead):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    enable_bridge(runtime)
    parent = runtime.store.create_session(project.id, lead)
    try:
        await runtime.submit(parent.id, "initial_round", "instant")
        await wait_run(runtime, parent.id)
        await settle(runtime)
        original = runtime.store.list_bindings(parent.id)[0]
        host = runtime.native.hosts[(project.id, lead)]
        connection = host._client if lead == ExecutorId.CODEX else host._sessions[original.id].connection
        await connection.close()
        runtime.store.save_subagents(project.id, 0, [{"id": "reviewer", "name": "Reviewer", "instructions": "Read only",
            "executor": "claude", "readonly": True}])
        await runtime.submit(parent.id, "restored_round", "delegate_host")
        await wait_run(runtime, parent.id)
        await settle(runtime)
        restored = next(b for b in runtime.store.list_bindings(parent.id) if b.state == "active")
        assert (restored.id, restored.native_session_id) == (original.id, original.native_session_id)
        assert runtime.snapshot(parent.id)["nativeBinding"]["hostSubagents"] is True
        assert len(runtime.store.list_runs(parent.id)) == 2
        records = await runtime.collaboration.observe(parent.id)
        assert len(records) == 1 and records[0]["returnMessageId"]
        assert not model_calls and (root / "manual.txt").read_text() == "MANUAL_CONTENT"
    finally:
        await client.close()
        await runtime.close()


def test_work_tool_call_is_strict_and_contains_one_mona_tool_request():
    request = WorkToolCall.model_validate({"tool": "read_file", "arguments": {"path": "notes.txt"}})
    assert request.model_dump() == {"tool": "read_file", "arguments": {"path": "notes.txt"}}
    schema = WorkToolCall.model_json_schema()
    assert schema["additionalProperties"] is False
    assert schema["properties"]["tool"]["minLength"] == 1
    assert set(schema["required"]) == {"tool", "arguments"}
    with pytest.raises(ValidationError):
        WorkToolCall.model_validate({"tool": "  ", "arguments": {}})
    with pytest.raises(ValidationError):
        WorkToolCall.model_validate({"tool": "read_file", "arguments": {}, "extra": True})


@pytest.mark.asyncio
async def test_work_callback_can_wait_without_the_code_timeout():
    from mona.development.contracts import Binding

    binding = Binding(session_id="session_id", executor=ExecutorId.CLAUDE,
                      native_session_id="native", working_directory=".")
    async def handler(*_args):
        await asyncio.sleep(0.03)
        return {"content": [{"type": "text", "text": "runner result"}], "isError": False}

    result = await call_in_turn(handler, binding, "turn", {}, lambda: True, timeout_s=None)
    assert result["content"][0]["text"] == "runner result"


@pytest.mark.asyncio
async def test_sdk_executor_sends_work_prompt_and_routes_tool_result(tmp_path, monkeypatch):
    from mona.development.executors.sdk import call_in_turn as original_call

    root = (tmp_path / "work").resolve()
    root.mkdir()
    prompt = _long_work_prompt()
    profile = prepare_sdk_profile(ExecutorId.CLAUDE, Path(sys.executable), tmp_path / "native", root)
    monkeypatch.setattr("mona.development.executors.sdk.sdk_version", lambda _executor: "test-peer")
    monkeypatch.setattr("mona.development.executors.sdk.worker_command",
        lambda: (sys.executable, "-u", str(Path(__file__).with_name("sdk_peer.py").resolve())))
    observed_timeouts = []

    async def tracked_call(*args, timeout_s=90):
        observed_timeouts.append(timeout_s)
        return await original_call(*args, timeout_s=timeout_s)

    monkeypatch.setattr("mona.development.executors.sdk.call_in_turn", tracked_call)
    calls = []

    async def run_tool(binding, turn_id, arguments):
        calls.append((binding.native_session_id, turn_id, arguments))
        await asyncio.sleep(0.03)
        return {"content": [{"type": "text", "text": "AUTHORIZED_RUNNER_RESULT"}], "isError": False}

    host = SDKExecutor(profile, tool_handler=run_tool)
    context = ProjectContext("work", root, (), (), (), "rules", "skills")
    session = DevelopmentSession(project_id="work", executor=ExecutorId.CLAUDE)
    prompt_file = None
    try:
        binding = await host.create_session(SessionStart(session, context, work_prompt=prompt))
        config_dir = Path(profile.environment["CLAUDE_CONFIG_DIR"])
        prompt_files = list(config_dir.glob(".mona-work-prompt-*.txt"))
        assert len(prompt_files) == 1
        prompt_file = prompt_files[0]
        assert hashlib.sha256(prompt_file.read_bytes()).hexdigest() == hashlib.sha256(prompt.encode("utf-8")).hexdigest()

        async def collect_events():
            collected = []
            async for event in host.events(binding):
                collected.append(event)
                if event.type in {"run.completed", "run.failed", "run.unknown"}:
                    return collected
            return collected

        event_task = asyncio.create_task(collect_events())
        receipt = await host.send(binding, "work_input", "work_tool")
        assert receipt.outcome == "accepted"
        terminal = await asyncio.wait_for(event_task, 5)
        assert terminal and terminal[-1].type == "run.completed"
        assert calls and calls[0][1] == receipt.native_turn_id
        assert calls[0][2] == {"tool": "read_file", "arguments": {"path": "manual.txt"}}
        assert observed_timeouts == [None]
        await host.close_runtime(binding)
        assert not prompt_file.exists()
    finally:
        await host.shutdown()


def _sdk_worker_peer(monkeypatch):
    import sdk_peer

    from mona.development.executors import sdk_worker

    module = SimpleNamespace(
        ClaudeAgentOptions=sdk_peer.Options,
        CodeBuddyAgentOptions=sdk_peer.Options,
        ClaudeSDKClient=sdk_peer.Client,
        CodeBuddySDKClient=sdk_peer.Client,
        PermissionResultAllow=sdk_peer.Allow,
        PermissionResultDeny=sdk_peer.Deny,
        AppendSystemPrompt=sdk_peer.AppendPrompt,
        HookMatcher=sdk_peer.HookMatcher,
        tool=sdk_peer.tool,
        create_sdk_mcp_server=sdk_peer.create_sdk_mcp_server,
    )
    original_import = sdk_worker.importlib.import_module
    monkeypatch.setattr(sdk_worker, "sdk_version", lambda _executor: "test-peer")
    monkeypatch.setattr(sdk_worker.importlib, "import_module", lambda name, *args:
                        module if name in {"claude_agent_sdk", "codebuddy_agent_sdk"}
                        else original_import(name, *args))
    return sdk_worker, sdk_peer


def _work_start(tmp_path, monkeypatch, executor, prompt):
    managed_home = tmp_path / "managed-home"
    workspace = tmp_path / "workspace"
    managed_home.mkdir()
    workspace.mkdir()
    config_dir = managed_home / (".claude" if executor == ExecutorId.CLAUDE else ".codebuddy")
    monkeypatch.setenv("HOME", str(managed_home))
    monkeypatch.setenv("USERPROFILE", str(managed_home))
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(managed_home / ".claude"))
    monkeypatch.setenv("CODEBUDDY_CONFIG_DIR", str(managed_home / ".codebuddy"))
    start = {"executor": executor.value, "cwd": str(workspace), "executable": "test-only",
        "nativeSessionId": "test-session", "readonly": False, "isSubagent": False, "context": "CODE_CONTEXT",
        "model": None, "resume": False, "hostCollaboration": False, "workPrompt": prompt,
        "permissionMode": "ask", "effort": None}
    return start, managed_home, workspace, config_dir


def _long_work_prompt():
    return "完整提示词\r\n" + "p" * 40_000


@pytest.mark.parametrize("executor", [ExecutorId.CLAUDE, ExecutorId.CODEBUDDY])
def test_sdk_work_prompt_is_spooled_under_managed_config_home(tmp_path, monkeypatch, executor):
    sdk_worker, sdk_peer = _sdk_worker_peer(monkeypatch)
    prompt = _long_work_prompt()
    expected_digest = hashlib.sha256(prompt.encode("utf-8")).digest()
    start, managed_home, workspace, config_dir = _work_start(tmp_path, monkeypatch, executor, prompt)
    worker = sdk_worker.Worker()
    prompt_file = None
    try:
        worker.build_options(start)
        prompt_file = worker._work_prompt_file
        assert len(prompt) > 32767
        assert prompt_file is not None and prompt_file.is_absolute()
        assert prompt_file.parent == config_dir.resolve(strict=True)
        assert prompt_file.is_relative_to(managed_home.resolve(strict=True))
        assert not prompt_file.is_relative_to(workspace.resolve(strict=True))
        assert hashlib.sha256(prompt_file.read_bytes()).digest() == expected_digest
        if executor == ExecutorId.CLAUDE:
            assert worker.options.system_prompt == {"type": "file", "path": str(prompt_file)}
        else:
            assert worker.options.system_prompt is None
            assert worker.options.extra_args["system-prompt-file"] == str(prompt_file)
        assert worker.options.tools == []
        assert worker.options.allowed_tools == [SDK_WORK_TOOL]
        assert "mcp__*" not in worker.options.disallowed_tools
        assert set(worker.options.mcp_servers) == {WORK_SERVER}
        server_tool = worker.options.mcp_servers[WORK_SERVER]["instance"][WORK_TOOL]
        assert server_tool.description == WORK_DESCRIPTION
        assert server_tool.input_schema == WorkToolCall.model_json_schema()

        worker.start = start
        worker.active = "turn"
        worker.projector.begin("turn")
        allowed = asyncio.run(worker.permission(SDK_WORK_TOOL, {"tool": "read_file", "arguments": {}}, None))
        denied = asyncio.run(worker.permission("Bash", {"command": "echo side effect"}, None))
        assert isinstance(allowed, sdk_peer.Allow)
        assert isinstance(denied, sdk_peer.Deny)
    finally:
        worker._cleanup_work_prompt_file()
    assert prompt_file is not None and not prompt_file.exists()


def _sdk_without_tools_option(monkeypatch):
    import sdk_peer

    from mona.development.executors import sdk_worker

    class NoToolsOptions:
        def __init__(self, cwd, setting_sources, mcp_servers, hooks, can_use_tool, extra_args,
                     include_partial_messages, resume=None, permission_mode="default",
                     codebuddy_code_path=None, **kwargs):
            self.extra_args = extra_args
            self.resume = resume
            self.session_id = kwargs.get("session_id")
            self.permission_mode = permission_mode
            self.kwargs = kwargs

    module = SimpleNamespace(ClaudeAgentOptions=NoToolsOptions, CodeBuddyAgentOptions=NoToolsOptions,
        ClaudeSDKClient=sdk_peer.Client, CodeBuddySDKClient=sdk_peer.Client,
        PermissionResultAllow=sdk_peer.Allow, PermissionResultDeny=sdk_peer.Deny,
        AppendSystemPrompt=sdk_peer.AppendPrompt, HookMatcher=sdk_peer.HookMatcher,
        tool=sdk_peer.tool, create_sdk_mcp_server=sdk_peer.create_sdk_mcp_server)
    original_import = sdk_worker.importlib.import_module
    monkeypatch.setattr(sdk_worker, "sdk_version", lambda _executor: "test-peer")
    monkeypatch.setattr(sdk_worker.importlib, "import_module", lambda name, *args:
                        module if name in {"claude_agent_sdk", "codebuddy_agent_sdk"}
                        else original_import(name, *args))
    return sdk_worker


def test_codebuddy_without_tools_option_uses_file_prompt_and_empty_cli_tools(tmp_path, monkeypatch):
    sdk_worker = _sdk_without_tools_option(monkeypatch)
    prompt = _long_work_prompt()
    expected_digest = hashlib.sha256(prompt.encode("utf-8")).digest()
    start, managed_home, workspace, config_dir = _work_start(
        tmp_path, monkeypatch, ExecutorId.CODEBUDDY, prompt)
    worker = sdk_worker.Worker()
    prompt_file = None
    try:
        worker.build_options(start)
        prompt_file = worker._work_prompt_file
        assert len(prompt) > 32767
        assert prompt_file is not None and prompt_file.is_absolute()
        assert prompt_file.parent == config_dir.resolve(strict=True)
        assert prompt_file.is_relative_to(managed_home.resolve(strict=True))
        assert not prompt_file.is_relative_to(workspace.resolve(strict=True))
        assert hashlib.sha256(prompt_file.read_bytes()).digest() == expected_digest
        assert worker.options.extra_args["system-prompt-file"] == str(prompt_file)
        assert worker.options.extra_args["tools"] == ""
        assert worker.options.kwargs["allowed_tools"] == [SDK_WORK_TOOL]
        assert "tools" not in worker.options.kwargs
        assert worker.options.kwargs["system_prompt"] is None
    finally:
        worker._cleanup_work_prompt_file()
    assert prompt_file is not None and not prompt_file.exists()


def test_claude_without_tools_option_fails_closed_for_work(tmp_path, monkeypatch):
    sdk_worker = _sdk_without_tools_option(monkeypatch)
    start = {"executor": ExecutorId.CLAUDE.value, "cwd": str(tmp_path), "executable": "test-only",
        "nativeSessionId": "test-session", "readonly": False, "isSubagent": False, "context": "CODE_CONTEXT",
        "model": None, "resume": False, "hostCollaboration": False, "workPrompt": "WORK PROMPT",
        "permissionMode": "ask", "effort": None}
    with pytest.raises(ValueError, match="sdk_isolation_unsupported"):
        worker = sdk_worker.Worker()
        worker.build_options(start)
    assert worker._work_prompt_file is None


def test_sdk_work_prompt_rejects_config_directory_outside_managed_home(tmp_path, monkeypatch):
    sdk_worker, _sdk_peer = _sdk_worker_peer(monkeypatch)
    prompt = _long_work_prompt()
    start, _managed_home, _workspace, _config_dir = _work_start(
        tmp_path, monkeypatch, ExecutorId.CODEBUDDY, prompt)
    outside_config = tmp_path / "outside-config"
    monkeypatch.setenv("CODEBUDDY_CONFIG_DIR", str(outside_config))

    worker = sdk_worker.Worker()
    with pytest.raises(ValueError, match="sdk_isolation_unsupported"):
        worker.build_options(start)

    assert worker._work_prompt_file is None
    assert not outside_config.exists()


@pytest.mark.parametrize("failure", ["startup", "cancel"])
@pytest.mark.asyncio
async def test_sdk_work_prompt_file_is_removed_after_startup_failure_or_cancellation(
        tmp_path, monkeypatch, failure):
    sdk_worker, sdk_peer = _sdk_worker_peer(monkeypatch)
    prompt = _long_work_prompt()
    start, _managed_home, workspace, _config_dir = _work_start(
        tmp_path, monkeypatch, ExecutorId.CLAUDE, prompt)
    monkeypatch.chdir(workspace)
    worker = sdk_worker.Worker()
    worker.ready = asyncio.get_running_loop().create_future()
    connect_entered = asyncio.Event()
    prompt_files = []
    disconnect_calls = []
    original_disconnect = sdk_peer.Client.disconnect

    async def connect(self, prompt=None):
        self.owner = asyncio.current_task()
        prompt_files.append(worker._work_prompt_file)
        connect_entered.set()
        if failure == "startup":
            raise RuntimeError("test connection failed")
        await asyncio.Event().wait()

    async def disconnect(self):
        assert worker._work_prompt_file is not None
        assert worker._work_prompt_file.exists()
        disconnect_calls.append(True)
        await original_disconnect(self)

    monkeypatch.setattr(sdk_peer.Client, "connect", connect)
    monkeypatch.setattr(sdk_peer.Client, "disconnect", disconnect)
    owner = asyncio.create_task(worker.own_client(start))
    await connect_entered.wait()
    prompt_file = prompt_files[0]
    assert prompt_file is not None
    if failure == "cancel":
        assert prompt_file.exists()
        owner.cancel()
    await owner

    assert not prompt_file.exists()
    assert disconnect_calls == [True]
    error = worker.ready.exception()
    assert isinstance(error, RuntimeError)
    assert str(error) == ("test connection failed" if failure == "startup" else "sdk_start_cancelled")


def test_sdk_event_projector_allows_only_the_work_mcp_tool():
    projector = SDKEventProjector("native", work_tool=True)
    projector.consume({"type": "system", "subtype": "init", "session_id": "native",
                       "mcp_servers": [{"name": WORK_SERVER}]})
    projector.begin("turn")
    projector.consume({"type": "assistant", "session_id": "native", "content": [{"type": "tool_use",
        "id": "work-call", "name": SDK_WORK_TOOL, "input": {"tool": "read_file", "arguments": {}}}]})
    with pytest.raises(RpcError, match="未授权"):
        projector.consume({"type": "assistant", "session_id": "native", "content": [{"type": "tool_use",
            "id": "wrong-call", "name": SDK_HOST_TOOL, "input": {"action": "presets"}}]})


def test_codebuddy_03264_transport_passes_file_path_without_prompt_argument(tmp_path, monkeypatch):
    from codebuddy_agent_sdk.transport.subprocess import SubprocessTransport

    from mona.development.executors import sdk_worker

    prompt = _long_work_prompt()
    expected_digest = hashlib.sha256(prompt.encode("utf-8")).digest()
    start, managed_home, workspace, config_dir = _work_start(
        tmp_path, monkeypatch, ExecutorId.CODEBUDDY, prompt)
    worker = sdk_worker.Worker()
    prompt_file = None
    try:
        worker.build_options(start)
        prompt_file = worker._work_prompt_file
        assert prompt_file is not None
        assert hashlib.sha256(prompt_file.read_bytes()).digest() == expected_digest
        assert worker.options.system_prompt is None
        args = SubprocessTransport(options=worker.options)._build_args()
        prompt_flag = args.index("--system-prompt-file")
        assert args[prompt_flag + 1] == str(prompt_file)
        assert args.count("--system-prompt-file") == 1
        assert "--system-prompt" not in args and "--append-system-prompt" not in args
        command_chars = sum(len(arg.encode("utf-16-le")) // 2 + 1
                            for arg in [str(worker.options.codebuddy_code_path), *args]) + 1
        assert command_chars < 32767
        assert prompt_file.parent == config_dir.resolve(strict=True)
        assert prompt_file.is_relative_to(managed_home.resolve(strict=True))
        assert not prompt_file.is_relative_to(workspace.resolve(strict=True))
    finally:
        worker._cleanup_work_prompt_file()
    assert prompt_file is not None and not prompt_file.exists()
