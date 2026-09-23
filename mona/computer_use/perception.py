"""Structured Computer Use perception and visual-effect checks."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import re
import time
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageStat

_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)
_MAX_CANDIDATES = 160
_MAX_STATE_LENGTH = 160
_MAX_RELATION_LENGTH = 160
_MAX_RELATIONS = 24
_MAX_SUMMARY_LENGTH = 1600
_LOCAL_FRAME_SPACES = frozenset({
    "window",
    "window_local",
    "screenshot",
    "screenshot_local",
})
_VISUAL_CHANGE_THRESHOLD = 0.08


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _raw_frame(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    x = _finite_number(value.get("x"))
    y = _finite_number(value.get("y"))
    width = _finite_number(value.get("w", value.get("width")))
    height = _finite_number(value.get("h", value.get("height")))
    if x is None or y is None or width is None or height is None:
        return None
    if width <= 0 or height <= 0:
        return None
    return {"x": x, "y": y, "w": width, "h": height}


def _frame(
    value: Any,
    width: int,
    height: int,
    *,
    space: Any = None,
) -> dict[str, float] | None:
    raw = _raw_frame(value)
    normalized_space = str(space or "").strip().lower()
    if raw is None or normalized_space not in _LOCAL_FRAME_SPACES:
        return None
    if raw["x"] < 0 or raw["y"] < 0:
        return None
    if raw["x"] + raw["w"] > width or raw["y"] + raw["h"] > height:
        return None
    return raw


def _actions(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if isinstance(item, str) and item and item not in result:
            result.append(item)
    return result


def _short_text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = " ".join(value.split())
    return value[:limit] if value else None


def _relations(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        relation = _short_text(item, _MAX_RELATION_LENGTH)
        if relation and relation not in result:
            result.append(relation)
        if len(result) >= _MAX_RELATIONS:
            break
    return result


def _inferred_actions(element: dict[str, Any]) -> list[str]:
    """Use only the driver's actions or a small, explicit UIA role mapping."""
    if "actions" in element:
        return _actions(element["actions"])
    if "supported_actions" in element:
        return _actions(element["supported_actions"])
    role = re.sub(r"[\s_-]+", "", str(element.get("role") or "").lower())
    if role in {"button", "menuitem", "checkbox", "radiobutton"}:
        return ["click"]
    if role in {"edit", "textbox"} and not any(
        element.get(key) is True for key in ("readonly", "read_only", "is_read_only")
    ):
        return ["type"]
    return []


def _frame_space(element: dict[str, Any], structured: dict[str, Any]) -> str | None:
    value = element.get("frame_space", element.get("coordinate_space"))
    if value is None:
        value = structured.get("frame_space", structured.get("coordinate_space"))
    return str(value).strip().lower() if value is not None else None


def _same_target(before: dict[str, Any], after: dict[str, Any]) -> bool:
    for key in ("scope", "pid", "window_id"):
        if key in before or key in after:
            if before.get(key) != after.get(key):
                return False
    return True


