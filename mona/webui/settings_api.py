"""Settings REST helpers for the WebUI HTTP surface.

The WebSocket channel owns transport/authentication. This module owns the
settings payload shape and the allowlisted config mutations exposed to WebUI.
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx
from loguru import logger

from mona.config.loader import get_config_path, load_config, save_config
from mona.config.schema import ProviderConfig
from mona.providers.capabilities import resolve_capabilities
from mona.providers.cindy_catalog import CINDY_CHAT_PROVIDER_BY_ID, CINDY_CHAT_PROVIDERS
from mona.providers.image_generation import get_image_gen_provider
from mona.providers.registry import (
    PROVIDERS,
    custom_provider_spec,
    find_by_name,
    is_custom_provider_name,
)
from mona.providers.video_generation import get_video_gen_provider
from mona.security.network import validate_url_target

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


def _validate_custom_api_base(value: str | None) -> str:
    """Validate the user-entered HTTP endpoint without making a request."""
    base = (value or "").strip().rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise WebUISettingsError("API Base 必须是合法的 http/https 地址")
    if parsed.username or parsed.password:
        raise WebUISettingsError("API Base 不得包含用户名或密码")
    return base


def _custom_provider_id(display_name: str, existing: set[str]) -> str:
    """Allocate a stable, non-overwriting ID for a new custom provider."""
    normalized = unicodedata.normalize("NFKD", display_name).encode(
        "ascii", "ignore"
    ).decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", normalized.lower()).strip("-") or "provider"
    candidate = f"custom-{slug}"
    suffix = 2
    static_ids = {spec.name for spec in PROVIDERS}
    while candidate in existing or candidate in static_ids:
        candidate = f"custom-{slug}-{suffix}"
        suffix += 1
    return candidate


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
    """Copy workspace-scoped data to a new workspace without overwriting.

    Per shared-output-workspace-execution-plan §8.5:
    - Copy sessions, legacy output, Agent outputs and product projects.
    - Never copy runtime state; Job/Workflow/Run data is instance-scoped.
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

    # 2. Keep legacy output readable while old sessions are being migrated.
    _copy_dir_non_destructive(old_ws / "output", new_ws / "output")

    # 3. Copy final user-visible ownership roots. Runtime directories are
    # intentionally absent from this list.
    for name in (
        "agent-workspaces",
        "stock_projects",
        "ppt_projects",
        "video_projects",
    ):
        _copy_dir_non_destructive(old_ws / name, new_ws / name)

    # memory/ and skills/ are intentionally NOT copied — they are global
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
        if spec.is_oauth or spec.is_local or spec.chat_only:
            continue
        provider_config = _provider_config(config, spec.name)
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
        if spec.is_oauth or spec.is_local or spec.chat_only:
            continue
        provider_config = _provider_config(config, spec.name)
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


