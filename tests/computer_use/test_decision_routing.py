"""Decision routing must avoid vision when controls suffice and ask for missing context."""

from unittest.mock import AsyncMock

import pytest

from mona.computer_use import executor
from mona.config.schema import Config


def answer(choice):
    return {"choice": choice, "confidence": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["SUFFICIENT", "NEEDS_VISION", "NEEDS_PLAN", "REQUEST_TEXT"])
async def test_native_coverage_controls_dispatch_and_vision(monkeypatch, route):
    current = None
    native = {"id": "uia:0", "source": "uia", "label": "Search", "role": "Edit", "actions": ["click", "type"], "element_token": "snapshot:0"}
    async def observe():
        nonlocal current
        current = {"pid": 1, "window_id": 2, "candidates": [dict(native)], "perception_status": "direct_screenshot"}

    async def visual(observation):
        observation["candidates"] = [{"id": "vision:0", "source": "vision", "label": "Target", "actions": ["click"], "frame": {"x": 2, "y": 4, "w": 10, "h": 10}, "state": "ready", "relations": "below search"}]
        observation["perception_status"] = {"status": "ready"}
        return observation

    perceive = AsyncMock(side_effect=visual)
    requests = []
    async def decide(**kwargs):
        requests.append(kwargs)
        if len(requests) == 1:
            return {
                "coverage": answer("SUFFICIENT" if route == "REQUEST_TEXT" else route),
                "operation": answer("REQUEST_TEXT" if route == "REQUEST_TEXT" else "CLICK"),
                "click_target": answer("uia:0"), "text_field": answer("uia:0"),
            }
        assert kwargs["state"]["candidates"][0]["relations"] == "below search"
        return {"operation": answer("CLICK"), "click_target": answer("vision:0")}

    monkeypatch.setattr(executor, "request_decisions", decide)
    act = AsyncMock(return_value="sent")
    result = await executor.run_computer_goal(
        pid=1, window_id=2, goal="find the requested item", completion_criteria="item visible",
        text_values=[], max_steps=2 if route == "NEEDS_VISION" else 1, max_duration_seconds=2, decision_config=Config().tools.jev,
        observe=observe, perceive=perceive, act=act, get_observation=lambda: current,
        is_stopped=lambda: False, settle_seconds=0, strategy="retain the current task",
    )
    assert "coverage" in requests[0]["questions"]
    assert "click_target" in requests[0]["questions"]
    assert requests[0]["state"]["strategy"] == "retain the current task"
    assert perceive.await_count == (2 if route == "NEEDS_VISION" else 0)
    if route in {"NEEDS_PLAN", "REQUEST_TEXT"}:
        act.assert_not_awaited()
        assert result["handoff_request"]["kind"] == ("planning" if route == "NEEDS_PLAN" else "text")
        assert result["snapshot_current"]
    elif route == "SUFFICIENT":
        assert len(requests) == 1
        assert act.await_args.args[1]["element_token"] == "snapshot:0"
    else:
        assert len(requests) == 3
        assert "coverage" not in requests[-1]["questions"]
        assert act.await_args.args[1]["x"] == 7
        assert "element_token" not in act.await_args.args[1]


@pytest.mark.asyncio
@pytest.mark.parametrize("supplement", [{"strategy": "Use the observed safe target"}, {"text_values": ["requested city"]}])
async def test_handoff_requires_new_context_before_resuming_same_phase(monkeypatch, supplement):
    from mona.agent.tools.context import RequestContext
    from mona.agent.tools.mcp import ComputerActTool
    from mona.agent.tools.registry import ToolRegistry
    from mona.computer_use.session import bind_computer_context, finish_computer_turn

    config = Config()
    config.tools.computer_use.use_decision_model = True
    config.tools.jev.api_key = "test-placeholder"
    run = AsyncMock(return_value={"status": "handoff", "snapshot_current": False})
    monkeypatch.setattr(executor, "run_computer_goal", run)
    tool = ComputerActTool(ToolRegistry(), runtime_config_loader=lambda: config)
    turn = bind_computer_context(RequestContext(channel="test", chat_id="resume"))
    arguments = {"pid": 1, "window_id": 2, "goal": "continue current task"}
    try:
        await tool.execute("run", arguments)
        denied = await tool.execute("run", arguments)
        assert "COMPUTER_HANDOFF" in denied
        assert run.await_count == 1
        await tool.execute("run", {**arguments, **supplement})
        assert run.await_count == 2
        for key, value in supplement.items():
            assert run.await_args.kwargs[key] == value
    finally:
        await finish_computer_turn(turn)