def build_observation(
    *,
    name: str,
    arguments: dict[str, Any],
    result: Any,
) -> dict[str, Any] | None:
    if name not in {"get_window_state", "get_desktop_state"}:
        return None
    structured = getattr(result, "structuredContent", None) or getattr(
        result, "structured_content", None
    ) or {}
    screenshot: bytes | None = None
    mime_type = "image/png"
    for block in getattr(result, "content", None) or []:
        if getattr(block, "type", None) == "image" or hasattr(block, "mimeType"):
            screenshot = base64.b64decode(block.data)
            mime_type = getattr(block, "mimeType", None) or getattr(
                block, "mime_type", "image/png"
            )
            break
    if screenshot is None:
        return None
    with Image.open(io.BytesIO(screenshot)) as image:
        width, height = image.size
        thumb = image.convert("L").resize((32, 32))
        perceptual = hashlib.sha256(thumb.tobytes()).hexdigest()
    elements = structured.get("elements", [])
    if not isinstance(elements, list):
        elements = []
    candidates: list[dict[str, Any]] = []
    tokens: set[str] = set()
    token_candidates: dict[str, dict[str, Any]] = {}
    candidate_total = 0
    for index, element in enumerate(elements):
        if not isinstance(element, dict):
            continue
        token = element.get("element_token")
        raw_frame = _raw_frame(element.get("frame", element.get("bounds")))
        space = _frame_space(element, structured)
        normalized_frame = _frame(
            element.get("frame", element.get("bounds")),
            width,
            height,
            space=space,
        )
        if isinstance(token, str) and token:
            tokens.add(token)
            token_candidates.setdefault(
                token,
                {
                    "role": str(element.get("role") or "control"),
                    "label": str(element.get("label") or "")[:300],
                    "raw_frame": raw_frame,
                    "frame": normalized_frame,
                    "actions": _inferred_actions(element),
                },
            )
        candidate_total += 1
        if len(candidates) >= _MAX_CANDIDATES:
            continue
        candidate: dict[str, Any] = {
            "id": f"uia:{index}",
            "source": "uia",
            "role": str(element.get("role") or "control"),
            "label": str(element.get("label") or "")[:300],
            "frame": normalized_frame,
            "raw_frame": raw_frame,
            "frame_space": space,
            "element_token": token if isinstance(token, str) and token else None,
            "actions": _inferred_actions(element),
            "confidence": 1.0,
        }
        if element.get("frame", element.get("bounds")) is not None and raw_frame is None:
            candidate["frame_error"] = "invalid_frame"
        for field in (
            "value",
            "checked",
            "disabled",
            "enabled",
            "selected",
            "expanded",
            "focused",
        ):
            if field in element:
                candidate[field] = element[field]
        candidates.append(candidate)
    scope = "desktop" if name == "get_desktop_state" else "window"
    return {
        "observation_id": str(structured.get("snapshot_id") or f"obs-{time.time_ns()}"),
        "image_id": f"image-{time.time_ns()}",
        "captured_at": time.time(),
        "scope": scope,
        "pid": arguments.get("pid"),
        "window_id": arguments.get("window_id"),
        "coordinate_space": scope,
        "screenshot_geometry": {
            "scope": scope,
            "width": width,
            "height": height,
            "pid": arguments.get("pid"),
            "window_id": arguments.get("window_id"),
        },
        "width": width,
        "height": height,
        "mime_type": mime_type,
        "screenshot": screenshot,
        "screenshot_sha256": hashlib.sha256(screenshot).hexdigest(),
        "perceptual_hash": perceptual,
        "tokens": tokens,
        "token_candidates": token_candidates,
        "candidates": candidates,
        "candidates_truncated": candidate_total > _MAX_CANDIDATES,
        "summary": "",
        "state": "",
        "relations": [],
        "perception_status": {
            "status": "unknown",
            "coverage": "uia",
            "candidate_count": len(candidates),
        },
        "structured": structured,
    }


def observation_data_url(observation: dict[str, Any]) -> str:
    encoded = base64.b64encode(observation["screenshot"]).decode("ascii")
    return f"data:{observation.get('mime_type', 'image/png')};base64,{encoded}"


