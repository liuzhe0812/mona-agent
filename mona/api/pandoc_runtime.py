"""Pandoc runtime detection and on-demand download.

Pandoc (GPL-licensed) is never bundled with Mona. The standalone binary
is downloaded from the official GitHub release to the per-user resources
directory on first use — after explicit user confirmation in the UI —
and invoked as a separate subprocess (mere aggregation, no GPL linkage).

Windows is the primary target; other platforms rely on a system install.
"""

from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING

from loguru import logger

from mona.api.video_runtime import RESOURCE_ROOT, ComponentStatus, VideoRuntime, _run_sync

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = ("PANDOC_DOWNLOAD_MB", "PandocRuntime")

PANDOC_VERSION = "3.6.4"
PANDOC_ZIP_URL = (
    "https://github.com/jgm/pandoc/releases/download/"
    f"{PANDOC_VERSION}/pandoc-{PANDOC_VERSION}-windows-x86_64.zip"
)
# Approximate zip size, surfaced in the first-download confirmation dialog.
PANDOC_DOWNLOAD_MB = 36


class PandocRuntime:
    """Detect and provision the Pandoc executable."""

    def __init__(self, runtime_root: Path | None = None) -> None:
        self.root = runtime_root or RESOURCE_ROOT

    def _cached_pandoc_exe(self) -> Path | None:
        pandoc_dir = self.root / "pandoc"
        if not pandoc_dir.exists():
            return None
        for name in ("pandoc.exe", "pandoc"):
            for exe in pandoc_dir.rglob(name):
                if exe.is_file():
                    return exe
        return None

    def get_pandoc_path(self) -> str | None:
        """Return the pandoc executable path (cache first, then system)."""
        cached = self._cached_pandoc_exe()
        if cached:
            return str(cached)
        return shutil.which("pandoc")

    @staticmethod
    def wrap_cmd(cmd: list[str]) -> list[str]:
        """Wrap .cmd/.bat shims for Windows CreateProcess (cannot exec them directly)."""
        if sys.platform == "win32" and cmd[0].lower().endswith((".cmd", ".bat")):
            return ["cmd", "/c", *cmd]
        return cmd

    def check(self) -> dict:
        """Return ComponentStatus dict for the resolved pandoc binary."""
        path = self.get_pandoc_path()
        if not path:
            return ComponentStatus(ok=False, error="pandoc not found").model_dump()
        code, out, err = _run_sync(self.wrap_cmd([path, "--version"]))
        if code != 0:
            return ComponentStatus(
                ok=False, path=path, error=err or "pandoc --version failed"
            ).model_dump()
        first_line = out.splitlines()[0] if out else ""
        version = first_line.removeprefix("pandoc").strip()
        return ComponentStatus(ok=True, version=version, path=path).model_dump()

    async def ensure(
        self, progress_cb: "Callable[[int, int], None] | None" = None
    ) -> dict:
        """Download and extract pandoc into Mona's resources directory."""
        existing = self.get_pandoc_path()
        if existing:
            return {"ok": True, "path": existing, "cached": True}
        if sys.platform != "win32":
            return {
                "ok": False,
                "error": "当前平台暂不支持自动下载 Pandoc，请手动安装后重试",
            }
        dest = self.root / "pandoc"
        dest.mkdir(parents=True, exist_ok=True)
        zip_path = dest / "pandoc.zip"
        try:
            # 复用 VideoRuntime 的下载实现（SSRF 校验 + 分块写入 + 进度回调）
            await VideoRuntime(self.root)._download(PANDOC_ZIP_URL, zip_path, progress_cb)
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(dest)
        finally:
            zip_path.unlink(missing_ok=True)
        exe = self._cached_pandoc_exe()
        if not exe:
            return {"ok": False, "error": "pandoc executable not found after extraction"}
        logger.info("Pandoc provisioned at {}", exe)
        return {"ok": True, "path": str(exe)}
