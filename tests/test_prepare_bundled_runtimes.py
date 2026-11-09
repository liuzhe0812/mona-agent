from __future__ import annotations

import asyncio
import hashlib
import io
import json
import stat
import tarfile
import zipfile
from pathlib import Path

import pytest

from mona.runtime.bundled import load_bundled_runtime
from mona.runtime.manager import RuntimeComponentStore
from scripts import prepare_bundled_runtimes as prepare


def _component(path: Path, kind: str) -> None:
    manifest = prepare._manifest(kind, "win32")
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("runtime-manifest.json", prepare._json_bytes(manifest.model_dump(mode="json", by_alias=True)))
        for entry in manifest.entrypoints.values():
            archive.writestr(entry, b"fixture")


def _source(path: Path, *, filename: str | None = None) -> dict:
    return {
        "filename": filename or path.name,
        "size": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "urls": ["https://example.invalid/fixed-resource"],
    }


def _fixture_sources(tmp_path: Path) -> tuple[Path, Path, Path]:
    base = tmp_path / "components"
    python = base / "python-base" / f"{prepare.PYTHON_VERSION}.zip"
    node = base / "node-base" / f"{prepare.NODE_VERSION}.zip"
    _component(python, "python-base")
    _component(node, "node-base")
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    wheel_names = [
        "defusedxml-0.7.1-py2.py3-none-any.whl",
        "lxml-6.1.2-cp313-cp313-win_amd64.whl",
        "pillow-12.3.0-cp313-cp313-win_amd64.whl",
        "pymupdf-1.26.4-cp39-abi3-win_amd64.whl",
        "pyyaml-6.0.3-cp313-cp313-win_amd64.whl",
        "websockets-17.1-cp313-cp313-win_amd64.whl",
    ]
    wheels = {}
    for filename in wheel_names:
        path = wheelhouse / filename
        path.write_bytes(filename.encode())
        wheels[filename] = {key: value for key, value in _source(path).items() if key != "filename"}
    sources = {
        "schemaVersion": 1,
        "targets": {"win32-x64": {
            "pythonBase": _source(python, filename="python-input.zip"),
            "nodeBase": _source(node, filename="node-input.zip"),
            "wheels": wheel_names,
        }},
        "wheels": wheels,
    }
    config = tmp_path / "sources.json"
    config.write_text(json.dumps(sources), encoding="utf-8")
    return config, base, wheelhouse


