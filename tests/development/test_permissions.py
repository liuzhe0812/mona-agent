import asyncio
import os
import re
import sys
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import pytest

from mona.agent.tools.shell import ExecToolConfig
from mona.config.paths import get_managed_runtimes_dir
from mona.config.schema import Config, _resolve_tool_config_refs
from mona.development.coding import CodingTools
from mona.development.contracts import Binding, ExecutorId, PermissionMode, RunStatus
from mona.development.decisions import DecisionBroker
from mona.development.permissions import DevelopmentPermissions
from mona.development.store import ConflictError, DevelopmentStore
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.runtime.manager import RuntimeComponentManifest, RuntimeComponentStore
from mona.session.manager import SessionManager
from tests.development.test_native_workbench import settle, trace
from tests.development.test_native_workbench import setup as setup_native
from tests.development.test_workbench_api import AUTH, setup_client
from tests.development.test_workbench_runtime import Model, make_runtime, wait_done


class ReviewModel(LLMProvider):
    def __init__(self, response):
        super().__init__()
        self.response = response
        self.closed = False

    def get_default_model(self):
        return "review-test"

    async def chat(self, messages, **kwargs):
        return LLMResponse(self.response)

    async def aclose(self):
        self.closed = True


def setup(tmp_path, *, mode=PermissionMode.AUTO, readonly=False):
    _resolve_tool_config_refs()
    root = tmp_path / "project"
    root.mkdir()
    config = Config()
    store = DevelopmentStore(tmp_path / "permissions.sqlite")
    sessions = SessionManager(tmp_path / "history")
    project = store.open_project(root)
    session = store.create_session(project.id, permission_mode=mode, readonly=readonly)
    run, _ = store.create_run(session.id, "request", "message")
    store.transition_run(run.id, run.revision, RunStatus.PREPARING)
    transcript = sessions.get_or_create(session.transcript_key)
    transcript.add_message("user", "修复项目代码，保留项目外文件。", id="message", run_id=run.id)
    sessions.save(transcript)
    broker = DecisionBroker(store, 5)
    policy = DevelopmentPermissions(store, sessions, broker, lambda: config)
    return root, store, session, run, policy


def install_process_sandbox(monkeypatch, spawn):
    runners = []

    class ControlledSandbox:
        def __init__(self, root, session_key):
            self.root = Path(root)
            self.session_key = session_key
            self.commands = []
            runners.append(self)

        async def spawn(self, command, cwd, env, shell_program, login, *, stdin):
            self.commands.append(command)
            return await spawn(command, cwd, env, stdin)

        def diagnostics(self, _exit_code, _stderr):
            return ""

    monkeypatch.setattr("mona.development.sandbox.DevelopmentSandbox", ControlledSandbox)
    return runners


async def execute_without_permission_prompt(tools, policy, session_id, name, arguments):
    task = asyncio.create_task(tools.registry.execute(name, arguments))
    try:
        async with asyncio.timeout(3):
            while not task.done():
                assert not policy.decisions.list_pending(session_id), f"{name} unexpectedly requested approval"
                await asyncio.sleep(0.01)
        return task.result()
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def wait_for_permission(policy, session_id):
    async with asyncio.timeout(3):
        while not policy.decisions.list_pending(session_id):
            await asyncio.sleep(0.01)
    return policy.decisions.list_pending(session_id)[0]


