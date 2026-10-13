"""Provider-declared reasoning levels from model metadata.

Unknown routes never imply effort levels. Managed routes also use a reviewed
exact-ID catalog when the server omits capabilities.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

_MISSING = object()
_EFFORT_TOKEN = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
_EFFORT_ORDER = (
    "minimal",
    "minimum",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
    "adaptive",
)

# Apply this fallback only to known managed model IDs; explicit server metadata
# always wins. Never apply it to arbitrary relays.
# Reviewed 2026-09-30 for Mona's managed OpenAI-compatible Alibaba route.
_MANAGED_EFFORTS: dict[str, tuple[tuple[str, ...], str]] = {
    "glm-5.3": (("low", "high", "max"), "high"),
    "kimi-k3": (("low", "high", "max"), "high"),
    "qwen3.8-flash": (("low", "medium", "xhigh"), "medium"),
    "qwen3.8-max-0902": (("low", "medium", "xhigh"), "medium"),
    "deepseek-v4-pro-0813": (("high", "max"), "high"),
    "deepseek-v4.1-flash": (("low", "high", "max"), "high"),
}


def managed_reasoning_metadata(model: Mapping[str, Any]) -> dict[str, Any]:
    metadata = normalize_reasoning_metadata(model)
    if "reasoning_efforts" in metadata:
        return metadata
    if model.get("reasoning") is False:
        return {**metadata, "reasoning_efforts": []}
    model_id = model.get("id")
    known = _MANAGED_EFFORTS.get(model_id) if isinstance(model_id, str) else None
    if known is None:
        return metadata
    efforts, recommended = known
    return {"reasoning_efforts": list(efforts), "default_reasoning_effort": recommended, **metadata}


def _order_effort_keys(values: list[Any]) -> list[Any]:
    rank = {effort: index for index, effort in enumerate(_EFFORT_ORDER)}
    return sorted(
        values,
        key=lambda value: (
            rank.get(value.strip().lower(), len(rank))
            if isinstance(value, str)
            else len(rank),
            values.index(value),
        ),
    )


def _effort_value(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if not _EFFORT_TOKEN.fullmatch(normalized):
        return None
    if normalized == "none":
        return ""
    return normalized


def _first(mapping: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return _MISSING


def _anthropic_efforts(value: Any) -> Any:
    if value is False:
        return []
    if not isinstance(value, Mapping):
        return _MISSING
    if value.get("supported") is False:
        return []

    levels = value.get("levels", _MISSING)
    if isinstance(levels, list):
        return levels
    if isinstance(levels, Mapping):
        recognized_statuses = any(
            isinstance(status, bool)
            or (
                isinstance(status, Mapping)
                and isinstance(status.get("supported"), bool)
            )
            for status in levels.values()
        )
        if not recognized_statuses:
            return _MISSING
        supported = [
            name
            for name, status in levels.items()
            if status is True
            or (isinstance(status, Mapping) and status.get("supported") is True)
        ]
        return _order_effort_keys(supported)

    # Some catalogs put the supported flag beside each effort level.
    per_level = {
        key: status
        for key, status in value.items()
        if key != "supported"
        and (
            isinstance(status, bool)
            or (
                isinstance(status, Mapping)
                and isinstance(status.get("supported"), bool)
            )
        )
    }
    if per_level:
        supported = [
            name
            for name, status in per_level.items()
            if status is True
            or (isinstance(status, Mapping) and status.get("supported") is True)
        ]
        return _order_effort_keys(supported)
    return _MISSING


def normalize_reasoning_metadata(
    model: Mapping[str, Any], *, strict: bool = False
) -> dict[str, Any]:
    """Return only declared, bounded reasoning metadata in Mona's snake_case form.

    Discovery input is treated leniently because it comes from provider catalogs.
    Settings saves use ``strict=True`` so malformed explicit metadata is reported.
    """
    reasoning = model.get("reasoning")
    reasoning = reasoning if isinstance(reasoning, Mapping) else {}
    effort = model.get("effort")
    effort = effort if isinstance(effort, Mapping) else {}
    capabilities = model.get("capabilities")
    capabilities = capabilities if isinstance(capabilities, Mapping) else {}
    anthropic_effort = capabilities.get("effort", _MISSING)
    raw_adaptive_thinking = _first(
        model, "supports_adaptive_thinking", "supportsAdaptiveThinking"
    )
    if raw_adaptive_thinking is _MISSING:
        thinking = capabilities.get("thinking")
        thinking_types = thinking.get("types") if isinstance(thinking, Mapping) else None
        adaptive_thinking = (
            thinking_types.get("adaptive")
            if isinstance(thinking_types, Mapping)
            and "adaptive" in thinking_types
            else None
        )
        if isinstance(thinking_types, Mapping) and "adaptive" in thinking_types:
            raw_adaptive_thinking = (
                adaptive_thinking.get("supported")
                if isinstance(adaptive_thinking, Mapping)
                and "supported" in adaptive_thinking
                else adaptive_thinking
            )

    raw_efforts = _first(model, "reasoning_efforts", "reasoningEfforts")
    if raw_efforts is _MISSING:
        raw_efforts = _first(reasoning, "supportedEfforts", "supported_efforts")
    if raw_efforts is _MISSING:
        raw_efforts = model.get("supported_efforts", _MISSING)
    if raw_efforts is _MISSING:
        raw_efforts = effort.get("supported_levels", _MISSING)
    if raw_efforts is _MISSING:
        raw_efforts = _anthropic_efforts(anthropic_effort)
        if (
            strict
            and raw_efforts is _MISSING
            and anthropic_effort is not _MISSING
        ):
            raise ValueError("reasoning efforts metadata is invalid")

    raw_default = _first(
        model, "default_reasoning_effort", "defaultReasoningEffort"
    )
    if raw_default is _MISSING:
        raw_default = _first(reasoning, "defaultEffort", "default_effort")
    if raw_default is _MISSING:
        raw_default = model.get("default_effort", _MISSING)
    if raw_default is _MISSING:
        raw_default = effort.get("default_level", _MISSING)
    if raw_default is _MISSING and isinstance(anthropic_effort, Mapping):
        raw_default = _first(anthropic_effort, "defaultEffort", "default_effort", "defaultLevel", "default_level")

    normalized: dict[str, Any] = {}
    efforts: list[str] | None = None
    if raw_efforts is not _MISSING:
        if not isinstance(raw_efforts, list):
            if strict:
                raise ValueError("reasoning efforts must be an array")
        elif len(raw_efforts) > 16:
            if strict:
                raise ValueError("reasoning efforts contain too many levels")
        else:
            efforts = []
            saw_valid_level = False
            for value in raw_efforts:
                normalized_value = _effort_value(value)
                if normalized_value is None:
                    if strict:
                        raise ValueError("reasoning efforts contain an invalid level")
                    continue
                saw_valid_level = True
                if not normalized_value:
                    continue
                if normalized_value not in efforts:
                    efforts.append(normalized_value)
            if raw_efforts and not efforts and not saw_valid_level:
                efforts = None
            if efforts is not None:
                normalized["reasoning_efforts"] = efforts

    if raw_default is not _MISSING:
        if raw_default is None:
            if efforts is not None:
                normalized["default_reasoning_effort"] = None
        else:
            default = _effort_value(raw_default)
            if default is None:
                if strict:
                    raise ValueError("default reasoning effort is invalid")
            elif efforts is None or default not in efforts:
                if strict:
                    raise ValueError("default reasoning effort is not supported")
            else:
                normalized["default_reasoning_effort"] = default

    if raw_adaptive_thinking is not _MISSING:
        if isinstance(raw_adaptive_thinking, bool):
            normalized["supports_adaptive_thinking"] = raw_adaptive_thinking
        elif strict:
            raise ValueError("adaptive thinking support must be a boolean")

    return normalized
