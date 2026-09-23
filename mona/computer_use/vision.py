"""Bind perception to the current Agent or an explicitly configured provider."""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

from mona.computer_use.perception import add_visual_candidates


def vision_binding(config: Any, provider: Any, model: str | None) -> tuple[Any, str | None]:
    selection = config.tools.computer_use.vision_model_preset
    if selection:
        from mona.config.schema import ModelPresetConfig
        from mona.providers.factory import make_provider

        # Old saved model-only choices refer to the global default provider,
        # never to whichever Agent happens to be handling this task.
        provider_id, separator, selected_model = selection.partition(":")
        if not separator:
            selected_model = selection
            provider_id = config.get_provider_name(config.agents.defaults.model) or "auto"
        preset = ModelPresetConfig(provider=provider_id, model=selected_model)
        provider = make_provider(config, preset=preset)
        model = selected_model
    if provider is None or not model:
        return None, model
    if provider.get_capabilities(model).supports_vision is not True:
        return None, model
    return provider, model


async def enrich_observation(
    observation: dict,
    *,
    goal: str,
    config: Any,
    provider: Any,
    model: str | None,
    cache: dict,
) -> dict:
    """Structured vision for the decision loop; ordinary screenshots bypass it."""
    selection = config.tools.computer_use.vision_model_preset
    binding_key = (selection, id(provider), model)
    if selection:
        binding_key = (selection, hashlib.sha256(config.providers.model_dump_json().encode()).hexdigest())
    if cache.get("binding_key") != binding_key:
        # Provider changes invalidate cached interpretations even if model IDs match.
        cache.clear()
        try:
            cache["binding"] = vision_binding(config, provider, model)
        except (ValueError, RuntimeError) as exc:
            observation["perception_warning"] = f"Visual model configuration is unavailable: {type(exc).__name__}."
            cache["binding"] = (None, model)
        cache["binding_key"] = binding_key
    provider, model = cache["binding"]
    if cache.get("failure"):
        observation["perception_status"] = "unavailable"
        observation["perception_warning"] = cache["failure"]
        return observation
    if provider is None:
        observation["perception_status"] = "uia_only"
        observation["perception_warning"] = "No configured model with confirmed image capability; canvas targets require visual inspection."
        return observation
    try:
        async with asyncio.timeout(config.tools.computer_use.perception_timeout_seconds):
            await add_visual_candidates(
                observation, goal=goal, provider=provider, model=model, cache=cache
            )
            status = observation.get("perception_status", {})
            if (
                isinstance(status, dict) and status.get("status") == "unknown"
                and observation.get("refine_region") and not observation.get("refinement_attempted")
            ):
                observation["refinement_attempted"] = True
                await add_visual_candidates(
                    observation, goal=goal, provider=provider, model=model, cache=cache,
                    refine_region=observation["refine_region"],
                )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        observation["perception_status"] = "unavailable"
        observation["perception_warning"] = f"Visual perception failed: {type(exc).__name__}."
    status = observation.get("perception_status")
    status = status.get("status") if isinstance(status, dict) else status
    if status in {"unavailable", "unknown", "error"}:
        cache["failure"] = (
            observation.get("perception_warning", "Visual perception could not identify actionable objects.")
            + " Structured vision is paused for this turn. Inspect the returned screenshot directly; "
            "if the target remains unclear, report the limitation and stop instead of repeating observation or guessing coordinates."
        )
        observation["perception_warning"] = cache["failure"]
    return observation