def _preset_capabilities_payload(config: Any, preset: Any) -> dict[str, Any]:
    """Resolve model capabilities for a preset row in the settings payload."""
    provider_name = config.get_provider_name(preset.model, preset=preset)
    if not provider_name and preset.provider and preset.provider != "auto":
        provider_name = preset.provider
    spec = find_by_name(provider_name) if provider_name else None
    return resolve_capabilities(spec, preset.model).to_dict()


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
        provider_config = _provider_config(config, spec.name)
        if provider_config is None or spec.is_oauth or spec.chat_only:
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
                "backend": spec.backend,
                "probe_supported": (
                    not spec.is_oauth
                    and spec.backend
                    in ("openai_compat", "anthropic")
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
    default_preset_obj = config.resolve_default_preset()
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
            "capabilities": _preset_capabilities_payload(config, default_preset_obj),
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
                "capabilities": _preset_capabilities_payload(config, preset),
            }
        )

    exec_config = config.tools.exec
    chat_providers = _chat_provider_rows(config)
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
        "chat_providers": chat_providers,
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
        "stock": {
            "enabled": config.stock.enabled,
            "auto_review_enabled": config.stock.auto_review_enabled,
            "review_time": config.stock.review_time,
            "review_scope": config.stock.review_scope,
            "push_notification": config.stock.push_notification,
            "push_email": config.stock.push_email,
            "quote_refresh_sec": config.stock.quote_refresh_sec,
        },
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
        provider_config = _provider_config(config, provider)
        if (
            provider_config is None
            or (
                spec.api_key_required
                and not _provider_configured_for_settings(spec, provider_config)
            )
            or (
                is_custom_provider_name(spec.name)
                and (
                    not provider_config.api_base
                    or not provider_config.enabled_models
                )
            )
        ):
            raise WebUISettingsError("provider is not configured")
        chat_provider = next(
            (row for row in _chat_provider_rows(config) if row["name"] == provider),
            None,
        )
        if model is not None and chat_provider is not None and model not in {
            item["id"] for item in chat_provider["models"] if item["enabled"]
        }:
            raise WebUISettingsError("model is not enabled for this provider")
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
        provider_config = _provider_config(config, active_provider)
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
    raw_provider_name = (_query_first(query, "provider") or "").strip()
    if not raw_provider_name:
        raise WebUISettingsError("provider is required")
    config = load_config()
    custom_name = _query_first_alias(query, "custom_name", "customName")
    creating_custom = raw_provider_name == "custom" and custom_name is not None

    if creating_custom:
        display_name = (custom_name or "").strip()
        if not display_name:
            raise WebUISettingsError("显示名称不能为空")
        if len(display_name) > 120:
            raise WebUISettingsError("显示名称过长")
        existing_ids = set(config.providers.cindy) | {
            registry_spec.name for registry_spec in PROVIDERS
        }
        provider_name = _custom_provider_id(display_name, existing_ids)
        spec = custom_provider_spec(provider_name)
        if spec is None:
            raise WebUISettingsError("invalid custom provider")
        catalog_entry = None
        custom_entry = True
        provider_config = ProviderConfig(display_name=display_name)
    else:
        spec = find_by_name(raw_provider_name)
        if spec is None or spec.is_oauth:
            raise WebUISettingsError("unknown provider")
        provider_name = spec.name
        custom_entry = is_custom_provider_name(provider_name)
        catalog_entry = CINDY_CHAT_PROVIDER_BY_ID.get(provider_name)
        if custom_entry and provider_name not in config.providers.cindy:
            raise WebUISettingsError("unknown provider")
        provider_config = None

    delete_requested = (catalog_entry is not None or custom_entry) and _parse_bool(
        _query_first(query, "delete") or "false", "delete"
    )
    legacy_config = getattr(config.providers, provider_name, None)
    if delete_requested:
        was_default = config.agents.defaults.provider == provider_name
        if not was_default and config.agents.defaults.provider == "auto":
            try:
                was_default = (
                    config.get_provider_name(config.agents.defaults.model)
                    == provider_name
                )
            except Exception:
                was_default = False
        config.providers.cindy.pop(provider_name, None)
        # Clear a legacy fixed-field entry with the same public ID as well;
        # otherwise a deleted Cindy provider would reappear as configured.
        if isinstance(legacy_config, ProviderConfig):
            setattr(config.providers, provider_name, ProviderConfig())
        if was_default:
            remaining = [
                row
                for row in _chat_provider_rows(config)
                if row["name"] != provider_name and row["configured"] and not row.get("is_builtin")
            ]
            order = {entry.id: index for index, entry in enumerate(CINDY_CHAT_PROVIDERS)}
            remaining.sort(
                key=lambda row: (
                    row.get("region") != "cn",
                    row.get("name", "").startswith("custom-"),
                    order.get(row["name"], len(order)),
                )
            )
            if remaining:
                replacement = remaining[0]
                enabled_models = [
                    model["id"] for model in replacement["models"] if model["enabled"]
                ]
                saved_model = replacement.get("model")
                config.agents.defaults.provider = replacement["name"]
                available_model_ids = enabled_models or [
                    model["id"] for model in replacement["models"]
                ]
                config.agents.defaults.model = (
                    saved_model
                    if saved_model in available_model_ids
                    else (available_model_ids[0] if available_model_ids else "")
                )
            else:
                # Zen resolves its free_default_model when model is empty.
                config.agents.defaults.provider = "zen"
                config.agents.defaults.model = ""
        save_config(config)
        return settings_payload()

    # Cindy IDs are persisted in their keyed map even when a legacy fixed
    # provider with the same public name exists (for example ``deepseek``).
    if provider_config is None:
        provider_config = (
            config.providers.cindy.get(provider_name)
            if catalog_entry is not None or custom_entry
            else _provider_config(config, spec.name)
        )
    if provider_config is None:
        if catalog_entry is None:
            raise WebUISettingsError("unknown provider")
        # Copy legacy credentials on first edit so existing Mona configs keep
        # working while all new Cindy state uses the dynamic map.
        provider_config = (
            legacy_config.model_copy(deep=True)
            if isinstance(legacy_config, ProviderConfig)
            else ProviderConfig()
        )
        config.providers.cindy[provider_name] = provider_config

    changed = False
    models_updated = False
    if (
        catalog_entry is not None
        and not catalog_entry.api_base_editable
        and provider_config.api_base
        and provider_config.api_base.rstrip("/") != catalog_entry.api_base.rstrip("/")
    ):
        provider_config.api_base = None
        changed = True

    if "api_key" in query or "apiKey" in query:
        api_key = _query_first_alias(query, "api_key", "apiKey")
        api_key = (api_key or "").strip() or None
        if custom_entry and api_key is None and provider_config.api_key:
            api_key = provider_config.api_key
        if provider_config.api_key != api_key:
            provider_config.api_key = api_key
            changed = True

    if "api_base" in query or "apiBase" in query:
        api_base = _query_first_alias(query, "api_base", "apiBase")
        api_base = (api_base or "").strip() or None
        if custom_entry:
            if not api_base and creating_custom:
                raise WebUISettingsError("API Base 不能为空")
            if api_base:
                api_base = _validate_custom_api_base(api_base)
        if catalog_entry is not None and not catalog_entry.api_base_editable:
            if api_base and api_base.rstrip("/") != catalog_entry.api_base.rstrip("/"):
                raise WebUISettingsError("该 Cindy 供应商的 API Base 不可编辑")
            api_base = None
        if provider_config.api_base != api_base:
            provider_config.api_base = api_base
            changed = True

    if custom_entry and custom_name is not None and not creating_custom:
        display_name = (custom_name or "").strip()
        if not display_name:
            raise WebUISettingsError("显示名称不能为空")
        if len(display_name) > 120:
            raise WebUISettingsError("显示名称过长")
        if provider_config.display_name != display_name:
            provider_config.display_name = display_name
            changed = True

    if custom_entry and creating_custom and not provider_config.api_base:
        raise WebUISettingsError("API Base 不能为空")

    model = _query_first_alias(query, "model", "model")
    if model is not None:
        model = model.strip() or None
        if provider_config.model != model:
            provider_config.model = model
            changed = True
    if custom_entry and creating_custom and model is None:
        raise WebUISettingsError("模型不能为空")
    if custom_entry and creating_custom and not (
        "enabled_models" in query or "enabledModels" in query
    ):
        raise WebUISettingsError("enabled_models must not be empty")

    if (catalog_entry is not None or custom_entry or spec.free_default_model) and (
        "enabled_models" in query or "enabledModels" in query
    ):
        raw_enabled = _query_first_alias(query, "enabled_models", "enabledModels")
        try:
            enabled = json.loads(raw_enabled or "[]")
        except json.JSONDecodeError:
            raise WebUISettingsError("enabled_models must be a JSON array") from None
        if not isinstance(enabled, list) or not all(
            isinstance(item, str) for item in enabled
        ):
            raise WebUISettingsError("enabled_models must be a JSON array of strings")
        if not enabled and creating_custom:
            raise WebUISettingsError("enabled_models must not be empty")
        known_models = {item.id for item in catalog_entry.models} if catalog_entry else set()
        if spec.free_default_model:
            known_models.add(spec.free_default_model)
        known_models.update(
            str(item.get("id"))
            for item in (provider_config.discovered_models or [])
            if isinstance(item, dict) and item.get("id")
        )
        raw_discovered_for_validation = _query_first_alias(
            query, "discovered_models", "discoveredModels"
        )
        if raw_discovered_for_validation:
            try:
                raw_items = json.loads(raw_discovered_for_validation)
            except json.JSONDecodeError:
                raw_items = []
            if isinstance(raw_items, list):
                known_models.update(
                    str(item.get("id"))
                    for item in raw_items
                    if isinstance(item, dict) and item.get("id")
                )
        if any(item not in known_models for item in enabled):
            raise WebUISettingsError("enabled_models contains an unknown model")
        if spec.free_default_model and any(not item.endswith("-free") for item in enabled):
            raise WebUISettingsError("内置免费供应商仅支持免费模型")
        normalized_enabled = list(dict.fromkeys(enabled))
        if provider_config.enabled_models != normalized_enabled:
            provider_config.enabled_models = normalized_enabled
            changed = True
        models_updated = True

    if (catalog_entry is not None or custom_entry or spec.free_default_model) and (
        "discovered_models" in query or "discoveredModels" in query
    ):
        raw_discovered = _query_first_alias(
            query, "discovered_models", "discoveredModels"
        )
        try:
            discovered = json.loads(raw_discovered or "[]")
        except json.JSONDecodeError:
            raise WebUISettingsError("discovered_models must be a JSON array") from None
        if not isinstance(discovered, list):
            raise WebUISettingsError("discovered_models must be a JSON array")
        normalized_discovered: list[dict[str, Any]] = []
        seen_discovered: set[str] = set()
        for item in discovered:
            if not isinstance(item, dict):
                raise WebUISettingsError("discovered_models contains an invalid model")
            model_id = str(item.get("id") or "").strip()
            if not model_id:
                continue
            if spec.free_default_model and not model_id.endswith("-free"):
                raise WebUISettingsError("内置免费供应商仅支持免费模型")
            context_window = item.get("contextWindow")
            if context_window is not None and (
                isinstance(context_window, bool) or not isinstance(context_window, int)
            ):
                raise WebUISettingsError(
                    "discovered_models.contextWindow must be an integer"
                )
            if model_id in seen_discovered:
                continue
            seen_discovered.add(model_id)
            normalized_discovered.append(
                {
                    "id": model_id,
                    "name": str(item.get("name") or model_id),
                    **(
                        {"context_window": context_window}
                        if context_window is not None
                        else {}
                    ),
                }
            )
        existing_discovered = list(provider_config.discovered_models or [])
        existing_ids = {
            str(item.get("id"))
            for item in existing_discovered
            if isinstance(item, dict) and item.get("id")
        }
        merged_discovered = existing_discovered + [
            item for item in normalized_discovered if item["id"] not in existing_ids
        ]
        if provider_config.discovered_models != merged_discovered:
            provider_config.discovered_models = merged_discovered
            changed = True

        if provider_config.enabled_models is not None:
            known_models = {item.id for item in catalog_entry.models} if catalog_entry else set()
            if spec.free_default_model:
                known_models.add(spec.free_default_model)
            known_models.update(
                str(item.get("id"))
                for item in merged_discovered
                if isinstance(item, dict) and item.get("id")
            )
            reconciled_enabled = [
                model_id
                for model_id in provider_config.enabled_models
                if model_id in known_models
            ]
            if provider_config.enabled_models and not reconciled_enabled:
                fallback_model = (
                    catalog_entry.models[0].id
                    if catalog_entry and catalog_entry.models
                    else (spec.free_default_model or next((item["id"] for item in merged_discovered), None))
                )
                if fallback_model is None:
                    raise WebUISettingsError("至少需要一个模型")
                reconciled_enabled = [fallback_model]
            if provider_config.enabled_models != reconciled_enabled:
                provider_config.enabled_models = reconciled_enabled
                changed = True
            models_updated = True

    if creating_custom:
        # Only expose a new provider in the config map after all required
        # scalar fields and model payload syntax have passed validation.
        config.providers.cindy[provider_name] = provider_config

    if (catalog_entry is not None or custom_entry or spec.free_default_model) and models_updated and provider_config.enabled_models:
        enabled_models = provider_config.enabled_models
        if provider_config.model and provider_config.model not in enabled_models:
            provider_config.model = enabled_models[0]
            changed = True

        defaults = config.agents.defaults
        defaults_use_provider = defaults.provider == provider_name
        if not defaults_use_provider and defaults.provider == "auto":
            try:
                defaults_use_provider = (
                    config.get_provider_name(defaults.model) == provider_name
                )
            except Exception:
                defaults_use_provider = False
        if defaults_use_provider and defaults.model and defaults.model not in enabled_models:
            defaults.model = enabled_models[0]
            changed = True

    if custom_entry:
        if not provider_config.display_name:
            raise WebUISettingsError("显示名称不能为空")
        if not provider_config.api_base:
            raise WebUISettingsError("API Base 不能为空")
        if creating_custom and not provider_config.enabled_models:
            raise WebUISettingsError("enabled_models must not be empty")
        known_models = {
            str(item.get("id"))
            for item in (provider_config.discovered_models or [])
            if isinstance(item, dict) and item.get("id")
        }
        if any(model_id not in known_models for model_id in provider_config.enabled_models or []):
            raise WebUISettingsError("enabled_models contains an unknown model")
        if provider_config.enabled_models and not provider_config.model:
            provider_config.model = provider_config.enabled_models[0]
            changed = True
        elif provider_config.enabled_models and provider_config.model not in provider_config.enabled_models:
            provider_config.model = provider_config.enabled_models[0]
            changed = True

    if models_updated:
        changed = _ensure_enabled_model_default(config) or changed

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
        if _provider_config(config, provider_name) is None:
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
        if _provider_config(config, provider_name) is None:
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