@pytest.mark.asyncio
async def test_permission_api_confirms_full_access_and_preserves_active_run(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    try:
        project = runtime.store.open_project(root)
        session = runtime.store.create_session(project.id)
        endpoint = f"/api/development/sessions/{session.id}/permissions"
        auto = await client.put(endpoint, headers=AUTH, json={"revision": session.revision, "mode": "auto"})
        assert auto.status == 200
        saved = await auto.json()
        rejected = await client.put(endpoint, headers=AUTH, json={"revision": saved["revision"], "mode": "full_access"})
        assert rejected.status == 409
        assert runtime.store.get_session(session.id).permission_mode == PermissionMode.AUTO
        accepted = await client.put(endpoint, headers=AUTH, json={"revision": saved["revision"], "mode": "full_access", "confirmed": True})
        assert accepted.status == 200
        run, _ = runtime.store.create_run(session.id, "new_request", "new_message")
        assert run.permission_mode == PermissionMode.FULL_ACCESS
        blocked = await client.put(endpoint, headers=AUTH, json={"revision": (await accepted.json())["revision"], "mode": "ask"})
        assert blocked.status == 409
        assert runtime.store.get_run(run.id).permission_mode == PermissionMode.FULL_ACCESS
        recovered = DevelopmentStore(runtime.store.path)
        assert recovered.get_session(session.id).permission_mode == PermissionMode.FULL_ACCESS
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_shared_auto_review_gates_real_file_writes_and_falls_back_to_confirmation(tmp_path, monkeypatch):
    root, store, session, run, policy = setup(tmp_path)
    model = ReviewModel('{"verdict":"block","reason":"不属于用户授权。"}')
    monkeypatch.setattr("mona.development.permissions.build_provider_snapshot", lambda *a, **k:
        SimpleNamespace(provider=model, model="review-test"))
    tools = CodingTools(root, session.transcript_key, ExecToolConfig())
    tools.configure_permissions(PermissionMode.AUTO, lambda name, args: policy.decide(run.id, name, args))
    result = await tools.registry.execute("write_file", {"path": "output.txt", "content": "first"})
    assert "未获授权" in result and not (root / "output.txt").exists() and model.closed
    model.response = '{"verdict":"allow","reason":"用户要求修改项目文件。"}'
    await tools.registry.execute("write_file", {"path": "output.txt", "content": "allowed"})
    assert (root / "output.txt").read_text() == "allowed"
    model.response = "invalid reviewer response"
    pending = asyncio.create_task(tools.registry.execute("write_file", {"path": "fallback.txt", "content": "confirmed"}))
    try:
        async with asyncio.timeout(3):
            while not policy.decisions.list_pending(session.id):
                await asyncio.sleep(0.01)
        decision = policy.decisions.list_pending(session.id)[0]
        assert not (root / "fallback.txt").exists()
        policy.decisions.resolve(session.id, decision["id"], "accept")
        await pending
        assert (root / "fallback.txt").read_text() == "confirmed"
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)


@pytest.mark.asyncio
async def test_full_access_inheritance_keeps_readonly_and_old_approval_protection(tmp_path):
    root, store, session, run, policy = setup(tmp_path, mode=PermissionMode.FULL_ACCESS)
    child = store.create_session(session.project_id, parent_session_id=session.id, readonly=True)
    assert child.permission_mode == PermissionMode.FULL_ACCESS
    with pytest.raises(ConflictError):
        store.set_permission_mode(child.id, child.revision, PermissionMode.ASK)
    child_run, _ = store.create_run(child.id, "child_request", "child_message")
    store.transition_run(child_run.id, child_run.revision, RunStatus.PREPARING)
    assert await policy.decide(child_run.id, "write_file", {"path": "outside.txt"}) == "decline"
    store.transition_run(run.id, store.get_run(run.id).revision, RunStatus.INTERRUPTING)
    store.transition_run(run.id, store.get_run(run.id).revision, RunStatus.INTERRUPTED)
    with pytest.raises(ConflictError):
        await policy.decide(run.id, "exec", {"command": "echo should-not-run"})
    assert not (root / "outside.txt").exists()


