"""Unit tests for the managed Cua Driver runtime."""

from __future__ import annotations

import asyncio
import json
import stat
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

import mona.computer_use.runtime as runtime
from mona.runtime.download import VerifiedDownloadResult
from mona.runtime.manager import RuntimeComponentStore


def _driver_path(manager: runtime.CuaDriverManager) -> Path:
    filename = "cua-driver.exe" if runtime.os.name == "nt" else "cua-driver"
    return manager.version_root / filename


def _test_asset(monkeypatch: pytest.MonkeyPatch) -> runtime.CuaReleaseAsset:
    asset = runtime.CuaReleaseAsset(
        filename="cua-driver-test.zip",
        size=12,
        sha256="a" * 64,
    )
    monkeypatch.setattr(runtime, "_release_asset", lambda: asset)
    return asset


def test_driver_manager_resolves_managed_component(monkeypatch, tmp_path) -> None:
    runtime_root = tmp_path / "managed"
    archive = tmp_path / "cua.zip"
    filename = "cua-driver.exe" if runtime.os.name == "nt" else "cua-driver"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": "cua-driver",
                    "version": runtime.CUA_DRIVER_VERSION,
                    "kind": "computer-use-runtime",
                    "entrypoints": {"driver": f"bin/{filename}"},
                }
            ),
        )
        bundle.writestr(f"bin/{filename}", b"driver")
    RuntimeComponentStore(runtime_root).install_archive(archive)
    monkeypatch.setattr("mona.config.paths.get_managed_runtimes_dir", lambda: runtime_root)

    assert runtime.CuaDriverManager(root=tmp_path / "legacy").executable == (
        runtime_root
        / "components"
        / "cua-driver"
        / "versions"
        / runtime.CUA_DRIVER_VERSION
        / "bin"
        / filename
    )


@pytest.mark.parametrize(
    ("sys_platform", "machine", "filename"),
    [
        (
            "win32",
            "AMD64",
            "cua-driver-rs-0.23.2-windows-x86_64-binary.zip",
        ),
        (
            "win32",
            "aarch64",
            "cua-driver-rs-0.23.2-windows-arm64-binary.zip",
        ),
    ],
)
def test_release_asset_selects_platform_and_architecture(
    monkeypatch: pytest.MonkeyPatch,
    sys_platform: str,
    machine: str,
    filename: str,
) -> None:
    monkeypatch.setattr(runtime.sys, "platform", sys_platform)
    monkeypatch.setattr(runtime.platform, "machine", lambda: machine)

    asset = runtime._release_asset()

    assert asset is not None
    assert asset.filename == filename


def test_release_asset_is_unavailable_for_unknown_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(runtime.sys, "platform", "freebsd")
    monkeypatch.setattr(runtime.platform, "machine", lambda: "x86_64")

    assert runtime._release_asset() is None


