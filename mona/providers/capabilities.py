"""Unified model capability queries.

Business code asks ``provider.get_capabilities(model)`` instead of
hard-coding model names. Resolution order:

  1. Per-model pattern overrides in ``_MODEL_PATTERN_CAPS`` (first match wins,
     case-insensitive substring match on the model name).
  2. Provider-level defaults declared on the ``ProviderSpec``.
  3. ``None`` (unknown) — callers must treat unknown as "feature not
     advertised", not as "supported".

Keep this table curated and conservative: only record capabilities we are
confident about. Unknown is always safer than wrong.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from mona.providers.registry import ProviderSpec


@dataclass(frozen=True)
class ModelCapabilities:
    """What a (provider, model) pair can do. ``None`` means unknown."""

    supports_vision: bool | None = None
    supports_tool_calling: bool | None = None
    supports_streaming: bool = True
    supports_json_mode: bool | None = None

    def to_dict(self) -> dict[str, bool | None]:
        return {
            "supports_vision": self.supports_vision,
            "supports_tool_calling": self.supports_tool_calling,
            "supports_streaming": self.supports_streaming,
            "supports_json_mode": self.supports_json_mode,
        }


# (substring pattern, capability overrides). First match wins; more specific
# patterns must come before broader ones.
_MODEL_PATTERN_CAPS: tuple[tuple[str, dict[str, bool]], ...] = (
    # --- vision-capable families -----------------------------------------
    ("qwen-vl", {"supports_vision": True}),
    ("qwen3-vl", {"supports_vision": True}),
    ("qwen2.5-vl", {"supports_vision": True}),
    ("glm-4v", {"supports_vision": True}),
    ("glm-4.5v", {"supports_vision": True}),
    ("gpt-4o", {"supports_vision": True, "supports_json_mode": True}),
    ("gpt-4.1", {"supports_vision": True, "supports_json_mode": True}),
    ("gpt-5", {"supports_vision": True, "supports_json_mode": True}),
    ("gpt-4-turbo", {"supports_vision": True, "supports_json_mode": True}),
    ("claude", {"supports_vision": True, "supports_tool_calling": True}),
    ("gemini", {"supports_vision": True, "supports_tool_calling": True}),
    # --- text-only families -------------------------------------------------
    ("gpt-3.5", {"supports_vision": False, "supports_json_mode": True}),
    ("deepseek", {"supports_vision": False, "supports_tool_calling": True}),
    ("qwen-turbo", {"supports_vision": False}),
    ("qwen-plus", {"supports_vision": False}),
    ("qwen-max", {"supports_vision": False}),
    ("qwen3-coder", {"supports_vision": False}),
    ("moonshot-v1", {"supports_vision": False}),
)


def resolve_capabilities(
    spec: ProviderSpec | None,
    model: str,
) -> ModelCapabilities:
    """Resolve capabilities for a (provider spec, model) pair."""
    overrides: dict[str, bool] = {}
    model_lower = (model or "").lower()
    for pattern, caps in _MODEL_PATTERN_CAPS:
        if pattern in model_lower:
            overrides = caps
            break

    provider_defaults: dict[str, bool | None] = {}
    if spec is not None:
        provider_defaults = {
            "supports_vision": spec.supports_vision,
            "supports_tool_calling": spec.supports_tool_calling,
            "supports_json_mode": spec.supports_json_mode,
        }

    merged = {**provider_defaults, **overrides}
    return ModelCapabilities(
        supports_vision=merged.get("supports_vision"),
        supports_tool_calling=merged.get("supports_tool_calling"),
        supports_streaming=True,
        supports_json_mode=merged.get("supports_json_mode"),
    )
