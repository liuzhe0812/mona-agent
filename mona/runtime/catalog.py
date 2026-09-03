"""Official runtime component catalog and installer."""

from __future__ import annotations

import asyncio
import json
import os
import platform
import sys
import tempfile
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import httpx
from filelock import FileLock
from loguru import logger
from pydantic import AnyHttpUrl, Field, field_validator

from mona.config.schema import Base
from mona.runtime.download import VerifiedDownloader
from mona.runtime.manager import (
    RuntimeComponentManifest,
    RuntimeComponentStore,
    RuntimeManagerError,
    parse_runtime_pack_ref,
)
from mona.runtime.python_env import PythonEnvironmentBuilder
from mona.security.network import validate_url_target


class RuntimeCatalogError(RuntimeManagerError):
    """Raised when a runtime catalog or package cannot be trusted."""


class RuntimeCatalogEntry(Base):
    schema_version: int = 1
    id: str
    version: str
    kind: str
    download_url: AnyHttpUrl
    mirrors: list[AnyHttpUrl] = Field(default_factory=list)
    size: int = Field(gt=0)
    sha256: str
    dependencies: list[str] = Field(default_factory=list)
    platforms: list[str] = Field(default_factory=list)
    architectures: list[str] = Field(default_factory=list)

    @field_validator("schema_version")
    @classmethod
    def _schema(cls, value: int) -> int:
        if value != 1:
            raise ValueError(f"unsupported runtime catalog entry schema {value}")
        return value

    @field_validator("id")
    @classmethod
    def _id(cls, value: str) -> str:
        return RuntimeComponentManifest._validate_id(value)

    @field_validator("version")
    @classmethod
    def _version(cls, value: str) -> str:
        return RuntimeComponentManifest._validate_version(value)

    @field_validator("sha256")
    @classmethod
    def _sha256(cls, value: str) -> str:
        value = value.strip().lower()
        if len(value) != 64 or any(ch not in "0123456789abcdef" for ch in value):
            raise ValueError("runtime sha256 must be 64 lowercase hex characters")
        return value

    @field_validator("dependencies")
    @classmethod
    def _dependencies(cls, values: list[str]) -> list[str]:
        result: list[str] = []
        for value in values:
            parse_runtime_pack_ref(value)
            if value not in result:
                result.append(value)
        return result

    @field_validator("platforms", "architectures")
    @classmethod
    def _dedupe(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))