_STOCK_REVIEW_TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def update_stock_settings(
    query: QueryParams,
    *,
    cron_service: Any | None = None,
    bootstrap: Any | None = None,
) -> dict[str, Any]:
    """Update the stock module section (design §13, dev plan T17).

    When ``cron_service`` is given, the daily-review job is synced to the
    resulting config: it exists only when both the module and automatic
    review are enabled. The sync runs only after a successful save, so a
    rejected validation never touches cron state.

    When ``bootstrap`` is given and the module ends up enabled, it is
    invoked with the saved :class:`StockConfig` so the caller can run the
    idempotent pack bootstrap (hidden room + templates) without the gateway
    needing a restart (dev plan T21).
    """
    from mona.agent.pack_bootstrap import sync_stock_review_cron

    config = load_config()
    stock = config.stock
    changed = False

    enabled = _query_first(query, "enabled")
    if enabled is not None:
        value = _parse_bool(enabled, "enabled")
        if stock.enabled != value:
            stock.enabled = value
            changed = True

    auto_review_enabled = _query_first_alias(
        query, "auto_review_enabled", "autoReviewEnabled"
    )

    if auto_review_enabled is not None:
        value = _parse_bool(auto_review_enabled, "autoReviewEnabled")
        if stock.auto_review_enabled != value:
            stock.auto_review_enabled = value
            changed = True

    review_time = _query_first_alias(query, "review_time", "reviewTime")
    if review_time is not None:
        review_time = review_time.strip()
        if not _STOCK_REVIEW_TIME_PATTERN.fullmatch(review_time):
            raise WebUISettingsError("reviewTime must be HH:MM (00:00-23:59)")
        if stock.review_time != review_time:
            stock.review_time = review_time
            changed = True

    review_scope = _query_first_alias(query, "review_scope", "reviewScope")
    if review_scope is not None:
        review_scope = review_scope.strip()
        if review_scope not in ("all", "focus"):
            raise WebUISettingsError("reviewScope must be 'all' or 'focus'")
        if stock.review_scope != review_scope:
            stock.review_scope = review_scope
            changed = True

    push_notification = _query_first_alias(query, "push_notification", "pushNotification")
    if push_notification is not None:
        value = _parse_bool(push_notification, "pushNotification")
        if stock.push_notification != value:
            stock.push_notification = value
            changed = True

    push_email = _query_first_alias(query, "push_email", "pushEmail")
    if push_email is not None:
        value = _parse_bool(push_email, "pushEmail")
        if stock.push_email != value:
            stock.push_email = value
            changed = True

    quote_refresh = _query_first_alias(query, "quote_refresh_sec", "quoteRefreshSec")
    if quote_refresh is not None:
        try:
            value = int(quote_refresh.strip())
        except ValueError:
            raise WebUISettingsError("quoteRefreshSec must be an integer") from None
        if not (5 <= value <= 3600):
            raise WebUISettingsError("quoteRefreshSec must be between 5 and 3600")
        if stock.quote_refresh_sec != value:
            stock.quote_refresh_sec = value
            changed = True

    if changed:
        save_config(config)
        if cron_service is not None:
            sync_stock_review_cron(cron_service, stock)
        if stock.enabled and bootstrap is not None:
            bootstrap(stock)
    return settings_payload(requires_restart=False)


