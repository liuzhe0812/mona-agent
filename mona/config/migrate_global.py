"""One-time migration: move global resources from workspace to ~/.mona/.

Before this change, memory/, skills/, SOUL.md, USER.md, AGENTS.md,
HEARTBEAT.md lived inside the workspace. They now live OUTSIDE the workspace
to enforce a hard _FsTool boundary. This module performs the one-time
migration on startup.

Migration rules (per shared-output-workspace-execution-plan §8.3):
- Use move semantics (not copy) so source paths are cleaned up.
- Never overwrite an existing target — conflicts are moved to
  ``~/.mona/migration-backups/workspace-output-v1/<timestamp>/``.
- Write a JSON manifest recording every migration decision so that
  replay is auditable and transcript.py can resolve legacy paths.
- Idempotent: a completed manifest short-circuits subsequent runs.
  An interrupted run continues from where it left off.
- Migration backups are never deleted.
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any

from loguru import logger

from mona.config.paths import (
    get_data_dir,
    get_heartbeat_path,
    get_memory_dir,
    get_skills_dir,
    get_workspace_path,
)

MIGRATION_VERSION = "workspace-output-v1"
MANIFEST_FILENAME = "manifest.json"


def _backup_root() -> Path:
    """Return the migration backup root ``~/.mona/migration-backups/<version>/``."""
    return get_data_dir() / "migration-backups" / MIGRATION_VERSION


def _manifest_path() -> Path:
    """Return the absolute manifest path."""
    return _backup_root() / MANIFEST_FILENAME


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def _load_or_create_manifest() -> dict[str, Any]:
    """Load the manifest from disk or create a fresh skeleton.

    The manifest tracks both global_resources and loose_artifacts migrations
    so that transcript path resolution can use the same file.
    """
    path = _manifest_path()
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("version") == MIGRATION_VERSION:
                return data
        except Exception:
            logger.exception("Failed to load migration manifest at {}, recreating", path)
    return {
        "version": MIGRATION_VERSION,
        "started_at": _now_iso(),
        "completed_at": None,
        "completed": False,
        "global_resources": {
            "migrated": [],
            "skipped": [],
            "conflicts": [],
            "errors": [],
        },
        # loose_artifacts is populated by migrate_workspace_output.py.
        "loose_artifacts": {
            "migrated": [],
            "skipped": [],
            "conflicts": [],
            "errors": [],
            "manual_required": False,
        },
        # Reverse map: old absolute path → new absolute path (for transcript).
        "path_map": {},
    }


def _save_manifest(manifest: dict[str, Any]) -> None:
    path = _manifest_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _record(
    manifest: dict[str, Any],
    section: str,
    *,
    src: Path,
    dest: Path | None = None,
    status: str,
    reason: str = "",
    backup: Path | None = None,
    size: int | None = None,
) -> None:
    """Append a migration record and update the path_map if applicable."""
    entry: dict[str, Any] = {
        "src": str(src),
        "status": status,
        "ts": _now_iso(),
    }
    if dest is not None:
        entry["dest"] = str(dest)
    if backup is not None:
        entry["backup"] = str(backup)
    if reason:
        entry["reason"] = reason
    if size is not None:
        entry["size"] = size

    manifest[section][status].append(entry)

    # Update the reverse path_map only for successful migrations.
    if status == "migrated" and dest is not None:
        manifest["path_map"][str(src)] = str(dest)


def _same_file(src: Path, dest: Path) -> bool:
    """Return True if src and dest refer to the same existing file."""
    try:
        return src.resolve() == dest.resolve() and src.exists()
    except Exception:
        return False


def _move_with_conflict_backup(
    src: Path,
    dest: Path,
    *,
    manifest: dict[str, Any],
    section: str,
    description: str,
) -> None:
    """Move src to dest, backing up conflicts to the migration backup dir.

    Semantics:
    - src missing: skip with status=skipped.
    - src resolves to dest (same inode/path): skip with status=skipped.
    - dest missing: atomic move (same-volume) or copy+delete fallback.
    - dest exists and differs from src: move src to
      ``<backup_root>/<timestamp>/<relative>`` and record as conflict.
    """
    if not src.exists():
        _record(
            manifest, section,
            src=src, dest=dest, status="skipped",
            reason="source does not exist",
        )
        return

    if _same_file(src, dest):
        _record(
            manifest, section,
            src=src, dest=dest, status="skipped",
            reason="source already at target",
        )
        return

    dest.parent.mkdir(parents=True, exist_ok=True)

    if not dest.exists():
        try:
            # shutil.move handles cross-volume moves automatically.
            shutil.move(str(src), str(dest))
            size = _try_size(dest)
            _record(
                manifest, section,
                src=src, dest=dest, status="migrated",
                size=size,
            )
            logger.info("Migration moved {} → {} ({})", src, dest, description)
            return
        except Exception as exc:
            logger.exception("Migration failed for {}: {} → {}", description, src, dest)
            _record(
                manifest, section,
                src=src, dest=dest, status="errors",
                reason=str(exc),
            )
            return

    # Target already exists with different content — back up the source.
    backup_dir = _backup_root() / time.strftime("%Y%m%d-%H%M%S") / description.replace("/", "_")
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / src.name
    try:
        # Avoid clobbering an existing backup of the same name.
        counter = 1
        while backup_path.exists():
            backup_path = backup_dir / f"{src.stem}.{counter}{src.suffix}"
            counter += 1
        shutil.move(str(src), str(backup_path))
        _record(
            manifest, section,
            src=src, dest=dest, status="conflicts",
            backup=backup_path,
            reason="target already exists; source moved to backup",
        )
        logger.warning(
            "Migration conflict for {}: target {} exists; source backed up to {}",
            description, dest, backup_path,
        )
    except Exception as exc:
        logger.exception("Migration backup failed for {}: {}", description, src)
        _record(
            manifest, section,
            src=src, dest=dest, status="errors",
            reason=f"backup failed: {exc}",
        )


def _try_size(path: Path) -> int | None:
    try:
        return path.stat().st_size
    except OSError:
        return None


def _migrate_dir_contents(
    src_dir: Path,
    dest_dir: Path,
    *,
    manifest: dict[str, Any],
    section: str,
    description: str,
) -> None:
    """Move each child of src_dir into dest_dir (top-level only).

    Subdirectories are moved recursively via ``shutil.move``.
    """
    if not src_dir.exists() or not src_dir.is_dir():
        return
    for child in src_dir.iterdir():
        target = dest_dir / child.name
        _move_with_conflict_backup(
            child, target,
            manifest=manifest, section=section,
            description=f"{description}/{child.name}",
        )


def migrate_global_resources(workspace: str | Path | None = None) -> bool:
    """Migrate global resources from workspace to ``~/.mona/`` (idempotent).

    Returns True if the global-resource section of the migration is complete
    (either already complete or just finished). Returns False if any error
    was encountered — callers should still continue startup, but the manifest
    will record the failure for diagnosis.
    """
    manifest = _load_or_create_manifest()
    global_section = manifest["global_resources"]

    # If already complete, short-circuit.
    already = (
        manifest.get("global_resources_completed")
        or manifest.get("completed")
        or False
    )
    if already:
        logger.debug("Global resource migration already complete, skipping")
        return True

    workspace = Path(workspace).expanduser().resolve() if workspace is not None else get_workspace_path()
    memory_dir = get_memory_dir()
    skills_dir = get_skills_dir()
    heartbeat_path = get_heartbeat_path()

    logger.info(
        "Running global resource migration: workspace={} → memory_dir={}",
        workspace, memory_dir,
    )

    # 1. Top-level .md files (AGENTS.md, SOUL.md, USER.md).
    for name in ("AGENTS.md", "SOUL.md", "USER.md"):
        _move_with_conflict_backup(
            workspace / name, memory_dir / name,
            manifest=manifest, section="global_resources",
            description=name,
        )

    # 2. memory/ directory contents → ~/.mona/memory/.
    _migrate_dir_contents(
        workspace / "memory", memory_dir,
        manifest=manifest, section="global_resources",
        description="memory",
    )

    # 3. skills/ directory contents → ~/.mona/skills/.
    _migrate_dir_contents(
        workspace / "skills", skills_dir,
        manifest=manifest, section="global_resources",
        description="skills",
    )

    # 4. HEARTBEAT.md → ~/.mona/HEARTBEAT.md.
    _move_with_conflict_backup(
        workspace / "HEARTBEAT.md", heartbeat_path,
        manifest=manifest, section="global_resources",
        description="HEARTBEAT.md",
    )

    manifest["global_resources_completed"] = True
    has_errors = bool(global_section["errors"])
    if has_errors:
        logger.warning(
            "Global resource migration completed with {} error(s); see manifest at {}",
            len(global_section["errors"]), _manifest_path(),
        )
    else:
        logger.info("Global resource migration complete")

    # Persist manifest (loose_artifacts section may still be pending).
    _save_manifest(manifest)
    return not has_errors


def load_manifest() -> dict[str, Any] | None:
    """Return the persisted migration manifest, or None if not yet created.

    Used by transcript / file-preview path resolution to map legacy
    artifact paths to their new locations under ``workspace/output/``.
    """
    path = _manifest_path()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("version") == MIGRATION_VERSION:
            return data
    except Exception:
        logger.exception("Failed to read migration manifest at {}", path)
    return None


def resolve_legacy_path(old_path: str | Path) -> Path | None:
    """Resolve a legacy artifact path through the migration manifest.

    Returns the new absolute Path if a mapping exists, else None.
    """
    manifest = load_manifest()
    if manifest is None:
        return None
    path_map = manifest.get("path_map") or {}
    key = str(Path(old_path).expanduser())
    new = path_map.get(key)
    if new is None:
        # Also try the un-expanded form in case the manifest stored a raw path.
        new = path_map.get(str(old_path))
    if not new:
        return None
    # A final-layout migration can legitimately have two hops (legacy loose
    # path -> output -> Agent/product owner). Follow the manifest chain while
    # guarding against malformed cycles written by an interrupted process.
    seen = {key, str(old_path)}
    for _ in range(8):
        candidate = str(new)
        if candidate in seen:
            break
        seen.add(candidate)
        chained = path_map.get(candidate)
        if not chained:
            break
        new = chained
    return Path(new)
