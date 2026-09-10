from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path

import pytest
from filelock import FileLock

import mona.config.paths as config_paths
import mona.runtime.migration as migration
from mona.runtime.manager import RuntimeComponentStore


def _install_component(
    tmp_path: Path,
    root: Path,
    component_id: str = "python-base",
    version: str = "1.0.0",
    payload: bytes = b"runtime",
) -> RuntimeComponentStore:
    archive = tmp_path / f"{component_id}-{version}.zip"
    manifest = {
        "schemaVersion": 1,
        "id": component_id,
        "version": version,
        "kind": "python-runtime",
        "entrypoints": {"python": "bin/python.exe"},
    }
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("runtime-manifest.json", json.dumps(manifest))
        bundle.writestr("bin/python.exe", payload)
    store = RuntimeComponentStore(root)
    store.install_archive(archive)
    return store


def _roots(tmp_path: Path) -> tuple[Path, Path]:
    return tmp_path / "runtimes", tmp_path / "new-runtimes"


def test_migration_copies_active_component_and_keeps_legacy_root(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    legacy_store = _install_component(tmp_path, legacy_root)

    payload = migration.migrate_managed_runtime_root(legacy_root, target_root)

    assert payload["state"] == "completed"
    assert payload["migratedComponents"] == ["python-base"]
    assert legacy_store.active("python-base") is not None
    target_active = RuntimeComponentStore(target_root).active("python-base")
    assert target_active is not None
    assert target_active[0].version == "1.0.0"
    assert target_active[1].joinpath("bin/python.exe").read_bytes() == b"runtime"
    assert legacy_root.exists()


def test_migration_is_idempotent(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root)
    migration.migrate_managed_runtime_root(legacy_root, target_root)
    target_component = target_root / "components" / "python-base"
    before = (target_component / "current.json").read_bytes()

    payload = migration.migrate_managed_runtime_root(legacy_root, target_root)

    assert payload["state"] == "completed"
    assert payload["migratedComponents"] == []
    assert (target_component / "current.json").read_bytes() == before
    assert [path.name for path in (target_component / "versions").iterdir()] == ["1.0.0"]


def test_completed_migration_fast_path_does_not_rescan_legacy_tree(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root)
    migration.migrate_managed_runtime_root(legacy_root, target_root)

    monkeypatch.setattr(
        migration,
        "_legacy_runtime_bytes",
        lambda _root: pytest.fail("completed migration must not rescan legacy files"),
    )

    payload = migration.migrate_managed_runtime_root(legacy_root, target_root)

    assert payload["state"] == "completed"
    assert payload["legacyBytes"] > 0


def test_incomplete_completed_marker_does_not_skip_migration(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root)
    target_root.mkdir()
    (target_root / "migration-state.json").write_text(
        '{"state": "completed"}',
        encoding="utf-8",
    )

    payload = migration.migrate_managed_runtime_root(legacy_root, target_root)

    assert payload["migratedComponents"] == ["python-base"]
    assert RuntimeComponentStore(target_root).active("python-base") is not None


def test_migration_does_not_overwrite_valid_target_component(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root, payload=b"legacy")
    _install_component(tmp_path, target_root, version="2.0.0", payload=b"target")

    payload = migration.migrate_managed_runtime_root(legacy_root, target_root)

    assert payload["state"] == "completed"
    assert payload["migratedComponents"] == []
    target_active = RuntimeComponentStore(target_root).active("python-base")
    assert target_active is not None
    assert target_active[0].version == "2.0.0"
    assert target_active[1].joinpath("bin/python.exe").read_bytes() == b"target"
    assert legacy_root.exists()


def test_migration_rejects_unactivated_same_version_with_different_bytes(
    tmp_path: Path,
) -> None:
    legacy_root, target_root = _roots(tmp_path)
    legacy_store = _install_component(tmp_path, legacy_root, payload=b"legacy")
    target_store = _install_component(tmp_path, target_root, payload=b"different")
    target_store.deactivate("python-base")

    source_receipt = json.loads(
        (
            legacy_store.root
            / "components"
            / "python-base"
            / "versions"
            / "1.0.0"
            / "receipt.json"
        ).read_text(encoding="utf-8")
    )
    target_receipt = json.loads(
        (
            target_store.root
            / "components"
            / "python-base"
            / "versions"
            / "1.0.0"
            / "receipt.json"
        ).read_text(encoding="utf-8")
    )
    assert target_receipt["version"] == source_receipt["version"]
    assert target_receipt["sha256"] != source_receipt["sha256"]

    payload = migration.migrate_managed_runtime_root(legacy_root, target_root)

    assert payload["state"] == "partial"
    assert payload["migratedComponents"] == []
    assert RuntimeComponentStore(target_root).active("python-base") is None
    assert legacy_root.exists()


def test_migration_rejects_nested_runtime_roots(tmp_path: Path) -> None:
    legacy_root = tmp_path / "runtimes"
    target_root = legacy_root / "target" / "runtimes"
    _install_component(tmp_path, legacy_root)

    with pytest.raises(ValueError, match="不能互相包含"):
        migration.migrate_managed_runtime_root(legacy_root, target_root)

    assert legacy_root.exists()


def test_corrupt_source_is_marked_for_repair_without_blocking_other_components(
    tmp_path: Path,
) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root, component_id="healthy")
    _install_component(tmp_path, legacy_root, component_id="broken")
    (legacy_root / "components" / "broken" / "versions" / "1.0.0" / "bin" / "python.exe").unlink()

    payload = migration.migrate_managed_runtime_root(legacy_root, target_root)

    assert payload["state"] == "completed"
    assert payload["migratedComponents"] == ["healthy"]
    assert payload["repairComponents"] == ["broken"]
    assert RuntimeComponentStore(target_root).active("healthy") is not None
    assert RuntimeComponentStore(target_root).active("broken") is None
    assert not payload["errors"]


