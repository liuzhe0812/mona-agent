"""Atomic user-profile storage with explicit user-owned state boundaries."""

from __future__ import annotations

import json
import re
import shutil
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

from filelock import FileLock
from filelock import Timeout as FileLockTimeout
from loguru import logger

from mona.distill.base import DistillResult

_RICH_PROFILE_FILENAME = "profile.rich.json"
_USER_FILENAME = "USER.md"
_PROFILE_VERSION = "3.0"
_MIGRATION_MARKER = ".migrated-from-mona-memory-v1"
_MAX_TRAJECTORY_POINTS = 104
_STORE_LOCK = threading.RLock()
_FILE_LOCKS: dict[str, FileLock] = {}

_TASK_KEY_MAP = {
    "work-pattern": "work_patterns",
    "profile": "profile",
    "advice": "advice",
    "dashboard": "dashboard",
}
_SECTION_TO_FIELD = {
    "Basic Information": "background",
    "Preferences": "preferences",
    "Work Context": "work_context",
    "Topics of Interest": "interests",
    "Special Instructions": "special_instructions",
}
_FIELD_TO_SECTION = {value: key for key, value in _SECTION_TO_FIELD.items()}
_OBSERVED_FIELDS = (
    "background",
    "current_focus",
    "preferences",
    "work_context",
    "interests",
)


class ProfileRevisionConflictError(ValueError):
    """An optimistic profile update used a stale revision."""

    def __init__(self, current_revision: int):
        super().__init__("profile revision changed")
        self.current_revision = current_revision


class ProfileItemNotFoundError(KeyError):
    """Feedback targeted an unknown profile item."""


class ProfileStoreBusyError(RuntimeError):
    """The short cross-process store lock could not be acquired."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_rich_profile_path(memory_dir: Path) -> Path:
    return memory_dir / _RICH_PROFILE_FILENAME


def _lock_for(memory_dir: Path) -> FileLock:
    key = str((memory_dir / ".store.lock").resolve())
    lock = _FILE_LOCKS.get(key)
    if lock is None:
        lock = FileLock(key, timeout=5)
        _FILE_LOCKS[key] = lock
    return lock


@contextmanager
def _write_lock(memory_dir: Path) -> Iterator[None]:
    memory_dir.mkdir(parents=True, exist_ok=True)
    with _STORE_LOCK:
        try:
            with _lock_for(memory_dir):
                yield
        except FileLockTimeout as exc:
            raise ProfileStoreBusyError("profile store is busy") from exc


def _atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def ensure_user_profile_store() -> Path:
    """Return the user-level profile store after a non-destructive legacy copy."""
    from mona.config.paths import get_memory_dir, get_user_profile_dir

    destination = get_user_profile_dir()
    destination.mkdir(parents=True, exist_ok=True)
    marker = destination / _MIGRATION_MARKER
    if not marker.exists():
        with _write_lock(destination):
            if not marker.exists():
                source = get_memory_dir()
                for filename in (_RICH_PROFILE_FILENAME, _USER_FILENAME):
                    src = source / filename
                    dst = destination / filename
                    if src.is_file() and not dst.exists():
                        shutil.copy2(src, dst)
                        if dst.read_bytes() != src.read_bytes():
                            raise OSError(f"profile migration verification failed for {filename}")
                _atomic_write_text(marker, _now_iso() + "\n")
    ensure_profile_v3(destination)
    return destination


def _empty_rich_profile() -> dict[str, Any]:
    return {
        "version": _PROFILE_VERSION,
        "scope": "user",
        "revision": 0,
        "updated_at": None,
        "last_distilled_at": None,
        "facts": {"explicit_context": {}, "context_revision": 0},
        "profile": {"understanding": []},
        "work_patterns": {},
        "dashboard": {},
        "advice": {
            "current_ids": [],
            "items": [],
            "generation_status": "unavailable",
            "empty_reason": "尚未生成建议",
        },
        "feedback": {"advice": {}, "artifacts": {}},
        "evidence_index": {},
        "evidence": {},
        "trajectory": [],
        "visualizations": {},
        "projection_error": None,
    }


def _normalise_profile(data: dict[str, Any]) -> dict[str, Any]:
    defaults = _empty_rich_profile()
    for key, value in defaults.items():
        data.setdefault(key, value)
    facts = data["facts"] if isinstance(data.get("facts"), dict) else {}
    data["facts"] = facts
    facts.setdefault("explicit_context", {})
    facts.setdefault("context_revision", 0)
    feedback = data["feedback"] if isinstance(data.get("feedback"), dict) else {}
    data["feedback"] = feedback
    feedback.setdefault("advice", {})
    feedback.setdefault("artifacts", {})
    profile = data["profile"] if isinstance(data.get("profile"), dict) else {}
    data["profile"] = profile
    profile.setdefault("understanding", [])
    return data


def _read_rich_profile_unlocked(memory_dir: Path) -> dict[str, Any]:
    path = get_rich_profile_path(memory_dir)
    if not path.exists():
        return _empty_rich_profile()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return _empty_rich_profile()
        return _normalise_profile(data)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning(f"[distill.store] failed to read rich profile: {exc}")
        return _empty_rich_profile()


def read_rich_profile(memory_dir: Path) -> dict[str, Any]:
    return _read_rich_profile_unlocked(memory_dir)


def _write_rich_unlocked(
    memory_dir: Path,
    data: dict[str, Any],
    *,
    distilled_at: str | None = None,
    increment_revision: bool = True,
) -> dict[str, Any]:
    data = _normalise_profile(data)
    data["version"] = _PROFILE_VERSION
    data["scope"] = "user"
    if increment_revision:
        data["revision"] = int(data.get("revision") or 0) + 1
    data["updated_at"] = _now_iso()
    if distilled_at is not None:
        data["last_distilled_at"] = distilled_at
    _atomic_write_text(
        get_rich_profile_path(memory_dir),
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
    )
    return data


def write_rich_profile(
    memory_dir: Path,
    data: dict[str, Any],
    *,
    distilled_at: str | None = None,
) -> dict[str, Any]:
    with _write_lock(memory_dir):
        return _write_rich_unlocked(memory_dir, data, distilled_at=distilled_at)


def mutate_rich_profile(
    memory_dir: Path,
    mutator: Callable[[dict[str, Any]], None],
    *,
    distilled_at: str | None = None,
) -> dict[str, Any]:
    with _write_lock(memory_dir):
        data = _read_rich_profile_unlocked(memory_dir)
        mutator(data)
        return _write_rich_unlocked(memory_dir, data, distilled_at=distilled_at)


def commit_dashboard_bundle(
    memory_dir: Path,
    dashboard: dict[str, Any],
    evidence_index: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Commit deterministic dashboard data and its bounded evidence cache."""
    def mutate(data: dict[str, Any]) -> None:
        data["dashboard"] = dashboard
        data["evidence_index"] = evidence_index

    return mutate_rich_profile(memory_dir, mutate)


