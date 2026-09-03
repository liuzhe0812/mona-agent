"""User-facing on-demand jobs for managed runtime resources."""

from __future__ import annotations

import asyncio
import json
import os
import platform
import sys
import tempfile
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from filelock import FileLock
from packaging.version import InvalidVersion, Version
from pydantic import Field

from mona.config.schema import Base
from mona.runtime.catalog import (
    RuntimeCatalog,
    RuntimeCatalogClient,
    RuntimeCatalogEntry,
    RuntimeInstaller,
)
from mona.runtime.manager import RuntimeComponentStore, parse_runtime_pack_ref

RUNTIME_KINDS = {
    "python": "python-runtime",
    "node": "node-runtime",
    "ffmpeg": "ffmpeg-runtime",
    "yt_dlp": "yt-dlp-runtime",
    "asr": "asr-runtime",
    "pandoc": "pandoc-runtime",
    "computer_use": "computer-use-runtime",
    "westock": "stock-data-runtime",
}

_RUNTIME_COMPONENT_IDS = {
    "python": ("python-base",),
    "node": ("node-base",),
    "ffmpeg": ("ffmpeg",),
    "yt_dlp": ("yt-dlp",),
    "asr": ("asr-sensevoice",),
    "pandoc": ("pandoc",),
    "computer_use": ("cua-driver",),
    "westock": ("westock-data",),
}
_STATUS_CATALOG_WAIT_SECONDS = 2.0


class RuntimeInstallUnavailableError(RuntimeError):
    """Raised when the release has no runtime installer configured."""


class RuntimeAutoDownloadDisabledError(RuntimeError):
    """Raised when a feature needs a resource but automatic download is disabled."""


class RuntimeInstallJob(Base):
    schema_version: int = 1
    job_id: str
    component: str
    pack_ref: str
    pack_refs: list[str] = Field(default_factory=list)
    repair: bool = False
    state: Literal["queued", "running", "completed", "failed", "cancelled"]
    stage: str = "queued"
    downloaded_bytes: int = Field(default=0, ge=0)
    total_bytes: int = Field(default=0, ge=0)
    error: str | None = None
    created_at: int
    updated_at: int
    finished_at: int | None = None


