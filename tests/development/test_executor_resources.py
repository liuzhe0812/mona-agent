"""Engine resource API tests using synthetic archives through the shared installer."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import platform
import sys
import zipfile
from pathlib import Path

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import Config, DevelopmentConfig, _resolve_tool_config_refs
from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.contracts import ExecutorId
from mona.development.executors.base import ExecutorProbe
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import ConflictError, DevelopmentStore
from mona.runtime.catalog import (
    RuntimeCatalog,
    RuntimeCatalogCache,
    RuntimeCatalogEntry,
    RuntimeInstaller,
)
from mona.runtime.download import VerifiedDownloader
from mona.runtime.executors import EXECUTOR_RUNTIMES, managed_executor_path
from mona.runtime.jobs import RuntimeInstallJobManager
from mona.runtime.manager import RuntimeComponentStore
from mona.session.manager import SessionManager

AUTH = {"X-Mona-Token": "synthetic-engine-resource-test"}
_ARCH = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(
    platform.machine().lower(), platform.machine().lower()
)


class SyntheticCatalogClient:
    def __init__(self, catalog: RuntimeCatalog, *, cached: bool = True) -> None:
        self.catalog = catalog
        self.cached_catalog = catalog if cached else None
        self.resource_calls: list[str] = []

    def load_cached(self) -> RuntimeCatalogCache | None:
        if self.cached_catalog is None:
            return None
        return RuntimeCatalogCache(
            fetchedAt="2026-10-08T00:00:00Z",
            sourceUrl="https://fixture.example/catalog.json",
            catalog=self.cached_catalog,
        )

    async def fetch(self) -> RuntimeCatalog:
        return self.catalog

    async def fetch_resource(self, executor: str) -> RuntimeCatalog:
        self.resource_calls.append(executor)
        return self.catalog


def _archive_fixture(executor: str, version: str) -> tuple[RuntimeCatalogEntry, bytes]:
    component_id, kind = EXECUTOR_RUNTIMES[executor]
    binary = f"bin/{executor}.exe" if sys.platform == "win32" else f"bin/{executor}"
    archive_bytes = io.BytesIO()
    with zipfile.ZipFile(archive_bytes, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": component_id,
                    "version": version,
                    "kind": kind,
                    "entrypoints": {executor: binary, "metadata": "executor.json"},
                }
            ),
        )
        archive.writestr(binary, f"synthetic {executor} fixture; never executed")
        archive.writestr(
            "executor.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "executor": executor,
                    "platform": sys.platform,
                    "architecture": _ARCH,
                    "nativeVersion": version.split("+", 1)[0],
                }
            ),
        )
    payload = archive_bytes.getvalue()
    entry = RuntimeCatalogEntry(
        id=component_id,
        version=version,
        kind=kind,
        downloadUrl=f"https://fixture.example/{component_id}/{version}.zip",
        size=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        platforms=[sys.platform],
        architectures=[_ARCH],
    )
    return entry, payload


def _catalog(*entries: RuntimeCatalogEntry) -> RuntimeCatalog:
    return RuntimeCatalog(generatedAt="2026-10-08T00:00:00Z", components=list(entries))


def _make_manager(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog: RuntimeCatalog,
    archives: dict[str, bytes],
    *,
    cached: bool = True,
    block_download: bool = False,
):
    import mona.runtime.download as download_module

    monkeypatch.setattr(download_module, "validate_url_target", lambda _url: (True, ""))
    requested = asyncio.Event()
    release = asyncio.Event() if block_download else None

    async def respond(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url not in archives:
            return httpx.Response(404, request=request)
        requested.set()
        if release is not None:
            await release.wait()
        return httpx.Response(200, content=archives[url], request=request)

    transport = httpx.MockTransport(respond)
    catalog_client = SyntheticCatalogClient(catalog, cached=cached)
    store = RuntimeComponentStore(tmp_path / "runtimes")
    installer = RuntimeInstaller(
        catalog_client=catalog_client,  # type: ignore[arg-type]
        downloader=VerifiedDownloader(transport=transport),
        store=store,
        cache_dir=store.root / "downloads",
        current_platform=sys.platform,
        current_architecture=_ARCH,
    )
    manager = RuntimeInstallJobManager(
        catalog_client=catalog_client,  # type: ignore[arg-type]
        component_store=store,
        state_path=tmp_path / "jobs.json",
        installer=installer,
        current_platform=sys.platform,
        current_architecture=_ARCH,
    )
    monkeypatch.setattr("mona.runtime.official._runtime_jobs", manager)
    return manager, catalog_client, store, requested, release


def _patch_discovery(monkeypatch: pytest.MonkeyPatch, store: RuntimeComponentStore) -> None:
    import mona.development.resources as resources

    def discover(config: DevelopmentConfig, *, include_managed: bool = True) -> list[ExecutorProbe]:
        probes = []
        for executor, (component_id, _kind) in EXECUTOR_RUNTIMES.items():
            configured_path = getattr(config, f"{executor}_path")
            active = store.active(component_id)
            if configured_path is not None:
                probes.append(
                    ExecutorProbe(
                        executor=ExecutorId(executor),
                        state="detected",
                        executable=configured_path,
                        source="configured",
                    )
                )
            elif active is not None and include_managed:
                path = managed_executor_path(executor, store)
                probes.append(
                    ExecutorProbe(
                        executor=ExecutorId(executor),
                        state="detected",
                        executable=str(path),
                        source="managed_runtime",
                    )
                )
            else:
                probes.append(ExecutorProbe(executor=ExecutorId(executor), state="not_detected"))
        return probes

    async def native_version(_path: Path, executor: ExecutorId, *, cwd: Path, env: dict[str, str]) -> str:
        active = store.active(EXECUTOR_RUNTIMES[executor.value][0])
        assert active is not None
        return active[0].version.split("+", 1)[0]

    monkeypatch.setattr(resources, "discover_executors", discover)
    monkeypatch.setattr(resources, "native_version", native_version)


async def _api_client(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    config: DevelopmentConfig | None = None,
) -> tuple[TestClient, DevelopmentRuntime]:
    _resolve_tool_config_refs()
    monkeypatch.setenv("MONA_SERVICES_TOKEN", AUTH["X-Mona-Token"])
    root_config = Config(development=config or DevelopmentConfig())
    runtime = DevelopmentRuntime(
        DevelopmentStore(tmp_path / "state.sqlite3"),
        SessionManager(tmp_path / "sessions"),
        lambda: root_config,
    )
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, runtime


def _install_component(
    store: RuntimeComponentStore,
    tmp_path: Path,
    executor: str,
    version: str,
) -> tuple[RuntimeCatalogEntry, bytes]:
    entry, payload = _archive_fixture(executor, version)
    archive = tmp_path / f"{executor}-{version}.zip"
    archive.write_bytes(payload)
    store.install_archive(archive)
    return entry, payload


@pytest.mark.asyncio
async def test_engine_resource_api_auth_and_metadata_reads_create_no_install_jobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry, payload = _archive_fixture("codex", f"1.0.0+{sys.platform}.{_ARCH}")
    manager, catalog_client, store, _requested, _release = _make_manager(
        tmp_path, monkeypatch, _catalog(entry), {str(entry.download_url): payload}, cached=False
    )
    _patch_discovery(monkeypatch, store)
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    try:
        denied = await client.get("/api/development/engine-resources?executor=codex")
        assert denied.status == 401
        denied = await client.post(
            "/api/development/executors/codex/prepare",
            json={"packRef": f"{entry.id}@{entry.version}"},
        )
        assert denied.status == 401
        assert manager.list() == [] and not manager._tasks
        assert catalog_client.resource_calls == []

        response = await client.get(
            "/api/development/engine-resources?executor=codex&refresh=true", headers=AUTH
        )
        assert response.status == 200
        body = await response.json()
        row = body["components"][0]
        assert body["catalogAvailable"] and row["canPrepare"]
        assert not row["canDelete"] and not row["canUpdate"]
        assert row["packRef"] == f"{entry.id}@{entry.version}"
        assert catalog_client.resource_calls == ["codex"]
        assert manager.list() == [] and not manager._tasks
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_system_or_explicit_executable_does_not_block_managed_prepare(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for existing_source in ("system", "explicit"):
        case_root = tmp_path / existing_source
        case_root.mkdir()
        entry, payload = _archive_fixture("codex", f"1.0.0+{sys.platform}.{_ARCH}")
        manager, catalog_client, store, requested, _release = _make_manager(
            case_root, monkeypatch, _catalog(entry), {str(entry.download_url): payload}
        )
        executable = str(case_root / "system" / "codex.exe")
        config = (
            DevelopmentConfig(codex_path=executable)
            if existing_source == "explicit"
            else DevelopmentConfig()
        )
        Path(executable).parent.mkdir(parents=True, exist_ok=True)
        Path(executable).write_text("system or explicit program sentinel", encoding="utf-8")
        import mona.development.resources as resources

        def discover(_config, *, include_managed=True):
            return [
                ExecutorProbe(
                    executor=ExecutorId.CODEX,
                    state="detected",
                    executable=executable,
                    source="configured" if existing_source == "explicit" else "system",
                ),
                ExecutorProbe(executor=ExecutorId.CLAUDE, state="not_detected"),
                ExecutorProbe(executor=ExecutorId.CODEBUDDY, state="not_detected"),
            ]

        async def native_version(_path, _executor, *, cwd, env):
            return "1.0.0"

        monkeypatch.setattr(resources, "discover_executors", discover)
        monkeypatch.setattr(resources, "native_version", native_version)
        client, _runtime = await _api_client(case_root, monkeypatch, config)
        try:
            status = await client.get("/api/development/engine-resources?executor=codex", headers=AUTH)
            status_row = (await status.json())["components"][0]
            assert status_row["systemAvailable"] and status_row["canPrepare"]
            assert not status_row["managedInstalled"] and not status_row["canDelete"]
            response = await client.post(
                "/api/development/executors/codex/prepare",
                headers=AUTH,
                json={"packRef": f"{entry.id}@{entry.version}"},
            )
            assert response.status == 202
            job_id = (await response.json())["job"]["id"]
            await asyncio.wait_for(requested.wait(), timeout=3)
            await manager._tasks[job_id]
            assert manager.get(job_id).state == "completed"
            assert store.active("codex-cli") is not None
            assert Path(executable).read_text(encoding="utf-8") == "system or explicit program sentinel"
            assert config.codex_path == (executable if existing_source == "explicit" else None)
        finally:
            await client.close()


@pytest.mark.asyncio
async def test_system_and_managed_engine_statuses_remain_independent(tmp_path, monkeypatch):
    import mona.development.resources as resources

    installed = f"1.0.0+{sys.platform}.{_ARCH}"
    latest = f"2.0.0+{sys.platform}.{_ARCH}"
    latest_entry, latest_payload = _archive_fixture("codex", latest)
    manager, _catalog_client, store, _requested, _release = _make_manager(
        tmp_path, monkeypatch, _catalog(latest_entry), {str(latest_entry.download_url): latest_payload}
    )
    _install_component(store, tmp_path, "codex", installed)
    system_executable = tmp_path / "system-bin" / ("codex.exe" if sys.platform == "win32" else "codex")
    system_executable.parent.mkdir()
    system_executable.write_text("system program sentinel", encoding="utf-8")

    def discover(_config, *, include_managed=True):
        return [
            ExecutorProbe(executor=ExecutorId.CODEX, state="detected", executable=str(system_executable), source="system"),
            ExecutorProbe(executor=ExecutorId.CLAUDE, state="not_detected"),
            ExecutorProbe(executor=ExecutorId.CODEBUDDY, state="not_detected"),
        ]

    async def native_version(path, _executor, *, cwd, env):
        return "9.0.0" if path == system_executable else "1.0.0"

    monkeypatch.setattr(resources, "discover_executors", discover)
    monkeypatch.setattr(resources, "native_version", native_version)
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    try:
        response = await client.get("/api/development/engine-resources?executor=codex", headers=AUTH)
        assert response.status == 200
        row = (await response.json())["components"][0]
        assert row["systemAvailable"] and row["systemExecutable"] == str(system_executable)
        assert row["systemVersion"] == "9.0.0"
        assert row["managedInstalled"] and row["canDelete"] and row["canUpdate"]
        assert row["managedExecutable"] == str(managed_executor_path("codex", store))
        assert row["managedVersion"] == "1.0.0"
        assert not row["canPrepare"] and row["installedVersion"] == "9.0.0"
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_mona_managed_path_is_not_reported_as_a_system_program(tmp_path, monkeypatch):
    import mona.development.resources as resources

    entry, payload = _archive_fixture("codex", f"1.0.0+{sys.platform}.{_ARCH}")
    _manager, _catalog_client, store, _requested, _release = _make_manager(
        tmp_path, monkeypatch, _catalog(entry), {str(entry.download_url): payload}
    )
    _install_component(store, tmp_path, "codex", entry.version)
    managed = managed_executor_path("codex", store)

    def discover(_config, *, include_managed=True):
        # Simulate a stale/default discovery source that points at Mona's own root.
        return [
            ExecutorProbe(executor=ExecutorId.CODEX, state="detected", executable=str(managed), source="system"),
            ExecutorProbe(executor=ExecutorId.CLAUDE, state="not_detected"),
            ExecutorProbe(executor=ExecutorId.CODEBUDDY, state="not_detected"),
        ]

    async def native_version(_path, _executor, *, cwd, env):
        return "1.0.0"

    monkeypatch.setattr(resources, "discover_executors", discover)
    monkeypatch.setattr(resources, "native_version", native_version)
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    try:
        response = await client.get("/api/development/engine-resources?executor=codex", headers=AUTH)
        row = (await response.json())["components"][0]
        assert response.status == 200
        assert not row["systemAvailable"] and row["systemExecutable"] is None
        assert row["managedInstalled"] and row["managedExecutable"] == str(managed)
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_prepare_rejects_wrong_executor_pack(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entry, payload = _archive_fixture("codex", f"1.0.0+{sys.platform}.{_ARCH}")
    manager, catalog_client, store, _requested, _release = _make_manager(
        tmp_path, monkeypatch, _catalog(entry), {str(entry.download_url): payload}
    )
    _patch_discovery(monkeypatch, store)
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    try:
        for executor, pack_ref in (
            ("claude", "codex-cli@1.0.0+win32.x64"),
            ("codex", "python-base@3.13.15"),
        ):
            response = await client.post(
                f"/api/development/executors/{executor}/prepare",
                headers=AUTH,
                json={"packRef": pack_ref},
            )
            assert response.status == 422
            assert (await response.json())["error"]["code"] == "invalid_runtime_resource"
        assert manager.list() == [] and not manager._tasks
        assert catalog_client.resource_calls == []
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("executor", ["codex", "claude", "codebuddy"])
async def test_install_and_update_use_shared_runtime_pipeline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    executor: str,
) -> None:
    version_one = f"1.0.0+{sys.platform}.{_ARCH}"
    version_two = f"2.0.0+{sys.platform}.{_ARCH}"
    entry_one, archive_one = _archive_fixture(executor, version_one)
    entry_two, archive_two = _archive_fixture(executor, version_two)
    manager, catalog_client, store, _requested, _release = _make_manager(
        tmp_path,
        monkeypatch,
        _catalog(entry_one),
        {
            str(entry_one.download_url): archive_one,
            str(entry_two.download_url): archive_two,
        },
    )
    _patch_discovery(monkeypatch, store)
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    component_id = EXECUTOR_RUNTIMES[executor][0]
    try:
        status = await client.get(
            f"/api/development/engine-resources?executor={executor}", headers=AUTH
        )
        row = (await status.json())["components"][0]
        assert status.status == 200 and row["canPrepare"]
        assert row["packRef"] == f"{entry_one.id}@{entry_one.version}"
        assert manager.list() == [] and not manager._tasks

        first = await client.post(
            f"/api/development/executors/{executor}/prepare",
            headers=AUTH,
            json={"packRef": f"{entry_one.id}@{entry_one.version}"},
        )
        assert first.status == 202
        first_job_id = (await first.json())["job"]["id"]
        await manager._tasks[first_job_id]
        first_state = await client.get(
            f"/api/development/executors/{executor}/install/{first_job_id}", headers=AUTH
        )
        assert (await first_state.json())["state"] == "completed"
        assert store.active(component_id)[0].version == version_one  # type: ignore[index]

        catalog_client.catalog = _catalog(entry_two)
        catalog_client.cached_catalog = catalog_client.catalog
        refreshed = await client.get(
            f"/api/development/engine-resources?executor={executor}&refresh=true", headers=AUTH
        )
        latest = (await refreshed.json())["components"][0]
        assert refreshed.status == 200 and latest["canUpdate"]
        assert latest["installedVersion"] == "1.0.0"
        assert latest["packRef"] == f"{entry_two.id}@{entry_two.version}"

        update = await client.post(
            f"/api/development/executors/{executor}/prepare",
            headers=AUTH,
            json={"packRef": f"{entry_two.id}@{entry_two.version}"},
        )
        assert update.status == 202
        update_job_id = (await update.json())["job"]["id"]
        await manager._tasks[update_job_id]
        update_state = await client.get(
            f"/api/development/executors/{executor}/install/{update_job_id}", headers=AUTH
        )
        assert (await update_state.json())["state"] == "completed"
        assert store.active(component_id)[0].version == version_two  # type: ignore[index]
        assert (store.root / "components" / component_id / "versions" / version_one).is_dir()
        assert catalog_client.resource_calls == [executor, executor, executor]
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_cancel_route_requires_matching_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry, payload = _archive_fixture("codex", f"1.0.0+{sys.platform}.{_ARCH}")
    manager, _catalog_client, store, requested, release = _make_manager(
        tmp_path,
        monkeypatch,
        _catalog(entry),
        {str(entry.download_url): payload},
        block_download=True,
    )
    _patch_discovery(monkeypatch, store)
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    job_id = ""
    try:
        response = await client.post(
            "/api/development/executors/codex/prepare",
            headers=AUTH,
            json={"packRef": f"{entry.id}@{entry.version}"},
        )
        assert response.status == 202
        job_id = (await response.json())["job"]["id"]
        await asyncio.wait_for(requested.wait(), timeout=3)
        assert manager.get(job_id).state == "running"

        wrong = await client.delete(
            f"/api/development/executors/claude/install/{job_id}", headers=AUTH
        )
        assert wrong.status == 404 and manager.get(job_id).state == "running"

        cancelled = await client.delete(
            f"/api/development/executors/codex/install/{job_id}", headers=AUTH
        )
        assert cancelled.status == 200
        assert (await cancelled.json())["state"] == "cancelled"
        await manager._tasks[job_id]
        assert store.active("codex-cli") is None
    finally:
        if release is not None:
            release.set()
        if job_id:
            await asyncio.gather(manager._tasks[job_id], return_exceptions=True)
        await client.close()


@pytest.mark.asyncio
async def test_partial_managed_program_can_be_repaired_or_deleted(tmp_path, monkeypatch):
    entry, payload = _archive_fixture("codex", f"1.0.0+{sys.platform}.{_ARCH}")
    _manager, _catalog_client, store, _requested, _release = _make_manager(
        tmp_path, monkeypatch, _catalog(entry), {str(entry.download_url): payload}
    )
    component = store.root / "components" / "codex-cli"
    component.mkdir(parents=True)
    (component / "remaining-file").write_text("partial removal", encoding="utf-8")
    _patch_discovery(monkeypatch, store)
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    try:
        response = await client.get("/api/development/engine-resources?executor=codex", headers=AUTH)
        row = (await response.json())["components"][0]
        assert response.status == 200
        assert row["repairRequired"] and row["canDelete"] and row["packRef"]
        assert row["managedExecutable"] is None and row["systemExecutable"] is None
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_delete_removes_only_selected_managed_program_and_download_cache(tmp_path, monkeypatch):
    codex_entry, codex_payload = _archive_fixture("codex", f"1.0.0+{sys.platform}.{_ARCH}")
    claude_entry, claude_payload = _archive_fixture("claude", f"1.0.0+{sys.platform}.{_ARCH}")
    manager, _catalog_client, store, _requested, _release = _make_manager(
        tmp_path,
        monkeypatch,
        _catalog(codex_entry, claude_entry),
        {str(codex_entry.download_url): codex_payload, str(claude_entry.download_url): claude_payload},
    )
    _install_component(store, tmp_path, "codex", codex_entry.version)
    _install_component(store, tmp_path, "claude", claude_entry.version)
    codex_cache = store.root / "downloads" / "codex-cli" / "partial.zip"
    claude_component = EXECUTOR_RUNTIMES["claude"][0]
    claude_cache = store.root / "downloads" / claude_component / "cached.zip"
    codex_cache.parent.mkdir(parents=True)
    claude_cache.parent.mkdir(parents=True)
    codex_cache.write_bytes(b"Codex download cache")
    claude_cache.write_bytes(b"Claude download cache")
    component_root = store.root / "components" / "codex-cli"
    system_binary = tmp_path / "system-bin" / ("codex.exe" if sys.platform == "win32" else "codex")
    system_binary.parent.mkdir()
    system_binary.write_text("system program", encoding="utf-8")
    auth_marker = tmp_path / "native" / "codex" / "auth.json"
    auth_marker.parent.mkdir(parents=True)
    auth_marker.write_text("native credentials", encoding="utf-8")
    monkeypatch.setattr(
        "mona.development.settings.read_settings",
        lambda: {"revision": "0" * 64, "values": {"codexPath": str(system_binary)}},
    )
    client, runtime = await _api_client(tmp_path, monkeypatch)
    try:
        project_root = tmp_path / "project"
        project_root.mkdir()
        project = runtime.store.open_project(project_root)
        session = runtime.store.create_session(project.id)
        response = await client.delete(
            "/api/development/executors/codex/managed-program",
            headers=AUTH,
            json={"version": codex_entry.version.split("+", 1)[0]},
        )
        assert response.status == 200 and (await response.json())["deleted"]
        assert not component_root.exists() and not codex_cache.parent.exists()
        assert store.active(claude_component) is not None and claude_cache.read_bytes() == b"Claude download cache"
        assert system_binary.read_text(encoding="utf-8") == "system program"
        assert auth_marker.read_text(encoding="utf-8") == "native credentials"
        assert runtime.store.get_session(session.id).id == session.id
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_delete_rejects_stale_managed_version_without_changing_files(tmp_path, monkeypatch):
    entry, payload = _archive_fixture("codex", f"2.0.0+{sys.platform}.{_ARCH}")
    manager, _catalog_client, store, _requested, _release = _make_manager(
        tmp_path, monkeypatch, _catalog(entry), {str(entry.download_url): payload}
    )
    _install_component(store, tmp_path, "codex", entry.version)
    cache = store.root / "downloads" / "codex-cli" / "cached.zip"
    cache.parent.mkdir(parents=True)
    cache.write_bytes(b"keep on conflict")
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    try:
        response = await client.delete(
            "/api/development/executors/codex/managed-program",
            headers=AUTH,
            json={"version": "1.0.0"},
        )
        assert response.status == 409
        active = store.active("codex-cli")
        assert active is not None and active[0].version == entry.version
        assert cache.read_bytes() == b"keep on conflict"
        assert (store.root / "components" / "codex-cli" / "current.json").is_file()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_delete_is_blocked_while_managed_program_update_is_running(tmp_path, monkeypatch):
    active_version = f"1.0.0+{sys.platform}.{_ARCH}"
    update_entry, update_payload = _archive_fixture("codex", f"2.0.0+{sys.platform}.{_ARCH}")
    manager, _catalog_client, store, requested, release = _make_manager(
        tmp_path,
        monkeypatch,
        _catalog(update_entry),
        {str(update_entry.download_url): update_payload},
        block_download=True,
    )
    _install_component(store, tmp_path, "codex", active_version)
    cache = store.root / "downloads" / "codex-cli" / "existing.zip"
    cache.parent.mkdir(parents=True)
    cache.write_bytes(b"preserve during update")
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    job_id = ""
    try:
        started = await client.post(
            "/api/development/executors/codex/prepare",
            headers=AUTH,
            json={"packRef": f"{update_entry.id}@{update_entry.version}"},
        )
        assert started.status == 202
        job_id = (await started.json())["job"]["id"]
        await asyncio.wait_for(requested.wait(), timeout=3)
        response = await client.delete(
            "/api/development/executors/codex/managed-program",
            headers=AUTH,
            json={"version": "1.0.0"},
        )
        assert response.status == 409 and manager.get(job_id).state == "running"
        active = store.active("codex-cli")
        assert active is not None and active[0].version == active_version
        assert cache.read_bytes() == b"preserve during update"

        # A cancellation state can become visible before its worker task unwinds.
        manager._jobs[job_id].state = "cancelled"
        task = manager._tasks[job_id]
        response = await client.delete(
            "/api/development/executors/codex/managed-program",
            headers=AUTH,
            json={"version": "1.0.0"},
        )
        assert response.status == 409 and not task.done()
        assert store.active("codex-cli") is not None and cache.read_bytes() == b"preserve during update"
        manager._jobs[job_id].state = "running"
    finally:
        if release is not None:
            release.set()
        if job_id:
            await asyncio.gather(manager._tasks[job_id], return_exceptions=True)
        await client.close()


@pytest.mark.asyncio
async def test_system_program_is_discovered_when_config_points_into_mona_component(tmp_path, monkeypatch):
    import mona.development.resources as resources

    current = f"1.0.0+{sys.platform}.{_ARCH}"
    latest = f"2.0.0+{sys.platform}.{_ARCH}"
    latest_entry, latest_payload = _archive_fixture("codex", latest)
    _manager, _catalog_client, store, _requested, _release = _make_manager(
        tmp_path, monkeypatch, _catalog(latest_entry), {str(latest_entry.download_url): latest_payload}
    )
    _install_component(store, tmp_path, "codex", current)
    managed = managed_executor_path("codex", store)
    system_binary = tmp_path / "system-bin" / ("codex.exe" if sys.platform == "win32" else "codex")
    system_binary.parent.mkdir()
    system_binary.write_text("system program", encoding="utf-8")
    config = DevelopmentConfig(codex_path=str(managed))

    def discover(config, *, include_managed=True):
        executable = config.codex_path or str(system_binary)
        return [
            ExecutorProbe(
                executor=ExecutorId.CODEX,
                state="detected",
                executable=executable,
                source="configured" if config.codex_path else "standard_location",
            ),
            ExecutorProbe(executor=ExecutorId.CLAUDE, state="not_detected"),
            ExecutorProbe(executor=ExecutorId.CODEBUDDY, state="not_detected"),
        ]

    async def native_version(path, _executor, *, cwd, env):
        return "9.0.0" if Path(path) == system_binary else "1.0.0"

    monkeypatch.setattr(resources, "discover_executors", discover)
    monkeypatch.setattr(resources, "native_version", native_version)
    client, _runtime = await _api_client(tmp_path, monkeypatch, config)
    try:
        response = await client.get("/api/development/engine-resources?executor=codex", headers=AUTH)
        assert response.status == 200
        row = (await response.json())["components"][0]
        assert row["systemAvailable"] and row["systemExecutable"] == str(system_binary)
        assert row["systemVersion"] == "9.0.0"
        assert row["managedExecutable"] == str(managed) and row["managedVersion"] == "1.0.0"
        assert row["canUpdate"] and not row["canPrepare"]
    finally:
        await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["oserror", "conflict"])
async def test_delete_reports_completed_with_warning_when_managed_path_cleanup_fails(
    tmp_path, monkeypatch, failure
):
    import mona.development.settings as settings

    entry, payload = _archive_fixture("codex", f"1.0.0+{sys.platform}.{_ARCH}")
    _manager, _catalog_client, store, _requested, _release = _make_manager(
        tmp_path, monkeypatch, _catalog(entry), {str(entry.download_url): payload}
    )
    _install_component(store, tmp_path, "codex", entry.version)
    managed = str(managed_executor_path("codex", store))
    revision = "a" * 64
    settings_state = {"codexPath": managed}
    monkeypatch.setattr(
        settings,
        "read_settings",
        lambda: {"revision": revision, "values": dict(settings_state)},
    )

    def fail_update(_revision, values):
        assert _revision == revision and values == {"codexPath": None}
        if failure == "conflict":
            settings_state["codexPath"] = str(tmp_path / "newer-user-choice" / "codex")
            raise ConflictError("settings changed concurrently")
        raise OSError("settings file became unavailable")

    monkeypatch.setattr(settings, "update_settings", fail_update)
    client, _runtime = await _api_client(tmp_path, monkeypatch)
    try:
        response = await client.delete(
            "/api/development/executors/codex/managed-program",
            headers=AUTH,
            json={"version": "1.0.0"},
        )
        body = await response.json()
        assert response.status == 200 and body["deleted"] and body["warning"]
        assert store.active("codex-cli") is None
        expected = str(tmp_path / "newer-user-choice" / "codex") if failure == "conflict" else managed
        assert settings_state["codexPath"] == expected
    finally:
        await client.close()