def _markdown_sections(text: str) -> dict[str, str]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", text or "", re.MULTILINE))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[match.group(1).strip()] = text[start:end].strip()
    return sections


def ensure_profile_v3(memory_dir: Path) -> dict[str, Any]:
    """Upgrade the rich shape and import unambiguous legacy user sections once."""
    with _write_lock(memory_dir):
        data = _read_rich_profile_unlocked(memory_dir)
        facts = data["facts"]
        if data.get("version") == _PROFILE_VERSION and facts.get("legacy_explicit_imported"):
            return data
        explicit = facts.setdefault("explicit_context", {})
        sections = _markdown_sections(read_user_profile(memory_dir))
        imported = False
        now = _now_iso()
        for section, field in _SECTION_TO_FIELD.items():
            content = sections.get(section, "").strip()
            if content and field not in explicit:
                explicit[field] = {"mode": "override", "value": content, "updated_at": now}
                imported = True
        facts["legacy_explicit_imported"] = True
        if imported:
            facts["context_revision"] = int(facts.get("context_revision") or 0) + 1
        return _write_rich_unlocked(memory_dir, data)


def _replace_user_section_text(text: str, section: str, content: str) -> str:
    pattern = re.compile(
        r"(^##\s+" + re.escape(section) + r"\s*\n)(.*?)(?=^##\s+|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    new_block = f"## {section}\n\n{content.strip()}\n\n"
    if pattern.search(text):
        return pattern.sub(new_block, text)
    if not text:
        text = "# User Profile\n\n"
    elif not text.endswith("\n\n"):
        text += "\n\n"
    return text + new_block


def update_user_section(user_path: Path, section: str, content: str) -> None:
    memory_dir = user_path.parent
    with _write_lock(memory_dir):
        text = user_path.read_text(encoding="utf-8") if user_path.exists() else ""
        _atomic_write_text(user_path, _replace_user_section_text(text, section, content))


def replace_user_profile(memory_dir: Path, content: str) -> None:
    with _write_lock(memory_dir):
        _atomic_write_text(memory_dir / _USER_FILENAME, content)


def _project_explicit_context_unlocked(memory_dir: Path, data: dict[str, Any]) -> None:
    user_path = memory_dir / _USER_FILENAME
    text = user_path.read_text(encoding="utf-8") if user_path.exists() else ""
    explicit = data.get("facts", {}).get("explicit_context", {})
    for field, section in _FIELD_TO_SECTION.items():
        item = explicit.get(field)
        if isinstance(item, dict) and item.get("mode") == "override":
            text = _replace_user_section_text(text, section, str(item.get("value") or ""))
        elif isinstance(item, dict) and item.get("mode") == "suppress":
            text = _replace_user_section_text(text, section, "")
    _atomic_write_text(user_path, text)


def _project_and_record(
    memory_dir: Path,
    data: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, str] | None]:
    try:
        _project_explicit_context_unlocked(memory_dir, data)
        if data.get("projection_error") is not None:
            data["projection_error"] = None
            _write_rich_unlocked(memory_dir, data, increment_revision=False)
        return data, None
    except OSError:
        warning = {
            "code": "user_projection_failed",
            "message": "修改已保存，可读副本尚未同步",
        }
        data["projection_error"] = {
            "code": warning["code"],
            "occurred_at": _now_iso(),
            "profile_revision": int(data.get("revision") or 0),
        }
        _write_rich_unlocked(memory_dir, data, increment_revision=False)
        logger.exception("[distill.store] USER.md projection failed")
        return data, warning