@pytest.mark.asyncio
async def test_ask_mode_allows_root_collaboration_without_expanding_child_permissions(tmp_path):
    root, store, parent, parent_run, policy = setup(tmp_path, mode=PermissionMode.ASK)
    assert await policy.decide(parent_run.id, "development_collaboration", {}) == "accept"
    assert not policy.decisions.list_pending(parent.id)

    child = store.create_session(parent.project_id, parent_session_id=parent.id)
    assert child.permission_mode == PermissionMode.ASK
    child_run, _ = store.create_run(child.id, "child_request", "child_message")
    store.transition_run(child_run.id, child_run.revision, RunStatus.PREPARING)
    tools = CodingTools(root, child.transcript_key, ExecToolConfig())
    tools.configure_permissions(PermissionMode.ASK,
        lambda name, arguments: policy.decide(child_run.id, name, arguments))
    outside = root.parent / "child-write.txt"
    write = asyncio.create_task(tools.registry.execute("write_file", {
        "path": str(outside), "content": "requires child authorization",
    }))
    try:
        decision = await wait_for_permission(policy, child.id)
        assert str(outside) in decision["details"]["reason"]
        assert not outside.exists()
        assert not policy.decisions.list_pending(parent.id)
        policy.decisions.resolve(child.id, decision["id"], "decline")
        assert "未获授权" in await write
        assert not outside.exists()
    finally:
        write.cancel()
        await asyncio.gather(write, return_exceptions=True)

    readonly_child = store.create_session(child.project_id, parent_session_id=parent.id, readonly=True)
    readonly_run, _ = store.create_run(readonly_child.id, "readonly_request", "readonly_message")
    store.transition_run(readonly_run.id, readonly_run.revision, RunStatus.PREPARING)
    assert await policy.decide(readonly_run.id, "development_collaboration", {}) == "decline"
    assert await policy.decide(readonly_run.id, "write_file", {"path": str(outside)}) == "decline"
    assert not policy.decisions.list_pending(readonly_child.id)
    assert not outside.exists()


@pytest.mark.asyncio
async def test_native_permission_switch_reuses_original_thread_on_next_run(tmp_path):
    from mona.development.contracts import ExecutorId
    runtime, project, root, _ = await setup_native(tmp_path)
    session = runtime.store.create_session(project.id, ExecutorId.CODEX)
    try:
        await runtime.submit(session.id, "before_permission", "instant")
        await settle(runtime)
        binding = runtime.store.list_bindings(session.id)[0]
        current = runtime.store.get_session(session.id)
        await runtime.set_permission_mode(session.id, current.revision, PermissionMode.FULL_ACCESS, confirmed=True)
        await runtime.submit(session.id, "after_permission", "instant")
        await settle(runtime)
        restored = runtime.store.list_bindings(session.id)[0]
        assert restored.native_session_id == binding.native_session_id and restored.permission_mode == PermissionMode.FULL_ACCESS
        resumed = next(call for call in trace(root) if call.get("method") == "thread/resume")
        assert resumed["params"]["sandbox"] == "danger-full-access" and resumed["params"]["approvalPolicy"] == "never"
        assert len([call for call in trace(root) if call.get("method") == "thread/start"]) == 1
        assert len([call for call in trace(root) if call.get("method") == "turn/start"]) == 2
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_external_file_approval_is_limited_to_one_confirmed_call(tmp_path):
    root, _, session, run, policy = setup(tmp_path, mode=PermissionMode.ASK)
    outside = tmp_path / "approved-outside.txt"
    tools = CodingTools(root, session.transcript_key, ExecToolConfig())
    tools.configure_permissions(PermissionMode.ASK, lambda name, args: policy.decide(run.id, name, args))
    request = asyncio.create_task(tools.registry.execute("write_file", {"path": str(outside), "content": "once"}))
    try:
        async with asyncio.timeout(3):
            while not policy.decisions.list_pending(session.id):
                await asyncio.sleep(0.01)
        decision = policy.decisions.list_pending(session.id)[0]
        assert str(outside) in decision["details"]["reason"] and not outside.exists()
        policy.decisions.resolve(session.id, decision["id"], "accept")
        await request
        assert outside.read_text() == "once"
        second = asyncio.create_task(tools.registry.execute("write_file", {"path": str(outside), "content": "must-not-write"}))
        async with asyncio.timeout(3):
            while not policy.decisions.list_pending(session.id):
                await asyncio.sleep(0.01)
        policy.decisions.resolve(session.id, policy.decisions.list_pending(session.id)[0]["id"], "decline")
        await second
        assert outside.read_text() == "once"
    finally:
        request.cancel()
        await asyncio.gather(request, return_exceptions=True)


