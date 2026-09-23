"""Validate computer actions against the last observed target."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any

_OBSERVATION_NAMES = {"get_window_state", "get_desktop_state"}


def _image_dimensions(observation: dict[str, Any], *, label: str) -> tuple[float, float]:
    try:
        width = observation["width"]
        height = observation["height"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{label} must include width and height") from exc
    if (
        isinstance(width, bool)
        or isinstance(height, bool)
        or not isinstance(width, (int, float))
        or not isinstance(height, (int, float))
        or not math.isfinite(width)
        or not math.isfinite(height)
        or width <= 0
        or height <= 0
    ):
        raise ValueError(f"{label} width and height must be finite positive numbers")
    return float(width), float(height)


def _image_crop(observation: dict[str, Any], *, label: str) -> tuple[float, float, float, float] | None:
    crop = observation.get("crop")
    if crop is None:
        return None
    if not isinstance(crop, (list, tuple)) or len(crop) != 4:
        raise ValueError(f"{label} crop must be [left, top, width, height]")
    values = tuple(crop)
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        for value in values
    ):
        raise ValueError(f"{label} crop values must be finite numbers")
    left, top, width, height = (float(value) for value in values)
    if left < 0 or top < 0 or width <= 0 or height <= 0:
        raise ValueError(f"{label} crop must have non-negative origin and positive size")
    return left, top, width, height


def _image_identifier(observation: dict[str, Any]) -> Any:
    image_id = observation.get("image_id")
    return image_id if image_id is not None else observation.get("observation_id")


def image_point_to_original(
    observation: dict[str, Any],
    x: Any,
    y: Any,
    *,
    image_id: Any = None,
    allow_edge: bool = False,
) -> tuple[float, float]:
    """Map a point from the current image or detail crop to original pixels.

    A crop stores its origin and source size as ``[left, top, width, height]``
    while ``width`` and ``height`` describe the image sent to the model.  The
    helper deliberately does not apply DPI or desktop coordinate transforms.
    """
    if not isinstance(observation, dict):
        raise ValueError("observation must be an object")
    _image_dimensions(observation, label="observation")
    if (
        isinstance(x, bool)
        or isinstance(y, bool)
        or not isinstance(x, (int, float))
        or not isinstance(y, (int, float))
        or not math.isfinite(x)
        or not math.isfinite(y)
    ):
        raise ValueError("image coordinates must be finite numbers")
    point_x, point_y = float(x), float(y)
    original_id = _image_identifier(observation)
    view = observation
    if image_id is not None and image_id != original_id:
        detail = observation.get("detail_view")
        if not isinstance(detail, dict) or image_id != detail.get("image_id"):
            raise ValueError("image_id does not match the current original or detail image")
        view = detail
    view_width, view_height = _image_dimensions(
        view, label="detail_view" if view is not observation else "observation"
    )
    upper_x = point_x <= view_width if allow_edge else point_x < view_width
    upper_y = point_y <= view_height if allow_edge else point_y < view_height
    if point_x < 0 or point_y < 0 or not upper_x or not upper_y:
        boundary = "including the right and bottom edges" if allow_edge else "excluding the right and bottom edges"
        raise ValueError(
            f"image point ({point_x}, {point_y}) is outside {view_width}x{view_height} ({boundary})"
        )

    crop = _image_crop(view, label="detail_view" if view is not observation else "observation")
    if crop is None:
        return point_x, point_y
    left, top, crop_width, crop_height = crop
    return (
        left + point_x * crop_width / view_width,
        top + point_y * crop_height / view_height,
    )


def _result_failed(result: Any) -> bool:
    if isinstance(result, str):
        if result.startswith("Error"):
            return True
        try:
            result = json.loads(result)
        except (TypeError, ValueError):
            return False
    if isinstance(result, dict):
        return result.get("ok") is False or result.get("isError") is True
    return bool(getattr(result, "isError", False))


def _same_target(before: dict[str, Any], after: dict[str, Any]) -> bool:
    for key in ("scope", "pid", "window_id"):
        if key in before or key in after:
            if before.get(key) != after.get(key):
                return False
    return True


def _candidate_identity(
    observation: dict[str, Any] | None,
    token: str | None,
) -> dict[str, Any]:
    if observation is not None and token:
        indexed = observation.get("token_candidates", {}).get(token)
        if isinstance(indexed, dict):
            return {
                "role": indexed.get("role"),
                "label": indexed.get("label"),
                "raw_frame": indexed.get("raw_frame"),
            }
        for candidate in observation.get("candidates", []):
            if isinstance(candidate, dict) and candidate.get("element_token") == token:
                return {
                    "role": candidate.get("role"),
                    "label": candidate.get("label"),
                    "raw_frame": candidate.get("raw_frame"),
                }
    return {"role": None, "label": None, "raw_frame": None}


def remember_observation(turn: Any, name: str, arguments: dict, result: Any) -> dict | None:
    from mona.computer_use.perception import build_observation, target_change_score

    if name not in _OBSERVATION_NAMES:
        pending = getattr(turn, "pending_action", None)
        if pending is not None and _result_failed(result):
            # Failed focus/dispatch must not be measured as the requested action.
            turn.pending_action = None
        return None
    observation = build_observation(name=name, arguments=arguments, result=result)
    if observation is None:
        turn.observation = None
        return None
    pending = getattr(turn, "pending_action", None)
    if pending and pending.get("before") is not None and not _same_target(
        pending.get("target", {}), observation
    ):
        # A screenshot for another window/desktop cannot verify this action.
        turn.pending_action = None
        pending = None
    if pending and pending.get("before") is not None:
        score = target_change_score(
            pending["before"],
            observation,
            frame=pending.get("frame"),
        )
        changed = score >= 0.08
        signature = pending["signature"]
        last_signature = getattr(turn, "last_action_signature", None)
        no_progress = int(getattr(turn, "consecutive_no_progress", 0))
        if not changed and signature == last_signature:
            turn.consecutive_no_progress = no_progress + 1
        elif not changed:
            turn.consecutive_no_progress = 1
        else:
            turn.consecutive_no_progress = 0
        turn.last_action_signature = signature
        turn.last_action_effect = {
            "changed": changed,
            "change_score": round(score, 4),
            "action": pending["action"],
            "signature": signature,
            "consecutive_no_progress": turn.consecutive_no_progress,
        }
        observation["last_action_effect"] = turn.last_action_effect
        turn.pending_action = None
    turn.observation = observation
    return observation


def action_signature(
    action: str,
    arguments: dict[str, Any],
    *,
    observation: dict[str, Any] | None = None,
) -> str:
    selected = {
        key: arguments.get(key)
        for key in (
            "pid", "window_id", "x", "y",
            "from_x", "from_y", "to_x", "to_y", "key", "keys",
        )
        if arguments.get(key) is not None
    }
    selected["scope"] = arguments.get("scope", "window")
    token = arguments.get("element_token")
    if isinstance(token, str):
        # Element tokens are observation-local. Use candidate identity instead.
        selected["target"] = _candidate_identity(observation, token)
    for sensitive in ("text", "value"):
        value = arguments.get(sensitive)
        if isinstance(value, str):
            selected[sensitive] = hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]
    return json.dumps([action, selected], ensure_ascii=False, sort_keys=True)


def repeated_no_progress_error(turn: Any, action: str, arguments: dict[str, Any]) -> str | None:
    if (
        getattr(turn, "consecutive_no_progress", 0) >= 2
        and getattr(turn, "last_action_signature", None)
        == action_signature(action, arguments, observation=getattr(turn, "observation", None))
    ):
        return "The same computer action made no visible progress twice. Re-locate the target or hand control back."
    return None


def remember_pending_action(turn: Any, action: str, arguments: dict[str, Any]) -> None:
    observation = turn.observation
    frame = None
    if observation:
        token = arguments.get("element_token")
        if token:
            indexed = observation.get("token_candidates", {}).get(token)
            if isinstance(indexed, dict):
                frame = indexed.get("frame")
            else:
                frame = next(
                    (
                        candidate.get("frame")
                        for candidate in observation.get("candidates", [])
                        if candidate.get("element_token") == token
                    ),
                    None,
                )
        elif arguments.get("x") is not None and arguments.get("y") is not None:
            frame = {
                "x": float(arguments["x"]) - 3,
                "y": float(arguments["y"]) - 3,
                "w": 6.0,
                "h": 6.0,
            }
    turn.pending_action = {
        "action": action,
        "signature": action_signature(action, arguments, observation=observation),
        "frame": frame,
        "before": observation,
        "target": {
            key: observation.get(key)
            for key in ("scope", "pid", "window_id")
        } if observation else {},
    }


def validate_action(action: str, arguments: dict, observation: dict | None) -> str | None:
    if "element_index" in arguments or "snapshot_id" in arguments:
        return "Use element_token from the latest observation, not element_index/snapshot_id."
    if arguments.get("from_zoom"):
        return "Use coordinates from the original window screenshot, not the zoom preview."
    if "target" in arguments:
        return "Use pid/window_id for a window, or scope='desktop' after a desktop observation."
    if action == "launch":
        return None
    if observation is None:
        return "Observe the target with computer_observe window/desktop before acting again."
    scope = arguments.get("scope", "window")
    if scope != observation["scope"]:
        return "Target differs from the last screenshot. Observe that target before acting."
    if scope == "window":
        if any(arguments.get(key) != observation[key] for key in ("pid", "window_id")):
            return "Pass the exact pid and window_id from the last window observation."
    elif any(key in arguments for key in ("pid", "window_id", "element_token")):
        return "Desktop actions cannot contain window IDs or element tokens."
    coordinates = {key for key in ("x", "y", "from_x", "from_y", "to_x", "to_y") if key in arguments}
    token = arguments.get("element_token")
    if token is not None:
        if not isinstance(token, str):
            return "element_token must be a string from the latest observation."
        if coordinates:
            return "Use either element_token OR screenshot coordinates, never both."
        if token not in observation["tokens"]:
            return "Unknown or stale element_token. Observe the window again."
    if action in {"click", "double_click", "right_click"} and token is None:
        if not {"x", "y"} <= coordinates:
            return "A click requires either element_token or both x and y."
    if action == "drag" and not {"from_x", "from_y", "to_x", "to_y"} <= coordinates:
        return "A drag requires both from_x/from_y and to_x/to_y."
    for x_name, y_name in (("x", "y"), ("from_x", "from_y"), ("to_x", "to_y")):
        if x_name not in coordinates and y_name not in coordinates:
            continue
        for key, maximum in ((x_name, observation["width"]), (y_name, observation["height"])):
            value = arguments.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                return f"{x_name}/{y_name} must be a pair of finite screenshot coordinates."
            if not 0 <= value < maximum:
                return f"{key} is outside the latest screenshot ({observation['width']}x{observation['height']})."
    return None