def update_explicit_context(
    memory_dir: Path,
    *,
    field: str,
    mode: str,
    value: str,
    expected_context_revision: int,
) -> tuple[dict[str, Any], dict[str, str] | None]:
    with _write_lock(memory_dir):
        data = _read_rich_profile_unlocked(memory_dir)
        facts = data["facts"]
        current = int(facts.get("context_revision") or 0)
        if expected_context_revision != current:
            raise ProfileRevisionConflictError(current)
        explicit = facts.setdefault("explicit_context", {})
        if mode == "reset":
            explicit.pop(field, None)
        else:
            explicit[field] = {
                "mode": mode,
                "value": value.strip() if mode == "override" else "",
                "updated_at": _now_iso(),
            }
        facts["context_revision"] = current + 1
        data = _write_rich_unlocked(memory_dir, data)
        return _project_and_record(memory_dir, data)


def update_advice_feedback(
    memory_dir: Path,
    advice_id: str,
    patch: dict[str, Any],
    expected_item_revision: int,
) -> dict[str, Any]:
    result: dict[str, Any] = {}

    def mutate(data: dict[str, Any]) -> None:
        nonlocal result
        items = data.get("advice", {}).get("items", [])
        if not any(isinstance(item, dict) and item.get("id") == advice_id for item in items):
            raise ProfileItemNotFoundError(advice_id)
        feedback = data["feedback"].setdefault("advice", {})
        current = feedback.get(advice_id, {})
        revision = int(current.get("revision") or 0)
        if revision != expected_item_revision:
            raise ProfileRevisionConflictError(revision)
        updated = {
            "revision": revision,
            "useful": current.get("useful"),
            "disposition": current.get("disposition", "active"),
            "dismiss_reason": current.get("dismiss_reason"),
            "updated_at": current.get("updated_at"),
        }
        if patch.get("useful") is not None:
            updated["useful"] = patch["useful"]
        if patch.get("disposition") is not None:
            updated["disposition"] = patch["disposition"]
            updated["dismiss_reason"] = patch.get("dismiss_reason")
        meaningful = {key: value for key, value in updated.items() if key not in {"revision", "updated_at"}}
        old_meaningful = {key: current.get(key) for key in meaningful}
        if meaningful != old_meaningful:
            updated["revision"] = revision + 1
            updated["updated_at"] = _now_iso()
            feedback[advice_id] = updated
        else:
            updated = current
        current_ids = data.setdefault("advice", {}).setdefault("current_ids", [])
        if updated.get("disposition") in {"dismissed", "completed"}:
            data["advice"]["current_ids"] = [item for item in current_ids if item != advice_id]
        elif advice_id not in current_ids and len(current_ids) < 3:
            data["advice"]["current_ids"] = [*current_ids, advice_id]
        result = dict(updated)

    data = mutate_rich_profile(memory_dir, mutate)
    result["profile_revision"] = data["revision"]
    result["current_ids"] = data.get("advice", {}).get("current_ids", [])
    return result