@pytest.mark.skipif(os.name != "nt", reason="Windows consumer and pinned runner integration")
@pytest.mark.asyncio
async def test_mona_command_uses_approval_and_bundled_sandbox_on_actual_runner(monkeypatch):
    active = RuntimeComponentStore(get_managed_runtimes_dir()).active("node-base")
    assert active and active[0].version == "22.23.2"
    node = active[1] / active[0].entrypoints["node"]
    # Use normal inherited Windows ACLs; pytest hardens its own temporary tree.
    with TemporaryDirectory(prefix="mona-permissions-") as temporary:
        base = Path(temporary)
        runtime_root = base / "runtime-store"
        store = RuntimeComponentStore(runtime_root)
        archive = base / "node-base.zip"
        manifest = RuntimeComponentManifest(id="node-base", version="22.23.2", kind="node-runtime", entrypoints={"node": "node.exe"})
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("runtime-manifest.json", manifest.model_dump_json(by_alias=True))
            bundle.write(node, "node.exe")
        store.install_archive(archive)
        monkeypatch.setattr("mona.development.sandbox.get_managed_runtimes_dir", lambda: runtime_root)
        model = Model([
            LLMResponse("", tool_calls=[ToolCallRequest("command", "exec", {"command": "echo approved>result.txt"})]),
            LLMResponse("已完成"),
            LLMResponse("", tool_calls=[ToolCallRequest("outside", "exec", {"command": "echo forbidden>..\\outside.txt"})]),
            LLMResponse("项目外写入被阻止"),
            LLMResponse("", tool_calls=[ToolCallRequest("escalated", "exec", {
                "command": "echo forbidden>..\\outside.txt", "sandbox_permissions": "danger-full-access",
                "justification": "为验证单次授权，需要在项目外创建这个临时文件。",
            })]),
            LLMResponse("单次授权已完成"),
        ])
        runtime, _, session, root = make_runtime(base / "workbench", monkeypatch, model)
        try:
            await runtime.submit(session.id, "command_request", "创建 result.txt 验证命令执行。")
            assert (await wait_done(runtime, session.id))[0].status == RunStatus.SUCCEEDED
            assert (root / "result.txt").read_text().strip() == "approved"
            assert not runtime.native.decisions.list_pending(session.id)
            assert store.active("development-sandbox") is not None

            await runtime.submit(session.id, "outside_request", "验证沙箱能否阻止项目外写入。")
            await wait_done(runtime, session.id)
            assert not (root.parent / "outside.txt").exists()
            result = next(message for message in runtime.snapshot(session.id)["messages"] if message.get("toolCallId") == "outside")
            assert "Exit code: 1" in result["content"]
            assert "[sandbox: file access denied under workspace-write mode]" in result["content"]
            assert "sandbox_permissions" in result["content"] and "不会自动重放" in result["content"]
            assert not runtime.native.decisions.list_pending(session.id)

            await runtime.submit(session.id, "escalated_request", "单次授权创建这个项目外的临时文件。")
            async with asyncio.timeout(10):
                while not runtime.native.decisions.list_pending(session.id):
                    await asyncio.sleep(0.01)
            pending = runtime.native.decisions.list_pending(session.id)[0]
            assert "工作区写入限制外" in pending["details"]["reason"]
            assert not (root.parent / "outside.txt").exists()
            runtime.native.decisions.resolve(session.id, pending["id"], "accept")
            await wait_done(runtime, session.id)
            assert (root.parent / "outside.txt").read_text().strip() == "forbidden"
            assert runtime.store.get_session(session.id).permission_mode == PermissionMode.ASK

            async def allow_background_call(_name, _arguments):
                return "accept"

            tools = CodingTools(root, "background-diagnostics", ExecToolConfig())
            tools.configure_permissions(PermissionMode.ASK, allow_background_call)
            try:
                output = await tools.registry.execute("exec", {"command": "echo denied>..\\background.txt", "yield_time_ms": 0})
                if "session_id:" in output:
                    session_id = re.search(r"session_id:\s*([0-9a-f]+)", output).group(1)
                    async with asyncio.timeout(10):
                        while "Exit code:" not in output:
                            output = await tools.registry.execute("write_stdin", {"session_id": session_id, "chars": "", "yield_time_ms": 100})
                assert "[sandbox: file access denied under workspace-write mode]" in output
                assert not (root.parent / "background.txt").exists()
            finally:
                await tools.exec_sessions.cancel_by_session("background-diagnostics")
        finally:
            await runtime.close()


