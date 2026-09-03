"""On-demand, verified installation and lifecycle for the MIT Cua Driver."""

from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import shutil
import stat
import sys
import tempfile
import time
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from mona.config.paths import get_runtime_subdir
from mona.config.schema import MCPServerConfig
from mona.runtime.download import VerifiedDownloader

CUA_DRIVER_VERSION = "0.23.2"
_RELEASE_BASE = (
    f"https://github.com/trycua/cua/releases/download/cua-driver-rs-v{CUA_DRIVER_VERSION}"
)
_CUA_LICENSE_TEXT = """MIT License

Copyright (c) 2025 Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

_ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_WIN32_FALLBACK_MARKER = "falling back to win32-only window tools"


def _clean_driver_message(value: str) -> str:
    return _ANSI_ESCAPE_RE.sub("", value).strip()

BUILTIN_COMPUTER_TOOLS = [
    "check_permissions",
    "health_report",
    "get_accessibility_tree",
    "get_desktop_state",
    "launch_app",
    "bring_to_front",
    "list_apps",
    "list_windows",
    "get_window_state",
    "click",
    "double_click",
    "right_click",
    "drag",
    "type_text",
    "set_value",
    "press_key",
    "hotkey",
    "scroll",
    "invoke_menu",
    "zoom",
    "verify_state",
    "get_screen_size",
    "get_cursor_position",
]


@dataclass(frozen=True, slots=True)
class CuaReleaseAsset:
    filename: str
    size: int
    sha256: str

    @property
    def url(self) -> str:
        return f"{_RELEASE_BASE}/{self.filename}"


_ASSETS: dict[tuple[str, str], CuaReleaseAsset] = {
    ("win32", "x86_64"): CuaReleaseAsset(
        "cua-driver-rs-0.23.2-windows-x86_64-binary.zip",
        27_635_699,
        "27a41831d5dda71082b58154ff87966a9ad8131ce66e8060da2d860558655c13",
    ),
    ("win32", "arm64"): CuaReleaseAsset(
        "cua-driver-rs-0.23.2-windows-arm64-binary.zip",
        25_976_630,
        "c73d0359f7aeec178c700328d405236e28b471cbd4a1746f776f9c28a23c0fd7",
    ),
}


def _architecture() -> str:
    machine = platform.machine().lower()
    if machine in {"amd64", "x86_64", "x64"}:
        return "x86_64"
    if machine in {"arm64", "aarch64"}:
        return "arm64"
    return machine


def _release_asset() -> CuaReleaseAsset | None:
    return _ASSETS.get((sys.platform, _architecture()))


def _safe_member_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise RuntimeError(f"unsafe Cua Driver archive path: {name!r}")
    return path


def _require_child_path(root: Path, path: Path) -> None:
    resolved_root = root.resolve()
    resolved_path = path.resolve(strict=False)
    if resolved_path == resolved_root or resolved_root not in resolved_path.parents:
        raise RuntimeError(f"Computer Use runtime path escapes its root: {resolved_path}")


class CuaDriverManager:
    def __init__(
        self,
        *,
        root: Path | None = None,
        downloader: VerifiedDownloader | None = None,
    ) -> None:
        self.root = root or get_runtime_subdir("computer-use")
        self._uses_managed_installer = downloader is None
        self.downloader = downloader or VerifiedDownloader(read_timeout_seconds=120.0)
        self._task: asyncio.Task[None] | None = None
        self._job: dict[str, Any] | None = None
        self._authorization_state: str | None = None
        self._health_error: str | None = None
        self._degraded = False
        self._connection_error: str | None = None
        self._health_checked_at = 0.0

    @property
    def version_root(self) -> Path:
        return self.root / "versions" / CUA_DRIVER_VERSION

    @property
    def executable(self) -> Path | None:
        try:
            from mona.config.paths import get_managed_runtimes_dir
            from mona.runtime.manager import RuntimeComponentStore

            active = RuntimeComponentStore(get_managed_runtimes_dir()).active("cua-driver")
        except Exception:
            active = None
        if active is not None:
            relative = active[0].entrypoints.get("driver")
            managed = active[1] / Path(relative or "")
            if relative and managed.is_file():
                return managed
        filename = "cua-driver.exe" if os.name == "nt" else "cua-driver"
        path = self.version_root / filename
        return path if path.is_file() else None

    def status(self, *, enabled: bool) -> dict[str, Any]:
        asset = _release_asset()
        executable = self.executable
        if not enabled:
            state = "disabled"
        elif self._job and self._job["state"] in {"queued", "running"}:
            state = "downloading"
        elif self._job and self._job["state"] == "failed":
            state = "error"
        elif self._connection_error:
            state = "error"
        elif self._authorization_state == "pending_authorization":
            state = "pending_authorization"
        elif self._authorization_state == "error":
            state = "error"
        elif executable is not None:
            state = "available"
        else:
            state = "not_installed"
        return {
            "schemaVersion": 1,
            "enabled": enabled,
            "state": state,
            "supported": asset is not None,
            "version": CUA_DRIVER_VERSION,
            "downloadBytes": asset.size if asset else 0,
            "installed": executable is not None,
            "executablePath": str(executable) if executable else None,
            "degraded": self._degraded,
            "error": self._connection_error or self._health_error,
            "job": dict(self._job) if self._job else None,
        }

    async def start_install(self) -> dict[str, Any]:
        asset = _release_asset()
        if asset is None:
            raise RuntimeError("Computer Use is not available for this platform/architecture")
        if self.executable is not None:
            return self.status(enabled=True)
        if self._task is not None and not self._task.done():
            return self.status(enabled=True)
        now = int(time.time() * 1000)
        self._job = {
            "jobId": uuid.uuid4().hex,
            "state": "queued",
            "stage": "queued",
            "downloadedBytes": 0,
            "totalBytes": asset.size,
            "error": None,
            "createdAt": now,
            "updatedAt": now,
        }
        self._task = asyncio.create_task(self._install(asset))
        return self.status(enabled=True)

    async def cancel_install(self) -> dict[str, Any]:
        task = self._task
        if task is None or task.done():
            raise ValueError("Computer Use download is not running")
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return self.status(enabled=True)

    async def wait_install(self) -> dict[str, Any]:
        task = self._task
        if task is not None:
            await asyncio.shield(task)
        return self.status(enabled=True)

    async def _install(self, asset: CuaReleaseAsset) -> None:
        assert self._job is not None
        job = self._job
        job["state"] = "running"
        job["stage"] = "downloading"
        job["updatedAt"] = int(time.time() * 1000)

        def progress(current: int, total: int) -> None:
            job["downloadedBytes"] = current
            job["totalBytes"] = total
            job["updatedAt"] = int(time.time() * 1000)

        try:
            if self._uses_managed_installer:
                from mona.runtime.official import ensure_official_runtime_resource

                await ensure_official_runtime_resource(
                    "computer_use",
                    lambda _ref, current, total: progress(current, total),
                )
                if self.executable is None:
                    raise RuntimeError(
                        "电脑操作组件安装后不可用，请在功能资源中修复"
                    )
            else:
                archive = self.root / "downloads" / asset.filename
                result = await self.downloader.download(
                    [asset.url],
                    archive,
                    expected_sha256=asset.sha256,
                    expected_size=asset.size,
                    progress=progress,
                )
                job["stage"] = "installing"
                await asyncio.to_thread(self._extract_and_activate, result.path, asset)
            await self._verify()
            await self.refresh_health(force=True)
            job["state"] = "completed"
            job["stage"] = "ready"
            job["downloadedBytes"] = job["totalBytes"]
        except asyncio.CancelledError:
            job["state"] = "cancelled"
            job["stage"] = "cancelled"
            job["error"] = "下载已取消，可稍后继续"
            raise
        except Exception as exc:
            job["state"] = "failed"
            job["stage"] = "failed"
            job["error"] = str(exc)[:2000]
        finally:
            job["updatedAt"] = int(time.time() * 1000)
            job["finishedAt"] = job["updatedAt"]

    def _extract_and_activate(self, archive: Path, asset: CuaReleaseAsset) -> None:
        _require_child_path(self.root, self.version_root)
        self.version_root.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(
            tempfile.mkdtemp(
                prefix=f".{CUA_DRIVER_VERSION}-",
                dir=self.version_root.parent,
            )
        )
        _require_child_path(self.root, staging)
        try:
            self._extract_zip(archive, staging)
            filename = "cua-driver.exe" if os.name == "nt" else "cua-driver"
            candidates = list(staging.rglob(filename))
            if len(candidates) != 1:
                raise RuntimeError("Cua Driver archive does not contain exactly one executable")
            executable = candidates[0]
            if executable.parent != staging:
                for item in executable.parent.iterdir():
                    shutil.move(str(item), staging / item.name)
            executable = staging / filename
            if os.name != "nt":
                executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
            receipt = {
                "schemaVersion": 1,
                "component": "cua-driver",
                "version": CUA_DRIVER_VERSION,
                "source": asset.url,
                "sha256": asset.sha256,
                "license": "MIT",
                "installedAt": int(time.time()),
            }
            (staging / "receipt.json").write_text(
                json.dumps(receipt, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            (staging / "LICENSE-CUA-MIT.txt").write_text(_CUA_LICENSE_TEXT, encoding="utf-8")
            if self.version_root.exists():
                shutil.rmtree(self.version_root)
            os.replace(staging, self.version_root)
        finally:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)

    @staticmethod
    def _extract_zip(archive: Path, destination: Path) -> None:
        with zipfile.ZipFile(archive) as bundle:
            if len(bundle.infolist()) > 100:
                raise RuntimeError("Cua Driver archive contains too many files")
            total = 0
            for member in bundle.infolist():
                target = destination.joinpath(*_safe_member_path(member.filename).parts)
                total += member.file_size
                if total > 500 * 1024 * 1024:
                    raise RuntimeError("Cua Driver archive is too large after extraction")
                mode = member.external_attr >> 16
                if stat.S_ISLNK(mode):
                    raise RuntimeError("Cua Driver archive contains a symbolic link")
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)

    async def _verify(self) -> None:
        executable = self.executable
        if executable is None:
            raise RuntimeError("Cua Driver executable is missing after installation")
        process = await asyncio.create_subprocess_exec(
            str(executable),
            "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.environment(),
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=15)
        if process.returncode != 0 or CUA_DRIVER_VERSION not in stdout.decode(errors="replace"):
            detail = stderr.decode(errors="replace").strip()
            raise RuntimeError(f"Cua Driver verification failed: {detail or process.returncode}")

    async def refresh_health(self, *, force: bool = False) -> dict[str, Any]:
        executable = self.executable
        if executable is None:
            self._authorization_state = None
            self._health_error = None
            self._degraded = False
            return self.status(enabled=True)
        if not force and time.monotonic() - self._health_checked_at < 10.0:
            return self.status(enabled=True)
        self._health_checked_at = time.monotonic()
        self._degraded = False
        try:
            process = await asyncio.create_subprocess_exec(
                str(executable),
                "doctor",
                "--json",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=self.environment(),
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=20)
            stdout_text = _clean_driver_message(stdout.decode(errors="replace"))
            stderr_text = _clean_driver_message(stderr.decode(errors="replace"))
            fallback_active = _WIN32_FALLBACK_MARKER in stderr_text.lower()

            payload: Any = None
            if stdout_text:
                try:
                    payload = json.loads(stdout_text)
                except json.JSONDecodeError:
                    if not fallback_active:
                        raise
            if payload is None:
                if fallback_active:
                    self._authorization_state = "available"
                    self._health_error = None
                    self._degraded = True
                    return self.status(enabled=True)
                raise RuntimeError(stderr_text or "driver doctor failed")

            probes = payload.get("probes", []) if isinstance(payload, dict) else []
            failed = [
                probe
                for probe in probes
                if isinstance(probe, dict) and probe.get("status") not in {"ok", "pass", "skip"}
            ]
            permission_failure = any(
                any(
                    marker in str(probe.get("label", "")).lower()
                    for marker in ("tcc", "accessibility", "screen")
                )
                for probe in failed
            )
            non_uia_failures = [
                probe
                for probe in failed
                if not any(
                    marker in str(probe.get("label", "")).lower()
                    for marker in ("uia", "ui automation")
                )
            ]
            degraded = fallback_active and not permission_failure and not non_uia_failures
            if process.returncode != 0 and not degraded and not failed:
                raise RuntimeError(stderr_text or "driver doctor failed")
            self._authorization_state = (
                "pending_authorization"
                if permission_failure
                else ("error" if non_uia_failures or (failed and not degraded) else "available")
            )
            self._health_error = (
                "; ".join(
                    str(probe.get("message") or probe.get("label") or "driver probe failed")
                    for probe in failed
                )[:2000]
                if failed and not degraded
                else None
            )
            self._degraded = degraded
        except Exception as exc:
            self._authorization_state = "error"
            self._health_error = _clean_driver_message(str(exc))[:2000]
            self._degraded = False
        return self.status(enabled=True)

    async def grant_permissions(self) -> dict[str, Any]:
        executable = self.executable
        if executable is None:
            raise RuntimeError("Cua Driver is not installed")
        return await self.refresh_health(force=True)

    def set_connection_result(self, error: str | None) -> None:
        self._connection_error = _clean_driver_message(error)[:2000] if error else None

    def environment(self) -> dict[str, str]:
        env = dict(os.environ)
        state_root = str(self.root / "state")
        env["CUA_DRIVER_HOME"] = state_root
        env["CUA_DRIVER_RS_HOME"] = state_root
        env["CUA_DRIVER_LOCAL_HOME"] = state_root
        env["CUA_DRIVER_TELEMETRY_HOME"] = state_root
        env["CUA_DRIVER_RS_TELEMETRY_ENABLED"] = "0"
        env["CUA_DRIVER_PERMISSION_MODE"] = "standard"
        return env

    def mcp_config(self) -> MCPServerConfig:
        executable = self.executable
        if executable is None:
            raise RuntimeError("Cua Driver is not installed")
        state_root = str(self.root / "state")
        return MCPServerConfig(
            type="stdio",
            command=str(executable),
            args=["mcp", "--direct", "--no-overlay"],
            env={
                "CUA_DRIVER_HOME": state_root,
                "CUA_DRIVER_RS_HOME": state_root,
                "CUA_DRIVER_LOCAL_HOME": state_root,
                "CUA_DRIVER_TELEMETRY_HOME": state_root,
                "CUA_DRIVER_RS_TELEMETRY_ENABLED": "0",
                "CUA_DRIVER_PERMISSION_MODE": "standard",
            },
            tool_timeout=60,
            enabled_tools=list(BUILTIN_COMPUTER_TOOLS),
        )


_MANAGER: CuaDriverManager | None = None


def get_cua_driver_manager() -> CuaDriverManager:
    global _MANAGER
    if _MANAGER is None:
        _MANAGER = CuaDriverManager()
    return _MANAGER
