"""DPI/crop/observation regressions exercise the production facade and MCP adapter."""
import base64
import io
import json
from types import SimpleNamespace

import pytest
from mcp.types import CallToolResult, ImageContent, TextContent
from PIL import Image, ImageDraw

from mona.agent.tools.context import RequestContext
from mona.agent.tools.mcp import (
    BUILTIN_COMPUTER_SERVER_NAME,
    ComputerActTool,
    ComputerObserveTool,
    MCPToolWrapper,
)
from mona.agent.tools.registry import ToolRegistry
from mona.computer_use.perception import make_detail_view
from mona.computer_use.session import bind_computer_context, finish_computer_turn
from mona.config.schema import Config


def snapshot(image):
    png = io.BytesIO()
    image.save(png, format="PNG")
    return CallToolResult(content=[ImageContent(type="image", mimeType="image/png", data=base64.b64encode(png.getvalue()).decode())],
                          structuredContent={"elements": [], "screenshot_width": image.width, "screenshot_height": image.height})


@pytest.fixture
async def harness():
    context = RequestContext(channel="test", chat_id="grounding-freshness")
    turn = bind_computer_context(context)
    state = SimpleNamespace(image=Image.new("RGB", (400, 300), "white"),
                            geometry=(-800, 100, 0, 700, 192), calls=[], on_focus=None)
    ImageDraw.Draw(state.image).rectangle((40, 50, 80, 90), fill="blue")
    registry = ToolRegistry()
    common = {"pid": {"type": "integer"}, "window_id": {"type": "integer"}, "session": {"type": "string"}}

    async def call_tool(name, *, arguments):
        state.calls.append((name, dict(arguments)))
        if name == "bring_to_front" and state.on_focus:
            state.on_focus()
        if name == "get_window_state":
            return snapshot(state.image)
        return CallToolResult(content=[TextContent(type="text", text="delivered")])

    for name, extra in {
        "get_window_state": {"include_screenshot": {"type": "boolean"}},
        "bring_to_front": {},
        "click": {"x": {"type": "number"}, "y": {"type": "number"}, "delivery_mode": {"type": "string"}},
        "drag": {k: {"type": "number"} for k in ("from_x", "from_y", "to_x", "to_y")},
    }.items():
        tool = SimpleNamespace(name=name, description=name, inputSchema={"type": "object", "properties": {**common, **extra}, "required": ["pid", "window_id"]})
        wrapper = MCPToolWrapper(SimpleNamespace(call_tool=call_tool), BUILTIN_COMPUTER_SERVER_NAME, tool, computer_session_nonce="fixture")
        wrapper.set_context(context)
        registry.register(wrapper)
    config = Config()
    opts = {"runtime_config_loader": lambda: config, "geometry_reader": lambda pid, wid: state.geometry, "permission_check": lambda: True}
    observer, actor = ComputerObserveTool(registry, **opts), ComputerActTool(registry, **opts)
    try:
        yield SimpleNamespace(turn=turn, state=state, observe=observer, act=actor)
    finally:
        await finish_computer_turn(turn)


async def observe(h):
    await h.observe.execute(action="window", arguments={"pid": 7, "window_id": 11})
    assert h.turn.observation is not None
    return h.turn.observation


def dispatched(h):
    return [args for name, args in h.state.calls if name in {"click", "drag"}]


@pytest.mark.asyncio
async def test_pixel_action_requires_explicit_current_image(harness):
    h = harness
    await observe(h)
    result = await h.act.execute(action="click", arguments={"pid": 7, "window_id": 11, "x": 60, "y": 70})
    assert not dispatched(h)
    assert "image_id" in result


@pytest.mark.asyncio
async def test_focus_content_change_does_not_click_old_position(harness):
    h = harness
    old = await observe(h)
    h.state.on_focus = lambda: ImageDraw.Draw(h.state.image).rectangle((40, 50, 80, 90), fill="red")
    result = await h.act.execute(action="click", arguments={"pid": 7, "window_id": 11, "x": 60, "y": 70, "image_id": old["image_id"]})
    assert not dispatched(h)
    assert json.loads(result)["error"]["code"] == "STALE_COMPUTER_TARGET"


@pytest.mark.asyncio
@pytest.mark.parametrize("scale", [1, 1.25, 1.5, 1.75, 2, 2.5])
@pytest.mark.parametrize("cropped", [False, True])
async def test_system_scale_never_multiplies_driver_screenshot_coordinates(harness, scale, cropped):
    h = harness
    h.state.geometry = (-1600, 100, -1600 + int(400 * scale), 100 + int(300 * scale), int(96 * scale))
    old = await observe(h)
    image_id, x, y = old["image_id"], 60, 70
    if cropped:
        view = make_detail_view(old, {"x": 40, "y": 50, "w": 40, "h": 40})
        image_id, x, y = view["image_id"], 40, 40
    result = await h.act.execute(action="click", arguments={"pid": 7, "window_id": 11, "x": x, "y": y, "image_id": image_id})
    assert result == "delivered"
    assert len(dispatched(h)) == 1
    assert (dispatched(h)[0]["x"], dispatched(h)[0]["y"]) == (60, 70)
    assert h.turn.observation is None


@pytest.mark.asyncio
async def test_drag_both_endpoints_use_crop_space_once(harness):
    h = harness
    old = await observe(h)
    view = make_detail_view(old, {"x": 30, "y": 40, "w": 120, "h": 100})
    await h.act.execute(action="drag", arguments={"pid": 7, "window_id": 11, "from_x": 60, "from_y": 60,
                                                 "to_x": 200, "to_y": 140, "image_id": view["image_id"]})
    assert len(dispatched(h)) == 1
    assert {k: dispatched(h)[0][k] for k in ("from_x", "from_y", "to_x", "to_y")} == {
        "from_x": 60, "from_y": 70, "to_x": 130, "to_y": 110,
    }


@pytest.mark.asyncio
async def test_scale_or_monitor_geometry_change_invalidates_observation(harness):
    h = harness
    old = await observe(h)
    h.state.geometry = (500, 100, 1500, 850, 240)
    result = await h.act.execute(action="click", arguments={"pid": 7, "window_id": 11, "x": 60, "y": 70, "image_id": old["image_id"]})
    assert not dispatched(h)
    assert json.loads(result)["error"]["code"] == "STALE_COMPUTER_TARGET"


@pytest.mark.asyncio
async def test_stale_image_cannot_be_rebound_to_new_capture(harness, monkeypatch):
    # Windows wall-clock resolution must not decide screenshot identity.
    monkeypatch.setattr("mona.computer_use.perception.time.time_ns", lambda: 12345)
    h = harness
    old = await observe(h)
    await observe(h)
    result = await h.act.execute(action="click", arguments={"pid": 7, "window_id": 11, "x": 60, "y": 70, "image_id": old["image_id"]})
    assert not dispatched(h)
    assert "image_id" in result


@pytest.mark.asyncio
async def test_distant_animation_does_not_force_another_model_decision(harness):
    h = harness
    old = await observe(h)
    h.state.on_focus = lambda: ImageDraw.Draw(h.state.image).rectangle((330, 240, 380, 280), fill="red")
    await h.act.execute(action="click", arguments={"pid": 7, "window_id": 11, "x": 60, "y": 70, "image_id": old["image_id"]})
    assert len(dispatched(h)) == 1
