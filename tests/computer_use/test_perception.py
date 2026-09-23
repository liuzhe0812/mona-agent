from __future__ import annotations

import base64
import io
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image

from mona.computer_use.actions import (
    action_signature,
    remember_observation,
    remember_pending_action,
)
from mona.computer_use.perception import (
    add_visual_candidates,
    build_observation,
    public_observation,
)


def _image_result(
    width: int = 100,
    height: int = 100,
    *,
    elements=(),
    pixel: tuple[int, int, tuple[int, int, int]] | None = None,
) -> SimpleNamespace:
    image = Image.new("RGB", (width, height), "black")
    if pixel:
        image.putpixel((pixel[0], pixel[1]), pixel[2])
    output = io.BytesIO()
    image.save(output, format="PNG")
    return SimpleNamespace(
        content=[
            SimpleNamespace(
                type="image",
                mimeType="image/png",
                data=base64.b64encode(output.getvalue()).decode("ascii"),
            )
        ],
        structuredContent={"elements": list(elements)},
    )


def _observation(*, pixel=None) -> dict:
    return build_observation(
        name="get_window_state",
        arguments={"pid": 7, "window_id": 11},
        result=_image_result(
            elements=[
                {
                    "element_token": "uia:continue",
                    "role": "button",
                    "label": "Continue",
                    "frame": {"x": 10, "y": 10, "w": 20, "h": 20},
                    "actions": ["click"],
                }
            ],
            pixel=pixel,
        ),
    )


def test_observation_keeps_all_tokens_and_does_not_guess_uia_frame_space() -> None:
    elements = [
        {
            "element_token": f"token-{index}",
            "role": "checkbox",
            "label": f"Item {index}",
            "frame": {"x": 1, "y": 2, "w": 10, "h": 10},
            "value": "yes",
            "checked": True,
            "disabled": False,
            "actions": ["click", "set_value"],
        }
        for index in range(200)
    ]

    observation = build_observation(
        name="get_window_state",
        arguments={"pid": 7, "window_id": 11},
        result=_image_result(elements=elements),
    )

    assert len(observation["tokens"]) == 200
    assert len(observation["candidates"]) == 160
    assert observation["candidates_truncated"] is True
    assert observation["token_candidates"]["token-199"]["role"] == "checkbox"
    assert "token_candidates" not in public_observation(observation)
    observation["geometry"] = (80, 80, 250, 336, 96)
    public = public_observation(observation)
    assert "geometry" not in public
    assert "raw_frame" not in public["candidates"][0]
    first = observation["candidates"][0]
    assert first["raw_frame"] == {"x": 1.0, "y": 2.0, "w": 10.0, "h": 10.0}
    assert first["frame"] is None
    assert first["value"] == "yes"
    assert first["checked"] is True
    assert first["disabled"] is False
    assert first["actions"] == ["click", "set_value"]


def test_non_observation_result_preserves_last_observation_and_failed_focus_clears_pending() -> None:
    turn = SimpleNamespace(observation=_observation(), pending_action=None)
    remember_pending_action(
        turn,
        "click",
        {"pid": 7, "window_id": 11, "element_token": "uia:continue"},
    )
    previous = turn.observation

    remember_observation(turn, "bring_to_front", {}, {"ok": True})
    assert turn.observation is previous
    assert turn.pending_action is not None

    remember_observation(turn, "bring_to_front", {}, {"ok": False})
    assert turn.observation is previous
    assert turn.pending_action is None


def test_observation_for_another_window_cannot_verify_pending_action() -> None:
    turn = SimpleNamespace(observation=_observation(), pending_action=None)
    remember_pending_action(
        turn,
        "click",
        {"pid": 7, "window_id": 11, "element_token": "uia:continue"},
    )

    remember_observation(
        turn,
        "get_window_state",
        {"pid": 8, "window_id": 12},
        _image_result(),
    )

    assert turn.pending_action is None
    assert not hasattr(turn, "last_action_effect")


def test_action_signature_uses_candidate_identity_instead_of_observation_token() -> None:
    observation = _observation()
    first = action_signature(
        "click",
        {"pid": 7, "window_id": 11, "element_token": "uia:continue"},
        observation=observation,
    )
    observation["candidates"][0]["element_token"] = "uia:refreshed"
    second = action_signature(
        "click",
        {"pid": 7, "window_id": 11, "element_token": "uia:refreshed"},
        observation=observation,
    )
    assert first == second
    assert "uia:continue" not in first
    assert "uia:refreshed" not in second


