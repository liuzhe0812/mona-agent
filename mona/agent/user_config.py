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
from typing import Any, Literal

from pydantic import Field, field_validator

from mona.agent.partners import MONA_AGENT_ID, AgentDefinition, normalize_agent_id
from mona.config.schema import Base

AGENT_USER_CONFIG_SCHEMA_VERSION = 4
_V2_EXPLICIT_PERMISSION_TOOLS = frozenset({"crypto", "config_set_provider"})
_AVATAR_DATA_URL_RE = re.compile(
    r"^data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$",
    re.IGNORECASE,
)
_MAX_AVATAR_BYTES = 2 * 1024 * 1024
_MAX_AVATAR_CHARS = 3_000_000

# Platform-owned personal-knowledge capabilities that a user may explicitly
# grant to an installed Agent even when its package manifest did not request
# them. Other tools remain bounded by the package allowlist.
USER_GRANTABLE_PLATFORM_TOOLS = frozenset({
    "knowledge_read",
    "knowledge_search",
    "notes_create",
    "notes_read",
    "notes_save_image",
    "notes_search",
})
# Agent infrastructure required for normal work. These capabilities are not
# user permissions and must survive old or empty permission selections.
REQUIRED_AGENT_TOOLS = frozenset({
    "apply_patch",
    "conversation_read",
    "conversation_search",
    "deliver_file",
    "edit_file",
    "exec",
    "find_files",
    "grep",
    "http_request",
    "list_dir",
    "load_capability",
    "memory_read",
    "memory_search",
    "pdf",
    "read_file",
    "skill_asset_copy",
    "skill_read",
    "skill_reference_read",
    "skill_script_run",
    "web_fetch",
    "web_search",
    "write_file",
})
# Platform capabilities that every user-visible expert may configure. Package
# manifests still decide their initial enabled subset; this set only defines a
# stable settings ceiling shared by all experts.
COMMON_AGENT_TOOLS = frozenset({
    *USER_GRANTABLE_PLATFORM_TOOLS,
    *REQUIRED_AGENT_TOOLS,
    "browser_act",
    "browser_observe",
    "computer_act",
    "computer_observe",
    "crypto",
    "document",
    "generate_image",
    "generate_video",
    "office",
})
AGENT_EXCLUSIVE_TOOLS: dict[str, frozenset[str]] = {
    "com.mona.a-share-analyst": frozenset({
        "stock_context_read",
        "stock_quote",
        "stock_report_read",
        "stock_research_status",
        "stock_screen_compare",
        "stock_screen_read",
        "stock_screen_run",
        "stock_screen_strategy_save",
        "stock_screen_validation_read",
        "stock_source_open",
    }),
    "com.mona.academic-researcher": frozenset({
        "academic_search",
        "chart",
        "dataframe_query",
        "research_record",
        "scientific_tool",
    }),
    "com.mona.musician": frozenset({"guitar_tab", "music_score"}),
}
TOOL_AGENT_OWNERS: dict[str, frozenset[str]] = {
    **{
        name: frozenset({agent_id})
        for agent_id in ("com.mona.academic-researcher", "com.mona.musician")
        for name in AGENT_EXCLUSIVE_TOOLS[agent_id]
    },
    "artifact_read": frozenset({
        "com.mona.stock-bear-researcher",
        "com.mona.stock-bull-researcher",
        "com.mona.stock-referee",
    }),
    "stock_context_read": frozenset({
        "com.mona.a-share-analyst",
        "com.mona.stock-selection-analyst",
    }),
    "stock_evidence_read": frozenset({
        "com.mona.stock-bear-researcher",
        "com.mona.stock-bull-researcher",
        "com.mona.stock-diagnosis-semantic-researcher",
        "com.mona.stock-fundamental-analyst",
        "com.mona.stock-news-analyst",
        "com.mona.stock-referee",
        "com.mona.stock-tech-analyst",
    }),
    "stock_opportunity_submit": frozenset({"com.mona.stock-selection-analyst"}),
    "stock_quote": frozenset({"com.mona.a-share-analyst"}),
    "stock_report_read": frozenset({"com.mona.a-share-analyst"}),
    "stock_research_status": frozenset({"com.mona.a-share-analyst"}),
    "stock_screen_compare": frozenset({
        "com.mona.a-share-analyst",
        "com.mona.stock-selection-analyst",
    }),
    "stock_screen_read": frozenset({
        "com.mona.a-share-analyst",
        "com.mona.stock-selection-analyst",
    }),
    "stock_screen_run": frozenset({
        "com.mona.a-share-analyst",
        "com.mona.stock-selection-analyst",
    }),
    "stock_screen_strategy_save": frozenset({
        "com.mona.a-share-analyst",
        "com.mona.stock-selection-analyst",
    }),
    "stock_screen_validation_read": frozenset({
        "com.mona.a-share-analyst",
        "com.mona.stock-selection-analyst",
    }),
    "stock_source_open": frozenset({
        "com.mona.a-share-analyst",
        "com.mona.stock-news-analyst",
        "com.mona.stock-selection-analyst",
    }),
    "submit_bear_case": frozenset({"com.mona.stock-bear-researcher"}),
    "submit_bull_case": frozenset({"com.mona.stock-bull-researcher"}),
    "submit_fundamental_view": frozenset({"com.mona.stock-fundamental-analyst"}),
    "submit_news_view": frozenset({"com.mona.stock-news-analyst"}),
    # Internal finalizer called by submit_stock_report_staged, never model-visible.
    "submit_stock_report": frozenset(),
    "submit_stock_diagnosis_semantic": frozenset({
        "com.mona.stock-diagnosis-semantic-researcher",
    }),
    "submit_stock_report_staged": frozenset({"com.mona.stock-referee"}),
    "submit_technical_view": frozenset({"com.mona.stock-tech-analyst"}),
}


