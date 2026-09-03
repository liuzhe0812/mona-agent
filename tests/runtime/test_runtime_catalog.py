"""Official runtime catalog and dependency installer tests."""

from __future__ import annotations

import asyncio
import hashlib
import json
import zipfile
from pathlib import Path

import httpx
import pytest

import mona.runtime.catalog as catalog_module
import mona.runtime.download as download_module
from mona.runtime.catalog import (
    RuntimeCatalogClient,
    RuntimeInstaller,
)
from mona.runtime.download import VerifiedDownloader
from mona.runtime.manager import RuntimeComponentStore


def _archive(
    path: Path,
    component_id: str,
    version: str,
    *,
    kind: str,
    dependencies: list[str] | None = None,
    entrypoints: dict[str, str] | None = None,
    python_requirements: bool = False,
) -> bytes:
    dependencies = dependencies or []
    entrypoints = entrypoints or {}
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        manifest: dict[str, object] = {
            "schemaVersion": 1,
            "id": component_id,
            "version": version,
            "kind": kind,
            "dependencies": dependencies,
            "entrypoints": entrypoints,
        }
        if python_requirements:
            manifest.update(
                {
                    "pythonRequirements": "requirements.lock",
                    "pythonWheelhouse": "wheels",
                    "healthImports": ["numpy"],
                }
            )
        bundle.writestr(
            "runtime-manifest.json",
            json.dumps(manifest),
        )
        for relative in entrypoints.values():
            bundle.writestr(relative, "fixture executable")
        if python_requirements:
            bundle.writestr("requirements.lock", "numpy==1 --hash=sha256:" + "0" * 64)
            bundle.writestr("wheels/numpy-1-py3-none-any.whl", "fixture")
    return path.read_bytes()


class FakePythonEnvironmentBuilder:
    def __init__(self, error: BaseException | None = None) -> None:
        self.calls: list[list[str]] = []
        self.error = error

    async def ensure(self, refs: list[str]) -> None:
        self.calls.append(refs)
        if self.error is not None:
            raise self.error


def _entry(
    component_id: str,
    version: str,
    payload: bytes,
    *,
    kind: str,
    dependencies: list[str] | None = None,
) -> dict:
    digest = hashlib.sha256(payload).hexdigest()
    return {
        "schemaVersion": 1,
        "id": component_id,
        "version": version,
        "kind": kind,
        "downloadUrl": f"https://cdn.example.test/{component_id}.zip",
        "size": len(payload),
        "sha256": digest,
        "dependencies": dependencies or [],
        "platforms": ["win32"],
        "architectures": ["x64"],
    }


@pytest.fixture(autouse=True)
def allow_test_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(catalog_module, "validate_url_target", lambda _url: (True, ""))
    monkeypatch.setattr(download_module, "validate_url_target", lambda _url: (True, ""))


