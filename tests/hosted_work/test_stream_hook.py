"""Hosted Work adapts the desktop lifecycle without inventing progress or outcomes."""
import json

import pytest

from mona.agent.hook import AgentHookContext
from mona.agent.progress_hook import AgentProgressHook
from mona.config.schema import HostedWorkConfig
from mona.hosted_work.turn import WorkHook, run_turn
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.providers.capabilities import ModelCapabilities


@pytest.mark.asyncio
async def test_hook_reuses_desktop_reasoning_and_streams_short_answers_immediately():
    events, authorizations = [], []

    async def emit(kind, value):
        events.append((kind, value))

    async def authorize():
        authorizations.append(True)

    hook = WorkHook(emit, authorize)
    assert isinstance(hook, AgentProgressHook) and hook.wants_streaming()
    context = AgentHookContext(iteration=2, messages=[])
    await hook.before_iteration(context)
    assert authorizations == [True] and events == []

    await hook.emit_reasoning("先核对结果。")
    await hook.on_stream(context, "好的")
    # Two characters must already be visible, without waiting for 256 bytes or end-of-stream.
    assert [(kind, value.get("kind"), value.get("text")) for kind, value in events] == [
        ("progress", "reasoning_delta", "先核对结果。"),
        ("progress", "reasoning_end", ""),
        ("delta", None, "好的"),
    ]
    await hook.on_stream_end(context, resuming=False)
    assert len(events) == 3


@pytest.mark.asyncio
async def test_tool_events_retain_call_identity_and_never_duplicate_private_results():
    events = []
    async def emit(kind, value):
        events.append((kind, value))

    calls = [
        ToolCallRequest(id="call-private", name="browser_type",
                        arguments={"text": "synthetic-private-text", "selector": "#query"}),
        ToolCallRequest(id="call-write", name="write_file",
                        arguments={"path": "report.txt", "content": "synthetic-large-content-" * 1000}),
    ]
    context = AgentHookContext(iteration=1, messages=[], tool_calls=calls,
        tool_results=["synthetic-raw-error-and-key", "synthetic-large-result-" * 5000],
        tool_events=[{"status": "error"}, {"status": "ok"}])
    hook = WorkHook(emit)
    await hook.before_execute_tools(context)
    await hook.after_iteration(context)

    progress = [value for kind, value in events if kind == "progress" and value.get("tool_events")]
    assert [value["kind"] for value in progress] == ["tool_hint", "progress"]
    start, finish = (value["tool_events"] for value in progress)
    assert [(event["call_id"], event["phase"]) for event in start] == [
        ("call-private", "start"), ("call-write", "start")]
    assert [(event["call_id"], event["phase"]) for event in finish] == [
        ("call-private", "error"), ("call-write", "end")]
    assert start[0]["arguments"]["text"] == "<redacted>"
    assert start[1]["arguments"]["path"] == "report.txt"
    public = json.dumps(progress, ensure_ascii=False)
    for private in ("synthetic-private-text", "synthetic-raw-error-and-key", "synthetic-large-content-", "synthetic-large-result-"):
        assert private not in public
    assert finish[0].get("error") and "synthetic-raw-error" not in finish[0]["error"]


@pytest.mark.asyncio
async def test_widget_completion_is_forwarded_once_without_streaming_or_code_in_tool_events():
    events = []
    async def emit(kind, value):
        events.append((kind, value))

    code = '<svg viewBox="0 0 680 80"><text x="10" y="30">fixture</text></svg>'
    call = ToolCallRequest(id="widget-id", name="show_widget",
                           arguments={"title": "图形", "widget_code": code, "loading_messages": []})
    result = json.dumps({"type": "visualizer_show_widget_result", "success": True,
                         "title": "图形", "widget_code": code, "loading_messages": []})
    context = AgentHookContext(iteration=0, messages=[], tool_calls=[call],
                               tool_results=[result], tool_events=[{"status": "ok"}])
    hook = WorkHook(emit)
    await hook.before_execute_tools(context)
    assert not [value for kind, value in events if kind == "widget"]
    await hook.after_iteration(context)
    widgets = [value for kind, value in events if kind == "widget"]
    assert len(widgets) == 1
    assert widgets[0]["id"] == "widget-id" and widgets[0]["status"] == "complete" and widgets[0]["code"] == code
    assert not any(event.get("name") == "show_widget" for kind, value in events if kind == "progress"
                   for event in value.get("tool_events", []))


class ContextLimitModel(LLMProvider):
    def __init__(self):
        super().__init__()
        self.requests = 0

    def get_default_model(self):
        return "fixture-model"

    def get_capabilities(self, model):
        return ModelCapabilities(supports_tool_calling=True)

    async def chat(self, messages, **kwargs):
        return await self.chat_stream(messages, **kwargs)

    async def chat_stream(self, messages, **kwargs):
        self.requests += 1
        assert self.requests == 1, "the already-executed file read must not be replayed"
        return LLMResponse(content="", tool_calls=[ToolCallRequest(id="read-call", name="read_file",
            arguments={"path": "large.txt"})], finish_reason="tool_calls")


class LargeFileSandbox:
    def __init__(self):
        self.requests = []

    async def file(self, request):
        self.requests.append(request)
        return {"path": "large.txt", "content": "synthetic-secret-key-" + "z" * 90000}


@pytest.mark.asyncio
async def test_real_runner_reports_context_limit_without_leaking_private_diagnostics():
    config = HostedWorkConfig(models={"qwen": {"label": "Qwen", "model": "fixture-model",
                                              "context_window_tokens": 4096, "max_output_tokens": 256}})
    model, sandbox, events = ContextLimitModel(), LargeFileSandbox(), []
    async def emit(kind, value):
        events.append((kind, value))

    result = await run_turn(config, {"model_id": "qwen", "run_id": "b" * 32,
        "history": [{"role": "user", "content": "读取文件并整理"}], "attachments": []}, sandbox, model, emit)
    assert result["status"] == "failed" and result["diagnostic"]["stop_reason"] == "context_limit"
    assert "上下文" in result["message"] and "保留" in result["message"]
    assert "synthetic-secret-key" not in json.dumps(result, ensure_ascii=False)
    assert model.requests == 1 and len(sandbox.requests) == 1
    public = json.dumps([value for kind, value in events if kind == "progress"], ensure_ascii=False)
    assert "synthetic-secret-key" not in public and "正在处理任务" not in public


@pytest.mark.asyncio
async def test_failed_provider_response_does_not_expose_raw_error_or_key():
    class ErrorModel(ContextLimitModel):
        async def chat_stream(self, messages, **kwargs):
            self.requests += 1
            return LLMResponse(content="synthetic-provider-error api_key=synthetic-provider-key", finish_reason="error",
                               error_status_code=401, error_should_retry=False)

    config = HostedWorkConfig(models={"qwen": {"label": "Qwen", "model": "fixture-model"}})
    model, events = ErrorModel(), []
    async def emit(kind, value):
        events.append((kind, value))

    result = await run_turn(config, {"model_id": "qwen", "run_id": "c" * 32,
        "history": [{"role": "user", "content": "你好"}], "attachments": []}, LargeFileSandbox(), model, emit)
    assert result["status"] == "failed" and model.requests == 1
    public = json.dumps(result, ensure_ascii=False)
    assert "synthetic-provider-error" not in public and "synthetic-provider-key" not in public
    assert result["message"] and result["diagnostic"]["stop_reason"] == "error"
