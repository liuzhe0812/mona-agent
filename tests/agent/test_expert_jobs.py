"""Expert catalog and background install job contracts."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.agent.expert_catalog import ExpertCatalogSnapshot
from mona.agent.expert_installer import ExpertInstallProgress
from mona.agent.expert_jobs import (
    ExpertInstallJobManager,
    ExpertInstallUnavailableError,
)
from mona.agent.package_store import AgentPackageStore, ExpertCatalog


def _snapshot() -> ExpertCatalogSnapshot:
    catalog = ExpertCatalog.model_validate(
        {
            "schemaVersion": 1,
            "generatedAt": "2026-08-29T00:00:00Z",
            "experts": [
                {
                    "schemaVersion": 1,
                    "id": "com.mona.researcher",
                    "displayName": "科研专家",
                    "description": "检索与分析科研文献",
                    "version": "2.0.0",
                    "downloadUrl": "https://cdn.example.test/researcher.zip",
                    "size": 1024,
                    "sha256": "a" * 64,
                    "runtimePacks": ["python-base@3.12", "scientific@1"],
                },
                {
                    "schemaVersion": 1,
                    "id": "com.mona.researcher",
                    "displayName": "科研专家",
                    "version": "1.0.0",
                    "downloadUrl": "https://cdn.example.test/researcher-v1.zip",
                    "size": 512,
                    "sha256": "b" * 64,
                },
            ],
        }
    )
    return ExpertCatalogSnapshot(
        catalog=catalog,
        source="cache",
        source_url="https://cdn.example.test/catalog.json",
        fetched_at="2026-08-29T00:00:00Z",
        stale=True,
    )


class FakeCatalogClient:
    async def fetch(self) -> ExpertCatalogSnapshot:
        return _snapshot()


class FakeInstaller:
    def compatibility_error(self, _entry):
        return None

    async def install(self, expert_id: str, *, version=None, progress=None):
        assert expert_id == "com.mona.researcher"
        if progress:
            progress(ExpertInstallProgress("downloading", 512, 1024))
            progress(ExpertInstallProgress("ready", 1024, 1024))
        return SimpleNamespace(
            cached_download=False,
            entry=SimpleNamespace(version=version or "2.0.0"),
        )


def _manager(tmp_path: Path, installer: object | None) -> ExpertInstallJobManager:
    return ExpertInstallJobManager(
        catalog_client=FakeCatalogClient(),  # type: ignore[arg-type]
        package_store=AgentPackageStore(tmp_path / "packages"),
        state_path=tmp_path / "jobs.json",
        installer=installer,  # type: ignore[arg-type]
        installed_definition=lambda expert_id: (
            SimpleNamespace(package_version="1.0.0") if expert_id == "com.mona.researcher" else None
        ),
    )


async def test_catalog_returns_latest_version_and_install_state(tmp_path: Path) -> None:
    payload = await _manager(tmp_path, FakeInstaller()).catalog_payload()

    assert payload["stale"] is True
    assert payload["installEnabled"] is True
    assert payload["experts"] == [
        {
            "id": "com.mona.researcher",
            "displayName": "科研专家",
            "description": "检索与分析科研文献",
            "version": "2.0.0",
            "minMonaVersion": None,
            "downloadBytes": 1024,
            "runtimePacks": ["python-base@3.12", "scientific@1"],
            "requiredTools": [],
            "installed": True,
            "installedVersion": "1.0.0",
            "updateAvailable": True,
            "compatible": True,
            "unavailableReason": None,
        }
    ]


async def test_background_install_reports_progress_and_persists(tmp_path: Path) -> None:
    manager = _manager(tmp_path, FakeInstaller())

    started = manager.start("com.mona.researcher")
    await manager._tasks[started.job_id]
    finished = manager.get(started.job_id)

    assert finished.state == "completed"
    assert finished.stage == "ready"
    assert finished.downloaded_bytes == 1024
    assert finished.total_bytes == 1024
    assert finished.installed_version == "2.0.0"
    persisted = json.loads((tmp_path / "jobs.json").read_text(encoding="utf-8"))
    assert persisted["jobs"][0]["state"] == "completed"


def test_install_is_disabled_without_installer(tmp_path: Path) -> None:
    manager = _manager(tmp_path, None)

    with pytest.raises(ExpertInstallUnavailableError, match="服务暂不可用"):
        manager.start("com.mona.researcher")


async def test_cancelled_install_reaches_terminal_state(tmp_path: Path) -> None:
    gate = asyncio.Event()

    class WaitingInstaller:
        async def install(self, *_args, **_kwargs):
            await gate.wait()

    manager = _manager(tmp_path, WaitingInstaller())
    started = manager.start("com.mona.researcher")
    await asyncio.sleep(0)

    cancelled = await manager.cancel(started.job_id)

    assert cancelled.state == "cancelled"
    assert cancelled.finished_at is not None
