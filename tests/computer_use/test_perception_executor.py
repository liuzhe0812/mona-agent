from __future__ import annotations

import io
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from mona.computer_use import executor
from mona.computer_use.perception import add_visual_candidates, target_change_score
from mona.config.schema import JevConfig
from mona.providers.base import LLMResponse


def _observation(
    color: str,
    *,
    pixel: tuple[int, int, tuple[int, int, int]] | None = None,
) -> dict[str, Any]:
    image = Image.new("RGB", (100, 100), color)
    if pixel:
        image.putpixel((pixel[0], pixel[1]), pixel[2])
    data = io.BytesIO()
    image.save(data, format="PNG")
    return {
        "observation_id": color,
        "width": 100,
        "height": 100,
        "screenshot": data.getvalue(),
        "candidates": [
            {
                "id": "uia:0",
                "source": "uia",
                "role": "button",
                "label": "Continue",
                "frame": {"x": 10.0, "y": 10.0, "w": 20.0, "h": 20.0},
                "element_token": "s1:0",
                "actions": ["click"],
            }
        ],
        "summary": "",
    }


def test_target_change_ignores_distant_animation() -> None:
    before = _observation("black")
    distant = _observation("black", pixel=(95, 95, (255, 255, 255)))
    local = _observation("black", pixel=(20, 20, (255, 255, 255)))
    target = {"x": 10.0, "y": 10.0, "w": 20.0, "h": 20.0}

    assert target_change_score(before, distant, frame=target) == 0
    assert target_change_score(before, local, frame=target) > 0


@pytest.mark.asyncio
async def test_visual_perception_adds_validated_candidates() -> None:
    provider = SimpleNamespace(
        chat_with_retry=AsyncMock(
            return_value=LLMResponse(
                content='{"summary":"battle","candidates":[{"label":"Attack","role":"button","frame":{"x":40,"y":50,"w":20,"h":10},"actions":["click"]}]}'
            )
        )
    )
    observation = _observation("black")

    await add_visual_candidates(
        observation,
        goal="attack the enemy",
        provider=provider,
        model="vision-model",
    )

    assert observation["summary"] == "battle"
    assert observation["candidates"][-1]["label"] == "Attack"
    assert observation["candidates"][-1]["source"] == "vision"


@pytest.mark.asyncio
async def test_decision_loop_observes_after_action_and_returns_for_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observations = [_observation("black"), _observation("white")]
    current = observations[0]
    observe_calls = 0
    actions: list[tuple[str, dict[str, Any]]] = []
    decisions = [
        {"operation": {"choice": "CLICK", "confidence": 1}, "click_target": {"choice": "uia:0", "confidence": 1}},
        {"operation": {"choice": "DONE", "confidence": 1}, "click_target": {"choice": "uia:0", "confidence": 1}},
    ]

    async def observe() -> None:
        nonlocal current, observe_calls
        current = observations[min(observe_calls, len(observations) - 1)]
        observe_calls += 1

    async def act(action: str, arguments: dict[str, Any]) -> str:
        actions.append((action, arguments))
        return "dispatched"

    async def decide(**_kwargs: Any) -> dict[str, Any]:
        return decisions.pop(0)

    monkeypatch.setattr(executor, "request_decisions", decide)
    result = await executor.run_computer_goal(
        pid=42,
        window_id=7,
        goal="continue",
        completion_criteria="next view is visible",
        text_values=[],
        max_steps=4,
        max_duration_seconds=30,
        decision_config=JevConfig(api_key="secret"),
        observe=observe,
        act=act,
        get_observation=lambda: current,
        is_stopped=lambda: False,
    )

    assert result["status"] == "done_pending_verification"
    assert observe_calls >= 3
    assert actions == [
        (
            "click",
            {
                "pid": 42,
                "window_id": 7,
                "scope": "window",
                "element_token": "s1:0",
            },
        )
    ]