def _provider_config(config: Any, provider_name: str) -> Any:
    """Resolve fixed-schema and Cindy dynamic provider configs uniformly."""
    providers = config.providers
    getter = getattr(providers, "get_provider_config", None)
    return getter(provider_name) if getter else getattr(providers, provider_name, None)


def _chat_provider_config(config: Any, provider_name: str) -> Any:
    """Resolve only the Cindy chat-provider entry for a catalog ID."""
    dynamic = config.providers.cindy.get(provider_name)
    if dynamic is not None:
        return dynamic
    # Read legacy fixed fields for backwards compatibility; first mutation
    # above migrates a copy into the Cindy map.
    return getattr(config.providers, provider_name, None)


def _chat_provider_rows(config: Any) -> list[dict[str, Any]]:
    """Return Cindy's chat catalog with persisted state and no secrets."""
    rows: list[dict[str, Any]] = []
    for entry in CINDY_CHAT_PROVIDERS:
        provider_config = _chat_provider_config(config, entry.id)
        configured = bool(provider_config) and (
            bool(provider_config.api_key) or not entry.api_key_required
        )
        selected = (
            list(provider_config.enabled_models)
            if provider_config and provider_config.enabled_models is not None
            else None
        )
        catalog_models: list[dict[str, Any]] = [
            {
                "id": model.id,
                "name": model.name,
                "context_window": model.context_window,
            }
            for model in entry.models
        ]
        seen_ids = {model["id"] for model in catalog_models}
        for model in (provider_config.discovered_models if provider_config else None) or []:
            model_id = str(model.get("id") or "").strip()
            if not model_id or model_id in seen_ids:
                continue
            seen_ids.add(model_id)
            catalog_models.append(
                {
                    "id": model_id,
                    "name": str(model.get("name") or model_id),
                    "context_window": model.get("context_window"),
                }
            )
        rows.append(
            {
                "name": entry.id,
                "label": entry.name,
                "configured": configured,
                "api_key_required": entry.api_key_required,
                "api_key_hint": _mask_secret_hint(
                    provider_config.api_key if provider_config else None
                ),
                "api_base": (
                    provider_config.api_base
                    if provider_config and entry.api_base_editable
                    else None
                )
                or entry.api_base,
                "default_api_base": entry.api_base,
                "model": provider_config.model if provider_config else None,
                "models": [
                    {
                        **model,
                        "enabled": selected is None or model["id"] in selected,
                        "recommended": index == 0,
                    }
                    for index, model in enumerate(catalog_models)
                ],
                "models_url": entry.models_url,
                "region": entry.region,
                "api_base_editable": entry.api_base_editable,
                "is_custom": False,
            }
        )
    zen = find_by_name("zen")
    if zen and zen.free_default_model:
        provider_config = _provider_config(config, zen.name)
        selected = (
            list(provider_config.enabled_models)
            if provider_config and provider_config.enabled_models is not None
            else None
        )
        models = [{"id": zen.free_default_model, "name": zen.free_default_model}]
        seen_ids = {zen.free_default_model}
        for model in (provider_config.discovered_models if provider_config else None) or []:
            model_id = str(model.get("id") or "").strip()
            if not model_id or not model_id.endswith("-free") or model_id in seen_ids:
                continue
            seen_ids.add(model_id)
            models.append({"id": model_id, "name": str(model.get("name") or model_id)})
        rows.insert(
            0,
            {
                "name": zen.name,
                "label": zen.display_name,
                "configured": True,
                "api_key_required": False,
                "api_base": zen.default_api_base,
                "default_api_base": zen.default_api_base,
                "model": (provider_config.model if provider_config and provider_config.model else zen.free_default_model),
                "models": [
                    {**model, "enabled": selected is None or model["id"] in selected, "recommended": index == 0}
                    for index, model in enumerate(models)
                ],
                "models_url": _ZEN_MODELS_URL,
                "api_base_editable": False,
                "is_builtin": True,
            },
        )
    for provider_name, provider_config in config.providers.cindy.items():
        if not is_custom_provider_name(provider_name):
            continue
        discovered_models: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for model in provider_config.discovered_models or []:
            if not isinstance(model, dict):
                continue
            model_id = str(model.get("id") or "").strip()
            if not model_id or model_id in seen_ids:
                continue
            seen_ids.add(model_id)
            discovered_models.append(
                {
                    "id": model_id,
                    "name": str(model.get("name") or model_id),
                    "context_window": model.get("context_window"),
                }
            )
        selected = list(provider_config.enabled_models or [])
        rows.append(
            {
                "name": provider_name,
                "label": provider_config.display_name or provider_name,
                "configured": bool(
                    provider_config.display_name
                    and provider_config.api_base
                    and discovered_models
                ),
                "api_key_required": False,
                "api_key_hint": _mask_secret_hint(provider_config.api_key),
                "api_base": provider_config.api_base or "",
                "default_api_base": provider_config.api_base or "",
                "model": provider_config.model,
                "models": [
                    {
                        **model,
                        "enabled": model["id"] in selected,
                        "recommended": index == 0,
                    }
                    for index, model in enumerate(discovered_models)
                ],
                "models_url": None,
                "region": None,
                "api_base_editable": True,
                "is_custom": True,
            }
        )
    return rows


