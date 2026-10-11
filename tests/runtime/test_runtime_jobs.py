"""On-demand Python and Node runtime job tests."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import sys
import zipfile
from pathlib import Path

import httpx
import pytest

from mona.runtime import jobs as runtime_jobs
from mona.runtime.catalog import RuntimeCatalog, RuntimeCatalogClient, RuntimeInstaller
from mona.runtime.download import VerifiedDownloader
from mona.runtime.executors import managed_executor_path
from mona.runtime.jobs import (
    RuntimeAutoDownloadDisabledError,
    RuntimeInstallJob,
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


class SlowCatalogClient:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def fetch(self) -> RuntimeCatalog:
        self.started.set()
        await self.release.wait()
        return _catalog()


class ResourceCatalogClient:
    def __init__(self, client: RuntimeCatalogClient) -> None:
        self.client = client
        self.resources: list[str] = []

    async def fetch(self) -> RuntimeCatalog:
        return await self.client.fetch()

    async def fetch_resource(self, resource: str) -> RuntimeCatalog:
        self.resources.append(resource)
        return await self.client.fetch()


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
    assert payload["catalogAvailable"] is True
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
            "availableLocally": False,
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
            "availableLocally": False,
            "updateAvailable": False,
        },
    ]


async def test_runtime_status_recognizes_a_compatible_local_resource(tmp_path: Path) -> None:
    manager = _manager(tmp_path, FakeInstaller())
    manager.local_component_available = lambda component: component == "python"

    payload = await manager.status_payload()

    components = {item["component"]: item for item in payload["components"]}
    assert components["python"]["installed"] is False
    assert components["python"]["availableLocally"] is True
    assert components["node"]["availableLocally"] is False


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


@pytest.mark.parametrize(
    ("executor", "component_id", "kind"),
    [
        ("codex", "codex-cli", "codex-runtime"),
        ("claude", "claude-code-cli", "claude-code-runtime"),
        ("codebuddy", "codebuddy-cli", "codebuddy-runtime"),
    ],
)
async def test_executor_jobs_install_through_shared_runtime_pipeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    executor: str,
    component_id: str,
    kind: str,
) -> None:
    import mona.runtime.catalog as catalog_module
    import mona.runtime.download as download_module

    monkeypatch.setattr(catalog_module, "validate_url_target", lambda _url: (True, ""))
    monkeypatch.setattr(download_module, "validate_url_target", lambda _url: (True, ""))
    version = "1.0.0+test"
    entrypoint = f"bin/{executor}.exe" if sys.platform == "win32" else f"bin/{executor}"
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": component_id,
                    "version": version,
                    "kind": kind,
                    "entrypoints": {executor: entrypoint, "metadata": "executor.json"},
                }
            ),
        )
        archive.writestr(entrypoint, "synthetic fixture executable")
        archive.writestr(
            "executor.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "executor": executor,
                    "platform": sys.platform,
                    "architecture": runtime_jobs._architecture(),
                }
            ),
        )
    archive_bytes = payload.getvalue()
    catalog = {
        "schemaVersion": 1,
        "generatedAt": "2026-10-08T00:00:00Z",
        "components": [
            {
                "schemaVersion": 1,
                "id": component_id,
                "version": version,
                "kind": kind,
                "downloadUrl": f"https://cdn.example.test/{component_id}.zip",
                "size": len(archive_bytes),
                "sha256": hashlib.sha256(archive_bytes).hexdigest(),
                "platforms": [sys.platform],
                "architectures": [runtime_jobs._architecture()],
            }
        ],
    }

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/catalog.json":
            return httpx.Response(200, json=catalog, request=request)
        return httpx.Response(200, content=archive_bytes, request=request)

    transport = httpx.MockTransport(respond)
    runtime_catalog = RuntimeCatalogClient(
        ["https://cdn.example.test/catalog.json"],
        tmp_path / "catalog.json",
        transport=transport,
    )
    resource_catalog = ResourceCatalogClient(runtime_catalog)
    store = RuntimeComponentStore(tmp_path / "runtimes")
    installer = RuntimeInstaller(
        catalog_client=runtime_catalog,
        downloader=VerifiedDownloader(transport=transport),
        store=store,
        cache_dir=tmp_path / "downloads",
        current_platform=sys.platform,
        current_architecture=runtime_jobs._architecture(),
    )
    manager = RuntimeInstallJobManager(
        catalog_client=resource_catalog,  # type: ignore[arg-type]
        component_store=store,
        state_path=tmp_path / "jobs.json",
        installer=installer,
        current_platform=sys.platform,
        current_architecture=runtime_jobs._architecture(),
    )

    started = await manager.start(executor)
    await manager._tasks[started.job_id]
    finished = manager.get(started.job_id)
    pack_ref = f"{component_id}@{version}"

    assert resource_catalog.resources == [executor]
    assert started.pack_refs == [pack_ref]
    assert finished.state == "completed"
    assert store.active(component_id) is not None
    assert managed_executor_path(executor, store) == store.active(component_id)[1] / entrypoint  # type: ignore[index]

    exact = await manager.ensure_packs(executor, [pack_ref])
    assert exact.state == "completed"


def test_runtime_jobs_recover_legacy_cli_installs(tmp_path: Path) -> None:
    legacy_cli_job = RuntimeInstallJob(
        jobId="legacy-cli",
        component="codex",
        packRef="codex-cli@0.147.0",
        state="queued",
        createdAt=1,
        updatedAt=1,
    )
    regular_job = RuntimeInstallJob(
        jobId="python-job",
        component="python",
        packRef="python-base@3.13.15",
        state="completed",
        createdAt=2,
        updatedAt=2,
        finishedAt=2,
    )
    (tmp_path / "jobs.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "jobs": [
                    legacy_cli_job.model_dump(by_alias=True, mode="json"),
                    regular_job.model_dump(by_alias=True, mode="json"),
                ],
            }
        ),
        encoding="utf-8",
    )

    manager = _manager(tmp_path, FakeInstaller())

    jobs = {job.job_id: job for job in manager.list()}
    assert set(jobs) == {"legacy-cli", "python-job"}
    assert jobs["legacy-cli"].state == "failed"


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

    with pytest.raises(RuntimeAutoDownloadDisabledError, match="高级功能"):
        await manager.ensure("python")

    assert manager.list() == []


async def test_runtime_status_returns_local_rows_when_catalog_is_slow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = SlowCatalogClient()
    manager = RuntimeInstallJobManager(
        catalog_client=client,  # type: ignore[arg-type]
        component_store=RuntimeComponentStore(tmp_path / "runtimes"),
        state_path=tmp_path / "jobs.json",
        installer=FakeInstaller(),  # type: ignore[arg-type]
        current_platform="win32",
        current_architecture="x64",
    )
    monkeypatch.setattr(runtime_jobs, "_STATUS_CATALOG_WAIT_SECONDS", 0.01)

    payload = await manager.status_payload()

    assert client.started.is_set()
    assert payload["catalogAvailable"] is False
    assert [item["component"] for item in payload["components"]] == list(runtime_jobs.RUNTIME_KINDS)
    refresh = manager._catalog_refresh_task
    assert refresh is not None
    refresh.cancel()
    await asyncio.gather(refresh, return_exceptions=True)


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
