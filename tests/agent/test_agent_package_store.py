"""Versioned downloadable Agent package store contracts."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from mona.agent.package_store import (
    AgentPackageError,
    AgentPackageStore,
    ExpertCatalog,
    sha256_file,
)
from mona.agent.partners import AgentRegistry
from mona.agent.user_config import load_agent_user_config, resolve_effective_agent_config

AGENT_ID = "com.example.downloaded-expert"


def _package_files(
    version: str,
    *,
    prompt: str = "You are an expert.",
    avatar: str | None = None,
) -> dict[str, str]:
    agent = {
        "schemaVersion": 1,
        "id": AGENT_ID,
        "displayName": "Downloaded Expert",
        "prompt": "prompt.md",
        "toolAllowlist": ["read_file"],
        "skills": ["skills/research"],
        "packageId": AGENT_ID,
        "packageVersion": version,
        "visibility": "partner",
    }
    files = {
        f"{AGENT_ID}/agent.json": json.dumps(agent),
        f"{AGENT_ID}/package-manifest.json": json.dumps(
            {
                "schemaVersion": 1,
                "agentId": AGENT_ID,
                "version": version,
                "requiredTools": ["read_file"],
                "runtimePacks": ["python-base@3.12"],
            }
        ),
        f"{AGENT_ID}/prompt.md": prompt,
        f"{AGENT_ID}/skills/research/SKILL.md": (
            "---\nname: research\ndescription: Test research skill.\n---\n# Research\n"
        ),
    }
    if avatar is not None:
        agent["avatar"] = "avatar.png"
        files[f"{AGENT_ID}/agent.json"] = json.dumps(agent)
        files[f"{AGENT_ID}/avatar.png"] = avatar
    return files


def _write_archive(path: Path, files: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, content in files.items():
            bundle.writestr(name, content)
    return path


def _install(store: AgentPackageStore, archive: Path, version: str):
    return store.install_archive(
        archive,
        expected_sha256=sha256_file(archive),
        expected_agent_id=AGENT_ID,
        expected_version=version,
    )


def test_install_activate_and_registry_load(tmp_path: Path) -> None:
    store_root = tmp_path / "packages" / "agents"
    store = AgentPackageStore(store_root, known_tool_names={"read_file"})
    archive = _write_archive(tmp_path / "expert.zip", _package_files("1.0.0"))

    installed = _install(store, archive, "1.0.0")

    assert installed.activated is True
    assert installed.package_root == (store_root / AGENT_ID / "v" / "1.0.0" / "p")
    pointer, package_root = store.active(AGENT_ID) or (None, None)
    assert pointer is not None
    assert pointer.version == "1.0.0"
    assert package_root == installed.package_root

    registry = AgentRegistry(
        builtin_dir=tmp_path / "no-builtin",
        installed_dir=tmp_path / "no-legacy",
        package_store_dir=store_root,
        known_tool_names={"read_file"},
    )
    definition = registry.require(AGENT_ID)
    assert definition.package_version == "1.0.0"
    assert registry.load_prompt(AGENT_ID) == "You are an expert."
    assert [path.name for path in registry.resolve_skill_dirs(AGENT_ID)] == ["research"]


def test_registry_reload_sees_newly_activated_package(tmp_path: Path) -> None:
    store_root = tmp_path / "packages" / "agents"
    registry = AgentRegistry(
        builtin_dir=tmp_path / "no-builtin",
        installed_dir=tmp_path / "no-legacy",
        package_store_dir=store_root,
    )
    assert registry.get(AGENT_ID) is None
    archive = _write_archive(tmp_path / "expert.zip", _package_files("1.0.0"))
    _install(AgentPackageStore(store_root), archive, "1.0.0")

    registry.reload()

    assert registry.require(AGENT_ID).package_version == "1.0.0"


def test_install_new_version_and_rollback_keeps_private_data(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store_root = tmp_path / "packages" / "agents"
    private_root = tmp_path / "agents" / AGENT_ID
    private_root.mkdir(parents=True)
    private_file = private_root / "memory" / "MEMORY.md"
    private_file.parent.mkdir()
    private_file.write_text("user-owned memory", encoding="utf-8")
    user_avatar = "data:image/png;base64,iVBORw0KGgo="
    private_config = private_root / "config.json"
    private_config.write_text(
        json.dumps({"schemaVersion": 1, "revision": 1, "avatar": user_avatar}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "mona.agent.user_config.get_agent_user_config_path",
        lambda _agent_id: private_config,
    )
    store = AgentPackageStore(store_root)

    first = _write_archive(
        tmp_path / "v1.zip",
        _package_files("1.0.0", avatar="package avatar v1"),
    )
    second = _write_archive(
        tmp_path / "v2.zip",
        _package_files(
            "1.1.0",
            prompt="You are the updated expert.",
            avatar="package avatar v2",
        ),
    )
    _install(store, first, "1.0.0")
    _install(store, second, "1.1.0")
    assert store.active(AGENT_ID)[0].version == "1.1.0"  # type: ignore[index]

    registry = AgentRegistry(
        builtin_dir=tmp_path / "no-builtin",
        installed_dir=tmp_path / "no-legacy",
        package_store_dir=store_root,
    )
    effective = resolve_effective_agent_config(
        registry.require(AGENT_ID),
        load_agent_user_config(AGENT_ID),
    )
    assert effective.avatar == user_avatar

    store.activate(AGENT_ID, "1.0.0")

    assert store.active(AGENT_ID)[0].version == "1.0.0"  # type: ignore[index]
    assert private_file.read_text(encoding="utf-8") == "user-owned memory"
    assert json.loads(private_config.read_text(encoding="utf-8"))["avatar"] == user_avatar
    assert (store_root / AGENT_ID / "v" / "1.1.0" / "p").is_dir()


def test_rejects_hash_mismatch_before_install(tmp_path: Path) -> None:
    archive = _write_archive(tmp_path / "expert.zip", _package_files("1.0.0"))
    store = AgentPackageStore(tmp_path / "store")

    with pytest.raises(AgentPackageError, match="sha256 mismatch"):
        store.install_archive(
            archive,
            expected_sha256="0" * 64,
            expected_agent_id=AGENT_ID,
            expected_version="1.0.0",
        )

    assert not (tmp_path / "store" / AGENT_ID / "current.json").exists()


def test_rejects_path_traversal_archive(tmp_path: Path) -> None:
    archive = tmp_path / "escape.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(f"{AGENT_ID}/agent.json", "{}")
        bundle.writestr("../escape.txt", "escaped")
    store = AgentPackageStore(tmp_path / "store")

    with pytest.raises(AgentPackageError, match="unsafe archive path"):
        _install(store, archive, "1.0.0")

    assert not (tmp_path / "escape.txt").exists()
    assert not (tmp_path / "store" / AGENT_ID / "current.json").exists()


def test_same_version_is_immutable(tmp_path: Path) -> None:
    store = AgentPackageStore(tmp_path / "store")
    first = _write_archive(tmp_path / "first.zip", _package_files("1.0.0"))
    changed = _write_archive(
        tmp_path / "changed.zip",
        _package_files("1.0.0", prompt="Different bytes for the same version."),
    )
    _install(store, first, "1.0.0")

    with pytest.raises(AgentPackageError, match="immutable package version"):
        _install(store, changed, "1.0.0")

    assert store.active(AGENT_ID)[0].sha256 == sha256_file(first)  # type: ignore[index]


def test_prune_keeps_active_and_newest_rebuildable_versions(tmp_path: Path) -> None:
    store_root = tmp_path / "store"
    store = AgentPackageStore(store_root)
    for version in ("1.0.0", "1.1.0", "1.2.0"):
        archive = _write_archive(tmp_path / f"{version}.zip", _package_files(version))
        _install(store, archive, version)
    store.activate(AGENT_ID, "1.0.0")

    removed = store.prune_inactive(AGENT_ID, keep=1)

    assert removed == ["1.1.0"]
    assert store.active(AGENT_ID)[0].version == "1.0.0"  # type: ignore[index]
    assert (store_root / AGENT_ID / "v" / "1.2.0").is_dir()


def test_corrupt_active_pointer_is_ignored(tmp_path: Path) -> None:
    store_root = tmp_path / "store"
    pointer = store_root / AGENT_ID / "current.json"
    pointer.parent.mkdir(parents=True)
    pointer.write_text("not-json", encoding="utf-8")

    store = AgentPackageStore(store_root)

    assert store.active(AGENT_ID) is None
    assert list(store.iter_active_package_roots()) == []


def test_expert_catalog_rejects_duplicate_identity() -> None:
    entry = {
        "schemaVersion": 1,
        "id": AGENT_ID,
        "displayName": "Expert",
        "version": "1.0.0",
        "downloadUrl": "https://downloads.example.test/expert.zip",
        "size": 100,
        "sha256": "a" * 64,
        "runtimePacks": ["python-base@3.12"],
        "requiredTools": ["read_file"],
    }

    with pytest.raises(ValueError, match="duplicate expert catalog entry"):
        ExpertCatalog.model_validate(
            {
                "schemaVersion": 1,
                "generatedAt": "2026-08-29T00:00:00Z",
                "experts": [entry, entry],
            }
        )


def test_expert_catalog_rejects_untrusted_runtime_pack_url() -> None:
    with pytest.raises(ValueError, match="invalid runtime pack reference"):
        ExpertCatalog.model_validate(
            {
                "schemaVersion": 1,
                "generatedAt": "2026-08-29T00:00:00Z",
                "experts": [
                    {
                        "schemaVersion": 1,
                        "id": AGENT_ID,
                        "displayName": "Expert",
                        "version": "1.0.0",
                        "downloadUrl": "https://downloads.example.test/expert.zip",
                        "size": 100,
                        "sha256": "a" * 64,
                        "runtimePacks": ["https://untrusted.example/package.whl"],
                    }
                ],
            }
        )
