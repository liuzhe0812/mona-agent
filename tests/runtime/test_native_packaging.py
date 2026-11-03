"""Native engine archive normalization tests."""

from __future__ import annotations

import io
import json
import os
import stat
import tarfile
import time
import zipfile
from pathlib import Path

import pytest

from mona.runtime import native_packaging
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


def _zip_member(archive: zipfile.ZipFile, name: str, data: bytes, mode: int) -> None:
    info = zipfile.ZipInfo(name)
    info.create_system = 3
    info.external_attr = mode << 16
    archive.writestr(info, data)


def test_chromium_preserves_distribution_and_has_only_browser_entrypoint(tmp_path: Path) -> None:
    source = tmp_path / "chromium.zip"
    executable = "chrome-headless-shell-mac-arm64/Contents/MacOS/headless"
    resources = "chrome-headless-shell-mac-arm64/Contents/Resources/locale.dat"
    empty_directory = "chrome-headless-shell-mac-arm64/Contents/empty/"
    with zipfile.ZipFile(source, "w") as archive:
        _zip_member(archive, executable, b"native browser", stat.S_IFREG | 0o755)
        _zip_member(archive, resources, b"resource bytes", stat.S_IFREG | 0o640)
        _zip_member(archive, empty_directory, b"", stat.S_IFDIR | 0o750)

    result = normalize_engine_archive(
        source,
        _entry("browser-chromium", "1.2.3+darwin.arm64", "browser-runtime", "native-zip", executable),
        tmp_path / "runtime.zip", current_platform="darwin", current_architecture="arm64",
    )

    with zipfile.ZipFile(result) as archive:
        assert set(archive.namelist()) == {executable, resources, empty_directory, "runtime-manifest.json"}
        assert archive.read(executable) == b"native browser"
        assert archive.read(resources) == b"resource bytes"
        assert archive.getinfo(executable).external_attr >> 16 & 0o777 == 0o755
        assert archive.getinfo(resources).external_attr >> 16 & 0o777 == 0o640
        assert archive.getinfo(empty_directory).external_attr >> 16 & 0o777 == 0o750
        manifest = json.loads(archive.read("runtime-manifest.json"))
        assert manifest["entrypoints"] == {"browser": executable}
        assert manifest["dependencies"] == ["python-base@3.12"]

    store = RuntimeComponentStore(tmp_path / "store")
    installed = store.install_archive(result)
    active = store.active(installed.id)
    assert active is not None
    assert active[0].entrypoints == {"browser": executable}
    assert (active[1] / resources).read_bytes() == b"resource bytes"
    assert (active[1] / empty_directory).is_dir()
    if os.name != "nt":
        assert stat.S_IMODE((active[1] / executable).stat().st_mode) == 0o755
        assert stat.S_IMODE((active[1] / resources).stat().st_mode) == 0o640


@pytest.mark.parametrize(
    ("kind", "artifact_format", "entrypoint"),
    [
        ("other-runtime", "native-zip", "browser/headless"),
        ("browser-runtime", "native-tar-gz", "browser/headless"),
        ("browser-runtime", "native-zip", None),
        ("browser-runtime", "native-zip", "browser/missing"),
        ("browser-runtime", "native-zip", "browser/empty"),
        ("browser-runtime", "native-zip", "browser/resource.dat"),
    ],
)
def test_chromium_rejects_wrong_identity_format_and_entrypoint(
    tmp_path: Path, kind: str, artifact_format: str, entrypoint: str | None,
) -> None:
    source = tmp_path / "chromium.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("browser/headless", b"browser")
        archive.writestr("browser/resource.dat", b"not executable")
        archive.writestr("browser/empty/", b"")
    output = tmp_path / "runtime.zip"
    with pytest.raises(NativeArchiveError):
        normalize_engine_archive(
            source, _entry("browser-chromium", "1.0", kind, artifact_format, entrypoint), output,
            current_platform="darwin", current_architecture="arm64",
        )
    assert not output.exists()


@pytest.mark.parametrize("problem", ["path-escape", "symlink", "special-file", "duplicate", "reserved"])
def test_chromium_rejects_unsafe_zip_members(tmp_path: Path, problem: str) -> None:
    source = tmp_path / "chromium.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("browser/headless", b"browser")
        if problem == "path-escape":
            archive.writestr("../outside", b"bad")
        elif problem == "symlink":
            _zip_member(archive, "browser/link", b"../../outside", stat.S_IFLNK | 0o777)
        elif problem == "special-file":
            _zip_member(archive, "browser/pipe", b"", stat.S_IFIFO | 0o600)
        elif problem == "duplicate":
            archive.writestr("browser/HEADLESS", b"duplicate")
        else:
            archive.writestr("Runtime-Manifest.json", b"conflicts with generated manifest")
    with pytest.raises(NativeArchiveError):
        normalize_engine_archive(
            source,
            _entry("browser-chromium", "1.0", "browser-runtime", "native-zip", "browser/headless"),
            tmp_path / "runtime.zip", current_platform="win32", current_architecture="x64",
        )


