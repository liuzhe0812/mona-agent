"""Ground computer actions in screenshots from the current turn."""

from __future__ import annotations

import base64
import io
from types import SimpleNamespace

import pytest
from PIL import Image

from mona.computer_use.actions import remember_observation, validate_action


def _image_result(width: int, height: int, elements=()) -> SimpleNamespace:
    png = io.BytesIO()
    Image.new("RGB", (width, height)).save(png, format="PNG")
    return SimpleNamespace(
        content=[
            SimpleNamespace(
                type="image",
                mimeType="image/png",
                data=base64.b64encode(png.getvalue()).decode("ascii"),
            )
        ],
        structuredContent={"elements": list(elements)},
    )


def _observe(scope: str, elements=()) -> dict:
    turn = SimpleNamespace(observation=None)
    name = "get_window_state" if scope == "window" else "get_desktop_state"
    arguments = {"pid": 7, "window_id": "window-11"} if scope == "window" else {}
    remember_observation(turn, name, arguments, _image_result(12, 8, elements))
    return turn.observation


@pytest.mark.parametrize(
    ("name", "arguments", "scope", "pid", "window_id"),
    [
        ("get_window_state", {"pid": 7, "window_id": "window-11"}, "window", 7, "window-11"),
        ("get_desktop_state", {}, "desktop", None, None),
    ],
)
def test_remember_observation_records_screenshot_size_and_tokens(
    name: str,
    arguments: dict,
    scope: str,
    pid: int | None,
    window_id: str | None,
) -> None:
    turn = SimpleNamespace(observation=None)
    result = _image_result(
        12,
        8,
        [{"element_token": "fresh-control"}, {"element_token": "another-control"}],
    )

    remember_observation(turn, name, arguments, result)

    assert turn.observation == {
        "scope": scope,
        "pid": pid,
        "window_id": window_id,
        "width": 12,
        "height": 8,
        "tokens": {"fresh-control", "another-control"},
    }


def test_tree_only_observation_cannot_ground_coordinate_actions() -> None:
    turn = SimpleNamespace(observation=_observe("window", [{"element_token": "old"}]))
    tree_result = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="window tree")],
        structuredContent={"elements": [{"element_token": "tree-token"}]},
    )

    remember_observation(
        turn,
        "get_window_state",
        {"pid": 7, "window_id": "window-11"},
        tree_result,
    )

    assert turn.observation is None
    assert validate_action(
        "click",
        {"pid": 7, "window_id": "window-11", "x": 2, "y": 3},
        turn.observation,
    )


def test_screenshot_with_no_elements_still_allows_canvas_coordinates() -> None:
    observation = _observe("window", elements=[])

    assert observation["tokens"] == set()
    assert validate_action(
        "click",
        {"pid": 7, "window_id": "window-11", "x": 2, "y": 3},
        observation,
    ) is None


@pytest.mark.parametrize(
    "arguments",
    [
        {"element_token": "fresh-control", "x": 2, "y": 3},
        {"element_token": "stale-control"},
    ],
)
def test_rejects_mixed_or_stale_element_tokens(arguments: dict) -> None:
    observation = _observe("window", [{"element_token": "fresh-control"}])
    action_arguments = {"pid": 7, "window_id": "window-11", **arguments}

    assert validate_action("click", action_arguments, observation)


@pytest.mark.parametrize(
    "target_change",
    [{"pid": 8}, {"window_id": "other-window"}, {"scope": "desktop"}],
)
def test_rejects_actions_for_a_different_window_or_scope(target_change: dict) -> None:
    observation = _observe("window", [{"element_token": "fresh-control"}])
    arguments = {"pid": 7, "window_id": "window-11", "x": 2, "y": 3}
    arguments.update(target_change)

    assert validate_action("click", arguments, observation)


@pytest.mark.parametrize(
    ("x", "y"),
    [
        (-1, 0),
        (12, 0),
        (0, -1),
        (0, 8),
        (float("nan"), 0),
        (0, float("nan")),
        (True, 0),
        (0, False),
    ],
)
def test_rejects_out_of_bounds_non_finite_and_boolean_coordinates(x: float, y: float) -> None:
    observation = _observe("window")

    assert validate_action(
        "click",
        {"pid": 7, "window_id": "window-11", "x": x, "y": y},
        observation,
    )


@pytest.mark.parametrize("coordinates", [{"x": 2}, {"y": 3}])
def test_click_requires_both_coordinates(coordinates: dict) -> None:
    observation = _observe("window")
    arguments = {"pid": 7, "window_id": "window-11", **coordinates}

    assert validate_action("click", arguments, observation)


@pytest.mark.parametrize(
    "coordinate_change",
    [
        {"from_x": 12},
        {"from_y": 8},
        {"to_x": 12},
        {"to_y": 8},
    ],
)
def test_drag_validates_both_coordinate_endpoints(coordinate_change: dict) -> None:
    observation = _observe("window")
    coordinates = {"from_x": 1, "from_y": 2, "to_x": 4, "to_y": 5}
    coordinates.update(coordinate_change)

    assert validate_action(
        "drag",
        {"pid": 7, "window_id": "window-11", **coordinates},
        observation,
    )


@pytest.mark.parametrize(
    "coordinates",
    [
        {"from_x": 1, "from_y": 2},
        {"to_x": 3, "to_y": 4},
        {"from_x": 1, "from_y": 2, "to_x": 3},
        {"from_x": 1, "to_x": 3, "to_y": 4},
    ],
)
def test_drag_requires_both_endpoint_pairs(coordinates: dict) -> None:
    observation = _observe("window")

    assert validate_action(
        "drag",
        {"pid": 7, "window_id": "window-11", **coordinates},
        observation,
    )


def test_accepts_current_window_token_and_coordinates_and_desktop_coordinates() -> None:
    window_observation = _observe("window", [{"element_token": "fresh-control"}])
    desktop_observation = _observe("desktop")

    assert validate_action(
        "click",
        {"pid": 7, "window_id": "window-11", "element_token": "fresh-control"},
        window_observation,
    ) is None
    assert validate_action(
        "click",
        {"pid": 7, "window_id": "window-11", "x": 2, "y": 3},
        window_observation,
    ) is None
    assert validate_action(
        "click",
        {"scope": "desktop", "x": 2, "y": 3},
        desktop_observation,
    ) is None


def test_launch_does_not_require_a_screenshot() -> None:
    assert validate_action("launch", {}, None) is None
