"""Native engine archive normalization tests."""

from __future__ import annotations

import io
import json
import stat
import tarfile
import time
import zipfile
from pathlib import Path

import pytest

from mona.runtime.catalog import RuntimeCatalogEntry
from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.native_packaging import NativeArchiveError, normalize_engine_archive


def _entry(
    component_id: str,
    version: str,
    kind: str,
    artifact_format: str,
    native_entrypoint: str | None = None,
) -> RuntimeCatalogEntry:
    return RuntimeCatalogEntry.model_validate(
        {
            "schemaVersion": 1,
            "id": component_id,
            "version": version,
            "kind": kind,
            "downloadUrl": "https://example.test/native",
            "size": 1,
            "sha256": "0" * 64,
            "dependencies": ["python-base@3.12"],
            "artifactFormat": artifact_format,
            "nativeEntrypoint": native_entrypoint,
        }
    )


def _tar_file(archive: tarfile.TarFile, name: str, data: bytes, mode: int = 0o644) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    archive.addfile(info, io.BytesIO(data))


def _tar_dir(archive: tarfile.TarFile, name: str) -> None:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    info.mode = 0o755
    archive.addfile(info)


def _runtime_archive(path: Path, version: str) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": "claude-code-cli",
                    "version": version,
                    "kind": "claude-code-runtime",
                    "entrypoints": {"claude": "bin/claude"},
                    "dependencies": [],
                }
            ),
        )
        archive.writestr("bin/claude", "old runtime")


def test_codex_preserves_package_helpers_and_executable_permissions(tmp_path: Path) -> None:
    source = tmp_path / "codex.tar.gz"
    destination = tmp_path / "normalized.zip"
    version = "0.156.1+linux.x64"
    with tarfile.open(source, "w:gz") as archive:
        _tar_dir(archive, "codex-package")
        _tar_dir(archive, "codex-package/bin")
        _tar_dir(archive, "codex-package/codex-resources")
        _tar_dir(archive, "codex-package/codex-path")
        _tar_file(
            archive,
            "codex-package/codex-package.json",
            json.dumps({"version": "0.156.1", "entrypoint": "bin/codex"}).encode(),
        )
        _tar_file(archive, "codex-package/bin/codex", b"cli", 0o755)
        _tar_file(archive, "codex-package/bin/codex-helper", b"helper", 0o755)
        _tar_file(archive, "codex-package/codex-resources/sandbox.dat", b"resource")
        _tar_file(archive, "codex-package/codex-path/rg", b"search", 0o755)

    result = normalize_engine_archive(
        source,
        _entry("codex-cli", version, "codex-runtime", "native-tar-gz", "bin/codex"),
        destination,
        current_platform="linux",
        current_architecture="x64",
    )

    with zipfile.ZipFile(result) as archive:
        names = set(archive.namelist())
        assert {
            "bin/codex",
            "bin/codex-helper",
            "codex-package.json",
            "codex-resources/sandbox.dat",
            "codex-path/rg",
            "runtime-manifest.json",
            "executor.json",
        } <= names
        assert not any(name.startswith("codex-package/") for name in names)
        assert archive.getinfo("bin/codex").external_attr >> 16 & 0o111
        manifest = json.loads(archive.read("runtime-manifest.json"))
        metadata = json.loads(archive.read("executor.json"))
    assert manifest["entrypoints"] == {"codex": "bin/codex", "metadata": "executor.json"}
    assert manifest["dependencies"] == ["python-base@3.12"]
    assert metadata == {
        "architecture": "x64",
        "executor": "codex",
        "nativeVersion": "0.156.1",
        "platform": "linux",
        "schemaVersion": 1,
    }