def test_status_reports_disabled_and_not_installed_defaults(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    asset = _test_asset(monkeypatch)
    manager = runtime.CuaDriverManager(root=tmp_path / "computer-use", downloader=MagicMock())

    disabled = manager.status(enabled=False)
    assert disabled["schemaVersion"] == 1
    assert disabled["enabled"] is False
    assert disabled["state"] == "disabled"
    assert disabled["supported"] is True
    assert disabled["version"] == runtime.CUA_DRIVER_VERSION
    assert disabled["downloadBytes"] == asset.size
    assert disabled["installed"] is False
    assert disabled["executablePath"] is None
    assert disabled["job"] is None

    enabled = manager.status(enabled=True)
    assert enabled["state"] == "not_installed"
    assert enabled["enabled"] is True


def test_status_reports_installed_driver(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _test_asset(monkeypatch)
    manager = runtime.CuaDriverManager(root=tmp_path / "computer-use", downloader=MagicMock())
    executable = _driver_path(manager)
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"driver")

    status = manager.status(enabled=True)

    assert status["state"] == "available"
    assert status["installed"] is True
    assert status["executablePath"] == str(executable)

    manager.set_connection_result("MCP unavailable")
    failed = manager.status(enabled=True)
    assert failed["state"] == "error"
    assert failed["error"] == "MCP unavailable"


@pytest.mark.asyncio
async def test_health_probe_accepts_win32_fallback_and_strips_ansi(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _test_asset(monkeypatch)
    manager = runtime.CuaDriverManager(root=tmp_path / "computer-use", downloader=MagicMock())
    executable = _driver_path(manager)
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"driver")

    class FallbackProcess:
        returncode = 1

        async def communicate(self) -> tuple[bytes, bytes]:
            return (
                b"",
                b"\x1b[33mWARN\x1b[0m UIA health probe exceeded 2000ms; "
                b"falling back to Win32-only window tools",
            )

    monkeypatch.setattr(
        runtime.asyncio,
        "create_subprocess_exec",
        AsyncMock(return_value=FallbackProcess()),
    )

    status = await manager.refresh_health(force=True)

    assert status["state"] == "available"
    assert status["degraded"] is True
    assert status["error"] is None


@pytest.mark.asyncio
async def test_health_probe_keeps_real_failure_without_ansi(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _test_asset(monkeypatch)
    manager = runtime.CuaDriverManager(root=tmp_path / "computer-use", downloader=MagicMock())
    executable = _driver_path(manager)
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"driver")

    class FailedProcess:
        returncode = 1

        async def communicate(self) -> tuple[bytes, bytes]:
            return b"", b"\x1b[31mdriver unavailable\x1b[0m"

    monkeypatch.setattr(
        runtime.asyncio,
        "create_subprocess_exec",
        AsyncMock(return_value=FailedProcess()),
    )

    status = await manager.refresh_health(force=True)

    assert status["state"] == "error"
    assert status["degraded"] is False
    assert status["error"] == "driver unavailable"


@pytest.mark.asyncio
async def test_start_install_reports_progress_and_verifies_success(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    asset = _test_asset(monkeypatch)
    progress_seen = asyncio.Event()
    continue_download = asyncio.Event()

    class ControlledDownloader:
        def __init__(self) -> None:
            self.call: dict[str, object] | None = None

        async def download(
            self,
            urls: list[str],
            destination: Path,
            *,
            expected_sha256: str,
            expected_size: int,
            progress,
        ) -> VerifiedDownloadResult:
            self.call = {
                "urls": urls,
                "destination": destination,
                "expected_sha256": expected_sha256,
                "expected_size": expected_size,
            }
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(b"archive fixture")
            progress(4, expected_size)
            progress_seen.set()
            await continue_download.wait()
            progress(expected_size, expected_size)
            return VerifiedDownloadResult(
                path=destination,
                source_url=urls[0],
                bytes=expected_size,
                sha256=expected_sha256,
                cached=False,
            )

    downloader = ControlledDownloader()
    manager = runtime.CuaDriverManager(root=tmp_path / "computer-use", downloader=downloader)  # type: ignore[arg-type]

    def activate_fixture(_archive: Path, _asset: runtime.CuaReleaseAsset) -> None:
        executable = _driver_path(manager)
        executable.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b"driver")

    extract = MagicMock(side_effect=activate_fixture)
    verify = AsyncMock()
    refresh_health = AsyncMock()
    monkeypatch.setattr(manager, "_extract_and_activate", extract)
    monkeypatch.setattr(manager, "_verify", verify)
    monkeypatch.setattr(manager, "refresh_health", refresh_health)

    queued = await manager.start_install()
    assert queued["state"] == "downloading"
    assert queued["job"]["state"] == "queued"

    await progress_seen.wait()
    running = manager.status(enabled=True)
    assert running["state"] == "downloading"
    assert running["job"]["stage"] == "downloading"
    assert running["job"]["downloadedBytes"] == 4
    assert running["job"]["totalBytes"] == asset.size

    continue_download.set()
    finished = await manager.wait_install()

    assert finished["state"] == "available"
    assert finished["installed"] is True
    assert finished["job"]["state"] == "completed"
    assert finished["job"]["stage"] == "ready"
    assert finished["job"]["downloadedBytes"] == asset.size
    assert downloader.call == {
        "urls": [asset.url],
        "destination": manager.root / "downloads" / asset.filename,
        "expected_sha256": asset.sha256,
        "expected_size": asset.size,
    }
    extract.assert_called_once_with(
        manager.root / "downloads" / asset.filename,
        asset,
    )
    verify.assert_awaited_once_with()
    refresh_health.assert_awaited_once_with(force=True)


@pytest.mark.asyncio
async def test_cancel_install_marks_download_cancelled(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _test_asset(monkeypatch)
    started = asyncio.Event()
    release = asyncio.Event()

    class BlockingDownloader:
        async def download(self, *_args, progress, **_kwargs) -> VerifiedDownloadResult:
            started.set()
            await release.wait()
            raise AssertionError("cancelled download should not return")

    manager = runtime.CuaDriverManager(
        root=tmp_path / "computer-use",
        downloader=BlockingDownloader(),  # type: ignore[arg-type]
    )
    await manager.start_install()
    await started.wait()

    cancelled = await manager.cancel_install()

    assert cancelled["state"] == "not_installed"
    assert cancelled["job"]["state"] == "cancelled"
    assert cancelled["job"]["stage"] == "cancelled"
    assert "取消" in cancelled["job"]["error"]
    release.set()


def test_extract_zip_rejects_path_traversal(tmp_path: Path) -> None:
    archive = tmp_path / "traversal.zip"
    destination = tmp_path / "staging"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("../escape.txt", b"escape")

    with pytest.raises(RuntimeError, match="unsafe Cua Driver archive path"):
        runtime.CuaDriverManager._extract_zip(archive, destination)

    assert not (tmp_path / "escape.txt").exists()


def test_extract_zip_rejects_symbolic_links(tmp_path: Path) -> None:
    archive = tmp_path / "symlink.zip"
    destination = tmp_path / "staging"
    link = zipfile.ZipInfo("driver-link")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(link, "cua-driver")

    with pytest.raises(RuntimeError, match="symbolic link"):
        runtime.CuaDriverManager._extract_zip(archive, destination)

    assert not (destination / "driver-link").exists()


def test_install_writes_receipt_and_mit_license(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    asset = _test_asset(monkeypatch)
    archive = tmp_path / asset.filename
    executable_name = "cua-driver.exe" if runtime.os.name == "nt" else "cua-driver"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(executable_name, b"driver")

    manager = runtime.CuaDriverManager(root=tmp_path / "computer-use", downloader=MagicMock())
    manager._extract_and_activate(archive, asset)

    receipt = (manager.version_root / "receipt.json").read_text(encoding="utf-8")
    license_text = (manager.version_root / "LICENSE-CUA-MIT.txt").read_text(encoding="utf-8")
    assert '"license": "MIT"' in receipt
    assert "Copyright (c) 2025 Cua AI, Inc." in license_text


def test_mcp_config_exposes_only_allowlisted_tools_and_disables_telemetry(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _test_asset(monkeypatch)
    manager = runtime.CuaDriverManager(root=tmp_path / "computer-use", downloader=MagicMock())
    executable = _driver_path(manager)
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"driver")

    config = manager.mcp_config()

    assert config.type == "stdio"
    assert config.command == str(executable)
    assert config.args == ["mcp", "--direct", "--no-overlay"]
    assert config.enabled_tools == runtime.BUILTIN_COMPUTER_TOOLS
    assert "*" not in config.enabled_tools
    assert set(config.env) == {
        "CUA_DRIVER_HOME",
        "CUA_DRIVER_RS_HOME",
        "CUA_DRIVER_LOCAL_HOME",
        "CUA_DRIVER_TELEMETRY_HOME",
        "CUA_DRIVER_RS_TELEMETRY_ENABLED",
        "CUA_DRIVER_PERMISSION_MODE",
    }
    assert config.env["CUA_DRIVER_RS_TELEMETRY_ENABLED"] == "0"
    assert config.env["CUA_DRIVER_PERMISSION_MODE"] == "standard"
    assert config.env["CUA_DRIVER_HOME"] == str(manager.root / "state")
