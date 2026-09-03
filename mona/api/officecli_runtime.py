"""OfficeCLI runtime detection and download manager.

OfficeCLI is retained only so existing tasks can find an already-installed
binary. Mona no longer distributes or downloads new OfficeCLI binaries.

Windows is the primary target; macOS (arm64) is also provisioned.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from pydantic import BaseModel

__all__ = ("OfficeCliRuntime",)

# User-managed component root (shared with video runtime). Do not use the
# installation directory: it may be read-only and is replaced by app updates.
RESOURCE_ROOT = Path(
    os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
) / "Mona" / "resources"

OFFICECLI_VERSION = "1.0.141"


class OfficeCliStatus(BaseModel):
    """Status of the OfficeCLI runtime dependency."""

    ok: bool
    version: str | None = None
    path: str | None = None
    error: str | None = None
    supported: bool = True


def _platform_key() -> str | None:
    """Map the current platform to an asset key, or None if unsupported."""
    machine = platform.machine().lower()
    if sys.platform == "win32" and machine in ("amd64", "x86_64"):
        return "windows-amd64"
    if sys.platform == "darwin" and machine == "arm64":
        return "darwin-arm64"
    return None


def _run_sync(cmd: list[str], timeout: float = 10.0) -> tuple[int, str, str]:
    kwargs: dict[str, Any] = dict(
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        shell=False,
    )
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    try:
        proc = subprocess.run(cmd, **kwargs)
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return -1, "", str(exc)


class OfficeCliRuntime:
    """Detect and provision the OfficeCLI binary."""

    def __init__(self, runtime_root: Path | None = None) -> None:
        self.root = runtime_root or RESOURCE_ROOT

    def _component_dir(self) -> Path:
        return self.root / "officecli"

    def _cached_exe(self) -> Path | None:
        exe_dir = self._component_dir()
        name = "officecli.exe" if sys.platform == "win32" else "officecli"
        candidate = exe_dir / name
        if candidate.is_file():
            return candidate
        return None

    def get_officecli_path(self) -> str | None:
        """Return the officecli executable path (system install or cache)."""
        system = shutil.which("officecli")
        if system:
            return system
        cached = self._cached_exe()
        return str(cached) if cached else None

    def check(self) -> dict:
        """Detect officecli availability and version."""
        if _platform_key() is None:
            return OfficeCliStatus(
                ok=False,
                supported=False,
                error=f"Unsupported platform: {sys.platform}/{platform.machine()}",
            ).model_dump()
        exe = self.get_officecli_path()
        if not exe:
            return OfficeCliStatus(ok=False, error="officecli not found").model_dump()
        code, out, err = _run_sync([exe, "--version"])
        if code != 0:
            return OfficeCliStatus(
                ok=False, path=exe, error=err.strip() or "officecli --version failed"
            ).model_dump()
        return OfficeCliStatus(
            ok=True, version=out.strip().splitlines()[0] if out else None, path=exe
        ).model_dump()

    async def ensure(
        self,
        progress_cb: "Callable[[int, int], None] | None" = None,
    ) -> dict:
        """Keep the legacy API stable without distributing new OfficeCLI binaries."""
        _ = progress_cb
        return {
            "ok": False,
            "code": "OFFICECLI_REMOVED",
            "error": "旧 OfficeCLI 能力已停止分发",
        }
