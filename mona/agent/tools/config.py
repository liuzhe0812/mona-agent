"""Config agent tools.

Lets the agent configure LLM provider credentials on the user's behalf so
they don't have to open the BYOK settings panel manually. Writes go through
the same Tauri IPC commands the WebUI BYOK panel uses, so ``~/.mona/config.json``
stays the single source of truth.

Design notes:
- Only providers registered in ``mona.providers.registry.PROVIDERS`` are
  writable; OAuth-based providers (openai_codex, github_copilot) are rejected
  because they don't accept API keys.
- API keys are masked in logs to avoid leaking secrets to log files.
- The tool runs exclusively (no parallel tool calls) because it mutates the
  shared config file.
- Restart of Mona (or the gateway) is required for the change to take effect;
  the tool return value makes this explicit so the agent can surface it.
"""

from __future__ import annotations

from typing import Any

from loguru import logger

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import (
    BooleanSchema,
    StringSchema,
    tool_parameters_schema,
)
from mona.agent.tools.tauri_ipc import tauri_invoke
from mona.providers.registry import PROVIDERS, find_by_name

# Provider names the agent is allowed to write. Excludes OAuth-based providers
# (openai_codex, github_copilot) since those need interactive `mona provider
# login` instead of an API key.
_ALLOWED_PROVIDER_NAMES: frozenset[str] = frozenset(
    spec.name for spec in PROVIDERS if not spec.is_oauth
)


def _mask_api_key(key: str) -> str:
    """Mask an API key for safe logging: show only the last 4 chars."""
    if not key:
        return "<empty>"
    if len(key) <= 8:
        return "***"
    return f"***{key[-4:]}"


_PARAMETERS = tool_parameters_schema(
    provider=StringSchema(
        "Provider config field name (e.g. 'deepseek', 'openai', 'anthropic', "
        "'dashscope', 'siliconflow', 'agnes'). Must be one of the providers registered "
        "in Mona's provider registry. OAuth-based providers (openai_codex, "
        "github_copilot) are not supported here — ask the user to run "
        "`mona provider login` for those.",
        min_length=1,
    ),
    api_key=StringSchema(
        "API key issued by the provider. Stored locally in ~/.mona/config.json, "
        "never uploaded to any server.",
        min_length=1,
    ),
    api_base=StringSchema(
        "Optional override for the provider's OpenAI-compatible API base URL. "
        "Leave empty to use the provider's default. Required for 'custom' and "
        "'azure_openai' providers.",
        nullable=True,
    ),
    set_as_default=BooleanSchema(
        description=(
            "If true, also set this provider as the default provider and set "
            "`default_model` as the default model. Takes effect after Mona restarts."
        )
    ),
    default_model=StringSchema(
        "Model ID to set as the default when `set_as_default` is true. For "
        "gateways like OpenRouter include the org prefix "
        "(e.g. 'anthropic/claude-3-5-sonnet').",
        nullable=True,
    ),
    image_model=StringSchema(
        "Optional image generation model ID to configure for this provider "
        "(e.g. 'agnes-image-2.0-flash'). When provided, also sets "
        "tools.imageGeneration.{provider, model, enabled=true}. The provider "
        "must be registered with image_models in the provider registry.",
        nullable=True,
    ),
    video_model=StringSchema(
        "Optional video generation model ID to configure for this provider "
        "(e.g. 'agnes-video-v2.0'). When provided, also sets "
        "tools.videoGeneration.{provider, model, enabled=true}. The provider "
        "must be registered with video_models in the provider registry.",
        nullable=True,
    ),
    required=["provider", "api_key"],
)


