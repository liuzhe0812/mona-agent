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
            return LLMResponse(content="", tool_calls=[ToolCallRequest(id="load", name="load_capability",
                arguments={"capabilities": ["development"]})], finish_reason="tool_calls")
        if len(self.requests) == 2:
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
async def test_existing_runner_executes_only_explicit_online_tools(monkeypatch):
    from mona.agent.runner import AgentRunner

    original_run = AgentRunner.run
    async def check_spec(self, spec):
        assert spec.llm_timeout_s is None and not spec.enforce_llm_timeout_for_streaming
        return await original_run(self, spec)
    monkeypatch.setattr(AgentRunner, "run", check_spec)
    config = HostedWorkConfig(run_timeout_seconds=45, models={"official": {"label": "Mona", "model": "fixture-model"}})
    model, sandbox, events = ModelBoundary(), SandboxBoundary(), []
    async def emit(kind, value):
        events.append((kind, value))
    result = await run_turn(config, {"model_id": "official", "run_id": "b" * 32,
        "history": [{"role": "user", "content": "创建一个工作文件"}], "attachments": []}, sandbox, model, emit)
    assert result["status"] == "completed" and result["content"] == "任务完成"
    assert sandbox.calls == [{"action": "write", "path": "result.txt", "content": "实际工具写入", "expected_sha256": None}]
    names = {tool["function"]["name"] for tool in model.requests[0][1]}
    assert names == {"read_file", "list_dir", "web_fetch", "web_search", "deliver_file", "skill_list", "skill_read",
                     "load_capability", "update_plan", "spawn"}
    assert {"write_file", "exec"} <= {tool["function"]["name"] for tool in model.requests[1][1]}
    assert all(request[0][0] == model.requests[0][0][0] for request in model.requests)
    assert any(kind == "checkpoint" and value.get("phase") == "tools_started" for kind, value in events)
    assert any(kind == "history" and any(message.get("role") == "tool" for message in value["messages"]) for kind, value in events)
    assert any(kind == "delta" and value["text"] == "任务完成" for kind, value in events)


@pytest.mark.asyncio
async def test_skill_read_exposes_resources_without_changing_the_turn_system_prompt():
    class SkillsModel(ModelBoundary):
        async def chat_stream(self, messages, tools=None, **kwargs):
            self.requests.append((json.loads(json.dumps(messages)), tools))
            if len(self.requests) == 1:
                return LLMResponse(content="", tool_calls=[ToolCallRequest(id="read-skill", name="skill_read",
                    arguments={"name": "mona-xlsx"})], finish_reason="tool_calls")
            if len(self.requests) == 2:
                assert "skill_reference_read" in {tool["function"]["name"] for tool in tools}
                return LLMResponse(content="", tool_calls=[ToolCallRequest(id="read-reference", name="skill_reference_read",
                    arguments={"skill": "mona-xlsx", "ref_path": "office-example.md"})], finish_reason="tool_calls")
            return LLMResponse(content="已读取技能与参考资料。")

    config = HostedWorkConfig(models={"official": {"label": "Mona", "model": "fixture-model"}})
    model, events = SkillsModel(), []
    async def emit(kind, value):
        events.append((kind, value))
    result = await run_turn(config, {"model_id": "official", "run_id": "c" * 32,
        "history": [{"role": "user", "content": "读取表格技能"}]}, SandboxBoundary(), model, emit)
    assert result["status"] == "completed" and len(model.requests) == 3
    assert all(request[0][0] == model.requests[0][0][0] for request in model.requests)
    assert any(kind == "progress" and "mona-xlsx" in value.get("message", "") for kind, value in events)


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
    assert result["status"] == "failed" and len(model.requests) == 2 and len(sandbox.calls) == 1


