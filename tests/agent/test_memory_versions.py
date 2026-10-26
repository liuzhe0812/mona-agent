"""Legacy memory history becomes a bounded, per-file safety copy."""

import os
import subprocess
from pathlib import Path

import pytest
from dulwich import porcelain
from dulwich.repo import Repo

from mona.agent.memory_versions import migrate_legacy_memory_versions, write_text_atomic
from mona.utils.gitstore import GitStore
from mona.utils.prompt_templates import persona_content


def _store(root: Path, *, soul: str = "soul zero", memory: str = "memory zero") -> GitStore:
    root.mkdir()
    (root / "SOUL.md").write_text(soul, encoding="utf-8")
    (root / "MEMORY.md").write_text(memory, encoding="utf-8")
    store = GitStore(root, ["SOUL.md", "MEMORY.md", "USER.md", "AGENTS.md", ".dream_cursor"])
    assert store.init()
    return store


def _commit(root: Path, store: GitStore, **changes: str) -> None:
    for name, content in changes.items():
        (root / name).write_text(content, encoding="utf-8")
    assert store.auto_commit("dream: updated private memory")


def _current(root: Path) -> dict[str, str]:
    return {name: (root / name).read_text(encoding="utf-8") for name in ("SOUL.md", "MEMORY.md")}


def test_migration_keeps_only_the_latest_different_version_per_file(tmp_path: Path):
    root = tmp_path / "memory"
    store = _store(root)
    _commit(root, store, **{"SOUL.md": "soul one", "MEMORY.md": "memory one"})
    _commit(root, store, **{"MEMORY.md": "memory two"})
    _commit(root, store, **{".dream_cursor": "42", "USER.md": "private user data"})
    (root / "history.jsonl").write_text("history remains", encoding="utf-8")
    originals = {path.name: path.read_bytes() for path in root.iterdir() if path.is_file() and path.name != ".gitignore"}

    migrate_legacy_memory_versions(root, _current(root))

    assert (root / "SOUL.md.previous").read_text(encoding="utf-8") == "soul zero"
    assert (root / "MEMORY.md.previous").read_text(encoding="utf-8") == "memory one"
    assert not (root / ".git").exists()
    assert not (root / ".gitignore").exists()
    assert {name: (root / name).read_bytes() for name in originals} == originals
    after = {path.name: path.read_bytes() for path in root.iterdir()}
    migrate_legacy_memory_versions(root, _current(root))
    assert {path.name: path.read_bytes() for path in root.iterdir()} == after


def test_existing_previous_copy_is_not_overwritten(tmp_path: Path):
    root = tmp_path / "memory"
    store = _store(root)
    _commit(root, store, **{"SOUL.md": "soul one"})
    (root / "SOUL.md.previous").write_text("already retained", encoding="utf-8")
    (root / "SOUL.md").write_text("uncommitted current", encoding="utf-8")

    migrate_legacy_memory_versions(root, _current(root))

    assert (root / "SOUL.md.previous").read_text(encoding="utf-8") == "already retained"
    assert (root / "SOUL.md").read_text(encoding="utf-8") == "uncommitted current"
    assert not (root / ".git").exists()


def test_legacy_rules_are_part_of_the_retained_persona(tmp_path: Path):
    root = tmp_path / "memory"
    root.mkdir()
    (root / "AGENTS.md").write_text("old rules", encoding="utf-8")
    (root / "MEMORY.md").write_text("memory", encoding="utf-8")
    store = GitStore(root, ["AGENTS.md", "MEMORY.md"])
    assert store.init()
    _commit(root, store, **{"AGENTS.md": "new rules"})
    current = {"SOUL.md": persona_content("", "new rules"), "MEMORY.md": "memory"}

    migrate_legacy_memory_versions(root, current)

    assert (root / "SOUL.md.previous").read_text(encoding="utf-8") == persona_content("", "old rules")
    assert not (root / "SOUL.md").exists()
    assert (root / "AGENTS.md").read_text(encoding="utf-8") == "new rules"


def test_regular_user_repository_is_not_deleted(tmp_path: Path):
    root = tmp_path / "memory"
    root.mkdir()
    porcelain.init(str(root))
    (root / "SOUL.md").write_text("my persona", encoding="utf-8")
    porcelain.add(str(root), paths=["SOUL.md"])
    porcelain.commit(str(root), message=b"personal repository", author=b"User <user@example.test>")

    migrate_legacy_memory_versions(root, {"SOUL.md": "my persona"})

    assert (root / ".git").is_dir()
    assert not list(root.glob("*.previous"))


