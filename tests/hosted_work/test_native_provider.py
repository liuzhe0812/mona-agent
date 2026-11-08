"""The hosted native adapter keeps workspace operations in Mona's sandbox."""

import asyncio
import copy
from types import SimpleNamespace

import pytest

from mona.agent.tools.registry import ToolRegistry
from mona.config.schema import Config
from mona.development.contracts import ExecutorId
from mona.development.executors.host_tools import WORK_TOOL
from mona.development.executors.rpc import RpcError
from mona.hosted_work.native_provider import HostedNativeWorkProvider
from mona.hosted_work.tools import HostedTool
from mona.providers.base import LLMResponse, ToolCallRequest
from mona.providers.native_work_provider import NativeWorkProvider


def test_codex_factory_reuses_hosted_adapter_when_private_admission_is_allowed(tmp_path, monkeypatch):
    from mona.config.schema import HostedCodexSettings, HostedWorkConfig, HostedWorkModel
    from mona.hosted_work import providers
    from mona.hosted_work.admin import CodexAdmin

    config_path = tmp_path / "operator.json"
    config_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(providers, "require_model_available", lambda _model, _config, *, billing_authorized=False: None)
    native_home = tmp_path / "development/native/codex"
    executable = tmp_path / "codex"
    seen = []

    def profile(admin, settings):
        seen.append((admin.path, settings))
        return SimpleNamespace(command=[str(executable)], home=native_home)

    monkeypatch.setattr(CodexAdmin, "profile", profile)
    codex = HostedCodexSettings(cli_path=str(executable))
    selection = HostedWorkModel(label="Codex", source="codex", model="test-model",
                                native_config_path=str(tmp_path / "ignored.json"), billing_mode="wallet")
    result = providers.create_provider(HostedWorkConfig(operator_config_path=str(config_path), codex=codex),
                                       selection, tmp_path)
    assert isinstance(result, HostedNativeWorkProvider)
    assert result.config.agents.defaults.native_model == "test-model"
    assert result.config.development.codex_path == str(executable)
    assert result._native_home == native_home.resolve()
    assert seen == [(config_path.resolve(), codex)]


