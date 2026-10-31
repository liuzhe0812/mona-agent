"""Behavior tests for the chat visualizer tools."""

from __future__ import annotations

import json
from contextvars import copy_context
from types import SimpleNamespace

import pytest

from mona.agent.tools.context import RequestContext
from mona.agent.tools.registry import ToolRegistry
from mona.agent.tools.visualizer import (
    ShowWidgetTool,
    VisualizerToolConfig,
)


def _payload(result: str) -> dict:
    return json.loads(result)


def _run(coroutine):
    """Drive the tools' immediate async methods without starting a platform event loop."""
    try:
        coroutine.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError("Visualizer tool unexpectedly suspended during validation")


def test_tool_scope_config_and_request_context_isolation() -> None:
    config = VisualizerToolConfig()
    assert config.enable is True
    assert config.max_widget_chars == 128_000
    assert ShowWidgetTool.config_cls() is VisualizerToolConfig
    assert ShowWidgetTool._scopes == {"core"}
    assert ShowWidgetTool.config_key == "visualizer"
    assert ShowWidgetTool.system_managed is True
    assert ShowWidgetTool.enabled(SimpleNamespace(config=SimpleNamespace(visualizer=config)))
    instance = ShowWidgetTool.create(SimpleNamespace(config=SimpleNamespace(visualizer=config)))
    assert instance.config is config
    assert instance.read_only is True
    assert instance.available_in_context() is False
    assert not ShowWidgetTool.enabled(
        SimpleNamespace(config=SimpleNamespace(visualizer=VisualizerToolConfig(enable=False)))
    )

    tool = ShowWidgetTool(config)
    assert tool.available_in_context() is False
    tool.set_context(RequestContext(channel="email", chat_id="mail"))
    assert tool.available_in_context() is False

    websocket_context = copy_context()
    email_context = copy_context()
    websocket_context.run(tool.set_context, RequestContext(channel="websocket", chat_id="websocket"))
    email_context.run(tool.set_context, RequestContext(channel="email", chat_id="email"))
    assert websocket_context.run(tool.available_in_context) is True
    assert email_context.run(tool.available_in_context) is False
    assert tool.available_in_context() is False


def test_visualizer_guidance_loads_from_skill_references(tmp_path, monkeypatch) -> None:
    from mona.agent.skills import SkillsLoader
    from mona.agent.tools import skill_tools
    from mona.agent.tools.capabilities import LoadCapabilityTool, bind_capability_context
    from mona.agent.tools.skill_tools import SkillReadTool, SkillReferenceReadTool

    monkeypatch.setattr(skill_tools, "_skills_loader", lambda _agent_id: SkillsLoader(tmp_path))
    registry = ToolRegistry()
    registry.register(LoadCapabilityTool(workspace=tmp_path, agent_id="mona", registry=registry))
    registry.register(SkillReadTool(track_usage=False))
    registry.register(SkillReferenceReadTool(track_usage=False))
    bind_capability_context(RequestContext(channel="websocket", chat_id="chat"))

    assert not registry.is_visible("skill_reference_read")
    skill = _run(registry.execute("skill_read", {"name": "mona-visualizer"}))
    assert "skill_reference_read" in skill
    assert registry.is_visible("skill_reference_read")
    core = _run(registry.execute("skill_reference_read", {"skill": "mona-visualizer", "ref_path": "core.md"}))
    diagram = _run(registry.execute("skill_reference_read", {"skill": "mona-visualizer", "ref_path": "diagram.md"}))
    assert "# Visualizer Core Design System" in core
    assert "# Diagram Guidance" in diagram


def test_show_widget_returns_svg_and_interactive_html_protocol() -> None:
    tool = ShowWidgetTool()
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 240"><text x="12" y="24">图表</text></svg>'
    svg_result = _payload(_run(tool.execute(
        title="  收入趋势  ",
        widget_code=svg,
        loading_messages='["正在绘制图表"]',
    )))
    assert svg_result == {
        "type": "visualizer_show_widget_result",
        "success": True,
        "title": "收入趋势",
        "widget_code": svg,
        "loading_messages": ["正在绘制图表"],
        "render_mode": "svg",
    }

    html = '<div><button>展开</button><script src="https://cdn.jsdelivr.net/npm/example.js"></script></div>'
    html_result = _payload(_run(tool.execute(
        title="交互说明",
        widget_code=html,
        loading_messages=["正在准备交互"],
    )))
    assert html_result["render_mode"] == "html"
    assert html_result["widget_code"] == html


