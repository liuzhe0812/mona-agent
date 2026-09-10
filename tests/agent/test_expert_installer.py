"""Official expert install pipeline tests."""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import httpx
import pytest

import mona.agent.expert_catalog as catalog_module
import mona.runtime.download as download_module
from mona.agent.expert_catalog import ExpertCatalogClient
from mona.agent.expert_installer import ExpertInstaller, ExpertInstallError
from mona.agent.package_store import AgentPackageStore
from mona.runtime.download import VerifiedDownloader

AGENT_ID = "com.example.catalog-expert"


def _archive(tmp_path: Path, version: str = "1.0.0") -> tuple[Path, bytes]:
    path = tmp_path / f"expert-{version}.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(
            f"{AGENT_ID}/agent.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": AGENT_ID,
                    "displayName": "Catalog Expert",
                    "prompt": "prompt.md",
                    "toolAllowlist": ["read_file"],
                    "packageId": AGENT_ID,
                    "packageVersion": version,
                }
            ),
        )
        bundle.writestr(
            f"{AGENT_ID}/package-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "agentId": AGENT_ID,
                    "version": version,
                    "requiredTools": ["read_file"],
                    "runtimePacks": ["python-base@3.12"],
                }
            ),
        )
        bundle.writestr(f"{AGENT_ID}/prompt.md", "Catalog expert prompt.")
    return path, path.read_bytes()


def _catalog_entry(payload: bytes, digest: str, *, min_version: str = "1.0.0") -> dict:
    return {
        "schemaVersion": 1,
        "generatedAt": "2026-08-29T00:00:00Z",
        "experts": [
            {
                "schemaVersion": 1,
                "id": AGENT_ID,
                "displayName": "Catalog Expert",
                "version": "1.0.0",
                "minMonaVersion": min_version,
                "downloadUrl": "https://cdn.example.test/expert.zip",
                "mirrors": ["https://backup.example.test/expert.zip"],
                "size": len(payload),
                "sha256": digest,
                "requiredTools": ["read_file"],
                "runtimePacks": ["python-base@3.12"],
                "platforms": ["win32"],
                "architectures": ["x64"],
            }
        ],
    }


@pytest.fixture(autouse=True)
def allow_test_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(catalog_module, "validate_url_target", lambda _url: (True, ""))
    monkeypatch.setattr(download_module, "validate_url_target", lambda _url: (True, ""))


async def test_installs_runtime_then_activates_and_reloads(tmp_path: Path) -> None:
    _path, payload = _archive(tmp_path)
    digest = hashlib.sha256(payload).hexdigest()
    catalog = _catalog_entry(payload, digest)

    def transport(request: httpx.Request) -> httpx.Response:
        if request.url.host == "catalog.example.test":
            return httpx.Response(200, json=catalog, request=request)
        return httpx.Response(200, content=payload, request=request)

    runtime_calls: list[list[str]] = []
    reloads: list[bool] = []

    async def install_runtime(packs: list[str], _progress) -> None:
        runtime_calls.append(packs)

    installer = ExpertInstaller(
        catalog_client=ExpertCatalogClient(
            ["https://catalog.example.test/catalog.json"],
            tmp_path / "catalog-cache.json",
            transport=httpx.MockTransport(transport),
        ),
        downloader=VerifiedDownloader(transport=httpx.MockTransport(transport)),
        package_store=AgentPackageStore(tmp_path / "packages", known_tool_names={"read_file"}),
        download_cache_dir=tmp_path / "downloads",
        known_tool_names={"read_file"},
        runtime_pack_installer=install_runtime,
        registry_reload=lambda: reloads.append(True),
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )
    progress: list[str] = []

    result = await installer.install(AGENT_ID, progress=lambda event: progress.append(event.stage))

    assert result.package.activated is True
    assert runtime_calls == [["python-base@3.12"]]
    assert reloads == [True]
    assert progress[0] == "catalog"
    assert progress[-1] == "ready"