class RuntimeCatalog(Base):
    schema_version: int = 1
    generated_at: str
    components: list[RuntimeCatalogEntry] = Field(max_length=10_000)

    @field_validator("generated_at")
    @classmethod
    def _generated_at(cls, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("catalog generatedAt is invalid") from exc
        if parsed.tzinfo is None:
            raise ValueError("catalog generatedAt must include a timezone")
        return value

    @field_validator("components")
    @classmethod
    def _unique(cls, entries: list[RuntimeCatalogEntry]) -> list[RuntimeCatalogEntry]:
        seen: set[tuple[str, str, tuple[str, ...], tuple[str, ...]]] = set()
        for entry in entries:
            identity = (
                entry.id,
                entry.version,
                tuple(entry.platforms),
                tuple(entry.architectures),
            )
            if identity in seen:
                raise ValueError(f"duplicate runtime catalog entry {entry.id}@{entry.version}")
            seen.add(identity)
        return entries


class RuntimeCatalogCache(Base):
    schema_version: int = 1
    fetched_at: str
    source_url: str
    catalog: RuntimeCatalog


class RuntimeCatalogClient:
    def __init__(
        self,
        urls: list[str],
        cache_path: Path,
        *,
        max_bytes: int = 5 * 1024 * 1024,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not urls:
            raise ValueError("at least one runtime catalog URL is required")
        self.urls = list(dict.fromkeys(urls))
        self.cache_path = cache_path
        self.max_bytes = max_bytes
        self.transport = transport

    async def fetch(self) -> RuntimeCatalog:
        errors: list[str] = []
        cached = self.load_cached()
        async with httpx.AsyncClient(
            timeout=15,
            follow_redirects=False,
            transport=self.transport,
        ) as client:
            for original in self.urls:
                current = original
                try:
                    for _ in range(6):
                        ok, error = validate_url_target(current)
                        if not ok:
                            raise RuntimeCatalogError(f"runtime catalog URL blocked: {error}")
                        response = await client.get(current, headers={"Accept": "application/json"})
                        if response.is_redirect:
                            location = response.headers.get("location")
                            if not location:
                                raise RuntimeCatalogError(
                                    "runtime catalog redirect has no location"
                                )
                            current = urljoin(current, location)
                            continue
                        response.raise_for_status()
                        body = await response.aread()
                        if len(body) > self.max_bytes:
                            raise RuntimeCatalogError("runtime catalog exceeds size limit")
                        catalog = RuntimeCatalog.model_validate_json(body)
                        if cached is not None and _catalog_time(
                            catalog.generated_at
                        ) < _catalog_time(cached.catalog.generated_at):
                            raise RuntimeCatalogError("runtime catalog rollback was rejected")
                        self._write_cache(
                            RuntimeCatalogCache(
                                fetchedAt=datetime.now(timezone.utc).isoformat(),
                                sourceUrl=current,
                                catalog=catalog,
                            )
                        )
                        return catalog
                    raise RuntimeCatalogError("runtime catalog redirect limit exceeded")
                except Exception as exc:
                    errors.append(f"{original}: {exc}")
        if cached is not None:
            return cached.catalog
        raise RuntimeCatalogError("runtime catalog unavailable: " + "; ".join(errors))

    def load_cached(self) -> RuntimeCatalogCache | None:
        try:
            if self.cache_path.stat().st_size > self.max_bytes:
                return None
            return RuntimeCatalogCache.model_validate_json(
                self.cache_path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return None

    def _write_cache(self, cache: RuntimeCatalogCache) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.cache_path) + ".lock", timeout=30):
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.cache_path.name}.", dir=self.cache_path.parent
            )
            temporary = Path(temporary_name)
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                    json.dump(
                        cache.model_dump(by_alias=True, mode="json"),
                        handle,
                        ensure_ascii=False,
                        indent=2,
                        sort_keys=True,
                    )
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.cache_path)
            finally:
                temporary.unlink(missing_ok=True)