@pytest.mark.asyncio
async def test_command_escalation_never_starts_before_exact_confirmation(tmp_path):
    root, _, session, run, policy = setup(tmp_path, mode=PermissionMode.ASK)
    tools = CodingTools(root, session.transcript_key, ExecToolConfig())
    tools.configure_permissions(PermissionMode.ASK, lambda name, args: policy.decide(run.id, name, args))
    marker = root / "should-not-exist.txt"
    command = f'echo unsafe > "{marker}"'
    request = asyncio.create_task(tools.registry.execute("exec", {"command": command,
        "sandbox_permissions": "danger-full-access", "justification": "本次命令确实需要额外写入范围。"}))
    try:
        async with asyncio.timeout(3):
            while not policy.decisions.list_pending(session.id):
                await asyncio.sleep(0.01)
        decision = policy.decisions.list_pending(session.id)[0]
        assert decision["details"]["command"] == command and not marker.exists()
        policy.decisions.resolve(session.id, decision["id"], "decline")
        await request
        assert not marker.exists()
        invalid = await tools.registry.execute("exec", {"command": command, "sandbox_permissions": "danger-full-access"})
        assert "必须同时" in invalid and not marker.exists()
    finally:
        request.cancel()
        await asyncio.gather(request, return_exceptions=True)


@pytest.mark.asyncio
async def test_ask_mona_git_log_reaches_project_sandbox_without_approval(tmp_path, monkeypatch):
    root, _, session, run, policy = setup(tmp_path, mode=PermissionMode.ASK)
    marker = root / "controlled-runner.txt"

    async def spawn(command, cwd, env, stdin):
        script = (
            "from pathlib import Path; import sys; "
            "Path(sys.argv[1]).write_text(sys.argv[2], encoding='utf-8'); "
            "print('controlled sandbox runner')"
        )
        return await asyncio.create_subprocess_exec(
            sys.executable, "-c", script, str(marker), command, cwd=cwd, env=env,
            stdin=stdin, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )

    runners = install_process_sandbox(monkeypatch, spawn)
    tools = CodingTools(root, session.transcript_key, ExecToolConfig())
    tools.configure_permissions(PermissionMode.ASK, lambda name, args: policy.decide(run.id, name, args))
    try:
        result = await execute_without_permission_prompt(tools, policy, session.id, "exec", {"command": "git log"})
        assert len(runners) == 1 and runners[0].commands == ["git log"]
        assert marker.read_text(encoding="utf-8") == "git log"
        assert "controlled sandbox runner" in result
        assert not policy.decisions.list_pending(session.id)

        elevated = asyncio.create_task(tools.registry.execute("exec", {
            "command": "git log", "sandbox_permissions": "danger-full-access",
            "justification": "验证显式升权必须单独确认。",
        }))
        try:
            decision = await wait_for_permission(policy, session.id)
            assert runners[0].commands == ["git log"]
            assert marker.read_text(encoding="utf-8") == "git log"
            policy.decisions.resolve(session.id, decision["id"], "decline")
            result = await elevated
            assert "未获授权" in result
            assert runners[0].commands == ["git log"]
        finally:
            elevated.cancel()
            await asyncio.gather(elevated, return_exceptions=True)
    finally:
        await tools.exec_sessions.cancel_by_session(session.transcript_key)


