"""Create LLM providers from config."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from loguru import logger

from mona.config.schema import Config, InlineFallbackConfig, ModelPresetConfig
from mona.providers.base import LLMProvider
from mona.providers.context_window import resolve_model_context_window_details
from mona.providers.fallback_provider import FallbackProvider
from mona.providers.model_metadata import (
    catalog_model_for_route,
    configured_model_metadata,
    declared_model_metadata,
    preset_model_route,
    stored_model,
)
from mona.providers.model_sources import CHAT_SOURCE_PROVIDER_BY_ID
from mona.providers.preset_transport import cloudflare_client_factory, openai_compatible_preset
from mona.providers.registry import WIRE_PROVIDER_BACKENDS, find_by_name, is_custom_provider_name


@dataclass(frozen=True)
class ProviderSnapshot:
    provider: LLMProvider
    model: str
    context_window_tokens: int
    signature: tuple[object, ...]
    auto_compact_token_limit: int | None = None
    context_window_verified: bool = True
    context_provider: str | None = None


def _resolve_model_preset(
    config: Config,
    *,
    preset_name: str | None = None,
    preset: ModelPresetConfig | None = None,
) -> ModelPresetConfig:
    return preset if preset is not None else config.resolve_preset(preset_name)


def _make_provider_core(
    config: Config,
    *,
    preset_name: str | None = None,
    preset: ModelPresetConfig | None = None,
    model: str | None = None,
    http_client_factory: Callable[[], Any] | None = None,
) -> LLMProvider:
    """Create a plain LLM provider without failover wrapping."""
    resolved = _resolve_model_preset(config, preset_name=preset_name, preset=preset)
    model = model or resolved.model
    provider_name = config.get_provider_name(model, preset=resolved)
    if not provider_name and resolved.provider != "auto":
        # An unconfigured named connection still owns its destination. Falling
        # through to the generic SDK default would send this prompt to OpenAI.
        provider_name = resolved.provider
    p = config.get_provider(model, preset=resolved)
    spec = find_by_name(provider_name) if provider_name else None
    backend = spec.backend if spec else "openai_compat"
    declared_models = declared_model_metadata(p)
    api_base = config.get_api_base(model, preset=resolved) or (spec.default_api_base if spec else None)
    route = preset_model_route(provider_name, model, api_base) or {}
    api_base = route.get("api_base") or api_base
    wire_api = route.get("wire_api") or (spec.wire_api if spec else None)
    wire_model_id = route.get("wire_model_id") or model
    if provider_name and (provider_name == "custom" or is_custom_provider_name(provider_name)):
        wire_api = getattr(p, "wire_api", None)
        if wire_api is None:
            matched = catalog_model_for_route(provider_name, model, api_base) or {}
            discovered_api = matched.get("wire_api")
            wire_api = discovered_api if discovered_api in {"openai-completions", "openai-responses", "anthropic-messages"} else "openai-completions"
    if wire_api and api_base:
        wire_api, api_base = openai_compatible_preset(provider_name, wire_api, api_base)
        if backend != "github_copilot":
            backend = WIRE_PROVIDER_BACKENDS[wire_api]
    api_key = (p.api_key if p else None) or None
    if provider_name == "cloudflare-ai-gateway":
        http_client_factory = cloudflare_client_factory(api_base or "", api_key or "", http_client_factory)
        # The connection sends this gateway key only in cf-aig-authorization.
        api_key = "gateway-managed"

    if backend == "azure_openai":
        if not p or not p.api_key or not p.api_base:
            raise ValueError("Azure OpenAI requires api_key and api_base in config.")
        if provider_name == "azure-openai-responses":
            target = urlsplit(api_base or "")
            if (target.scheme != "https" or not (target.hostname or "").endswith(".openai.azure.com")
                    or target.username is not None or target.password is not None or target.port not in {None, 443}
                    or target.path.rstrip("/") not in {"", "/openai/v1"} or target.query or target.fragment):
                raise ValueError("请填写所用 Azure OpenAI 资源的官方 HTTPS 地址。")
    elif backend == "openai_compat" and not model.startswith("bedrock/"):
        needs_key = not (p and p.api_key)
        exempt = spec and (spec.is_oauth or spec.is_local or spec.is_direct)
        if needs_key and not exempt and (spec and spec.api_key_required):
            logger.warning(
                f"Provider '{provider_name}' 未配置 api_key，runtime 将启动但实际调用时会失败。"
                f"请在设置中补全 API Key。"
            )

    if backend == "mona_managed":
        from mona.providers.mona_managed_provider import MonaManagedProvider

        if spec is None:
            raise ValueError("Mona managed provider metadata is missing")
        provider = MonaManagedProvider(default_model=model, spec=spec)
    elif backend == "openai_codex":
        from mona.providers.openai_codex_provider import OpenAICodexProvider

        provider = OpenAICodexProvider(default_model=model)
    elif backend == "azure_openai":
        from mona.providers.azure_openai_provider import AzureOpenAIProvider

        provider = AzureOpenAIProvider(
            api_key=p.api_key,
            api_base=api_base,
            default_model=model,
            http_client=http_client_factory() if http_client_factory else None,
            model_metadata=declared_models,
        )
    elif backend == "github_copilot":
        from mona.providers.github_copilot_provider import GitHubCopilotProvider

        provider = GitHubCopilotProvider(default_model=model, api_base=api_base, wire_api=wire_api,
                                        model_metadata=declared_models)
    elif backend == "vertex":
        from mona.providers.vertex_provider import VertexOpenAIProvider

        provider = VertexOpenAIProvider(api_base=api_base, default_model=model, spec=spec, model_metadata=declared_models)
    elif backend == "anthropic":
        from mona.providers.anthropic_provider import AnthropicProvider

        provider = AnthropicProvider(
            api_key=api_key,
            api_base=api_base,
            default_model=model,
            extra_headers=p.extra_headers if p else None,
            model_metadata=declared_models,
            http_client=http_client_factory() if http_client_factory else None,
        )
    elif backend == "bedrock":
        from mona.providers.bedrock_provider import BedrockProvider

        region = getattr(p, "region", None) if p else None
        if wire_api == "bedrock-converse-stream" and spec and spec.wire_api == wire_api:
            if api_base != spec.default_api_base:
                raise ValueError("Bedrock 区域预设只接受所选区域的 AWS 官方地址。")
            region = urlsplit(api_base).hostname.split(".")[1]
        provider = BedrockProvider(
            api_key=api_key,
            api_base=api_base,
            default_model=model,
            region=region,
            profile=getattr(p, "profile", None) if p else None,
            extra_body=p.extra_body if p else None,
            model_metadata=declared_models,
        )
    else:
        from mona.providers.openai_compat_provider import OpenAICompatProvider

        provider = OpenAICompatProvider(
            api_key=api_key,
            api_base=api_base,
            default_model=model,
            extra_headers=p.extra_headers if p else None,
            spec=spec,
            model_metadata=declared_models,
            wire_api=wire_api,
            extra_body=p.extra_body if p else None,
            # Optional-key endpoints (including custom chat endpoints) still
            # need their Authorization header when the user supplied a key;
            # only keyless free providers should strip auth.
            no_auth=bool(spec and not api_key and (not spec.api_key_required or spec.is_local)),
        )

    if route:
        provider.wire_model_ids = {model: wire_model_id}
    provider.http_client_factory = http_client_factory
    provider.generation = resolved.to_generation_settings()
    capabilities = configured_model_metadata(provider_name, model, p) if provider_name in CHAT_SOURCE_PROVIDER_BY_ID or (
        provider_name and is_custom_provider_name(provider_name)
    ) else {}
    if resolved.reasoning_effort is None and capabilities.get("default_reasoning_effort"):
        provider.generation = replace(provider.generation, reasoning_effort=capabilities["default_reasoning_effort"])
    provider.spec = spec
    provider.model_input_modalities = {}
    for item in (p.discovered_models if p else None) or []:
        if not isinstance(item, dict):
            continue
        model_id = str(item.get("id") or "").strip()
        raw_modalities = item.get("input_modalities", item.get("inputModalities"))
        if not model_id or not isinstance(raw_modalities, list):
            continue
        modalities = tuple(
            dict.fromkeys(
                str(value).strip().lower()
                for value in raw_modalities
                if str(value).strip()
            )
        )
        provider.model_input_modalities[model_id] = modalities
    if capabilities.get("input_modalities") is not None:
        provider.model_input_modalities[model] = tuple(capabilities["input_modalities"])
    return provider


def _inline_fallback_preset(
    primary: ModelPresetConfig,
    fallback: InlineFallbackConfig,
) -> ModelPresetConfig:
    return ModelPresetConfig(
        model=fallback.model,
        provider=fallback.provider,
        max_tokens=fallback.max_tokens if fallback.max_tokens is not None else primary.max_tokens,
        auto_compact_token_limit=primary.auto_compact_token_limit,
        temperature=(
            fallback.temperature if fallback.temperature is not None else primary.temperature
        ),
        reasoning_effort=fallback.reasoning_effort,
    )


def _resolve_fallback_presets(config: Config, primary: ModelPresetConfig) -> list[ModelPresetConfig]:
    presets: list[ModelPresetConfig] = []
    for fallback in config.agents.defaults.fallback_models:
        if isinstance(fallback, str):
            presets.append(config.model_presets[fallback])
        else:
            presets.append(_inline_fallback_preset(primary, fallback))
    return presets


def resolve_work_context_budget(
    config: Config,
    preset: ModelPresetConfig,
    fallbacks: list[ModelPresetConfig] | None = None,
    *,
    managed_catalog: dict[str, Any] | None = None,
) -> tuple[int, bool]:
    """Resolve the total budget shared by the primary model and its fallback routes."""
    if fallbacks is None:
        fallbacks = _resolve_fallback_presets(config, preset)
    windows = [
        resolve_model_context_window_details(config, item, managed_catalog=managed_catalog)
        for item in [preset, *fallbacks]
    ]
    return min(window.tokens for window in windows), all(window.verified for window in windows)


def _effective_auto_compact_token_limit(
    primary: ModelPresetConfig,
    fallbacks: list[ModelPresetConfig],
) -> int | None:
    limits = [
        preset.auto_compact_token_limit
        for preset in [primary, *fallbacks]
        if preset.auto_compact_token_limit is not None
    ]
    return min(limits) if limits else None


def make_provider(
    config: Config,
    *,
    preset_name: str | None = None,
    preset: ModelPresetConfig | None = None,
    model: str | None = None,
    http_client_factory: Callable[[], Any] | None = None,
) -> LLMProvider:
    """Create the LLM provider implied by config.

    When *model* is given, it overrides the resolved/preset model — used by
    the failover path to create providers for fallback models.
    """
    resolved = _resolve_model_preset(config, preset_name=preset_name, preset=preset)
    provider = _make_provider_core(config, preset_name=preset_name, preset=preset, model=model,
                                   http_client_factory=http_client_factory)
    fallback_presets = _resolve_fallback_presets(config, resolved)

    if fallback_presets:
        provider = FallbackProvider(
            primary=provider,
            fallback_presets=fallback_presets,
            provider_factory=lambda fb: _make_provider_core(
                config, preset_name=preset_name, preset=fb, http_client_factory=http_client_factory
            ),
        )

    return provider


def provider_signature(
    config: Config,
    *,
    preset_name: str | None = None,
    preset: ModelPresetConfig | None = None,
) -> tuple[object, ...]:
    """Return the config fields that affect the active provider chain."""
    resolved = _resolve_model_preset(config, preset_name=preset_name, preset=preset)
    p = config.get_provider(resolved.model, preset=resolved)
    fallback_presets = _resolve_fallback_presets(config, resolved)

    def model_capabilities(preset: ModelPresetConfig, connection: Any) -> tuple:
        override = (getattr(connection, "model_overrides", None) or {}).get(preset.model)
        return (
            resolve_model_context_window_details(config, preset),
            getattr(connection, "wire_api", None),
            dict(stored_model(connection, preset.model)),
            override.model_dump(exclude_none=True) if override else None,
        )

    def _fallback_signature(fallback: ModelPresetConfig) -> tuple[object, ...]:
        fp = config.get_provider(fallback.model, preset=fallback)
        return (
            fallback.model,
            fallback.provider,
            config.get_provider_name(fallback.model, preset=fallback),
            config.get_api_key(fallback.model, preset=fallback),
            config.get_api_base(fallback.model, preset=fallback),
            fp.extra_headers if fp else None,
            fp.extra_body if fp else None,
            getattr(fp, "region", None) if fp else None,
            getattr(fp, "profile", None) if fp else None,
            fallback.max_tokens,
            fallback.temperature,
            fallback.reasoning_effort,
            model_capabilities(fallback, fp),
            fallback.auto_compact_token_limit,
        )

    return (
        resolved.model,
        resolved.provider,
        config.get_provider_name(resolved.model, preset=resolved),
        config.get_api_key(resolved.model, preset=resolved),
        config.get_api_base(resolved.model, preset=resolved),
        p.extra_headers if p else None,
        p.extra_body if p else None,
        getattr(p, "region", None) if p else None,
        getattr(p, "profile", None) if p else None,
        resolved.max_tokens,
        resolved.temperature,
        resolved.reasoning_effort,
        model_capabilities(resolved, p),
        resolved.auto_compact_token_limit,
        tuple(_fallback_signature(fallback) for fallback in fallback_presets),
    )


def build_provider_snapshot(
    config: Config,
    *,
    preset_name: str | None = None,
    preset: ModelPresetConfig | None = None,
) -> ProviderSnapshot:
    if preset_name is None and preset is None and config.agents.defaults.executor != "mona":
        from mona.providers.context_window import DEFAULT_CONTEXT_WINDOW_TOKENS
        from mona.providers.native_work_provider import NativeWorkProvider

        defaults = config.agents.defaults
        if not defaults.native_model:
            raise ValueError("原生模型尚未选择，请在模型设置中选择模型。")
        provider = NativeWorkProvider(config, config.workspace_path)
        provider.generation = config.resolve_default_preset().to_generation_settings()
        provider.generation = replace(provider.generation, reasoning_effort=defaults.native_reasoning_effort)
        return ProviderSnapshot(
            provider=provider,
            model=defaults.native_model,
            context_provider=f"native:{defaults.executor}",
            context_window_tokens=defaults.native_context_window_tokens or DEFAULT_CONTEXT_WINDOW_TOKENS,
            context_window_verified=defaults.native_context_window_tokens is not None,
            signature=("native_work", defaults.executor, defaults.native_model, defaults.native_reasoning_effort,
                       defaults.native_context_window_tokens, config.development.model_dump_json()),
            auto_compact_token_limit=defaults.auto_compact_token_limit,
        )
    resolved = _resolve_model_preset(config, preset_name=preset_name, preset=preset)
    fallback_presets = _resolve_fallback_presets(config, resolved)
    context_budget, context_window_verified = resolve_work_context_budget(config, resolved, fallback_presets)
    return ProviderSnapshot(
        provider=make_provider(config, preset=resolved),
        model=resolved.model,
        context_provider=config.get_provider_name(resolved.model, preset=resolved),
        context_window_tokens=context_budget,
        signature=provider_signature(config, preset=resolved),
        context_window_verified=context_window_verified,
        auto_compact_token_limit=_effective_auto_compact_token_limit(
            resolved,
            fallback_presets,
        ),
    )


def load_provider_snapshot(
    config_path: Path | None = None,
    *,
    preset_name: str | None = None,
) -> ProviderSnapshot:
    from mona.config.loader import load_config, resolve_config_env_vars

    return build_provider_snapshot(
        resolve_config_env_vars(load_config(config_path)),
        preset_name=preset_name,
    )
