"""Official expert install pipeline tests."""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import httpx
import pytest

import mona.agent.expert_catalog as catalog_module
import mona.agent.official_experts as official_experts
import mona.runtime.download as download_module
from mona.agent.expert_catalog import ExpertCatalogClient
from mona.agent.expert_installer import (
    ExpertCatalogVersionUnavailable, ExpertInstaller, ExpertInstallError,
)
from mona.agent.expert_jobs import ExpertInstallJobManager
from mona.agent.memory_versions import write_text_atomic
from mona.agent.package_store import AgentPackageStore
from mona.agent.partners import AgentRegistry
from mona.agent.tools.academic import AcademicSearchTool, ScientificTool
from mona.agent.tools.base import Tool
from mona.agent.tools.filesystem import ReadFileTool
from mona.agent.tools.guitar_tab import GuitarTabTool
from mona.agent.tools.loader import ToolLoader
from mona.agent.tools.music_score import MusicScoreTool
from mona.config.paths import get_agent_deletion_marker
from mona.config.schema import Config
from mona.runtime.download import VerifiedDownloader

AGENT_ID = "com.example.catalog-expert"


def _archive(
    tmp_path: Path,
    version: str = "1.0.0",
    *,
    agent_id: str = AGENT_ID,
    required_tools: tuple[str, ...] = ("read_file",),
    runtime_packs: tuple[str, ...] = ("python-base@3.12",),
) -> tuple[Path, bytes]:
    path = tmp_path / f"expert-{version}.zip"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(
            f"{agent_id}/agent.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": agent_id,
                    "displayName": "Catalog Expert",
                    "prompt": "prompt.md",
                    "toolAllowlist": list(required_tools),
                    "packageId": agent_id,
                    "packageVersion": version,
                }
            ),
        )
        bundle.writestr(
            f"{agent_id}/package-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "agentId": agent_id,
                    "version": version,
                    "requiredTools": list(required_tools),
                    "runtimePacks": list(runtime_packs),
                }
            ),
        )
        bundle.writestr(f"{agent_id}/prompt.md", "Catalog expert prompt.")
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
def allow_test_hosts(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(catalog_module, "validate_url_target", lambda _url: (True, ""))
    monkeypatch.setattr(download_module, "validate_url_target", lambda _url: (True, ""))
    monkeypatch.setattr("mona.config.paths.get_agents_dir", lambda: tmp_path / "agents")


@pytest.mark.parametrize(
    ("was_deleted", "delete_during_install"),
    [(True, False), (False, True), (True, True)],
)
async def test_installs_runtime_then_activates_and_reloads(
    tmp_path: Path, was_deleted: bool, delete_during_install: bool,
) -> None:
    marker = get_agent_deletion_marker(AGENT_ID)
    marker.parent.mkdir(parents=True)
    if was_deleted:
        marker.touch()
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
        if delete_during_install:
            write_text_atomic(marker, "")

    installer = ExpertInstaller(
        catalog_client=ExpertCatalogClient(
            ["https://catalog.example.test/catalog.json"],
            tmp_path / "catalog-cache.json",
            transport=httpx.MockTransport(transport),
        ),
        downloader=VerifiedDownloader(transport=httpx.MockTransport(transport)),
        package_store=AgentPackageStore(tmp_path / "packages", known_tool_names={"read_file"}),
        download_cache_dir=tmp_path / "downloads",
        resolve_tool_names=lambda _agent_id: {"read_file"},
        runtime_pack_installer=install_runtime,
        registry_reload=lambda: reloads.append(True),
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )
    progress: list[str] = []

    result = await installer.install(AGENT_ID, progress=lambda event: progress.append(event.stage))

    assert result.package.activated is True
    assert marker.exists() is delete_during_install
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
        resolve_tool_names=lambda _agent_id: {"read_file"},
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )

    with pytest.raises(ExpertInstallError, match="requires Mona"):
        await installer.install(AGENT_ID)

    assert package_requests == 0


