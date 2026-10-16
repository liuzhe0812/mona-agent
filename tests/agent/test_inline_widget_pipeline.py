"""Exercise the Work visualizer through the runner, channel and durable replay."""

import asyncio
import json
from types import SimpleNamespace

from mona.agent.progress_hook import AgentProgressHook
from mona.agent.runner import AgentRunner, AgentRunSpec
from mona.agent.tools.context import RequestContext
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.visualizer import ShowWidgetTool
from mona.bus.events import InboundMessage
from mona.bus.queue import MessageBus
from mona.channels.websocket import WebSocketChannel
from mona.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from mona.session.webui_turns import build_bus_progress_callback
from mona.utils.widget_events import StreamingWidgetTracker, widget_event
from mona.webui.transcript import read_transcript_lines, replay_transcript_to_ui_messages

SVG = '<svg viewBox="0 0 680 220"><text x="40" y="60" class="t">聊天图形</text></svg>'


class WidgetProvider(LLMProvider):
    def __init__(self, code):
        super().__init__()
        self.code = code
        self.rounds = 0

    def get_default_model(self):
        return "widget-test"

    async def chat(self, **kwargs):
        return await self.chat_stream(**kwargs)

    async def chat_stream(self, on_content_delta=None, on_tool_call_delta=None, **kwargs):
        self.rounds += 1
        if self.rounds > 1:
            if on_content_delta:
                await on_content_delta("图形说明。")
            return LLMResponse(content="图形说明。")
        args = {"title": "聊天图形", "widget_code": self.code, "loading_messages": ["正在绘制"]}
        encoded = json.dumps(args, ensure_ascii=True)
        if on_tool_call_delta:
            await on_tool_call_delta({
                "index": 0, "call_id": "widget-1", "name": "show_widget",
                "arguments_delta": encoded[:70],
            })
            await on_tool_call_delta({"index": 0, "arguments_delta": encoded[70:]})
        return LLMResponse(content=None, tool_calls=[ToolCallRequest("widget-1", "show_widget", args)])


def widget_registry():
    tool = ShowWidgetTool()
    tool.set_context(RequestContext(channel="websocket", chat_id="chat"))
    registry = ToolRegistry()
    registry.register(tool)
    return registry


def test_real_runner_preserves_widget_outside_model_tool_result_budget(tmp_path):
    events = []
    code = SVG.replace("</svg>", "<!--" + "数据" * 18000 + "--></svg>")

    async def progress(content, *, widget_events=None, **kwargs):
        events.extend(widget_events or [])

    async def run():
        result = await AgentRunner(WidgetProvider(code)).run(AgentRunSpec(
            initial_messages=[{"role": "user", "content": "用图解释流程"}],
            tools=widget_registry(), model="widget-test", max_iterations=3,
            max_tool_result_chars=1024, workspace=tmp_path, session_key="websocket:test",
            hook=AgentProgressHook(progress, on_stream=lambda value: progress(value)),
            progress_callback=progress,
        ))
        assert result.final_content == "图形说明。"

    asyncio.run(run())
    assert events[0]["status"] == "streaming"
    assert events[-1]["status"] == "complete"
    assert events[-1]["code"] == code
    assert {event["id"] for event in events} == {"widget-1"}


def test_invalid_widget_is_reported_as_failed_not_executable(tmp_path):
    events = []

    async def progress(content, *, widget_events=None, **kwargs):
        events.extend(widget_events or [])

    asyncio.run(AgentRunner(WidgetProvider("<form>invalid</form>")).run(AgentRunSpec(
        initial_messages=[{"role": "user", "content": "展示图形"}], tools=widget_registry(),
        model="widget-test", max_iterations=3, max_tool_result_chars=4000, workspace=tmp_path,
        hook=AgentProgressHook(progress, on_stream=lambda value: progress(value)), progress_callback=progress,
    )))
    assert events[-1]["status"] == "error"
    assert events[-1]["error"]


def test_streamed_json_escapes_and_surrogates_are_assembled_safely():
    events = []
    registry = widget_registry()

    async def run():
        async def emit(values):
            events.extend(values)

        tracker = StreamingWidgetTracker(tools=registry, emit=emit)
        await tracker.update({"index": 0, "call_id": "escape", "name": "show_widget",
                              "arguments_delta": '{"title":"流程","widget_code":"<div>\\uD83D'})
        # Force the next piece through the normal preview interval without a sleep.
        tracker._states["0"]["last_emit"] = 0
        await tracker.update({"index": 0, "arguments_delta": '\\uDE00\\n完整</div>"}'})

    asyncio.run(run())
    assert events[-1]["code"] == "<div>😀\n完整</div>"
    json.dumps(events, ensure_ascii=False).encode("utf-8")


