"""Native-initiated delegation through production adapters, worker and durable store.

Vendor responses are explicit protocol/SDK peers, not live account/model acceptance.
"""
from __future__ import annotations

import asyncio
import itertools
import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from test_native_collaboration_flow import NATIVE, setup, wire_inputs
from test_native_workbench import settle, wait_run

from mona.development.contracts import ExecutorId, ReviewSource, RunStatus
from mona.development.executors.codex_events import normalize_codex_event
from mona.development.executors.host_tools import (
    HOST_SERVER,
    HOST_TOOL,
    SDK_HOST_TOOL,
    SUBAGENT_INSTRUCTIONS,
    HostToolCall,
    call_in_turn,
    host_servers_valid,
)
from mona.development.executors.rpc import RpcError
from mona.development.executors.sdk_events import SDKEventProjector


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