def test_empty_user_repository_is_not_deleted(tmp_path: Path):
    root = tmp_path / "memory"
    root.mkdir()
    porcelain.init(str(root))

    migrate_legacy_memory_versions(root, {})

    assert (root / ".git").is_dir()


def test_user_managed_references_are_not_deleted(tmp_path: Path):
    root = tmp_path / "memory"
    _store(root)
    with Repo(str(root)) as repo:
        repo.refs[b"refs/heads/saved-by-user"] = repo.head()

    migrate_legacy_memory_versions(root, _current(root))

    assert (root / ".git").is_dir()


def test_repository_with_non_memory_files_is_not_deleted(tmp_path: Path):
    root = tmp_path / "memory"
    root.mkdir()
    store = GitStore(root, ["SOUL.md", "MEMORY.md", "user-notes.txt"])
    assert store.init()
    (root / "SOUL.md").write_text("current persona", encoding="utf-8")
    assert store.auto_commit("manual edit")

    migrate_legacy_memory_versions(root, _current(root))

    assert (root / ".git").is_dir()
    assert not list(root.glob("*.previous"))


def test_parent_repository_is_not_touched(tmp_path: Path):
    porcelain.init(str(tmp_path))
    root = tmp_path / "memory"
    root.mkdir()

    migrate_legacy_memory_versions(root, {})

    assert (tmp_path / ".git").is_dir()
    assert not (root / ".git").exists()


def test_linked_git_directory_is_not_touched(tmp_path: Path):
    outside = tmp_path / "outside"
    _store(outside)
    root = tmp_path / "memory"
    root.mkdir()
    try:
        (root / ".git").symlink_to(outside / ".git", target_is_directory=True)
    except OSError:
        if os.name != "nt":
            pytest.skip("directory symlinks are unavailable")
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(root / ".git"), str(outside / ".git")],
            check=True,
            capture_output=True,
        )

    migrate_legacy_memory_versions(root, {})

    assert (root / ".git").resolve() == (outside / ".git").resolve()
    assert (outside / ".git").is_dir()


def test_git_file_and_edited_ignore_are_preserved(tmp_path: Path):
    linked = tmp_path / "linked"
    linked.mkdir()
    (linked / ".git").write_text("gitdir: ../some-repo", encoding="utf-8")
    migrate_legacy_memory_versions(linked, {})
    assert (linked / ".git").read_text(encoding="utf-8") == "gitdir: ../some-repo"

    root = tmp_path / "memory"
    _store(root)
    (root / ".gitignore").write_text("my own ignore rules", encoding="utf-8")
    migrate_legacy_memory_versions(root, _current(root))
    assert not (root / ".git").exists()
    assert (root / ".gitignore").read_text(encoding="utf-8") == "my own ignore rules"


def test_failed_atomic_replace_preserves_original_and_removes_temporary_file(tmp_path: Path, monkeypatch):
    path = tmp_path / "MEMORY.md.previous"
    path.write_text("original", encoding="utf-8")

    def fail_replace(*_args):
        raise PermissionError("file is busy")

    monkeypatch.setattr("mona.agent.memory_versions.os.replace", fail_replace)
    with pytest.raises(PermissionError, match="file is busy"):
        write_text_atomic(path, "replacement")
    assert path.read_text(encoding="utf-8") == "original"
    assert sorted(item.name for item in tmp_path.iterdir()) == [path.name]


def test_failed_backup_preserves_the_legacy_repository(tmp_path: Path, monkeypatch):
    root = tmp_path / "memory"
    store = _store(root)
    _commit(root, store, **{"SOUL.md": "current persona"})

    def fail_replace(*_args):
        raise PermissionError("backup could not be saved")

    monkeypatch.setattr("mona.agent.memory_versions.os.replace", fail_replace)
    with pytest.raises(PermissionError, match="backup could not be saved"):
        migrate_legacy_memory_versions(root, _current(root))
    assert (root / ".git").is_dir()
    assert (root / "SOUL.md").read_text(encoding="utf-8") == "current persona"
    assert not list(root.glob("*.previous"))
