"""Foreground routing preserves the caller's chosen computer target."""

from __future__ import annotations

import asyncio
import base64
import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from mcp.types import CallToolResult, ImageContent, TextContent
from PIL import Image

from mona.agent.tools.context import RequestContext
from mona.agent.tools.mcp import (
    BUILTIN_COMPUTER_SERVER_NAME,
    ComputerActTool,
    ComputerObserveTool,
    MCPToolWrapper,
)
from mona.agent.tools.registry import ToolRegistry
from mona.computer_use.session import (
    bind_computer_context,
    finish_computer_turn,
    mark_computer_turn_stopped,
)

_PID = 123
_WINDOW_ID = 456
_ELEMENT_TOKEN = "button-open-settings"


def _schema(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required}


def _text_result(text: str, *, is_error: bool = False, code: str | None = None) -> CallToolResult:
    result = CallToolResult(
        content=[TextContent(type="text", text=text)],
        isError=is_error,
    )
    if code is not None:
        result.structuredContent = {"code": code}
    return result


def _window_result() -> CallToolResult:
    png = io.BytesIO()
    Image.new("RGB", (100, 80), color=(32, 64, 96)).save(png, format="PNG")
    return CallToolResult(
        content=[
            TextContent(type="text", text="window state"),
            ImageContent(
                type="image",
                mimeType="image/png",
                data=base64.b64encode(png.getvalue()).decode("ascii"),
            ),
        ],
        structuredContent={
            "screenshot_width": 100,
            "screenshot_height": 80,
            "elements": [
                {
                    "element_token": _ELEMENT_TOKEN,
                    "role": "button",
                    "label": "Open settings",
                    "frame": {"x": 10, "y": 10, "w": 20, "h": 12},
                }
            ],
        },
    )


@pytest.fixture
async def computer_tools():
    context = RequestContext(
        channel="websocket",
        chat_id="computer-route-test",
        session_key="computer-route-test",
    )
    turn = bind_computer_context(context)
    state = SimpleNamespace(
        calls=[],
        focus_result=_text_result("focused"),
        focus_started=asyncio.Event(),
        focus_release=None,
    )

    async def call_tool(name: str, *, arguments: dict) -> CallToolResult:
        state.calls.append((name, dict(arguments)))
        if name == "get_window_state":
            return _window_result()
        if name == "bring_to_front":
            state.focus_started.set()
            if state.focus_release is not None:
                await state.focus_release.wait()
            return state.focus_result
        if name == "click":
            return _text_result("clicked")
        if name == "set_value":
            return _text_result("value set")
        return _text_result("ok")

    driver = SimpleNamespace(call_tool=AsyncMock(side_effect=call_tool))
    registry = ToolRegistry()
    common = {
        "session": {"type": "string"},
        "pid": {"type": "integer"},
        "window_id": {"type": "integer"},
    }
    definitions = {
        "get_window_state": _schema(
            {
                **common,
                "include_screenshot": {"type": "boolean"},
            },
            ["pid", "window_id"],
        ),
        "bring_to_front": _schema(common, ["pid", "window_id"]),
        "click": _schema(
            {
                **common,
                "element_token": {"type": "string"},
                "x": {"type": "number"},
                "y": {"type": "number"},
                "delivery_mode": {"type": "string", "enum": ["foreground", "background"]},
            },
            ["pid", "window_id"],
        ),
        "set_value": _schema(
            {
                **common,
                "element_token": {"type": "string"},
                "value": {"type": "string"},
            },
            ["pid", "window_id", "element_token", "value"],
        ),
    }
    wrappers = {}
    for name, input_schema in definitions.items():
        wrapper = MCPToolWrapper(
            driver,
            BUILTIN_COMPUTER_SERVER_NAME,
            SimpleNamespace(name=name, description=name, inputSchema=input_schema),
            computer_session_nonce="foreground-route-test",
        )
        wrapper.set_context(context)
        registry.register(wrapper)
        wrappers[name] = wrapper

    registry.register(ComputerObserveTool(registry))
    registry.register(ComputerActTool(registry))
    try:
        yield SimpleNamespace(
            context=context,
            turn=turn,
            state=state,
            registry=registry,
            wrappers=wrappers,
        )
    finally:
        if state.focus_release is not None:
            state.focus_release.set()
        await finish_computer_turn(turn)


async def _observe_window(harness) -> None:
    await harness.registry.get("computer_observe").execute(
        action="window",
        arguments={"pid": _PID, "window_id": _WINDOW_ID},
    )
    assert harness.turn.observation == {
        "scope": "window",
        "pid": _PID,
        "window_id": _WINDOW_ID,
        "width": 100,
        "height": 80,
        "tokens": {_ELEMENT_TOKEN},
    }