def test_claude_raw_binary_is_wrapped_and_does_not_change_active_store(tmp_path: Path) -> None:
    source = tmp_path / "claude"
    source.write_bytes(b"native cli bytes")
    output = tmp_path / "claude-runtime.zip"
    store = RuntimeComponentStore(tmp_path / "store")
    old_archive = tmp_path / "old-runtime.zip"
    _runtime_archive(old_archive, "1.0.0+linux.x64")
    store.install_archive(old_archive)
    pointer = tmp_path / "store/components/claude-code-cli/current.json"
    active_before = pointer.read_bytes()

    result = normalize_engine_archive(
        source,
        _entry("claude-code-cli", "1.2.3+linux.x64", "claude-code-runtime", "native-binary"),
        output,
        current_platform="linux",
        current_architecture="x64",
    )

    with zipfile.ZipFile(result) as archive:
        assert archive.read("bin/claude") == b"native cli bytes"
        assert archive.getinfo("bin/claude").external_attr >> 16 & 0o111
    assert pointer.read_bytes() == active_before
    assert store.active("claude-code-cli")[0].version == "1.0.0+linux.x64"


def test_normalized_zip_bytes_are_independent_of_system_clock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "claude"
    source.write_bytes(b"same verified artifact")
    entry = _entry(
        "claude-code-cli", "1.2.3+linux.x64", "claude-code-runtime", "native-binary"
    )
    year = [2025]

    def localtime(_seconds: float | None = None) -> time.struct_time:
        return time.struct_time((year[0], 1, 1, 0, 0, 0, 2, 1, -1))

    monkeypatch.setattr(zipfile.time, "localtime", localtime)
    first = normalize_engine_archive(
        source,
        entry,
        tmp_path / "first.zip",
        current_platform="linux",
        current_architecture="x64",
    )
    year[0] = 2026
    second = normalize_engine_archive(
        source,
        entry,
        tmp_path / "second.zip",
        current_platform="linux",
        current_architecture="x64",
    )

    assert first.read_bytes() == second.read_bytes()
    with zipfile.ZipFile(first) as archive:
        assert {info.date_time for info in archive.infolist()} == {(1980, 1, 1, 0, 0, 0)}


def test_codebuddy_zip_strips_its_single_wrapper_directory(tmp_path: Path) -> None:
    source = tmp_path / "codebuddy.zip"
    destination = tmp_path / "normalized.zip"
    with zipfile.ZipFile(source, "w") as archive:
        executable = zipfile.ZipInfo("bundle/codebuddy.exe")
        executable.external_attr = (stat.S_IFREG | 0o755) << 16
        archive.writestr(executable, b"codebuddy")
        archive.writestr("bundle/resources/rules.json", b"{}")

    result = normalize_engine_archive(
        source,
        _entry(
            "codebuddy-cli",
            "2.0.0+win32.x64",
            "codebuddy-runtime",
            "native-zip",
            "codebuddy.exe",
        ),
        destination,
        current_platform="win32",
        current_architecture="x64",
    )

    with zipfile.ZipFile(result) as archive:
        assert "codebuddy.exe" in archive.namelist()
        assert "resources/rules.json" in archive.namelist()
        assert not any(name.startswith("bundle/") for name in archive.namelist())
        manifest = json.loads(archive.read("runtime-manifest.json"))
    assert manifest["entrypoints"]["codebuddy"] == "codebuddy.exe"


@pytest.mark.parametrize("member_name", ["../escape", "/absolute"])
def test_native_tar_rejects_unsafe_paths(tmp_path: Path, member_name: str) -> None:
    source = tmp_path / "malicious.tar.gz"
    with tarfile.open(source, "w:gz") as archive:
        _tar_file(archive, member_name, b"bad")

    with pytest.raises(NativeArchiveError):
        normalize_engine_archive(
            source,
            _entry("codex-cli", "1.0.0+linux.x64", "codex-runtime", "native-tar-gz", "bin/codex"),
            tmp_path / "out.zip",
            current_platform="linux",
            current_architecture="x64",
        )


def test_native_zip_rejects_symlink_members(tmp_path: Path) -> None:
    source = tmp_path / "malicious.zip"
    with zipfile.ZipFile(source, "w") as archive:
        link = zipfile.ZipInfo("bundle/codebuddy.exe")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(link, "../../outside")

    with pytest.raises(NativeArchiveError):
        normalize_engine_archive(
            source,
            _entry(
                "codebuddy-cli",
                "1.0.0+win32.x64",
                "codebuddy-runtime",
                "native-zip",
                "codebuddy.exe",
            ),
            tmp_path / "out.zip",
            current_platform="win32",
            current_architecture="x64",
        )
