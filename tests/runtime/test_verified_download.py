"""Verified expert/runtime download transport tests."""

from __future__ import annotations

import hashlib
from pathlib import Path

import httpx
import pytest

import mona.runtime.download as download_module
from mona.runtime.download import VerifiedDownloader, VerifiedDownloadError


@pytest.fixture(autouse=True)
def allow_test_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(download_module, "validate_url_target", lambda _url: (True, ""))


async def test_downloads_and_verifies_bytes(tmp_path: Path) -> None:
    payload = b"verified package bytes"
    progress: list[tuple[int, int]] = []
    downloader = VerifiedDownloader(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=payload, request=request)
        )
    )

    result = await downloader.download(
        ["https://cdn.example.test/package.zip"],
        tmp_path / "package.zip",
        expected_sha256=hashlib.sha256(payload).hexdigest(),
        expected_size=len(payload),
        progress=lambda current, total: progress.append((current, total)),
    )

    assert result.cached is False
    assert result.path.read_bytes() == payload
    assert progress[-1] == (len(payload), len(payload))


async def test_resumes_partial_download(tmp_path: Path) -> None:
    payload = b"0123456789"
    destination = tmp_path / "package.zip"
    destination.with_suffix(".zip.part").write_bytes(payload[:4])

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Range"] == "bytes=4-"
        return httpx.Response(
            206,
            content=payload[4:],
            headers={"Content-Range": "bytes 4-9/10"},
            request=request,
        )

    result = await VerifiedDownloader(
        transport=httpx.MockTransport(handler)
    ).download(
        ["https://cdn.example.test/package.zip"],
        destination,
        expected_sha256=hashlib.sha256(payload).hexdigest(),
        expected_size=len(payload),
    )

    assert result.path.read_bytes() == payload


async def test_falls_back_to_second_source(tmp_path: Path) -> None:
    payload = b"mirror payload"
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.host or "")
        if request.url.host == "primary.example.test":
            return httpx.Response(503, request=request)
        return httpx.Response(200, content=payload, request=request)

    result = await VerifiedDownloader(
        transport=httpx.MockTransport(handler)
    ).download(
        [
            "https://primary.example.test/package.zip",
            "https://fallback.example.test/package.zip",
        ],
        tmp_path / "package.zip",
        expected_sha256=hashlib.sha256(payload).hexdigest(),
        expected_size=len(payload),
    )

    assert result.source_url == "https://fallback.example.test/package.zip"
    assert seen == ["primary.example.test", "fallback.example.test"]


async def test_rejects_hash_mismatch_and_removes_bad_partial(tmp_path: Path) -> None:
    destination = tmp_path / "package.zip"
    downloader = VerifiedDownloader(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=b"bad", request=request)
        )
    )

    with pytest.raises(VerifiedDownloadError, match="sha256 mismatch"):
        await downloader.download(
            ["https://cdn.example.test/package.zip"],
            destination,
            expected_sha256=hashlib.sha256(b"good").hexdigest(),
            expected_size=3,
        )

    assert not destination.exists()
    assert not destination.with_suffix(".zip.part").exists()


async def test_revalidates_redirect_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        download_module,
        "validate_url_target",
        lambda url: (False, "private") if "127.0.0.1" in url else (True, ""),
    )
    downloader = VerifiedDownloader(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                302,
                headers={"Location": "http://127.0.0.1/package.zip"},
                request=request,
            )
        )
    )

    with pytest.raises(VerifiedDownloadError, match="blocked"):
        await downloader.download(
            ["https://cdn.example.test/package.zip"],
            tmp_path / "package.zip",
            expected_sha256="0" * 64,
            expected_size=1,
        )


async def test_uses_verified_cached_destination_without_network(tmp_path: Path) -> None:
    payload = b"cached"
    destination = tmp_path / "package.zip"
    destination.write_bytes(payload)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500, request=request)

    result = await VerifiedDownloader(
        transport=httpx.MockTransport(handler)
    ).download(
        ["https://cdn.example.test/package.zip"],
        destination,
        expected_sha256=hashlib.sha256(payload).hexdigest(),
        expected_size=len(payload),
    )

    assert result.cached is True
    assert calls == 0