@pytest.mark.parametrize(("name", "architecture"), [("ffmpeg", "arm64"), ("ffprobe", "x64")])
def test_macos_media_executable_keeps_license_and_version(
    tmp_path: Path, name: str, architecture: str,
) -> None:
    source = tmp_path / "upstream.zip"
    with zipfile.ZipFile(source, "w") as archive:
        _zip_member(archive, name, b"native executable", stat.S_IFREG | 0o755)
    entry = _entry(name, f"6.1.1+darwin.{architecture}", f"{name}-runtime", "native-zip", name)
    if name == "ffmpeg":
        entry.dependencies = ["ffprobe@6.1.1+darwin.arm64"]

    result = normalize_engine_archive(
        source, entry, tmp_path / "runtime.zip",
        current_platform="darwin", current_architecture=architecture,
    )

    with zipfile.ZipFile(result) as archive:
        assert set(archive.namelist()) == {
            name, "licenses/LICENSE.md", "licenses/COPYING.GPLv2", "licenses/sources.md", "runtime-manifest.json",
        }
        assert archive.read(name) == b"native executable"
        assert archive.getinfo(name).external_attr >> 16 & 0o777 == 0o755
        for filename in ("LICENSE.md", "COPYING.GPLv2", "sources.md"):
            assert archive.read(f"licenses/{filename}") == (native_packaging._FFMPEG_LICENSES / filename).read_bytes()
        manifest = json.loads(archive.read("runtime-manifest.json"))
        assert manifest["entrypoints"] == {name: name}
        assert manifest["dependencies"] == entry.dependencies

    store = RuntimeComponentStore(tmp_path / "store")
    store.install_archive(result)
    active = store.active(name)
    assert active is not None
    assert (active[1] / active[0].entrypoints[name]).read_bytes() == b"native executable"
    if os.name != "nt":
        assert stat.S_IMODE((active[1] / name).stat().st_mode) == 0o755


@pytest.mark.parametrize(
    ("kind", "version", "artifact_format", "entrypoint", "platform", "architecture", "extra", "mode"),
    [
        ("wrong-runtime", "6.1.1+darwin.arm64", "native-zip", "ffmpeg", "darwin", "arm64", False, 0o755),
        ("ffmpeg-runtime", "6.1.2+darwin.arm64", "native-zip", "ffmpeg", "darwin", "arm64", False, 0o755),
        ("ffmpeg-runtime", "6.1.1+darwin.arm64", "native-zip", "ffmpeg", "darwin", "x64", False, 0o755),
        ("ffmpeg-runtime", "6.1.1+darwin.arm64", "native-zip", "ffmpeg", "win32", "arm64", False, 0o755),
        ("ffmpeg-runtime", "6.1.1+darwin.arm64", "native-binary", "ffmpeg", "darwin", "arm64", False, 0o755),
        ("ffmpeg-runtime", "6.1.1+darwin.arm64", "native-zip", "ffprobe", "darwin", "arm64", False, 0o755),
        ("ffmpeg-runtime", "6.1.1+darwin.arm64", "native-zip", "ffmpeg", "darwin", "arm64", True, 0o755),
        ("ffmpeg-runtime", "6.1.1+darwin.arm64", "native-zip", "ffmpeg", "darwin", "arm64", False, 0o644),
    ],
)
def test_macos_media_rejects_wrong_archive(
    tmp_path: Path, kind: str, version: str, artifact_format: str, entrypoint: str,
    platform: str, architecture: str, extra: bool, mode: int,
) -> None:
    source = tmp_path / "upstream.zip"
    with zipfile.ZipFile(source, "w") as archive:
        _zip_member(archive, "ffmpeg", b"native executable", stat.S_IFREG | mode)
        if extra:
            archive.writestr("unexpected-file", b"unexpected")
    with pytest.raises(NativeArchiveError):
        normalize_engine_archive(
            source, _entry("ffmpeg", version, kind, artifact_format, entrypoint), tmp_path / "runtime.zip",
            current_platform=platform, current_architecture=architecture,
        )


def test_macos_media_fails_if_licenses_are_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "upstream.zip"
    with zipfile.ZipFile(source, "w") as archive:
        _zip_member(archive, "ffmpeg", b"native executable", stat.S_IFREG | 0o755)
    monkeypatch.setattr(native_packaging, "_FFMPEG_LICENSES", tmp_path / "missing")
    with pytest.raises(NativeArchiveError, match="license resources"):
        normalize_engine_archive(
            source, _entry("ffmpeg", "6.1.1+darwin.arm64", "ffmpeg-runtime", "native-zip", "ffmpeg"),
            tmp_path / "runtime.zip", current_platform="darwin", current_architecture="arm64",
        )
