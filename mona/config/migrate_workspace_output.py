"""One-time migration: move loose artifacts into ``<workspace>/output/``.

Per shared-output-workspace-execution-plan §8.2-§8.3, after global resources
have moved out of the workspace root, any remaining top-level files and
directories that are NOT in the reserved set must be moved into
``<workspace>/output/`` so that the workspace root stays clean and the
shared output directory is the single source of artifacts for ordinary
sessions.

Reserved top-level entries that stay at the workspace root:

- ``output/`` (the migration target itself)
- ``sessions/``, ``cron/``, ``schedule/`` (runtime data)
- ``ppt_projects/``, ``video_projects/`` (specialized project pipelines)
- ``.git/``, ``.gitignore``, ``.mona/`` (existing user/version state)

Safety rules:
- Never overwrite an existing target — conflicts are backed up.
- Write every move into the migration manifest so transcript.py can
  resolve legacy paths after migration.
- Idempotent: an already-completed migration short-circuits.
- A user-owned Git repository with tracked non-Mona files triggers
  ``manual_required`` — the output path is still enabled, but loose
  artifact auto-migration is skipped to avoid disturbing user content.
"""
from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from loguru import logger

from mona.config.migrate_global import (
    _load_or_create_manifest,
    _manifest_path,
    _move_with_conflict_backup,
    _now_iso,
    _save_manifest,
)
from mona.config.paths import get_shared_output_dir, get_workspace_path

# Reserved top-level entries that must NOT be moved into output/.
RESERVED_TOP_LEVEL: frozenset[str] = frozenset({
    "output",          # migration target
    "sessions",        # runtime data
    "cron",            # runtime data
    "schedule",        # runtime data
    "ppt_projects",    # PPT agent pipeline
    "video_projects",  # video agent pipeline
    ".git",            # user/version control
    ".gitignore",      # user/version control
    ".mona",           # mona internal state
})


def _is_reserved(entry: Path) -> bool:
    """Return True if a top-level workspace entry must stay where it is."""
    return entry.name in RESERVED_TOP_LEVEL


