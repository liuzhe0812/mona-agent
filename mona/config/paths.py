"""Runtime path helpers derived from the active config context."""

from __future__ import annotations

from pathlib import Path

from mona.utils.helpers import ensure_dir


def get_config_path() -> Path:
    """Get the configuration file path (lazy import to break circular dependency).

    Delegates to ``mona.config.loader.get_config_path`` at call time so
    that importing this module never triggers a circular import during startup.
    """
    from mona.config.loader import get_config_path as _loader_get_config_path
    return _loader_get_config_path()


def get_data_dir() -> Path:
    """Return the instance-level runtime data directory."""
    return ensure_dir(get_config_path().parent)


def get_runtime_subdir(name: str) -> Path:
    """Return a named runtime subdirectory under the instance data dir."""
    return ensure_dir(get_data_dir() / name)


def get_media_dir(channel: str | None = None) -> Path:
    """Return the media directory, optionally namespaced per channel."""
    base = get_runtime_subdir("media")
    return ensure_dir(base / channel) if channel else base


def get_cron_dir() -> Path:
    """Return the cron storage directory."""
    return get_runtime_subdir("cron")


def get_logs_dir() -> Path:
    """Return the logs directory."""
    return get_runtime_subdir("logs")


def get_webui_dir() -> Path:
    """Return the directory for WebUI-only persisted display threads (JSON)."""
    return get_runtime_subdir("webui")


def get_workspace_path(workspace: str | None = None) -> Path:
    """Resolve and ensure the agent workspace path."""
    path = Path(workspace).expanduser() if workspace else Path.home() / ".mona" / "workspace"
    return ensure_dir(path)


def get_shared_output_dir(workspace: str | Path) -> Path:
    """Return the shared artifacts directory for non-project sessions.

    ``workspace`` must be the configured Mona workspace root (the same value
    returned by :func:`get_workspace_path`). The shared output directory is
    always ``<workspace>/output``. Project workspaces are NOT auto-appended;
    callers must pass the Mona workspace root, not a project directory.

    The directory is created on call.
    """
    root = Path(workspace).expanduser().resolve()
    return ensure_dir(root / "output")


def is_default_workspace(workspace: str | Path | None) -> bool:
    """Return whether a workspace resolves to mona's default workspace path."""
    current = Path(workspace).expanduser() if workspace is not None else Path.home() / ".mona" / "workspace"
    default = Path.home() / ".mona" / "workspace"
    return current.resolve(strict=False) == default.resolve(strict=False)


def get_cli_history_path() -> Path:
    """Return the shared CLI history file path."""
    return Path.home() / ".mona" / "history" / "cli_history"


def get_legacy_sessions_dir() -> Path:
    """Return the legacy global session directory used for migration fallback."""
    return Path.home() / ".mona" / "sessions"


# ---------------------------------------------------------------------------
# Per-agent directories (multi-agent phase 1, guide section 6.1)
# ---------------------------------------------------------------------------


def get_agents_dir() -> Path:
    """Return the agents root directory (~/.mona/agents/)."""
    return ensure_dir(get_data_dir() / "agents")


def get_agent_dir(agent_id: str) -> Path:
    """Return the per-agent root directory (~/.mona/agents/<agent_id>/)."""
    from mona.agent.partners import normalize_agent_id
    return ensure_dir(get_agents_dir() / normalize_agent_id(agent_id))


def get_agent_memory_dir(agent_id: str) -> Path:
    """Return the agent-private memory directory (~/.mona/agents/<id>/memory/).

    Stores the agent's MEMORY.md, SOUL.md, USER.md, AGENTS.md, history.jsonl.
    """
    return ensure_dir(get_agent_dir(agent_id) / "memory")


def get_agent_skills_dir(agent_id: str) -> Path:
    """Return the agent-private skills directory (~/.mona/agents/<id>/skills/).

    Holds skills the agent created itself; package skills stay inside the
    read-only agent package and are resolved via ``AgentRegistry``.
    """
    return ensure_dir(get_agent_dir(agent_id) / "skills")


def get_legacy_memory_dir() -> Path:
    """Return the pre-multi-agent global memory directory (~/.mona/memory/).

    Only used by the one-time migration to Mona's agent-private memory dir.
    Does NOT create the directory — the migration must not manufacture an
    empty legacy source on fresh installs.
    """
    return get_data_dir() / "memory"


def get_legacy_skills_dir() -> Path:
    """Return the pre-multi-agent global skills directory (~/.mona/skills/).

    Only used by the one-time migration to Mona's agent-private skills dir.
    Does NOT create the directory — the migration must not manufacture an
    empty legacy source on fresh installs.
    """
    return get_data_dir() / "skills"


# ---------------------------------------------------------------------------
# Global resource directories (stored OUTSIDE workspace for hard boundary)
# ---------------------------------------------------------------------------


def get_memory_dir() -> Path:
    """Return Mona's memory directory (~/.mona/agents/mona/memory/).

    Stores MEMORY.md, SOUL.md, USER.md, AGENTS.md, history.jsonl.
    Lives outside the workspace to enforce the _FsTool hard boundary. Since
    multi-agent phase 1 the canonical location is Mona's agent-private
    directory; the legacy ``~/.mona/memory/`` is migrated on startup.
    """
    from mona.agent.partners import MONA_AGENT_ID
    return get_agent_memory_dir(MONA_AGENT_ID)


def get_memory_file(name: str) -> Path:
    """Return path to a memory file (MEMORY.md/SOUL.md/USER.md/AGENTS.md)."""
    return get_memory_dir() / name


def get_memory_history_path() -> Path:
    """Return path to memory/history.jsonl."""
    return get_memory_dir() / "history.jsonl"


def get_skills_dir() -> Path:
    """Return Mona's user skills directory (~/.mona/agents/mona/skills/).

    Lives outside the workspace to enforce the _FsTool hard boundary. Since
    multi-agent phase 1 the canonical location is Mona's agent-private
    directory; the legacy ``~/.mona/skills/`` is migrated on startup.
    """
    from mona.agent.partners import MONA_AGENT_ID
    return get_agent_skills_dir(MONA_AGENT_ID)


def get_heartbeat_path() -> Path:
    """Return path to HEARTBEAT.md (~/.mona/HEARTBEAT.md).

    Moved out of workspace to enforce _FsTool hard boundary.
    """
    return get_data_dir() / "HEARTBEAT.md"
