"""Resolve model capabilities without changing a connection's URL, wire ID, or membership."""

from __future__ import annotations

import re
from collections.abc import Mapping
from functools import lru_cache
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from mona.providers.cindy_catalog import CindyChatProvider, CindyModel
from mona.providers.cindy_catalog import bundled_model_catalog as _catalog
from mona.providers.model_sources import CHAT_SOURCE_PROVIDER_BY_ID
from mona.providers.reasoning import normalize_reasoning_metadata, supported_default_effort

_PUBLIC_FIELDS = ("name", "input_modalities", "context_window", "reasoning_efforts", "default_reasoning_effort", "supports_adaptive_thinking")
_VENDOR_PREFIX = re.compile(r"^(?:openai|anthropic|google|x-ai|xai|deepseek|qwen)/")
_MODEL_SIZE = re.compile(r"^[a-z][a-z/-]*?\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?[kmbt](?=[-_/.:]|$)")
_GENERATION = re.compile(r"^([a-z][a-z/-]*?)(\d{1,3}(?:[.-]\d{1,3}(?=[.-]|$))*)([^0-9].*|$)")


def positive_token_count(value: Any) -> int | None:
    if isinstance(value, str):
        value = value.strip()
        if len(value) <= 16 and value.isascii() and value.isdecimal():
            value = int(value)
    return value if type(value) is int and 0 < value <= 2**53 - 1 else None


def canonical_model_endpoint(value: str | None) -> str:
    if not value or any(char.isspace() or char in "\\{}<>*" for char in value):
        return ""
    try:
        url = urlsplit(value)
        if url.scheme not in ("http", "https") or not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment:
            return ""
        host = url.hostname.lower()
        if ":" in host:
            host = f"[{host}]"
        if url.port is not None and url.port != (443 if url.scheme == "https" else 80):
            host = f"{host}:{url.port}"
        return urlunsplit((url.scheme, host, url.path.rstrip("/"), "", ""))
    except ValueError:
        return ""


def _endpoint(provider_name: str | None, api_base: str | None) -> str:
    if not api_base and provider_name:
        entry = CHAT_SOURCE_PROVIDER_BY_ID.get(provider_name)
        if entry:
            api_base = entry.api_base
        else:
            from mona.providers.registry import find_by_name

            spec = find_by_name(provider_name)
            api_base = spec.default_api_base if spec else None
    return canonical_model_endpoint(api_base)


_TEMPLATE_SLOT = re.compile(r"\{([A-Za-z][A-Za-z0-9_]*)\}")


def _preset_bindings(entry: CindyChatProvider, base: str) -> dict[str, str] | None:
    template = entry.api_base.rstrip("/")
    if not base:
        return None
    if canonical_model_endpoint(template) == base:
        return {}
    if entry.auth_method == "google-adc":
        from mona.providers.vertex_provider import validate_vertex_base

        try:
            validate_vertex_base(base)
        except ValueError:
            return None
        return {}
    if "{" not in template or "{endpoint}" in template:
        return None
    # Tenant and region slots bind just one path component or DNS label.
    segments = []
    seen = set()
    for part in re.split(r"(\{[A-Za-z][A-Za-z0-9_]*\})", template):
        slot = _TEMPLATE_SLOT.fullmatch(part)
        if not slot:
            segments.append(re.escape(part))
            continue
        key = slot[1]
        segments.append(f"(?P={key})" if key in seen else f"(?P<{key}>[A-Za-z0-9_-]+)")
        seen.add(key)
    match = re.fullmatch("".join(segments), base)
    return match.groupdict() if match else None


def _bind_endpoint(value: str, bindings: dict[str, str]) -> str:
    return _TEMPLATE_SLOT.sub(lambda match: bindings.get(match[1], match[0]), value)


