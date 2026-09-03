"""Deterministic official server repository builder tests."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

from mona.agent.package_store import AgentPackageStore
from mona.runtime.manager import RuntimeComponentStore
from scripts.build_official_distribution import (
    build_expert_repository,
    build_runtime_repository,
)


def test_builds_deterministic_installable_expert(tmp_path: Path) -> None:
    source_root = tmp_path / "sources"
    source = source_root / "com.example.researcher"
    source.mkdir(parents=True)
    (source / "package-manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "agentId": "com.example.researcher",
                "version": "1.0.0",
                "requiredTools": ["read_file"],
                "runtimePacks": [],
            }
        ),
        encoding="utf-8",
    )
    (source / "agent.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "id": "com.example.researcher",
                "displayName": "Researcher",
                "prompt": "prompt.md",
                "toolAllowlist": ["read_file"],
                "skills": [],
                "packageId": "com.example.researcher",
                "packageVersion": "1.0.0",
            }
        ),
        encoding="utf-8",
    )
    (source / "prompt.md").write_text("Research carefully.", encoding="utf-8")
    ignored = source / "__pycache__"
    ignored.mkdir()
    (ignored / "fixture.pyc").write_bytes(b"ignored")
    first = tmp_path / "first"
    second = tmp_path / "second"

    first_catalog = build_expert_repository(
        source_root,
        first,
        base_url="https://cdn.example.test",
    )
    build_expert_repository(
        source_root,
        second,
        base_url="https://cdn.example.test",
    )

    first_archive = first / "experts/agents/com.example.researcher/1.0.0.zip"
    second_archive = second / "experts/agents/com.example.researcher/1.0.0.zip"
    assert first_archive.read_bytes() == second_archive.read_bytes()
    with zipfile.ZipFile(first_archive) as bundle:
        assert not any("__pycache__" in name for name in bundle.namelist())
    entry = first_catalog["experts"][0]
    assert "signature" not in entry
    installed = AgentPackageStore(tmp_path / "installed").install_archive(
        first_archive,
        expected_sha256=entry["sha256"],
        expected_agent_id=entry["id"],
        expected_version=entry["version"],
    )
    assert installed.activated is True


def test_builds_installable_runtime_without_signing_key(tmp_path: Path) -> None:
    source = tmp_path / "runtime-sources" / "python-base" / "3.13"
    source.mkdir(parents=True)
    (source / "runtime-manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "id": "python-base",
                "version": "3.13",
                "kind": "python-runtime",
                "entrypoints": {"python": "python.exe"},
            }
        ),
        encoding="utf-8",
    )
    (source / "distribution.json").write_text(
        json.dumps({"platforms": ["win32"], "architectures": ["x64"]}),
        encoding="utf-8",
    )
    (source / "python.exe").write_bytes(b"fixture executable")
    output = tmp_path / "output"

    catalog = build_runtime_repository(
        tmp_path / "runtime-sources",
        output,
        base_url="https://cdn.example.test",
    )

    archive = output / "runtimes/components/python-base/3.13.zip"
    entry = catalog["components"][0]
    assert "signature" not in entry
    manifest = RuntimeComponentStore(tmp_path / "installed-runtimes").install_archive(
        archive
    )
    assert manifest.id == "python-base"
    assert entry["sha256"]
