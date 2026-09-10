"""Runtime path helpers derived from the active config context."""

from __future__ import annotations

import os
from pathlib import Path

from loguru import logger

from mona.utils.helpers import ensure_dir

_managed_runtime_roots: dict[tuple[Path, Path], Path] = {}


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


def get_user_profile_dir() -> Path:
    """Return the user-owned profile store, independent of any Agent.

    Agent memory remains private under ``agents/<agent_id>/memory``.  The
    distilled user profile is shared platform state and therefore must not use
    Mona's private memory directory as its canonical location.
    """
    return ensure_dir(get_data_dir() / "profile")


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


def get_agent_workspace_dir(workspace: str | Path, agent_id: str) -> Path:
    """Return the durable workspace owned by one agent.

    Sessions are views over this directory; they never get a physical copy.
    Keep the identifier validation in ``normalize_agent_id`` so callers cannot
    turn an agent id into a path escape.
    """
    from mona.agent.partners import normalize_agent_id

    root = Path(workspace).expanduser().resolve()
    return ensure_dir(root / "agent-workspaces" / normalize_agent_id(agent_id))


def get_agent_output_dir(workspace: str | Path, agent_id: str) -> Path:
    """Return ``<workspace>/agent-workspaces/<agent_id>/output``."""
    return ensure_dir(get_agent_workspace_dir(workspace, agent_id) / "output")


_STORAGE_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789-_")


def get_stock_projects_dir(workspace: str | Path) -> Path:
    """Return the product-owned stock run root."""
    candidate = Path(workspace).expanduser().resolve()
    if candidate.name == "stock_projects":
        return ensure_dir(candidate)
    if candidate.parent.name == "stock_projects":
        return ensure_dir(candidate.parent)
    return ensure_dir(candidate / "stock_projects")


def get_stock_project_dir(workspace: str | Path, run_id: str) -> Path:
    """Return one run-scoped stock product directory."""
    if not run_id or any(ch not in _STORAGE_ID_CHARS for ch in run_id):
        raise ValueError(f"Invalid stock run id {run_id!r}")
    candidate = Path(workspace).expanduser().resolve()
    if candidate.name == run_id and candidate.parent.name == "stock_projects":
        return ensure_dir(candidate)
    return ensure_dir(get_stock_projects_dir(candidate) / run_id)


def get_runtime_dir() -> Path:
    """Return the runtime state root outside user-visible workspaces."""
    return get_runtime_subdir("runtime")


def get_agent_jobs_dir() -> Path:
    return ensure_dir(get_runtime_dir() / "agent-jobs")


def get_workflows_dir() -> Path:
    return ensure_dir(get_runtime_dir() / "workflows")


def get_workflow_runs_dir() -> Path:
    return ensure_dir(get_runtime_dir() / "workflow-runs")


def is_default_workspace(workspace: str | Path | None) -> bool:
    """Return whether a workspace resolves to mona's default workspace path."""
    current = (
        Path(workspace).expanduser()
        if workspace is not None
        else Path.home() / ".mona" / "workspace"
    )
    default = Path.home() / ".mona" / "workspace"
    return current.resolve(strict=False) == default.resolve(strict=False)


def is_agent_workspace(workspace: str | Path | None) -> bool:
    """Return whether a path belongs to Mona's non-project Agent workspace."""
    current = Path(workspace).expanduser() if workspace is not None else get_workspace_path()
    default = get_workspace_path()
    resolved = current.resolve(strict=False)
    root = default.resolve(strict=False)
    return resolved == root or root in resolved.parents


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


def get_packages_dir() -> Path:
    """Return the rebuildable downloaded-package root."""
    return ensure_dir(get_data_dir() / "packages")


def get_agent_packages_dir() -> Path:
    """Return the versioned downloaded Agent package store."""
    return ensure_dir(get_packages_dir() / "agents")


def get_legacy_managed_runtimes_dir() -> Path:
    """Return the pre-migration managed runtime root without creating it."""
    return (get_data_dir() / "runtimes").resolve()


def get_target_managed_runtimes_dir() -> Path:
    """Return the OS-local target for rebuildable managed runtimes without creating it."""
    if os.name == "nt":
        local_app_data = Path(
            os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local"
        )
        return (local_app_data / "Mona" / "runtimes").resolve()
    return (get_data_dir() / "runtimes").resolve()


def get_managed_runtimes_dir() -> Path:
    """Migrate active components before returning the managed runtime root."""
    legacy_root = get_legacy_managed_runtimes_dir()
    target_root = get_target_managed_runtimes_dir()
    cache_key = (legacy_root, target_root)
    cached = _managed_runtime_roots.get(cache_key)
    if cached is not None:
        return cached
    if legacy_root == target_root:
        selected = ensure_dir(target_root)
        _managed_runtime_roots[cache_key] = selected
        return selected
    try:
        from mona.runtime.migration import migrate_managed_runtime_root

        status = migrate_managed_runtime_root(legacy_root, target_root)
    except Exception as exc:
        logger.warning("Managed runtime migration deferred: {}", exc)
        if not legacy_root.exists():
            raise
        _managed_runtime_roots[cache_key] = legacy_root
        return legacy_root
    if status["state"] == "partial" and legacy_root.exists():
        logger.warning(
            "Managed runtime migration incomplete: {}",
            "; ".join(str(error) for error in status.get("errors", [])),
        )
        _managed_runtime_roots[cache_key] = legacy_root
        return legacy_root
    _managed_runtime_roots[cache_key] = target_root
    return target_root


def get_agent_dir(agent_id: str) -> Path:
    """Return the per-agent root directory (~/.mona/agents/<agent_id>/)."""
    from mona.agent.partners import normalize_agent_id

    return ensure_dir(get_agents_dir() / normalize_agent_id(agent_id))


def get_agent_memory_dir(agent_id: str) -> Path:
    """Return the agent-private memory directory (~/.mona/agents/<id>/memory/).

    Stores the agent's MEMORY.md, SOUL.md, USER.md, AGENTS.md, history.jsonl.
    """
    return _get_agent_resource_dir(agent_id, "memory")


def get_agent_skills_dir(agent_id: str) -> Path:
    """Return the agent-private skills directory (~/.mona/agents/<id>/skills/).

    Holds skills the agent created itself; package skills stay inside the
    read-only agent package and are resolved via ``AgentRegistry``.
    """
    return _get_agent_resource_dir(agent_id, "skills")


def get_agent_knowledge_dir(agent_id: str) -> Path:
    """Return the independent LLM Wiki store owned by one Agent."""
    root = _get_agent_resource_dir(agent_id, "knowledge")
    for name in ("raw", "text", "evidence", "wiki"):
        ensure_dir(root / name)
    return root


def _get_agent_resource_dir(agent_id: str, name: str) -> Path:
    """Resolve an agent-private directory, preserving Mona's legacy fallback."""
    from mona.agent.partners import MONA_AGENT_ID, normalize_agent_id

    agent = normalize_agent_id(agent_id)
    path = get_agent_dir(agent) / name
    try:
        ensure_dir(path)
        next(path.iterdir(), None)  # Windows can allow stat but deny child access.
        return path
    except PermissionError:
        if agent != MONA_AGENT_ID:
            raise
        return ensure_dir(get_data_dir() / name)


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