@lru_cache(maxsize=4096)
def _preset_candidate(provider_name: str | None, model_id: str, base: str) -> tuple[CindyModel, str, str] | None:
    entry = CHAT_SOURCE_PROVIDER_BY_ID.get(provider_name or "")
    if not entry:
        return None
    bindings = _preset_bindings(entry, base)
    if bindings is None:
        return None
    matches: dict[tuple[str, str, str], CindyModel] = {}
    for candidate in (*entry.catalog_models, *entry.models):
        if candidate.id != model_id:
            continue
        target = canonical_model_endpoint(_bind_endpoint(candidate.api_base, bindings)) if candidate.api_base else base
        if not target or urlsplit(target).netloc != urlsplit(base).netloc or urlsplit(target).scheme != urlsplit(base).scheme:
            continue
        api = candidate.wire_api or (candidate.metadata or {}).get("wire_api") or entry.wire_api
        matches.setdefault((target, api, candidate.wire_model_id or model_id), candidate)
    if not matches:
        return None
    # The default connection wins when a provider offers the same ID over several protocols.
    for preferred in (
        [key for key in matches if key[0] == base and key[1] == entry.wire_api],
        [key for key in matches if key[0] == base],
        [key for key in matches if key[1] == entry.wire_api],
        list(matches),
    ):
        if preferred:
            if len(preferred) != 1:
                return None
            target, api, wire_id = preferred[0]
            return matches[(target, api, wire_id)], target, api
    return None


def preset_model_route(provider_name: str | None, model_id: str, api_base: str | None = None) -> dict[str, str] | None:
    selected = _preset_candidate(provider_name, model_id, _endpoint(provider_name, api_base))
    if selected is None:
        return None
    candidate, target, api = selected
    return {"api_base": target, "wire_api": api, "wire_model_id": candidate.wire_model_id or model_id}


def catalog_model_for_route(provider_name: str | None, model_id: str, api_base: str | None = None) -> dict[str, Any] | None:
    """Only a matching upstream and exact wire ID may supply serializer options."""
    base = _endpoint(provider_name, api_base)
    if not base or not model_id:
        return None
    routes = _catalog()["routes"]
    row = routes.get(base, {}).get(model_id)
    if row is None:
        # OpenAI-compatible clients commonly append /v1 to an unversioned base.
        alternate = base.removesuffix("/v1") if base.endswith("/v1") else f"{base}/v1"
        row = routes.get(alternate, {}).get(model_id)
    if row is None:
        selected = _preset_candidate(provider_name, model_id, base)
        if selected:
            candidate, target, api = selected
            metadata = routes.get(target, {}).get(candidate.wire_model_id or model_id) or candidate.metadata
            if metadata:
                row = {**metadata, "wire_api": api}
    return row


def catalog_api_for_endpoint(api_base: str) -> str | None:
    base = canonical_model_endpoint(api_base)
    routes = _catalog()["routes"]
    rows = routes.get(base) or routes.get(base.removesuffix("/v1") if base.endswith("/v1") else f"{base}/v1", {})
    protocols = {row.get("wire_api") for row in rows.values()}
    return protocols.pop() if len(protocols) == 1 else None


@lru_cache(maxsize=4096)
def _generation(identity: str) -> tuple[str, tuple[int, ...]] | None:
    model = _VENDOR_PREFIX.sub("", identity.lower())
    match = _GENERATION.fullmatch(model) if not _MODEL_SIZE.match(model) else None
    if not match:
        return None
    version = [int(part) for part in re.split(r"[.-]", match[2])]
    while len(version) > 1 and version[-1] == 0:
        version.pop()
    return match[1] + "|" + match[3], tuple(version)