@pytest.mark.asyncio
async def test_empty_write_stdin_polls_without_approval_but_nonempty_input_still_asks(tmp_path, monkeypatch):
    root, _, session, run, policy = setup(tmp_path, mode=PermissionMode.ASK)
    received = root / "stdin-received.txt"

    async def spawn(command, cwd, env, stdin):
        script = (
            "import pathlib,sys,time; time.sleep(.35); print('READY',flush=True); "
            "value=sys.stdin.readline(); "
            "pathlib.Path(sys.argv[1]).write_text(value,encoding='utf-8') if value else None"
        )
        return await asyncio.create_subprocess_exec(
            sys.executable, "-c", script, str(received), cwd=cwd, env=env, stdin=stdin,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )

    runners = install_process_sandbox(monkeypatch, spawn)
    tools = CodingTools(root, session.transcript_key, ExecToolConfig())
    tools.configure_permissions(PermissionMode.ASK, lambda name, args: policy.decide(run.id, name, args))
    try:
        started = await execute_without_permission_prompt(
            tools, policy, session.id, "exec", {"command": "git log", "yield_time_ms": 0},
        )
        match = re.search(r"session_id:\s*([0-9a-f]+)", started)
        assert match is not None
        output = await execute_without_permission_prompt(tools, policy, session.id, "write_stdin", {
            "session_id": match.group(1), "chars": "", "yield_time_ms": 1000,
        })
        assert "READY" in output
        assert runners[0].commands == ["git log"]
        assert not received.exists()
        assert not policy.decisions.list_pending(session.id)

        write = asyncio.create_task(tools.registry.execute("write_stdin", {
            "session_id": match.group(1), "chars": "unapproved input\n", "yield_time_ms": 100,
        }))
        try:
            decision = await wait_for_permission(policy, session.id)
            assert decision["details"]["command"] == "unapproved input\n"
            assert not received.exists()
            policy.decisions.resolve(session.id, decision["id"], "decline")
            assert "未获授权" in await write
            assert not received.exists()
            assert runners[0].commands == ["git log"]
        finally:
            write.cancel()
            await asyncio.gather(write, return_exceptions=True)
    finally:
        await tools.exec_sessions.cancel_by_session(session.transcript_key)


@pytest.mark.asyncio
async def test_native_ask_requests_keep_executor_identity_and_turn_correlation(tmp_path):
    root, store, base_session, _, policy = setup(tmp_path, mode=PermissionMode.ASK)
    for executor in (ExecutorId.CODEX, ExecutorId.CLAUDE, ExecutorId.CODEBUDDY):
        session = store.create_session(base_session.project_id, executor, permission_mode=PermissionMode.ASK)
        binding = store.activate_binding(Binding(
            id=f"binding_{executor.value}_native", session_id=session.id, executor=executor,
            native_session_id=f"native-{executor.value}-session", working_directory=str(root),
        ), session.revision)
        run, _ = store.create_run(session.id, f"request_{executor.value}", f"message_{executor.value}", binding.id)
        run = store.transition_run(run.id, run.revision, RunStatus.PREPARING)
        turn_id = f"native-turn-{executor.value}"
        store.bind_native_turn(run.id, binding.id, turn_id)
        params = {
            "turnId": turn_id, "toolName": "exec", "command": "git log",
            "cwd": str(root), "reason": f"{executor.value} native approval",
        }
        request = asyncio.create_task(policy.native_request(binding, "native/commandApproval", params))
        try:
            decision = await wait_for_permission(policy, session.id)
            assert decision["details"] == {
                "command": "git log", "cwd": str(root), "reason": f"{executor.value} native approval",
                "toolName": "exec", "questions": [],
            }
            policy.decisions.resolve(session.id, decision["id"], "accept")
            assert await request == "accept"
            with pytest.raises(ConflictError, match="原任务不再等待"):
                await policy.native_request(binding, "native/commandApproval", {**params, "turnId": "stale-turn"})
            assert not policy.decisions.list_pending(session.id)
        finally:
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
