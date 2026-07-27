"""OfficeCLI runtime detection and download manager.

OfficeCLI powers the PPT template-edit track (fill user-provided .pptx
templates). The binary is not bundled into the installer (~33 MB); it is
downloaded lazily on first use from Mona's Qiniu CDN into the per-user
resources directory.

Windows is the primary target; macOS (arm64) is also provisioned.
"""

from __future__ import annotations

import hashlib
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

import aiohttp
from loguru import logger
from pydantic import BaseModel

from mona.security.network import validate_url_target

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = ("OfficeCliRuntime",)

# User-managed component root (shared with video runtime). Do not use the
# installation directory: it may be read-only and is replaced by app updates.
RESOURCE_ROOT = Path(
    os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
) / "Mona" / "resources"

# Pinned upstream release (iOfficeAI/OfficeCLI), mirrored on Mona's CDN.
OFFICECLI_VERSION = "1.0.141"
_CDN_BASE = f"https://dl.mona.lzfun.vip/officecli/v{OFFICECLI_VERSION}"

# sha256 of the mirrored binaries, verified against upstream SHA256SUMS.
# Filled per platform key: (asset_name, sha256).
_ASSETS: dict[str, tuple[str, str]] = {
    "windows-amd64": (
        "officecli-win-x64.exe",
        "65d119912147b47d102224715df2288813a2fea56520bfc4313b2fa0bf4672c7",
    ),
    "darwin-arm64": (
        "officecli-mac-arm64",
        "a9639df060513d73b125849e4c630383f7a80f70e61911ef486dd24ec2208e37",
    ),
}

_DOWNLOAD_CHUNK = 1 << 16  # 64 KiB


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
        """Download the pinned officecli binary into the resources directory."""
        existing = self._cached_exe()
        if existing:
            return {"ok": True, "path": str(existing), "cached": True}

        key = _platform_key()
        if key is None:
            return {
                "ok": False,
                "error": f"Unsupported platform: {sys.platform}/{platform.machine()}",
            }
        asset_name, expected_sha = _ASSETS[key]
        url = f"{_CDN_BASE}/{asset_name}"

        dest_dir = self._component_dir()
        dest_dir.mkdir(parents=True, exist_ok=True)
        final_name = "officecli.exe" if sys.platform == "win32" else "officecli"
        dest = dest_dir / final_name
        tmp = dest_dir / f"{final_name}.download"

        try:
            await self._download(url, tmp, progress_cb)
            actual_sha = self._sha256(tmp)
            if actual_sha != expected_sha:
                tmp.unlink(missing_ok=True)
                logger.error(
                    "officecli sha256 mismatch: expected {}, got {}",
                    expected_sha,
                    actual_sha,
                )
                return {"ok": False, "error": "下载文件校验失败，请重试"}
            tmp.replace(dest)
            if sys.platform != "win32":
                dest.chmod(dest.stat().st_mode | 0o111)
        except Exception as exc:
            tmp.unlink(missing_ok=True)
            logger.exception("officecli download failed")
            return {"ok": False, "error": str(exc)}

        logger.info("officecli provisioned at {}", dest)
        return {"ok": True, "path": str(dest)}

    async def _download(
        self,
        url: str,
        dest: Path,
        progress_cb: "Callable[[int, int], None] | None",
    ) -> None:
        ok, err = validate_url_target(url)
        if not ok:
            raise RuntimeError(f"URL blocked by SSRF guard: {err}")
        timeout = aiohttp.ClientTimeout(total=600)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, allow_redirects=True) as resp:
                resp.raise_for_status()
                total = int(resp.headers.get("Content-Length", "0"))
                downloaded = 0
                with open(dest, "wb") as f:
                    async for chunk in resp.content.iter_chunked(_DOWNLOAD_CHUNK):
                        f.write(chunk)
                        downloaded += len(chunk)
                        if progress_cb:
                            progress_cb(downloaded, total)
        logger.debug("Downloaded {} -> {}", url, dest)

    @staticmethod
    def _sha256(path: Path) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