def _ensure_enabled_model_default(config: Any) -> bool:
    """Keep one chat model enabled globally and rehome an invalid default."""
    rows = _chat_provider_rows(config)
    choices = [
        (row, [model["id"] for model in row["models"] if model["enabled"]])
        for row in rows
        if row["configured"]
    ]
    choices = [(row, models) for row, models in choices if models]
    if not choices:
        raise WebUISettingsError("至少需要保留一个可用模型")

    defaults = config.agents.defaults
    current_provider = defaults.provider
    if current_provider == "auto":
        try:
            current_provider = config.get_provider_name(defaults.model)
        except Exception:
            current_provider = ""
    current_model = defaults.model
    if current_provider == "zen" and not current_model:
        zen = find_by_name("zen")
        current_model = zen.free_default_model if zen else ""
    if any(
        row["name"] == current_provider
        and current_model in models
        for row, models in choices
    ):
        return False

    preferred = [choice for choice in choices if not choice[0].get("is_builtin")]
    order = {entry.id: index for index, entry in enumerate(CINDY_CHAT_PROVIDERS)}
    preferred.sort(
        key=lambda choice: (
            choice[0].get("region") != "cn",
            choice[0]["name"].startswith("custom-"),
            order.get(choice[0]["name"], len(order)),
        )
    )
    replacement, models = (preferred or choices)[0]
    defaults.provider = replacement["name"]
    defaults.model = replacement["model"] if replacement.get("model") in models else models[0]
    return True


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


