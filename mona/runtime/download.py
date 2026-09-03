"""Verified resumable downloads shared by runtime and expert package installers."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin

import httpx
from filelock import FileLock, Timeout

from mona.security.network import validate_url_target

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_CONTENT_RANGE_RE = re.compile(r"^bytes\s+(\d+)-(\d+)/(\d+|\*)$")
_CHUNK_SIZE = 1024 * 1024


class VerifiedDownloadError(RuntimeError):
    """Raised when all download sources fail verification or transport."""


@dataclass(frozen=True, slots=True)
class VerifiedDownloadResult:
    path: Path
    source_url: str | None
    bytes: int
    sha256: str
    cached: bool


ProgressCallback = Callable[[int, int], None]


async def _acquire_file_lock(lock: FileLock, timeout_seconds: float) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        try:
            lock.acquire(timeout=0)
            return
        except Timeout:
            if asyncio.get_running_loop().time() >= deadline:
                raise
            await asyncio.sleep(0.05)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


class VerifiedDownloader:
    """Download immutable bytes with mirrors, resume, SSRF checks and SHA-256."""

    def __init__(
        self,
        *,
        connect_timeout_seconds: float = 30.0,
        read_timeout_seconds: float = 60.0,
        redirect_limit: int = 5,
        lock_timeout_seconds: float = 120.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.timeout = httpx.Timeout(
            connect=connect_timeout_seconds,
            read=read_timeout_seconds,
            write=read_timeout_seconds,
            pool=connect_timeout_seconds,
        )
        self.redirect_limit = redirect_limit
        self.lock_timeout_seconds = lock_timeout_seconds
        self.transport = transport

    async def download(
        self,
        urls: list[str],
        destination: Path,
        *,
        expected_sha256: str,
        expected_size: int,
        progress: ProgressCallback | None = None,
    ) -> VerifiedDownloadResult:
        if not urls:
            raise ValueError("at least one download URL is required")
        digest = expected_sha256.strip().lower()
        if not _SHA256_RE.fullmatch(digest):
            raise ValueError("expected_sha256 must be 64 lowercase hex characters")
        if expected_size <= 0:
            raise ValueError("expected_size must be positive")
        destination.parent.mkdir(parents=True, exist_ok=True)
        lock = FileLock(str(destination) + ".download.lock")
        await _acquire_file_lock(lock, self.lock_timeout_seconds)
        try:
            cached = self._verified_existing(destination, expected_size, digest)
            if cached:
                if progress:
                    progress(expected_size, expected_size)
                return VerifiedDownloadResult(
                    path=destination,
                    source_url=None,
                    bytes=expected_size,
                    sha256=digest,
                    cached=True,
                )

            part = destination.with_suffix(destination.suffix + ".part")
            if part.is_file() and part.stat().st_size > expected_size:
                part.unlink(missing_ok=True)
            errors: list[str] = []
            async with httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=False,
                transport=self.transport,
            ) as client:
                for url in dict.fromkeys(urls):
                    try:
                        final_url = await self._download_one(
                            client,
                            url,
                            part,
                            expected_size,
                            progress,
                        )
                        actual_size = part.stat().st_size
                        if actual_size != expected_size:
                            raise VerifiedDownloadError(
                                f"download size mismatch: expected {expected_size}, got {actual_size}"
                            )
                        actual_hash = await asyncio.to_thread(_sha256, part)
                        if actual_hash != digest:
                            part.unlink(missing_ok=True)
                            raise VerifiedDownloadError(
                                f"download sha256 mismatch: expected {digest}, got {actual_hash}"
                            )
                        os.replace(part, destination)
                        return VerifiedDownloadResult(
                            path=destination,
                            source_url=final_url,
                            bytes=actual_size,
                            sha256=actual_hash,
                            cached=False,
                        )
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        errors.append(f"{url}: {exc}")
            raise VerifiedDownloadError("all download sources failed: " + "; ".join(errors))
        finally:
            lock.release()

    @staticmethod
    def _verified_existing(path: Path, expected_size: int, expected_hash: str) -> bool:
        return (
            path.is_file()
            and path.stat().st_size == expected_size
            and _sha256(path) == expected_hash
        )

    async def _download_one(
        self,
        client: httpx.AsyncClient,
        url: str,
        part: Path,
        expected_size: int,
        progress: ProgressCallback | None,
    ) -> str:
        current = url
        existing = part.stat().st_size if part.is_file() else 0
        headers = {"Range": f"bytes={existing}-"} if existing else {}
        for _ in range(self.redirect_limit + 1):
            ok, error = validate_url_target(current)
            if not ok:
                raise VerifiedDownloadError(f"download URL blocked: {error}")
            async with client.stream("GET", current, headers=headers) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise VerifiedDownloadError("download redirect has no location")
                    current = urljoin(current, location)
                    continue
                if response.status_code not in (200, 206):
                    raise VerifiedDownloadError(f"download returned HTTP {response.status_code}")
                resumed = existing > 0 and response.status_code == 206
                if resumed:
                    content_range = response.headers.get("content-range", "")
                    match = _CONTENT_RANGE_RE.fullmatch(content_range)
                    if not match or int(match.group(1)) != existing:
                        raise VerifiedDownloadError("invalid Content-Range for resumed download")
                    if match.group(3) != "*" and int(match.group(3)) != expected_size:
                        raise VerifiedDownloadError("resumed download total size mismatch")
                else:
                    existing = 0
                content_length = response.headers.get("content-length")
                if content_length:
                    projected = existing + int(content_length)
                    if projected > expected_size:
                        raise VerifiedDownloadError("download exceeds declared size")
                downloaded = existing
                if progress:
                    progress(downloaded, expected_size)
                with part.open("ab" if resumed else "wb") as output:
                    async for chunk in response.aiter_bytes(_CHUNK_SIZE):
                        downloaded += len(chunk)
                        if downloaded > expected_size:
                            raise VerifiedDownloadError("download exceeds declared size")
                        output.write(chunk)
                        if progress:
                            progress(downloaded, expected_size)
                    output.flush()
                    os.fsync(output.fileno())
                return current
        raise VerifiedDownloadError("download redirect limit exceeded")


__all__ = [
    "VerifiedDownloadError",
    "VerifiedDownloadResult",
    "VerifiedDownloader",
]