async def test_install_selects_newest_compatible_version_and_honors_explicit_version(
    tmp_path: Path,
) -> None:
    _path, payload = _archive(tmp_path, runtime_packs=())
    digest = hashlib.sha256(payload).hexdigest()
    catalog = _catalog_entry(payload, digest)
    older = {
        **catalog["experts"][0],
        "downloadUrl": "https://cdn.example.test/older.zip",
        "mirrors": [],
        "runtimePacks": [],
    }
    newer = {
        **older,
        "version": "2.0.0",
        "downloadUrl": "https://cdn.example.test/newer.zip",
        "requiredTools": ["future_tool"],
    }
    catalog["experts"] = [newer, older]
    package_requests = []

    def transport(request: httpx.Request) -> httpx.Response:
        if request.url.host == "catalog.example.test":
            return httpx.Response(200, json=catalog, request=request)
        package_requests.append(request.url.path)
        return httpx.Response(200, content=payload, request=request)

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
        resolve_tool_names=lambda _agent_id: {"read_file"},
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )

    # An explicit incompatible or missing version cannot fall back silently.
    with pytest.raises(ExpertInstallError):
        await installer.install(AGENT_ID, version="2.0.0")
    with pytest.raises(ExpertCatalogVersionUnavailable):
        await installer.install(AGENT_ID, version="9.0.0")
    assert package_requests == []
    assert store.active(AGENT_ID) is None

    installed = await installer.install(AGENT_ID)
    assert installed.entry.version == "1.0.0"
    assert store.active(AGENT_ID)[0].version == "1.0.0"
    assert package_requests == ["/older.zip"]

    explicit = await installer.install(AGENT_ID, version="1.0.0")
    assert explicit.entry.version == "1.0.0"


@pytest.mark.parametrize("agent_id", [
    "com.mona.a-share-analyst",
    "com.mona.stock",
    "com.mona.stock-researcher",
])
async def test_retired_stock_partner_cannot_be_installed(
    tmp_path: Path, agent_id: str,
) -> None:
    _path, payload = _archive(tmp_path)
    catalog = _catalog_entry(payload, hashlib.sha256(payload).hexdigest())
    catalog["experts"][0]["id"] = agent_id
    package_requests = []

    def transport(request: httpx.Request) -> httpx.Response:
        if request.url.host == "catalog.example.test":
            return httpx.Response(200, json=catalog, request=request)
        package_requests.append(request.url.path)
        return httpx.Response(200, content=payload, request=request)

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
        resolve_tool_names=lambda _agent_id: {"read_file"},
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )

    with pytest.raises(ExpertInstallError):
        await installer.install(agent_id)
    with pytest.raises(ExpertInstallError):
        await installer.install(agent_id, version="1.0.0")
    assert package_requests == []
    assert store.active(agent_id) is None


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
        resolve_tool_names=lambda _agent_id: {"read_file"},
        runtime_pack_installer=fail_runtime,
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )

    with pytest.raises(RuntimeError, match="runtime unavailable"):
        await installer.install(AGENT_ID)

    assert store.active(AGENT_ID) is None


async def test_registry_reload_failure_rolls_back_activation(tmp_path: Path) -> None:
    marker = get_agent_deletion_marker(AGENT_ID)
    marker.parent.mkdir(parents=True)
    marker.touch()
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
        resolve_tool_names=lambda _agent_id: {"read_file"},
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
    assert marker.exists()


class _FuturePartnerTool(Tool):
    """A new partner-only tool should not need a special catalog workaround."""

    _scopes = {"subagent"}
    agent_allowlist = frozenset({AGENT_ID})

    @property
    def name(self):
        return "future_partner_tool"

    @property
    def description(self):
        return "A partner-specific tool."

    @property
    def parameters(self):
        return {"type": "object"}

    async def execute(self, **_kwargs):
        return "ok"