def sync_zen_free_models(models: list[str]) -> bool:
    """Persist the live Zen catalog without changing an explicit model selection."""
    model_ids = list(dict.fromkeys(model.strip() for model in models if model.strip().endswith("-free")))
    if not model_ids:
        return False

    config = load_config()
    spec = find_by_name("zen")
    provider_config = _provider_config(config, "zen")
    if spec is None or provider_config is None or not spec.free_default_model:
        return False

    discovered = [
        {"id": model_id, "name": model_id}
        for model_id in model_ids
        if model_id != spec.free_default_model
    ]
    changed = provider_config.discovered_models != discovered
    if changed:
        provider_config.discovered_models = discovered

    known_models = {spec.free_default_model, *model_ids}
    if provider_config.enabled_models is not None:
        enabled = [model_id for model_id in provider_config.enabled_models if model_id in known_models]
        if provider_config.enabled_models and not enabled:
            enabled = [spec.free_default_model]
        if provider_config.enabled_models != enabled:
            provider_config.enabled_models = enabled
            changed = True

    enabled_models = provider_config.enabled_models
    if enabled_models is not None and provider_config.model not in enabled_models:
        next_model = enabled_models[0] if enabled_models else None
        if provider_config.model != next_model:
            provider_config.model = next_model
            changed = True
    elif provider_config.model and provider_config.model not in known_models:
        provider_config.model = spec.free_default_model
        changed = True

    changed = _ensure_enabled_model_default(config) or changed
    if changed:
        save_config(config)
    return changed


