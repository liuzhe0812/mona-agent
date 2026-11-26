"""Native primitives keep Mona authorization; private tools keep their host route."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.apply_patch import ApplyPatchTool
from mona.agent.tools.exec_session import WriteStdinTool
from mona.agent.tools.filesystem import ReadFileTool, WriteFileTool
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.shell import ExecTool
from mona.config.schema import Config
from mona.development.contracts import ExecutorId
from mona.development.executors.base import DispatchReceipt, NativeEvent
from mona.development.executors.codex_policy import prepare_codex_profile
from mona.development.executors.rpc import RpcError
from mona.providers.native_work_provider import NativeWorkProvider
from mona.providers.native_work_tools import NATIVE_BASIC_TOOLS, NativeWorkToolPolicy


def registry(root, *, restricted=False):
    tools = ToolRegistry()
    tools.register(ReadFileTool(workspace=root, allowed_dir=root if restricted else None))
    tools.register(WriteFileTool(workspace=root, allowed_dir=root if restricted else None))
    tools.register(ApplyPatchTool(workspace=root, allowed_dir=root if restricted else None))
    tools.register(ExecTool(working_dir=str(root), deny_patterns=["blocked-command"]))
    tools.register(WriteStdinTool())
    return tools


@pytest.mark.parametrize("executor", ["codex", "claude", "codebuddy"])
def test_native_tool_selection_never_expands_agent_authorization(tmp_path, executor):
    tools = registry(tmp_path)
    tools.set_allowed_tool_names({"read_file"})
    policy = NativeWorkToolPolicy(tools, executor, tmp_path)
    assert policy.native_tools
    assert not set(policy.native_tools) & {"Bash", "PowerShell", "Write", "Edit", "exec_command", "apply_patch"}
    assert policy.check("Write", {"file_path": str(tmp_path / "no.txt"), "content": "no"})["allow"] is False
    tools.get("read_file").model_visible = False
    assert policy.native_tools == ()


@pytest.mark.parametrize("executor", ["claude", "codebuddy"])
def test_native_file_and_command_checks_reuse_mona_boundaries(tmp_path, executor):
    root = tmp_path / "work"
    root.mkdir()
    policy = NativeWorkToolPolicy(registry(root, restricted=True), executor, root)
    assert policy.check("Read", {"file_path": str(root / "inside.txt")})["allow"]
    assert not policy.check("Read", {"file_path": str(tmp_path / "outside.txt")})["allow"]
    assert not policy.check("Write", {"file_path": str(tmp_path / "outside.txt"), "content": "no"})["allow"]
    assert not policy.check("Bash", {"command": "blocked-command"})["allow"]
    assert not policy.check("Bash", {"command": "curl http://127.0.0.1/private"})["allow"]


@pytest.mark.parametrize("executor", ["codex", "claude", "codebuddy"])
async def test_duplicate_host_tool_call_is_rejected_without_dispatch(tmp_path, executor):
    config = Config()
    config.agents.defaults.executor = executor
    provider = NativeWorkProvider(config, tmp_path)
    for name in NATIVE_BASIC_TOOLS:
        reply = await provider._host_tool(None, "turn", {"tool": name, "arguments": {}})
        assert reply["isError"] is True and provider._requests.empty()


@pytest.mark.parametrize("executor", ["codex", "claude", "codebuddy"])
async def test_unrepresentable_command_scope_is_rejected_before_cli_dispatch(tmp_path, executor, monkeypatch):
    config = Config()
    config.agents.defaults.executor = executor
    config.tools.restrict_to_workspace = True
    provider = NativeWorkProvider(config, tmp_path)
    provider.bind_runtime(registry(tmp_path))
    monkeypatch.setattr("mona.providers.native_work_provider.discover_executors",
                        lambda *_: pytest.fail("An unsupported scope must not start a CLI"))
    response = await provider.chat_stream([])
    assert response.error_code == "native_policy_unavailable" and not response.error_should_retry


async def test_saved_code_rules_do_not_block_or_expand_a_work_turn(tmp_path, monkeypatch):
    config = Config()
    config.agents.defaults.executor = "codex"
    config.development.enabled_engines = ["codex"]
    root = tmp_path / "work"
    root.mkdir()
    executable = tmp_path / "native.exe"
    executable.write_bytes(b"fixture")
    home = tmp_path / "native-home"
    prepare_codex_profile(executable, home, root, environment={})
    rules = home / "rules" / "default.rules"
    rules.parent.mkdir()
    rules.write_text("private rule fixture", encoding="utf8")
    (home / "models_cache.json").write_text(json.dumps({"models": [{"slug": "native-test"}]}), encoding="utf8")
    monkeypatch.setattr("mona.providers.native_work_provider.discover_executors", lambda *_: [
        SimpleNamespace(executor=ExecutorId.CODEX, state="detected", executable=str(executable))])
    hosts = []

    class Host:
        def __init__(self, profile, *, tool_handler):
            self.profile, self.sends = profile, 0
            self.shutdown = AsyncMock()
            hosts.append(self)

        async def create_session(self, start):
            self.start = start
            return SimpleNamespace(native_session_id="isolated-work")

        async def send(self, binding, input_id, content):
            self.sends += 1
            return DispatchReceipt(input_id=input_id, outcome="accepted", native_turn_id="turn")

        async def events(self, binding):
            yield NativeEvent(type="agent.message.completed", payload={"text": "ready"})
            yield NativeEvent(type="run.completed")

    monkeypatch.setattr("mona.providers.native_work_provider.CodexExecutor", Host)
    provider = NativeWorkProvider(config, root, native_home=home)
    provider.bind_runtime(registry(root))

    try:
        response = await provider.chat_stream_with_retry([{"role": "user", "content": "Read the current slide"}])
        assert response.content == "ready" and response.error_code is None
        assert hosts[0].sends == 1 and hosts[0].profile.home != home
        assert hosts[0].profile.work_auth_home == home
        assert "exec_command" in hosts[0].start.work_native_tools
        assert not (hosts[0].profile.home / "rules").exists()
    finally:
        await provider.aclose()
    assert not hosts[0].profile.home.exists()
    hosts[0].shutdown.assert_awaited_once()
    assert rules.read_text(encoding="utf8") == "private rule fixture"
    assert not list(home.glob(".mona-work-models-*.json"))


async def test_native_permission_is_recorded_once_before_operation_and_not_replayed(tmp_path):
    config = Config()
    config.agents.defaults.executor = "codebuddy"
    provider = NativeWorkProvider(config, tmp_path)
    checkpoints = []

    async def save(payload):
        checkpoints.append(payload)

    provider.bind_runtime(registry(tmp_path), save)
    provider._binding = SimpleNamespace(native_session_id="native-original")
    arguments = {"file_path": str(tmp_path / "created.txt"), "content": "not persisted in audit"}
    for _ in range(2):
        assert (await provider._native_permission("turn", "native-call", "Write", arguments))["allow"]
    assert len(checkpoints) == 1
    record = checkpoints[0]["native_work"]["calls"][0]
    assert record["status"] == "started" and record["native_session_id"] == "native-original"
    assert "not persisted in audit" not in str(checkpoints)
    assert not (tmp_path / "created.txt").exists()
    provider._reconciliation_deadline = asyncio.get_running_loop().time() + 1
    assert not (await provider._native_permission("turn", "next-call", "Write", arguments))["allow"]


@pytest.mark.parametrize("save_fails", [False, True])
async def test_duplicate_native_approvals_wait_for_the_same_durable_record(tmp_path, save_fails):
    config = Config()
    config.agents.defaults.executor = "codebuddy"
    provider = NativeWorkProvider(config, tmp_path)
    entered, release = asyncio.Event(), asyncio.Event()
    saves = []

    async def save(payload):
        saves.append(payload)
        entered.set()
        await release.wait()
        if save_fails:
            raise OSError("fixture save failed")

    provider.bind_runtime(registry(tmp_path), save)
    provider._binding = SimpleNamespace(native_session_id="native-original")
    arguments = {"file_path": str(tmp_path / "created.txt"), "content": "same operation"}
    first = asyncio.create_task(provider._native_permission("turn", "same-id", "Write", arguments))
    second = None
    try:
        await entered.wait()
        second = asyncio.create_task(provider._native_permission("turn", "same-id", "Write", arguments))
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(second), 0.02)
        changed = await provider._native_permission("turn", "same-id", "Write", {**arguments, "content": "different"})
        assert changed["allow"] is False
        release.set()
        replies = await asyncio.gather(first, second)
        assert [reply["allow"] for reply in replies] == [not save_fails, not save_fails]
        assert len(saves) == 1
    finally:
        release.set()
        await asyncio.gather(first, *([second] if second else []), return_exceptions=True)


def test_native_tools_still_require_request_capability_loading(tmp_path):
    from mona.agent.tools.capabilities import _ACTIVE_CAPABILITIES, activate_capabilities

    tools = registry(tmp_path)
    tools.register(SimpleNamespace(name="load_capability"))
    policy = NativeWorkToolPolicy(tools, "codebuddy", tmp_path)
    token = _ACTIVE_CAPABILITIES.set(set())
    try:
        assert "Write" in policy.native_tools
        assert not policy.check("Write", {"file_path": str(tmp_path / "a.txt"), "content": "ok"})["allow"]
        activate_capabilities({"development"})
        assert policy.check("Write", {"file_path": str(tmp_path / "a.txt"), "content": "ok"})["allow"]
    finally:
        _ACTIVE_CAPABILITIES.reset(token)


@pytest.mark.parametrize("status", ["started", "unknown"])
async def test_unconfirmed_native_operation_prevents_context_rebuild(tmp_path, status):
    config = Config()
    config.agents.defaults.executor = "codebuddy"
    provider = NativeWorkProvider(config, tmp_path)
    provider._binding = SimpleNamespace(native_session_id="native-original")
    provider._native_calls["pending"] = {
        "id": "pending", "name": "Write", "status": status, "native_session_id": "native-original"}
    with pytest.raises(RpcError) as error:
        await provider._reset_context()
    assert error.value.code == "native_turn_incomplete" and provider._context_reset_failed


async def test_rebuilt_native_context_contains_completed_native_audit(tmp_path, monkeypatch):
    config = Config()
    config.agents.defaults.executor = "codebuddy"
    config.development.enabled_engines = ["codebuddy"]
    provider = NativeWorkProvider(config, tmp_path)
    provider._native_calls["completed"] = {
        "id": "completed", "name": "Write", "status": "completed", "path": str(tmp_path / "done.txt"),
        "native_session_id": "native-original", "native_turn_id": "original-turn"}
    sent = []
    host = SimpleNamespace(interrupt=AsyncMock(), shutdown=AsyncMock())

    async def create_session(start):
        return SimpleNamespace(native_session_id="native-new")

    async def events(binding):
        await asyncio.Event().wait()
        yield

    async def send(binding, input_id, message):
        sent.extend(message)
        return DispatchReceipt(input_id=input_id, outcome="accepted", native_turn_id="new-turn")

    host.create_session, host.events, host.send = create_session, events, send
    monkeypatch.setattr("mona.providers.native_work_provider.discover_executors", lambda *_: [
        SimpleNamespace(executor=ExecutorId.CODEBUDDY, state="detected", executable="fixture")])
    monkeypatch.setattr("mona.providers.native_work_provider.prepare_sdk_profile", lambda *_args, **_kwargs: object())
    monkeypatch.setattr("mona.providers.native_work_provider.SDKExecutor", lambda *_args, **_kwargs: host)
    try:
        await provider._start([{"role": "user", "content": "continue"}], [], "fixture", None)
        assert any("native-original" in block.get("text", "") and "done.txt" in block.get("text", "") for block in sent)
        assert all("original-turn" not in block.get("text", "") or "completed" in block.get("text", "") for block in sent)
    finally:
        await provider.aclose()


class BusinessSaveTool(WriteFileTool):
    @property
    def name(self):
        return "fixture_business_save"


@pytest.mark.parametrize("executor", ["codex", "claude", "codebuddy"])
async def test_three_engines_execute_native_primitives_and_host_business_tools(tmp_path, monkeypatch, executor):
    root = tmp_path / "work"
    root.mkdir()
    config = Config()
    config.agents.defaults.executor = executor
    config.development.enabled_engines = [executor]
    tools = registry(root)
    tools.get("write_file").execute = AsyncMock(side_effect=AssertionError("Duplicate host primitive dispatched"))
    tools.register(BusinessSaveTool(workspace=root, allowed_dir=root))
    selected = ExecutorId(executor)
    hosts = []
    checkpoints = []

    async def checkpoint(payload):
        checkpoints.append(payload)

    class Host:
        def __init__(self, profile, *, tool_handler):
            self.handler, self.queue = tool_handler, asyncio.Queue()
            self.sent = 0
            hosts.append(self)

        async def create_session(self, start):
            self.start = start
            self.binding = SimpleNamespace(native_session_id=f"native-{executor}")
            assert "fixture_business_save" in start.work_prompt
            assert '"name": "write_file"' not in start.work_prompt
            assert start.work_native_tools
            return self.binding

        async def send(self, binding, input_id, content):
            self.sent += 1
            self.driver = asyncio.create_task(self.run_native())
            return DispatchReceipt(input_id=input_id, outcome="accepted", native_turn_id="turn")

        async def run_native(self):
            name = "apply_patch" if executor == "codex" else "Write"
            arguments = {"grantRoot": str(root)} if executor == "codex" else {
                "file_path": str(root / "native.txt"), "content": "native write"}
            approved = await self.start.work_native_permission("turn", "native-write", name, arguments)
            assert approved["allow"]
            assert checkpoints[-1]["native_work"]["calls"][0]["status"] == "started"
            (root / "native.txt").write_text("native write", encoding="utf8")
            await self.queue.put(NativeEvent(type="tool.completed", payload={"itemId": "native-write"}))
            reply = await self.handler(self.binding, "turn", {"tool": "fixture_business_save", "arguments": {
                "path": str(root / "business.txt"), "content": "host write"}})
            assert reply.get("isError") is False
            await self.queue.put(NativeEvent(type="agent.message.completed", payload={"text": "done"}))
            await self.queue.put(NativeEvent(type="run.completed"))

        async def events(self, binding):
            while True:
                yield await self.queue.get()

        async def shutdown(self):
            await self.driver

    monkeypatch.setattr("mona.providers.native_work_provider.discover_executors", lambda *_: [
        SimpleNamespace(executor=selected, state="detected", executable="fixture-native-program")])
    monkeypatch.setattr("mona.providers.native_work_provider.prepare_sdk_profile", lambda *_args, **_kwargs: object())
    catalog = tmp_path / "catalog.json"
    catalog.write_text("{}")
    from mona.development.executors.codex_policy import CodexProfile

    monkeypatch.setattr("mona.providers.native_work_provider.prepare_codex_work_profile",
                        lambda *_args, **_kwargs: (CodexProfile((), tmp_path / "fixture-home", root, {}), catalog))
    monkeypatch.setattr("mona.providers.native_work_provider.SDKExecutor", Host)
    monkeypatch.setattr("mona.providers.native_work_provider.CodexExecutor", Host)
    async with asyncio.timeout(5):
        result = await AgentRunner(NativeWorkProvider(config, root)).run(AgentRunSpec(
            [{"role": "system", "content": "Mona"}, {"role": "user", "content": "Use both kinds of tools"}],
            tools, "native-fixture", 4, 16000, workspace=root, checkpoint_callback=checkpoint))
    assert result.stop_reason == "completed" and hosts[0].sent == 1
    assert (root / "native.txt").read_text() == "native write"
    assert (root / "business.txt").read_text() == "host write"
    tools.get("write_file").execute.assert_not_called()
    audit = result.messages[-1]["native_work"]
    assert audit["executor"] == executor and audit["status"] == "completed"
    assert audit["calls"][0]["status"] == "completed"