def test_offline_bundle_uses_local_inputs_and_installs_as_existing_components(tmp_path: Path) -> None:
    config, components, wheelhouse = _fixture_sources(tmp_path)
    cache = tmp_path / "cache"
    outputs = [tmp_path / "first", tmp_path / "second"]
    results = [
        asyncio.run(prepare.prepare(
            platform="win32", architecture="x64", output=output, cache=cache,
            components_dir=components, wheelhouse=wheelhouse, offline=True, sources_file=config,
        ))
        for output in outputs
    ]
    assert results[0] == results[1]
    assert {item["manifest"]["id"] for item in results[0]["components"]} == {
        "python-base", "node-base", "python-common",
    }
    payload = load_bundled_runtime(outputs[0], current_platform="win32", current_architecture="x64")
    assert set(payload.refs) == {"python-base@3.13.15", "node-base@22.23.2", "python-common@1.0.0"}
    store = RuntimeComponentStore(tmp_path / "runtime-store")
    for row in results[0]["components"]:
        path = outputs[0] / row["archive"]
        assert path.stat().st_size == row["size"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == row["sha256"]
        installed = store.install_archive(path)
        assert installed.model_dump(mode="json", by_alias=True) == row["manifest"]
    with zipfile.ZipFile(outputs[0] / "python-common-1.0.0.zip") as archive:
        assert len([name for name in archive.namelist() if name.startswith("wheels/")]) == 6
        lock = archive.read("requirements.lock").decode()
        assert "pymupdf==1.26.4 --hash=sha256:" in lock
        assert "pyyaml==6.0.3 --hash=sha256:" in lock


def test_offline_missing_or_corrupt_inputs_fail_without_publishing(tmp_path: Path) -> None:
    config, components, wheelhouse = _fixture_sources(tmp_path)
    (wheelhouse / "defusedxml-0.7.1-py2.py3-none-any.whl").write_bytes(b"corrupt")
    output = tmp_path / "output"
    with pytest.raises(ValueError, match="fixed size and SHA-256"):
        asyncio.run(prepare.prepare(
            platform="win32", architecture="x64", output=output, cache=tmp_path / "cache",
            components_dir=components, wheelhouse=wheelhouse, offline=True, sources_file=config,
        ))
    assert not (output / "manifest.json").exists()


def test_wheels_must_match_platform_and_exact_common_dependencies() -> None:
    config = json.loads(prepare.SOURCES.read_text(encoding="utf-8"))
    windows = config["targets"]["win32-x64"]["wheels"]
    mac = config["targets"]["darwin-arm64"]["wheels"]
    mac_x64 = config["targets"]["darwin-x64"]["wheels"]
    assert prepare._wheel_versions("win32", "x64", windows) == prepare.COMMON_REQUIREMENTS
    assert prepare._wheel_versions("darwin", "arm64", mac) == prepare.COMMON_REQUIREMENTS
    assert prepare._wheel_versions("darwin", "x64", mac_x64) == prepare.COMMON_REQUIREMENTS
    with pytest.raises(ValueError, match="incompatible"):
        prepare._wheel_versions("darwin", "arm64", windows)
    with pytest.raises(ValueError, match="incompatible"):
        prepare._wheel_versions("darwin", "arm64", mac_x64)
    with pytest.raises(ValueError, match="required common set"):
        prepare._wheel_versions("win32", "x64", windows[:-1])


def test_hosted_linux_document_pack_is_verified_deterministic_and_platform_scoped(tmp_path: Path) -> None:
    source = json.loads(prepare.SOURCES.read_text(encoding="utf-8"))
    names = source["hostedDocumentPacks"]["linux-x64-cp311"]
    assert prepare._hosted_document_wheel_versions(names) == prepare.HOSTED_DOCUMENT_REQUIREMENTS
    with pytest.raises(ValueError, match="incompatible"):
        prepare._hosted_document_wheel_versions([*names[:-1], "pymupdf-1.26.4-cp39-abi3-win_amd64.whl"])

    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    entries = {}
    for name in names:
        path = wheelhouse / name
        path.write_bytes(name.encode())
        entries[name] = {key: value for key, value in _source(path).items() if key != "filename"}
    spec = tmp_path / "sources.json"
    spec.write_text(json.dumps({"schemaVersion": 1, "hostedDocumentPacks": {"linux-x64-cp311": names},
                                "wheels": entries}), encoding="utf-8")
    outputs = [tmp_path / "first", tmp_path / "second"]
    records = [asyncio.run(prepare.prepare_hosted_document_pack(
        output=output, cache=tmp_path / "cache", wheelhouse=wheelhouse, offline=True, sources_file=spec,
    )) for output in outputs]
    assert records[0] == records[1]
    assert records[0]["pythonVersion"] == "3.11" and records[0]["glibcMinimum"] == "2.28"
    package = outputs[0] / records[0]["archive"]
    assert hashlib.sha256(package.read_bytes()).hexdigest() == records[0]["sha256"]
    store = RuntimeComponentStore(tmp_path / "runtime-store")
    manifest = store.install_archive(package)
    assert manifest.id == "python-hosted-documents" and manifest.python_environment == "hosted-work"
    with zipfile.ZipFile(package) as archive:
        lock = archive.read("requirements.lock").decode()
        assert "pymupdf==1.26.4 --hash=sha256:" in lock
        assert "python-docx==1.2.0 --hash=sha256:" in lock
        assert len([name for name in archive.namelist() if name.startswith("wheels/")]) == len(names)
    with pytest.raises(FileExistsError):
        asyncio.run(prepare.prepare_hosted_document_pack(
            output=outputs[0], cache=tmp_path / "cache", wheelhouse=wheelhouse, offline=True, sources_file=spec,
        ))


def _tar_file(archive: tarfile.TarFile, name: str, content: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(content)
    info.mode = mode
    archive.addfile(info, io.BytesIO(content))


def _tar_link(archive: tarfile.TarFile, name: str, target: str) -> None:
    info = tarfile.TarInfo(name)
    info.type = tarfile.SYMTYPE
    info.linkname = target
    archive.addfile(info)


def test_macos_python_links_are_materialized_and_keep_execution_bits(tmp_path: Path) -> None:
    source = tmp_path / "python.tar.gz"
    with tarfile.open(source, "w:gz") as archive:
        _tar_file(archive, "python/bin/python3.13", b"executable", 0o755)
        _tar_link(archive, "python/bin/python3", "python3.13")
        _tar_file(archive, "python/lib/pkg/resource.txt", b"resource")
        _tar_link(archive, "python/alias", "lib/pkg")
    output = tmp_path / "component.zip"
    prepare._build_macos_component(source, output, "python-base")
    with zipfile.ZipFile(output) as archive:
        assert archive.read("python/bin/python3") == b"executable"
        assert archive.read("python/alias/resource.txt") == b"resource"
        mode = archive.getinfo("python/bin/python3").external_attr >> 16
        assert stat.S_ISREG(mode) and mode & 0o111


@pytest.mark.parametrize("target", ["../../outside", "/etc/passwd", "../bin/python3"])
def test_macos_rejects_escaping_or_cyclic_links(tmp_path: Path, target: str) -> None:
    source = tmp_path / "unsafe.tar.gz"
    with tarfile.open(source, "w:gz") as archive:
        _tar_link(archive, "python/bin/python3", target)
    with pytest.raises(ValueError, match="escape|unsafe|cycle"):
        prepare._build_macos_component(source, tmp_path / "component.zip", "python-base")


@pytest.mark.parametrize("architecture", ["arm64", "x64"])
def test_macos_node_layout_supplies_managed_npm_and_npx(tmp_path: Path, architecture: str) -> None:
    source = tmp_path / "node.tar.gz"
    root = f"node-v{prepare.NODE_VERSION}-darwin-{architecture}"
    with tarfile.open(source, "w:gz") as archive:
        _tar_file(archive, f"{root}/bin/node", b"node", 0o755)
        for name in ("npm", "npx"):
            _tar_file(archive, f"{root}/lib/node_modules/npm/bin/{name}-cli.js", name.encode())
            _tar_link(archive, f"{root}/bin/{name}", f"../lib/node_modules/npm/bin/{name}-cli.js")
    output = tmp_path / "component.zip"
    prepare._build_macos_component(source, output, "node-base", architecture)
    with zipfile.ZipFile(output) as archive:
        assert archive.read("node/node") == b"node"
        for name in ("npm", "npx"):
            assert f"node_modules/npm/bin/{name}-cli.js" in archive.read(f"node/{name}").decode()
            assert (archive.getinfo(f"node/{name}").external_attr >> 16) & 0o111


def test_component_archive_rejects_traversal(tmp_path: Path) -> None:
    path = tmp_path / "unsafe.zip"
    manifest = prepare._manifest("python-base", "win32")
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("runtime-manifest.json", prepare._json_bytes(manifest.model_dump(mode="json", by_alias=True)))
        archive.writestr("python/python.exe", b"fixture")
        archive.writestr("../escape", b"bad")
    with pytest.raises(ValueError, match="unsafe archive path"):
        prepare._verify_component(path, manifest)