def _workspace_is_user_git_repo(workspace: Path) -> bool:
    """Detect whether the workspace is a Git repo with tracked non-Mona files.

    If true, auto-migration is disabled to avoid disturbing user content.
    The check is conservative: any tracked file outside the reserved set
    triggers manual_required.
    """
    git_dir = workspace / ".git"
    if not git_dir.exists():
        return False
    # Try to list tracked files via `git ls-files`.
    try:
        import subprocess

        result = subprocess.run(
            ["git", "ls-files"],
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return False
        tracked = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        for line in tracked:
            top = line.split("/", 1)[0].split("\\", 1)[0]
            if top not in RESERVED_TOP_LEVEL:
                # Found a tracked file outside the reserved set.
                return True
    except FileNotFoundError:
        # git not installed — assume not a user repo and proceed.
        return False
    except Exception:
        logger.exception("Failed to inspect git index for {}", workspace)
        return False
    return False


def _move_loose_entry(
    src: Path,
    dest: Path,
    *,
    manifest: dict[str, Any],
) -> None:
    """Move a single loose top-level entry into output/ with conflict backup."""
    _move_with_conflict_backup(
        src, dest,
        manifest=manifest, section="loose_artifacts",
        description=src.name,
    )


def migrate_workspace_output() -> bool:
    """Move loose top-level workspace entries into ``<workspace>/output/``.

    Returns True if the loose-artifact migration is complete (already or
    just finished), False if manual intervention is required.
    """
    manifest = _load_or_create_manifest()
    loose_section = manifest["loose_artifacts"]

    if loose_section.get("manual_required"):
        logger.info(
            "Loose artifact migration marked manual_required, skipping "
            "(output path still enabled)"
        )
        return False

    if manifest.get("loose_artifacts_completed") or manifest.get("completed"):
        logger.debug("Loose artifact migration already complete, skipping")
        return True

    workspace = get_workspace_path()
    output_dir = get_shared_output_dir(workspace)

    logger.info(
        "Running loose artifact migration: workspace={} → output={}",
        workspace, output_dir,
    )

    # Detect user Git repos with tracked non-Mona files BEFORE moving anything.
    if _workspace_is_user_git_repo(workspace):
        loose_section["manual_required"] = True
        manifest["loose_artifacts_completed"] = True
        manifest["completed_at"] = _now_iso()
        manifest["completed"] = True
        _save_manifest(manifest)
        logger.warning(
            "Workspace {} is a Git repository with tracked non-Mona files; "
            "loose artifact auto-migration skipped (manual_required). "
            "The output path is still enabled. See manifest at {}",
            workspace, _manifest_path(),
        )
        return False

    # Enumerate top-level entries and move non-reserved ones.
    try:
        entries = list(workspace.iterdir())
    except OSError:
        logger.exception("Failed to enumerate workspace {}", workspace)
        return False

    for entry in entries:
        if _is_reserved(entry):
            continue
        # Don't re-migrate anything that's already inside output/.
        try:
            if entry.resolve() == output_dir.resolve():
                continue
        except Exception:
            pass

        dest = output_dir / entry.name
        _move_loose_entry(entry, dest, manifest=manifest)

    manifest["loose_artifacts_completed"] = True
    # Mark the whole migration as complete only if global_resources is also done.
    if manifest.get("global_resources_completed"):
        manifest["completed_at"] = _now_iso()
        manifest["completed"] = True
    _save_manifest(manifest)

    has_errors = bool(loose_section["errors"])
    if has_errors:
        logger.warning(
            "Loose artifact migration completed with {} error(s); see manifest at {}",
            len(loose_section["errors"]), _manifest_path(),
        )
    else:
        logger.info("Loose artifact migration complete")
    return not has_errors


def run_startup_migrations(*, skip_loose_artifacts: bool = False) -> None:
    """Run the consolidated startup migration sequence.

    Per shared-output-workspace-execution-plan §8.1, the order is:

    1. Ensure workspace root exists.
    2. Run global resource migration (move memory/skills/AGENTS.md/etc.
       out of workspace into Mona's agent-private dirs).
    2.5. Copy legacy global ``~/.mona/memory`` and ``~/.mona/skills`` into
       Mona's agent-private dirs (multi-agent phase 1).
    3. Fill in missing global templates under ~/.mona/ via
       ``sync_global_templates()``.
    4. Create ``<workspace>/output/``.
    5. Run one-time loose artifact migration into ``output/``.
    6. (caller starts SessionManager, AgentLoop and channels.)

    All steps are idempotent. ``skip_loose_artifacts`` is used by callers
    that operate on a non-default workspace (e.g. project workspaces) where
    loose artifact migration should not run.
    """
    from mona.utils.helpers import sync_global_templates

    workspace = get_workspace_path()
    workspace.mkdir(parents=True, exist_ok=True)

    # 2. Global resource migration (move semantics + manifest).
    try:
        from mona.config.migrate_global import migrate_global_resources
        migrate_global_resources()
    except Exception:
        logger.exception("Global resource migration failed; continuing startup")

    # 2.5. Multi-agent phase 1: legacy ~/.mona/memory|skills → agents/mona/...
    # Must run before sync_global_templates, which would otherwise populate
    # the target dirs and block the copy.
    try:
        from mona.agent.migration import migrate_legacy_agent_resources
        migrate_legacy_agent_resources()
    except Exception:
        logger.exception("Agent resource migration failed; continuing startup")

    # 3. Sync global templates into ~/.mona/ (memory/, skills/, AGENTS.md, ...).
    try:
        sync_global_templates(silent=True)
    except Exception:
        logger.exception("sync_global_templates failed; continuing startup")

    # 4. Ensure <workspace>/output/ exists.
    try:
        get_shared_output_dir(workspace)
    except Exception:
        logger.exception("Failed to create shared output dir; continuing startup")

    # 5. Loose artifact migration (one-time, idempotent).
    if not skip_loose_artifacts:
        try:
            migrate_workspace_output()
        except Exception:
            logger.exception("Loose artifact migration failed; continuing startup")


def restore_workspace_output_migration(manifest: dict[str, Any] | None = None) -> int:
    """Restore migrated loose artifacts to their original workspace locations.

    Internal helper used by rollback procedures (not currently exposed via UI
    or CLI). Returns the number of entries restored. Skips conflicts to
    avoid overwriting newer user files.

    This function is intentionally conservative: it only restores entries
    marked ``migrated`` in the ``loose_artifacts`` section. Conflicts and
    errors are left untouched.
    """
    if manifest is None:
        manifest = _load_or_create_manifest()
    if manifest is None:
        return 0

    loose = manifest.get("loose_artifacts") or {}
    migrated = loose.get("migrated") or []
    restored = 0
    for entry in migrated:
        src = Path(entry["dest"])
        dest = Path(entry["src"])
        if not src.exists():
            continue
        if dest.exists():
            # Don't overwrite — leave at current location.
            continue
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest))
            restored += 1
        except Exception:
            logger.exception("Failed to restore {} → {}", src, dest)
    return restored