def test_copy_failure_returns_partial_and_keeps_legacy_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    legacy_root, target_root = _roots(tmp_path)
    legacy_store = _install_component(tmp_path, legacy_root)

    def fail_copy(*_args, **_kwargs) -> None:
        raise OSError("simulated copy failure")

    monkeypatch.setattr(migration.shutil, "copytree", fail_copy)

    payload = migration.migrate_managed_runtime_root(legacy_root, target_root)

    assert payload["state"] == "partial"
    assert payload["migratedComponents"] == []
    assert payload["errors"] == ["python-base: simulated copy failure"]
    assert legacy_root.exists()
    assert legacy_store.active("python-base") is not None
    assert RuntimeComponentStore(target_root).active("python-base") is None


def test_cleanup_rejects_incomplete_migration(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root)

    with pytest.raises(ValueError, match="尚未整理完成"):
        migration.cleanup_legacy_runtime_root(legacy_root, target_root)

    assert legacy_root.exists()


def test_cleanup_rejects_nested_runtime_roots(tmp_path: Path) -> None:
    legacy_root = tmp_path / "runtimes"
    target_root = legacy_root / "target" / "runtimes"
    _install_component(tmp_path, legacy_root)

    with pytest.raises(ValueError, match="不能互相包含"):
        migration.cleanup_legacy_runtime_root(legacy_root, target_root)

    assert legacy_root.exists()


def test_cleanup_removes_legacy_only_after_target_is_covered(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root)
    migration.migrate_managed_runtime_root(legacy_root, target_root)

    result = migration.cleanup_legacy_runtime_root(legacy_root, target_root)

    assert result["removedLegacyBytes"] > 0
    assert not legacy_root.exists()
    assert RuntimeComponentStore(target_root).active("python-base") is not None
    status = migration.runtime_migration_status(legacy_root, target_root)
    assert status["legacyBytes"] == 0
    assert status["cleanupAvailable"] is False


def test_cleanup_preserves_unknown_legacy_content(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root)
    unrelated = legacy_root / "keep.txt"
    unrelated.write_text("user content", encoding="utf-8")
    migration.migrate_managed_runtime_root(legacy_root, target_root)

    migration.cleanup_legacy_runtime_root(legacy_root, target_root)

    assert unrelated.read_text(encoding="utf-8") == "user content"
    assert not (legacy_root / "components").exists()
    assert migration.runtime_migration_status(legacy_root, target_root)[
        "cleanupAvailable"
    ] is False