async def test_incompatible_client_stops_before_package_download(tmp_path: Path) -> None:
    _path, payload = _archive(tmp_path)
    digest = hashlib.sha256(payload).hexdigest()
    catalog = _catalog_entry(payload, digest, min_version="9.0.0")
    package_requests = 0

    def transport(request: httpx.Request) -> httpx.Response:
        nonlocal package_requests
        if request.url.host == "catalog.example.test":
            return httpx.Response(200, json=catalog, request=request)
        package_requests += 1
        return httpx.Response(200, content=payload, request=request)

    installer = ExpertInstaller(
        catalog_client=ExpertCatalogClient(
            ["https://catalog.example.test/catalog.json"],
            tmp_path / "catalog-cache.json",
            transport=httpx.MockTransport(transport),
        ),
        downloader=VerifiedDownloader(transport=httpx.MockTransport(transport)),
        package_store=AgentPackageStore(tmp_path / "packages"),
        download_cache_dir=tmp_path / "downloads",
        known_tool_names={"read_file"},
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )

    with pytest.raises(ExpertInstallError, match="requires Mona"):
        await installer.install(AGENT_ID)

    assert package_requests == 0


async def test_runtime_failure_never_activates_package(tmp_path: Path) -> None:
    _path, payload = _archive(tmp_path)
    digest = hashlib.sha256(payload).hexdigest()
    catalog = _catalog_entry(payload, digest)

    def transport(request: httpx.Request) -> httpx.Response:
        if request.url.host == "catalog.example.test":
            return httpx.Response(200, json=catalog, request=request)
        return httpx.Response(200, content=payload, request=request)

    async def fail_runtime(_packs: list[str], _progress) -> None:
        raise RuntimeError("runtime unavailable")

    store = AgentPackageStore(tmp_path / "packages")
    installer = ExpertInstaller(
        catalog_client=ExpertCatalogClient(
            ["https://catalog.example.test/catalog.json"],
            tmp_path / "catalog-cache.json",
            transport=httpx.MockTransport(transport),
        ),
        downloader=VerifiedDownloader(transport=httpx.MockTransport(transport)),
        package_store=store,
        download_cache_dir=tmp_path / "downloads",
        known_tool_names={"read_file"},
        runtime_pack_installer=fail_runtime,
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )

    with pytest.raises(RuntimeError, match="runtime unavailable"):
        await installer.install(AGENT_ID)

    assert store.active(AGENT_ID) is None


async def test_registry_reload_failure_rolls_back_activation(tmp_path: Path) -> None:
    _path, payload = _archive(tmp_path)
    digest = hashlib.sha256(payload).hexdigest()
    catalog = _catalog_entry(payload, digest)

    def transport(request: httpx.Request) -> httpx.Response:
        if request.url.host == "catalog.example.test":
            return httpx.Response(200, json=catalog, request=request)
        return httpx.Response(200, content=payload, request=request)

    async def install_runtime(_packs: list[str], _progress) -> None:
        return None

    reload_calls = 0

    def fail_reload() -> None:
        nonlocal reload_calls
        reload_calls += 1
        raise RuntimeError("reload failed")

    store = AgentPackageStore(tmp_path / "packages")
    installer = ExpertInstaller(
        catalog_client=ExpertCatalogClient(
            ["https://catalog.example.test/catalog.json"],
            tmp_path / "catalog-cache.json",
            transport=httpx.MockTransport(transport),
        ),
        downloader=VerifiedDownloader(transport=httpx.MockTransport(transport)),
        package_store=store,
        download_cache_dir=tmp_path / "downloads",
        known_tool_names={"read_file"},
        runtime_pack_installer=install_runtime,
        registry_reload=fail_reload,
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )

    with pytest.raises(ExpertInstallError, match="previous version restored"):
        await installer.install(AGENT_ID)

    assert store.active(AGENT_ID) is None
    assert reload_calls == 2
