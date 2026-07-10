"""Video runtime dependency detection and download manager.

Detects Node.js 22+, FFmpeg, and Chrome; lazily downloads missing
components to ``~/.mona/runtime/<component>/``.

Windows is the primary target: Node and FFmpeg ship as zip archives that
are extracted in place. Chrome is provisioned through
``npx hyperframes browser ensure`` (requires Node first).
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import aiohttp
from loguru import logger
from pydantic import BaseModel

from mona.security.network import validate_url_target

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = ("VideoRuntime",)

# Runtime root: ~/.mona/runtime/
RUNTIME_ROOT = Path.home() / ".mona" / "runtime"

# Fixed download sources (Windows builds).
NODE_URL = "https://nodejs.org/dist/v22.11.0/node-v22.11.0-win-x64.zip"
FFMPEG_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-master-latest-win64-gpl.zip"
)

NODE_MIN_MAJOR = 22

# Chunk size for streaming downloads.
_DOWNLOAD_CHUNK = 1 << 16  # 64 KiB


class ComponentStatus(BaseModel):
    """Status of a single runtime dependency."""

    ok: bool
    version: str | None = None
    path: str | None = None
    error: str | None = None


def _run_sync(cmd: list[str], timeout: float = 10.0) -> tuple[int, str, str]:
    """Run a command synchronously, capturing stdout/stderr.

    Returns (returncode, stdout, stderr). On failure returns (-1, "", error).
    """
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


class VideoRuntime:
    """Detect and provision Node.js / FFmpeg / Chrome for video rendering."""

    def __init__(self, runtime_root: Path | None = None) -> None:
        self.root = runtime_root or RUNTIME_ROOT

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    def _component_dir(self, component: str) -> Path:
        return self.root / component

    def _cached_node_exe(self) -> Path | None:
        node_dir = self._component_dir("node")
        if not node_dir.exists():
            return None
        # zip extracts to node-v22.11.0-win-x64/node.exe
        for exe in node_dir.rglob("node.exe"):
            return exe
        for exe in node_dir.rglob("node"):
            if exe.is_file() and exe.suffix == "":
                return exe
        return None

    def _cached_ffmpeg_exe(self) -> Path | None:
        ff_dir = self._component_dir("ffmpeg")
        if not ff_dir.exists():
            return None
        for exe in ff_dir.rglob("ffmpeg.exe"):
            return exe
        for exe in ff_dir.rglob("ffmpeg"):
            if exe.is_file() and exe.suffix == "":
                return exe
        return None

    def _cached_chrome_exe(self) -> Path | None:
        ch_dir = self._component_dir("chrome")
        if not ch_dir.exists():
            return None
        for name in ("chrome.exe", "msedge.exe", "headless_shell.exe", "chrome"):
            for exe in ch_dir.rglob(name):
                if exe.is_file():
                    return exe
        return None

    @staticmethod
    def _system_chrome_candidates() -> list[Path]:
        if sys.platform == "win32":
            return [
                Path(
                    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
                ),
                Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
                Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
                Path(
                    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
                ),
            ]
        if sys.platform == "darwin":
            return [
                Path(
                    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
                ),
                Path(
                    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
                ),
            ]
        return [
            Path("/usr/bin/google-chrome"),
            Path("/usr/bin/chromium"),
            Path("/usr/bin/microsoft-edge"),
        ]

    # ------------------------------------------------------------------
    # Public path getters
    # ------------------------------------------------------------------

    def get_node_path(self) -> str | None:
        """Return the node executable path (system install or cache)."""
        system = shutil.which("node")
        if system:
            return system
        cached = self._cached_node_exe()
        return str(cached) if cached else None

    def get_ffmpeg_path(self) -> str | None:
        """Return the ffmpeg executable path (system install or cache)."""
        system = shutil.which("ffmpeg")
        if system:
            return system
        cached = self._cached_ffmpeg_exe()
        return str(cached) if cached else None

    def get_chrome_path(self) -> str | None:
        """Return a Chromium-based browser executable path."""
        for cand in self._system_chrome_candidates():
            if cand.exists() and cand.is_file():
                return str(cand)
        cached = self._cached_chrome_exe()
        return str(cached) if cached else None

    def get_npx_path(self) -> str | None:
        """Return the path to npx-cli.js alongside the resolved Node.

        npx-cli.js is invoked via ``node <npx-cli.js>`` to avoid the
        Windows ``.cmd`` quoting pitfalls of ``create_subprocess_exec``.
        """
        node_path = self.get_node_path()
        if not node_path:
            return None
        prefix = Path(node_path).parent
        candidate = prefix / "node_modules" / "npm" / "bin" / "npx-cli.js"
        if candidate.exists():
            return str(candidate)
        return None

    def build_env(self) -> dict:
        """Build a child-process environment with runtime PATH prepended."""
        env = os.environ.copy()
        paths: list[str] = []
        node_exe = self._cached_node_exe()
        if node_exe:
            paths.append(str(node_exe.parent))
        ff_exe = self._cached_ffmpeg_exe()
        if ff_exe:
            paths.append(str(ff_exe.parent))
        if paths:
            env["PATH"] = os.pathsep.join(paths + [env.get("PATH", "")])
        return env

    # ------------------------------------------------------------------
    # Detection
    # ------------------------------------------------------------------

    def _check_node(self) -> ComponentStatus:
        node_path = self.get_node_path()
        if not node_path:
            return ComponentStatus(ok=False, error="Node.js not found")
        code, out, err = _run_sync([node_path, "--version"])
        if code != 0:
            return ComponentStatus(
                ok=False, path=node_path, error=err or "node --version failed"
            )
        version = out.strip()
        match = re.match(r"v?(\d+)", version)
        if not match:
            return ComponentStatus(
                ok=False, path=node_path, version=version, error="Cannot parse version"
            )
        major = int(match.group(1))
        if major < NODE_MIN_MAJOR:
            return ComponentStatus(
                ok=False,
                path=node_path,
                version=version,
                error=f"Node {major} < required {NODE_MIN_MAJOR}",
            )
        return ComponentStatus(ok=True, version=version, path=node_path)

    def _check_ffmpeg(self) -> ComponentStatus:
        ff_path = self.get_ffmpeg_path()
        if not ff_path:
            return ComponentStatus(ok=False, error="FFmpeg not found")
        code, out, _ = _run_sync([ff_path, "-version"])
        if code != 0:
            return ComponentStatus(
                ok=False, path=ff_path, error="ffmpeg -version failed"
            )
        first_line = out.splitlines()[0] if out else ""
        return ComponentStatus(ok=True, version=first_line, path=ff_path)

    def _check_chrome(self) -> ComponentStatus:
        ch_path = self.get_chrome_path()
        if not ch_path:
            return ComponentStatus(ok=False, error="Chrome/Edge not found")
        version = None
        if sys.platform == "win32":
            # 读取 PE 文件版本信息，避免启动浏览器进程（msedge.exe --version
            # 即使加 --headless=new 仍会短暂创建渲染窗口）
            escaped = ch_path.replace("'", "''")
            code, out, _ = _run_sync(
                [
                    "powershell", "-NoProfile", "-NonInteractive", "-Command",
                    f"(Get-Item -LiteralPath '{escaped}').VersionInfo.ProductVersion",
                ],
                timeout=5.0,
            )
            version = out.strip() if code == 0 and out else None
        else:
            code, out, _ = _run_sync([ch_path, "--version"], timeout=5.0)
            version = out.strip() if code == 0 and out else None
        return ComponentStatus(ok=True, version=version, path=ch_path)

    def check_all(self) -> dict:
        """Detect all three dependencies.

        Returns ``{node: {...}, ffmpeg: {...}, chrome: {...}}``.
        """
        return {
            "node": self._check_node().model_dump(),
            "ffmpeg": self._check_ffmpeg().model_dump(),
            "chrome": self._check_chrome().model_dump(),
        }

    # ------------------------------------------------------------------
    # Download / provisioning
    # ------------------------------------------------------------------

    async def ensure_runtime(
        self,
        component: str,
        progress_cb: "Callable[[int, int], None] | None" = None,
    ) -> dict:
        """Download and extract a component into ``~/.mona/runtime/<component>/``.

        Args:
            component: One of ``"node"``, ``"ffmpeg"``, ``"chrome"``.
            progress_cb: Optional callback ``(downloaded_bytes, total_bytes)``.

        Returns a dict with ``ok`` and either ``path`` or ``error``.
        """
        if component == "node":
            return await self._ensure_node(progress_cb)
        if component == "ffmpeg":
            return await self._ensure_ffmpeg(progress_cb)
        if component == "chrome":
            return await self._ensure_chrome(progress_cb)
        return {"ok": False, "error": f"Unknown component: {component}"}

    async def _ensure_node(
        self, progress_cb: "Callable[[int, int], None] | None"
    ) -> dict:
        existing = self._cached_node_exe()
        if existing:
            return {"ok": True, "path": str(existing), "cached": True}
        dest = self._component_dir("node")
        dest.mkdir(parents=True, exist_ok=True)
        zip_path = dest / "node.zip"
        await self._download(NODE_URL, zip_path, progress_cb)
        self._extract_zip(zip_path, dest)
        zip_path.unlink(missing_ok=True)
        exe = self._cached_node_exe()
        if not exe:
            return {"ok": False, "error": "node executable not found after extraction"}
        logger.info("Node.js provisioned at {}", exe)
        return {"ok": True, "path": str(exe)}

    async def _ensure_ffmpeg(
        self, progress_cb: "Callable[[int, int], None] | None"
    ) -> dict:
        existing = self._cached_ffmpeg_exe()
        if existing:
            return {"ok": True, "path": str(existing), "cached": True}
        dest = self._component_dir("ffmpeg")
        dest.mkdir(parents=True, exist_ok=True)
        zip_path = dest / "ffmpeg.zip"
        await self._download(FFMPEG_URL, zip_path, progress_cb)
        self._extract_zip(zip_path, dest)
        zip_path.unlink(missing_ok=True)
        exe = self._cached_ffmpeg_exe()
        if not exe:
            return {"ok": False, "error": "ffmpeg executable not found after extraction"}
        logger.info("FFmpeg provisioned at {}", exe)
        return {"ok": True, "path": str(exe)}

    async def _ensure_chrome(
        self, progress_cb: "Callable[[int, int], None] | None"
    ) -> dict:
        existing = self._cached_chrome_exe()
        if existing:
            return {"ok": True, "path": str(existing), "cached": True}
        node_path = self.get_node_path()
        if not node_path:
            return {"ok": False, "error": "Node.js required to provision Chrome"}
        npx_js = self.get_npx_path()
        if not npx_js:
            return {"ok": False, "error": "npx-cli.js not found alongside Node"}
        dest = self._component_dir("chrome")
        dest.mkdir(parents=True, exist_ok=True)
        if progress_cb:
            progress_cb(0, 0)
        env = self.build_env()
        proc = await asyncio.create_subprocess_exec(
            node_path,
            npx_js,
            "hyperframes",
            "browser",
            "ensure",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=str(dest),
        )
        stdout, stderr = await proc.communicate()
        if proc.returncode != 0:
            return {
                "ok": False,
                "error": (stderr or b"").decode("utf-8", "replace"),
                "stdout": (stdout or b"").decode("utf-8", "replace"),
            }
        if progress_cb:
            progress_cb(1, 1)
        exe = self._cached_chrome_exe()
        logger.info("Chrome provisioned at {}", exe)
        return {"ok": True, "path": str(exe) if exe else None}

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
        logger.info("Downloaded {} -> {}", url, dest)

    @staticmethod
    def _extract_zip(zip_path: Path, dest: Path) -> None:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(dest)
