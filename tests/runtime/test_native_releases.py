"""Official release metadata mapping for native coding engines."""

from __future__ import annotations

import httpx
import pytest

import mona.runtime.native_releases as native_releases
from mona.runtime.catalog import RuntimeCatalogError


@pytest.fixture(autouse=True)
def allow_release_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(native_releases, "validate_url_target", lambda _url: (True, ""))


async def test_claude_release_metadata_maps_version_size_and_checksum() -> None:
    checksum = "a" * 64
    requests: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        if str(request.url) == f"{native_releases.CLAUDE_RELEASES}/stable":
            return httpx.Response(200, content=b"1.2.3\n", request=request)
        return httpx.Response(
            200,
            json={
                "version": "1.2.3",
                "platforms": {
                    "win32-x64": {"binary": "claude.exe", "checksum": checksum, "size": 1234}
                },
            },
            request=request,
        )

    entry = await native_releases.native_release_entry(
        "claude",
        current_platform="win32",
        current_architecture="x64",
        transport=httpx.MockTransport(respond),
    )

    assert requests == [
        f"{native_releases.CLAUDE_RELEASES}/stable",
        f"{native_releases.CLAUDE_RELEASES}/1.2.3/manifest.json",
    ]
    assert (entry.id, entry.kind, entry.version) == (
        "claude-code-cli",
        "claude-code-runtime",
        "1.2.3+win32.x64",
    )
    assert (entry.size, entry.sha256, entry.artifact_format, entry.native_entrypoint) == (
        1234,
        checksum,
        "native-binary",
        "claude.exe",
    )


async def test_codebuddy_release_metadata_maps_checksum_and_head_size() -> None:
    checksum = "b" * 64
    filename = "codebuddy-code_Windows_x86_64.zip"
    requests: list[tuple[str, str]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, str(request.url)))
        if str(request.url) == f"{native_releases.CODEBUDDY_RELEASES}/latest":
            return httpx.Response(200, content=b"2.3.4", request=request)
        if str(request.url).endswith("/checksums.txt"):
            return httpx.Response(
                200,
                content=f"{checksum}  {filename}\n{'c' * 64}  other.zip\n".encode(),
                request=request,
            )
        return httpx.Response(
            200,
            headers={"content-length": "5678"},
            request=request,
        )

    entry = await native_releases.native_release_entry(
        "codebuddy",
        current_platform="win32",
        current_architecture="x64",
        transport=httpx.MockTransport(respond),
    )

    assert [method for method, _url in requests] == ["GET", "GET", "HEAD"]
    assert requests[-1][1].endswith(f"/download/2.3.4/{filename}")
    assert (entry.id, entry.kind, entry.version) == (
        "codebuddy-cli",
        "codebuddy-runtime",
        "2.3.4+win32.x64",
    )
    assert (entry.size, entry.sha256, entry.artifact_format, entry.native_entrypoint) == (
        5678,
        checksum,
        "native-zip",
        "codebuddy.exe",
    )


async def test_codex_release_metadata_selects_platform_asset_digest_and_size() -> None:
    checksum = "d" * 64
    filename = "codex-package-x86_64-pc-windows-msvc-0.147.0.tar.gz"
    requests: list[str] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(
            200,
            json={
                "tag_name": "rust-v0.147.0",
                "assets": [
                    {
                        "name": "codex-package-other-platform.tar.gz",
                        "browser_download_url": "https://fixture.example/other.tar.gz",
                        "digest": "sha256:" + "e" * 64,
                        "size": 50,
                    },
                    {
                        "name": filename,
                        "browser_download_url": "https://fixture.example/codex.tar.gz",
                        "digest": "sha256:" + checksum,
                        "size": 9876,
                    },
                ],
            },
            request=request,
        )

    entry = await native_releases.native_release_entry(
        "codex",
        current_platform="win32",
        current_architecture="x64",
        transport=httpx.MockTransport(respond),
    )

    assert requests == [native_releases.CODEX_RELEASE]
    assert (entry.id, entry.kind, entry.version) == (
        "codex-cli",
        "codex-runtime",
        "0.147.0+win32.x64",
    )
    assert (str(entry.download_url), entry.size, entry.sha256) == (
        "https://fixture.example/codex.tar.gz",
        9876,
        checksum,
    )
    assert (entry.artifact_format, entry.native_entrypoint) == ("native-tar-gz", "bin/codex.exe")


async def test_native_release_redirect_to_private_address_is_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[str] = []

    def validate(url: str) -> tuple[bool, str]:
        return (not url.startswith("http://127.0.0.1/"), "private address")

    monkeypatch.setattr(native_releases, "validate_url_target", validate)

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1/private"}, request=request)

    with pytest.raises(RuntimeCatalogError, match="发行地址不可访问"):
        await native_releases.native_release_entry(
            "codex",
            current_platform="win32",
            current_architecture="x64",
            transport=httpx.MockTransport(respond),
        )

    assert requests == [native_releases.CODEX_RELEASE]


async def test_native_release_rejects_unsupported_platform_without_requests(
) -> None:
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={}, request=request)

    for current_platform, current_architecture in (("freebsd", "x64"), ("win32", "riscv64")):
        with pytest.raises(RuntimeCatalogError, match="暂未提供"):
            await native_releases.native_release_entry(
                "codex",
                current_platform=current_platform,
                current_architecture=current_architecture,
                transport=httpx.MockTransport(respond),
            )

    assert requests == []
