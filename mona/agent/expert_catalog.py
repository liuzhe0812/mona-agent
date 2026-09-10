"""Remote expert catalog retrieval with validated atomic offline cache."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import httpx
from filelock import FileLock
from pydantic import field_validator

from mona.agent.package_store import ExpertCatalog
from mona.config.schema import Base
from mona.security.network import validate_url_target

DEFAULT_CATALOG_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_REDIRECT_LIMIT = 5


class ExpertCatalogError(RuntimeError):
    """Raised when neither a remote nor cached expert catalog is usable."""


class ExpertCatalogCache(Base):
    """Validated catalog plus HTTP metadata for offline startup."""

    schema_version: int = 1
    fetched_at: str
    source_url: str
    etag: str | None = None
    catalog: ExpertCatalog

    @field_validator("schema_version")
    @classmethod
    def _validate_schema_version(cls, value: int) -> int:
        if value != 1:
            raise ValueError(f"unsupported expert catalog cache schema version {value}")
        return value


@dataclass(frozen=True, slots=True)
class ExpertCatalogSnapshot:
    catalog: ExpertCatalog
    source: str
    source_url: str
    fetched_at: str
    stale: bool


class ExpertCatalogClient:
    """Fetch a bounded catalog from primary/fallback URLs and cache it atomically."""

    def __init__(
        self,
        urls: list[str],
        cache_path: Path,
        *,
        timeout_seconds: float = 15.0,
        max_bytes: int = DEFAULT_CATALOG_MAX_BYTES,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not urls:
            raise ValueError("at least one expert catalog URL is required")
        self.urls = list(dict.fromkeys(urls))
        self.cache_path = cache_path
        self.timeout_seconds = timeout_seconds
        self.max_bytes = max_bytes
        self.transport = transport

    async def fetch(self, *, allow_stale: bool = True) -> ExpertCatalogSnapshot:
        cached = self.load_cached()
        errors: list[str] = []
        async with httpx.AsyncClient(
            timeout=self.timeout_seconds,
            follow_redirects=False,
            transport=self.transport,
        ) as client:
            for url in self.urls:
                try:
                    cache = await self._fetch_one(client, url, cached)
                    self._write_cache(cache)
                    return ExpertCatalogSnapshot(
                        catalog=cache.catalog,
                        source="remote",
                        source_url=cache.source_url,
                        fetched_at=cache.fetched_at,
                        stale=False,
                    )
                except Exception as exc:
                    errors.append(f"{url}: {exc}")
        if allow_stale and cached is not None:
            return ExpertCatalogSnapshot(
                catalog=cached.catalog,
                source="cache",
                source_url=cached.source_url,
                fetched_at=cached.fetched_at,
                stale=True,
            )
        raise ExpertCatalogError("expert catalog unavailable: " + "; ".join(errors))

    def load_cached(self) -> ExpertCatalogCache | None:
        try:
            if self.cache_path.stat().st_size > self.max_bytes:
                return None
            return ExpertCatalogCache.model_validate_json(
                self.cache_path.read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return None

    async def _fetch_one(
        self,
        client: httpx.AsyncClient,
        url: str,
        cached: ExpertCatalogCache | None,
    ) -> ExpertCatalogCache:
        current = url
        headers: dict[str, str] = {"Accept": "application/json"}
        if cached is not None and cached.source_url == url and cached.etag:
            headers["If-None-Match"] = cached.etag
        for _ in range(DEFAULT_REDIRECT_LIMIT + 1):
            ok, error = validate_url_target(current)
            if not ok:
                raise ExpertCatalogError(f"catalog URL blocked: {error}")
            response = await client.get(current, headers=headers)
            if response.status_code == 304:
                if cached is None:
                    raise ExpertCatalogError("catalog returned 304 without a usable cache")
                return cached.model_copy(
                    update={"fetched_at": datetime.now(timezone.utc).isoformat()}
                )
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise ExpertCatalogError("catalog redirect has no location")
                current = urljoin(current, location)
                headers.pop("If-None-Match", None)
                continue
            response.raise_for_status()
            length = response.headers.get("content-length")
            if length and int(length) > self.max_bytes:
                raise ExpertCatalogError("expert catalog exceeds size limit")
            payload = await response.aread()
            if len(payload) > self.max_bytes:
                raise ExpertCatalogError("expert catalog exceeds size limit")
            try:
                catalog = ExpertCatalog.model_validate_json(payload)
            except ValueError as exc:
                raise ExpertCatalogError(f"invalid expert catalog: {exc}") from exc
            if cached is not None and _catalog_time(catalog.generated_at) < _catalog_time(
                cached.catalog.generated_at
            ):
                raise ExpertCatalogError("expert catalog rollback was rejected")
            return ExpertCatalogCache(
                fetchedAt=datetime.now(timezone.utc).isoformat(),
                sourceUrl=current,
                etag=response.headers.get("etag"),
                catalog=catalog,
            )
        raise ExpertCatalogError("expert catalog redirect limit exceeded")

    def _write_cache(self, cache: ExpertCatalogCache) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self.cache_path) + ".lock", timeout=30):
            fd, temporary_name = tempfile.mkstemp(
                prefix=f".{self.cache_path.name}.",
                dir=self.cache_path.parent,
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


def _catalog_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ExpertCatalogError("catalog generatedAt is invalid") from exc
    if parsed.tzinfo is None:
        raise ExpertCatalogError("catalog generatedAt must include a timezone")
    return parsed


__all__ = [
    "ExpertCatalogCache",
    "ExpertCatalogClient",
    "ExpertCatalogError",
    "ExpertCatalogSnapshot",
]
