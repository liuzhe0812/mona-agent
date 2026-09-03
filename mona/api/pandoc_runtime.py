"""Pandoc runtime detection and managed provisioning.

Pandoc (GPL-licensed) is never bundled with Mona. The standalone binary
is installed through Mona's unified runtime store and invoked as a separate
subprocess (mere aggregation, no GPL linkage). Existing legacy installs remain
readable during migration.

Windows is the primary target; other platforms rely on a system install.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from mona.api.video_runtime import RESOURCE_ROOT, ComponentStatus, _run_sync

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = ("PANDOC_DOWNLOAD_MB", "PandocRuntime")

PANDOC_VERSION = "3.10.1"
# Approximate zip size, surfaced in the first-download confirmation dialog.
PANDOC_DOWNLOAD_MB = 40


class PandocRuntime:
    """Detect and provision the Pandoc executable."""

    def __init__(self, runtime_root: Path | None = None) -> None:
        self.root = runtime_root or RESOURCE_ROOT

    def _cached_pandoc_exe(self) -> Path | None:
        pandoc_dir = self.root / "pandoc" / f"pandoc-{PANDOC_VERSION}"
        if not pandoc_dir.exists():
            return None
        for name in ("pandoc.exe", "pandoc"):
            for exe in pandoc_dir.rglob(name):
                if exe.is_file():
                    return exe
        return None

    def get_pandoc_path(self) -> str | None:
        """Return managed Pandoc, then a compatible legacy or system binary."""
        try:
            from mona.config.paths import get_managed_runtimes_dir
            from mona.runtime.manager import RuntimeComponentStore

            active = RuntimeComponentStore(get_managed_runtimes_dir()).active("pandoc")
        except Exception:
            active = None
        if active is not None:
            relative = active[0].entrypoints.get("pandoc")
            managed = active[1] / Path(relative or "")
            if relative and managed.is_file():
                return str(managed)
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
                "error": "当前平台暂不支持自动下载文档解析组件，请手动安装后重试",
            }
        try:
            from mona.runtime.official import ensure_official_runtime_resource

            await ensure_official_runtime_resource(
                "pandoc",
                (
                    (lambda _ref, current, total: progress_cb(current, total))
                    if progress_cb
                    else None
                ),
            )
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        managed = self.get_pandoc_path()
        if managed:
            return {"ok": True, "path": managed}
        return {"ok": False, "error": "文档转换组件安装后不可用，请在高级功能中修复"}
