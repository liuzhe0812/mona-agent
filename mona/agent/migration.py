"""One-time migration: legacy global memory/skills → agent-private dirs.

Multi-agent phase 1 (docs/design/multi-agent-development-guide.md section 7.3).

Rules (per the guide):

- Only when ``agents/<agent_id>/memory`` is empty, copy the legacy global
  ``~/.mona/memory`` into it.
- Only when ``agents/<agent_id>/skills`` is empty, copy the legacy global
  ``~/.mona/skills`` into it. Skill lifecycle artifacts (``.archive/``,
  ``.usage.json``) travel with the skills — they are part of the user skill
  state, and the loader skips dotfile entries when enumerating skills.
- Copy via a temporary sibling directory + atomic rename; never overwrite
  existing content.
- Legacy directories are NOT deleted in this version; a separate cleanup
  operation may be offered once the new layout proves stable.
- Idempotent: a schema marker written after the first successful run
  short-circuits subsequent runs, and re-runs never duplicate files or
  overwrite newer content.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from mona.agent.partners import MONA_AGENT_ID, normalize_agent_id

MIGRATION_SCHEMA_VERSION = 1
_MARKER_NAME = ".agent-migration-v1.json"

# Resource kinds migrated from the legacy global data dir into the agent dir.
_KINDS = ("memory", "skills")


def _is_empty_dir(path: Path) -> bool:
    """True when path is missing or an empty directory.

    A stray non-directory at the target path counts as NOT empty — the
    migration must never remove unknown content to make room for a copy.
    """
    if path.exists() and not path.is_dir():
        return False
    if not path.is_dir():
        return True
    try:
        next(path.iterdir())
    except StopIteration:
        return True
    except OSError:
        return False
    return False


def _copy_tree_atomic(src: Path, dest: Path) -> None:
    """Copy ``src`` to ``dest`` via a temporary sibling + rename.

    ``dest`` must be missing or an empty directory (verified by the caller).
    The staging directory lives next to ``dest`` so the final rename stays on
    the same volume.
    """
    parent = dest.parent
    parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{dest.name}.staging-", dir=parent))
    try:
        staged = staging / dest.name
        shutil.copytree(src, staged)
        if dest.exists():
            # Empty directory (verified by caller); os.replace cannot replace
            # an existing directory, so remove it first.
            dest.rmtree()
        os.replace(staged, dest)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def migrate_legacy_agent_resources(
    *,
    agent_id: str = MONA_AGENT_ID,
    data_dir: Path | None = None,
) -> dict[str, str]:
    """Migrate legacy global memory/skills into the agent-private dirs.

    Returns a per-kind status map (``migrated`` / ``no-source`` /
    ``target-not-empty`` / ``already-done`` / ``error: ...``) for logging and
    tests. ``data_dir`` overrides the instance data dir (tests only); the
    default resolves ``~/.mona`` from the active config.
    """
    from mona.config.paths import get_data_dir

    agent = normalize_agent_id(agent_id)
    base = Path(data_dir) if data_dir is not None else get_data_dir()
    agent_dir = base / "agents" / agent
    marker = agent_dir / _MARKER_NAME
    if marker.is_file():
        logger.debug("Agent resource migration already complete for {!r}, skipping", agent)
        return {kind: "already-done" for kind in _KINDS}

    result: dict[str, str] = {}
    for kind in _KINDS:
        src = base / kind
        dest = agent_dir / kind
        if not src.is_dir():
            result[kind] = "no-source"
            continue
        if not _is_empty_dir(dest):
            # New content already lives in the agent-private dir; it wins and
            # the legacy copy stays untouched in place (guide 7.3).
            result[kind] = "target-not-empty"
            logger.warning(
                "Legacy {} migration for agent {!r} skipped: {} already has content; "
                "legacy data left in place at {}",
                kind, agent, dest, src,
            )
            continue
        try:
            _copy_tree_atomic(src, dest)
        except Exception as exc:
            logger.exception(
                "Legacy {} migration failed for agent {!r}: {} → {}", kind, agent, src, dest
            )
            result[kind] = f"error: {exc}"
            continue
        result[kind] = "migrated"
        logger.info("Migrated legacy {} for agent {!r}: {} → {}", kind, agent, src, dest)

    # Write the schema marker only when nothing errored, so a failed copy is
    # retried on the next startup. Already-migrated kinds then report
    # "target-not-empty" and are skipped, keeping the retry idempotent.
    if not any(status.startswith("error") for status in result.values()):
        try:
            agent_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "schema_version": MIGRATION_SCHEMA_VERSION,
                "agent_id": agent,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "result": result,
            }
            tmp_marker = marker.with_suffix(".tmp")
            tmp_marker.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            os.replace(tmp_marker, marker)
        except Exception:
            logger.exception("Failed to write agent migration marker {}; will retry", marker)
    return result