def update_artifact_feedback(
    memory_dir: Path,
    artifact_id: str,
    adopted: bool,
    expected_item_revision: int,
) -> dict[str, Any]:
    result: dict[str, Any] = {}

    def mutate(data: dict[str, Any]) -> None:
        nonlocal result
        artifacts = data.get("dashboard", {}).get("artifacts", [])
        if not any(isinstance(item, dict) and item.get("id") == artifact_id for item in artifacts):
            raise ProfileItemNotFoundError(artifact_id)
        feedback = data["feedback"].setdefault("artifacts", {})
        current = feedback.get(artifact_id, {})
        revision = int(current.get("revision") or 0)
        if revision != expected_item_revision:
            raise ProfileRevisionConflictError(revision)
        if current.get("adopted") == adopted:
            result = dict(current)
            return
        result = {"revision": revision + 1, "adopted": adopted, "updated_at": _now_iso()}
        feedback[artifact_id] = result

    data = mutate_rich_profile(memory_dir, mutate)
    result["profile_revision"] = data["revision"]
    return result


def effective_context(data: dict[str, Any]) -> list[dict[str, Any]]:
    explicit = data.get("facts", {}).get("explicit_context", {})
    observed = {
        item.get("field"): item
        for item in data.get("profile", {}).get("understanding", [])
        if isinstance(item, dict) and item.get("field") in _OBSERVED_FIELDS
    }
    output: list[dict[str, Any]] = []
    for field in (*_OBSERVED_FIELDS, "special_instructions"):
        confirmed = explicit.get(field)
        if isinstance(confirmed, dict) and confirmed.get("mode") == "suppress":
            output.append({"field": field, "value": "", "origin": "suppressed", "source_refs": []})
        elif isinstance(confirmed, dict) and confirmed.get("mode") == "override":
            output.append({
                "field": field,
                "value": str(confirmed.get("value") or ""),
                "origin": "confirmed",
                "source_refs": [f"explicit:{field}"],
            })
        elif field in observed:
            item = observed[field]
            output.append({
                "field": field,
                "value": str(item.get("text") or ""),
                "origin": "observed",
                "source_refs": list(item.get("source_refs") or []),
            })
        else:
            output.append({"field": field, "value": "", "origin": "missing", "source_refs": []})
    return output


def replace_user_profile_and_sync(memory_dir: Path, content: str) -> dict[str, Any]:
    with _write_lock(memory_dir):
        data = _read_rich_profile_unlocked(memory_dir)
        explicit = data["facts"].setdefault("explicit_context", {})
        sections = _markdown_sections(content)
        now = _now_iso()
        changed = False
        for section, field in _SECTION_TO_FIELD.items():
            value = sections.get(section, "").strip()
            old = explicit.get(field)
            if value and (not isinstance(old, dict) or old.get("value") != value):
                explicit[field] = {"mode": "override", "value": value, "updated_at": now}
                changed = True
        if changed:
            data["facts"]["context_revision"] = int(data["facts"].get("context_revision") or 0) + 1
        _atomic_write_text(memory_dir / _USER_FILENAME, content)
        return _write_rich_unlocked(memory_dir, data)


def update_user_section_and_sync(memory_dir: Path, section: str, content: str) -> dict[str, Any]:
    field = _SECTION_TO_FIELD.get(section)
    if field:
        data = ensure_profile_v3(memory_dir)
        updated, _ = update_explicit_context(
            memory_dir,
            field=field,
            mode="override",
            value=content,
            expected_context_revision=int(data.get("facts", {}).get("context_revision") or 0),
        )
        return updated
    update_user_section(memory_dir / _USER_FILENAME, section, content)
    return mutate_rich_profile(memory_dir, lambda _data: None)


def append_trajectory_point(memory_dir: Path, point: dict[str, Any]) -> None:
    def mutate(data: dict[str, Any]) -> None:
        trajectory = data.setdefault("trajectory", [])
        trajectory.append(point)
        data["trajectory"] = trajectory[-_MAX_TRAJECTORY_POINTS:]

    mutate_rich_profile(memory_dir, mutate)


