"""Tests for the workspace-output migration (阶段 5).

Covers:
- Global resource migration (move semantics, no copy).
- Loose artifact migration into ``<workspace>/output/``.
- Manifest idempotency (second run is a no-op).
- Conflict backup behavior (existing target does not get overwritten).
- Git-repo manual_required short-circuit.
- Legacy path resolution used by transcript replay.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from mona.config import paths as paths_mod
from mona.config.migrate_global import (
    MIGRATION_VERSION,
    _manifest_path,
    migrate_global_resources,
    resolve_legacy_path,
)
from mona.config.migrate_workspace_output import (
    RESERVED_TOP_LEVEL,
    migrate_workspace_output,
    run_startup_migrations,
)


@pytest.fixture
def isolated_instance(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect mona's config path and workspace to a tmp instance dir.

    Returns the tmp_path (the synthetic ``~/.mona/`` root).
    """
    config_file = tmp_path / "config.json"
    config_file.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(paths_mod, "get_config_path", lambda: config_file)
    # Force the module-level imports inside migrate_global to use the patched
    # functions (they import names at module load time but call them at
    # runtime, so monkeypatching paths_mod is enough).
    from mona.config import migrate_global as mg
    monkeypatch.setattr(mg, "get_data_dir", lambda: tmp_path)
    monkeypatch.setattr(mg, "get_memory_dir", lambda: tmp_path / "memory")
    monkeypatch.setattr(mg, "get_skills_dir", lambda: tmp_path / "skills")
    monkeypatch.setattr(mg, "get_heartbeat_path", lambda: tmp_path / "HEARTBEAT.md")
    workspace = tmp_path / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(mg, "get_workspace_path", lambda: workspace)

    from mona.config import migrate_workspace_output as mwo
    monkeypatch.setattr(mwo, "get_workspace_path", lambda: workspace)
    monkeypatch.setattr(
        mwo,
        "get_shared_output_dir",
        lambda ws: ws / "output",
    )
    # Also patch the sync_global_templates call inside run_startup_migrations
    # so it doesn't try to write real bundled templates.
    import mona.utils.helpers as helpers_mod

    def _fake_sync(silent: bool = False) -> list[str]:
        (tmp_path / "memory").mkdir(parents=True, exist_ok=True)
        (tmp_path / "skills").mkdir(parents=True, exist_ok=True)
        return []

    monkeypatch.setattr(helpers_mod, "sync_global_templates", _fake_sync)
    return tmp_path


def _seed_legacy_workspace(ws: Path) -> None:
    """Write the legacy layout (pre-migration) into ws."""
    (ws / "AGENTS.md").write_text("legacy agents", encoding="utf-8")
    (ws / "SOUL.md").write_text("legacy soul", encoding="utf-8")
    (ws / "USER.md").write_text("legacy user", encoding="utf-8")
    (ws / "HEARTBEAT.md").write_text("heartbeat", encoding="utf-8")
    (ws / "memory").mkdir(exist_ok=True)
    (ws / "memory" / "MEMORY.md").write_text("legacy memory", encoding="utf-8")
    (ws / "memory" / "history.jsonl").write_text("[]", encoding="utf-8")
    (ws / "skills").mkdir(exist_ok=True)
    (ws / "skills" / "custom.py").write_text("# legacy skill", encoding="utf-8")
    # Loose artifacts that should be moved into output/
    (ws / "old_report.md").write_text("# old report", encoding="utf-8")
    (ws / "old_data").mkdir(exist_ok=True)
    (ws / "old_data" / "data.csv").write_text("a,b,c", encoding="utf-8")


def test_global_resources_moved_out_of_workspace(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)

    migrate_global_resources()

    # Source files should be gone (move semantics, not copy).
    assert not (ws / "AGENTS.md").exists()
    assert not (ws / "SOUL.md").exists()
    assert not (ws / "USER.md").exists()
    assert not (ws / "HEARTBEAT.md").exists()
    # memory/ and skills/ should be empty (or not exist).
    if (ws / "memory").exists():
        assert not any((ws / "memory").iterdir())
    if (ws / "skills").exists():
        assert not any((ws / "skills").iterdir())


def test_global_resources_landed_in_data_dir(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)

    migrate_global_resources()

    memory_dir = isolated_instance / "memory"
    assert (memory_dir / "AGENTS.md").read_text(encoding="utf-8") == "legacy agents"
    assert (memory_dir / "SOUL.md").read_text(encoding="utf-8") == "legacy soul"
    assert (memory_dir / "USER.md").read_text(encoding="utf-8") == "legacy user"
    assert (memory_dir / "MEMORY.md").read_text(encoding="utf-8") == "legacy memory"
    assert (isolated_instance / "skills" / "custom.py").exists()
    assert (isolated_instance / "HEARTBEAT.md").read_text(encoding="utf-8") == "heartbeat"


def test_manifest_records_moved_paths(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)

    migrate_global_resources()

    manifest_path = _manifest_path()
    assert manifest_path.exists()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["version"] == MIGRATION_VERSION
    assert manifest["global_resources_completed"] is True
    migrated_paths = [entry["src"] for entry in manifest["global_resources"]["migrated"]]
    assert str(ws / "AGENTS.md") in migrated_paths
    assert str(ws / "SOUL.md") in migrated_paths


def test_global_migration_is_idempotent(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)

    migrate_global_resources()
    manifest1 = json.loads(_manifest_path().read_text(encoding="utf-8"))
    migrated1 = len(manifest1["global_resources"]["migrated"])

    # Second run: no new migrations, manifest unchanged in size.
    migrate_global_resources()
    manifest2 = json.loads(_manifest_path().read_text(encoding="utf-8"))
    migrated2 = len(manifest2["global_resources"]["migrated"])
    assert migrated2 == migrated1


