"""Migrate legacy workspace artifacts into the final ownership layout.

The historical loose-output pass is retained as an interruption-safe first
step for old installations. ``migrate_final_artifact_layout`` then moves
those entries to Agent-owned output, product-owned stock runs and Mona's
runtime state; all new code targets the latter layout.

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
from mona.config.paths import (
    get_agent_jobs_dir,
    get_agent_output_dir,
    get_managed_runtimes_dir,
    get_shared_output_dir,
    get_stock_projects_dir,
    get_workflow_runs_dir,
    get_workflows_dir,
    get_workspace_path,
)

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
    "rooms",           # legacy room artifacts, handled by final migration
    "agent-workspaces",  # final Agent-owned artifact roots
    "stock_projects",  # final product-owned artifact roots
    "agent-jobs",      # legacy runtime state, handled by final migration
    "workflows",       # legacy runtime state, handled by final migration
    "workflow-runs",   # legacy runtime state, handled by final migration
})

FINAL_LAYOUT_SECTION = "artifact_layout"


def _ensure_layout_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """Add the final-layout section without invalidating old manifests."""
    section = manifest.setdefault(
        FINAL_LAYOUT_SECTION,
        {
            "migrated": [],
            "skipped": [],
            "conflicts": [],
            "errors": [],
            "manual_required": False,
        },
    )
    return section


def _move_layout_entry(
    src: Path,
    dest: Path,
    *,
    manifest: dict[str, Any],
    description: str,
) -> None:
    _move_with_conflict_backup(
        src,
        dest,
        manifest=manifest,
        section=FINAL_LAYOUT_SECTION,
        description=description,
    )


def migrate_final_artifact_layout(workspace: str | Path | None = None) -> bool:
    """Move legacy output/room/runtime entries into final owner roots.

    This is intentionally a second, separately recorded pass after the old
    loose-output migration. Existing installations may already have
    ``workspace/output`` populated; moving its children keeps the migration
    resumable while making the final layout the only new-write contract.
    """
    manifest = _load_or_create_manifest()
    section = _ensure_layout_manifest(manifest)
    if manifest.get("artifact_layout_completed") and not section.get("errors"):
        return True
    # A prior attempt may have recorded a transient filesystem error while
    # still (incorrectly) setting the completion flag. Preserve the failed
    # attempt for audit, but allow a later startup to retry the unresolved
    # sources instead of short-circuiting forever.
    if section.get("errors"):
        section.setdefault("error_history", []).extend(section["errors"])
        section["errors"] = []

    workspace = Path(workspace).expanduser().resolve() if workspace is not None else get_workspace_path()
    agent_output = get_agent_output_dir(workspace, "mona")
    stock_root = get_stock_projects_dir(workspace)

    # Runtime state is not an artifact owner and must leave the workspace.
    runtime_sources = {
        workspace / "agent-jobs": get_agent_jobs_dir(),
        workspace / "workflows": get_workflows_dir(),
        workspace / "workflow-runs": get_workflow_runs_dir(),
        workspace / "output" / "agent-jobs": get_agent_jobs_dir(),
        workspace / "output" / "workflows": get_workflows_dir(),
        workspace / "output" / "workflow-runs": get_workflow_runs_dir(),
    }
    for source, target in runtime_sources.items():
        if source.exists():
            _move_layout_entry(
                source,
                target,
                manifest=manifest,
                description=f"runtime/{source.name}",
            )

    # Stock runs are product-owned and keep their run id as the boundary.
    legacy_stock = workspace / "output" / "stock"
    if legacy_stock.is_dir():
        for run_dir in list(legacy_stock.iterdir()):
            if run_dir.name.startswith("."):
                continue
            try:
                target = stock_root / run_dir.name
                _move_layout_entry(
                    run_dir,
                    target,
                    manifest=manifest,
                    description=f"stock/{run_dir.name}",
                )
            except OSError:
                logger.exception("Failed to prepare stock migration for {}", run_dir)

    # A legacy room directory has no trustworthy owner metadata at this
    # layer. Preserve it under Mona's output with an explicit legacy marker;
    # never guess that it belongs to another Agent.
    legacy_rooms = workspace / "rooms"
    if legacy_rooms.is_dir():
        legacy_target_root = agent_output / "legacy-rooms"
        for room_dir in list(legacy_rooms.iterdir()):
            _move_layout_entry(
                room_dir,
                legacy_target_root / room_dir.name,
                manifest=manifest,
                description=f"legacy-rooms/{room_dir.name}",
            )

    # Every remaining old shared-output entry becomes Mona-owned. The old
    # output directory itself is left in place as an empty tombstone so an
    # interrupted older process cannot recreate state under it silently.
    legacy_output = workspace / "output"
    if legacy_output.is_dir():
        for entry in list(legacy_output.iterdir()):
            if entry.name in {"stock", "agent-jobs", "workflows", "workflow-runs"}:
                continue
            _move_layout_entry(
                entry,
                agent_output / entry.name,
                manifest=manifest,
                description=f"agent/mona/{entry.name}",
            )

    has_errors = bool(section.get("errors"))
    manifest["artifact_layout_completed"] = not has_errors
    # Keep the legacy completion flags for callers and old manifests, but
    # only claim the overall migration complete after this final pass.
    if not has_errors and manifest.get("global_resources_completed") and manifest.get("loose_artifacts_completed"):
        manifest["completed_at"] = _now_iso()
        manifest["completed"] = True
    elif has_errors:
        manifest["completed_at"] = None
        manifest["completed"] = False
    _save_manifest(manifest)
    if has_errors:
        logger.warning(
            "Final artifact layout migration completed with {} error(s); see {}",
            len(section["errors"]),
            _manifest_path(),
        )
    return not has_errors


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


def migrate_workspace_output(workspace: str | Path | None = None) -> bool:
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

    workspace = Path(workspace).expanduser().resolve() if workspace is not None else get_workspace_path()
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


def run_startup_migrations(
    workspace: str | Path | None = None,
    *,
    skip_loose_artifacts: bool = False,
) -> None:
    """Run the consolidated startup migration sequence.

    Per shared-output-workspace-execution-plan §8.1, the order is:

    1. Ensure workspace root exists.
    2. Run global resource migration (move memory/skills/AGENTS.md/etc.
       out of workspace into Mona's agent-private dirs).
    2.5. Copy legacy global ``~/.mona/memory`` and ``~/.mona/skills`` into
       Mona's agent-private dirs (multi-agent phase 1).
    3. Migrate active managed runtimes into the OS-local store.
    4. Fill in missing global templates under ~/.mona/ via
       ``sync_global_templates()``.
    5. Create ``<workspace>/output/``.
    6. Run one-time loose artifact migration into ``output/``.
    7. (caller starts SessionManager, AgentLoop and channels.)

    All steps are idempotent. ``skip_loose_artifacts`` is used by callers
    that operate on a non-default workspace (e.g. project workspaces) where
    loose artifact migration should not run.
    """
    from mona.utils.helpers import sync_global_templates

    workspace = Path(workspace).expanduser().resolve() if workspace is not None else get_workspace_path()
    workspace.mkdir(parents=True, exist_ok=True)

    # 2. Global resource migration (move semantics + manifest).
    try:
        from mona.config.migrate_global import migrate_global_resources
        migrate_global_resources(workspace)
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

    try:
        from mona.agent.skill_usage import migrate_legacy_self_evolution

        migrated = migrate_legacy_self_evolution()
        if migrated:
            logger.info("Marked {} legacy Mona skills as self-evolution", len(migrated))
    except Exception:
        logger.exception("Legacy self-evolution provenance migration failed; continuing startup")

    # 3. Managed runtimes: copy verified active components and keep the old root.
    try:
        get_managed_runtimes_dir()
    except Exception:
        logger.exception("Managed runtime migration failed; continuing startup")

    # 4. Sync global templates into ~/.mona/ (memory/, skills/, AGENTS.md, ...).
    try:
        sync_global_templates(silent=True)
    except Exception:
        logger.exception("sync_global_templates failed; continuing startup")

    # 5. Ensure <workspace>/output/ exists.
    try:
        get_shared_output_dir(workspace)
    except Exception:
        logger.exception("Failed to create shared output dir; continuing startup")

    # 6. Legacy loose-artifact migration (kept as an interruption-safe first
    # pass for existing manifests).
    if not skip_loose_artifacts:
        try:
            migrate_workspace_output(workspace)
        except Exception:
            logger.exception("Loose artifact migration failed; continuing startup")
        # 7. Final ownership migration. This pass is what establishes the
        # current contract: Agent output, product runs and runtime state are
        # physically separate.
        try:
            migrate_final_artifact_layout(workspace)
        except Exception:
            logger.exception("Final artifact layout migration failed; continuing startup")


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

    # Final-layout moves are the second hop (output → Agent/product/runtime).
    # Reverse them first so the original loose-artifact destinations exist
    # before the first migration pass is rolled back.
    restored = restore_final_artifact_layout(manifest)

    loose = manifest.get("loose_artifacts") or {}
    migrated = loose.get("migrated") or []
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


def restore_final_artifact_layout(manifest: dict[str, Any] | None = None) -> int:
    """Reverse successful final-layout moves without overwriting user data.

    Records are processed newest-first because later moves may have used a
    directory created by an earlier move. Existing sources are treated as a
    conflict and left untouched; restoration is therefore safe to retry.
    """
    if manifest is None:
        manifest = _load_or_create_manifest()
    if not manifest:
        return 0
    section = manifest.get(FINAL_LAYOUT_SECTION) or {}
    restored = 0
    for entry in reversed(section.get("migrated") or []):
        src = Path(entry.get("src", ""))
        dest = Path(entry.get("dest", ""))
        if not src or not dest or not dest.exists():
            continue
        if src.exists():
            continue
        try:
            src.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(dest), str(src))
            restored += 1
        except Exception:
            logger.exception("Failed to restore final artifact {} → {}", dest, src)
    if restored:
        manifest["artifact_layout_completed"] = False
        manifest["completed"] = False
        manifest["completed_at"] = None
        _save_manifest(manifest)
    return restored
