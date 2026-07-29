"""Skill lifecycle sidecar: access telemetry + archive/restore primitives.

Design (see docs/design/skill-lifecycle-design.md):
  - Sidecar JSON at ~/.mona/skills/.usage.json keyed by skill name.
  - Directory location is the source of truth for active vs archived; the
    sidecar's ``archived_at`` field is display-only and reconciled on scan.
  - Only real session accesses bump counters; metadata reads, summary builds
    and Dream maintenance reads must NOT bump.
  - Automatic archival is restricted to ``created_by == "agent"``; builtin
    skills (live in the read-only package dir) and unknown user skills are
    never auto-archived.
  - Automatic operations only ever move a skill to .archive/, never delete.
  - Sidecar corruption fails closed: automatic archival aborts with a warning,
    never silently treating bad data as empty.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from mona.config.paths import get_skills_dir

logger = logging.getLogger(__name__)

# fcntl is Unix-only; on Windows fall back to msvcrt for cross-process locking.
fcntl: Any = None
msvcrt: Any = None
try:
    import fcntl  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - platform-specific
    try:
        import msvcrt  # type: ignore[import-not-found]
    except ImportError:
        pass


def _skills_dir() -> Path:
    return get_skills_dir()


def _usage_file() -> Path:
    return _skills_dir() / ".usage.json"


def _lock_file() -> Path:
    return _skills_dir() / ".usage.json.lock"


def _archive_dir() -> Path:
    return _skills_dir() / ".archive"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _empty_record() -> dict[str, Any]:
    return {
        "created_by": None,
        "created_at": _now_iso(),
        "access_count": 0,
        "last_accessed_at": None,
        "pinned": False,
        "archived_at": None,
    }


@contextmanager
def _lifecycle_lock() -> Iterator[None]:
    """Cross-process lock for the entire read-modify-write cycle.

    Only protects the sidecar file; skill directory moves rely on filesystem
    atomicity. Windows uses msvcrt.locking on a 1-byte lock file, Unix uses
    fcntl.flock.
    """
    lock_path = _lock_file()
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    if fcntl is None and msvcrt is None:
        # No locking primitive available — best effort.
        yield
        return

    if msvcrt is not None:
        if not lock_path.exists() or lock_path.stat().st_size == 0:
            lock_path.write_text(" ", encoding="utf-8")

    fd = open(lock_path, "r+" if msvcrt is not None else "a+", encoding="utf-8")
    try:
        if fcntl is not None:
            fcntl.flock(fd, fcntl.LOCK_EX)
        else:
            fd.seek(0)
            msvcrt.locking(fd.fileno(), msvcrt.LK_LOCK, 1)
        yield
    finally:
        if fcntl is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_UN)
            except (OSError, IOError):
                pass
        else:
            try:
                fd.seek(0)
                msvcrt.locking(fd.fileno(), msvcrt.LK_UNLCK, 1)
            except (OSError, IOError):
                pass
        fd.close()


# ---------------------------------------------------------------------------
# Sidecar I/O
# ---------------------------------------------------------------------------


def load_usage() -> dict[str, dict[str, Any]]:
    """Read .usage.json. Returns empty dict on missing file.

    Raises ValueError on corrupt JSON so callers can fail closed instead of
    silently treating corruption as "no records".
    """
    path = _usage_file()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"corrupt sidecar at {path}: {e}") from e
    if not isinstance(data, dict):
        raise ValueError(f"corrupt sidecar at {path}: top-level is not an object")
    clean: dict[str, dict[str, Any]] = {}
    for key, value in data.items():
        if isinstance(value, dict):
            clean[str(key)] = value
    return clean


def save_usage(data: dict[str, dict[str, Any]]) -> None:
    """Atomically write the usage map. Best-effort: logs on failure."""
    path = _usage_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(
            dir=str(path.parent), prefix=".usage_", suffix=".tmp"
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, sort_keys=True, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, path)
        except BaseException:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except Exception as e:
        logger.debug("Failed to write %s: %s", path, e, exc_info=True)
        raise


def get_record(name: str) -> dict[str, Any]:
    """Return the record for *name*, backfilling missing keys with defaults."""
    try:
        data = load_usage()
    except ValueError:
        # Caller asked for a single record; surface a fresh empty one and let
        # the caller decide whether to escalate. Mutations will re-raise.
        return _empty_record()
    rec = data.get(name)
    if not isinstance(rec, dict):
        return _empty_record()
    base = _empty_record()
    for key, value in base.items():
        rec.setdefault(key, value)
    return rec


def _mutate(name: str, mutator: Any) -> None:
    """Load (lock) → mutate record → save, all inside the lifecycle lock."""
    if not name:
        return
    with _lifecycle_lock():
        data = load_usage()
        rec = data.get(name)
        if not isinstance(rec, dict):
            rec = _empty_record()
        mutator(rec)
        data[name] = rec
        save_usage(data)


# ---------------------------------------------------------------------------
# Public mutators
# ---------------------------------------------------------------------------


def record_agent_created(name: str) -> None:
    """Mark a skill as agent-created and anchor its creation time.

    Called by SkillCreateTool after writing SKILL.md. Failure propagates so
    the caller can roll back the directory creation.
    """
    def _apply(rec: dict[str, Any]) -> None:
        rec["created_by"] = "agent"
        # Preserve an existing created_at (e.g. seeded earlier) if present;
        # otherwise stamp now.
        if not rec.get("created_at"):
            rec["created_at"] = _now_iso()
        rec["archived_at"] = None

    _mutate(name, _apply)


def bump_access(name: str) -> None:
    """Best-effort: bump access_count and last_accessed_at for *name*.

    Failures only log at DEBUG; they must never break the underlying tool
    call that triggered the access.
    """
    try:
        def _apply(rec: dict[str, Any]) -> None:
            rec["access_count"] = int(rec.get("access_count") or 0) + 1
            rec["last_accessed_at"] = _now_iso()

        _mutate(name, _apply)
    except Exception as e:
        logger.debug("bump_access(%s) failed: %s", name, e, exc_info=True)


def set_pinned(name: str, pinned: bool) -> None:
    def _apply(rec: dict[str, Any]) -> None:
        rec["pinned"] = bool(pinned)

    _mutate(name, _apply)


def set_archived_at(name: str, archived_at: str | None) -> None:
    """Display-only field; directory location is the source of truth."""
    def _apply(rec: dict[str, Any]) -> None:
        rec["archived_at"] = archived_at

    _mutate(name, _apply)


# ---------------------------------------------------------------------------
# Provenance
# ---------------------------------------------------------------------------


def is_builtin(name: str) -> bool:
    """Whether *name* lives under the read-only builtin skills directory."""
    from mona.agent.skills import BUILTIN_SKILLS_DIR
    return (BUILTIN_SKILLS_DIR / name / "SKILL.md").exists()


def get_provenance(name: str) -> str:
    """Return 'agent' | 'bundled' | 'unknown'.

    'agent' — created by Dream via SkillCreateTool (has a usage record with
    ``created_by == "agent"``).
    'bundled' — ships with the package (under mona/skills/).
    'unknown' — everything else (manually authored, pre-lifecycle Dream
    output that predates the sidecar).
    """
    if is_builtin(name):
        return "bundled"
    try:
        data = load_usage()
    except ValueError:
        return "unknown"
    rec = data.get(name)
    if isinstance(rec, dict) and rec.get("created_by") == "agent":
        return "agent"
    return "unknown"


# ---------------------------------------------------------------------------
# Directory facts
# ---------------------------------------------------------------------------


def is_archived(name: str) -> bool:
    """Whether *name* currently lives under .archive/."""
    return (_archive_dir() / name / "SKILL.md").exists()


def is_active(name: str) -> bool:
    """Whether *name* currently lives as an active top-level skill."""
    return (_skills_dir() / name / "SKILL.md").exists()


def list_active_user_skill_names() -> list[str]:
    """List active user skill directory names (excludes .archive and builtin)."""
    base = _skills_dir()
    if not base.exists():
        return []
    names: list[str] = []
    for entry in base.iterdir():
        if not entry.is_dir():
            continue
        if entry.name.startswith("."):
            continue
        if not (entry / "SKILL.md").exists():
            continue
        names.append(entry.name)
    return sorted(names)


def list_archived_skill_names() -> list[str]:
    archive = _archive_dir()
    if not archive.exists():
        return []
    return sorted(
        entry.name for entry in archive.iterdir()
        if entry.is_dir() and (entry / "SKILL.md").exists()
    )


# ---------------------------------------------------------------------------
# Archive decision (pure function)
# ---------------------------------------------------------------------------


def plan_automatic_archives(
    *,
    archive_after_days: int,
    disabled_skills: set[str] | None = None,
    now: datetime | None = None,
) -> list[str]:
    """Return candidate skill names eligible for automatic archival.

    Pure function: only reads sidecar + directory state, returns names, does
    not move anything. The same function drives both dry-run and apply paths.

    Rules:
      - Only ``created_by == "agent"`` skills are eligible.
      - Builtin, unknown, pinned, disabled, and already-archived skills skip.
      - Anchor = last_accessed_at or created_at (fallback).
      - Anchor older than ``archive_after_days`` → candidate.
      - Corrupt sidecar fails closed: raises ValueError, caller must handle.
    """
    if now is None:
        now = datetime.now(timezone.utc)
    cutoff = now - _days(archive_after_days)
    disabled = disabled_skills or set()

    try:
        data = load_usage()
    except ValueError:
        # Fail closed: surface corruption instead of silently skipping.
        raise

    candidates: list[str] = []
    for name in list_active_user_skill_names():
        rec = data.get(name)
        if not isinstance(rec, dict):
            # Unknown user skill (no provenance record) — never auto-archive.
            continue
        if rec.get("created_by") != "agent":
            continue
        if rec.get("pinned"):
            continue
        if name in disabled:
            continue
        anchor_raw = rec.get("last_accessed_at") or rec.get("created_at")
        anchor = _parse_iso(anchor_raw)
        if anchor is None:
            # No usable time anchor — skip this cycle, do not guess.
            continue
        if anchor <= cutoff:
            candidates.append(name)
    return candidates


def _days(n: int) -> timedelta:
    return timedelta(days=n)


# ---------------------------------------------------------------------------
# Archive / restore (filesystem moves)
# ---------------------------------------------------------------------------


def archive_skill(name: str, *, automatic: bool) -> tuple[bool, str]:
    """Move ``~/.mona/skills/<name>/`` to ``~/.mona/skills/.archive/<name>/``.

    Returns (ok, message). Refuses to operate on builtin skills or unknown
    user skills when ``automatic=True``. Refuses to overwrite an existing
    destination. Updates ``archived_at`` on the sidecar (display only).
    """
    if is_builtin(name):
        return False, f"skill '{name}' is builtin; builtin skills are never archived"
    if automatic and get_provenance(name) != "agent":
        return False, (
            f"skill '{name}' is not agent-created; only agent-created skills "
            "are eligible for automatic archival"
        )

    src = _skills_dir() / name
    if not src.exists() or not (src / "SKILL.md").exists():
        return False, f"skill '{name}' not found at {src}"

    archive_root = _archive_dir()
    try:
        archive_root.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return False, f"failed to create archive dir: {e}"

    dest = archive_root / name
    if dest.exists():
        return False, f"destination already exists: {dest} (refusing to overwrite)"

    try:
        src.rename(dest)
    except OSError:
        # Cross-device fallback
        import shutil
        try:
            shutil.move(str(src), str(dest))
        except Exception as e:
            return False, f"failed to archive: {e}"

    set_archived_at(name, _now_iso())
    return True, f"archived to {dest}"


def restore_skill(name: str) -> tuple[bool, str]:
    """Move ``~/.mona/skills/.archive/<name>/`` back to ``~/.mona/skills/<name>/``.

    Refuses to overwrite an existing active skill. Clears ``archived_at``.
    """
    archive_root = _archive_dir()
    src = archive_root / name
    if not src.exists() or not (src / "SKILL.md").exists():
        return False, f"skill '{name}' not found in archive"

    dest = _skills_dir() / name
    if dest.exists():
        return False, f"destination already exists: {dest} (refusing to overwrite)"

    try:
        src.rename(dest)
    except OSError:
        import shutil
        try:
            shutil.move(str(src), str(dest))
        except Exception as e:
            return False, f"failed to restore: {e}"

    set_archived_at(name, None)
    return True, f"restored to {dest}"


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------


def reconcile_archived_at() -> None:
    """Fix ``archived_at`` fields that disagree with directory location.

    - Skill in .archive/ but archived_at is None → stamp now.
    - Skill at active location but archived_at is set → clear it.
    - Skill missing entirely → leave record alone (could be restored later).
    """
    try:
        with _lifecycle_lock():
            data = load_usage()
            changed = False
            archived_names = set(list_archived_skill_names())
            active_user_names = set(list_active_user_skill_names())
            now_iso = _now_iso()
            for name, rec in data.items():
                if not isinstance(rec, dict):
                    continue
                if name in archived_names and not rec.get("archived_at"):
                    rec["archived_at"] = now_iso
                    changed = True
                elif name in active_user_names and rec.get("archived_at"):
                    rec["archived_at"] = None
                    changed = True
            if changed:
                save_usage(data)
    except Exception as e:
        logger.debug("reconcile_archived_at failed: %s", e, exc_info=True)


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def usage_report() -> list[dict[str, Any]]:
    """Return a row per skill on disk (active + archived), with provenance."""
    rows: list[dict[str, Any]] = []
    try:
        data = load_usage()
    except ValueError:
        # Corrupt sidecar — surface what we can from the filesystem.
        data = {}

    seen: set[str] = set()
    for name in list_active_user_skill_names() + list_archived_skill_names():
        if name in seen:
            continue
        seen.add(name)
        rec = data.get(name) if isinstance(data.get(name), dict) else _empty_record()
        base = _empty_record()
        for key, value in base.items():
            rec.setdefault(key, value)
        row = {
            "name": name,
            **rec,
            "provenance": get_provenance(name),
            "location": "archived" if is_archived(name) else "active",
        }
        rows.append(row)
    return sorted(rows, key=lambda r: r["name"])
