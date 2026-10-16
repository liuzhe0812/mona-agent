"""Real workbench/runtime + production Codex adapter + independent pipe peer.

Only the upstream native process is a fixture. This is not vendor binary or
account acceptance, and never invokes an LLM to stand in for a CLI.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.contracts import ExecutorId, RunStatus
from mona.development.executors.base import DispatchReceipt
from mona.development.executors.codex import CodexExecutor
from mona.development.executors.codex_policy import CodexProfile
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import ConflictError, DevelopmentError, DevelopmentStore
from mona.session.manager import SessionManager

PEER = Path(__file__).with_name("native_peer.py").resolve()


async def setup(tmp_path):
    _resolve_tool_config_refs()
    config = Config()
    config.development.codex_path = sys.executable
    config.development.enabled_engines = ["codex"]
    root = tmp_path / "中文项目"
    root.mkdir()
    (root / "AGENTS.md").write_text("PROJECT_SENTINEL: preserve manual edits", encoding="utf8")
    home = tmp_path / "native"
    home.mkdir()
    runtime = DevelopmentRuntime(DevelopmentStore(tmp_path / "state.sqlite3"), SessionManager(tmp_path / "history"), lambda: config)
    project = runtime.store.open_project(root)
    async def approve(binding, method, params):
        return await runtime.native.decisions.request(binding, "permission", params)
    adapter = CodexExecutor(CodexProfile((sys.executable, "-u", str(PEER)), home, root, dict(os.environ)),
                            approval_handler=approve, request_timeout=2)
    runtime.native.hosts[(project.id, ExecutorId.CODEX)] = adapter
    return runtime, project, root, adapter


async def wait_run(runtime, session_id, state=RunStatus.SUCCEEDED):
    async with asyncio.timeout(8):
        while True:
            runs = runtime.store.list_runs(session_id)
            if runs and runs[0].status == state:
                return runs[0]
            await asyncio.sleep(0.01)


async def settle(runtime):
    async with asyncio.timeout(8):
        while runtime.tasks:
            await asyncio.sleep(0.01)


def trace(root):
    return [json.loads(line) for line in (root / "peer-trace.jsonl").read_text(encoding="utf8").splitlines()]


@pytest.mark.asyncio
async def test_native_main_rounds_resume_and_full_delta_handoff(tmp_path, monkeypatch):
    runtime, project, root, adapter = await setup(tmp_path)
    def no_model(*args, **kwargs):
        raise AssertionError("Native requests must not call Mona model API")
    monkeypatch.setattr("mona.development.runtime.build_provider_snapshot", no_model)
    session = runtime.store.create_session(project.id)
    transcript = runtime.sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", "ALREADY_DECIDED: keep the existing parser")
    runtime.sessions.save(transcript)
    try:
        switched = await runtime.switch_executor(session.id, session.revision, ExecutorId.CODEX, None)
        first = await runtime.submit(session.id, "request_first", "instant")
        await settle(runtime)
        binding = runtime.store.list_bindings(session.id)[0]
        assert binding.transcript_cursor > 0 and binding.handoff.state == "accepted"
        assert "ALREADY_DECIDED" in next(r["params"]["input"][0]["text"] for r in trace(root) if r.get("method") == "turn/start")
        again = await runtime.submit(session.id, "request_first", "instant")
        assert again["reused"] and first["run"]["id"] == again["run"]["id"]
        with pytest.raises(ConflictError):
            await runtime.submit(session.id, "request_first", "different")
        second = await runtime.submit(session.id, "request_second", "instant")
        await settle(runtime)
        assert runtime.store.get_run(second["run"]["id"]).status == RunStatus.SUCCEEDED
        assert len([r for r in trace(root) if r.get("method") == "thread/start"]) == 1
        session = runtime.store.get_session(session.id)
        await runtime.switch_executor(session.id, session.revision, ExecutorId.MONA, None)
        transcript = runtime.sessions.get_or_create(session.transcript_key)
        transcript.add_message("user", "NEW_DECISION_WHILE_AWAY: keep comments")
        runtime.sessions.save(transcript)
        session = runtime.store.get_session(session.id)
        await runtime.switch_executor(session.id, session.revision, ExecutorId.CODEX, None)
        await runtime.submit(session.id, "request_third", "instant")
        await settle(runtime)
        assert len(runtime.store.list_sessions(project.id)) == 1
        assert runtime.store.list_bindings(session.id)[0].native_session_id == binding.native_session_id
        last = [r for r in trace(root) if r.get("method") == "turn/start"][-1]
        text = last["params"]["input"][0]["text"]
        delta, _ = json.JSONDecoder().raw_decode(text[text.index("{"):])
        assert delta["mode"] == "delta"
        assert "NEW_DECISION_WHILE_AWAY" in json.dumps(delta["conversation"])
        assert "ALREADY_DECIDED" not in json.dumps(delta["conversation"])
        # Incremental history excludes old turns; the task brief retains their constraints.
        assert "ALREADY_DECIDED" in delta["taskBrief"]["requests"][0]["text"]
        assert switched.id == session.id
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_user_approval_is_scoped_and_native_queue_dispatches_once(tmp_path):
    runtime, project, root, _ = await setup(tmp_path)
    one = runtime.store.create_session(project.id, ExecutorId.CODEX)
    two = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        first = await runtime.submit(one.id, "request_approval", "approve")
        await wait_run(runtime, one.id, RunStatus.WAITING_USER)
        pending = runtime.snapshot(one.id)["pendingDecisions"]
        assert len(pending) == 1 and not runtime.snapshot(two.id)["pendingDecisions"]
        with pytest.raises(ConflictError):
            runtime.native.decisions.resolve(two.id, pending[0]["id"], "accept")
        queued = await runtime.submit(one.id, "request_followup", "instant")
        assert queued["queued"]
        await runtime.submit(two.id, "request_independent", "instant")
        await wait_run(runtime, two.id)
        runtime.native.decisions.resolve(one.id, pending[0]["id"], "accept")
        await settle(runtime)
        assert runtime.store.get_run(first["run"]["id"]).status == RunStatus.SUCCEEDED
        assert len(runtime.store.list_runs(one.id)) == 2
        assert len([r for r in trace(root) if r.get("method") == "turn/start"]) == 3
        snapshot = runtime.snapshot(one.id)
        assert [m["content"] for m in snapshot["messages"] if m["role"] == "user"] == ["approve", "instant"]
        assert len({m["id"] for m in snapshot["messages"]}) == len(snapshot["messages"])
        assert all(m["authorId"] == "codex" for m in snapshot["messages"] if m["role"] == "assistant")
        assert not snapshot["pendingDecisions"] and not snapshot["pendingInputs"]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_native_inflight_switch_rejected_and_recovery_does_not_send(tmp_path):
    runtime, project, root, _ = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        sent = await runtime.submit(session.id, "request_hold", "hold")
        await wait_run(runtime, session.id, RunStatus.RUNNING)
        current = runtime.store.get_session(session.id)
        with pytest.raises(ConflictError):
            await runtime.switch_executor(session.id, current.revision, ExecutorId.MONA, None)
        await runtime.interrupt(session.id, sent["run"]["id"])
        await settle(runtime)
        assert runtime.store.get_run(sent["run"]["id"]).status == RunStatus.INTERRUPTED
        assert len([r for r in trace(root) if r.get("method") == "turn/start"]) == 1
    finally:
        await runtime.close()


def updated_program(runtime, monkeypatch):
    binary = Path(sys._base_executable).resolve()
    if binary == Path(sys.executable).resolve():
        pytest.skip("This real-pipe fixture requires a virtual environment")
    runtime.config_loader().development.codex_path = str(binary)
    monkeypatch.setattr("mona.development.native_manager.prepare_codex_profile",
        lambda executable, home, root, **_kwargs:
            CodexProfile((str(executable), "-u", str(PEER)), home, root, dict(os.environ)))
    return binary


@pytest.mark.asyncio
async def test_model_refresh_replaces_old_account_process_and_preserves_home(tmp_path, monkeypatch):
    runtime, _, root, old = await setup(tmp_path)
    home = runtime.store.path.parent / "native" / "codex"
    home.mkdir()
    old.profile = replace(old.profile, home=home)
    runtime.native.hosts[("", ExecutorId.CODEX)] = old
    marker = old.profile.home / "retained-session.txt"
    marker.write_text("existing session")
    try:
        assert await old.list_models() == ["example-model"]
        previous = old._client
        binary = updated_program(runtime, monkeypatch)
        new = await runtime.native._account_host(ExecutorId.CODEX)
        assert new is not old and previous.closed
        assert new.profile.command[0] == str(binary)
        assert new.profile.home == old.profile.home
        assert await new.list_models() == ["example-model"]
        assert marker.read_text() == "existing session"
        assert not runtime.tasks and all(not runtime.store.list_sessions(project.id) for project in runtime.store.list_projects())
        assert not any(call["method"] in {"thread/start", "turn/start", "account/login/start"} for call in trace(root))
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_program_upgrade_keeps_running_project_process(tmp_path, monkeypatch):
    runtime, project, _, old = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(session.id, "upgrade_waiting", "approve")
        await wait_run(runtime, session.id, RunStatus.WAITING_USER)
        previous = old._client
        updated_program(runtime, monkeypatch)
        assert await runtime.native._host(runtime.store.get_session(session.id)) is old
        assert not previous.closed
        assert runtime.store.active_run(session.id).status == RunStatus.WAITING_USER
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_disabled_source_keeps_current_task_but_rejects_new_calls(tmp_path):
    runtime, project, root, host = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        first = await runtime.submit(session.id, "before_disable", "approve")
        await wait_run(runtime, session.id, RunStatus.WAITING_USER)
        runtime.config_loader().development.enabled_engines = []
        description = next(item for item in runtime.native.describe() if item["id"] == "codex")
        assert not description["enabled"] and not description["available"] and description["programAvailable"]
        with pytest.raises(DevelopmentError) as error:
            await runtime.submit(session.id, "after_disable", "instant")
        assert error.value.code == "engine_disabled" and not host._client.closed
        assert runtime.store.get_run(first["run"]["id"]).status == RunStatus.WAITING_USER
        pending = runtime.native.decisions.list_pending(session.id)[0]
        runtime.native.decisions.resolve(session.id, pending["id"], "accept")
        await settle(runtime)
        assert runtime.store.get_run(first["run"]["id"]).status == RunStatus.SUCCEEDED
        assert len([call for call in trace(root) if call.get("method") == "turn/start"]) == 1
    finally:
        await runtime.close()


async def wait_run_state(runtime, run_id, state):
    async with asyncio.timeout(8):
        while True:
            run = runtime.store.get_run(run_id)
            if run.status == state:
                return run
            await asyncio.sleep(0.01)


@pytest.mark.asyncio
async def test_native_steering_is_idempotent_on_target_run(tmp_path):
    runtime, project, root, _ = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    run_id = None
    try:
        started = await runtime.submit(session.id, "steer_parent", "hold")
        run_id = started["run"]["id"]
        run = await wait_run_state(runtime, run_id, RunStatus.RUNNING)
        first = await runtime.submit(session.id, "steer_once", "请先保留现有解析器，再补齐错误处理。",
            intent="steering", target_run_id=run.id)
        repeated = await runtime.submit(session.id, "steer_once", "请先保留现有解析器，再补齐错误处理。",
            intent="steering", target_run_id=run.id)

        assert first["input"]["state"] == "accepted" and not first["queued"]
        assert repeated["reused"] and repeated["input"]["runId"] == run.id
        assert len(runtime.store.list_runs(session.id)) == 1
        calls = trace(root)
        assert len([call for call in calls if call.get("method") == "turn/start"]) == 1
        steering = [call for call in calls if call.get("method") == "turn/steer"]
        assert len(steering) == 1
        assert steering[0]["params"]["expectedTurnId"] == run.native_turn_id
    finally:
        if run_id is not None:
            current = runtime.store.get_run(run_id)
            if current.status not in {RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.INTERRUPTED}:
                await runtime.interrupt(session.id, current.id)
                await settle(runtime)
        await runtime.close()


@pytest.mark.asyncio
async def test_native_guided_follow_up_rejection_replays_without_redispatch(tmp_path, monkeypatch):
    runtime, project, _root, host = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    run_id = None
    steer_calls = []
    content = "保留这条排队消息，明确拒绝后仍可恢复。"
    try:
        started = await runtime.submit(session.id, "guide_rejected_parent", "hold")
        run_id = started["run"]["id"]
        run = await wait_run_state(runtime, run_id, RunStatus.RUNNING)
        queued = await runtime.submit(session.id, "guide_rejected_input", content, intent="follow_up")
        assert queued["queued"]
        item = runtime.store.get_input(queued["input"]["id"])
        assert item.intent == "follow_up" and item.state.value == "pending"
        original_revision = item.revision

        async def reject_steering(binding, input_id, message):
            steer_calls.append((binding.id, input_id, message))
            return DispatchReceipt(input_id=input_id, outcome="rejected", native_turn_id=run.native_turn_id)

        monkeypatch.setattr(host, "steer", reject_steering)
        for _ in range(2):
            with pytest.raises(DevelopmentError) as error:
                await runtime.guide_input(session.id, item.id, original_revision, run.id)
            assert error.value.code == "native_steering_rejected"

        saved = runtime.store.get_input(item.id)
        assert saved.id == item.id and saved.message_id == item.message_id and saved.run_id == run.id
        assert saved.intent == "steering" and saved.requested_intent == "follow_up"
        assert saved.state.value == "rejected" and saved.revision > original_revision
        transcript = runtime.sessions.get_or_create(session.transcript_key)
        message = next(m for m in transcript.messages if m.get("id") == item.message_id)
        assert message["content"] == content
        assert message["_input_source"]["content"] == content
        assert steer_calls == [(runtime.store.get_run(run.id).binding_id, item.id, content)]
        assert len(runtime.store.list_runs(session.id)) == 1
    finally:
        if run_id is not None:
            current = runtime.store.get_run(run_id)
            if current.status not in {RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.INTERRUPTED, RunStatus.UNKNOWN}:
                await runtime.interrupt(session.id, run_id)
                await settle(runtime)
        await runtime.close()


@pytest.mark.asyncio
async def test_native_steering_rejects_stale_or_wrong_target_without_dispatch(tmp_path):
    runtime, project, root, _ = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    active_run_id = None
    try:
        completed = await runtime.submit(session.id, "completed_before_steer", "instant")
        await wait_run_state(runtime, completed["run"]["id"], RunStatus.SUCCEEDED)
        active = await runtime.submit(session.id, "active_for_steer", "hold")
        active_run_id = active["run"]["id"]
        await wait_run_state(runtime, active_run_id, RunStatus.RUNNING)

        for request_id, target in (("stale_target", completed["run"]["id"]),
                                   ("wrong_target", "run_not_current")):
            with pytest.raises(ConflictError):
                await runtime.submit(session.id, request_id, "请修正当前步骤。", intent="steering",
                                     target_run_id=target)

        assert len(runtime.store.list_runs(session.id)) == 2
        assert not runtime.snapshot(session.id)["pendingInputs"]
        calls = trace(root)
        assert len([call for call in calls if call.get("method") == "turn/start"]) == 2
        assert not any(call.get("method") == "turn/steer" for call in calls)
    finally:
        if active_run_id is not None:
            current = runtime.store.get_run(active_run_id)
            if current.status not in {RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.INTERRUPTED}:
                await runtime.interrupt(session.id, current.id)
                await settle(runtime)
        await runtime.close()


@pytest.mark.asyncio
async def test_similar_command_requires_native_prefix_and_returns_execpolicy_amendment(tmp_path):
    runtime, project, root, _ = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        first = await runtime.submit(session.id, "approve_similar", "approve_similar")
        run = await wait_run_state(runtime, first["run"]["id"], RunStatus.WAITING_USER)
        pending = runtime.native.decisions.list_pending(session.id)[0]
        prefix = ["echo", "harmless"]
        assert pending["details"]["similarCommandPrefix"] == prefix
        runtime.native.decisions.resolve(session.id, pending["id"], "accept_similar")
        await wait_run_state(runtime, run.id, RunStatus.SUCCEEDED)
        similar_reply = next(call for call in trace(root)
            if call.get("id") == "approve-" + run.native_turn_id and "result" in call)
        assert similar_reply["result"]["decision"] == {
            "acceptWithExecpolicyAmendment": {"execpolicy_amendment": prefix}}

        second = await runtime.submit(session.id, "approve_without_prefix", "approve")
        second_run = await wait_run_state(runtime, second["run"]["id"], RunStatus.WAITING_USER)
        pending = runtime.native.decisions.list_pending(session.id)[0]
        assert "similarCommandPrefix" not in pending["details"]
        with pytest.raises(ConflictError):
            runtime.native.decisions.resolve(session.id, pending["id"], "accept_similar")
        runtime.native.decisions.resolve(session.id, pending["id"], "accept")
        await wait_run_state(runtime, second_run.id, RunStatus.SUCCEEDED)
        plain_reply = next(call for call in trace(root)
            if call.get("id") == "approve-" + second_run.native_turn_id and "result" in call)
        assert plain_reply["result"]["decision"] == "accept"
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_native_steering_unknown_is_saved_and_retry_does_not_resend(tmp_path):
    runtime, project, root, _ = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    request_id = "steer_lost_ack"
    target_run_id = None
    try:
        started = await runtime.submit(session.id, "steer_unknown_parent", "hold")
        target_run_id = started["run"]["id"]
        run = await wait_run_state(runtime, target_run_id, RunStatus.RUNNING)
        host = runtime.native.hosts[(project.id, ExecutorId.CODEX)]
        assert host._client is not None
        host._client._timeout = 0.1

        with pytest.raises(DevelopmentError) as error:
            await runtime.submit(session.id, request_id, "steer_no_ack", intent="steering",
                                 target_run_id=run.id)
        assert error.value.code == "native_steering_unknown"
        item = runtime.store.get_input(request_id)
        assert item.state.value == "unknown" and item.run_id == run.id
        message = next(m for m in runtime.sessions.get_or_create(session.transcript_key).messages
                       if m.get("id") == item.message_id)
        assert message["content"] == "steer_no_ack"
        assert runtime.store.get_run(run.id).status == RunStatus.UNKNOWN

        repeated = await runtime.submit(session.id, request_id, "steer_no_ack", intent="steering",
                                        target_run_id=run.id)
        assert repeated["reused"] and repeated["input"]["state"] == "unknown"
        assert len(runtime.store.list_runs(session.id)) == 1
        calls = trace(root)
        assert len([call for call in calls if call.get("method") == "turn/start"]) == 1
        assert len([call for call in calls if call.get("method") == "turn/steer"]) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_native_guided_follow_up_unknown_retry_keeps_original_input_without_redispatch(tmp_path):
    runtime, project, root, _ = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    run_id = None
    request_id = "guide_lost_ack_input"
    content = "steer_no_ack"
    try:
        started = await runtime.submit(session.id, "guide_unknown_parent", "hold")
        run_id = started["run"]["id"]
        run = await wait_run_state(runtime, run_id, RunStatus.RUNNING)
        host = runtime.native.hosts[(project.id, ExecutorId.CODEX)]
        assert host._client is not None
        host._client._timeout = 0.1

        queued = await runtime.submit(session.id, request_id, content, intent="follow_up")
        assert queued["queued"] and queued["input"]["id"] == request_id
        original_revision = queued["input"]["revision"]
        with pytest.raises(DevelopmentError) as error:
            await runtime.guide_input(session.id, request_id, original_revision, run.id)
        assert error.value.code == "native_steering_unknown"

        saved = runtime.store.get_input(request_id)
        assert saved.state.value == "unknown" and saved.intent == "steering" and saved.run_id == run.id
        transcript = runtime.sessions.get_or_create(session.transcript_key)
        message = next(m for m in transcript.messages if m.get("id") == saved.message_id)
        assert message["content"] == content and message["_input_source"]["content"] == content
        repeated = await runtime.guide_input(session.id, request_id, original_revision, run.id)
        assert repeated["reused"] and repeated["input"]["id"] == request_id
        assert repeated["input"]["state"] == "unknown"
        assert len(runtime.store.list_runs(session.id)) == 1
        calls = trace(root)
        assert len([call for call in calls if call.get("method") == "turn/start"]) == 1
        assert len([call for call in calls if call.get("method") == "turn/steer"]) == 1
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_managed_program_change_releases_an_idle_native_host(tmp_path):
    runtime, project, _root, host = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    component_root = tmp_path / "runtimes" / "components" / "codex-cli"
    managed_program = component_root / "versions" / "1.0.0" / "bin" / "codex"
    previous_profile = host.profile
    try:
        await runtime.native.ensure(session)
        host.profile = replace(
            host.profile,
            command=(str(managed_program), *host.profile.command[1:]),
        )
        assert host._client is not None and not host._client.closed

        async with runtime.native.managed_program_change(ExecutorId.CODEX, component_root):
            pass

        assert host._client is not None and host._client.closed
        assert (project.id, ExecutorId.CODEX) not in runtime.native.hosts
        assert runtime.store.get_session(session.id).id == session.id
    finally:
        host.profile = previous_profile
        await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("uncertain", [False, True], ids=["running", "unknown"])
async def test_managed_program_change_keeps_running_or_unknown_pipe_task(tmp_path, uncertain):
    runtime, project, root, host = await setup(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    run_id = None
    component_root = tmp_path / "runtimes" / "components" / "codex-cli"
    managed_program = component_root / "versions" / "1.0.0" / "bin" / "codex"
    previous_profile = host.profile
    try:
        started = await runtime.submit(session.id, "managed_delete_guard", "hold")
        run_id = started["run"]["id"]
        run = await wait_run_state(runtime, run_id, RunStatus.RUNNING)
        binding = runtime.store.list_bindings(session.id)[0]
        if uncertain:
            host._runtime(binding).fault("test_uncertain_turn")
            run = await wait_run_state(runtime, run_id, RunStatus.UNKNOWN)
        host.profile = replace(
            host.profile,
            command=(str(managed_program), *host.profile.command[1:]),
        )

        with pytest.raises(ConflictError):
            async with runtime.native.managed_program_change(ExecutorId.CODEX, component_root):
                pytest.fail("the active native task must keep the managed program in use")

        assert host._client is not None and not host._client.closed
        assert len([call for call in trace(root) if call.get("method") == "turn/start"]) == 1
        assert runtime.store.get_run(run.id).status in {RunStatus.RUNNING, RunStatus.UNKNOWN}
    finally:
        host.profile = previous_profile
        if run_id is not None and runtime.store.get_run(run_id).status == RunStatus.RUNNING:
            await runtime.interrupt(session.id, run_id)
            await settle(runtime)
        await runtime.close()