# ─── Provider model probing ───────────────────────────────────────────
#
# Fetch a provider's real model catalog by hitting its OpenAI-compatible
# ``GET /v1/models`` (or vendor equivalent). Mirrors the approach used by
# OpenAkita's ``model_probe.probe_models``: one HTTP GET, normalised payload
# parsing, typed errors with Chinese user messages.
#
# Mona-specific: every outbound request MUST pass ``validate_url_target``
# (project_rules.md SSRF 红线).


def _models_url_for(backend: str, api_base: str, provider_name: str = "") -> str | None:
    """Resolve the models-list URL for a (backend, provider, api_base) tuple.

    Returns ``None`` when the backend/provider combo has no public catalog
    route; the caller surfaces a friendly "unsupported" message.
    """
    base = (api_base or "").strip().rstrip("/")
    if not base:
        return None

    provider_l = (provider_name or "").lower()
    backend_l = (backend or "").lower()

    # DashScope's OpenAI-compat entry is /compatible-mode/v1/models.
    # If the user already pasted a base ending in /compatible-mode/v1,
    # just append /models; otherwise rebuild from the bare host.
    if provider_l == "dashscope" and "dashscope.aliyuncs.com" in base:
        if "/compatible-mode" in base:
            return f"{base.rstrip('/')}/models"
        return f"{base.rstrip('/')}/compatible-mode/v1/models"

    # Anthropic native API has no public /v1/models, but relays that
    # expose Claude through an OpenAI shim usually do — still try /v1/models.
    if backend_l in ("openai_compat", "anthropic"):
        # Normalise: strip trailing /v1/chat/completions, /chat/completions,
        # or /v1 so we can re-append a canonical /v1/models.
        for suffix in ("/v1/chat/completions", "/chat/completions", "/v1"):
            if base.endswith(suffix):
                base = base[: -len(suffix)]
                break
        return f"{base}/v1/models"

    return None


def _parse_models_payload(payload: Any) -> list[str]:
    """Extract a flat ``list[str]`` of model ids from arbitrary shapes.

    Accepted shapes (any of):
      - ``{"data": [{"id": "gpt-4o"}, ...]}``        (OpenAI standard)
      - ``{"data": ["gpt-4o", "gpt-4o-mini"]}``       (some relays)
      - ``{"models": [{"name": "claude-3.5"}]}``      (Anthropic-ish)
      - ``[{"id": "x"}, {"id": "y"}]``                (flat list at root)
      - ``["x", "y"]``                                (string array)
    Duplicates removed, first-seen order preserved.
    """
    items: list[Any] = []
    if isinstance(payload, dict):
        for key in ("data", "models", "list"):
            value = payload.get(key)
            if isinstance(value, list):
                items = value
                break
    elif isinstance(payload, list):
        items = payload

    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        if isinstance(item, str):
            name = item.strip()
        elif isinstance(item, dict):
            name = str(item.get("id") or item.get("name") or "").strip()
        else:
            continue
        if not name or name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


