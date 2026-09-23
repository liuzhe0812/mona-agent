"""A failed visual service must not delay every subsequent screenshot."""

import asyncio
import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from mona.computer_use.vision import enrich_observation
from mona.config.schema import Config


@pytest.mark.asyncio
async def test_visual_timeout_is_not_retried_for_changed_frames_in_same_turn():
    config = Config()
    config.tools.computer_use.perception_timeout_seconds = 0.01
    async def slow_vision(**kwargs):
        await asyncio.Event().wait()

    provider = SimpleNamespace(
        get_capabilities=lambda model: SimpleNamespace(supports_vision=True),
        chat_with_retry=AsyncMock(side_effect=slow_vision),
    )
    data = io.BytesIO()
    Image.new("RGB", (20, 20)).save(data, format="PNG")
    cache = {}
    for fingerprint in ("first-frame", "changed-frame"):
        observation = {"width": 20, "height": 20, "screenshot": data.getvalue(), "screenshot_sha256": fingerprint}
        await enrich_observation(observation, goal="continue", config=config, provider=provider, model="vision", cache=cache)
        assert observation["perception_status"] == "unavailable"
        assert "paused for this turn" in observation["perception_warning"]
    assert provider.chat_with_retry.await_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("still_unknown", [False, True])
async def test_one_local_refinement_maps_back_and_does_not_repeat(still_unknown):
    provider = SimpleNamespace(
        get_capabilities=lambda model: SimpleNamespace(supports_vision=True),
        chat_with_retry=AsyncMock(side_effect=[
            SimpleNamespace(content=json.dumps({"unknown": True, "refine_region": {"x": 20, "y": 30, "w": 10, "h": 10}, "candidates": []})),
            SimpleNamespace(content=json.dumps({"unknown": still_unknown, "refine_region": {"x": 1, "y": 1, "w": 5, "h": 5}, "candidates": [{"label": "target", "frame": {"x": 4, "y": 6, "w": 4, "h": 4}, "actions": ["click"]}]})),
        ]),
    )
    data = io.BytesIO()
    Image.new("RGB", (100, 100)).save(data, format="PNG")
    observation = {"width": 100, "height": 100, "image_id": "base", "screenshot": data.getvalue(), "screenshot_sha256": "frame"}
    cache = {}
    await enrich_observation(observation, goal="locate", config=Config(), provider=provider, model="vision", cache=cache)
    assert observation["refinement_attempted"] is True
    assert observation["candidates"][0]["frame"] == {"x": 22, "y": 33, "w": 2, "h": 2}
    assert provider.chat_with_retry.await_count == 2
    if still_unknown:
        await enrich_observation(observation, goal="locate", config=Config(), provider=provider, model="vision", cache=cache)
        assert provider.chat_with_retry.await_count == 2
        assert observation["perception_status"] == "unavailable"


@pytest.mark.asyncio
async def test_computer_stream_has_wall_timeout_without_affecting_other_tools():
    from mona.agent.hook import AgentHook, AgentHookContext
    from mona.agent.runner import AgentRunner, AgentRunSpec
    from mona.agent.tools.context import RequestContext
    from mona.computer_use.session import bind_computer_context, finish_computer_turn
    from mona.providers.base import LLMResponse

    turn = bind_computer_context(RequestContext(channel="test", chat_id="timeout"))
    turn.model_response_timeout_seconds = 0.01
    requests = []
    async def stream(**kwargs):
        requests.append(kwargs)
        await asyncio.sleep(0.03)
        return LLMResponse(content="done")

    class StreamingHook(AgentHook):
        def wants_streaming(self):
            return True

    runner = AgentRunner(SimpleNamespace(chat_stream_with_retry=stream))
    spec = AgentRunSpec(initial_messages=[], tools=SimpleNamespace(get_definitions=lambda: []), model="test", max_iterations=1, max_tool_result_chars=1000, reasoning_effort="high")
    try:
        for name in ("computer_observe", "notes_read"):
            messages = [{"role": "tool", "name": name, "content": "result"}]
            response = await runner._request_model(spec, messages, StreamingHook(), AgentHookContext(iteration=1, messages=messages))
            if name == "computer_observe":
                assert response.error_kind == "timeout"
                assert requests[-1]["reasoning_effort"] == "high"
            else:
                assert response.content == "done"
                assert requests[-1]["reasoning_effort"] == "high"
    finally:
        await finish_computer_turn(turn)