class RuntimeInstallJobManager:
    def __init__(
        self,
        *,
        catalog_client: RuntimeCatalogClient,
        component_store: RuntimeComponentStore,
        state_path: Path,
        installer: RuntimeInstaller | None,
        current_platform: str = sys.platform,
        current_architecture: str | None = None,
        unavailable_reason: str = "官方运行组件服务暂不可用",
        auto_download_enabled: Callable[[], bool] | None = None,
        migration_status: Callable[[], dict[str, object]] | None = None,
        cleanup_legacy: Callable[[], dict[str, int]] | None = None,
    ) -> None:
        self.catalog_client = catalog_client
        self.component_store = component_store
        self.state_path = state_path
        self.installer = installer
        self.current_platform = current_platform
        self.current_architecture = current_architecture or _architecture()
        self.unavailable_reason = unavailable_reason
        self.auto_download_enabled = auto_download_enabled or (lambda: True)
        self.migration_status = migration_status
        self.cleanup_legacy = cleanup_legacy
        self.cache_dir = getattr(installer, "cache_dir", component_store.root / "downloads")
        self._jobs: dict[str, RuntimeInstallJob] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._catalog_refresh_task: asyncio.Task[RuntimeCatalog] | None = None
        self._install_lock = asyncio.Lock()
        self._last_persisted = 0.0
        self._load()

    async def status_payload(self) -> dict[str, object]:
        catalog = await self._status_catalog()
        components = (
            self._components_from_catalog(catalog)
            if catalog is not None
            else self._components_without_catalog()
        )
        payload: dict[str, object] = {
            "schemaVersion": 1,
            "autoDownload": bool(self.auto_download_enabled()),
            "installEnabled": self.installer is not None,
            "installUnavailableReason": None if self.installer else self.unavailable_reason,
            "catalogAvailable": catalog is not None,
            "components": components,
            "jobs": [job.model_dump(by_alias=True, mode="json") for job in self.list()],
        }
        if self.migration_status is not None:
            payload["migration"] = self.migration_status()
        return payload

    async def _status_catalog(self) -> RuntimeCatalog | None:
        cached = self._cached_catalog()
        task = self._start_catalog_refresh()
        if cached is not None:
            return cached
        try:
            return await asyncio.wait_for(
                asyncio.shield(task), timeout=_STATUS_CATALOG_WAIT_SECONDS
            )
        except Exception:
            return None

    def _cached_catalog(self) -> RuntimeCatalog | None:
        load_cached = getattr(self.catalog_client, "load_cached", None)
        if not callable(load_cached):
            return None
        cached = load_cached()
        return cached.catalog if cached is not None else None

    def _start_catalog_refresh(self) -> asyncio.Task[RuntimeCatalog]:
        task = self._catalog_refresh_task
        if task is not None and not task.done():
            return task
        task = asyncio.create_task(self.catalog_client.fetch())
        self._catalog_refresh_task = task
        task.add_done_callback(self._finish_catalog_refresh)
        return task

    def _finish_catalog_refresh(self, task: asyncio.Task[RuntimeCatalog]) -> None:
        if self._catalog_refresh_task is task:
            self._catalog_refresh_task = None
        if task.cancelled():
            return
        try:
            task.result()
        except Exception:
            pass

    def _components_from_catalog(self, catalog: RuntimeCatalog) -> list[dict[str, object]]:
        components: list[dict[str, object]] = []
        for component, kind in RUNTIME_KINDS.items():
            entry = self._latest(catalog, kind)
            if entry is None:
                continue
            active = self.component_store.active(entry.id)
            installed_version = active[0].version if active else None
            components.append(
                {
                    "component": component,
                    "available": True,
                    "packRef": f"{entry.id}@{entry.version}",
                    "version": entry.version,
                    "downloadBytes": self._dependency_bytes(catalog, entry),
                    "installed": installed_version is not None,
                    "installedVersion": installed_version,
                    "updateAvailable": bool(
                        installed_version and _newer(entry.version, installed_version)
                    ),
                    }
            )
        return components

    def _components_without_catalog(self) -> list[dict[str, object]]:
        components: list[dict[str, object]] = []
        for component, ids in _RUNTIME_COMPONENT_IDS.items():
            active = None
            for component_id in ids:
                active = self.component_store.active(component_id)
                if active is not None:
                    break
            components.append(
                {
                    "component": component,
                    "available": False,
                    "installed": active is not None,
                    "installedVersion": active[0].version if active else None,
                    "updateAvailable": False,
                }
            )
        return components

    async def start(self, component: str, *, repair: bool = False) -> RuntimeInstallJob:
        if self.installer is None:
            raise RuntimeInstallUnavailableError(self.unavailable_reason)
        normalized = component.strip().lower()
        kind = RUNTIME_KINDS.get(normalized)
        if kind is None:
            raise ValueError("unknown runtime resource")
        catalog = await self.catalog_client.fetch()
        entry = self._latest(catalog, kind)
        if entry is None:
            raise ValueError(f"{normalized} runtime is unavailable for this device")
        return self._start_job(
            normalized,
            [f"{entry.id}@{entry.version}"],
            total_bytes=self._dependency_bytes(catalog, entry, missing_only=not repair),
            repair=repair,
        )

    async def ensure_packs(self, component: str, refs: list[str]) -> RuntimeInstallJob:
        """Install exact packs for a feature and wait without tying the job to its caller."""
        if not self.auto_download_enabled():
            raise RuntimeAutoDownloadDisabledError(
                "需要先下载高级功能内容，请在设置的“高级功能”中下载，或开启“需要时自动下载”"
            )
        if self.installer is None:
            raise RuntimeInstallUnavailableError(self.unavailable_reason)
        normalized_refs = list(dict.fromkeys(ref.strip() for ref in refs if ref.strip()))
        if not normalized_refs:
            raise ValueError("at least one runtime pack is required")
        catalog = await self.catalog_client.fetch()
        total_bytes = 0
        for ref in normalized_refs:
            component_id, version = parse_runtime_pack_ref(ref)
            entry = self._select(catalog, component_id, version)
            total_bytes += entry.size
        job = self._start_job(
            component.strip().lower(),
            normalized_refs,
            total_bytes=total_bytes,
            repair=False,
        )
        return await self._wait_for_job(job)

    async def ensure(self, component: str) -> RuntimeInstallJob:
        """Ensure the latest compatible resource required by a product feature."""
        job = await self.start_required(component)
        return await self._wait_for_job(job)

    async def start_required(self, component: str) -> RuntimeInstallJob:
        """Start an automatic feature download while respecting user settings."""
        if not self.auto_download_enabled():
            raise RuntimeAutoDownloadDisabledError(
                "需要先下载高级功能内容，请在设置的“高级功能”中下载，或开启“需要时自动下载”"
            )
        return await self.start(component)

    async def _wait_for_job(self, job: RuntimeInstallJob) -> RuntimeInstallJob:
        task = self._tasks.get(job.job_id)
        if task is not None:
            await asyncio.shield(task)
        finished = self.get(job.job_id)
        if finished.state != "completed":
            raise RuntimeError(finished.error or "高级功能内容下载失败")
        return finished

    def _start_job(
        self,
        component: str,
        refs: list[str],
        *,
        total_bytes: int,
        repair: bool,
    ) -> RuntimeInstallJob:
        if not component:
            raise ValueError("component is required")
        pack_ref = refs[0]
        for job in self._jobs.values():
            existing_refs = job.pack_refs or [job.pack_ref]
            if existing_refs == refs and job.state in {"queued", "running"}:
                return job.model_copy(deep=True)
        now = _now_ms()
        job = RuntimeInstallJob(
            jobId=uuid.uuid4().hex,
            component=component,
            packRef=pack_ref,
            packRefs=refs,
            repair=repair,
            state="queued",
            totalBytes=total_bytes,
            createdAt=now,
            updatedAt=now,
        )
        self._jobs[job.job_id] = job
        self._tasks[job.job_id] = asyncio.create_task(self._run(job.job_id))
        self._prune()
        self._persist(force=True)
        return job.model_copy(deep=True)

    def get(self, job_id: str) -> RuntimeInstallJob:
        try:
            return self._jobs[job_id].model_copy(deep=True)
        except KeyError as exc:
            raise KeyError("runtime install job not found") from exc

    def list(self) -> list[RuntimeInstallJob]:
        return [
            job.model_copy(deep=True)
            for job in sorted(self._jobs.values(), key=lambda item: item.created_at, reverse=True)
        ]

    async def cancel(self, job_id: str) -> RuntimeInstallJob:
        job = self._jobs.get(job_id)
        task = self._tasks.get(job_id)
        if job is None:
            raise KeyError("runtime install job not found")
        if task is None or task.done() or job.state not in {"queued", "running"}:
            raise ValueError("runtime install job is not running")
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return self.get(job_id)

    async def _run(self, job_id: str) -> None:
        job = self._jobs[job_id]
        installer = self.installer
        if installer is None:
            return

        try:
            async with self._install_lock:
                job.state = "running"
                job.stage = "downloading"
                job.updated_at = _now_ms()
                self._persist(force=True)

                component_progress: dict[str, tuple[int, int]] = {}

                def progress(ref: str, current: int, total: int) -> None:
                    component_progress[ref] = (max(0, current), max(0, total))
                    job.downloaded_bytes = sum(row[0] for row in component_progress.values())
                    job.total_bytes = max(
                        job.total_bytes,
                        sum(row[1] for row in component_progress.values()),
                    )
                    job.updated_at = _now_ms()
                    self._persist()

                await installer.ensure_packs(
                    job.pack_refs or [job.pack_ref],
                    progress,
                    force=job.repair,
                )
                job.state = "completed"
                job.stage = "ready"
                job.downloaded_bytes = job.total_bytes
        except asyncio.CancelledError:
            job.state = "cancelled"
            job.stage = "cancelled"
            job.error = "安装已取消，可稍后继续下载"
        except Exception as exc:
            job.state = "failed"
            job.stage = "failed"
            job.error = str(exc)[:2_000]
        finally:
            job.updated_at = _now_ms()
            job.finished_at = job.updated_at
            self._persist(force=True)

    def cleanup(self) -> dict[str, int]:
        """Remove download caches and old inactive versions, never active components."""
        if any(job.state in {"queued", "running"} for job in self._jobs.values()):
            raise ValueError("请等待当前下载完成或先取消下载")
        legacy = self.cleanup_legacy() if self.cleanup_legacy is not None else {}
        freed_bytes = 0
        removed_downloads = 0
        if self.cache_dir.is_dir():
            for path in self.cache_dir.rglob("*"):
                if not path.is_file() or not (
                    path.name.endswith(".zip") or path.name.endswith(".part")
                ):
                    continue
                try:
                    size = path.stat().st_size
                    path.unlink()
                    freed_bytes += size
                    removed_downloads += 1
                except OSError:
                    continue
        removed_versions = 0
        components_root = self.component_store.root / "components"
        if components_root.is_dir():
            for component_root in components_root.iterdir():
                if not component_root.is_dir():
                    continue
                try:
                    before = _tree_bytes(component_root)
                    removed = self.component_store.prune_inactive(component_root.name, keep=2)
                    after = _tree_bytes(component_root)
                except (OSError, ValueError):
                    continue
                removed_versions += len(removed)
                freed_bytes += max(0, before - after)
        return {
            "removedDownloads": removed_downloads,
            "removedVersions": removed_versions,
            "freedBytes": freed_bytes,
            "removedLegacyBytes": legacy.get("removedLegacyBytes", 0),
        }

    def _latest(self, catalog: RuntimeCatalog, kind: str) -> RuntimeCatalogEntry | None:
        candidates = [
            entry
            for entry in catalog.components
            if entry.kind == kind
            and (not entry.platforms or self.current_platform in entry.platforms)
            and (not entry.architectures or self.current_architecture in entry.architectures)
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda entry: _version_key(entry.version))

    def _select(
        self, catalog: RuntimeCatalog, component_id: str, version: str
    ) -> RuntimeCatalogEntry:
        for entry in catalog.components:
            if entry.id != component_id or entry.version != version:
                continue
            if entry.platforms and self.current_platform not in entry.platforms:
                continue
            if entry.architectures and self.current_architecture not in entry.architectures:
                continue
            return entry
        raise ValueError(f"runtime component unavailable for this device: {component_id}@{version}")

    def _dependency_bytes(
        self,
        catalog: RuntimeCatalog,
        entry: RuntimeCatalogEntry,
        *,
        missing_only: bool = False,
        seen: set[str] | None = None,
    ) -> int:
        seen = seen or set()
        ref = f"{entry.id}@{entry.version}"
        if ref in seen:
            return 0
        seen.add(ref)
        active = self.component_store.active(entry.id)
        total = (
            0
            if missing_only and active is not None and active[0].version == entry.version
            else entry.size
        )
        for dependency in entry.dependencies:
            component_id, version = parse_runtime_pack_ref(dependency)
            total += self._dependency_bytes(
                catalog,
                self._select(catalog, component_id, version),
                missing_only=missing_only,
                seen=seen,
            )
        return total

    def _load(self) -> None:
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        rows = payload.get("jobs") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            return
        recovered = False
        for raw in rows[-50:]:
            try:
                job = RuntimeInstallJob.model_validate(raw)
            except ValueError:
                continue
            if job.state in {"queued", "running"}:
                recovered = True
                job.state = "failed"
                job.stage = "failed"
                job.error = "应用在安装完成前退出，可重新开始并断点续传"
                job.updated_at = _now_ms()
                job.finished_at = job.updated_at
            self._jobs[job.job_id] = job
        if recovered:
            self._persist(force=True)

    def _persist(self, *, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_persisted < 0.5:
            return
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.state_path) + ".lock", timeout=30):
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.state_path.name}.", dir=self.state_path.parent
            )
            temporary = Path(temporary_name)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                    json.dump(
                        {
                            "schemaVersion": 1,
                            "jobs": [
                                job.model_dump(by_alias=True, mode="json")
                                for job in self._jobs.values()
                            ],
                        },
                        handle,
                        ensure_ascii=False,
                        indent=2,
                        sort_keys=True,
                    )
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.state_path)
                self._last_persisted = now
            finally:
                temporary.unlink(missing_ok=True)

    def _prune(self) -> None:
        terminal = sorted(
            (job for job in self._jobs.values() if job.finished_at is not None),
            key=lambda item: item.updated_at,
            reverse=True,
        )
        for stale in terminal[50:]:
            self._jobs.pop(stale.job_id, None)
            self._tasks.pop(stale.job_id, None)


def _architecture() -> str:
    value = platform.machine().lower()
    return {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(value, value)


def _version_key(value: str) -> tuple[int, object]:
    try:
        return 1, Version(value)
    except InvalidVersion:
        return 0, value


def _newer(candidate: str, current: str) -> bool:
    try:
        return Version(candidate) > Version(current)
    except InvalidVersion:
        return candidate > current


def _now_ms() -> int:
    return int(time.time() * 1_000)


def _tree_bytes(root: Path) -> int:
    total = 0
    for path in root.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except OSError:
            continue
    return total


__all__ = [
    "RuntimeInstallJob",
    "RuntimeInstallJobManager",
    "RuntimeInstallUnavailableError",
    "RuntimeAutoDownloadDisabledError",
]