def tool_available_to_agent(name: str, agent_id: str) -> bool:
    owners = TOOL_AGENT_OWNERS.get(name)
    return owners is None or agent_id in owners
AGENT_KNOWLEDGE_TOOLS = (
    "knowledge_search",
    "knowledge_read",
)
MONA_CONTEXTUAL_TOOLS = (
    "canvas",
    "complete_goal",
    "delegate_agent",
    "hoard_capture",
    "hoard_search",
    "long_task",
    "my",
    "propose_workflow",
    "run_collaboration",
    "spawn",
    "update_plan",
)

# Query permissions are intentionally atomic: search without evidence reading
# encourages answers from snippets, while read without search is not usable.
QUERY_TOOL_PAIRS = (
    frozenset({"notes_search", "notes_read"}),
    frozenset({"knowledge_search", "knowledge_read"}),
)

_ACADEMIC_SKILL_RENAMES = {
    "research-evidence": ("literature-search", "paper-reading", "citation-audit"),
    "research-design": ("research-design",),
    "research-execution": ("analysis-experiment",),
    "research-writing": ("manuscript-editing", "review-response"),
}


def _normalize_browser_tool_names(names: list[str]) -> list[str]:
    from mona.agent.tools.browser import BROWSER_LEGACY_TOOL_NAMES

    browser_observe_legacy = {
        "browser_list_tabs",
        "browser_read",
        "browser_snapshot",
        "browser_screenshot",
    }
    existing = set(names)
    normalized = list(names)
    if existing & browser_observe_legacy:
        normalized.append("browser_observe")
    if existing & (set(BROWSER_LEGACY_TOOL_NAMES) - browser_observe_legacy):
        normalized.append("browser_act")
    return [
        name
        for name in dict.fromkeys(normalized)
        if name not in set(BROWSER_LEGACY_TOOL_NAMES) - {"browser_act"}
    ]


def _normalize_knowledge_tool_names(names: list[str]) -> list[str]:
    legacy_search = {"materials_search", "wiki_search"}
    legacy_read = {"materials_read", "wiki_read"}
    existing = set(names)
    normalized = [name for name in names if name not in legacy_search | legacy_read]
    if existing & legacy_search:
        normalized.append("knowledge_search")
    if existing & legacy_read:
        normalized.append("knowledge_read")
    return list(dict.fromkeys(normalized))


class AgentConfigConflictError(ValueError):
    """Raised when a caller saves against a stale configuration revision."""


