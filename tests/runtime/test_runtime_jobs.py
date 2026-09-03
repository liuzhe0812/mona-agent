"""On-demand Python and Node runtime job tests."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from mona.runtime.catalog import RuntimeCatalog
from mona.runtime.jobs import (
    RuntimeAutoDownloadDisabledError,
    RuntimeInstallJobManager,
    RuntimeInstallUnavailableError,
)
from mona.runtime.manager import RuntimeComponentStore


def _catalog() -> RuntimeCatalog:
    return RuntimeCatalog.model_validate(
        {
            "schemaVersion": 1,
            "generatedAt": "2026-08-29T00:00:00Z",
            "components": [
                {
                    "schemaVersion": 1,
                    "id": "python-base",
                    "version": "3.13.15",
                    "kind": "python-runtime",
                    "downloadUrl": "https://cdn.example.test/python.zip",
                    "size": 20_000_000,
                    "sha256": "a" * 64,
                    "platforms": ["win32"],
                    "architectures": ["x64"],
                },
                {
                    "schemaVersion": 1,
                    "id": "node-base",
                    "version": "22.23.2",
                    "kind": "node-runtime",
                    "downloadUrl": "https://cdn.example.test/node.zip",
                    "size": 30_000_000,
                    "sha256": "b" * 64,
                    "platforms": ["win32"],
                    "architectures": ["x64"],
                },
            ],
        }
    )


class FakeCatalogClient:
    async def fetch(self) -> RuntimeCatalog:
        return _catalog()


class FakeInstaller:
    def __init__(self, wait: asyncio.Event | None = None) -> None:
        self.calls: list[list[str]] = []
        self.force_calls: list[bool] = []
        self.wait = wait

    async def ensure_packs(self, refs: list[str], progress=None, *, force: bool = False) -> None:
        self.calls.append(refs)
        self.force_calls.append(force)
        if progress:
            progress(refs[0], 10_000_000, 20_000_000)
        if self.wait is not None:
            await self.wait.wait()


class SerialInstaller(FakeInstaller):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.active = 0
        self.max_active = 0

    async def ensure_packs(self, refs: list[str], progress=None, *, force: bool = False) -> None:
        self.calls.append(refs)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.started.set()
        await self.release.wait()
        self.active -= 1


def _manager(
    tmp_path: Path,
    installer: object | None,
    *,
    auto_download: bool = True,
) -> RuntimeInstallJobManager:
    return RuntimeInstallJobManager(
        catalog_client=FakeCatalogClient(),  # type: ignore[arg-type]
        component_store=RuntimeComponentStore(tmp_path / "runtimes"),
        state_path=tmp_path / "jobs.json",
        installer=installer,  # type: ignore[arg-type]
        current_platform="win32",
        current_architecture="x64",
        auto_download_enabled=lambda: auto_download,
    )


async def test_runtime_status_exposes_optional_downloads(tmp_path: Path) -> None:
    manager = _manager(tmp_path, FakeInstaller())
    manager.migration_status = lambda: {
        "state": "completed",
        "legacyBytes": 10,
        "cleanupAvailable": True,
    }
    payload = await manager.status_payload()

    assert payload["installEnabled"] is True
    assert payload["autoDownload"] is True
    assert payload["migration"] == {
        "state": "completed",
        "legacyBytes": 10,
        "cleanupAvailable": True,
    }
    assert payload["components"] == [
        {
            "component": "python",
            "available": True,
            "packRef": "python-base@3.13.15",
            "version": "3.13.15",
            "downloadBytes": 20_000_000,
            "installed": False,
            "installedVersion": None,
            "updateAvailable": False,
        },
        {
            "component": "node",
            "available": True,
            "packRef": "node-base@22.23.2",
            "version": "22.23.2",
            "downloadBytes": 30_000_000,
            "installed": False,
            "installedVersion": None,
            "updateAvailable": False,
        },
    ]


async def test_runtime_job_installs_latest_compatible_pack(tmp_path: Path) -> None:
    installer = FakeInstaller()
    manager = _manager(tmp_path, installer)

    started = await manager.start("python")
    await manager._tasks[started.job_id]
    finished = manager.get(started.job_id)

    assert installer.calls == [["python-base@3.13.15"]]
    assert finished.state == "completed"
    assert finished.downloaded_bytes == finished.total_bytes == 20_000_000
    persisted = json.loads((tmp_path / "jobs.json").read_text(encoding="utf-8"))
    assert persisted["jobs"][0]["state"] == "completed"


async def test_runtime_repair_forces_same_version_redeployment(tmp_path: Path) -> None:
    installer = FakeInstaller()
    manager = _manager(tmp_path, installer)

    started = await manager.start("python", repair=True)
    await manager._tasks[started.job_id]

    assert started.repair is True
    assert installer.calls == [["python-base@3.13.15"]]
    assert installer.force_calls == [True]


async def test_runtime_job_can_be_cancelled(tmp_path: Path) -> None:
    manager = _manager(tmp_path, FakeInstaller(asyncio.Event()))
    started = await manager.start("node")
    await asyncio.sleep(0)

    cancelled = await manager.cancel(started.job_id)

    assert cancelled.state == "cancelled"


async def test_runtime_install_disabled_without_installer(tmp_path: Path) -> None:
    manager = _manager(tmp_path, None)

    with pytest.raises(RuntimeInstallUnavailableError, match="服务暂不可用"):
        await manager.start("python")


async def test_feature_download_respects_auto_download_setting(tmp_path: Path) -> None:
    manager = _manager(tmp_path, FakeInstaller(), auto_download=False)

    with pytest.raises(RuntimeAutoDownloadDisabledError, match="功能资源"):
        await manager.ensure("python")

    assert manager.list() == []


async def test_duplicate_runtime_requests_share_one_job(tmp_path: Path) -> None:
    wait = asyncio.Event()
    installer = FakeInstaller(wait)
    manager = _manager(tmp_path, installer)

    first = await manager.start("python")
    second = await manager.start("python")
    wait.set()
    await manager._tasks[first.job_id]

    assert first.job_id == second.job_id
    assert installer.calls == [["python-base@3.13.15"]]


async def test_runtime_install_jobs_run_serially(tmp_path: Path) -> None:
    installer = SerialInstaller()
    manager = _manager(tmp_path, installer)

    first = await manager.start("python")
    second = await manager.start("node")
    await installer.started.wait()
    await asyncio.sleep(0)

    assert manager.get(first.job_id).state == "running"
    assert manager.get(second.job_id).state == "queued"
    installer.release.set()
    await asyncio.gather(manager._tasks[first.job_id], manager._tasks[second.job_id])
    assert installer.max_active == 1


def test_cleanup_removes_download_cache(tmp_path: Path) -> None:
    manager = _manager(tmp_path, FakeInstaller())
    manager.cleanup_legacy = lambda: {"removedLegacyBytes": 5}
    manager.cache_dir.mkdir(parents=True)
    (manager.cache_dir / "python.zip").write_bytes(b"zip")
    (manager.cache_dir / "python.zip.part").write_bytes(b"part")

    result = manager.cleanup()

    assert result == {
        "removedDownloads": 2,
        "removedVersions": 0,
        "freedBytes": 7,
        "removedLegacyBytes": 5,
    }