def write_distill_result(memory_dir: Path, result: DistillResult) -> None:
    """Merge one generated result without overwriting user feedback or facts."""
    now = _now_iso()
    with _write_lock(memory_dir):
        data = _read_rich_profile_unlocked(memory_dir)
        task_key = _TASK_KEY_MAP.get(result.task_name, result.task_name.replace("-", "_"))
        if result.data:
            if result.task_name in {"profile", "advice"}:
                expected = result.data.get("context_revision_used")
                current = int(data.get("facts", {}).get("context_revision") or 0)
                if expected is not None and int(expected) != current:
                    raise ProfileRevisionConflictError(current)
            if result.task_name == "advice":
                latest_feedback = data.get("feedback", {}).get("advice", {})
                result.data["current_ids"] = [
                    item_id
                    for item_id in result.data.get("current_ids", [])
                    if not (
                        isinstance(latest_feedback.get(item_id), dict)
                        and latest_feedback[item_id].get("disposition")
                        in {"dismissed", "completed"}
                    )
                ][:3]
            if result.task_name == "profile":
                existing = data.get(task_key) if isinstance(data.get(task_key), dict) else {}
                data[task_key] = {**existing, **result.data}
            else:
                data[task_key] = result.data
            if "evidence" in result.data:
                data.setdefault("evidence", {}).update(result.data["evidence"])
            if "visualizations" in result.data:
                data.setdefault("visualizations", {}).update(result.data["visualizations"])
        if result.success and result.confidence > 0 and result.task_name != "advice":
            trajectory = data.setdefault("trajectory", [])
            trajectory.append({
                "timestamp": now,
                "task": result.task_name,
                "confidence": result.confidence,
                "data_snapshot": {
                    key: value
                    for key, value in result.data.items()
                    if key not in ("evidence", "visualizations")
                },
            })
            data["trajectory"] = trajectory[-_MAX_TRAJECTORY_POINTS:]
        distilled_at = now if result.success and result.task_name == "profile" else None
        data = _write_rich_unlocked(memory_dir, data, distilled_at=distilled_at)

        sections: list[tuple[str, str]] = []
        if result.user_section and result.markdown:
            sections.append((result.user_section, result.markdown))
        sections.extend(result.extra_sections)
        if sections:
            user_path = memory_dir / _USER_FILENAME
            text = user_path.read_text(encoding="utf-8") if user_path.exists() else ""
            try:
                for section, content in sections:
                    if content:
                        text = _replace_user_section_text(text, section, content)
                _atomic_write_text(user_path, text)
            except OSError:
                data["projection_error"] = {
                    "code": "user_projection_failed",
                    "occurred_at": _now_iso(),
                    "profile_revision": data["revision"],
                }
                _write_rich_unlocked(memory_dir, data, increment_revision=False)
                logger.exception("[distill.store] generated USER.md projection failed")
    logger.info(
        f"[distill.store] wrote result for task '{result.task_name}' "
        f"(confidence={result.confidence:.2f})"
    )


def record_advice_failure(memory_dir: Path, *, code: str, message: str) -> dict[str, Any]:
    """Record a failed advice attempt without clearing prior successful items."""
    def mutate(data: dict[str, Any]) -> None:
        advice = data.setdefault("advice", {})
        advice["last_attempt_at"] = _now_iso()
        advice["generation_status"] = "failed"
        advice["failure"] = {"code": code, "message": message}

    return mutate_rich_profile(memory_dir, mutate)


def read_user_profile(memory_dir: Path) -> str:
    user_path = memory_dir / _USER_FILENAME
    if not user_path.exists():
        return ""
    return user_path.read_text(encoding="utf-8")


__all__ = [
    "ProfileItemNotFoundError",
    "ProfileRevisionConflictError",
    "ProfileStoreBusyError",
    "append_trajectory_point",
    "commit_dashboard_bundle",
    "effective_context",
    "ensure_profile_v3",
    "ensure_user_profile_store",
    "get_rich_profile_path",
    "mutate_rich_profile",
    "read_rich_profile",
    "read_user_profile",
    "record_advice_failure",
    "replace_user_profile",
    "replace_user_profile_and_sync",
    "update_advice_feedback",
    "update_artifact_feedback",
    "update_explicit_context",
    "update_user_section",
    "update_user_section_and_sync",
    "write_distill_result",
    "write_rich_profile",
]