def make_detail_view(observation: dict[str, Any], region: dict) -> dict:
    """Keep just one enlarged view of the current original screenshot."""
    frame = _frame(region, observation["width"], observation["height"], space="window")
    if frame is None:
        raise ValueError("Region must be a positive rectangle inside the current screenshot")
    left, top = math.floor(frame["x"]), math.floor(frame["y"])
    right, bottom = math.ceil(frame["x"] + frame["w"]), math.ceil(frame["y"] + frame["h"])
    with Image.open(io.BytesIO(observation["screenshot"])) as original:
        detail = original.crop((left, top, right, bottom))
        factor = min(2.0, 1024 / max(detail.size))
        detail = detail.resize((max(1, round(detail.width * factor)), max(1, round(detail.height * factor))), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        detail.save(output, format="PNG")
    view = {
        "image_id": f"detail-{time.time_ns()}", "width": detail.width, "height": detail.height,
        "crop": [left, top, right - left, bottom - top], "screenshot": output.getvalue(),
        "mime_type": "image/png",
    }
    observation["detail_view"] = view
    return view


def preview_point(observation: dict[str, Any], x: float, y: float) -> str:
    """Annotate a planned point without changing the observation or sending input."""
    with Image.open(io.BytesIO(observation["screenshot"])) as original:
        marked = original.convert("RGB")
        draw = ImageDraw.Draw(marked)
        radius = max(6, min(18, min(marked.size) // 30))
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), outline="red", width=2)
        draw.line((x - radius - 3, y, x + radius + 3, y), fill="red", width=2)
        draw.line((x, y - radius - 3, x, y + radius + 3), fill="red", width=2)
        output = io.BytesIO()
        marked.save(output, format="PNG")
    return observation_data_url({"screenshot": output.getvalue(), "mime_type": "image/png"})


def _parse_json_text(text: str) -> dict[str, Any]:
    raw = text.strip()
    match = _JSON_FENCE_RE.search(raw)
    if match:
        raw = match.group(1).strip()
    if not raw.startswith("{"):
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            raw = raw[start : end + 1]
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("visual perception response must be an object")
    return payload


def _set_perception_status(
    observation: dict[str, Any],
    status: str,
    coverage: str,
    **details: Any,
) -> None:
    observation["perception_status"] = {
        "status": status,
        "coverage": coverage,
        **details,
    }


def _visual_cache_key(
    observation: dict[str, Any],
    *,
    goal: str,
    model: str | None,
) -> str:
    target = {
        key: observation.get(key)
        for key in ("scope", "pid", "window_id", "width", "height", "geometry")
    }
    return json.dumps(
        [target, model or "", goal.strip()],
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )


def _crop_observation(
    observation: dict[str, Any],
    box: tuple[int, int, int, int],
) -> tuple[dict[str, Any], tuple[int, int]]:
    with Image.open(io.BytesIO(observation["screenshot"])) as image:
        left, top, right, bottom = box
        cropped = image.crop((left, top, right, bottom))
        output = io.BytesIO()
        cropped.save(output, format="PNG")
        data = output.getvalue()
    cropped_observation = dict(observation)
    cropped_observation.update(
        {
            "screenshot": data,
            "width": right - left,
            "height": bottom - top,
            "screenshot_sha256": hashlib.sha256(data).hexdigest(),
            "crop": [left, top, right - left, bottom - top],
        }
    )
    return cropped_observation, (left, top)


def _changed_visual_region(
    previous: dict[str, Any],
    current: dict[str, Any],
    candidates: list[dict[str, Any]],
) -> tuple[int, int, int, int] | list[Any] | None:
    if not _same_target(previous, current):
        return None
    if previous.get("width") != current.get("width") or previous.get("height") != current.get("height"):
        return None
    with Image.open(io.BytesIO(previous["screenshot"])) as left, Image.open(io.BytesIO(current["screenshot"])) as right:
        difference = ImageChops.difference(left.convert("RGB"), right.convert("RGB")).convert("L")
        region = difference.point(lambda value: 255 if value > 8 else 0).getbbox()
    if region is None:
        return []
    frames = [
        candidate.get("frame")
        for candidate in candidates
        if isinstance(candidate.get("frame"), dict)
    ]
    # Include changes outside old candidates: a new dialog must not be ignored.
    changed = [frame for frame in frames if _overlaps(frame, region)]
    margin = 16
    left = max(0, int(min([region[0], *[f["x"] for f in changed]])) - margin)
    top = max(0, int(min([region[1], *[f["y"] for f in changed]])) - margin)
    right = min(
        int(current["width"]),
        int(max([region[2], *[f["x"] + f["w"] for f in changed]])) + margin,
    )
    bottom = min(
        int(current["height"]),
        int(max([region[3], *[f["y"] + f["h"] for f in changed]])) + margin,
    )
    return (left, top, right, bottom) if (right - left) * (bottom - top) < current["width"] * current["height"] * 0.6 else None


def _overlaps(left: dict[str, float], right: tuple[int, int, int, int]) -> bool:
    return not (
        left["x"] + left["w"] <= right[0]
        or left["y"] + left["h"] <= right[1]
        or right[2] <= left["x"]
        or right[3] <= left["y"]
    )


def _visual_candidates_from_payload(
    payload: dict[str, Any],
    observation: dict[str, Any],
) -> tuple[list[dict[str, Any]], int]:
    from mona.computer_use.actions import image_point_to_original

    candidates: list[dict[str, Any]] = []
    invalid = 0
    raw_candidates = payload.get("candidates", [])
    if not isinstance(raw_candidates, list):
        return [], 1
    for item in raw_candidates:
        if not isinstance(item, dict):
            invalid += 1
            continue
        raw_frame = _raw_frame(item.get("frame"))
        frame = _frame(
            item.get("frame"),
            int(observation["width"]),
            int(observation["height"]),
            space="window",
        )
        if raw_frame is None or frame is None:
            invalid += 1
            continue
        x, y = image_point_to_original(observation, frame["x"], frame["y"])
        right, bottom = image_point_to_original(observation, frame["x"] + frame["w"], frame["y"] + frame["h"], allow_edge=True)
        mapped = {"x": x, "y": y, "w": right - x, "h": bottom - y}
        candidate: dict[str, Any] = {
            "id": f"vision:{len(candidates)}",
            "source": "vision",
            "role": str(item.get("role") or "region")[:80],
            "label": str(item.get("label") or "visual region")[:500],
            "frame": mapped,
            "raw_frame": raw_frame,
            "frame_space": "window",
            "element_token": None,
            "actions": _actions(item.get("actions")),
        }
        if "state" in item:
            state = _short_text(item.get("state"), _MAX_STATE_LENGTH)
            if state is not None:
                candidate["state"] = state
        if "relations" in item:
            candidate["relations"] = _relations(item.get("relations"))
        for field in ("value", "checked", "disabled", "enabled", "selected"):
            if field in item:
                candidate[field] = item[field]
        try:
            confidence = float(item.get("confidence", 0.5) or 0.5)
        except (TypeError, ValueError):
            confidence = 0.5
        candidate["confidence"] = confidence if math.isfinite(confidence) else 0.5
        candidates.append(candidate)
    return candidates, invalid


def _merged_summary(global_summary: str, local_update: str = "") -> str:
    global_summary = _short_text(global_summary, _MAX_SUMMARY_LENGTH) or ""
    local_update = _short_text(local_update, _MAX_SUMMARY_LENGTH) or ""
    if global_summary and local_update:
        return (
            f"Global baseline (earlier observation): {global_summary[:750]}\n"
            f"Local update: {local_update[:750]}"
        )[:_MAX_SUMMARY_LENGTH]
    return (local_update or global_summary)[:_MAX_SUMMARY_LENGTH]


async def add_visual_candidates(
    observation: dict[str, Any],
    *,
    goal: str,
    provider: Any | None,
    model: str | None,
    cache: dict[str, Any] | None = None,
    refine_region: dict | None = None,
) -> dict[str, Any]:
    """Use a multimodal provider to describe non-UIA regions with bounded caching."""
    cache_key = _visual_cache_key(observation, goal=goal, model=model)
    current_hash = observation.get("screenshot_sha256")
    cached = cache.get(cache_key) if cache is not None else None
    if refine_region is None and isinstance(cached, dict) and cached.get("screenshot_sha256") == current_hash:
        merged = [
            *observation.get("candidates", []),
            *[dict(candidate) for candidate in cached.get("candidates", [])],
        ]
        observation["candidates_truncated"] = (
            observation.get("candidates_truncated", False)
            or len(merged) > _MAX_CANDIDATES
        )
        observation["candidates"] = merged[:_MAX_CANDIDATES]
        observation["summary"] = _merged_summary(
            cached.get("global_summary", cached.get("summary", "")),
            cached.get("summary_update", ""),
        )
        observation["summary_update"] = cached.get("summary_update", "")
        cached_status = cached.get("perception_status")
        if isinstance(cached_status, dict):
            observation["perception_status"] = {
                **cached_status,
                "coverage": "cached",
                "cache": "exact",
            }
        else:
            _set_perception_status(
                observation,
                "ready",
                "cached",
                cache="exact",
                candidate_count=len(cached.get("candidates", [])),
            )
        return observation
    if provider is None:
        _set_perception_status(
            observation,
            "unknown",
            "uia_only",
            error="vision_provider_unavailable",
        )
        return observation
    visual_candidates = []
    summary = ""
    coverage = "full"
    cache_status = "miss"
    request_observation = observation
    changed_region: tuple[int, int, int, int] | list[Any] | None = None
    if refine_region is not None:
        view = make_detail_view(observation, refine_region)
        left, top, width, height = view["crop"]
        changed_region = (left, top, left + width, top + height)
        request_observation = {**observation, **view}
        coverage, cache_status = "local_refinement", "refined"
    elif isinstance(cached, dict) and isinstance(cached.get("observation"), dict):
        changed_region = _changed_visual_region(
            cached["observation"], observation, cached.get("candidates", [])
        )
        if changed_region == []:
            merged = [
                *observation.get("candidates", []),
                *[dict(candidate) for candidate in cached.get("candidates", [])],
            ]
            observation["candidates_truncated"] = (
                observation.get("candidates_truncated", False)
                or len(merged) > _MAX_CANDIDATES
            )
            observation["candidates"] = merged[:_MAX_CANDIDATES]
            observation["summary"] = _merged_summary(
                cached.get("global_summary", cached.get("summary", "")),
                cached.get("summary_update", ""),
            )
            observation["summary_update"] = cached.get("summary_update", "")
            _set_perception_status(
                observation,
                "ready",
                "cached",
                cache="unchanged_roi",
                candidate_count=len(cached.get("candidates", [])),
            )
            cached_status = cached.get("perception_status")
            if isinstance(cached_status, dict):
                observation["perception_status"] = {
                    **cached_status,
                    "coverage": "cached",
                    "cache": "unchanged_roi",
                }
            return observation
        if isinstance(changed_region, tuple):
            request_observation, _ = _crop_observation(observation, changed_region)
            coverage = "changed_roi"
            cache_status = "roi_refresh"

    prompt = (
        "Inspect this application-window screenshot for computer control. Return JSON only: "
        '{"summary":"short current state","candidates":[{"label":"what the object is and its '
        'current state","state":"short state string","relations":["short relation"],'
        '"role":"button|field|menu|unit|tile|item|region","frame":{"x":0,"y":0,'
        '"w":1,"h":1},"actions":["click"]}],"unknown":false}. Coordinates must be '
        f"window-local pixels within {request_observation['width']}x{request_observation['height']}. "
        "Keep state under 160 characters and each relation under 160 characters; return at most 24 relations. "
        "Include only useful objects missing from the accessibility tree. Do not invent actions; "
        "If small details prevent reliable identification but their region is known, return unknown:true "
        "and refine_region:{x,y,w,h} in this image's pixels. Otherwise omit refine_region. "
        "for a changed local region, summary is a local update and must not claim the whole window changed. "
        f"Current goal: {goal[:4000]}"
    )
    try:
        response = await provider.chat_with_retry(
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": observation_data_url(request_observation)},
                        },
                    ],
                }
            ],
            model=model,
            max_tokens=4096,
            temperature=0,
            reasoning_effort="none",
            retry_mode="standard",
        )
    except Exception as exc:
        _set_perception_status(
            observation,
            "error",
            coverage,
            cache=cache_status,
            error=f"vision_request_failed:{type(exc).__name__}",
        )
        return observation
    if getattr(response, "finish_reason", "") == "error" or not response.content:
        _set_perception_status(
            observation,
            "error",
            coverage,
            cache=cache_status,
            error="vision_response_empty",
        )
        return observation
    try:
        payload = _parse_json_text(str(response.content))
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        _set_perception_status(
            observation,
            "error",
            coverage,
            cache=cache_status,
            error=f"vision_json_invalid:{type(exc).__name__}",
        )
        return observation
    visual_candidates, invalid_count = _visual_candidates_from_payload(
        payload, request_observation
    )
    observation.pop("refine_region", None)
    region = _frame(payload.get("refine_region"), request_observation["width"], request_observation["height"], space="window")
    if region is not None:
        from mona.computer_use.actions import image_point_to_original

        left, top = image_point_to_original(request_observation, region["x"], region["y"])
        right, bottom = image_point_to_original(request_observation, region["x"] + region["w"], region["y"] + region["h"], allow_edge=True)
        observation["refine_region"] = {"x": left, "y": top, "w": right - left, "h": bottom - top}
    previous_candidates = (
        cached.get("candidates", []) if isinstance(cached, dict) else []
    )
    if isinstance(changed_region, tuple):
        retained = [
            candidate
            for candidate in previous_candidates
            if not isinstance(candidate.get("frame"), dict)
            or not _overlaps(candidate["frame"], changed_region)
        ]
    else:
        retained = []
    next_id = cached.get("next_id", 0) if isinstance(cached, dict) else 0
    for candidate in visual_candidates:
        candidate["id"] = f"vision:{next_id}"
        next_id += 1
    merged = [*[c for c in observation.get("candidates", []) if c.get("source") != "vision"], *retained, *visual_candidates]
    observation["candidates_truncated"] = (
        observation.get("candidates_truncated", False)
        or len(merged) > _MAX_CANDIDATES
    )
    observation["candidates"] = merged[:_MAX_CANDIDATES]
    summary_update = _short_text(payload.get("summary"), _MAX_SUMMARY_LENGTH) or ""
    if isinstance(changed_region, tuple):
        global_summary = (
            cached.get("global_summary", cached.get("summary", ""))
            if isinstance(cached, dict)
            else ""
        )
        summary = _merged_summary(global_summary, summary_update)
        observation["summary_update"] = summary_update
    else:
        global_summary = summary_update
        summary = global_summary
        observation["summary_update"] = ""
    observation["summary"] = summary
    status = "unknown" if payload.get("unknown") is True else "ready"
    if invalid_count and not visual_candidates:
        status = "error"
    _set_perception_status(
        observation,
        status,
        coverage,
        cache=cache_status,
        candidate_count=len(visual_candidates),
        invalid_candidates=invalid_count,
    )
    if cache is not None and status != "error":
        cache[cache_key] = {
            "screenshot_sha256": current_hash,
            "observation": {
                "scope": observation.get("scope"),
                "pid": observation.get("pid"),
                "window_id": observation.get("window_id"),
                "width": observation.get("width"),
                "height": observation.get("height"),
                "screenshot": observation.get("screenshot"),
                "screenshot_sha256": current_hash,
            },
            "candidates": [*retained, *visual_candidates],
            "next_id": next_id,
            "summary": summary,
            "global_summary": global_summary,
            "summary_update": observation.get("summary_update", ""),
            "perception_status": dict(observation.get("perception_status") or {}),
        }
    return observation


