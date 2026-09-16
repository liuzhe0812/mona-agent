"""Validate computer actions against the last observed target."""

from __future__ import annotations

import base64
import io
import math
from typing import Any

from PIL import Image


def remember_observation(turn: Any, name: str, arguments: dict, result: Any) -> None:
    if name not in {"get_window_state", "get_desktop_state"}:
        return
    structured = getattr(result, "structuredContent", None) or getattr(result, "structured_content", None) or {}
    size = None
    for block in result.content:
        if getattr(block, "type", None) == "image" or hasattr(block, "mimeType"):
            with Image.open(io.BytesIO(base64.b64decode(block.data))) as screenshot:
                size = screenshot.size
            break
    # A tree-only response cannot ground a pixel action or confirm its effect.
    if size is None:
        turn.observation = None
        return
    turn.observation = {
        "scope": "desktop" if name == "get_desktop_state" else "window",
        "pid": arguments.get("pid"),
        "window_id": arguments.get("window_id"),
        "width": size[0],
        "height": size[1],
        "tokens": {
            element["element_token"]
            for element in structured.get("elements", [])
            if isinstance(element, dict) and element.get("element_token")
        },
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
