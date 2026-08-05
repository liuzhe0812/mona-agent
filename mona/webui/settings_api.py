"""Settings REST helpers for the WebUI HTTP surface.

The WebSocket channel owns transport/authentication. This module owns the
settings payload shape and the allowlisted config mutations exposed to WebUI.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from loguru import logger

from mona.config.loader import get_config_path, load_config, save_config
from mona.providers.image_generation import get_image_gen_provider
from mona.providers.registry import PROVIDERS, find_by_name
from mona.providers.video_generation import get_video_gen_provider

QueryParams = dict[str, list[str]]

_WEB_SEARCH_PROVIDER_OPTIONS: tuple[dict[str, str], ...] = (
    {"name": "duckduckgo", "label": "DuckDuckGo", "credential": "none"},
    {"name": "brave", "label": "Brave Search", "credential": "api_key"},
    {"name": "tavily", "label": "Tavily", "credential": "api_key"},
    {"name": "searxng", "label": "SearXNG", "credential": "base_url"},
    {"name": "jina", "label": "Jina", "credential": "api_key"},
    {"name": "kagi", "label": "Kagi", "credential": "api_key"},
    {"name": "olostep", "label": "Olostep", "credential": "api_key"},
)
_WEB_SEARCH_PROVIDER_BY_NAME = {
    provider["name"]: provider for provider in _WEB_SEARCH_PROVIDER_OPTIONS
}

_IMAGE_GENERATION_ASPECT_RATIOS = {
    "1:1",
    "3:4",
    "9:16",
    "4:3",
    "16:9",
    "3:2",
    "2:3",
    "21:9",
}

_VIDEO_GENERATION_ASPECT_RATIOS = {"1:1", "3:4", "9:16", "4:3", "16:9"}
_VIDEO_DURATION_OPTIONS = (3, 5, 10, 18)


class WebUISettingsError(ValueError):
    """User-facing settings validation failure."""

    def __init__(self, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def _query_first(query: QueryParams, key: str) -> str | None:
    values = query.get(key)
    return values[0] if values else None


def _query_first_alias(query: QueryParams, snake: str, camel: str) -> str | None:
    value = _query_first(query, snake)
    return _query_first(query, camel) if value is None else value


def _mask_secret_hint(secret: str | None) -> str | None:
    if not secret:
        return None
    if len(secret) <= 8:
        return "••••"
    return f"{secret[:4]}••••{secret[-4:]}"


def _provider_requires_api_key(spec: Any) -> bool:
    if not spec.api_key_required:
        return False
    if spec.backend == "azure_openai":
        return True
    if spec.is_oauth:
        return False
    if spec.is_local or spec.is_direct:
        return False
    return True


def _provider_configured_for_settings(spec: Any, provider_config: Any) -> bool:
    if spec.is_oauth:
        return True
    if _provider_requires_api_key(spec):
        return bool(provider_config.api_key)
    return bool(
        provider_config.api_key
        or provider_config.api_base
        or getattr(provider_config, "region", None)
        or getattr(provider_config, "profile", None)
    )


def _parse_bool(value: str, field: str) -> bool:
    normalized = value.strip().lower()
    if normalized not in {"1", "0", "true", "false", "yes", "no"}:
        raise WebUISettingsError(f"{field} must be boolean")
    return normalized in {"1", "true", "yes"}


def _validate_workspace_path(path: Path) -> None:
    """Reject unsafe workspace paths."""
    resolved = path.resolve()
    if resolved == resolved.parent:
        raise WebUISettingsError("workspace cannot be the filesystem root")
    home = Path.home().resolve()
    if resolved == home:
        raise WebUISettingsError("workspace cannot be the user home directory")
    if ".." in Path(str(path)).parts:
        raise WebUISettingsError("workspace path must not contain '..'")
    if os.name == "nt":
        system_dirs: list[Path] = []
        for env_key in ("SystemRoot", "ProgramFiles", "ProgramFiles(x86)"):
            val = os.environ.get(env_key)
            if val:
                system_dirs.append(Path(val).resolve())
        for sd in system_dirs:
            if resolved == sd or _is_under(resolved, sd):
                raise WebUISettingsError(
                    "workspace cannot be inside a system directory"
                )


def _is_under(path: Path, directory: Path) -> bool:
    try:
        path.relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def _migrate_workspace_data(old_ws: Path, new_ws: Path) -> None:
    """Copy non-destructively sessions/ and output/ from old workspace to new.

    Per shared-output-workspace-execution-plan §8.5:
    - Copy ``sessions/`` and ``output/`` only.
    - Do NOT copy ``memory/`` or ``skills/`` — they are now global resources
      stored under ``~/.mona/`` and migrating them between workspaces would
      duplicate or overwrite global state.
    - Source workspace is preserved; the user decides when to clean up.
    """
    import shutil

    if not old_ws.exists():
        return
    new_ws.mkdir(parents=True, exist_ok=True)

    # Helper for non-destructive directory copies.
    def _copy_dir_non_destructive(src: Path, dest: Path, *, suffix_filter: str | None = None) -> None:
        if not src.exists() or not src.is_dir():
            return
        dest.mkdir(parents=True, exist_ok=True)
        for item in src.iterdir():
            if suffix_filter and (not item.is_file() or item.suffix != suffix_filter):
                continue
            target = dest / item.name
            if target.exists():
                continue
            try:
                if item.is_dir():
                    shutil.copytree(item, target)
                else:
                    shutil.copy2(str(item), str(target))
            except Exception:
                logger.exception("Failed to copy {} → {}", item, target)

    # 1. Migrate sessions directory (only .jsonl files).
    _copy_dir_non_destructive(old_ws / "sessions", new_ws / "sessions", suffix_filter=".jsonl")

    # 2. Migrate shared output directory (recursive, all files).
    _copy_dir_non_destructive(old_ws / "output", new_ws / "output")

    # NOTE: memory/ and skills/ are intentionally NOT copied — they are global
    # resources under ~/.mona/ and not workspace-scoped.


def _image_generation_provider_rows(config: Any) -> list[dict[str, Any]]:
    """Provider rows for the image generation settings section.

    Lists all non-OAuth providers so the user can pick any one and configure
    credentials + model ID inline.  Providers with a dedicated image-gen
    client or declared ``image_models`` surface those as quick-pick candidates;
    others fall back to the OpenAI-compatible ``/images/generations`` endpoint.
    """
    rows: list[dict[str, Any]] = []
    for spec in PROVIDERS:
        if spec.is_oauth or spec.is_local:
            continue
        provider_config = getattr(config.providers, spec.name, None)
        configured = (
            _provider_configured_for_settings(spec, provider_config)
            if provider_config is not None
            else False
        )
        image_models = list(spec.image_models) if spec.image_models else []
        rows.append(
            {
                "name": spec.name,
                "label": spec.label,
                "configured": configured,
                "api_key_hint": _mask_secret_hint(
                    getattr(provider_config, "api_key", None)
                    if provider_config is not None
                    else None
                ),
                "api_base": getattr(provider_config, "api_base", None) if provider_config else None,
                "default_api_base": spec.default_api_base or None,
                "image_models": image_models,
                "default_image_model": image_models[0] if image_models else None,
            }
        )
    return rows


def _video_generation_provider_rows(config: Any) -> list[dict[str, Any]]:
    """Provider rows for the video generation settings section.

    Lists all non-OAuth providers so the user can pick any one and configure
    credentials + model ID inline.  Providers that declare ``video_models``
    in their registry spec surface those as quick-pick candidates.
    """
    rows: list[dict[str, Any]] = []
    for spec in PROVIDERS:
        if spec.is_oauth or spec.is_local:
            continue
        provider_config = getattr(config.providers, spec.name, None)
        configured = (
            _provider_configured_for_settings(spec, provider_config)
            if provider_config is not None
            else False
        )
        video_models = list(spec.video_models) if spec.video_models else []
        rows.append(
            {
                "name": spec.name,
                "label": spec.label,
                "configured": configured,
                "api_key_hint": _mask_secret_hint(
                    getattr(provider_config, "api_key", None)
                ),
                "api_base": getattr(provider_config, "api_base", None) if provider_config else None,
                "default_api_base": spec.default_api_base or None,
                "video_models": video_models,
                "default_video_model": video_models[0] if video_models else None,
            }
        )
    return rows


def _channels_payload(config: Any) -> dict[str, Any]:
    """Build the ``channels`` section of the settings payload.

    Lists built-in channels that opt in to UI configuration. Each entry
    reports its enabled state and (for channels that support interactive
    login) whether saved credentials exist on disk.
    """
    from mona.channels.registry import discover_all
    from mona.webui.weixin_login import WeixinLoginSession

    available: list[dict[str, Any]] = []
    try:
        all_channels = discover_all()
    except Exception:
        all_channels = {}

    # Channels exposed in the WebUI settings page.
    # Maps channel name → (id_field, secret_field) for credential-based channels.
    _credential_channels = {
        "wecom": ("bot_id", "secret"),
        "qq": ("app_id", "secret"),
        "feishu": ("app_id", "app_secret"),
    }
    exposed = ("weixin", "wecom", "qq", "feishu")
    for name in exposed:
        cls = all_channels.get(name)
        if cls is None:
            continue
        section = getattr(config.channels, name, None)
        if isinstance(section, dict):
            enabled = bool(section.get("enabled", False))
        elif section is not None:
            enabled = bool(getattr(section, "enabled", False))
        else:
            enabled = False

        entry: dict[str, Any] = {
            "name": name,
            "display_name": cls.display_name,
            "enabled": enabled,
            "supports_login": name == "weixin",
        }
        if name == "weixin":
            entry["logged_in"] = WeixinLoginSession.has_saved_token()
            if isinstance(section, dict):
                entry["allow_from"] = section.get("allow_from") or section.get("allowFrom") or []
            elif section is not None:
                entry["allow_from"] = getattr(section, "allow_from", None) or []
            else:
                entry["allow_from"] = []
        elif name in _credential_channels:
            id_field, secret_field = _credential_channels[name]
            if isinstance(section, dict):
                entry[id_field] = section.get(id_field) or ""
                entry[secret_field] = "true" if section.get(secret_field) else ""
                entry["allow_from"] = section.get("allow_from") or section.get("allowFrom") or []
            elif section is not None:
                entry[id_field] = getattr(section, id_field, "") or ""
                entry[secret_field] = "true" if getattr(section, secret_field, "") else ""
                entry["allow_from"] = getattr(section, "allow_from", None) or []
            else:
                entry[id_field] = ""
                entry[secret_field] = ""
                entry["allow_from"] = []
        available.append(entry)

    return {"available": available}


def _tts_payload(config: Any) -> dict[str, Any]:
    """Build the ``tts`` section of the settings payload.

    Never returns the full API key — only whether one is configured plus a
    masked hint, matching the provider settings convention.
    """
    channels = config.channels
    api_key = str(getattr(channels, "tts_api_key", "") or "")
    return {
        "provider": str(getattr(channels, "tts_provider", "edge") or "edge"),
        "voice": str(getattr(channels, "tts_voice", "") or ""),
        "api_base": str(getattr(channels, "tts_api_base", "") or "") or None,
        "model": str(getattr(channels, "tts_model", "") or "") or None,
        "api_key_configured": bool(api_key),
        "api_key_hint": _mask_secret_hint(api_key),
    }


def _parse_allow_from(value: str | None) -> list[str]:
    """Parse a comma/newline separated allowlist into a clean list."""
    if not value:
        return []
    entries: list[str] = []
    for raw in value.replace(",", "\n").splitlines():
        entry = raw.strip()
        if entry:
            entries.append(entry)
    return entries


def update_channel_settings(query: QueryParams) -> dict[str, Any]:
    """Mutate a channel's WebUI-exposed settings.

    Only channels exposed in the WebUI can be mutated here.
    Enabling/disabling a channel requires a gateway restart.
    """
    # Maps channel name → (id_field, id_query_alias, secret_field, secret_query_alias)
    _credential_channels = {
        "wecom": ("bot_id", "botId", "secret", "secret"),
        "qq": ("app_id", "appId", "secret", "secret"),
        "feishu": ("app_id", "appId", "app_secret", "appSecret"),
    }

    channel_name = (_query_first(query, "channel") or "").strip()
    if not channel_name:
        raise WebUISettingsError("channel is required")
    if channel_name not in ("weixin",) and channel_name not in _credential_channels:
        raise WebUISettingsError(f"channel '{channel_name}' is not configurable in the WebUI")

    config = load_config()
    section = getattr(config.channels, channel_name, None)
    if section is None:
        # ChannelsConfig allows extra fields; ensure the section exists.
        section = {"enabled": False}
        setattr(config.channels, channel_name, section)

    changed = False

    enabled_raw = _query_first(query, "enabled")
    if enabled_raw is not None:
        enabled = _parse_bool(enabled_raw, "enabled")
        if isinstance(section, dict):
            if section.get("enabled") != enabled:
                section["enabled"] = enabled
                changed = True
        elif getattr(section, "enabled", None) != enabled:
            setattr(section, "enabled", enabled)
            changed = True

    allow_from_raw = _query_first_alias(query, "allow_from", "allowFrom")
    if allow_from_raw is not None:
        allow_from = _parse_allow_from(allow_from_raw)
        if isinstance(section, dict):
            existing = section.get("allow_from") or section.get("allowFrom") or []
            if existing != allow_from:
                section["allow_from"] = allow_from
                section.pop("allowFrom", None)
                changed = True
        else:
            existing = getattr(section, "allow_from", None) or []
            if existing != allow_from:
                setattr(section, "allow_from", allow_from)
                changed = True

    # Credential-based channels: save id + secret fields.
    if channel_name in _credential_channels:
        id_field, id_alias, secret_field, secret_alias = _credential_channels[channel_name]

        id_raw = _query_first_alias(query, id_field, id_alias)
        if id_raw is not None:
            id_val = id_raw.strip()
            if isinstance(section, dict):
                if section.get(id_field) != id_val:
                    section[id_field] = id_val
                    changed = True
            else:
                if getattr(section, id_field, "") != id_val:
                    setattr(section, id_field, id_val)
                    changed = True

        secret_raw = _query_first_alias(query, secret_field, secret_alias)
        if secret_raw is not None:
            secret_val = secret_raw.strip()
            if isinstance(section, dict):
                if section.get(secret_field) != secret_val:
                    section[secret_field] = secret_val
                    changed = True
            else:
                if getattr(section, secret_field, "") != secret_val:
                    setattr(section, secret_field, secret_val)
                    changed = True

    if changed:
        save_config(config)
    return settings_payload(requires_restart=True)


def settings_payload(*, requires_restart: bool = False) -> dict[str, Any]:
    config = load_config()
    defaults = config.agents.defaults
    active_preset_name = defaults.model_preset or "default"
    try:
        effective_preset = config.resolve_preset()
    except Exception:
        effective_preset = config.resolve_default_preset()
        active_preset_name = "default"

    provider_name = (
        config.get_provider_name(effective_preset.model, preset=effective_preset)
        or effective_preset.provider
    )
    provider = config.get_provider(effective_preset.model, preset=effective_preset)
    selected_provider = provider_name
    if effective_preset.provider != "auto":
        spec = find_by_name(effective_preset.provider)
        selected_provider = spec.name if spec else provider_name

    providers = []
    for spec in PROVIDERS:
        provider_config = getattr(config.providers, spec.name, None)
        if provider_config is None or spec.is_oauth:
            continue
        # Skip providers whose configured model is an image/video-only model —
        # they are set up for media generation, not LLM chat completions.
        cfg_model = provider_config.model or (
            defaults.model if spec.name == defaults.provider else None
        )
        if cfg_model and (
            cfg_model in spec.image_models or cfg_model in spec.video_models
        ):
            continue
        configured = _provider_configured_for_settings(
            spec, provider_config
        ) or not spec.api_key_required
        providers.append(
            {
                "name": spec.name,
                "label": spec.label,
                "configured": configured,
                "api_key_required": _provider_requires_api_key(spec),
                "api_key_hint": _mask_secret_hint(provider_config.api_key),
                "api_base": provider_config.api_base or spec.default_api_base or None,
                "default_api_base": spec.default_api_base or None,
                "model": cfg_model,
                "free_default_model": (
                    spec.free_default_model if spec.free_default_model else None
                ),
            }
        )

    search_config = config.tools.web.search
    image_config = config.tools.image_generation
    video_config = config.tools.video_generation
    search_provider = (
        search_config.provider
        if search_config.provider in _WEB_SEARCH_PROVIDER_BY_NAME
        else "duckduckgo"
    )
    image_providers = _image_generation_provider_rows(config)
    selected_image_provider = next(
        (
            provider
            for provider in image_providers
            if provider["name"] == image_config.provider
        ),
        None,
    )
    video_providers = _video_generation_provider_rows(config)
    selected_video_provider = next(
        (
            provider
            for provider in video_providers
            if provider["name"] == video_config.provider
        ),
        None,
    )
    model_presets = [
        {
            "name": "default",
            "label": "Default",
            "active": active_preset_name == "default",
            "is_default": True,
            "model": defaults.model,
            "provider": defaults.provider,
            "max_tokens": defaults.max_tokens,
            "context_window_tokens": defaults.context_window_tokens,
            "temperature": defaults.temperature,
            "reasoning_effort": defaults.reasoning_effort,
        }
    ]
    for name, preset in config.model_presets.items():
        model_presets.append(
            {
                "name": name,
                "label": name,
                "active": active_preset_name == name,
                "is_default": False,
                "model": preset.model,
                "provider": preset.provider,
                "max_tokens": preset.max_tokens,
                "context_window_tokens": preset.context_window_tokens,
                "temperature": preset.temperature,
                "reasoning_effort": preset.reasoning_effort,
            }
        )

    exec_config = config.tools.exec
    return {
        "agent": {
            "model": effective_preset.model,
            "provider": selected_provider,
            "resolved_provider": provider_name,
            "has_api_key": bool(provider and provider.api_key),
            "model_preset": active_preset_name,
            "max_tokens": effective_preset.max_tokens,
            "context_window_tokens": effective_preset.context_window_tokens,
            "temperature": effective_preset.temperature,
            "reasoning_effort": effective_preset.reasoning_effort,
            "timezone": defaults.timezone,
            "bot_name": defaults.bot_name,
            "bot_icon": defaults.bot_icon,
            "tool_hint_max_length": defaults.tool_hint_max_length,
        },
        "model_presets": model_presets,
        "providers": providers,
        "web_search": {
            "provider": search_provider,
            "api_key_hint": _mask_secret_hint(search_config.api_key),
            "base_url": search_config.base_url or None,
            "max_results": search_config.max_results,
            "timeout": search_config.timeout,
            "providers": list(_WEB_SEARCH_PROVIDER_OPTIONS),
        },
        "web": {
            "enable": config.tools.web.enable,
            "proxy": config.tools.web.proxy,
            "user_agent": config.tools.web.user_agent,
            "search": {
                "max_results": search_config.max_results,
                "timeout": search_config.timeout,
            },
            "fetch": {
                "use_jina_reader": config.tools.web.fetch.use_jina_reader,
            },
        },
        "image_generation": {
            "enabled": image_config.enabled,
            "provider": image_config.provider,
            "provider_configured": bool(
                selected_image_provider and selected_image_provider["configured"]
            ),
            "model": image_config.model,
            "default_aspect_ratio": image_config.default_aspect_ratio,
            "default_image_size": image_config.default_image_size,
            "max_images_per_turn": image_config.max_images_per_turn,
            "save_dir": image_config.save_dir,
            "providers": image_providers,
        },
        "video_generation": {
            "enabled": video_config.enabled,
            "provider": video_config.provider,
            "provider_configured": bool(
                selected_video_provider and selected_video_provider["configured"]
            ),
            "model": video_config.model,
            "default_aspect_ratio": video_config.default_aspect_ratio,
            "default_duration": video_config.default_duration,
            "save_dir": video_config.save_dir,
            "providers": video_providers,
        },
        "runtime": {
            "config_path": str(get_config_path().expanduser()),
            "workspace_path": str(config.workspace_path),
            "gateway_host": config.gateway.host,
            "gateway_port": config.gateway.port,
            "heartbeat": {
                "enabled": config.gateway.heartbeat.enabled,
                "interval_s": config.gateway.heartbeat.interval_s,
                "keep_recent_messages": config.gateway.heartbeat.keep_recent_messages,
            },
            "dream": {
                "schedule": defaults.dream.describe_schedule(),
                "max_batch_size": defaults.dream.max_batch_size,
                "max_iterations": defaults.dream.max_iterations,
                "annotate_line_ages": defaults.dream.annotate_line_ages,
            },
            "unified_session": defaults.unified_session,
        },
        "advanced": {
            "restrict_to_workspace": config.tools.restrict_to_workspace,
            "ssrf_whitelist_count": len(config.tools.ssrf_whitelist),
            "mcp_server_count": len(config.tools.mcp_servers),
            "exec_enabled": exec_config.enable,
            "exec_sandbox": exec_config.sandbox or None,
            "exec_path_append_set": bool(exec_config.path_append),
        },
        "channels": _channels_payload(config),
        "tts": _tts_payload(config),
        "requires_restart": requires_restart,
    }


def update_agent_settings(query: QueryParams) -> dict[str, Any]:
    config = load_config()
    defaults = config.agents.defaults
    changed = False
    restart_required = False

    if "model_preset" in query or "modelPreset" in query:
        preset = (_query_first_alias(query, "model_preset", "modelPreset") or "").strip()
        preset_value = None if not preset or preset == "default" else preset
        if preset_value is not None and preset_value not in config.model_presets:
            raise WebUISettingsError("unknown model preset")
        if defaults.model_preset != preset_value:
            defaults.model_preset = preset_value
            changed = True

    model = _query_first(query, "model")
    if model is not None:
        model = model.strip()
        if not model:
            raise WebUISettingsError("model is required")
        if defaults.model != model:
            defaults.model = model
            changed = True

    provider = _query_first(query, "provider")
    if provider is not None:
        provider = provider.strip()
        if not provider:
            raise WebUISettingsError("provider is required")
        spec = find_by_name(provider)
        if spec is None:
            raise WebUISettingsError("unknown provider")
        provider_config = getattr(config.providers, provider, None)
        if (
            provider_config is None
            or (
                spec.api_key_required
                and not _provider_configured_for_settings(spec, provider_config)
            )
        ):
            raise WebUISettingsError("provider is not configured")
        if defaults.provider != provider:
            defaults.provider = provider
            changed = True
        # When switching providers without explicitly setting a model,
        # auto-apply the target provider's stored model so the active model
        # stays consistent with the new provider.
        if model is None and provider_config and provider_config.model:
            if defaults.model != provider_config.model:
                defaults.model = provider_config.model
                changed = True

    # Save the model to the provider's config so it can be recalled when switching providers
    provider_model = _query_first_alias(query, "provider_model", "providerModel")
    if provider_model is not None:
        provider_model = provider_model.strip()
        active_provider = provider or defaults.provider
        provider_config = getattr(config.providers, active_provider, None)
        if provider_config is not None and provider_config.model != provider_model:
            provider_config.model = provider_model
            changed = True

    timezone = _query_first(query, "timezone")
    if timezone is not None:
        timezone = timezone.strip()
        if not timezone:
            raise WebUISettingsError("timezone is required")
        try:
            ZoneInfo(timezone)
        except Exception:
            raise WebUISettingsError("invalid timezone") from None
        if defaults.timezone != timezone:
            defaults.timezone = timezone
            changed = True
            restart_required = True

    bot_name = _query_first_alias(query, "bot_name", "botName")
    if bot_name is not None:
        bot_name = bot_name.strip()
        if not bot_name:
            raise WebUISettingsError("bot_name is required")
        if defaults.bot_name != bot_name:
            defaults.bot_name = bot_name
            changed = True
            restart_required = True

    bot_icon = _query_first_alias(query, "bot_icon", "botIcon")
    if bot_icon is not None:
        bot_icon = bot_icon.strip()
        if defaults.bot_icon != bot_icon:
            defaults.bot_icon = bot_icon
            changed = True
            restart_required = True

    tool_hint_max_length = _query_first_alias(
        query,
        "tool_hint_max_length",
        "toolHintMaxLength",
    )
    if tool_hint_max_length is not None:
        try:
            parsed = int(tool_hint_max_length)
        except ValueError:
            raise WebUISettingsError("tool_hint_max_length must be an integer") from None
        if parsed < 20 or parsed > 500:
            raise WebUISettingsError("tool_hint_max_length must be between 20 and 500")
        if defaults.tool_hint_max_length != parsed:
            defaults.tool_hint_max_length = parsed
            changed = True
            restart_required = True

    workspace = _query_first(query, "workspace")
    if workspace is not None:
        workspace = workspace.strip()
        if not workspace:
            raise WebUISettingsError("workspace is required")
        _validate_workspace_path(Path(workspace).expanduser())
        if defaults.workspace != workspace:
            _migrate_workspace_data(Path(defaults.workspace).expanduser(), Path(workspace).expanduser())
            defaults.workspace = workspace
            changed = True
            restart_required = True

    if changed:
        save_config(config)
        # Ensure the new workspace directory exists and has templates.
        if workspace is not None and defaults.workspace == workspace:
            from mona.utils.helpers import sync_workspace_templates

            ws = Path(workspace).expanduser()
            ws.mkdir(parents=True, exist_ok=True)
            sync_workspace_templates(ws)
    return settings_payload(requires_restart=restart_required)


def update_provider_settings(query: QueryParams) -> dict[str, Any]:
    provider_name = (_query_first(query, "provider") or "").strip()
    if not provider_name:
        raise WebUISettingsError("provider is required")
    spec = find_by_name(provider_name)
    if spec is None or spec.is_oauth:
        raise WebUISettingsError("unknown provider")

    config = load_config()
    provider_config = getattr(config.providers, spec.name, None)
    if provider_config is None:
        raise WebUISettingsError("unknown provider")

    changed = False
    if "api_key" in query or "apiKey" in query:
        api_key = _query_first_alias(query, "api_key", "apiKey")
        api_key = (api_key or "").strip() or None
        if provider_config.api_key != api_key:
            provider_config.api_key = api_key
            changed = True

    if "api_base" in query or "apiBase" in query:
        api_base = _query_first_alias(query, "api_base", "apiBase")
        api_base = (api_base or "").strip() or None
        if provider_config.api_base != api_base:
            provider_config.api_base = api_base
            changed = True

    model = _query_first_alias(query, "model", "model")
    if model is not None:
        model = model.strip() or None
        if provider_config.model != model:
            provider_config.model = model
            changed = True

    if changed:
        save_config(config)
    image_config = config.tools.image_generation
    restart_required = (
        changed
        and image_config.enabled
        and image_config.provider == spec.name
        and get_image_gen_provider(spec.name) is not None
    )
    return settings_payload(requires_restart=restart_required)


def update_web_search_settings(query: QueryParams) -> dict[str, Any]:
    provider_name = (_query_first(query, "provider") or "").strip().lower()
    provider_option = _WEB_SEARCH_PROVIDER_BY_NAME.get(provider_name)
    if provider_option is None:
        raise WebUISettingsError("unknown web search provider")

    config = load_config()
    search_config = config.tools.web.search
    web_config = config.tools.web
    previous_provider = search_config.provider
    changed = False
    restart_required = False

    def set_search_value(attr: str, value: object) -> None:
        nonlocal changed
        if getattr(search_config, attr) != value:
            setattr(search_config, attr, value)
            changed = True

    def set_fetch_value(attr: str, value: object) -> None:
        nonlocal changed
        if getattr(web_config.fetch, attr) != value:
            setattr(web_config.fetch, attr, value)
            changed = True

    if search_config.provider != provider_name:
        search_config.provider = provider_name
        changed = True

    credential = provider_option["credential"]
    if credential == "none":
        set_search_value("api_key", "")
        set_search_value("base_url", "")
    elif credential == "base_url":
        base_url = _query_first_alias(query, "base_url", "baseUrl")
        base_url = base_url.strip() if base_url is not None else None
        if not base_url and previous_provider == provider_name and search_config.base_url:
            base_url = search_config.base_url
        if not base_url:
            raise WebUISettingsError("base_url is required")
        set_search_value("base_url", base_url)
        set_search_value("api_key", "")
    else:
        api_key = _query_first_alias(query, "api_key", "apiKey")
        api_key = api_key.strip() if api_key is not None else None
        if not api_key and previous_provider == provider_name and search_config.api_key:
            api_key = search_config.api_key
        if not api_key:
            raise WebUISettingsError("api_key is required")
        set_search_value("api_key", api_key)
        set_search_value("base_url", "")

    max_results = _query_first_alias(query, "max_results", "maxResults")
    if max_results is not None:
        try:
            parsed = int(max_results)
        except ValueError:
            raise WebUISettingsError("max_results must be an integer") from None
        if parsed < 1 or parsed > 10:
            raise WebUISettingsError("max_results must be between 1 and 10")
        set_search_value("max_results", parsed)

    timeout = _query_first(query, "timeout")
    if timeout is not None:
        try:
            parsed_timeout = int(timeout)
        except ValueError:
            raise WebUISettingsError("timeout must be an integer") from None
        if parsed_timeout < 1 or parsed_timeout > 120:
            raise WebUISettingsError("timeout must be between 1 and 120")
        set_search_value("timeout", parsed_timeout)

    use_jina_reader = _query_first_alias(query, "use_jina_reader", "useJinaReader")
    if use_jina_reader is not None:
        normalized = use_jina_reader.strip().lower()
        if normalized not in {"1", "0", "true", "false", "yes", "no"}:
            raise WebUISettingsError("use_jina_reader must be boolean")
        previous_jina_reader = web_config.fetch.use_jina_reader
        set_fetch_value("use_jina_reader", normalized in {"1", "true", "yes"})
        if web_config.fetch.use_jina_reader != previous_jina_reader:
            restart_required = True

    if changed:
        save_config(config)
    return settings_payload(requires_restart=restart_required)


def update_image_generation_settings(query: QueryParams) -> dict[str, Any]:
    config = load_config()
    image_config = config.tools.image_generation
    changed = False

    provider_name = _query_first(query, "provider")
    if provider_name is not None:
        provider_name = provider_name.strip().lower()
        if not provider_name:
            raise WebUISettingsError("image generation provider is required")
        if get_image_gen_provider(provider_name) is None:
            raise WebUISettingsError("unknown image generation provider")
        # Verify the provider has a config entry.
        if getattr(config.providers, provider_name, None) is None:
            raise WebUISettingsError("provider is not available in configuration")
        if image_config.provider != provider_name:
            image_config.provider = provider_name
            changed = True

    enabled = _query_first(query, "enabled")
    if enabled is not None:
        parsed_enabled = _parse_bool(enabled, "enabled")
        if image_config.enabled != parsed_enabled:
            image_config.enabled = parsed_enabled
            changed = True

    model = _query_first(query, "model")
    if model is not None:
        model = model.strip()
        if not model:
            raise WebUISettingsError("image generation model is required")
        if len(model) > 200:
            raise WebUISettingsError("image generation model is too long")
        if image_config.model != model:
            image_config.model = model
            changed = True

    default_aspect_ratio = _query_first_alias(
        query,
        "default_aspect_ratio",
        "defaultAspectRatio",
    )
    if default_aspect_ratio is not None:
        default_aspect_ratio = default_aspect_ratio.strip()
        if default_aspect_ratio not in _IMAGE_GENERATION_ASPECT_RATIOS:
            raise WebUISettingsError("unsupported image generation aspect ratio")
        if image_config.default_aspect_ratio != default_aspect_ratio:
            image_config.default_aspect_ratio = default_aspect_ratio
            changed = True

    default_image_size = _query_first_alias(
        query,
        "default_image_size",
        "defaultImageSize",
    )
    if default_image_size is not None:
        default_image_size = default_image_size.strip()
        if not default_image_size:
            raise WebUISettingsError("default image size is required")
        if len(default_image_size) > 32 or not all(
            char.isascii() and (char.isalnum() or char in {"x", "X", ":", "-", "_"})
            for char in default_image_size
        ):
            raise WebUISettingsError("unsupported image generation size")
        if image_config.default_image_size != default_image_size:
            image_config.default_image_size = default_image_size
            changed = True

    max_images_per_turn = _query_first_alias(
        query,
        "max_images_per_turn",
        "maxImagesPerTurn",
    )
    if max_images_per_turn is not None:
        try:
            parsed_max = int(max_images_per_turn)
        except ValueError:
            raise WebUISettingsError("max_images_per_turn must be an integer") from None
        if parsed_max < 1 or parsed_max > 8:
            raise WebUISettingsError("max_images_per_turn must be between 1 and 8")
        if image_config.max_images_per_turn != parsed_max:
            image_config.max_images_per_turn = parsed_max
            changed = True

    if image_config.enabled:
        selected_provider = next(
            (
                provider
                for provider in _image_generation_provider_rows(config)
                if provider["name"] == image_config.provider
            ),
            None,
        )
        if not selected_provider or not selected_provider["configured"]:
            raise WebUISettingsError("image generation provider is not configured")

    if changed:
        save_config(config)
    return settings_payload(requires_restart=changed)


def update_video_generation_settings(query: QueryParams) -> dict[str, Any]:
    config = load_config()
    video_config = config.tools.video_generation
    changed = False

    provider_name = _query_first(query, "provider")
    if provider_name is not None:
        provider_name = provider_name.strip().lower()
        if not provider_name:
            raise WebUISettingsError("video generation provider is required")
        if get_video_gen_provider(provider_name) is None:
            raise WebUISettingsError("unknown video generation provider")
        if getattr(config.providers, provider_name, None) is None:
            raise WebUISettingsError("provider is not available in configuration")
        if video_config.provider != provider_name:
            video_config.provider = provider_name
            changed = True

    enabled = _query_first(query, "enabled")
    if enabled is not None:
        parsed_enabled = _parse_bool(enabled, "enabled")
        if video_config.enabled != parsed_enabled:
            video_config.enabled = parsed_enabled
            changed = True

    model = _query_first(query, "model")
    if model is not None:
        model = model.strip()
        if not model:
            raise WebUISettingsError("video generation model is required")
        if len(model) > 200:
            raise WebUISettingsError("video generation model is too long")
        if video_config.model != model:
            video_config.model = model
            changed = True

    default_aspect_ratio = _query_first_alias(
        query, "default_aspect_ratio", "defaultAspectRatio",
    )
    if default_aspect_ratio is not None:
        default_aspect_ratio = default_aspect_ratio.strip()
        if default_aspect_ratio not in _VIDEO_GENERATION_ASPECT_RATIOS:
            raise WebUISettingsError("unsupported video generation aspect ratio")
        if video_config.default_aspect_ratio != default_aspect_ratio:
            video_config.default_aspect_ratio = default_aspect_ratio
            changed = True

    default_duration = _query_first_alias(query, "default_duration", "defaultDuration")
    if default_duration is not None:
        try:
            parsed_duration = int(default_duration)
        except ValueError:
            raise WebUISettingsError("default_duration must be an integer") from None
        if parsed_duration not in _VIDEO_DURATION_OPTIONS:
            raise WebUISettingsError(
                f"default_duration must be one of {list(_VIDEO_DURATION_OPTIONS)}"
            )
        if video_config.default_duration != parsed_duration:
            video_config.default_duration = parsed_duration
            changed = True

    if video_config.enabled:
        selected_provider = next(
            (
                provider
                for provider in _video_generation_provider_rows(config)
                if provider["name"] == video_config.provider
            ),
            None,
        )
        if not selected_provider or not selected_provider["configured"]:
            raise WebUISettingsError("video generation provider is not configured")

    if changed:
        save_config(config)
    return settings_payload(requires_restart=changed)


_TTS_PROVIDERS = {"edge", "custom"}


def update_tts_settings(query: QueryParams) -> dict[str, Any]:
    """Update global TTS (语音合成) settings stored on ChannelsConfig.

    The API key is write-only: a non-empty value replaces the stored key,
    ``clearKey=true`` removes it, and omitted leaves it unchanged.
    """
    config = load_config()
    channels = config.channels
    changed = False

    provider = _query_first(query, "provider")
    if provider is not None:
        provider = provider.strip().lower()
        if provider not in _TTS_PROVIDERS:
            raise WebUISettingsError("unsupported TTS provider")
        if channels.tts_provider != provider:
            channels.tts_provider = provider
            changed = True

    voice = _query_first(query, "voice")
    if voice is not None:
        voice = voice.strip()
        if len(voice) > 200:
            raise WebUISettingsError("TTS voice is too long")
        if channels.tts_voice != voice:
            channels.tts_voice = voice
            changed = True

    api_base = _query_first_alias(query, "api_base", "apiBase")
    if api_base is not None:
        api_base = api_base.strip()
        if len(api_base) > 500:
            raise WebUISettingsError("TTS api base is too long")
        if channels.tts_api_base != api_base:
            channels.tts_api_base = api_base
            changed = True

    model = _query_first(query, "model")
    if model is not None:
        model = model.strip()
        if len(model) > 200:
            raise WebUISettingsError("TTS model is too long")
        if channels.tts_model != model:
            channels.tts_model = model
            changed = True

    api_key = _query_first_alias(query, "api_key", "apiKey")
    if api_key is not None and api_key.strip():
        key = api_key.strip()
        if channels.tts_api_key != key:
            channels.tts_api_key = key
            changed = True

    clear_key = _query_first_alias(query, "clear_key", "clearKey")
    if clear_key is not None and _parse_bool(clear_key, "clearKey"):
        if channels.tts_api_key:
            channels.tts_api_key = ""
            changed = True

    if changed:
        save_config(config)
    return settings_payload(requires_restart=False)


_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models"


async def fetch_zen_free_models() -> list[str]:
    """Fetch free model IDs from OpenCode Zen API.

    Free models have a ``-free`` suffix in their ``id`` field.
    Returns a sorted list of model ID strings; on any error returns an empty list.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(_ZEN_MODELS_URL)
        resp.raise_for_status()
        data = resp.json()
        models = data.get("data", [])
        free_ids = sorted(m["id"] for m in models if m.get("id", "").endswith("-free"))
        return free_ids
    except Exception:
        logger.exception("Failed to fetch Zen free models")
        return []
