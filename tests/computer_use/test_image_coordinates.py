import pytest

from mona.computer_use.actions import image_point_to_original


def test_detail_view_point_is_scaled_back_to_original_pixels() -> None:
    observation = {
        "observation_id": "obs-1",
        "image_id": "original-1",
        "width": 1000,
        "height": 800,
        "detail_view": {
            "image_id": "detail-1",
            "width": 200,
            "height": 100,
            "crop": [100, 50, 400, 200],
        },
    }

    assert image_point_to_original(observation, 100, 50, image_id="detail-1") == (
        300.0,
        150.0,
    )


@pytest.mark.parametrize(
    ("x", "y", "expected"),
    [
        (0, 0, (100.0, 50.0)),
        (199, 99, (498.0, 248.0)),
    ],
)
def test_drag_endpoints_from_a_cropped_observation(
    x: int, y: int, expected: tuple[float, float]
) -> None:
    cropped = {
        "width": 200,
        "height": 100,
        "crop": [100, 50, 400, 200],
    }

    assert image_point_to_original(cropped, x, y) == expected


def test_original_point_is_identity_and_old_observation_id_is_accepted() -> None:
    observation = {"observation_id": "obs-1", "width": 1000, "height": 800}

    assert image_point_to_original(observation, 12, 34) == (12.0, 34.0)
    assert image_point_to_original(observation, 12, 34, image_id="obs-1") == (
        12.0,
        34.0,
    )


def test_unknown_image_id_and_out_of_bounds_points_are_rejected() -> None:
    observation = {
        "image_id": "original-1",
        "width": 100,
        "height": 80,
        "detail_view": {
            "image_id": "detail-1",
            "width": 20,
            "height": 20,
            "crop": [10, 10, 40, 40],
        },
    }

    with pytest.raises(ValueError, match="image_id"):
        image_point_to_original(observation, 1, 1, image_id="stale")
    with pytest.raises(ValueError, match="outside"):
        image_point_to_original(observation, 20, 1, image_id="detail-1")
    with pytest.raises(ValueError, match="outside"):
        image_point_to_original(observation, 100, 1)


def test_allow_edge_only_allows_right_and_bottom_boundary() -> None:
    observation = {"width": 100, "height": 80}

    assert image_point_to_original(observation, 100, 80, allow_edge=True) == (
        100.0,
        80.0,
    )
    with pytest.raises(ValueError):
        image_point_to_original(observation, 100, 80)
    with pytest.raises(ValueError):
        image_point_to_original(observation, -1, 0, allow_edge=True)
