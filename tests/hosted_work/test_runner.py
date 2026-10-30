"""Use the actual Mona runner, registry, checkpoints and stream hooks with a synthetic LLM."""
import json

import pytest

from mona.config.schema import Config, HostedWorkConfig
from mona.hosted_work.providers import create_provider
from mona.hosted_work.turn import run_turn
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.providers.capabilities import ModelCapabilities
from mona.providers.native_work_provider import NativeWorkProvider


class ModelBoundary(LLMProvider):
    supports_progress_deltas = True

    def __init__(self):
        super().__init__()
        self.requests = []

    def get_default_model(self):
        return "fixture-model"

    def get_capabilities(self, model):
        return ModelCapabilities(supports_tool_calling=True)

    async def chat(self, messages, **kwargs):
        return await self.chat_stream(messages, **kwargs)

    async def chat_stream(self, messages, tools=None, on_content_delta=None, **kwargs):
        self.requests.append((json.loads(json.dumps(messages)), tools))
        if len(self.requests) == 1:
            return LLMResponse(content="", tool_calls=[ToolCallRequest(id="call1", name="write_file",
                arguments={"path": "result.txt", "content": "实际工具写入"})], finish_reason="tool_calls")
        if on_content_delta:
            await on_content_delta("任务完成")
        return LLMResponse(content="任务完成", usage={"prompt_tokens": 10, "completion_tokens": 4})


class SandboxBoundary:
    def __init__(self):
        self.calls = []

    async def file(self, request):
        self.calls.append(request)
        return {"path": request["path"], "name": "result.txt", "size": 18, "sha256": "a" * 64}


@pytest.mark.asyncio
async def test_existing_runner_executes_only_explicit_online_tools():
    config = HostedWorkConfig(models={"official": {"label": "Mona", "model": "fixture-model"}})
    model, sandbox, events = ModelBoundary(), SandboxBoundary(), []
    async def emit(kind, value):
        events.append((kind, value))
    result = await run_turn(config, {"model_id": "official", "run_id": "b" * 32,
        "history": [{"role": "user", "content": "创建一个工作文件"}], "attachments": []}, sandbox, model, emit)
    assert result["status"] == "completed" and result["content"] == "任务完成"
    assert sandbox.calls == [{"action": "write", "path": "result.txt", "content": "实际工具写入", "expected_sha256": None}]
    names = {tool["function"]["name"] for tool in model.requests[0][1]}
    assert names == {"read_file", "write_file", "list_dir", "exec", "web_fetch", "deliver_file"}
    assert model.requests[1][0][0] == model.requests[0][0][0]
    assert any(kind == "checkpoint" and value.get("phase") == "tools_started" for kind, value in events)
    assert any(kind == "history" and any(message.get("role") == "tool" for message in value["messages"]) for kind, value in events)
    assert any(kind == "delta" and value["text"] == "任务完成" for kind, value in events)


@pytest.mark.asyncio
async def test_unknown_command_aborts_without_model_retry():
    class TimedOut(SandboxBoundary):
        async def file(self, request):
            self.calls.append(request)
            raise TimeoutError("not a host fallback")
    config = HostedWorkConfig(models={"official": {"label": "Mona", "model": "fixture-model"}})
    model, sandbox = ModelBoundary(), TimedOut()
    async def emit(kind, value):
        pass
    result = await run_turn(config, {"model_id": "official", "run_id": "b" * 32,
        "history": [{"role": "user", "content": "work"}]}, sandbox, model, emit)
    assert result["status"] == "failed" and len(model.requests) == 1 and len(sandbox.calls) == 1


def test_native_home_override_is_explicit_and_preserves_desktop_default(tmp_path):
    config = Config()
    config.agents.defaults.executor = "codex"
    desktop = NativeWorkProvider(config, tmp_path / "desktop")
    assert desktop._native_home is None and desktop.for_turn(None)._native_home is None
    hosted = NativeWorkProvider(config, tmp_path / "empty", native_home=tmp_path / "platform-native")
    assert hosted.for_turn(None)._native_home == (tmp_path / "platform-native").resolve()


def test_online_native_config_does_not_change_global_data_root(tmp_path, monkeypatch):
    from mona.config import loader
    private_config = tmp_path / "isolated" / "config.json"
    monkeypatch.setattr(loader, "_current_config_path", private_config)
    operator_config = tmp_path / "operator" / "config.json"
    operator_config.parent.mkdir()
    operator_config.write_text(Config().model_dump_json(), encoding="utf-8")
    config = HostedWorkConfig(models={"native": {"label": "Platform GPT", "model": "configured-model", "source": "codex",
                                               "native_config_path": str(operator_config)}})
    provider = create_provider(config, config.models["native"], tmp_path / "empty")
    assert loader.get_config_path() == private_config
    assert provider._native_home == operator_config.parent / "development" / "native" / "codex"
    assert provider._CHAT_RETRY_DELAYS == ()
