from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import shutil
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest
import zstandard

_SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "build_update_package.py"
_SPEC = importlib.util.spec_from_file_location("build_update_package", _SCRIPT_PATH)
assert _SPEC is not None and _SPEC.loader is not None
build_update_package = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(build_update_package)


def _write(path: Path, data: bytes = b"fixture\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def _write_runtime_fixture(runtime: Path) -> dict[str, bytes]:
    runtime.mkdir(parents=True)
    manifests = [
        {"id": "python-base", "version": "3.13.15", "kind": "python-runtime",
         "entrypoints": {"python": "python/python.exe"}},
        {"id": "node-base", "version": "22.23.2", "kind": "node-runtime",
         "entrypoints": {"node": "node/node.exe"}},
        {"id": "python-common", "version": "1.0.0", "kind": "python-pack",
         "dependencies": ["python-base@3.13.15"], "pythonRequirements": "requirements.lock",
         "pythonWheelhouse": "wheels"},
    ]
    components = []
    for manifest in manifests:
        archive = runtime / f"{manifest['id']}-{manifest['version']}.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("runtime-manifest.json", json.dumps(manifest))
            for entry in manifest.get("entrypoints", {}).values():
                bundle.writestr(entry, "fixture")
        data = archive.read_bytes()
        components.append({"archive": archive.name, "size": len(data),
                           "sha256": hashlib.sha256(data).hexdigest(), "manifest": manifest})
    (runtime / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "platform": "win32", "architecture": "x64",
                    "components": components}), encoding="utf-8"
    )
    return {path.name: path.read_bytes() for path in runtime.iterdir()}


def _make_staging(tmp_path: Path) -> Path:
    staging = tmp_path / "staging"
    _write(staging / "Mona.exe", b"Mona executable")
    gateway = staging / "mona-gateway"
    _write(gateway / "mona-gateway.exe", b"gateway executable")
    _write(gateway / "_internal/mona_ai-1.6.0.dist-info/METADATA", b"Name: mona-ai\nVersion: 1.6.0\n")

    sidecar = gateway / "_internal" / "desktop-resources" / "office-editor" / "sheets" / "xlsx-sidecar.exe"
    sidecar_payload = b"xlsx sidecar fixture"
    _write(sidecar, sidecar_payload)
    office_root = sidecar.parents[1]
    _write(office_root / "templates" / "blank.docx", b"docx")
    _write(office_root / "templates" / "blank.xlsx", b"xlsx")
    _write(office_root / "templates" / "blank.pptx", b"pptx")
    _write(office_root / "licenses" / "LICENSE", b"license")
    (office_root / "manifest.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "platform": "windows",
                "arch": "x64",
                "xlsxSidecar": {
                    "path": "sheets/xlsx-sidecar.exe",
                    "version": "fixture",
                    "size": len(sidecar_payload),
                    "sha256": hashlib.sha256(sidecar_payload).hexdigest(),
                },
            }
        ),
        encoding="utf-8",
    )
    _write_runtime_fixture(gateway / "_internal" / "desktop-resources" / "runtime-base")

    # A real skill script must survive packaging, while development-only
    # caches and tests must be removed from the Gateway tree.
    _write(gateway / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "export.py")
    _write(gateway / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "tests" / "test_export.py")
    _write(gateway / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "__pycache__" / "export.pyc")
    _write(gateway / "_internal" / "mona" / "skills" / "mona-motion" / "py.typed")
    _write(gateway / "node_modules" / "dev-only" / "index.js")
    _write(gateway / ".git" / "config")
    return staging


def _archive_members(archive: Path) -> list[str]:
    output = io.BytesIO()
    with archive.open("rb") as stream:
        dctx = zstandard.ZstdDecompressor()
        with dctx.stream_reader(stream) as reader:
            output.write(reader.read())
    with tarfile.open(fileobj=io.BytesIO(output.getvalue()), mode="r:") as tar:
        return tar.getnames()