def _architecture() -> str:
    value = platform.machine().lower()
    return {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(value, value)


def _catalog_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RuntimeCatalogError("catalog generatedAt is invalid") from exc
    if parsed.tzinfo is None:
        raise RuntimeCatalogError("catalog generatedAt must include a timezone")
    return parsed


RuntimeProgress = Callable[[str, int, int], None]


class RuntimeInstaller:
    """Install an exact dependency closure from the official runtime catalog."""

    def __init__(
        self,
        *,
        catalog_client: RuntimeCatalogClient,
        downloader: VerifiedDownloader,
        store: RuntimeComponentStore,
        cache_dir: Path,
        python_environment_builder: PythonEnvironmentBuilder | None = None,
        current_platform: str = sys.platform,
        current_architecture: str | None = None,
    ) -> None:
        self.catalog_client = catalog_client
        self.downloader = downloader
        self.store = store
        self.cache_dir = cache_dir
        self.python_environment_builder = python_environment_builder or PythonEnvironmentBuilder(
            store.root, store, current_platform=current_platform
        )
        self.current_platform = current_platform
        self.current_architecture = current_architecture or _architecture()

    async def ensure_packs(
        self,
        refs: list[str],
        progress: RuntimeProgress | None = None,
        *,
        force: bool = False,
    ) -> None:
        catalog = await self.catalog_client.fetch()
        completed: set[str] = set()
        completed_order: list[str] = []
        visiting: set[str] = set()
        selected_versions: dict[str, str] = {}
        previous_versions: dict[str, str | None] = {}
        activation_order: list[str] = []

        def mark_completed(ref: str) -> None:
            if ref not in completed:
                completed.add(ref)
                completed_order.append(ref)

        async def ensure(ref: str) -> None:
            if ref in completed:
                return
            if ref in visiting:
                raise RuntimeCatalogError(f"runtime dependency cycle includes {ref}")
            component_id, version = parse_runtime_pack_ref(ref)
            selected = selected_versions.setdefault(component_id, version)
            if selected != version:
                raise RuntimeCatalogError(
                    f"runtime dependency version conflict: "
                    f"{component_id}@{selected} and {component_id}@{version}"
                )
            entry = self._select(catalog, component_id, version)
            visiting.add(ref)
            try:
                for dependency in entry.dependencies:
                    await ensure(dependency)
                active = self.store.active(component_id)
                if not force and active is not None and active[0].version == version:
                    mark_completed(ref)
                    return
                if progress:
                    progress(ref, 0, entry.size)
                destination = self.cache_dir / component_id / f"{version}.zip"
                await self.downloader.download(
                    [str(entry.download_url), *(str(url) for url in entry.mirrors)],
                    destination,
                    expected_sha256=entry.sha256,
                    expected_size=entry.size,
                    progress=(
                        (lambda current, total: progress(ref, current, total)) if progress else None
                    ),
                )
                manifest = self.store.install_archive(
                    destination,
                    activate=False,
                    replace=force,
                )
                if (
                    manifest.id != entry.id
                    or manifest.version != entry.version
                    or manifest.kind != entry.kind
                    or manifest.dependencies != entry.dependencies
                ):
                    raise RuntimeCatalogError(
                        f"runtime archive manifest does not match catalog: {ref}"
                    )
                if component_id not in previous_versions:
                    previous = self.store.active(component_id)
                    previous_versions[component_id] = (
                        previous[0].version if previous is not None else None
                    )
                    activation_order.append(component_id)
                self.store.activate(component_id, version)
                mark_completed(ref)
            finally:
                visiting.discard(ref)

        try:
            for ref in refs:
                await ensure(ref)

            python_refs: list[str] = []
            has_wheel_pack = False
            for ref in completed_order:
                component_id, version = parse_runtime_pack_ref(ref)
                active = self.store.active(component_id)
                if active is None or active[0].version != version:
                    raise RuntimeCatalogError(f"runtime activation was lost: {ref}")
                manifest = active[0]
                if "python" in manifest.entrypoints or manifest.python_requirements is not None:
                    python_refs.append(ref)
                if manifest.python_requirements is not None:
                    has_wheel_pack = True
            if has_wheel_pack:
                await self.python_environment_builder.ensure(python_refs)
            for component_id in selected_versions:
                try:
                    self.store.prune_inactive(component_id)
                except Exception as exc:
                    logger.warning(
                        "failed to prune old runtime versions for {}: {}",
                        component_id,
                        exc,
                    )
        except (Exception, asyncio.CancelledError) as install_error:
            rollback_errors: list[str] = []
            for component_id in reversed(activation_order):
                try:
                    previous_version = previous_versions[component_id]
                    if previous_version is None:
                        self.store.deactivate(component_id)
                    else:
                        self.store.activate(component_id, previous_version)
                except Exception as rollback_error:
                    rollback_errors.append(f"{component_id}: {rollback_error}")
            if rollback_errors:
                raise RuntimeCatalogError(
                    "runtime install failed and rollback was incomplete: "
                    + "; ".join(rollback_errors)
                ) from install_error
            raise

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
        raise RuntimeCatalogError(
            f"runtime component unavailable for this platform: {component_id}@{version}"
        )


__all__ = [
    "RuntimeCatalog",
    "RuntimeCatalogClient",
    "RuntimeCatalogEntry",
    "RuntimeCatalogError",
    "RuntimeInstaller",
]
