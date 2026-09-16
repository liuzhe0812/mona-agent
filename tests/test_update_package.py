from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import shutil
import sys
import tarfile
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

    # A real skill script must survive packaging, while development-only
    # caches and tests must be removed from the Gateway tree.
    _write(gateway / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "export.py")
    _write(gateway / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "tests" / "test_export.py")
    _write(gateway / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "__pycache__" / "export.pyc")
    _write(gateway / "_internal" / "mona" / "skills" / "mona-video" / "py.typed")
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
    assert "mona-gateway/_internal/mona/skills/mona-video/scripts/export.py" in members
    assert not any("/tests/" in name or "/__pycache__/" in name for name in members)
    assert not any(name.endswith(".pyc") or name.endswith("py.typed") for name in members)
    assert not any("/node_modules/" in name or "/.git/" in name for name in members)


def test_build_package_rejects_missing_office_before_cleanup_or_output(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    office_root = staging / "mona-gateway" / "_internal" / "desktop-resources" / "office-editor"
    shutil.rmtree(office_root)
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "__pycache__" / "export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"

    with pytest.raises(build_update_package.UpdatePackageValidationError, match="Office"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()


def test_build_package_rejects_manifest_path_escape_before_cleanup_or_output(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    manifest_path = staging / "mona-gateway" / "_internal" / "desktop-resources" / "office-editor" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["xlsxSidecar"]["path"] = "../../../../outside.exe"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "__pycache__" / "export.pyc"
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
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "__pycache__" / "export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"

    with pytest.raises(build_update_package.UpdatePackageValidationError, match="sha256"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()


def test_build_package_rejects_web_dist_duplicate_before_cleanup(tmp_path: Path) -> None:
    staging = _make_staging(tmp_path)
    web_dist = staging / "mona-gateway" / "_internal" / "mona" / "web" / "dist"
    _write(web_dist / "index.html", b"unused web bundle")
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "__pycache__" / "export.pyc"
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
    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "__pycache__" / "export.pyc"
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

    cache = staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "__pycache__" / "export.pyc"
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

    cache = real_staging / "mona-gateway" / "_internal" / "mona" / "skills" / "mona-video" / "scripts" / "__pycache__" / "export.pyc"
    output = tmp_path / "dist" / "package.tar.zst"
    with pytest.raises(build_update_package.UpdatePackageValidationError, match="symlink"):
        build_update_package.build_package(str(staging), str(output))

    assert not output.exists()
    assert cache.exists()