def test_codex_proxy_is_scoped_to_its_own_turn(monkeypatch):
    from mona.config.schema import HostedCodexSettings, HostedWorkConfig, HostedWorkModel
    from mona.hosted_work.executor import child_environment

    monkeypatch.setenv("HTTP_PROXY", "http://untrusted-proxy")
    config = HostedWorkConfig(codex=HostedCodexSettings(local_proxy_url="http://127.0.0.1:7897"), models={
        "codex": HostedWorkModel(label="Codex", source="codex", model="codex-test"),
        "api": HostedWorkModel(label="API", source="mona", model="api-test", billing_mode="free"),
    })
    env = child_environment(config, {"action": "turn", "model_id": "codex"})
    assert all(env[key] == "http://127.0.0.1:7897" for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"))
    assert "HTTP_PROXY" not in child_environment(config, {"action": "turn", "model_id": "api"})
    assert "HTTP_PROXY" not in child_environment(config, {"action": "upload"})


def provider(tmp_path):
    config = Config()
    config.agents.defaults.executor = "codex"
    config.development.enabled_engines = ["codex"]
    return HostedNativeWorkProvider(config, tmp_path, native_home=tmp_path / "native-home")


def definition(name, *, flat=False):
    function = {
        "name": name,
        "description": "test tool",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
    }
    return function if flat else {"type": "function", "function": function}


@pytest.mark.asyncio
async def test_basic_tool_aliases_round_trip_without_mutating_schemas(tmp_path, monkeypatch):
    hosted = provider(tmp_path)
    tools = [definition("read_file"), definition("write_file", flat=True), definition("skill_read")]
    original = copy.deepcopy(tools)
    captured = {}

    async def chat(_self, messages, definitions, model, effort, on_content_delta, on_thinking_delta):
        captured.update(messages=messages, definitions=definitions, model=model, effort=effort,
                        content_callback=on_content_delta, thinking_callback=on_thinking_delta)
        return LLMResponse(
            content=None,
            finish_reason="tool_calls",
            tool_calls=[ToolCallRequest("1", "hosted_read_file", {"path": "one"}),
                        ToolCallRequest("2", "hosted_write_file", {"path": "two"}),
                        ToolCallRequest("3", "skill_read", {"path": "three"}),
                        ToolCallRequest("4", "hosted_exec", {})],
        )

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    messages = [{"role": "user", "content": "test"}]
    content_callback, thinking_callback = object(), object()
    result = await hosted._chat(messages, tools, "model", "low", content_callback, thinking_callback)

    assert tools == original
    assert captured["definitions"] == [
        definition("hosted_read_file"), definition("hosted_write_file", flat=True), definition("skill_read")
    ]
    assert captured["messages"] is messages
    assert (captured["model"], captured["effort"]) == ("model", "low")
    assert captured["content_callback"] is content_callback
    assert captured["thinking_callback"] is thinking_callback
    assert [(call.name, call.arguments) for call in result.tool_calls] == [
        ("read_file", {"path": "one"}), ("write_file", {"path": "two"}),
        ("skill_read", {"path": "three"}), ("hosted_exec", {}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("reverse", [False, True])
async def test_conflicting_visible_alias_is_rejected_before_model_call(tmp_path, monkeypatch, reverse):
    hosted = provider(tmp_path)
    called = False

    async def chat(*_args, **_kwargs):
        nonlocal called
        called = True

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    tools = [definition("read_file"), definition("hosted_read_file", flat=True)]
    if reverse:
        tools.reverse()
    original = copy.deepcopy(tools)
    with pytest.raises(RpcError) as exc:
        await hosted._chat([], tools, "model", None)
    assert exc.value.code == "native_policy_unavailable"
    assert tools == original
    assert called is False


@pytest.mark.asyncio
async def test_only_currently_visible_tools_can_be_resolved_from_aliases(tmp_path, monkeypatch):
    hosted = provider(tmp_path)
    registry = ToolRegistry()
    for name in ("read_file", "write_file", "exec"):
        registry.register(HostedTool(name, name, {}, [], lambda: None))
    registry.get("write_file").model_visible = False
    registry.get("exec").is_available = False
    hosted.bind_runtime(registry)
    names_seen = []

    async def chat(_self, _messages, definitions, *_args):
        names_seen.append([item["function"]["name"] for item in definitions])
        return LLMResponse(content=None, finish_reason="tool_calls", tool_calls=[
            ToolCallRequest("1", "hosted_read_file", {}),
            ToolCallRequest("2", "hosted_write_file", {}),
            ToolCallRequest("3", "hosted_exec", {}),
            ToolCallRequest("4", "hosted_unknown", {}),
        ])

    monkeypatch.setattr(NativeWorkProvider, "_chat", chat)
    first = await hosted._chat([], registry.get_definitions(), "model", None)
    assert names_seen[-1] == ["hosted_read_file"]
    assert [call.name for call in first.tool_calls] == [
        "read_file", "hosted_write_file", "hosted_exec", "hosted_unknown"
    ]

    registry.set_allowed_tool_names(set())
    second = await hosted._chat([], registry.get_definitions(), "model", None)
    assert names_seen[-1] == []
    assert [call.name for call in second.tool_calls] == [
        "hosted_read_file", "hosted_write_file", "hosted_exec", "hosted_unknown"
    ]


@pytest.mark.asyncio
async def test_hosted_start_uses_no_native_tools_and_prompt_matches_definitions(tmp_path, monkeypatch):
    from mona.providers import native_work_provider as native

    hosted = provider(tmp_path)
    registry = ToolRegistry()
    registry.register(HostedTool("exec", "sandboxed command", {}, [], lambda: None))
    registry.register(HostedTool("read_file", "sandboxed read", {}, [], lambda: None))
    hosted.bind_runtime(registry)
    assert hosted._validate_native_policy() == ()
    captured = {}

    def prepare(_exe, _home, _root, *, native_tools=()):
        captured["profile_native_tools"] = native_tools
        return object(), tmp_path / "unused-catalog.json"

    class FakeExecutor:
        def __init__(self, _profile, *, tool_handler):
            captured["tool_handler"] = tool_handler

        async def create_session(self, start):
            captured["start"] = start
            return SimpleNamespace(native_session_id="private-session")

        async def events(self, _binding):
            await asyncio.Event().wait()
            yield None

        async def send(self, _binding, _identifier, _history):
            return SimpleNamespace(outcome="accepted", native_turn_id="private-turn")

        async def interrupt(self, _binding, *, native_turn_id=None):
            assert native_turn_id == "private-turn"
            return SimpleNamespace(outcome="confirmed")

        async def shutdown(self):
            captured["shutdown"] = True

    monkeypatch.setattr(native, "discover_executors", lambda _config: [
        SimpleNamespace(executor=ExecutorId.CODEX, state="detected", executable="test-executable")
    ])
    monkeypatch.setattr(native, "prepare_codex_work_profile", prepare)
    monkeypatch.setattr(native, "CodexExecutor", FakeExecutor)
    if hasattr(native, "cleanup_codex_work_profile"):
        monkeypatch.setattr(native, "cleanup_codex_work_profile", lambda _profile: None)
    definitions = [definition("hosted_read_file"), definition("hosted_exec")]
    try:
        await hosted._start([{"role": "system", "content": "MONA_PERSONALITY"}], definitions, "model", None)
        start = captured["start"]
        assert captured["profile_native_tools"] == ()
        assert start.work_native_tools == ()
        assert "MONA_PERSONALITY" in start.work_prompt
        assert WORK_TOOL in start.work_prompt
        assert "hosted_read_file" in start.work_prompt and "hosted_exec" in start.work_prompt
        assert "使用当前引擎提供的原生工具" not in start.work_prompt
        assert (await hosted._native_permission("private-turn", "item", "exec_command", {}))["allow"] is False
    finally:
        await hosted.aclose()
    assert captured["shutdown"] is True


@pytest.mark.asyncio
async def test_hosted_tool_call_round_trips_through_shared_provider(tmp_path, monkeypatch):
    from mona.providers import native_work_provider as native

    hosted = provider(tmp_path)
    registry = ToolRegistry()
    registry.register(HostedTool("read_file", "sandboxed read", {}, [], lambda: None))
    hosted.bind_runtime(registry)
    observed = {}

    class FakeExecutor:
        def __init__(self, _profile, *, tool_handler):
            self.tool_handler = tool_handler
            self.queue = asyncio.Queue()
            self.pending = None

        async def create_session(self, start):
            observed["start"] = start
            return SimpleNamespace(native_session_id="private-session")

        async def events(self, _binding):
            while True:
                yield await self.queue.get()

        async def send(self, binding, _identifier, _history):
            async def request_file():
                observed["tool_reply"] = await self.tool_handler(
                    binding, "private-turn", {"tool": "hosted_read_file", "arguments": {"path": "a.txt"}}
                )
                await self.queue.put(SimpleNamespace(
                    type="agent.message.delta", payload={"itemId": "answer", "delta": "done"}
                ))
                await self.queue.put(SimpleNamespace(type="run.completed", payload={}))

            self.pending = asyncio.create_task(request_file())
            return SimpleNamespace(outcome="accepted", native_turn_id="private-turn")

        async def interrupt(self, _binding):
            pass

        async def shutdown(self):
            if self.pending:
                if not self.pending.done():
                    self.pending.cancel()
                await asyncio.gather(self.pending, return_exceptions=True)

    monkeypatch.setattr(native, "discover_executors", lambda _config: [
        SimpleNamespace(executor=ExecutorId.CODEX, state="detected", executable="test-executable")
    ])
    monkeypatch.setattr(native, "prepare_codex_work_profile", lambda *_args, **_kwargs: (
        object(), tmp_path / "unused-catalog.json"
    ))
    monkeypatch.setattr(native, "CodexExecutor", FakeExecutor)
    if hasattr(native, "cleanup_codex_work_profile"):
        monkeypatch.setattr(native, "cleanup_codex_work_profile", lambda _profile: None)
    history = [{"role": "system", "content": "MONA_PERSONALITY"}, {"role": "user", "content": "read a"}]
    tools = registry.get_definitions()
    chunks = []

    async def on_content_delta(chunk):
        chunks.append(chunk)

    try:
        async with asyncio.timeout(3):
            first = await hosted.chat_stream(history, tools, "model", on_content_delta=on_content_delta)
            assert first.finish_reason == "tool_calls"
            assert len(first.tool_calls) == 1
            call = first.tool_calls[0]
            assert (call.name, call.arguments) == ("read_file", {"path": "a.txt"})
            assert observed["start"].work_native_tools == ()
            assert "hosted_read_file" in observed["start"].work_prompt
            history = [*history, {"role": "assistant", "content": None,
                                  "tool_calls": [call.to_openai_tool_call()]},
                       {"role": "tool", "tool_call_id": call.id, "content": "sandbox result"}]
            result = await hosted.chat_stream(history, tools, "model", on_content_delta=on_content_delta)
            assert result.finish_reason == "stop" and result.content == "done"
            assert chunks == ["done"]
            assert observed["tool_reply"] == {
                "content": [{"type": "text", "text": "sandbox result"}], "isError": False
            }
    finally:
        await hosted.aclose()


def test_for_turn_retains_hosted_adapter_and_native_home(tmp_path):
    hosted = provider(tmp_path)
    hosted.generation = object()
    hosted._CHAT_RETRY_DELAYS = ()
    child = hosted.for_turn(tmp_path / "other-workspace")
    assert isinstance(child, HostedNativeWorkProvider)
    assert child.config is hosted.config
    assert child.workspace == (tmp_path / "other-workspace").resolve()
    assert child._native_home == hosted._native_home
    assert child.generation is hosted.generation
    assert child._CHAT_RETRY_DELAYS == ()
