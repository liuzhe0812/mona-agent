"""Production image/candidate boundaries; no network, GUI input or paid model."""

import copy
import io
import json
from types import SimpleNamespace

import pytest
from PIL import Image

from mona.computer_use.executor import _questions, _target_arguments
from mona.computer_use.perception import _visual_candidates_from_payload, add_visual_candidates
from mona.providers.base import LLMProvider, LLMResponse


class ImageRejectingProvider(LLMProvider):
    def __init__(self, supports_vision=True):
        super().__init__()
        self.supports_vision = supports_vision
        self.calls = []

    def get_default_model(self):
        return "grounding-test"

    def get_capabilities(self, model):
        return SimpleNamespace(supports_vision=self.supports_vision)

    async def chat(self, **kwargs):
        self.calls.append(copy.deepcopy(kwargs))
        if len(self.calls) == 1:
            return LLMResponse("unsupported image format", finish_reason="error", error_status_code=400)
        return LLMResponse(json.dumps({"unknown": False, "candidates": [{
            "label": "fabricated without image", "frame": {"x": 10, "y": 10, "w": 20, "h": 20},
            "actions": ["click"], "confidence": 0.99,
        }]}))


@pytest.fixture(autouse=True)
def no_usage_writes(monkeypatch):
    monkeypatch.setattr("mona.usage.record_provider_usage", lambda *args, **kwargs: None)


def image_messages():
    return [{"role": "user", "content": [
        {"type": "text", "text": "Locate the target"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,fixture"}},
    ]}]


@pytest.mark.asyncio
@pytest.mark.parametrize("stream", [False, True])
async def test_required_image_never_falls_back_to_text(stream):
    provider = ImageRejectingProvider()
    messages = image_messages()
    original = copy.deepcopy(messages)
    method = provider.chat_stream_with_retry if stream else provider.chat_with_retry
    response = await method(messages=messages, require_image=True)
    assert response.finish_reason == "error"
    assert len(provider.calls) == 1
    assert messages == original
    assert "require_image" not in provider.calls[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("stream", [False, True])
async def test_ordinary_chat_keeps_existing_optional_image_fallback(stream):
    provider = ImageRejectingProvider()
    method = provider.chat_stream_with_retry if stream else provider.chat_with_retry
    response = await method(messages=image_messages())
    assert response.finish_reason != "error"
    assert len(provider.calls) == 2
    assert all(block["type"] == "text" for block in provider.calls[1]["messages"][0]["content"])


@pytest.mark.asyncio
@pytest.mark.parametrize("has_image,supports_vision", [(False, True), (True, False)])
async def test_required_image_rejects_missing_input_or_text_only_route(has_image, supports_vision):
    provider = ImageRejectingProvider(supports_vision)
    messages = image_messages() if has_image else [{"role": "user", "content": "no image"}]
    response = await provider.chat_with_retry(messages=messages, require_image=True)
    assert response.error_code == "IMAGE_INPUT_REQUIRED"
    assert not provider.calls


@pytest.mark.asyncio
async def test_real_perception_caller_cannot_admit_text_only_retry_coordinates():
    provider = ImageRejectingProvider()
    png = io.BytesIO()
    Image.new("RGB", (100, 80)).save(png, format="PNG")
    observation = {"width": 100, "height": 80, "screenshot": png.getvalue(), "candidates": []}
    await add_visual_candidates(observation, goal="locate", provider=provider, model="grounding-test")
    assert observation["perception_status"]["status"] == "error"
    assert not observation["candidates"]
    assert len(provider.calls) == 1


@pytest.mark.parametrize("confidence", [None, False, True, "0.9", -1, 0, 0.05, 0.59, 1.1, float("nan"), float("inf")])
def test_unreliable_visual_coordinates_are_not_offered_or_dispatched(confidence):
    raw = {"frame": {"x": 10, "y": 20, "w": 16, "h": 12}, "actions": ["click"], "confidence": confidence}
    candidates, invalid = _visual_candidates_from_payload({"candidates": [raw]}, {"width": 100, "height": 80})
    assert invalid == 0
    questions, by_id, _ = _questions(goal="click", completion_criteria="", candidates=candidates, text_values=[])
    assert not by_id
    assert "CLICK" not in questions["operation"]["criteria"]
    with pytest.raises(ValueError, match="localization"):
        _target_arguments(candidates[0], 1, 2)


def test_decision_confidence_threshold_also_applies_to_visual_position():
    candidate = {"id": "visual", "source": "vision", "confidence": 0.7,
                 "frame": {"x": 10, "y": 20, "w": 16, "h": 12}, "actions": ["click"]}
    _, by_id, _ = _questions(goal="click", completion_criteria="", candidates=[candidate], text_values=[], min_confidence=0.8)
    assert not by_id
    assert _target_arguments(candidate, 1, 2)["x"] == 18
    with pytest.raises(ValueError):
        _target_arguments(candidate, 1, 2, 0.8)


@pytest.mark.asyncio
@pytest.mark.parametrize("stream", [False, True])
async def test_main_computer_model_request_requires_images_but_other_tasks_do_not(stream):
    from mona.agent.hook import AgentHook, AgentHookContext
    from mona.agent.runner import AgentRunner, AgentRunSpec
    from mona.agent.tools.context import RequestContext
    from mona.computer_use.session import bind_computer_context, finish_computer_turn

    calls = []

    async def request(**kwargs):
        calls.append(kwargs)
        return LLMResponse("done")

    class Hook(AgentHook):
        def wants_streaming(self):
            return stream

    runner = AgentRunner(SimpleNamespace(chat_with_retry=request, chat_stream_with_retry=request))
    spec = AgentRunSpec(initial_messages=[], tools=SimpleNamespace(get_definitions=lambda: []), model="test",
                        max_iterations=1, max_tool_result_chars=1000)
    turn = bind_computer_context(RequestContext(channel="test", chat_id="required-image"))
    try:
        for name in ("computer_observe", "notes_read"):
            messages = [{"role": "tool", "name": name, "content": image_messages()[0]["content"]}]
            await runner._request_model(spec, messages, Hook(), AgentHookContext(iteration=1, messages=messages))
            assert calls[-1].get("require_image", False) is (name == "computer_observe")
    finally:
        await finish_computer_turn(turn)


def test_real_uia_tokens_do_not_need_a_visual_confidence_score():
    candidate = {"id": "uia", "source": "uia", "element_token": "fresh-token", "actions": ["click"]}
    _, by_id, _ = _questions(goal="click", completion_criteria="", candidates=[candidate], text_values=[])
    assert "uia" in by_id
    assert _target_arguments(candidate, 1, 2)["element_token"] == "fresh-token"
