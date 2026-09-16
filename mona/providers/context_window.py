"""Resolve the effective context window from model metadata."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from mona.providers.cindy_catalog import CINDY_CHAT_PROVIDER_BY_ID, CINDY_CHAT_PROVIDERS
from mona.providers.managed_catalog import managed_model_catalog

DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000


def _positive_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _canonical_model_ids(model: str) -> tuple[str, ...]:
    aliases = [model]
    unversioned = re.sub(r"-\d{4,8}$", "", model)
    if unversioned != model:
        aliases.append(unversioned)
    return tuple(aliases)


def _known_model_family_window(model: str) -> int | None:
    aliases = set(_canonical_model_ids(model))
    for entry in CINDY_CHAT_PROVIDERS:
        for item in entry.models:
            if item.id in aliases and item.context_window is not None:
                return item.context_window
    return None


@dataclass(frozen=True)
class ResolvedContextWindow:
    tokens: int
    source: str


_CONTEXT_LIMIT_MARKERS = (
    "maximum context length",
    "maximum context window",
    "context length exceeded",
    "context window exceeded",
    "context_length_exceeded",
    "context_window_exceeded",
    "context limit exceeded",
    "prompt is too long",
    "too many tokens",
)
_CONTEXT_LIMIT_VALUE = re.compile(
    r"(?:maximum\s+context(?:\s+(?:length|window))?|"
    r"context(?:\s+(?:length|window))?(?:\s+limit)?|"
    r"input(?:\s+token)?\s+limit)\D{0,40}?"
    r"(?P<value>\d{1,3}(?:[,_]\d{3})+|\d{4,9}|\d+(?:\.\d+)?\s*[km])\s*(?:tokens?)?",
    re.IGNORECASE,
)


def _parse_token_count(value: str) -> int | None:
    normalized = value.strip().lower().replace(",", "").replace("_", "")
    multiplier = 1
    if normalized.endswith("k"):
        multiplier = 1_000
        normalized = normalized[:-1].strip()
    elif normalized.endswith("m"):
        multiplier = 1_000_000
        normalized = normalized[:-1].strip()
    try:
        tokens = int(float(normalized) * multiplier)
    except ValueError:
        return None
    return tokens if tokens >= 4_096 else None


def context_window_from_error(*values: object) -> int | None:
    """Extract a provider-declared context ceiling from an error response.

    This deliberately returns ``None`` when the provider only says that the
    request is too large: guessing a ceiling would make later compaction
    destructive without improving reliability.
    """
    text = "\n".join(str(value) for value in values if value).lower()
    if not any(marker in text for marker in _CONTEXT_LIMIT_MARKERS):
        return None
    match = _CONTEXT_LIMIT_VALUE.search(text)
    return _parse_token_count(match.group("value")) if match else None


def record_discovered_context_window(
    config: Any,
    preset: Any,
    tokens: int,
) -> bool:
    """Store a provider-confirmed model window in its discovery metadata."""
    if not isinstance(tokens, int) or isinstance(tokens, bool) or tokens < 4_096:
        return False
    model = str(getattr(preset, "model", "") or "").strip()
    if not model:
        return False
    provider = config.get_provider(model, preset=preset)
    if provider is None:
        return False

    existing = list(getattr(provider, "discovered_models", None) or [])
    for index, item in enumerate(existing):
        if not isinstance(item, dict) or str(item.get("id") or "").strip() != model:
            continue
        if item.get("context_window") == tokens:
            return False
        existing[index] = {**item, "context_window": tokens}
        provider.discovered_models = existing
        return True

    existing.append({"id": model, "name": model, "context_window": tokens})
    provider.discovered_models = existing
    return True


def resolve_model_context_window_details(
    config: Any,
    preset: Any,
    *,
    provider_name: str | None = None,
    managed_catalog: dict[str, Any] | None = None,
) -> ResolvedContextWindow:
    """Resolve an effective window and retain its internal capability source."""
    model = str(preset.model or "").strip()
    resolved_provider = provider_name or config.get_provider_name(model, preset=preset)

    provider_config = config.get_provider(model, preset=preset)
    for item in (getattr(provider_config, "discovered_models", None) or []):
        if not isinstance(item, dict) or str(item.get("id") or "").strip() != model:
            continue
        detected = _positive_int(item.get("context_window", item.get("contextWindow")))
        if detected is not None:
            return ResolvedContextWindow(detected, "discovered")

    if resolved_provider == "mona_managed":
        catalog = managed_catalog if managed_catalog is not None else managed_model_catalog()
        for item in catalog.get("models", []):
            if not isinstance(item, dict) or str(item.get("id") or "").strip() != model:
                continue
            detected = _positive_int(item.get("context_window", item.get("contextWindow")))
            if detected is not None:
                return ResolvedContextWindow(detected, "catalog")
        detected = _known_model_family_window(model)
        if detected is not None:
            return ResolvedContextWindow(detected, "catalog")

    entry = CINDY_CHAT_PROVIDER_BY_ID.get(str(resolved_provider or ""))
    if entry is not None:
        for item in entry.models:
            if item.id == model and item.context_window is not None:
                return ResolvedContextWindow(item.context_window, "catalog")

    return ResolvedContextWindow(DEFAULT_CONTEXT_WINDOW_TOKENS, "default")


def resolve_model_context_window(
    config: Any,
    preset: Any,
    *,
    provider_name: str | None = None,
    managed_catalog: dict[str, Any] | None = None,
) -> int:
    """Prefer declared capability metadata, then use Mona's product default."""
    return resolve_model_context_window_details(
        config,
        preset,
        provider_name=provider_name,
        managed_catalog=managed_catalog,
    ).tokens
