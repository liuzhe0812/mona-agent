"""User-owned overrides for immutable AgentDefinition manifests.

The agent package remains the authority for identity and maximum capabilities.
This module only persists a small, agent-private configuration layer that can
rename, disable, or further restrict an agent without changing its package.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import Field, field_validator

from mona.agent.partners import MONA_AGENT_ID, AgentDefinition, normalize_agent_id
from mona.config.schema import Base

AGENT_USER_CONFIG_SCHEMA_VERSION = 1
_AVATAR_DATA_URL_RE = re.compile(
    r"^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$",
    re.IGNORECASE,
)
_MAX_AVATAR_BYTES = 2 * 1024 * 1024
_MAX_AVATAR_CHARS = 3_000_000


class AgentConfigConflictError(ValueError):
    """Raised when a caller saves against a stale configuration revision."""


class AgentUserConfig(Base):
    """Mutable user settings stored beside one agent's private data."""

    schema_version: int = AGENT_USER_CONFIG_SCHEMA_VERSION
    revision: int = Field(default=0, ge=0)
    enabled: bool = True
    display_name: str | None = Field(default=None, max_length=80)
    # URLs and package-relative paths remain supported. User-selected images
    # are persisted as small, validated data URLs so the UI can render them
    # without exposing arbitrary local filesystem paths.
    avatar: str | None = Field(default=None, max_length=_MAX_AVATAR_CHARS)
    # Name of a configured global model preset; null inherits the package/global default.
    model_preset: str | None = Field(default=None, max_length=80)
    reasoning_effort: str | None = Field(default=None, max_length=40)
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=200_000)
    # null means inherit the manifest's allowed tools; [] means explicitly no tools.
    granted_tools: list[str] | None = None
    disabled_skills: list[str] = Field(default_factory=list)
    delegation_enabled: bool = True
    # Scripts are never enabled merely by installing a skill. This list is managed
    # through an explicit UI action after the user reviews the script risk.
    script_enabled_skills: list[str] = Field(default_factory=list)
    updated_at: str | None = None

    @field_validator("display_name", "avatar", "model_preset", "reasoning_effort")
    @classmethod
    def _trim_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("avatar")
    @classmethod
    def _validate_avatar_data_url(cls, value: str | None) -> str | None:
        if value is None or not value.lower().startswith("data:"):
            return value
        match = _AVATAR_DATA_URL_RE.fullmatch(value)
        if match is None:
            raise ValueError("avatar data URL must be a PNG, JPEG, WebP, or GIF image")
        try:
            raw = base64.b64decode(match.group(2), validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("avatar data URL is not valid base64") from exc
        if len(raw) > _MAX_AVATAR_BYTES:
            raise ValueError("avatar image must be 2 MB or smaller")
        return value

    @field_validator("granted_tools", "disabled_skills", "script_enabled_skills")
    @classmethod
    def _dedupe_names(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        names: list[str] = []
        for item in value:
            if not isinstance(item, str):
                raise ValueError("names must be strings")
            name = item.strip()
            if not name:
                raise ValueError("names must not be empty")
            if name not in names:
                names.append(name)
        return names


class EffectiveAgentConfig(Base):
    """Resolved values consumed by runtime and returned for UI explanation."""

    agent_id: str
    enabled: bool
    display_name: str
    avatar: str | None = None
    model_preset: str | None = None
    reasoning_effort: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    allowed_tools: list[str] | None = None
    disabled_skills: list[str] = Field(default_factory=list)
    delegation_enabled: bool = False
    script_enabled_skills: list[str] = Field(default_factory=list)


def get_agent_user_config_path(agent_id: str) -> Path:
    """Return the fixed private configuration path for *agent_id*."""
    from mona.config.paths import get_agent_dir

    return get_agent_dir(normalize_agent_id(agent_id)) / "config.json"


def load_agent_user_config(agent_id: str) -> AgentUserConfig:
    """Read a user override, treating absent/corrupt files as no overrides.

    A malformed local override must not stop the agent registry from loading.
    The management API exposes the error during save; runtime safely falls back
    to defaults until the user fixes the file through the UI.
    """
    path = get_agent_user_config_path(agent_id)
    if not path.exists():
        return AgentUserConfig()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return AgentUserConfig.model_validate(raw)
    except (OSError, ValueError, json.JSONDecodeError):
        return AgentUserConfig()


def _atomic_json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".config_", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def save_agent_user_config(
    agent_id: str,
    update: dict[str, Any],
    *,
    expected_revision: int | None,
) -> AgentUserConfig:
    """Merge a narrow update and atomically persist a new revision."""
    current = load_agent_user_config(agent_id)
    if expected_revision is not None and expected_revision != current.revision:
        raise AgentConfigConflictError(
            f"agent config changed (expected revision {expected_revision}, current {current.revision})"
        )
    permitted = set(AgentUserConfig.model_fields) - {"schema_version", "revision", "updated_at"}
    unknown = set(update) - permitted
    if unknown:
        raise ValueError(f"unsupported agent config fields: {', '.join(sorted(unknown))}")
    payload = current.model_dump()
    payload.update(update)
    payload["revision"] = current.revision + 1
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()
    saved = AgentUserConfig.model_validate(payload)
    _atomic_json_write(get_agent_user_config_path(agent_id), saved.model_dump(by_alias=True))
    return saved


def resolve_effective_agent_config(
    definition: AgentDefinition,
    config: AgentUserConfig | None = None,
) -> EffectiveAgentConfig:
    """Resolve user choices without ever expanding a package capability bound."""
    config = config or load_agent_user_config(definition.id)
    if definition.id == MONA_AGENT_ID:
        manifest_tools: list[str] | None = None
    else:
        manifest_tools = list(definition.tool_allowlist)

    if manifest_tools is None:
        allowed_tools = list(config.granted_tools) if config.granted_tools is not None else None
    elif config.granted_tools is None:
        allowed_tools = manifest_tools
    else:
        allowed_tools = [name for name in config.granted_tools if name in manifest_tools]

    return EffectiveAgentConfig(
        agent_id=definition.id,
        enabled=config.enabled,
        display_name=config.display_name or definition.display_name,
        avatar=config.avatar if config.avatar is not None else definition.avatar,
        model_preset=config.model_preset,
        reasoning_effort=config.reasoning_effort,
        temperature=config.temperature,
        max_tokens=config.max_tokens,
        allowed_tools=allowed_tools,
        disabled_skills=list(config.disabled_skills),
        delegation_enabled=definition.can_delegate and config.delegation_enabled,
        script_enabled_skills=list(config.script_enabled_skills),
    )


__all__ = [
    "AGENT_USER_CONFIG_SCHEMA_VERSION",
    "AgentConfigConflictError",
    "AgentUserConfig",
    "EffectiveAgentConfig",
    "get_agent_user_config_path",
    "load_agent_user_config",
    "save_agent_user_config",
    "resolve_effective_agent_config",
]