def test_cleanup_refuses_runtime_that_is_still_in_use(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root)
    migration.migrate_managed_runtime_root(legacy_root, target_root)
    held = FileLock(
        str(legacy_root / "components" / "python-base") + ".install.lock",
        timeout=0,
    )
    held.acquire()
    try:
        with pytest.raises(ValueError, match="正在使用"):
            migration.cleanup_legacy_runtime_root(legacy_root, target_root)
    finally:
        held.release()

    assert legacy_root.exists()


def test_migration_status_reports_legacy_bytes_and_cleanup_availability(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root)

    pending = migration.runtime_migration_status(legacy_root, target_root)
    assert pending["state"] == "pending"
    assert pending["legacyBytes"] > 0
    assert pending["cleanupAvailable"] is False

    migration.migrate_managed_runtime_root(legacy_root, target_root)
    complete = migration.runtime_migration_status(legacy_root, target_root)
    assert complete["state"] == "completed"
    assert complete["legacyBytes"] > 0
    assert complete["cleanupAvailable"] is True


def test_completed_status_uses_persisted_size_without_rescan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    legacy_root, target_root = _roots(tmp_path)
    _install_component(tmp_path, legacy_root)
    completed = migration.migrate_managed_runtime_root(legacy_root, target_root)

    monkeypatch.setattr(
        migration,
        "_legacy_runtime_bytes",
        lambda _root: pytest.fail("completed status must use persisted size"),
    )

    status = migration.runtime_migration_status(legacy_root, target_root)

    assert status["state"] == "completed"
    assert status["legacyBytes"] == completed["legacyBytes"]


def test_status_payload_counts_legacy_bytes_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def count_once(_root: Path) -> int:
        nonlocal calls
        calls += 1
        return 7

    monkeypatch.setattr(migration, "_legacy_runtime_bytes", count_once)

    status = migration._status_payload(
        "completed",
        tmp_path / "legacy",
        tmp_path / "target",
    )

    assert status["legacyBytes"] == 7
    assert status["cleanupAvailable"] is True
    assert calls == 1


def test_migration_status_normalizes_incomplete_state_file(tmp_path: Path) -> None:
    legacy_root, target_root = _roots(tmp_path)
    target_root.mkdir()
    (target_root / "migration-state.json").write_text("{}", encoding="utf-8")

    status = migration.runtime_migration_status(legacy_root, target_root)

    assert status["state"] == "pending"
    assert status["migratedComponents"] == []
    assert status["repairComponents"] == []
    assert status["errors"] == []


@pytest.mark.skipif(os.name != "nt", reason="Windows LocalAppData migration")
def test_managed_runtime_path_switches_after_successful_migration(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_root = tmp_path / "data"
    local_root = tmp_path / "local"
    legacy_root = data_root / "runtimes"
    _install_component(tmp_path, legacy_root)
    monkeypatch.setattr(config_paths, "get_data_dir", lambda: data_root)
    monkeypatch.setenv("LOCALAPPDATA", str(local_root))

    selected = config_paths.get_managed_runtimes_dir()

    assert selected == (local_root / "Mona" / "runtimes").resolve()
    assert RuntimeComponentStore(selected).active("python-base") is not None
    assert legacy_root.exists()


def test_managed_runtime_path_falls_back_and_stays_stable_when_target_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_root = tmp_path / "data"
    legacy_root = data_root / "runtimes"
    _install_component(tmp_path, legacy_root)
    blocked_target = tmp_path / "target"
    blocked_target.write_text("not a directory", encoding="utf-8")
    monkeypatch.setattr(config_paths, "get_data_dir", lambda: data_root)
    monkeypatch.setattr(
        config_paths,
        "get_target_managed_runtimes_dir",
        lambda: blocked_target,
    )

    first = config_paths.get_managed_runtimes_dir()
    second = config_paths.get_managed_runtimes_dir()

    assert first == second == legacy_root.resolve()
    assert blocked_target.is_file()