def _action_calls(harness) -> list[tuple[str, dict]]:
    return [(name, args) for name, args in harness.state.calls if name != "end_session"]


@pytest.mark.asyncio
async def test_control_click_focuses_first_and_preserves_element_token(computer_tools) -> None:
    await _observe_window(computer_tools)

    result = await computer_tools.registry.get("computer_act").execute(
        action="click",
        arguments={"pid": _PID, "window_id": _WINDOW_ID, "element_token": _ELEMENT_TOKEN},
    )

    assert result == "clicked"
    assert _action_calls(computer_tools) == [
        ("get_window_state", {
            "pid": _PID,
            "window_id": _WINDOW_ID,
            "include_screenshot": True,
            "session": computer_tools.turn.driver_label,
        }),
        ("bring_to_front", {
            "pid": _PID,
            "window_id": _WINDOW_ID,
            "session": computer_tools.turn.driver_label,
        }),
        ("click", {
            "pid": _PID,
            "window_id": _WINDOW_ID,
            "element_token": _ELEMENT_TOKEN,
            "delivery_mode": "foreground",
            "session": computer_tools.turn.driver_label,
        }),
    ]


@pytest.mark.parametrize("x,y", [(23, 42), (99.5, 18.25)])
@pytest.mark.asyncio
async def test_coordinate_click_focuses_first_and_preserves_coordinates(computer_tools, x, y) -> None:
    await _observe_window(computer_tools)

    result = await computer_tools.registry.get("computer_act").execute(
        action="click",
        arguments={"pid": _PID, "window_id": _WINDOW_ID, "x": x, "y": y},
    )

    assert result == "clicked"
    calls = _action_calls(computer_tools)
    assert [name for name, _ in calls] == ["get_window_state", "bring_to_front", "click"]
    click_arguments = calls[-1][1]
    assert click_arguments == {
        "pid": _PID,
        "window_id": _WINDOW_ID,
        "x": x,
        "y": y,
        "delivery_mode": "foreground",
        "session": computer_tools.turn.driver_label,
    }
    assert "element_token" not in click_arguments


@pytest.mark.asyncio
async def test_set_value_focuses_first_and_preserves_token_and_value(computer_tools) -> None:
    await _observe_window(computer_tools)

    result = await computer_tools.registry.get("computer_act").execute(
        action="set_value",
        arguments={
            "pid": _PID,
            "window_id": _WINDOW_ID,
            "element_token": _ELEMENT_TOKEN,
            "value": "Mona settings",
        },
    )

    assert result == "value set"
    calls = _action_calls(computer_tools)
    assert [name for name, _ in calls] == ["get_window_state", "bring_to_front", "set_value"]
    assert calls[-1][1] == {
        "pid": _PID,
        "window_id": _WINDOW_ID,
        "element_token": _ELEMENT_TOKEN,
        "value": "Mona settings",
        "session": computer_tools.turn.driver_label,
    }


@pytest.mark.asyncio
async def test_focus_failure_does_not_dispatch_original_action(computer_tools) -> None:
    await _observe_window(computer_tools)
    computer_tools.state.focus_result = _text_result(
        "focus denied",
        is_error=True,
        code="FOCUS_DENIED",
    )

    result = await computer_tools.registry.get("computer_act").execute(
        action="click",
        arguments={"pid": _PID, "window_id": _WINDOW_ID, "element_token": _ELEMENT_TOKEN},
    )

    assert json.loads(result)["isError"] is True
    assert [name for name, _ in _action_calls(computer_tools)] == [
        "get_window_state",
        "bring_to_front",
    ]


@pytest.mark.asyncio
async def test_stop_during_focus_prevents_original_action(computer_tools) -> None:
    await _observe_window(computer_tools)
    computer_tools.state.focus_release = asyncio.Event()
    action = asyncio.create_task(
        computer_tools.registry.get("computer_act").execute(
            action="click",
            arguments={"pid": _PID, "window_id": _WINDOW_ID, "element_token": _ELEMENT_TOKEN},
        )
    )
    try:
        await asyncio.wait_for(computer_tools.state.focus_started.wait(), timeout=2)
        assert mark_computer_turn_stopped(computer_tools.context.session_key)
    finally:
        computer_tools.state.focus_release.set()

    result = await action

    assert json.loads(result)["error"]["code"] == "COMPUTER_STOPPED"
    assert [name for name, _ in _action_calls(computer_tools)] == [
        "get_window_state",
        "bring_to_front",
    ]
