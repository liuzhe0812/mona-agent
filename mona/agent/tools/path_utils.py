"""Shared path helpers for workspace-scoped tools."""

import contextvars
from pathlib import Path

from mona.config.paths import get_media_dir

WORKSPACE_BOUNDARY_NOTE = (
    " (this is a hard policy boundary, not a transient failure; "
    "do not retry with shell tricks or alternative tools, and ask "
    "the user how to proceed if the resource is genuinely required)"
)

# ---------------------------------------------------------------------------
# Session workspace contextvar
# ---------------------------------------------------------------------------

# Per-task workspace override. Set at AgentLoop entry to redirect _FsTool
# resolution to the session-bound project directory. Falls back to the
# tool's configured workspace when unset.
_current_workspace: contextvars.ContextVar[Path | None] = contextvars.ContextVar(
    "_current_workspace", default=None
)


def set_current_workspace(ws: Path | None) -> contextvars.Token:
    """Set the per-session workspace override. Returns a token for reset."""
    return _current_workspace.set(ws)


def reset_current_workspace(token: contextvars.Token) -> None:
    """Reset the workspace override to its previous value."""
    _current_workspace.reset(token)


def get_current_workspace(fallback: Path | None = None) -> Path | None:
    """Return the active session workspace, or fallback if not set."""
    return _current_workspace.get() or fallback


def is_under(path: Path, directory: Path) -> bool:
    """Return True when path resolves under directory."""
    try:
        path.relative_to(directory.resolve())
        return True
    except ValueError:
        return False


def resolve_workspace_path(
    path: str,
    workspace: Path | None = None,
    allowed_dir: Path | None = None,
    extra_allowed_dirs: list[Path] | None = None,
) -> Path:
    """Resolve path against workspace and enforce allowed directory containment."""
    p = Path(path).expanduser()
    if not p.is_absolute() and workspace:
        p = workspace / p
    resolved = p.resolve()
    if allowed_dir:
        media_path = get_media_dir().resolve()
        all_dirs = [allowed_dir, media_path, *(extra_allowed_dirs or [])]
        if not any(is_under(resolved, d) for d in all_dirs):
            raise PermissionError(
                f"Path {path} is outside allowed directory {allowed_dir}"
                + WORKSPACE_BOUNDARY_NOTE
            )
    return resolved