def test_conflict_backup_when_target_already_exists(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)
    # Pre-create a target file so the source must back up.
    (isolated_instance / "memory").mkdir(parents=True, exist_ok=True)
    (isolated_instance / "memory" / "AGENTS.md").write_text(
        "existing target", encoding="utf-8"
    )

    migrate_global_resources()

    manifest = json.loads(_manifest_path().read_text(encoding="utf-8"))
    conflicts = manifest["global_resources"]["conflicts"]
    conflict_names = [Path(c["src"]).name for c in conflicts]
    assert "AGENTS.md" in conflict_names
    # The existing target must NOT be overwritten.
    assert (
        (isolated_instance / "memory" / "AGENTS.md").read_text(encoding="utf-8")
        == "existing target"
    )
    # The source must have been moved to a backup location.
    backups_root = isolated_instance / "migration-backups" / MIGRATION_VERSION
    assert backups_root.exists()
    # Find the AGENTS.md backup anywhere under backups_root.
    found_backup = False
    for path in backups_root.rglob("AGENTS.md"):
        if not path.is_file():
            continue
        if path.read_text(encoding="utf-8") == "legacy agents":
            found_backup = True
            break
    assert found_backup, "conflicting source must be backed up"


def test_loose_artifacts_moved_into_output(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)
    # First run global resources so memory/skills go away, then loose.
    migrate_global_resources()
    migrate_workspace_output()

    output = ws / "output"
    assert (output / "old_report.md").read_text(encoding="utf-8") == "# old report"
    assert (output / "old_data" / "data.csv").read_text(encoding="utf-8") == "a,b,c"
    # Source paths should no longer be at the workspace root.
    assert not (ws / "old_report.md").exists()
    assert not (ws / "old_data").exists()


def test_reserved_top_level_entries_not_moved(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    # Create reserved entries that should stay put.
    (ws / "sessions").mkdir(exist_ok=True)
    (ws / "sessions" / "abc.jsonl").write_text("[]", encoding="utf-8")
    (ws / "cron").mkdir(exist_ok=True)
    (ws / "ppt_projects").mkdir(exist_ok=True)
    (ws / "video_projects").mkdir(exist_ok=True)
    # output/ itself is reserved (it's the target).
    (ws / "output").mkdir(exist_ok=True)
    (ws / "output" / "existing.md").write_text("pre-existing", encoding="utf-8")

    migrate_workspace_output()

    # Reserved entries must still be at the workspace root.
    assert (ws / "sessions").exists()
    assert (ws / "sessions" / "abc.jsonl").exists()
    assert (ws / "cron").exists()
    assert (ws / "ppt_projects").exists()
    assert (ws / "video_projects").exists()
    # Pre-existing output/ content must not be touched.
    assert (ws / "output" / "existing.md").read_text(encoding="utf-8") == "pre-existing"


def test_full_migration_marks_manifest_complete(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)

    run_startup_migrations()

    manifest = json.loads(_manifest_path().read_text(encoding="utf-8"))
    assert manifest["completed"] is True
    assert manifest["global_resources_completed"] is True
    assert manifest["loose_artifacts_completed"] is True


def test_full_migration_idempotent(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)

    run_startup_migrations()
    manifest1 = json.loads(_manifest_path().read_text(encoding="utf-8"))

    # Second run should not add migrated entries.
    run_startup_migrations()
    manifest2 = json.loads(_manifest_path().read_text(encoding="utf-8"))

    assert len(manifest2["global_resources"]["migrated"]) == len(
        manifest1["global_resources"]["migrated"]
    )
    assert len(manifest2["loose_artifacts"]["migrated"]) == len(
        manifest1["loose_artifacts"]["migrated"]
    )


def test_resolve_legacy_path_returns_new_path(isolated_instance: Path) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)

    run_startup_migrations()

    # Path resolution should map the old location to the new one.
    new = resolve_legacy_path(ws / "old_report.md")
    assert new is not None
    expected = (ws / "output" / "old_report.md").resolve()
    assert new.resolve() == expected


def test_git_repo_with_tracked_files_triggers_manual_required(
    isolated_instance: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = isolated_instance / "workspace"
    _seed_legacy_workspace(ws)
    # Simulate a Git repo with a tracked non-Mona file.
    (ws / ".git").mkdir(parents=True, exist_ok=True)
    (ws / "my_source.py").write_text("# user file", encoding="utf-8")

    def _fake_run(cmd: list[str], **kwargs: Any):
        class _R:
            returncode = 0
            stdout = "my_source.py\n"
            stderr = ""

        return _R()

    monkeypatch.setattr("subprocess.run", _fake_run)

    migrate_global_resources()  # global resources still migrate
    migrate_workspace_output()

    manifest = json.loads(_manifest_path().read_text(encoding="utf-8"))
    assert manifest["loose_artifacts"]["manual_required"] is True
    # The user file should NOT have been moved.
    assert (ws / "my_source.py").exists()


def test_reserved_top_level_set_is_stable() -> None:
    # Catch accidental drift in the reserved set.
    assert "output" in RESERVED_TOP_LEVEL
    assert "sessions" in RESERVED_TOP_LEVEL
    assert "ppt_projects" in RESERVED_TOP_LEVEL
    assert "video_projects" in RESERVED_TOP_LEVEL
    assert ".git" in RESERVED_TOP_LEVEL
    assert ".mona" in RESERVED_TOP_LEVEL