@tool_parameters(_PARAMETERS)
class ConfigSetProviderTool(Tool):
    """Configure an LLM provider's API key (and optionally default model)."""

    _scopes = {"core"}
    _plugin_discoverable = True

    @property
    def name(self) -> str:
        return "config_set_provider"

    @property
    def description(self) -> str:
        return (
            "Configure an LLM provider's API key (and optionally set it as the "
            "default) in the user's local Mona config at ~/.mona/config.json. "
            "Use this when the user shares an API key in chat and asks you to "
            "set it up, so they don't have to open the BYOK settings panel "
            "manually. Writes go through the same path as the WebUI BYOK panel. "
            "Mona must be restarted (or the gateway restarted) for the change "
            "to take effect — surface this to the user in your reply."
        )

    @property
    def exclusive(self) -> bool:
        # Mutates the shared config file; don't run in parallel with other tools.
        return True

    async def execute(self, **kwargs: Any) -> Any:
        provider_raw = str(kwargs.get("provider", "")).strip()
        api_key = str(kwargs.get("api_key", ""))
        api_base_raw = kwargs.get("api_base")
        api_base = str(api_base_raw).strip() if api_base_raw else None
        set_as_default = bool(kwargs.get("set_as_default", False))
        default_model_raw = kwargs.get("default_model")
        default_model = (
            str(default_model_raw).strip() if default_model_raw else ""
        )
        image_model_raw = kwargs.get("image_model")
        image_model = (
            str(image_model_raw).strip() if image_model_raw else ""
        )
        video_model_raw = kwargs.get("video_model")
        video_model = (
            str(video_model_raw).strip() if video_model_raw else ""
        )

        if not provider_raw:
            return "Error: provider is required."
        if not api_key:
            return "Error: api_key is required."

        spec = find_by_name(provider_raw)
        if spec is None or spec.name not in _ALLOWED_PROVIDER_NAMES:
            return (
                f"Error: provider '{provider_raw}' is not configurable via this "
                "tool. Only registered non-OAuth providers are supported. Ask "
                "the user to configure OAuth-based providers (openai_codex, "
                "github_copilot) via `mona provider login`."
            )

        if set_as_default and not default_model:
            return (
                "Error: default_model is required when set_as_default is true."
            )

        if image_model and not spec.image_models:
            return (
                f"Error: provider '{spec.name}' is not registered with image "
                "models. Pick a provider that has image_models in the provider "
                "registry, or omit image_model."
            )
        if video_model and not spec.video_models:
            return (
                f"Error: provider '{spec.name}' is not registered with video "
                "models. Pick a provider that has video_models in the provider "
                "registry, or omit video_model."
            )

        logger.info(
            "config_set_provider: writing provider={} key={} base={} default={} image={} video={}",
            spec.name,
            _mask_api_key(api_key),
            api_base or "(default)",
            default_model or "(no default change)",
            image_model or "(no image)",
            video_model or "(no video)",
        )

        provider_args: dict[str, Any] = {
            "provider": spec.name,
            "apiKey": api_key,
        }
        if api_base:
            provider_args["apiBase"] = api_base

        try:
            tauri_invoke("write_mona_provider_config", provider_args)
        except RuntimeError as e:
            return f"Error writing provider config: {e}"

        if set_as_default:
            try:
                tauri_invoke(
                    "write_mona_model_config",
                    {"model": default_model, "provider": spec.name},
                )
            except RuntimeError as e:
                return (
                    f"Provider credentials written, but failed to set default "
                    f"model: {e}. The user can set the default model manually "
                    "in Settings."
                )

        if image_model:
            try:
                tauri_invoke(
                    "write_mona_image_gen_config",
                    {
                        "provider": spec.name,
                        "model": image_model,
                        "enabled": True,
                    },
                )
            except RuntimeError as e:
                return (
                    f"Provider credentials written, but failed to set image "
                    f"generation config: {e}. The user can configure image "
                    "generation manually in Settings."
                )

        if video_model:
            try:
                tauri_invoke(
                    "write_mona_video_gen_config",
                    {
                        "provider": spec.name,
                        "model": video_model,
                        "enabled": True,
                    },
                )
            except RuntimeError as e:
                return (
                    f"Provider credentials written, but failed to set video "
                    f"generation config: {e}. The user can configure video "
                    "generation manually in Settings."
                )

        parts = [
            f"Provider `{spec.name}` configured. API key written to "
            f"~/.mona/config.json"
        ]
        if api_base:
            parts.append(f" with custom apiBase `{api_base}`")
        parts.append(".")
        if set_as_default:
            parts.append(
                f" Default LLM model set to `{default_model}` "
                f"(provider: `{spec.name}`)."
            )
        if image_model:
            parts.append(
                f" Image generation configured with `{image_model}` "
                f"(provider: `{spec.name}`, enabled=true)."
            )
        if video_model:
            parts.append(
                f" Video generation configured with `{video_model}` "
                f"(provider: `{spec.name}`, enabled=true)."
            )
        parts.append(
            " Mona must be restarted (or the gateway restarted) for the change "
            "to take effect."
        )
        return "".join(parts)
