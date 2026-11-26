"""Expert catalog and background install job contracts."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from mona.agent.expert_catalog import ExpertCatalogSnapshot
from mona.agent.expert_installer import ExpertInstallProgress, ExpertInstaller
from mona.agent.expert_jobs import (
    ExpertInstallJobManager,
    ExpertInstallUnavailableError,
)
from mona.agent.package_store import AgentPackageStore, ExpertCatalog
from mona.runtime.download import VerifiedDownloader


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
    def load_cached_snapshot(self) -> ExpertCatalogSnapshot | None:
        return None

    async def fetch(self) -> ExpertCatalogSnapshot:
        return _snapshot()


class FakeInstaller:
    def compatibility_error(self, _entry):
        return None

    def select_compatible_entry(self, entries):
        return max(entries, key=lambda entry: entry.version)

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


async def test_catalog_shows_latest_compatible_versions_and_keeps_installed_partners(
    tmp_path: Path,
) -> None:
    template = _snapshot().catalog.experts[0].model_dump(by_alias=True, mode="json")

    def entry(agent_id: str, version: str, required_tools: list[str]) -> dict:
        return {
            **template,
            "id": agent_id,
            "displayName": agent_id,
            "version": version,
            "requiredTools": required_tools,
            "runtimePacks": [],
        }

    catalog = ExpertCatalog.model_validate({
        "schemaVersion": 1,
        "generatedAt": "2026-08-29T00:00:00Z",
        "experts": [
            entry("com.mona.researcher", "2.0.0", ["future_tool"]),
            entry("com.mona.researcher", "1.0.0", ["read_file"]),
            entry("com.mona.researcher", "invalid-version", ["read_file"]),
            entry("com.example.current", "3.0.0", ["future_tool"]),
            entry("com.example.current", "1.0.0", ["read_file"]),
            entry("com.example.installed", "2.0.0", ["future_tool"]),
            entry("com.example.hidden", "2.0.0", ["future_tool"]),
            entry("com.mona.a-share-analyst", "1.0.0", ["read_file"]),
            entry("com.mona.stock", "1.0.0", ["read_file"]),
            entry("com.mona.stock-researcher", "1.0.0", ["read_file"]),
        ],
    })
    snapshot = ExpertCatalogSnapshot(
        catalog=catalog,
        source="network",
        source_url="https://cdn.example.test/catalog.json",
        fetched_at="2026-08-29T00:00:00Z",
        stale=False,
    )

    class CatalogClient:
        def load_cached_snapshot(self):
            return None

        async def fetch(self):
            return snapshot

    client = CatalogClient()
    store = AgentPackageStore(tmp_path / "packages")
    installer = ExpertInstaller(
        catalog_client=client,  # type: ignore[arg-type]
        downloader=VerifiedDownloader(),
        package_store=store,
        download_cache_dir=tmp_path / "downloads",
        resolve_tool_names=lambda _agent_id: {"read_file"},
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )
    installed_versions = {
        "com.mona.researcher": "0.9.0",
        "com.example.current": "2.1.0",
        "com.example.installed": "1.0.0",
        "com.mona.a-share-analyst": "1.0.0",
        "com.mona.stock-researcher": "1.0.0",
    }
    manager = ExpertInstallJobManager(
        catalog_client=client,  # type: ignore[arg-type]
        state_path=tmp_path / "jobs.json",
        installer=installer,
        installed_definition=lambda agent_id: (
            SimpleNamespace(package_version=installed_versions[agent_id])
            if agent_id in installed_versions else None
        ),
    )

    payload = await manager.catalog_payload()
    rows = {row["id"]: row for row in payload["experts"]}
    assert set(rows) == {
        "com.mona.researcher", "com.example.current", "com.example.installed",
    }
    assert rows["com.mona.researcher"]["version"] == "1.0.0"
    assert rows["com.mona.researcher"]["installedVersion"] == "0.9.0"
    assert rows["com.mona.researcher"]["updateAvailable"] is True
    assert rows["com.mona.researcher"]["compatible"] is True
    assert rows["com.example.current"]["version"] == "2.1.0"
    assert rows["com.example.current"]["installedVersion"] == "2.1.0"
    assert rows["com.example.current"]["updateAvailable"] is False
    assert rows["com.example.installed"]["version"] == "1.0.0"
    assert rows["com.example.installed"]["installedVersion"] == "1.0.0"
    assert rows["com.example.installed"]["updateAvailable"] is False


async def test_catalog_returns_cached_snapshot_before_background_refresh(tmp_path: Path) -> None:
    refreshed = _snapshot()
    refresh_calls = 0

    class CachedCatalogClient(FakeCatalogClient):
        def load_cached_snapshot(self) -> ExpertCatalogSnapshot:
            return _snapshot()

        async def fetch(self) -> ExpertCatalogSnapshot:
            nonlocal refresh_calls
            refresh_calls += 1
            return refreshed

    manager = ExpertInstallJobManager(
        catalog_client=CachedCatalogClient(),  # type: ignore[arg-type]
        state_path=tmp_path / "jobs.json",
        installer=FakeInstaller(),
        installed_definition=lambda _expert_id: None,
    )

    payload = await manager.catalog_payload()

    assert payload["source"] == "cache"
    assert manager._catalog_refresh_task is not None
    await manager._catalog_refresh_task
    assert refresh_calls == 1


async def test_missing_requested_version_refreshes_catalog_and_reports_job_error(
    tmp_path: Path,
) -> None:
    old = _snapshot()
    newer_catalog = ExpertCatalog.model_validate({
        "schemaVersion": 1,
        "generatedAt": "2026-08-29T01:00:00Z",
        "experts": [
            old.catalog.experts[1].model_dump(by_alias=True, mode="json"),
        ],
    })
    refreshed = ExpertCatalogSnapshot(
        catalog=newer_catalog,
        source="remote",
        source_url=old.source_url,
        fetched_at="2026-08-29T01:00:00Z",
        stale=False,
    )

    class ChangingCatalog:
        cached = old

        def load_cached_snapshot(self):
            return self.cached

        async def fetch(self):
            self.cached = refreshed
            return refreshed

    async def prepare_runtime(_packs, _progress):
        raise AssertionError("a removed version must not prepare runtime")

    client = ChangingCatalog()
    installer = ExpertInstaller(
        catalog_client=client,  # type: ignore[arg-type]
        downloader=VerifiedDownloader(),
        package_store=AgentPackageStore(tmp_path / "packages"),
        download_cache_dir=tmp_path / "downloads",
        resolve_tool_names=lambda _agent_id: {"read_file"},
        runtime_pack_installer=prepare_runtime,
        mona_version="1.5.0",
    )
    manager = ExpertInstallJobManager(
        catalog_client=client,  # type: ignore[arg-type]
        state_path=tmp_path / "jobs.json",
        installer=installer,
        installed_definition=lambda _agent_id: None,
    )
    initial = await manager.catalog_payload()
    assert initial["experts"][0]["version"] == "2.0.0"

    job = manager.start("com.mona.researcher", "2.0.0")
    await manager._tasks[job.job_id]
    failed = manager.get(job.job_id)
    assert failed.state == "failed"
    assert failed.error_code == "catalog_version_unavailable"

    updated = await manager.catalog_payload()
    assert updated["experts"][0]["version"] == "1.0.0"
    assert not (tmp_path / "downloads").exists()
    if manager._catalog_refresh_task is not None:
        await manager._catalog_refresh_task


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


async def test_one_partner_reuses_active_install_across_requested_versions(tmp_path: Path) -> None:
    gate = asyncio.Event()
    calls = []

    class WaitingInstaller:
        async def install(self, agent_id, *, version=None, progress=None):
            calls.append((agent_id, version))
            await gate.wait()
            return SimpleNamespace(
                cached_download=False,
                entry=SimpleNamespace(version=version or "1.0.0"),
            )

    manager = _manager(tmp_path, WaitingInstaller())
    first = manager.start("com.mona.researcher", "1.0.0")
    same = manager.start("com.mona.researcher", "2.0.0")
    same_default = manager.start("com.mona.researcher")
    other = manager.start("com.mona.other", "2.0.0")
    try:
        assert same.job_id == first.job_id
        assert same_default.job_id == first.job_id
        assert other.job_id != first.job_id
        await asyncio.sleep(0)
        assert calls == [
            ("com.mona.researcher", "1.0.0"),
            ("com.mona.other", "2.0.0"),
        ]
    finally:
        gate.set()
        await asyncio.gather(*manager._tasks.values())
    assert manager.get(first.job_id).state == "completed"
    assert manager.get(other.job_id).state == "completed"

    later = manager.start("com.mona.researcher", "2.0.0")
    assert later.job_id != first.job_id
    await manager._tasks[later.job_id]
    assert manager.get(later.job_id).installed_version == "2.0.0"