@lru_cache(maxsize=1024)
def _reference_metadata(model_id: str, endpoint: str, protocol: str) -> dict:
    public = _catalog()["references"]
    exact = public.get(model_id)
    if exact:
        if exact.get("wire_api", protocol) == protocol:
            return exact
        return {key: exact[key] for key in ("name", "context_window") if key in exact}
    target = _generation(model_id)
    if not target:
        return {}
    # Size, date, private namespace, and variant stay part of the family key.
    # A predecessor can lend capability hints, never identity or transport.
    result = {}
    for candidates in (public, _catalog()["routes"].get(endpoint, {})):
        nearest: tuple[int, ...] = ()
        matches = []
        for identity, values in candidates.items():
            if values.get("wire_api", protocol) != protocol:
                continue
            source = _generation(identity)
            if not source or source[0] != target[0] or not nearest <= source[1] < target[1]:
                continue
            if source[1] != nearest:
                matches.clear()
                nearest = source[1]
            matches.append(values)
        if matches:
            for field in ("context_window", "reasoning_efforts", "default_reasoning_effort", "input_modalities"):
                first = matches[0].get(field)
                if first is not None and all(row.get(field) == first for row in matches):
                    result[field] = first
    return result


def _catalog_capabilities(row: Mapping[str, Any], model_id: str, wire_api: str | None = None) -> dict[str, Any]:
    data = {key: row[key] for key in _PUBLIC_FIELDS if key in row}
    if (row.get("wire_api", wire_api) == "bedrock-converse-stream" and "anthropic.claude" not in model_id.lower()
            and not model_id.lower().startswith("claude-")):
        data.update(reasoning_efforts=[], default_reasoning_effort=None)
        return data
    dialect = row.get("thinking_format")
    if (row.get("thinking_toggle") and not row.get("reasoning_efforts")) or (
        row.get("wire_api") == "openai-completions" and row.get("supports_reasoning_effort") is False
        and dialect not in ("openrouter", "ant-ling")
    ):
        off_supported = (row.get("thinking_level_map") or {}).get("off", "off") is not None
        toggle = row.get("thinking_toggle", bool(row.get("reasoning_efforts")) and dialect in {
            "deepseek", "qwen", "qwen-chat-template", "zai", "together", "baseten",
        })
        data["reasoning_efforts"] = ["off", "on"] if toggle and off_supported else []
        data["default_reasoning_effort"] = "on" if data["reasoning_efforts"] else None
    return data


def stored_model(provider_config: Any, model_id: str) -> dict[str, Any]:
    return next((item for item in (getattr(provider_config, "discovered_models", None) or [])
                 if isinstance(item, dict) and item.get("id") == model_id), {})


def declared_model_metadata(provider_config: Any) -> list[dict[str, Any]]:
    models = {item["id"]: {**item, **normalize_reasoning_metadata(item)} for item in (getattr(provider_config, "discovered_models", None) or [])
              if isinstance(item, dict) and isinstance(item.get("id"), str)}
    for model_id, override in (getattr(provider_config, "model_overrides", None) or {}).items():
        models[model_id] = {**models.get(model_id, {}), "id": model_id, **override.model_dump(exclude_none=True)}
    return list(models.values())


