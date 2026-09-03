"""Non-destructive migration of managed runtimes into the OS-local store."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from filelock import FileLock, Timeout

from mona.runtime.manager import (
    RuntimeComponentManifest,
    RuntimeComponentStore,
    RuntimeManagerError,
)

_STATE_FILE = "migration-state.json"
_LEGACY_RUNTIME_ENTRIES = (
    "components",
    "agent-env",
    "python",
    "project-locks",
    "project-shims",
    "skill-envs",
    "environments",
)


def migrate_managed_runtime_root(legacy_root: Path, target_root: Path) -> dict[str, object]:
    """Copy active legacy components to the target store and keep the source intact."""
    legacy_root = legacy_root.resolve()
    target_root = target_root.resolve()
    if legacy_root == target_root:
        return _status_payload("not_needed", legacy_root, target_root)
    _require_separate_roots(legacy_root, target_root)
    target_root.mkdir(parents=True, exist_ok=True)

    with FileLock(str(target_root / ".migration.lock"), timeout=600):
        components_root = legacy_root / "components"
        if not components_root.is_dir():
            payload = _status_payload("not_needed", legacy_root, target_root)
            _write_state(target_root, payload)
            return payload

        legacy_store = RuntimeComponentStore(legacy_root)
        target_store = RuntimeComponentStore(target_root)
        migrated: list[str] = []
        repair: list[str] = []
        errors: list[str] = []

        for component_root in sorted(components_root.iterdir(), key=lambda item: item.name):
            if not component_root.is_dir():
                continue
            try:
                component_id = RuntimeComponentManifest._validate_id(component_root.name)
            except ValueError:
                repair.append(component_root.name)
                continue
            source_active = legacy_store.active(component_id)
            if source_active is None:
                repair.append(component_id)
                continue
            target_active = target_store.active(component_id)
            if target_active is not None:
                continue
            try:
                _copy_active_component(
                    legacy_store,
                    target_store,
                    component_id,
                    source_active[1],
                )
                migrated.append(component_id)
            except (OSError, RuntimeManagerError, ValueError) as exc:
                errors.append(f"{component_id}: {exc}")

        state = "partial" if errors else "completed"
        payload = _status_payload(
            state,
            legacy_root,
            target_root,
            migrated=migrated,
            repair=repair,
            errors=errors,
        )
        _write_state(target_root, payload)
        return payload


def runtime_migration_status(legacy_root: Path, target_root: Path) -> dict[str, object]:
    """Return the persisted user-facing migration status without starting work."""
    legacy_root = legacy_root.resolve()
    target_root = target_root.resolve()
    if legacy_root == target_root:
        return _status_payload("not_needed", legacy_root, target_root)
    try:
        payload = json.loads((target_root / _STATE_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        state = "pending" if (legacy_root / "components").is_dir() else "not_needed"
        return _status_payload(state, legacy_root, target_root)
    if not isinstance(payload, dict):
        return _status_payload("pending", legacy_root, target_root)
    state = payload.get("state")
    if state not in {"pending", "partial", "completed", "not_needed"}:
        state = "pending"
    normalized = _status_payload(
        state,
        legacy_root,
        target_root,
        migrated=_string_list(payload.get("migratedComponents")),
        repair=_string_list(payload.get("repairComponents")),
        errors=_string_list(payload.get("errors")),
    )
    if isinstance(payload.get("updatedAt"), str):
        normalized["updatedAt"] = payload["updatedAt"]
    return normalized


def cleanup_legacy_runtime_root(legacy_root: Path, target_root: Path) -> dict[str, int]:
    """Delete the old managed runtime root only after every valid component is covered."""
    legacy_root = legacy_root.resolve()
    target_root = target_root.resolve()
    if legacy_root == target_root or not legacy_root.exists():
        return {"removedLegacyBytes": 0}
    _require_separate_roots(legacy_root, target_root)
    _require_safe_legacy_root(legacy_root, target_root)
    with FileLock(str(target_root / ".migration.lock"), timeout=120):
        status = runtime_migration_status(legacy_root, target_root)
        if status.get("state") not in {"completed", "not_needed"}:
            raise ValueError("旧资源尚未整理完成，暂时不能清理")

        legacy_store = RuntimeComponentStore(legacy_root)
        target_store = RuntimeComponentStore(target_root)
        components_root = legacy_root / "components"
        component_locks: list[FileLock] = []
        if components_root.is_dir():
            try:
                for component_root in sorted(
                    components_root.iterdir(), key=lambda item: item.name
                ):
                    if not component_root.is_dir():
                        continue
                    try:
                        component_id = RuntimeComponentManifest._validate_id(
                            component_root.name
                        )
                    except ValueError:
                        continue
                    lock = FileLock(str(component_root) + ".install.lock", timeout=1)
                    try:
                        lock.acquire()
                    except Timeout as exc:
                        raise ValueError("旧资源正在使用，暂时不能清理") from exc
                    component_locks.append(lock)
                    if (
                        legacy_store.active(component_id) is not None
                        and target_store.active(component_id) is None
                    ):
                        raise ValueError("仍有旧资源未迁移，暂时不能清理")
                removed = _legacy_runtime_bytes(legacy_root)
                for component_root in components_root.iterdir():
                    if component_root.is_dir():
                        try:
                            shutil.rmtree(component_root)
                        except OSError as exc:
                            raise ValueError(
                                "部分旧资源正在使用，请关闭相关任务后重试"
                            ) from exc
            finally:
                for lock in reversed(component_locks):
                    lock.release()
            for lock_file in components_root.glob("*.install.lock"):
                lock_file.unlink(missing_ok=True)
            try:
                components_root.rmdir()
            except OSError:
                pass
        else:
            removed = _legacy_runtime_bytes(legacy_root)

        for name in _LEGACY_RUNTIME_ENTRIES:
            if name == "components":
                continue
            path = legacy_root / name
            try:
                if path.is_symlink() or path.is_file():
                    path.unlink(missing_ok=True)
                elif path.is_dir():
                    shutil.rmtree(path)
            except OSError as exc:
                raise ValueError(
                    "部分旧资源正在使用，请关闭相关任务后重试"
                ) from exc
        try:
            legacy_root.rmdir()
        except OSError:
            pass
        updated = dict(status)
        updated["legacyBytes"] = 0
        updated["cleanupAvailable"] = False
        _write_state(target_root, updated)
        return {"removedLegacyBytes": removed}


def _copy_active_component(
    source_store: RuntimeComponentStore,
    target_store: RuntimeComponentStore,
    component_id: str,
    source_version_root: Path,
) -> None:
    source_version_root = source_version_root.resolve()
    _validate_copy_source(source_store.root, source_version_root)
    source_component_root = source_store.root / "components" / component_id
    with FileLock(str(source_component_root) + ".install.lock", timeout=120):
        current_source = source_store.active(component_id)
        if current_source is None or current_source[1].resolve() != source_version_root:
            raise RuntimeManagerError("legacy runtime changed during migration")
        source_manifest = current_source[0]
        source_receipt = source_store._read_receipt(source_version_root)
        component_root = target_store.root / "components" / component_id
        final = component_root / "versions" / source_manifest.version

        component_root.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(component_root) + ".install.lock", timeout=120):
            if not final.exists():
                component_root.mkdir(parents=True, exist_ok=True)
                for stale in component_root.glob(".migration-*"):
                    if stale.is_dir():
                        shutil.rmtree(stale, ignore_errors=True)
                staging = Path(tempfile.mkdtemp(prefix=".migration-", dir=component_root))
                try:
                    shutil.copytree(source_version_root, staging, dirs_exist_ok=True)
                    copied_manifest = target_store._read_manifest(staging)
                    copied_receipt = target_store._read_receipt(staging)
                    target_store._validate_entrypoints(staging, copied_manifest)
                    if copied_manifest != source_manifest or copied_receipt != source_receipt:
                        raise RuntimeManagerError("copied runtime metadata changed")
                    final.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(staging, final)
                finally:
                    shutil.rmtree(staging, ignore_errors=True)
            installed_manifest = target_store._read_manifest(final)
            installed_receipt = target_store._read_receipt(final)
            target_store._validate_entrypoints(final, installed_manifest)
            if (
                installed_manifest != source_manifest
                or installed_receipt.id != source_receipt.id
                or installed_receipt.version != source_receipt.version
                or installed_receipt.sha256 != source_receipt.sha256
            ):
                raise RuntimeManagerError("target runtime identity differs")
            target_store._activate(component_root, installed_receipt)

    active = target_store.active(component_id)
    if active is None or active[0].version != source_manifest.version:
        raise RuntimeManagerError("migrated runtime could not be activated")


def _validate_copy_source(root: Path, source: Path) -> None:
    root = root.resolve()
    if source == root or root not in source.parents:
        raise RuntimeManagerError("legacy runtime path escapes its root")
    for path in source.rglob("*"):
        if path.is_symlink():
            raise RuntimeManagerError("legacy runtime contains a symbolic link")
        resolved = path.resolve()
        if resolved != source and source not in resolved.parents:
            raise RuntimeManagerError("legacy runtime content escapes its version directory")


def _require_safe_legacy_root(legacy_root: Path, target_root: Path) -> None:
    if legacy_root == target_root:
        raise ValueError("旧资源目录与新目录相同")
    if legacy_root == Path(legacy_root.anchor).resolve() or legacy_root == Path.home().resolve():
        raise ValueError("拒绝清理不安全的旧资源目录")
    if legacy_root.name.casefold() != "runtimes" or legacy_root.parent == legacy_root:
        raise ValueError("旧资源目录不符合预期")


def _require_separate_roots(legacy_root: Path, target_root: Path) -> None:
    if legacy_root in target_root.parents or target_root in legacy_root.parents:
        raise ValueError("新旧运行时目录不能互相包含")


def _status_payload(
    state: str,
    legacy_root: Path,
    target_root: Path,
    *,
    migrated: list[str] | None = None,
    repair: list[str] | None = None,
    errors: list[str] | None = None,
) -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "state": state,
        "migratedComponents": migrated or [],
        "repairComponents": repair or [],
        "errors": errors or [],
        "legacyBytes": _legacy_runtime_bytes(legacy_root),
        "cleanupAvailable": bool(
            state in {"completed", "not_needed"}
            and legacy_root != target_root
            and _legacy_runtime_bytes(legacy_root) > 0
        ),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }


def _tree_bytes(root: Path) -> int:
    total = 0
    if root.is_symlink():
        return total
    if not root.is_dir():
        return total
    for path in root.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except OSError:
            continue
    return total


def _legacy_runtime_bytes(root: Path) -> int:
    return sum(_tree_bytes(root / name) for name in _LEGACY_RUNTIME_ENTRIES)


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _write_state(root: Path, payload: dict[str, object]) -> None:
    RuntimeComponentStore._write_json(root / _STATE_FILE, payload)


__all__ = [
    "cleanup_legacy_runtime_root",
    "migrate_managed_runtime_root",
    "runtime_migration_status",
]