@pytest.mark.asyncio
async def test_visual_candidates_cache_and_explicit_error_status() -> None:
    provider = SimpleNamespace(
        chat_with_retry=AsyncMock(
            return_value=SimpleNamespace(
                finish_reason="stop",
                content=(
                    '{"summary":"screen","candidates":['
                    '{"label":"Tile","role":"tile","frame":'
                    '{"x":10,"y":10,"w":20,"h":20},"actions":[]}]}'
                ),
            )
        )
    )
    cache: dict = {}
    first = _observation()
    second = _observation()

    await add_visual_candidates(
        first,
        goal="inspect the tile",
        provider=provider,
        model="vision",
        cache=cache,
    )
    await add_visual_candidates(
        second,
        goal="inspect the tile",
        provider=provider,
        model="vision",
        cache=cache,
    )

    provider.chat_with_retry.assert_awaited_once()
    assert second["perception_status"]["status"] == "ready"
    assert second["perception_status"]["cache"] == "exact"
    assert second["candidates"][-1]["actions"] == []

    failing = SimpleNamespace(
        chat_with_retry=AsyncMock(side_effect=RuntimeError("vision unavailable"))
    )
    failed = _observation()
    await add_visual_candidates(
        failed,
        goal="inspect the tile",
        provider=failing,
        model="vision",
    )
    assert failed["perception_status"]["status"] == "error"
    assert failed["perception_status"]["error"] == "vision_request_failed:RuntimeError"


@pytest.mark.asyncio
async def test_visual_cache_merge_is_capped_and_roi_is_refreshed() -> None:
    many = ",".join(
        '{"label":"item-%d","role":"tile","frame":{"x":1,"y":1,"w":2,"h":2},"actions":[]}'
        % index
        for index in range(161)
    )
    provider = SimpleNamespace(
        chat_with_retry=AsyncMock(
            side_effect=[
                SimpleNamespace(
                    finish_reason="stop",
                    content=f'{{"summary":"many","candidates":[{many}]}}',
                ),
                SimpleNamespace(
                    finish_reason="stop",
                    content=(
                        '{"summary":"changed","candidates":['
                        '{"label":"new","role":"tile","frame":'
                        '{"x":5,"y":5,"w":5,"h":5},"actions":[]}]}'
                    ),
                ),
            ]
        )
    )
    cache: dict = {}
    first = _observation()
    await add_visual_candidates(
        first,
        goal="inspect",
        provider=provider,
        model="vision",
        cache=cache,
    )
    second = _observation(pixel=(20, 20, (255, 255, 255)))
    await add_visual_candidates(
        second,
        goal="inspect",
        provider=provider,
        model="vision",
        cache=cache,
    )

    assert len(first["candidates"]) == 160
    assert first["candidates_truncated"] is True
    assert second["perception_status"]["coverage"] == "changed_roi"
    assert provider.chat_with_retry.await_args_list[1].kwargs["reasoning_effort"] == "none"


@pytest.mark.asyncio
async def test_local_refresh_preserves_unchanged_identity_without_inheriting_changed_state():
    def tile(x, state=None):
        result = {"label": "same label", "role": "tile", "frame": {"x": x, "y": x, "w": 10, "h": 10}, "actions": ["click"]}
        if state:
            result.update(state=state, relations=["beside another tile"])
        return result

    provider = SimpleNamespace(chat_with_retry=AsyncMock(side_effect=[
        SimpleNamespace(content=json.dumps({"summary": "full scene", "candidates": [tile(10, "old"), tile(80, "idle")]})),
        SimpleNamespace(content=json.dumps({"summary": "target updated", "candidates": [tile(6)]})),
    ]))
    cache = {}
    first = _observation()
    await add_visual_candidates(first, goal="inspect", provider=provider, model="vision", cache=cache)
    changed = _observation(pixel=(20, 20, (255, 255, 255)))
    await add_visual_candidates(changed, goal="inspect", provider=provider, model="vision", cache=cache)
    visual = {c["id"]: c for c in changed["candidates"] if c["source"] == "vision"}
    assert visual["vision:1"]["state"] == "idle"
    assert visual["vision:1"]["relations"] == ["beside another tile"]
    assert "vision:0" not in visual
    assert "state" not in visual["vision:2"]
    assert "full scene" in changed["summary"] and "target updated" in changed["summary"]
    repeated = _observation(pixel=(20, 20, (255, 255, 255)))
    await add_visual_candidates(repeated, goal="inspect", provider=provider, model="vision", cache=cache)
    assert repeated["candidates"] == changed["candidates"]
    assert provider.chat_with_retry.await_count == 2


def test_native_action_inference_respects_driver_actions_and_readonly():
    observation = build_observation(name="get_window_state", arguments={"pid": 7, "window_id": 11}, result=_image_result(elements=[
        {"role": "Button", "element_token": "a"},
        {"role": "Button", "element_token": "b", "actions": []},
        {"role": "Edit", "element_token": "c", "readonly": True},
        {"role": "TextBox", "element_token": "d"},
    ]))
    assert [c["actions"] for c in observation["candidates"]] == [["click"], [], [], ["type"]]
