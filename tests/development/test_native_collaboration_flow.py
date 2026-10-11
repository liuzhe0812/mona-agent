"""Native workbench integration: real HTTP/store/adapters/SDK worker and pipe peers.

Only vendor processes/SDK calls are test dependencies. No official account,
model, network service, native desktop UI or autonomous delegation is certified.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import os
import sys
from pathlib import Path

import pytest
from aiohttp import ClientConnectionError, web
from aiohttp.test_utils import TestClient, TestServer
from test_native_workbench import settle, wait_run

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId, InputState, RunStatus
from mona.development.executors.codex import CodexExecutor
from mona.development.executors.codex_policy import CodexProfile
from mona.development.executors.sdk import SDKExecutor
from mona.development.executors.sdk_policy import prepare_sdk_profile
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import DevelopmentStore
from mona.session.manager import SessionManager

NATIVE = (ExecutorId.CODEX, ExecutorId.CLAUDE, ExecutorId.CODEBUDDY)
HEADERS = {"X-Mona-Token": "synthetic-native-workbench-token"}


async def setup(tmp_path, monkeypatch, *, lose_followup=False):
    _resolve_tool_config_refs()
    config = Config()
    config.development.enabled_engines = ["codex", "claude", "codebuddy"]
    root = tmp_path / "协作项目"
    root.mkdir()
    (root / "AGENTS.md").write_text("PROJECT_RULE: keep user edits", encoding="utf8")
    (root / "manual.txt").write_text("MANUAL_CONTENT", encoding="utf8")
    runtime = DevelopmentRuntime(DevelopmentStore(tmp_path / "state.sqlite3"),
        SessionManager(tmp_path / "history"), lambda: config)
    project = runtime.store.open_project(root)
    model_calls = []
    def no_model(*args, **kwargs):
        model_calls.append(True)
        raise AssertionError("Native collaboration must not call an extra Mona model")
    monkeypatch.setattr("mona.development.runtime.build_provider_snapshot", no_model)
    monkeypatch.setattr("mona.development.executors.sdk.sdk_version", lambda _: "test-peer")
    monkeypatch.setattr("mona.development.executors.sdk.worker_command",
        lambda: (sys.executable, "-u", str(Path(__file__).with_name("sdk_peer.py").resolve())))
    monkeypatch.setattr("mona.development.api.is_valid_services_token", lambda value: value == HEADERS["X-Mona-Token"])
    async def approve(binding, _method, params):
        return await runtime.native.decisions.request(binding, "permission", params)
    async def question(binding, params):
        return await runtime.native.decisions.request(binding, "question", params)
    for executor in NATIVE:
        setattr(config.development, f"{executor.value}_path", sys.executable)
        home = tmp_path / executor.value
        home.mkdir()
        if executor == ExecutorId.CODEX:
            profile = CodexProfile((sys.executable, "-u", str(Path(__file__).with_name("native_peer.py").resolve()),
                "complete_requests"), home, root, dict(os.environ))
            host = CodexExecutor(profile, approval_handler=approve, question_handler=question, request_timeout=2)
        else:
            profile = prepare_sdk_profile(executor, Path(sys.executable), home, root)
            host = SDKExecutor(profile, approval_handler=approve, question_handler=question)
        runtime.native.hosts[(project.id, executor)] = host
    dropped = False
    @web.middleware
    async def drop_accepted_receipt(request, handler):
        nonlocal dropped
        response = await handler(request)
        if lose_followup and not dropped and request.method == "POST" and request.path.endswith("/follow-up") and response.status == 200:
            dropped = True
            assert request.transport is not None
            request.transport.close()  # The production handler has already accepted the request.
        return response
    app = web.Application(middlewares=[drop_accepted_receipt])
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    return runtime, project, root, TestClient(TestServer(app)), model_calls


def wire_inputs(root, binding):
    filename = "peer-trace.jsonl" if binding.executor == ExecutorId.CODEX else "sdk-peer-trace.jsonl"
    path = root / filename
    rows = [json.loads(line) for line in path.read_text(encoding="utf8").splitlines()] if path.exists() else []
    if binding.executor == ExecutorId.CODEX:
        return [row["params"]["input"][0]["text"] for row in rows
                if row.get("method") == "turn/start" and row["params"]["threadId"] == binding.native_session_id]
    return [row["input"] for row in rows if row.get("method") == "query" and row["nativeId"] == binding.native_session_id]


def handoff_conversation(binding):
    assert binding.handoff is not None
    lines = binding.handoff.content.split("\n", 2)
    assert len(lines) == 3
    payload, marker, _ = lines[2].rpartition("\n[/Mona handoff — current user request follows]")
    assert marker
    return json.loads(payload)["conversation"]


async def returned(runtime, parent_id):
    async with asyncio.timeout(10):
        while True:
            records = await runtime.collaboration.observe(parent_id)
            if records and records[0]["returnMessageId"]:
                return records[0]
            await asyncio.sleep(0.01)


async def post(client, path, body, status=200):
    response = await client.post("/api/development" + path, json=body, headers=HEADERS)
    value = await response.json()
    assert response.status == status, value
    return value


@pytest.mark.asyncio
@pytest.mark.parametrize("leader,reviewer", tuple(itertools.product(NATIVE, repeat=2)))
async def test_native_result_returns_to_original_leader_binding_once(tmp_path, monkeypatch, leader, reviewer):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    parent = runtime.store.create_session(project.id, leader)
    prefix = f"/sessions/{parent.id}"
    try:
        async with client:
            await post(client, prefix + "/send", {"requestId": "initial", "content": "instant"})
            await settle(runtime)
            binding = runtime.store.list_bindings(parent.id)[0]
            await post(client, prefix + "/collaborations", {"requestId": "native_review", "executor": reviewer.value,
                "goal": "Review the existing project without writing", "expectedOutput": "findings", "readonly": True})
            record = await returned(runtime, parent.id)
            child = runtime.store.get_session(record["childSessionId"])
            child_binding = runtime.store.list_bindings(child.id)[0]
            assert child.executor == reviewer and child.readonly and child_binding.id != binding.id
            source = runtime.sessions.get_or_create(child.transcript_key)
            parent_excerpt = next(message for message in source.messages if message.get("_collaboration_context"))
            child_input = wire_inputs(root, child_binding)[0]
            assert child_input.count("parentSessionId") == 1
            assert parent_excerpt["id"] in {item.get("messageId") for item in handoff_conversation(child_binding)}
            assert "协作目标：Review the existing project without writing" in child_input
            original = next(m["content"] for m in reversed(source.messages)
                            if m.get("role") == "assistant" and m.get("run_id") == record["latestRun"]["id"])
            assert len(wire_inputs(root, binding)) == 1  # Return alone does not restart the parent.
            # Later child discussion must not replace the original delegated result.
            await post(client, f"/sessions/{child.id}/send", {"requestId": "child_later", "content": "instant"})
            await settle(runtime)
            follow_path = prefix + f"/collaborations/{record['id']}/follow-up"
            observed = await (await client.get("/api/development" + follow_path, headers=HEADERS)).json()
            assert observed["followUp"] is None
            body = {"confirmed": True, "revision": runtime.store.get_session(parent.id).revision}
            first = await post(client, follow_path, body)
            await settle(runtime)
            recovered = await (await client.get("/api/development" + follow_path, headers=HEADERS)).json()
            again = await post(client, follow_path, body)
            assert first["followUp"]["requestId"] == recovered["followUp"]["requestId"] == again["followUp"]["requestId"]
            assert recovered["followUp"]["run"]["status"] == "succeeded"
            assert recovered["followUp"]["run"]["executor"] == leader.value
            assert runtime.store.list_bindings(parent.id)[0].native_session_id == binding.native_session_id
            inputs = wire_inputs(root, binding)
            assert len(inputs) == 2 and record["id"] in inputs[-1] and original in inputs[-1]
            assert len(wire_inputs(root, child_binding)) == 2
            assert len(runtime.store.list_runs(parent.id)) == 2 and len(runtime.store.list_runs(child.id)) == 2
            assert len([m for m in runtime.snapshot(parent.id)["messages"] if m["sourceKind"] == "collaboration"]) == 1
            assert (root / "manual.txt").read_text() == "MANUAL_CONTENT" and not model_calls
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("parent_excerpt_size", [128, 16_500])
async def test_native_child_context_is_sent_once_after_engine_switch(tmp_path, monkeypatch, parent_excerpt_size):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    parent = runtime.store.create_session(project.id, ExecutorId.MONA)
    parent_history = runtime.sessions.get_or_create(parent.transcript_key)
    parent_history.add_message("user", "PARENT_CONTEXT_SENTINEL" + "x" * parent_excerpt_size, id="parent-request")
    runtime.sessions.save(parent_history, fsync=True)
    try:
        async with client:
            record = await runtime.collaboration.start(parent.id, "context-once", ExecutorId.CODEX,
                "Review the supplied parent context", "Return concise findings", readonly=True)
            record = await returned(runtime, parent.id)
            child = runtime.store.get_session(record["childSessionId"])
            initial_binding = runtime.store.list_bindings(child.id)[0]
            source = runtime.sessions.get_or_create(child.transcript_key)
            parent_excerpt = next(message for message in source.messages if message.get("_collaboration_context"))
            initial_input = wire_inputs(root, initial_binding)[0]
            included = {item.get("messageId") for item in handoff_conversation(initial_binding)}
            assert (parent_excerpt["id"] in included) is (parent_excerpt_size == 128), (parent_excerpt["id"], included)
            expected_mentions = parent_excerpt["content"].count("PARENT_CONTEXT_SENTINEL")
            assert initial_input.count("PARENT_CONTEXT_SENTINEL") == expected_mentions
            assert "协作目标：Review the supplied parent context" in initial_input

            await runtime.switch_executor(child.id, child.revision, ExecutorId.CODEBUDDY, None)
            switched_binding = next(binding for binding in runtime.store.list_bindings(child.id)
                                    if binding.state == "active")
            switched_handoff_ids = {item.get("messageId") for item in handoff_conversation(switched_binding)}
            assert (parent_excerpt["id"] in switched_handoff_ids) is (parent_excerpt_size == 128)
            await runtime.submit(child.id, "child-after-switch", "Inspect the remaining handed-off context")
            await settle(runtime)
            switched_input = wire_inputs(root, switched_binding)[0]
            assert switched_input.count("PARENT_CONTEXT_SENTINEL") == expected_mentions
            assert "协作目标：Review the supplied parent context" in switched_input
            assert "Inspect the remaining handed-off context" in switched_input
            assert not model_calls
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("leader", NATIVE)
async def test_native_result_queues_behind_permission_and_is_consumed_once(tmp_path, monkeypatch, leader):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    parent = runtime.store.create_session(project.id, leader)
    prefix = f"/sessions/{parent.id}"
    try:
        async with client:
            command = "approve" if leader == ExecutorId.CODEX else "permission"
            await post(client, prefix + "/send", {"requestId": "current", "content": command})
            await wait_run(runtime, parent.id, RunStatus.WAITING_USER)
            binding = runtime.store.list_bindings(parent.id)[0]
            decision = runtime.snapshot(parent.id)["pendingDecisions"][0]
            await post(client, prefix + "/collaborations", {"requestId": "review", "executor": "claude",
                "goal": "Inspect current files", "expectedOutput": "findings", "readonly": True})
            record = await returned(runtime, parent.id)
            follow_path = prefix + f"/collaborations/{record['id']}/follow-up"
            body = {"confirmed": True, "revision": runtime.store.get_session(parent.id).revision}
            first, second = await asyncio.gather(post(client, follow_path, body), post(client, follow_path, body))
            request_id = first["followUp"]["requestId"]
            assert second["followUp"]["requestId"] == request_id
            assert first["followUp"]["input"]["state"] == "pending" and len(wire_inputs(root, binding)) == 1
            await post(client, prefix + f"/decisions/{decision['id']}", {"value": "accept"})
            await settle(runtime)
            state = runtime.collaboration.inspect_result(parent.id, record["id"])["followUp"]
            assert state["run"]["status"] == "succeeded"
            assert runtime.store.get_input(request_id).state == InputState.CONSUMED
            assert len(wire_inputs(root, binding)) == 2 and len(runtime.store.list_runs(record["childSessionId"])) == 1
            assert not runtime.snapshot(parent.id)["pendingInputs"] and not model_calls
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("leader", NATIVE)
async def test_cancelled_native_follow_up_never_restarts_child_or_parent(tmp_path, monkeypatch, leader):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    parent = runtime.store.create_session(project.id, leader)
    prefix = f"/sessions/{parent.id}"
    try:
        async with client:
            await post(client, prefix + "/send", {"requestId": "current",
                "content": "approve" if leader == ExecutorId.CODEX else "permission"})
            await wait_run(runtime, parent.id, RunStatus.WAITING_USER)
            decision = runtime.snapshot(parent.id)["pendingDecisions"][0]
            binding = runtime.store.list_bindings(parent.id)[0]
            await post(client, prefix + "/collaborations", {"requestId": "review", "executor": "claude",
                "goal": "Inspect without changing files", "readonly": True})
            record = await returned(runtime, parent.id)
            path = prefix + f"/collaborations/{record['id']}/follow-up"
            body = {"confirmed": True, "revision": runtime.store.get_session(parent.id).revision}
            queued = await post(client, path, body)
            request_id = queued["followUp"]["requestId"]
            response = await client.delete(f"/api/development{prefix}/inputs/{request_id}", headers=HEADERS)
            assert response.status == 200
            await post(client, prefix + f"/decisions/{decision['id']}", {"value": "accept"})
            await settle(runtime)
            again = await post(client, path, body)
            assert again["followUp"]["input"]["state"] == "cancelled" and again["followUp"]["run"] is None
            assert len(wire_inputs(root, binding)) == 1 and len(runtime.store.list_runs(record["childSessionId"])) == 1
            assert not model_calls
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("leader", NATIVE)
async def test_unknown_native_parent_blocks_new_result_processing_but_lookup_still_works(tmp_path, monkeypatch, leader):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch)
    parent = runtime.store.create_session(project.id, leader)
    prefix = f"/sessions/{parent.id}"
    try:
        async with client:
            await post(client, prefix + "/send", {"requestId": "unknown",
                "content": "disconnect" if leader == ExecutorId.CODEX else "new_result"})
            await wait_run(runtime, parent.id, RunStatus.UNKNOWN)
            binding = runtime.store.list_bindings(parent.id)[0]
            await post(client, prefix + "/collaborations", {"requestId": "review", "executor": "claude",
                "goal": "Inspect current files", "readonly": True})
            record = await returned(runtime, parent.id)
            path = prefix + f"/collaborations/{record['id']}/follow-up"
            for _ in range(2):
                await post(client, path, {"confirmed": True, "revision": runtime.store.get_session(parent.id).revision}, status=409)
                response = await client.get("/api/development" + path, headers=HEADERS)
                assert response.status == 200 and (await response.json())["followUp"] is None
            assert runtime.store.list_runs(parent.id)[0].status == RunStatus.UNKNOWN
            assert len(wire_inputs(root, binding)) == 1 and len(runtime.store.list_runs(record["childSessionId"])) == 1
            assert not model_calls
    finally:
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("leader", NATIVE)
async def test_native_accepted_followup_survives_real_http_receipt_loss(tmp_path, monkeypatch, leader):
    runtime, project, root, client, model_calls = await setup(tmp_path, monkeypatch, lose_followup=True)
    parent = runtime.store.create_session(project.id, leader)
    prefix = f"/sessions/{parent.id}"
    try:
        async with client:
            await post(client, prefix + "/send", {"requestId": "initial", "content": "instant"})
            await settle(runtime)
            binding = runtime.store.list_bindings(parent.id)[0]
            await post(client, prefix + "/collaborations", {"requestId": "review", "executor": "codebuddy",
                "goal": "Inspect current files", "readonly": True})
            record = await returned(runtime, parent.id)
            path = prefix + f"/collaborations/{record['id']}/follow-up"
            body = {"confirmed": True, "revision": runtime.store.get_session(parent.id).revision}
            with pytest.raises(ClientConnectionError):
                await post(client, path, body)
            await settle(runtime)
            recovered = await (await client.get("/api/development" + path, headers=HEADERS)).json()
            assert recovered["followUp"]["run"]["status"] == "succeeded"
            again = await post(client, path, body)
            assert again["followUp"]["run"]["id"] == recovered["followUp"]["run"]["id"]
            assert len(wire_inputs(root, binding)) == 2 and len(runtime.store.list_runs(record["childSessionId"])) == 1
            assert not model_calls
    finally:
        await runtime.close()
