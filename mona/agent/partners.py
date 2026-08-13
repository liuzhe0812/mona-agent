"""Partner agent data models and registry for multi-agent collaboration.

Phase 0 of the multi-agent plan (docs/design/multi-agent-development-guide.md):

- ``AgentExecutionContext``: uniform runtime identity carried by every agent run.
- ``AgentDefinition``: validated manifest for a package agent (section 5.1).
- ``ConversationMetadata``: session metadata describing direct/room shape (section 5.2).
- ``AgentRegistry``: loads the reserved Mona definition, built-in agents shipped
  under ``mona/agents/`` and installed agents under ``~/.mona/agents/``.

The file system is the only storage backend here; no Repository/Service/Factory
layers on top of it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Collection, Literal, Mapping

from loguru import logger
from pydantic import Field, ValidationError, field_validator, model_validator

import mona
from mona.config.schema import Base

# Reserved ID of the built-in main assistant. Package agents must not use it.
MONA_AGENT_ID = "mona"
RESERVED_AGENT_IDS = frozenset({MONA_AGENT_ID})

# Session.metadata key holding the serialized ConversationMetadata.
CONVERSATION_METADATA_KEY = "conversation"

AGENT_DEFINITION_SCHEMA_VERSION = 1
CONVERSATION_METADATA_SCHEMA_VERSION = 1

# Reverse-domain style IDs such as "com.mona.a-share-analyst".
_AGENT_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$")

# Built-in agent packages shipped inside the wheel (data dir, not a package).
BUILTIN_AGENTS_DIR = Path(__file__).resolve().parent.parent / "agents"


class AgentDefinitionError(ValueError):
    """Raised when an agent manifest fails validation."""


class AgentNotFoundError(KeyError):
    """Raised when an agent ID is not present in the registry."""


def normalize_agent_id(agent_id: str) -> str:
    """Return the canonical (lowercase) form of an agent ID, or raise ValueError.

    IDs must be stable, case-normalized and free of path separators / ``..`` so
    they are safe to use as directory names and map keys.
    """
    normalized = agent_id.strip().lower()
    if not normalized or not _AGENT_ID_RE.match(normalized) or ".." in normalized:
        raise ValueError(f"Invalid agent id {agent_id!r}")
    return normalized


def _validate_package_relative_path(value: str, *, field_name: str) -> str:
    """Validate a manifest path that must stay inside the package root."""
    candidate = value.strip()
    if not candidate:
        raise ValueError(f"{field_name} must be a non-empty relative path")
    if "\\" in candidate:
        raise ValueError(f"{field_name} must use forward slashes: {value!r}")
    pure = PurePosixPath(candidate)
    if pure.is_absolute():
        raise ValueError(f"{field_name} must be relative, got absolute path: {value!r}")
    if ".." in pure.parts:
        raise ValueError(f"{field_name} must not contain '..': {value!r}")
    return candidate


def _resolve_within(package_root: Path, rel_path: str, *, field_name: str) -> Path:
    """Resolve a manifest path inside the package root, rejecting escapes."""
    root = package_root.resolve()
    resolved = (root / rel_path).resolve()
    if not resolved.is_relative_to(root):
        raise AgentDefinitionError(
            f"{field_name} path {rel_path!r} escapes package root {package_root}"
        )
    return resolved


@dataclass(frozen=True, slots=True)
class AgentExecutionContext:
    """Uniform identity carried by every agent execution entry point.

    Tools read the current agent from this object; a model-supplied ``agent_id``
    is never a trusted source. In direct chats ``conversation_id`` is the
    chat_id and ``room_id`` is empty; in rooms ``room_id`` equals
    ``conversation_id``.
    """

    agent_id: str
    conversation_id: str
    conversation_type: Literal["direct", "room"]
    room_id: str | None = None
    job_id: str | None = None
    workflow_run_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "agent_id", normalize_agent_id(self.agent_id))
        if not self.conversation_id:
            raise ValueError("conversation_id must be non-empty")
        if self.conversation_type == "direct" and self.room_id is not None:
            raise ValueError("direct conversations must not set room_id")
        if self.conversation_type == "room" and self.room_id != self.conversation_id:
            raise ValueError("room conversations must use conversation_id as room_id")


class AgentDefinition(Base):
    """Validated agent manifest (``agent.json``), see guide section 5.1.

    ``tool_allowlist`` semantics: for package agents the runner intersects this
    list with the platform-safe tool table, so an empty list means no tools.
    The reserved Mona definition bypasses the allowlist entirely and keeps the
    full platform tool table.
    """

    schema_version: int = AGENT_DEFINITION_SCHEMA_VERSION
    id: str
    display_name: str = Field(min_length=1)
    description: str = ""
    avatar: str | None = None
    prompt: str = "prompt.md"
    model: str = "inherit"
    tool_allowlist: list[str] = Field(default_factory=list)
    can_delegate: bool = False
    skills: list[str] = Field(default_factory=list)
    package_id: str = ""
    package_version: str = ""

    @field_validator("schema_version")
    @classmethod
    def _check_schema_version(cls, value: int) -> int:
        if value != AGENT_DEFINITION_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported agent schema_version {value}, "
                f"expected {AGENT_DEFINITION_SCHEMA_VERSION}"
            )
        return value

    @field_validator("id")
    @classmethod
    def _check_id(cls, value: str) -> str:
        return normalize_agent_id(value)

    @field_validator("package_id")
    @classmethod
    def _check_package_id(cls, value: str) -> str:
        return normalize_agent_id(value) if value else value

    @field_validator("prompt")
    @classmethod
    def _check_prompt(cls, value: str) -> str:
        # Empty means "no package prompt"; only valid for the synthesized Mona
        # definition. Package manifests must name a prompt file (enforced at load).
        if not value.strip():
            return ""
        return _validate_package_relative_path(value, field_name="prompt")

    @field_validator("avatar")
    @classmethod
    def _check_avatar(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _validate_package_relative_path(value, field_name="avatar")

    @field_validator("skills")
    @classmethod
    def _check_skills(cls, value: list[str]) -> list[str]:
        return [
            _validate_package_relative_path(entry, field_name="skills[]") for entry in value
        ]


class ConversationMetadata(Base):
    """Conversation shape stored in ``Session.metadata["conversation"]`` (5.2).

    Legacy sessions without this key are treated as a direct chat with Mona;
    see :func:`conversation_from_session_metadata`.
    """

    schema_version: int = CONVERSATION_METADATA_SCHEMA_VERSION
    type: Literal["direct", "room"]
    title: str = ""
    goal: str | None = None
    agent_ids: list[str] = Field(min_length=1)
    direct_agent_id: str | None = None
    active_workflow_id: str | None = None
    active_workflow_revision: int | None = None
    archived: bool = False

    @field_validator("schema_version")
    @classmethod
    def _check_schema_version(cls, value: int) -> int:
        if value != CONVERSATION_METADATA_SCHEMA_VERSION:
            raise ValueError(
                f"unsupported conversation schema_version {value}, "
                f"expected {CONVERSATION_METADATA_SCHEMA_VERSION}"
            )
        return value

    @field_validator("agent_ids")
    @classmethod
    def _check_agent_ids(cls, value: list[str]) -> list[str]:
        deduped: list[str] = []
        for entry in value:
            normalized = normalize_agent_id(entry)
            if normalized not in deduped:
                deduped.append(normalized)
        return deduped

    @field_validator("direct_agent_id")
    @classmethod
    def _check_direct_agent_id(cls, value: str | None) -> str | None:
        return normalize_agent_id(value) if value is not None else None

    @model_validator(mode="after")
    def _check_shape(self) -> ConversationMetadata:
        if self.type == "direct":
            if self.direct_agent_id is None:
                raise ValueError("direct conversations must set direct_agent_id")
            if self.direct_agent_id not in self.agent_ids:
                raise ValueError("direct_agent_id must be a member of agent_ids")
        elif self.direct_agent_id is not None:
            raise ValueError("room conversations must not set direct_agent_id")
        return self

    @classmethod
    def direct(cls, agent_id: str, *, title: str = "") -> ConversationMetadata:
        """Build a direct-chat metadata with the given agent."""
        normalized = normalize_agent_id(agent_id)
        return cls(type="direct", title=title, agent_ids=[normalized], direct_agent_id=normalized)

    @classmethod
    def room(
        cls,
        agent_ids: list[str],
        *,
        title: str = "",
        goal: str | None = None,
    ) -> ConversationMetadata:
        """Build a room metadata with the given member agents."""
        return cls(type="room", title=title, goal=goal, agent_ids=agent_ids)

    def to_session_metadata(self) -> dict[str, Any]:
        """Serialize for storage under ``Session.metadata["conversation"]``."""
        return self.model_dump(by_alias=True)


def conversation_from_session_metadata(
    metadata: Mapping[str, Any] | None,
) -> ConversationMetadata:
    """Read conversation metadata from a session, defaulting legacy sessions to Mona.

    Sessions without a ``conversation`` key (all pre-multi-agent sessions) are a
    direct chat with Mona. Invalid payloads also fall back to Mona with a
    warning; the stored value is never rewritten here.
    """
    raw = (metadata or {}).get(CONVERSATION_METADATA_KEY)
    if raw is None:
        return ConversationMetadata.direct(MONA_AGENT_ID)
    try:
        return ConversationMetadata.model_validate(raw)
    except ValidationError as exc:
        logger.warning(
            "Invalid conversation metadata, falling back to Mona direct chat: {}", exc
        )
        return ConversationMetadata.direct(MONA_AGENT_ID)


@dataclass(frozen=True, slots=True)
class ResolvedAgent:
    """An agent definition plus its on-disk package root.

    ``package_root`` is ``None`` for the synthesized Mona definition, which
    reuses the platform templates instead of a package directory.
    """

    definition: AgentDefinition
    package_root: Path | None


def _mona_definition() -> AgentDefinition:
    """Synthesize the reserved Mona definition; platform templates stay the source."""
    return AgentDefinition(
        id=MONA_AGENT_ID,
        display_name="Mona",
        description="Mona main assistant; reuses platform templates and the full tool table",
        prompt="",
        can_delegate=True,
        package_id=MONA_AGENT_ID,
        package_version=mona.__version__,
    )


class AgentRegistry:
    """Loads and queries agent definitions.

    Sources, in priority order:

    1. The synthesized reserved Mona definition.
    2. Built-in agents shipped under ``mona/agents/`` (fatal if broken — that is
       a shipping bug, not user data).
    3. Installed agents under ``~/.mona/agents/<agent_id>/agent.json`` (broken
       manifests are logged and skipped so third-party content cannot crash the
       app).
    """

    def __init__(
        self,
        *,
        builtin_dir: Path | None = None,
        installed_dir: Path | None = None,
        known_tool_names: Collection[str] | None = None,
    ) -> None:
        self._builtin_dir = builtin_dir if builtin_dir is not None else BUILTIN_AGENTS_DIR
        self._installed_dir = installed_dir
        self._known_tool_names = known_tool_names
        self._agents: dict[str, ResolvedAgent] = {}
        self._load()

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    def _load(self) -> None:
        entry = ResolvedAgent(definition=_mona_definition(), package_root=None)
        self._agents[MONA_AGENT_ID] = entry
        self._load_dir(self._builtin_dir, source="builtin", strict=True)
        installed = self._installed_dir or self._default_installed_dir()
        if installed is not None:
            self._load_dir(installed, source="installed", strict=False)

    @staticmethod
    def _default_installed_dir() -> Path | None:
        """Resolve ``~/.mona/agents`` without creating it; None when config is unavailable."""
        try:
            from mona.config.paths import get_data_dir

            return get_data_dir() / "agents"
        except Exception as exc:
            logger.warning("Cannot resolve installed agents dir, skipping: {}", exc)
            return None

    def _load_dir(self, base: Path, *, source: str, strict: bool) -> None:
        if not base.is_dir():
            return
        for child in sorted(base.iterdir()):
            manifest = child / "agent.json"
            if not child.is_dir() or not manifest.is_file():
                continue
            try:
                definition = self._load_manifest(manifest, package_root=child)
            except AgentDefinitionError as exc:
                if strict:
                    raise
                logger.error("Skipping broken {} agent manifest {}: {}", source, manifest, exc)
                continue
            if definition.id in self._agents:
                message = f"duplicate agent id {definition.id!r} in {manifest}"
                if strict:
                    raise AgentDefinitionError(message)
                logger.warning("{}; keeping the earlier definition", message)
                continue
            self._agents[definition.id] = ResolvedAgent(
                definition=definition, package_root=child
            )
            logger.debug("Loaded {} agent {!r} from {}", source, definition.id, manifest)

    def _load_manifest(self, manifest: Path, *, package_root: Path) -> AgentDefinition:
        try:
            raw = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise AgentDefinitionError(f"{manifest}: cannot read manifest: {exc}") from exc
        try:
            definition = AgentDefinition.model_validate(raw)
        except ValidationError as exc:
            raise AgentDefinitionError(f"{manifest}: invalid manifest: {exc}") from exc
        if definition.id in RESERVED_AGENT_IDS:
            raise AgentDefinitionError(f"{manifest}: agent id {definition.id!r} is reserved")
        if not definition.prompt:
            raise AgentDefinitionError(f"{manifest}: package agents must declare a prompt file")
        if package_root.name != definition.id:
            raise AgentDefinitionError(
                f"{manifest}: agent id {definition.id!r} must match directory name "
                f"{package_root.name!r}"
            )
        self._validate_package_paths(definition, package_root)
        if self._known_tool_names is not None:
            unknown = [
                name for name in definition.tool_allowlist if name not in self._known_tool_names
            ]
            if unknown:
                raise AgentDefinitionError(
                    f"{manifest}: tool_allowlist references unregistered tools: "
                    f"{', '.join(sorted(set(unknown)))}"
                )
        return definition

    @staticmethod
    def _validate_package_paths(definition: AgentDefinition, package_root: Path) -> None:
        if not definition.prompt:
            return
        prompt_path = _resolve_within(package_root, definition.prompt, field_name="prompt")
        if not prompt_path.is_file():
            raise AgentDefinitionError(
                f"prompt file {definition.prompt!r} not found in {package_root}"
            )
        if definition.avatar is not None:
            avatar_path = _resolve_within(package_root, definition.avatar, field_name="avatar")
            if not avatar_path.is_file():
                logger.warning(
                    "Agent {!r} avatar {} does not exist", definition.id, avatar_path
                )
        for skill_rel in definition.skills:
            skill_dir = _resolve_within(package_root, skill_rel, field_name="skills[]")
            if not skill_dir.is_dir():
                logger.warning(
                    "Agent {!r} skill dir {} does not exist", definition.id, skill_dir
                )

    # ------------------------------------------------------------------
    # Queries
    # ------------------------------------------------------------------

    def get(self, agent_id: str) -> AgentDefinition | None:
        """Return the definition for an agent ID, or None."""
        entry = self._agents.get(normalize_agent_id(agent_id))
        return entry.definition if entry else None

    def require(self, agent_id: str) -> AgentDefinition:
        """Return the definition for an agent ID, raising AgentNotFoundError."""
        definition = self.get(agent_id)
        if definition is None:
            raise AgentNotFoundError(agent_id)
        return definition

    def get_entry(self, agent_id: str) -> ResolvedAgent | None:
        """Return the full resolved entry (definition + package root), or None."""
        return self._agents.get(normalize_agent_id(agent_id))

    def list_agents(self) -> list[AgentDefinition]:
        """List all loaded agents (Mona first, then built-ins, then installed)."""
        return [entry.definition for entry in self._agents.values()]

    def package_root(self, agent_id: str) -> Path | None:
        """Return the package root for an agent (None for Mona or unknown IDs)."""
        entry = self._agents.get(normalize_agent_id(agent_id))
        return entry.package_root if entry else None

    def resolve_skill_dirs(self, agent_id: str) -> list[Path]:
        """Resolve the agent package skill directories (existing dirs only)."""
        entry = self._agents.get(normalize_agent_id(agent_id))
        if entry is None or entry.package_root is None:
            return []
        dirs: list[Path] = []
        for skill_rel in entry.definition.skills:
            skill_dir = _resolve_within(entry.package_root, skill_rel, field_name="skills[]")
            if skill_dir.is_dir():
                dirs.append(skill_dir)
        return dirs

    def load_prompt(self, agent_id: str) -> str:
        """Load the agent prompt markdown; empty string for Mona or unknown IDs."""
        entry = self._agents.get(normalize_agent_id(agent_id))
        if entry is None or entry.package_root is None or not entry.definition.prompt:
            return ""
        prompt_path = _resolve_within(
            entry.package_root, entry.definition.prompt, field_name="prompt"
        )
        return prompt_path.read_text(encoding="utf-8")

    def __contains__(self, agent_id: object) -> bool:
        if not isinstance(agent_id, str):
            return False
        try:
            return normalize_agent_id(agent_id) in self._agents
        except ValueError:
            return False

    def __len__(self) -> int:
        return len(self._agents)