async def test_partner_catalog_and_install_use_each_agents_real_tool_scope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Keep real loader scope and identity checks while selecting a small set of
    # representative tools. The catalog check must work before installation.
    monkeypatch.setattr(official_experts, "load_config", lambda: Config())
    monkeypatch.setattr(
        ToolLoader, "discover",
        lambda _self: [
            ReadFileTool, GuitarTabTool, MusicScoreTool, AcademicSearchTool,
            ScientificTool, _FuturePartnerTool,
        ],
    )
    monkeypatch.setattr(ToolLoader, "_discover_plugins", lambda _self: {})
    resolve_tools = official_experts._known_partner_tools(
        tmp_path / "workspace", bus=None, subagent_manager=None, sessions=None,
    )

    musician_id = "com.mona.musician"
    researcher_id = "com.mona.academic-researcher"
    musician_tools = resolve_tools(musician_id)
    researcher_tools = resolve_tools(researcher_id)
    future_tools = resolve_tools(AGENT_ID)
    assert {"read_file", "guitar_tab", "music_score"} <= musician_tools
    assert {"read_file", "academic_search", "scientific_tool"} <= researcher_tools
    assert {"read_file", "future_partner_tool"} <= future_tools
    assert {"academic_search", "scientific_tool", "future_partner_tool"}.isdisjoint(musician_tools)
    assert {"guitar_tab", "music_score", "future_partner_tool"}.isdisjoint(researcher_tools)
    assert {"guitar_tab", "music_score", "academic_search", "scientific_tool"}.isdisjoint(future_tools)

    _path, payload = _archive(
        tmp_path,
        agent_id=musician_id,
        required_tools=("guitar_tab", "music_score"),
        runtime_packs=(),
    )
    digest = hashlib.sha256(payload).hexdigest()
    catalog = _catalog_entry(payload, digest)
    template = catalog["experts"][0]
    catalog["experts"] = [
        {**template, "id": musician_id, "requiredTools": ["guitar_tab", "music_score"], "runtimePacks": []},
        {**template, "id": researcher_id, "requiredTools": ["academic_search", "scientific_tool"], "runtimePacks": []},
        {**template, "id": AGENT_ID, "requiredTools": ["future_partner_tool"], "runtimePacks": []},
        {**template, "id": "com.example.foreign", "requiredTools": ["guitar_tab"], "runtimePacks": []},
        {**template, "id": "com.example.unsupported", "requiredTools": ["tool_does_not_exist"], "runtimePacks": []},
    ]
    package_requests = []

    def transport(request: httpx.Request) -> httpx.Response:
        if request.url.host == "catalog.example.test":
            return httpx.Response(200, json=catalog, request=request)
        package_requests.append(request.url.path)
        return httpx.Response(200, content=payload, request=request)

    client = ExpertCatalogClient(
        ["https://catalog.example.test/catalog.json"],
        tmp_path / "catalog-cache.json",
        transport=httpx.MockTransport(transport),
    )
    store = AgentPackageStore(tmp_path / "packages")
    registry = AgentRegistry(
        builtin_dir=tmp_path / "no-builtin",
        installed_dir=tmp_path / "agents",
        package_store_dir=store.root,
    )
    installer = ExpertInstaller(
        catalog_client=client,
        downloader=VerifiedDownloader(transport=httpx.MockTransport(transport)),
        package_store=store,
        download_cache_dir=tmp_path / "downloads",
        resolve_tool_names=resolve_tools,
        registry_reload=registry.reload,
        mona_version="1.5.0",
        current_platform="win32",
        current_architecture="x64",
    )
    manager = ExpertInstallJobManager(
        catalog_client=client,
        state_path=tmp_path / "jobs.json",
        installer=installer,
        installed_definition=registry.get,
    )
    response = await manager.catalog_payload()
    items = {item["id"]: item for item in response["experts"]}
    assert items[musician_id]["compatible"] is True
    assert items[researcher_id]["compatible"] is True
    assert items[AGENT_ID]["compatible"] is True
    assert "com.example.foreign" not in items
    assert "com.example.unsupported" not in items

    # Both catalog display and the install operation must reject another
    # agent's exclusive tool before attempting a package download.
    for agent_id in ("com.example.foreign", "com.example.unsupported"):
        with pytest.raises(ExpertInstallError):
            await installer.install(agent_id)
    assert package_requests == []

    result = await installer.install(musician_id)
    assert result.package.activated is True
    assert package_requests == ["/expert.zip"]

    async def musician_catalog_item():
        return next(item for item in (await manager.catalog_payload())["experts"] if item["id"] == musician_id)

    assert (await musician_catalog_item())["installed"] is True
    registry.delete(musician_id)
    registry.reload()
    assert store.active(musician_id) is not None
    item = await musician_catalog_item()
    assert (item["installed"], item["installedVersion"], item["updateAvailable"]) == (False, None, False)
    assert item["compatible"] is True
    await installer.install(musician_id)
    assert (await musician_catalog_item())["installed"] is True