def test_build_package_keeps_office_and_skill_scripts_and_removes_dev_cache(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    output = tmp_path / "dist" / "mona-1.6.0.tar.zst"
    runtime = staging / "mona-gateway/_internal/desktop-resources/runtime-base"
    original_runtime = {path.name: path.read_bytes() for path in runtime.iterdir()}

    build_update_package.build_package(str(staging), str(output))

    assert output.is_file()
    members = set(_archive_members(output))
    assert "Mona.exe" in members
    assert "mona-gateway/mona-gateway.exe" in members
    assert "mona-gateway/_internal/mona_ai-1.6.0.dist-info/METADATA" in members
    assert "mona-gateway/_internal/desktop-resources/office-editor/manifest.json" in members
    assert "mona-gateway/_internal/desktop-resources/office-editor/sheets/xlsx-sidecar.exe" in members
    for name in ("blank.docx", "blank.xlsx", "blank.pptx"):
        assert f"mona-gateway/_internal/desktop-resources/office-editor/templates/{name}" in members
    assert "mona-gateway/_internal/desktop-resources/office-editor/licenses/LICENSE" in members
    with output.open("rb") as stream, zstandard.ZstdDecompressor().stream_reader(stream) as reader:
        with tarfile.open(fileobj=reader, mode="r|") as tar:
            packaged_runtime = {
                Path(member.name).name: tar.extractfile(member).read()
                for member in tar
                if member.isfile() and "/desktop-resources/runtime-base/" in member.name
            }
    assert packaged_runtime == original_runtime
    assert "mona-gateway/_internal/mona/skills/mona-motion/scripts/export.py" in members
    assert not any("/tests/" in name or "/__pycache__/" in name for name in members)
    assert not any(name.endswith(".pyc") or name.endswith("py.typed") for name in members)
    assert not any("/node_modules/" in name or "/.git/" in name for name in members)


def test_build_package_rejects_missing_office_before_cleanup_or_output(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    office_root = staging / "mona-gateway" / "_internal" / "desktop-resources" / "office-editor"
    shutil.rmtree(office_root)
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "__pycache__" / "export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"

    with pytest.raises(build_update_package.UpdatePackageValidationError, match="Office"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()


@pytest.mark.parametrize("failure", ["missing", "corrupt", "wrong-platform"])
def test_build_package_rejects_invalid_runtime_before_cleanup_or_output(tmp_path: Path, failure: str) -> None:
    staging = _make_staging(tmp_path)
    runtime = staging / "mona-gateway/_internal/desktop-resources/runtime-base"
    archive = runtime / "python-base-3.13.15.zip"
    if failure == "missing":
        archive.unlink()
    elif failure == "corrupt":
        archive.write_bytes(archive.read_bytes() + b"corrupt")
    else:
        manifest_path = runtime / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["architecture"] = "arm64"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    cache = staging / "mona-gateway/_internal/mona/skills/mona-motion/scripts/__pycache__/export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"

    with pytest.raises(build_update_package.UpdatePackageValidationError, match="bundled script runtime"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()


def test_build_package_rejects_manifest_path_escape_before_cleanup_or_output(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    manifest_path = staging / "mona-gateway" / "_internal" / "desktop-resources" / "office-editor" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["xlsxSidecar"]["path"] = "../../../../outside.exe"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "__pycache__" / "export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"

    with pytest.raises(build_update_package.UpdatePackageValidationError, match="escapes"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()


def test_build_package_rejects_sidecar_hash_before_cleanup_or_output(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    manifest_path = staging / "mona-gateway" / "_internal" / "desktop-resources" / "office-editor" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["xlsxSidecar"]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "__pycache__" / "export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"

    with pytest.raises(build_update_package.UpdatePackageValidationError, match="sha256"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()


def test_build_package_rejects_web_dist_duplicate_before_cleanup(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    web_dist = staging / "mona-gateway" / "_internal" / "mona" / "web" / "dist"
    _write(web_dist / "index.html", b"unused web bundle")
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "__pycache__" / "export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"

    with pytest.raises(build_update_package.UpdatePackageValidationError, match="web bundle"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()


def test_build_package_requires_sidecar_version_used_by_client(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    manifest_path = staging / "mona-gateway/_internal/desktop-resources/office-editor/manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["xlsxSidecar"]["version"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    output = tmp_path / "package.tar.zst"

    with pytest.raises(build_update_package.UpdatePackageValidationError, match="version"):
        build_update_package.build_package(str(staging), str(output))
    assert not output.exists()


def test_build_package_rejects_output_inside_staging_before_cleanup(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "__pycache__" / "export.pyc"
    output = staging / "package.tar.zst"

    with pytest.raises(build_update_package.UpdatePackageValidationError, match="outside staging"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()


def test_build_package_rejects_symlink_before_cleanup_or_output(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    linked = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "linked"
    target = tmp_path / "outside"
    target.mkdir()
    try:
        linked.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        if sys.platform != "win32":
            pytest.skip(f"symlinks unavailable: {exc}")
        import _winapi

        _winapi.CreateJunction(str(target), str(linked))

    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "__pycache__" / "export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"
    with pytest.raises(build_update_package.UpdatePackageValidationError, match="outside staging|Symlink"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()


def test_build_package_rejects_symlinked_staging_root_before_cleanup_or_output(tmp_path: Path) -> None:
    real_staging = _make_staging(tmp_path)
    staging = tmp_path / "staging-link"
    try:
        staging.symlink_to(real_staging, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        if sys.platform != "win32":
            pytest.skip(f"symlinks unavailable: {exc}")
        import _winapi

        _winapi.CreateJunction(str(real_staging), str(staging))

    cache = real_staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-motion" / "scripts" / "__pycache__" / "export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"
    with pytest.raises(build_update_package.UpdatePackageValidationError, match="symlink"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()