@pytest.mark.asyncio
async def test_normal_iteration_limit_keeps_history_and_clears_only_the_recovery_checkpoint():
    from mona.config.schema import AgentDefaults

    assert HostedWorkConfig().max_iterations == AgentDefaults().max_tool_iterations
    config = HostedWorkConfig(max_iterations=2, models={"official": {"label": "Mona", "model": "fixture-model"}})
    events = []
    async def emit(kind, value):
        events.append((kind, value))
    result = await run_turn(config, {"model_id": "official", "run_id": "f" * 32,
        "history": [{"role": "user", "content": "创建文件"}]}, SandboxBoundary(), ModelBoundary(), emit)
    assert result["status"] == "failed" and result["diagnostic"]["stop_reason"] == "max_iterations"
    assert [value for kind, value in events if kind == "checkpoint"][-1] == {}
    history = [value["messages"] for kind, value in events if kind == "history"][-1]
    assert sum(message.get("tool_call_id") == "call1" for message in history) == 1


@pytest.mark.asyncio
async def test_initial_image_uses_verified_bytes_and_keeps_empty_original_text():
    import base64
    import hashlib

    raw = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5m8AAAAASUVORK5CYII=")
    attachment = {"path": "uploads/fixture/image.png", "name": "image.png", "size": len(raw),
                  "sha256": hashlib.sha256(raw).hexdigest()}

    class ImageSandbox:
        async def file(self, request):
            assert request["path"] == attachment["path"]
            return {**attachment, **({"data": base64.b64encode(raw).decode()} if request["action"] == "download" else {})}

    class VisionModel(ModelBoundary):
        def get_capabilities(self, model):
            return ModelCapabilities(supports_tool_calling=True, supports_vision=True)

        async def chat_stream(self, messages, **_kwargs):
            blocks = messages[-1]["content"]
            assert isinstance(blocks, list) and blocks[0]["type"] == "image_url"
            assert base64.b64decode(blocks[0]["image_url"]["url"].split(",", 1)[1]) == raw
            return LLMResponse(content="图像已收到。")

    events = []
    async def emit(kind, value):
        events.append((kind, value))
    config = HostedWorkConfig(models={"vision": {"label": "Vision fixture", "model": "fixture-model"}})
    result = await run_turn(config, {"model_id": "vision", "run_id": "e" * 32,
        "history": [{"role": "user", "content": "", "timestamp": "2026-11-06T01:00:00Z"}],
        "attachments": [attachment]}, ImageSandbox(), VisionModel(), emit)
    assert result["status"] == "completed"
    saved = [value["messages"] for kind, value in events if kind == "history"][-1]
    assert saved[0]["content"] == "" and saved[-1]["content"] == "图像已收到。"


def test_native_home_override_is_explicit_and_preserves_desktop_default(tmp_path):
    config = Config()
    config.agents.defaults.executor = "codex"
    desktop = NativeWorkProvider(config, tmp_path / "desktop")
    assert desktop._native_home is None and desktop.for_turn(None)._native_home is None
    hosted = NativeWorkProvider(config, tmp_path / "empty", native_home=tmp_path / "platform-native")
    assert hosted.for_turn(None)._native_home == (tmp_path / "platform-native").resolve()


def test_closed_native_provider_does_not_change_global_data_root(tmp_path, monkeypatch):
    from mona.config import loader
    private_config = tmp_path / "isolated" / "config.json"
    monkeypatch.setattr(loader, "_current_config_path", private_config)
    operator_config = tmp_path / "operator" / "config.json"
    operator_config.parent.mkdir()
    operator_config.write_text(Config().model_dump_json(), encoding="utf-8")
    config = HostedWorkConfig(models={"native": {"label": "Platform GPT", "model": "configured-model", "source": "codex",
                                               "native_config_path": str(operator_config)}})
    from mona.hosted_work.contracts import WorkError
    with pytest.raises(WorkError) as error:
        create_provider(config, config.models["native"], tmp_path / "empty")
    assert error.value.code == "provider_unavailable"
    assert loader.get_config_path() == private_config