def test_show_widget_registry_accepts_json_loading_message_array() -> None:
    tool = ShowWidgetTool()
    tool.set_context(RequestContext(channel="websocket", chat_id="chat"))
    registry = ToolRegistry()
    registry.register(tool)
    parameters = registry.get_definitions()[0]["function"]["parameters"]["properties"]
    assert parameters["loading_messages"]["minItems"] == 1
    assert parameters["loading_messages"]["maxItems"] == 4
    result = _payload(_run(registry.execute("show_widget", {
        "title": "Panel",
        "widget_code": "<div>Ready</div>",
        "loading_messages": '["Loading", "Almost ready"]',
    })))
    assert result["loading_messages"] == ["Loading", "Almost ready"]
    assert result["render_mode"] == "html"


@pytest.mark.parametrize(
    "host",
    ["cdnjs.cloudflare.com", "esm.sh", "cdn.jsdelivr.net", "unpkg.com"],
)
def test_show_widget_accepts_approved_script_hosts(host: str) -> None:
    result = _payload(_run(ShowWidgetTool().execute(
        title="Scripts",
        widget_code=f'<script src="https://{host}:443/bundle.js"></script>',
        loading_messages=["Loading"],
    )))
    assert result["success"] is True


@pytest.mark.parametrize(
    "widget_code",
    [
        "<!DOCTYPE html><div>bad</div>",
        "<html></html>",
        "<head></head>",
        "<body></body>",
        "<form><input></form>",
        "<iframe src='https://example.com'></iframe>",
        "<object></object>",
        "<embed>",
        "<base href='https://example.com'>",
        "<meta charset='utf-8'>",
        "<link rel='stylesheet' href='https://example.com/style.css'>",
        "<div style='position: fixed'>bad</div>",
        "<script>localStorage.getItem('x')</script>",
        "<script>sessionStorage.clear()</script>",
        '<script src="http://cdn.jsdelivr.net/a.js"></script>',
        '<script src="https://evil.example/a.js"></script>',
        '<script src="https://user@cdn.jsdelivr.net/a.js"></script>',
        '<script src="https://cdn.jsdelivr.net:444/a.js"></script>',
    ],
)
def test_show_widget_rejects_unsafe_markup_and_script_sources(widget_code: str) -> None:
    result = _run(ShowWidgetTool().execute(
        title="Bad widget",
        widget_code=widget_code,
        loading_messages=["Loading"],
    ))
    assert isinstance(result, str) and result.startswith("Error:")


def test_show_widget_rejects_invalid_svg_count_and_viewbox() -> None:
    tool = ShowWidgetTool()
    args = {"title": "SVG", "loading_messages": ["Loading"]}
    bad_viewbox = _run(tool.execute(
        **args,
        widget_code='<svg viewBox="0 0 500 200"></svg>',
    ))
    multiple = _run(tool.execute(
        **args,
        widget_code='<svg viewBox="0 0 680 200"><svg></svg></svg>',
    ))
    assert "viewBox" in bad_viewbox
    assert "exactly one SVG" in multiple


def test_show_widget_rejects_missing_fields_loading_count_and_oversize() -> None:
    tool = ShowWidgetTool(VisualizerToolConfig(max_widget_chars=16))
    assert _run(tool.execute(title=" ", widget_code="<div/>", loading_messages=["Loading"])).startswith("Error:")
    assert _run(tool.execute(title="OK", widget_code=" ", loading_messages=["Loading"])).startswith("Error:")
    assert _run(tool.execute(title="OK", widget_code="<div/>", loading_messages=[])).startswith("Error:")
    assert _run(tool.execute(title="OK", widget_code="<div/>", loading_messages=["1", "2", "3", "4", "5"])).startswith("Error:")
    assert "max_widget_chars" in _run(tool.execute(
        title="OK",
        widget_code="<div>this is longer than sixteen characters</div>",
        loading_messages=["Loading"],
    ))