def test_channel_persists_complete_large_widget_and_replays_once(tmp_path, monkeypatch):
    import mona.webui.transcript as transcript

    monkeypatch.setattr(transcript, "get_webui_dir", lambda: tmp_path)
    code = "<div>" + "图表数据" * 18000 + "</div>"
    call = SimpleNamespace(id="large-widget", arguments={
        "title": "大型图形", "widget_code": code, "loading_messages": ["正在绘制"],
    })
    preview = widget_event(call)
    complete = widget_event(call, {"type": "visualizer_show_widget_result", "success": True,
                                   **call.arguments}, status="complete")
    sent = []

    class Connection:
        async def send(self, value):
            sent.append(json.loads(value))

    async def run():
        bus = MessageBus()
        channel = WebSocketChannel({}, bus)
        channel._subs["chat"] = {Connection()}
        callback = build_bus_progress_callback(bus, InboundMessage(
            channel="websocket", chat_id="chat", sender_id="user", content="说明架构",
            metadata={"task_id": "task-1"},
        ))
        for event in (preview, complete):
            await callback("", widget_events=[event])
            await channel.send(await bus.consume_outbound())

    asyncio.run(run())
    assert len(sent) == 2
    assert sent[-1]["widget"]["code"] == code
    records = read_transcript_lines("websocket:chat", compact_tool_events=True)
    assert len(records) == 1
    assert records[0]["event"] == "widget"
    replayed = replay_transcript_to_ui_messages(records + records)
    assert len(replayed) == 1
    assert replayed[0]["kind"] == "widget"
    assert replayed[0]["widget"]["code"] == code
    assert replayed[0]["id"] == "widget:task-1:large-widget"


def test_visualizer_remains_available_with_old_work_permissions_and_is_excluded_from_code(tmp_path):
    from mona.agent.partners import AgentDefinition
    from mona.agent.tools.context import ToolContext
    from mona.agent.tools.loader import ToolLoader
    from mona.agent.user_config import AgentUserConfig, resolve_effective_agent_config
    from mona.config.schema import ToolsConfig

    effective = resolve_effective_agent_config(
        AgentDefinition(id="mona", display_name="Mona"),
        AgentUserConfig(granted_tools=["read_file"]),
    )
    assert {"read_me", "show_widget"} <= set(effective.allowed_tools)
    loader = ToolLoader()
    ctx = ToolContext(config=ToolsConfig(), workspace=str(tmp_path))
    work = ToolRegistry()
    names = loader.load(ctx, work, scope="core", tool_allowlist={"read_me", "show_widget"})
    assert set(names) == {"read_me", "show_widget"}
    work.set_allowed_tool_names(set(effective.allowed_tools))
    for name in names:
        work.get(name).set_context(RequestContext(channel="websocket", chat_id="chat"))
    assert work.is_visible("show_widget")
    work.get("show_widget").set_context(RequestContext(channel="development", chat_id="code"))
    assert not work.is_visible("show_widget")
    code = ToolRegistry()
    assert loader.load(ctx, code, scope="coding", tool_allowlist={"read_me", "show_widget"}) == []


def test_widget_theme_is_runtime_metadata_and_does_not_change_system_prompt(tmp_path):
    from mona.agent.context import ContextBuilder

    builder = ContextBuilder(tmp_path)
    light = builder.build_messages(history=[], current_message="说明架构", channel="websocket", chat_id="chat",
                                   message_metadata={"ui_theme": "light"})
    dark = builder.build_messages(history=[], current_message="说明架构", channel="websocket", chat_id="chat",
                                  message_metadata={"ui_theme": "dark"})
    assert light[0] == dark[0]
    assert "Current UI Theme: light" in light[-1]["content"]
    assert "Current UI Theme: dark" in dark[-1]["content"]


def test_work_visualizer_prompt_is_injected_verbatim_only_for_visible_work_tools(tmp_path):
    import hashlib
    from pathlib import Path

    from mona.agent.context import ContextBuilder
    from mona.agent.tools.context import RequestContext, ToolContext
    from mona.agent.tools.loader import ToolLoader
    from mona.agent.tools.registry import ToolRegistry
    from mona.config.schema import ToolsConfig
    from mona.utils.prompt_templates import render_template

    builder = ContextBuilder(tmp_path)
    source_path = Path(__file__).resolve().parents[2] / "mona" / "templates" / "agent" / "visualizer.md"
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == (
        "7b7806dc391017dda8d6d9687ffad945bbacdf48125a85ac321d2f4f87b3cd66"
    )
    visualizer_prompt = render_template("agent/visualizer.md", productName="Mona")
    tool_context = ToolContext(config=ToolsConfig(), workspace=str(tmp_path))
    registry = ToolRegistry()
    loader = ToolLoader()
    names = loader.load(
        tool_context,
        registry,
        scope="core",
        tool_allowlist={"read_me", "show_widget"},
    )
    registry.set_allowed_tool_names(set(names))
    for name in names:
        registry.get(name).set_context(RequestContext(channel="websocket", chat_id="chat"))
    visible_work_tools = {schema["function"]["name"] for schema in registry.get_definitions()}
    assert visible_work_tools == {"read_me", "show_widget"}

    # This matches the Dev prompt renderer, which supplies visible tools without a channel.
    dev_function_contract = render_template("agent/tool_contract.md", tool_names=visible_work_tools)
    with_tools = builder.build_system_prompt(tool_names=visible_work_tools)

    for name in names:
        registry.get(name).set_context(RequestContext(channel="development", chat_id="code"))
    visible_development_tools = {schema["function"]["name"] for schema in registry.get_definitions()}
    assert visible_development_tools == set()
    development_prompt = builder.build_system_prompt(tool_names=visible_development_tools)

    assert visualizer_prompt in dev_function_contract
    assert visualizer_prompt in with_tools
    assert with_tools.count(visualizer_prompt) == 1
    assert "Always use the Visualizer for educational topics" in visualizer_prompt
    assert "pure dictionary-style" in visualizer_prompt
    assert 'Request: "Explain how TCP/IP works"' in visualizer_prompt
    assert "→ Proactively use the Visualizer" in visualizer_prompt
    assert "{{ productName }}" not in visualizer_prompt
    assert visualizer_prompt not in development_prompt
    assert "Use a focused Mermaid diagram only when relationships are materially clearer than prose" in development_prompt