async def probe_provider_models(
    *,
    provider_name: str,
    api_key: str | None = None,
    api_base: str | None = None,
    timeout: float = 15.0,
) -> list[str]:
    """Fetch the model catalog for one provider.

    Raises ``WebUISettingsError`` on any failure (auth / network / unsupported /
    parse), with a Chinese ``message`` suitable for surfacing to the UI.
    On success returns a list of model id strings (may be empty).
    """
    spec = find_by_name(provider_name)
    if spec is None:
        raise WebUISettingsError("unknown provider")
    catalog_entry = CINDY_CHAT_PROVIDER_BY_ID.get(spec.name)

    # OAuth / non-HTTP providers (Codex, Copilot, Bedrock) can't be probed.
    if spec.is_oauth or spec.backend in ("openai_codex", "github_copilot", "bedrock", "azure_openai"):
        raise WebUISettingsError("该服务商不支持自动拉取模型列表，请手动填写")

    config = load_config()
    provider_config = _provider_config(config, spec.name)
    if provider_config is None:
        if catalog_entry is None:
            raise WebUISettingsError("unknown provider")
        provider_config = ProviderConfig()

    if catalog_entry and not catalog_entry.api_base_editable:
        if api_base and api_base.rstrip("/") != catalog_entry.api_base.rstrip("/"):
            raise WebUISettingsError("该 Cindy 供应商的 API Base 不可编辑")
        effective_base = catalog_entry.api_base
    else:
        effective_base = (
            api_base
            or provider_config.api_base
            or (catalog_entry.api_base if catalog_entry else None)
            or spec.default_api_base
            or ""
        ).strip()
    if not effective_base:
        raise WebUISettingsError("请先填写 API Base 后再拉取模型")

    # ``custom`` is the create-form sentinel, not a persisted provider.  Do
    # not borrow the legacy fixed ``providers.custom`` key for a new endpoint;
    # only an explicitly supplied request key may be used.  Persisted
    # ``custom-*`` providers retain the normal saved-key fallback for edits.
    effective_key = (
        (api_key or "").strip()
        if provider_name.strip() == "custom"
        else (api_key or provider_config.api_key or "").strip()
    )

    url = (
        catalog_entry.models_url
        if catalog_entry and catalog_entry.models_url
        else _models_url_for(spec.backend, effective_base, spec.name)
    )
    if not url:
        raise WebUISettingsError("该服务商不支持自动拉取模型列表，请手动填写")

    # SSRF 红线：所有出站 HTTP 必须过 validate_url_target
    ok, err = validate_url_target(url)
    if not ok:
        raise WebUISettingsError(f"API Base 不允许访问：{err}")

    headers: dict[str, str] = {"Accept": "application/json"}
    if effective_key:
        # Send both Bearer and x-api-key so we don't branch per provider;
        # an extra header an endpoint ignores is harmless.
        headers["Authorization"] = f"Bearer {effective_key}"
        headers["x-api-key"] = effective_key
        headers["anthropic-version"] = "2023-06-01"

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=headers)
    except httpx.TimeoutException:
        raise WebUISettingsError(
            f"探测超时（>{timeout:.0f}s），请检查网络或 API Base 是否可达"
        ) from None
    except httpx.HTTPError as exc:
        raise WebUISettingsError(f"无法访问该 API Base：{exc}") from exc

    body = resp.text or ""
    status = resp.status_code

    if status in (401, 403):
        raise WebUISettingsError(
            f"API Key 被拒绝（HTTP {status}），请检查 Key / 计费是否正常"
        )
    if status == 404:
        raise WebUISettingsError("该 endpoint 没有 /v1/models 路由，无法拉取模型列表")
    if status >= 400:
        raise WebUISettingsError(f"拉取失败 HTTP {status}：{body[:120]}")

    # Some expired relays return an HTML 200 login page — treat as unsupported.
    head = body.lstrip()[:64].lower()
    if head.startswith(("<!doctype", "<html", "<head", "<body")):
        raise WebUISettingsError("endpoint 返回 HTML 页面（可能需要登录），不是模型列表")

    try:
        payload = resp.json() if body else None
    except ValueError as exc:
        raise WebUISettingsError(f"endpoint 返回内容不是 JSON: {body[:100]}") from exc

    if not isinstance(payload, (dict, list)):
        raise WebUISettingsError("endpoint 返回内容格式无法识别")

    models = _parse_models_payload(payload)
    if spec.free_default_model:
        models = [model for model in models if model.endswith("-free")]
    if not models and isinstance(payload, dict) and payload.get("error"):
        err_msg = str(payload["error"])[:200]
        raise WebUISettingsError(f"endpoint 返回错误: {err_msg}")
    return models
