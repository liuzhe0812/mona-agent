"""Managed runtime component store and resolver contracts."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from mona.runtime.manager import (
    RuntimeComponentStore,
    RuntimeManagerError,
)


def _runtime_archive(
    path: Path,
    *,
    component_id: str,
    version: str,
    entrypoints: dict[str, str] | None = None,
) -> Path:
    entrypoints = entrypoints or {}
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": component_id,
                    "version": version,
                    "kind": "runtime" if entrypoints else "pack",
                    "entrypoints": entrypoints,
                }
            ),
        )
        for relative in entrypoints.values():
            bundle.writestr(relative, "runtime executable fixture")
    return path


def test_installs_and_activates_runtime_components(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    store = RuntimeComponentStore(root)
    store.install_archive(
        _runtime_archive(
            tmp_path / "python.zip",
            component_id="python-base",
            version="3.12",
            entrypoints={"python": "bin/python.exe"},
        )
    )
    store.install_archive(
        _runtime_archive(
            tmp_path / "scientific.zip",
            component_id="scientific",
            version="1",
        )
    )

    python = store.active("python-base")
    scientific = store.active("scientific")
    assert python is not None
    assert scientific is not None
    assert python[1] / "bin" / "python.exe" == (
        root / "components" / "python-base" / "versions" / "3.12" / "bin" / "python.exe"
    )


def test_runtime_archive_rejects_path_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "escape.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": "python-base",
                    "version": "3.12",
                    "kind": "runtime",
                    "entrypoints": {"python": "bin/python.exe"},
                }
            ),
        )
        bundle.writestr("../escape.exe", "escape")

    with pytest.raises(ValueError, match="unsafe runtime path"):
        RuntimeComponentStore(tmp_path / "runtimes").install_archive(archive)

    assert not (tmp_path / "escape.exe").exists()


def test_runtime_archive_requires_declared_entrypoint(tmp_path: Path) -> None:
    archive = tmp_path / "missing.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": "node-base",
                    "version": "22",
                    "kind": "runtime",
                    "entrypoints": {"node": "bin/node.exe"},
                }
            ),
        )

    with pytest.raises(RuntimeManagerError, match="entrypoint is missing"):
        RuntimeComponentStore(tmp_path / "runtimes").install_archive(archive)


def test_same_runtime_version_is_immutable(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    store = RuntimeComponentStore(root)
    first = _runtime_archive(
        tmp_path / "first.zip",
        component_id="scientific",
        version="1",
    )
    changed = tmp_path / "changed.zip"
    with zipfile.ZipFile(changed, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": "scientific",
                    "version": "1",
                    "kind": "pack",
                    "entrypoints": {},
                }
            ),
        )
        bundle.writestr("extra.txt", "different payload")
    store.install_archive(first)

    with pytest.raises(RuntimeManagerError, match="already differs"):
        store.install_archive(changed)


def test_runtime_prune_keeps_active_and_newest_versions(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    store = RuntimeComponentStore(root)
    for version in ("1", "2", "3"):
        store.install_archive(
            _runtime_archive(
                tmp_path / f"scientific-{version}.zip",
                component_id="scientific",
                version=version,
            )
        )
    store.activate("scientific", "1")

    removed = store.prune_inactive("scientific", keep=1)

    assert removed == ["2"]
    assert store.active("scientific")[0].version == "1"  # type: ignore[index]
    assert (root / "components" / "scientific" / "versions" / "3").is_dir()