async def test_installs_dependency_closure_from_official_catalog(tmp_path: Path) -> None:
    python_payload = _archive(
        tmp_path / "python.zip",
        "python-base",
        "3.12",
        kind="python-runtime",
        entrypoints={"python": "bin/python.exe"},
    )
    scientific_payload = _archive(
        tmp_path / "scientific.zip",
        "scientific",
        "1",
        kind="python-pack",
        dependencies=["python-base@3.12"],
        python_requirements=True,
    )
    catalog = {
        "schemaVersion": 1,
        "generatedAt": "2026-08-29T00:00:00Z",
        "components": [
            _entry("python-base", "3.12", python_payload, kind="python-runtime"),
            _entry(
                "scientific",
                "1",
                scientific_payload,
                kind="python-pack",
                dependencies=["python-base@3.12"],
            ),
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "catalog.example.test":
            return httpx.Response(200, json=catalog, request=request)
        payload = (
            python_payload if request.url.path.endswith("python-base.zip") else scientific_payload
        )
        return httpx.Response(200, content=payload, request=request)

    root = tmp_path / "runtimes"
    environment_builder = FakePythonEnvironmentBuilder()
    installer = RuntimeInstaller(
        catalog_client=RuntimeCatalogClient(
            ["https://catalog.example.test/runtime.json"],
            tmp_path / "runtime-catalog.json",
            transport=httpx.MockTransport(handler),
        ),
        downloader=VerifiedDownloader(transport=httpx.MockTransport(handler)),
        store=RuntimeComponentStore(root),
        cache_dir=tmp_path / "downloads",
        python_environment_builder=environment_builder,  # type: ignore[arg-type]
        current_platform="win32",
        current_architecture="x64",
    )

    await installer.ensure_packs(["scientific@1"])

    assert installer.store.active("python-base")[0].version == "3.12"  # type: ignore[index]
    assert installer.store.active("scientific")[0].version == "1"  # type: ignore[index]
    assert environment_builder.calls == [["python-base@3.12", "scientific@1"]]

    python_root = installer.store.active("python-base")[1]  # type: ignore[index]
    (python_root / "bin" / "python.exe").unlink()
    assert installer.store.active("python-base") is None

    await installer.ensure_packs(["scientific@1"], force=True)

    assert installer.store.active("python-base") is not None
    assert (installer.store.active("python-base")[1] / "bin" / "python.exe").is_file()  # type: ignore[index]
    assert environment_builder.calls == [
        ["python-base@3.12", "scientific@1"],
        ["python-base@3.12", "scientific@1"],
    ]


@pytest.mark.parametrize(
    "environment_error",
    [RuntimeError("venv build failed"), asyncio.CancelledError()],
    ids=["failure", "cancelled"],
)
async def test_python_environment_interruption_rolls_back_component_activation(
    tmp_path: Path,
    environment_error: BaseException,
) -> None:
    _archive(
        tmp_path / "old.zip",
        "scientific",
        "1",
        kind="python-pack",
    )
    base_payload = _archive(
        tmp_path / "python.zip",
        "python-base",
        "3.12",
        kind="python-runtime",
        entrypoints={"python": "python.exe"},
    )
    new_payload = _archive(
        tmp_path / "new.zip",
        "scientific",
        "2",
        kind="python-pack",
        dependencies=["python-base@3.12"],
        python_requirements=True,
    )
    catalog = {
        "schemaVersion": 1,
        "generatedAt": "2026-08-29T00:00:00Z",
        "components": [
            _entry("python-base", "3.12", base_payload, kind="python-runtime"),
            _entry(
                "scientific",
                "2",
                new_payload,
                kind="python-pack",
                dependencies=["python-base@3.12"],
            ),
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "catalog.example.test":
            return httpx.Response(200, json=catalog, request=request)
        payload = base_payload if request.url.path.endswith("python-base.zip") else new_payload
        return httpx.Response(200, content=payload, request=request)

    root = tmp_path / "runtimes"
    store = RuntimeComponentStore(root)
    store.install_archive(tmp_path / "old.zip")
    installer = RuntimeInstaller(
        catalog_client=RuntimeCatalogClient(
            ["https://catalog.example.test/runtime.json"],
            tmp_path / "runtime-catalog.json",
            transport=httpx.MockTransport(handler),
        ),
        downloader=VerifiedDownloader(transport=httpx.MockTransport(handler)),
        store=store,
        cache_dir=tmp_path / "downloads",
        python_environment_builder=FakePythonEnvironmentBuilder(environment_error),  # type: ignore[arg-type]
        current_platform="win32",
        current_architecture="x64",
    )

    with pytest.raises(
        type(environment_error),
        match="venv build failed" if isinstance(environment_error, RuntimeError) else None,
    ):
        await installer.ensure_packs(["scientific@2"])

    assert store.active("scientific")[0].version == "1"  # type: ignore[index]
    assert store.active("python-base") is None


async def test_runtime_catalog_uses_valid_offline_cache(tmp_path: Path) -> None:
    catalog = {
        "schemaVersion": 1,
        "generatedAt": "2026-08-29T00:00:00Z",
        "components": [],
    }
    cache_path = tmp_path / "runtime-catalog.json"
    first = RuntimeCatalogClient(
        ["https://catalog.example.test/runtime.json"],
        cache_path,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=catalog, request=request)
        ),
    )
    await first.fetch()
    offline = RuntimeCatalogClient(
        ["https://catalog.example.test/runtime.json"],
        cache_path,
        transport=httpx.MockTransport(lambda request: httpx.Response(503, request=request)),
    )

    loaded = await offline.fetch()

    assert loaded.components == []