def target_change_score(
    before: dict[str, Any],
    after: dict[str, Any],
    *,
    frame: dict[str, float] | None = None,
) -> float:
    """Measure visible change near the acted target, ignoring distant animations."""
    if not _same_target(before, after):
        return 0.0
    with Image.open(io.BytesIO(before["screenshot"])) as left_image, Image.open(
        io.BytesIO(after["screenshot"])
    ) as right_image:
        left = left_image.convert("L")
        right = right_image.convert("L")
        if left.size != right.size:
            return 1.0
        if frame and _frame(frame, left.width, left.height, space="window"):
            margin = max(12, int(max(frame["w"], frame["h"]) * 0.75))
            box = (
                max(0, int(frame["x"]) - margin),
                max(0, int(frame["y"]) - margin),
                min(left.width, int(frame["x"] + frame["w"]) + margin),
                min(left.height, int(frame["y"] + frame["h"]) + margin),
            )
            if box[2] > box[0] and box[3] > box[1]:
                left, right = left.crop(box), right.crop(box)
        difference = ImageChops.difference(left, right)
        return min(1.0, ImageStat.Stat(difference).mean[0] / 32.0)


def public_observation(observation: dict[str, Any]) -> dict[str, Any]:
    public = {
        key: value
        for key, value in observation.items()
        if key not in {"screenshot", "structured", "tokens", "token_candidates", "geometry", "detail_view"}
    }
    # Raw UIA bounds may mix logical/screen coordinates. Only verified
    # screenshot-local frames belong in model-visible position data.
    public["candidates"] = [
        {key: value for key, value in candidate.items() if key not in {"raw_frame", "frame_space"}}
        for candidate in observation.get("candidates", [])
    ]
    if observation.get("detail_view"):
        public["detail_view"] = {key: value for key, value in observation["detail_view"].items() if key != "screenshot"}
    return public


def observation_context(observation: dict[str, Any]) -> str:
    lines = [
        "Enhanced computer observation:",
        f"observation_id={observation['observation_id']} image_sha256={observation['screenshot_sha256'][:16]}",
        f"candidates={len(observation.get('candidates', []))} screenshot={observation['width']}x{observation['height']}",
    ]
    effect = observation.get("last_action_effect")
    if effect:
        lines.append(
            "last_action changed={changed} score={change_score} no_progress={consecutive_no_progress}".format(
                **effect
            )
        )
    return "\n".join(lines)