class KnowledgeBaseScope(Base):
    """Knowledge libraries one Agent may query."""

    mode: Literal["all", "none", "specific"] = "all"
    knowledge_base_ids: list[str] = Field(default_factory=list)

    @field_validator("knowledge_base_ids")
    @classmethod
    def _validate_ids(cls, value: list[str]) -> list[str]:
        from mona.materials.catalog import validate_library_id

        result: list[str] = []
        for item in value:
            library_id = validate_library_id(item)
            if library_id not in result:
                result.append(library_id)
        return result


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
    knowledge_base_scope: KnowledgeBaseScope = Field(default_factory=KnowledgeBaseScope)
    disabled_skills: list[str] = Field(default_factory=list)
    delegation_enabled: bool = True
    # Legacy fields accepted from existing settings; execution follows disabled_skills.
    script_enabled_skills: list[str] = Field(default_factory=list)
    script_enabled_skill_hashes: dict[str, str] = Field(default_factory=dict)
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

    @field_validator("script_enabled_skill_hashes")
    @classmethod
    def _validate_script_hashes(cls, value: dict[str, str]) -> dict[str, str]:
        result: dict[str, str] = {}
        for raw_name, raw_hash in value.items():
            name = raw_name.strip()
            content_hash = raw_hash.strip().lower()
            if not name or not re.fullmatch(r"[0-9a-f]{64}", content_hash):
                raise ValueError("script approval hashes must be SHA-256 values")
            result[name] = content_hash
        return result


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
    knowledge_base_scope: KnowledgeBaseScope = Field(default_factory=KnowledgeBaseScope)
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
        config = AgentUserConfig.model_validate(raw)
        source_schema_version = config.schema_version
        granted_tools = config.granted_tools
        if granted_tools is not None and source_schema_version < 2:
            granted_tools = [
                name for name in granted_tools if name not in _V2_EXPLICIT_PERMISSION_TOOLS
            ]
        if granted_tools is not None and source_schema_version < 4:
            granted_tools = _normalize_knowledge_tool_names(granted_tools)
        if source_schema_version < AGENT_USER_CONFIG_SCHEMA_VERSION:
            config = config.model_copy(update={
                "schema_version": AGENT_USER_CONFIG_SCHEMA_VERSION,
                "granted_tools": granted_tools,
            })
        if normalize_agent_id(agent_id) == "com.mona.academic-researcher":
            updates: dict[str, list[str]] = {}
            for field_name in ("disabled_skills", "script_enabled_skills"):
                names: list[str] = []
                for name in getattr(config, field_name):
                    for replacement in _ACADEMIC_SKILL_RENAMES.get(name, (name,)):
                        if replacement not in names:
                            names.append(replacement)
                updates[field_name] = names
            config = config.model_copy(update=updates)
        return config
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
    """Resolve package defaults plus explicitly user-grantable platform tools."""
    config = config or load_agent_user_config(definition.id)
    if definition.id == MONA_AGENT_ID:
        manifest_tools: list[str] | None = None
    else:
        manifest_tools = _normalize_knowledge_tool_names(list(dict.fromkeys([
            *(
                name
                for name in definition.tool_allowlist
                if tool_available_to_agent(name, definition.id)
            ),
            *AGENT_EXCLUSIVE_TOOLS.get(definition.id, ()),
            *REQUIRED_AGENT_TOOLS,
        ])))

    if manifest_tools is None:
        allowed_tools = list(config.granted_tools) if config.granted_tools is not None else None
    elif config.granted_tools is None:
        allowed_tools = manifest_tools
    else:
        ceiling = set(manifest_tools) | COMMON_AGENT_TOOLS
        allowed_tools = [name for name in config.granted_tools if name in ceiling]

    if allowed_tools is not None:
        allowed_tools = _normalize_browser_tool_names(allowed_tools)
        allowed_tools = _normalize_knowledge_tool_names(allowed_tools)
        allowed_tools = [
            name for name in allowed_tools if name not in AGENT_KNOWLEDGE_TOOLS
        ] + list(AGENT_KNOWLEDGE_TOOLS)
        if definition.id == MONA_AGENT_ID:
            allowed_tools = [
                name for name in allowed_tools if name not in MONA_CONTEXTUAL_TOOLS
            ] + list(MONA_CONTEXTUAL_TOOLS)
        allowed_tools = [
            name for name in allowed_tools if name not in REQUIRED_AGENT_TOOLS
        ] + list(REQUIRED_AGENT_TOOLS)

    if (
        allowed_tools is not None
        and "notes_save_image" in allowed_tools
        and "notes_create" not in allowed_tools
    ):
        allowed_tools = [name for name in allowed_tools if name != "notes_save_image"]

    if allowed_tools is not None:
        allowed = set(allowed_tools)
        for pair in QUERY_TOOL_PAIRS:
            if not pair <= allowed:
                allowed.difference_update(pair)
        allowed_tools = [name for name in allowed_tools if name in allowed]

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
        knowledge_base_scope=config.knowledge_base_scope,
        disabled_skills=list(config.disabled_skills),
        delegation_enabled=definition.can_delegate and config.delegation_enabled,
        script_enabled_skills=list(config.script_enabled_skills),
    )


def configurable_agent_tools(definition: AgentDefinition) -> list[str] | None:
    """Return the tools the user may enable for one Agent.

    ``None`` keeps Mona's unrestricted platform catalog. Package Agents keep
    their manifest tools plus the narrow set of platform-owned knowledge
    capabilities above.
    """
    if definition.id == MONA_AGENT_ID:
        return None
    return _normalize_knowledge_tool_names(_normalize_browser_tool_names(list(
        dict.fromkeys([
            *sorted(COMMON_AGENT_TOOLS),
            *(
                name
                for name in definition.tool_allowlist
                if tool_available_to_agent(name, definition.id)
            ),
            *sorted(AGENT_EXCLUSIVE_TOOLS.get(definition.id, ())),
        ])
    )))


__all__ = [
    "AGENT_USER_CONFIG_SCHEMA_VERSION",
    "AgentConfigConflictError",
    "AgentUserConfig",
    "AGENT_KNOWLEDGE_TOOLS",
    "AGENT_EXCLUSIVE_TOOLS",
    "COMMON_AGENT_TOOLS",
    "KnowledgeBaseScope",
    "TOOL_AGENT_OWNERS",
    "USER_GRANTABLE_PLATFORM_TOOLS",
    "QUERY_TOOL_PAIRS",
    "REQUIRED_AGENT_TOOLS",
    "configurable_agent_tools",
    "EffectiveAgentConfig",
    "get_agent_user_config_path",
    "load_agent_user_config",
    "save_agent_user_config",
    "tool_available_to_agent",
    "resolve_effective_agent_config",
]
