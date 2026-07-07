"""One-time migration: move global resources out of workspace to ~/.mona/.

Before this change, memory/, skills/, SOUL.md, USER.md, AGENTS.md, HEARTBEAT.md
lived inside the workspace. They now live OUTSIDE the workspace to enforce a
hard _FsTool boundary. This module performs the one-time migration on startup.

Migration rules:
- Only migrates if the target file does not already exist (does not overwrite).
- Source files are NOT deleted after migration (user may want them as backup).
- Logs every move at INFO level for auditability.
- Idempotent: running twice is safe (no-op on second run).
"""
from __future__ import annotations

import shutil
from pathlib import Path

from loguru import logger

from mona.config.paths import (
    get_data_dir,
    get_heartbeat_path,
    get_memory_dir,
    get_skills_dir,
    get_workspace_path,
)


def _migrate_file(src: Path, dest: Path, *, description: str) -> None:
    """Move a single file from src to dest if src exists and dest does not."""
    if not src.exists():
        return
    if dest.exists():
        # Target already exists (previous migration or user created it) — skip.
        logger.debug("Migration skip {}: dest already exists at {}", description, dest)
        return
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        logger.info(
            "Migration: copied {} → {} ({})",
            src, dest, description,
        )
    except Exception:
        logger.exception("Migration failed for {}: {} → {}", description, src, dest)


def _migrate_dir(src: Path, dest: Path, *, description: str) -> None:
    """Copy contents of src dir into dest dir (non-recursive top-level files).

    Each child file/subdir is copied individually with _migrate_file semantics
    (skip if dest child already exists).
    """
    if not src.exists() or not src.is_dir():
        return
    for child in src.iterdir():
        target = dest / child.name
        if target.exists():
            logger.debug("Migration skip {} child: {} already exists", description, child.name)
            continue
        try:
            dest.mkdir(parents=True, exist_ok=True)
            if child.is_dir():
                shutil.copytree(child, target)
            else:
                shutil.copy2(child, target)
            logger.info("Migration: copied {} → {}", child, target)
        except Exception:
            logger.exception("Migration failed for {} child: {}", description, child)


def migrate_global_resources() -> None:
    """Migrate global resources from workspace to ~/.mona/ (idempotent).

    Called once at startup. Safe to call multiple times — no-op after first run.
    """
    workspace = get_workspace_path()
    data_dir = get_data_dir()
    memory_dir = get_memory_dir()
    skills_dir = get_skills_dir()
    heartbeat_path = get_heartbeat_path()

    logger.info(
        "Running global resource migration: workspace={} → data_dir={}",
        workspace, data_dir,
    )

    # 1. Memory files (SOUL.md / USER.md / AGENTS.md used to live at workspace root)
    _migrate_file(workspace / "SOUL.md", memory_dir / "SOUL.md", description="SOUL.md")
    _migrate_file(workspace / "USER.md", memory_dir / "USER.md", description="USER.md")
    _migrate_file(workspace / "AGENTS.md", memory_dir / "AGENTS.md", description="AGENTS.md")

    # 2. memory/ directory contents (MEMORY.md, history.jsonl, .cursor, .dream_cursor)
    _migrate_dir(workspace / "memory", memory_dir, description="memory/")

    # 3. skills/ directory contents
    _migrate_dir(workspace / "skills", skills_dir, description="skills/")

    # 4. HEARTBEAT.md
    _migrate_file(workspace / "HEARTBEAT.md", heartbeat_path, description="HEARTBEAT.md")

    # NOTE: ppt_projects/ is intentionally NOT migrated — it stays in workspace
    # per design (PPT agent reuses workspace via _FsTool).

    logger.info("Global resource migration complete")