def resolve_route_model_metadata(
    provider_name: str | None, model_id: str, *, api_base: str | None = None,
    discovered: Mapping[str, Any] | None = None, override: Mapping[str, Any] | None = None, wire_api: str | None = None,
) -> dict[str, Any]:
    """Layer public hints, route declarations, observed metadata, and per-model settings."""
    live = discovered or {}
    endpoint = _endpoint(provider_name, api_base)
    entry = CHAT_SOURCE_PROVIDER_BY_ID.get(provider_name or "")
    route = catalog_model_for_route(provider_name, model_id, api_base)
    if wire_api and route and route.get("wire_api") != wire_api:
        route = None
    protocol = wire_api or (route or {}).get("wire_api") or (entry.wire_api if entry else "openai-completions")
    complete_route = route and all(field in route for field in ("name", "context_window", "reasoning_efforts", "input_modalities"))
    reference = {} if complete_route or live.get("opaque_model_id") or not endpoint or provider_name in {"magpie", "mona_managed", "azure-openai-responses", "azure_openai"} else _reference_metadata(model_id, endpoint, protocol)
    data = {key: reference[key] for key in _PUBLIC_FIELDS if key in reference}
    source = "reference" if data.get("context_window") else None
    if route:
        data.update(_catalog_capabilities(route, model_id))
        if route.get("context_window"):
            source = "catalog"
    selected = _preset_candidate(provider_name, model_id, endpoint)
    if selected:
        preset = selected[0]
        data["name"] = preset.name
        if preset.context_window:
            data["context_window"], source = preset.context_window, "catalog"
        if preset.input_modalities is not None:
            data["input_modalities"] = list(preset.input_modalities)
        if preset.metadata:
            data.update(_catalog_capabilities(preset.metadata, model_id, selected[2]))
    elif entry and _preset_bindings(entry, endpoint) is not None:
        # An account can discover a model before it joins the preset's recommended list.
        preset_id = {"openai": "openai-api", "anthropic": "anthropic-api"}.get(entry.id, entry.id)
        registered = _catalog()["preset_models"].get(preset_id, {}).get(model_id, {})
        if registered:
            data.update(_catalog_capabilities(registered, model_id, protocol))
            if registered.get("context_window"):
                source = "catalog"

    name = live.get("name")
    if isinstance(name, str) and name.strip() and name.strip() != model_id:
        data["name"] = name.strip()
    if isinstance(live.get("input_modalities"), list):
        data["input_modalities"] = live["input_modalities"]
    data.update(normalize_reasoning_metadata(live))
    window = positive_token_count(live.get("context_window", live.get("contextWindow")))
    maximum = positive_token_count(live.get("context_window_max", live.get("contextWindowMax")))
    if window and maximum and maximum < window:
        maximum = None
    if window:
        data["context_window"], source = window, "discovered"
    elif maximum and (not data.get("context_window") or maximum < data["context_window"]):
        data["context_window"], source = maximum, "reference"
    if maximum:
        data["context_window_max"] = maximum
    if override:
        data.update(override)
        if override.get("context_window"):
            source = "configured"
            if maximum and data["context_window"] > maximum:
                data["context_window"], source = maximum, "discovered" if maximum == window else "reference"
    if source:
        data["context_window_source"] = source
    efforts = data.get("reasoning_efforts")
    if efforts is not None and data.get("default_reasoning_effort") not in efforts:
        if not efforts:
            data["default_reasoning_effort"] = None
        elif data.get("default_reasoning_effort"):
            data["default_reasoning_effort"] = supported_default_effort(data["default_reasoning_effort"], efforts)
    return {**data, "id": model_id, "name": data.get("name") or model_id}


def model_selection_row(
    provider_name: str, model_id: str, raw: Mapping[str, Any], *, api_base: str | None,
    override: Mapping[str, Any] | None = None, default_type: str | None = None, wire_api: str | None = None,
) -> dict[str, Any]:
    """Expose the resolved model to selection, and only observed fields to the settings form."""
    observed = {key: raw[key] for key in ("type", "input_modalities", "context_window_max", "opaque_model_id")
                if raw.get(key) is not None}
    if raw.get("name") and raw["name"] != model_id:
        observed["name"] = raw["name"]
    window = positive_token_count(raw.get("context_window", raw.get("contextWindow")))
    if window:
        observed["context_window"] = window
    observed.update(normalize_reasoning_metadata(raw))
    resolved = resolve_route_model_metadata(provider_name, model_id, api_base=api_base, discovered=observed, override=override, wire_api=wire_api)
    kind = observed.get("type") or default_type
    if not kind and catalog_model_for_route(provider_name, model_id, api_base):
        kind = "chat"
    return {"context_window": None, "input_modalities": None, **resolved, "type": kind, "discovered_metadata": observed}


def configured_model_metadata(provider_name: str | None, model_id: str, provider_config: Any) -> dict[str, Any]:
    overrides = getattr(provider_config, "model_overrides", None) or {}
    override = overrides.get(model_id)
    return resolve_route_model_metadata(
        provider_name, model_id, api_base=getattr(provider_config, "api_base", None),
        discovered=stored_model(provider_config, model_id),
        override=override.model_dump(exclude_none=True) if override else None,
        wire_api=getattr(provider_config, "wire_api", None),
    )
