"""Video runtime dependency detection and managed provisioning.

Detects Node.js 22+, FFmpeg, a system Edge/Chrome browser, and yt-dlp. Missing
components are requested from Mona's unified runtime manager. Existing legacy
installs remain readable during migration. Video rendering uses a system browser.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel

if TYPE_CHECKING:
    from collections.abc import Callable

__all__ = ("VideoRuntime",)

# User-managed component root. Do not use the installation directory: it may
# be read-only for normal Windows users and is replaced by application updates.
RESOURCE_ROOT = Path(
    os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local")
) / "Mona" / "resources"

FUNASR_MODEL_ASSET = "sensevoice-small-q8.gguf"
FUNASR_VAD_ASSET = "fsmn-vad.gguf"

NODE_MIN_MAJOR = 22


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
    """Detect and provision video-related executable dependencies."""

    def __init__(self, runtime_root: Path | None = None) -> None:
        self.root = runtime_root or RESOURCE_ROOT

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

    @staticmethod
    def _managed_entrypoint(component_id: str, name: str) -> Path | None:
        try:
            from mona.config.paths import get_managed_runtimes_dir
            from mona.runtime.manager import RuntimeComponentStore

            active = RuntimeComponentStore(get_managed_runtimes_dir()).active(component_id)
        except Exception:
            return None
        if active is None:
            return None
        manifest, root = active
        relative = manifest.entrypoints.get(name)
        if not relative:
            return None
        executable = root / Path(relative)
        return executable if executable.is_file() else None

    @classmethod
    def _managed_node_exe(cls) -> Path | None:
        return cls._managed_entrypoint("node-base", "node")

    def _cached_ffprobe_exe(self) -> Path | None:
        ff_dir = self._component_dir("ffmpeg")
        if not ff_dir.exists():
            return None
        for name in ("ffprobe.exe", "ffprobe"):
            for executable in ff_dir.rglob(name):
                if executable.is_file():
                    return executable
        return None

    def _cached_ytdlp_exe(self) -> Path | None:
        ytdlp_dir = self._component_dir("yt-dlp")
        if not ytdlp_dir.exists():
            return None
        for name in ("yt-dlp.exe", "yt-dlp"):
            for executable in ytdlp_dir.rglob(name):
                if executable.is_file():
                    return executable
        return None

    def _cached_asr_exe(self) -> Path | None:
        asr_dir = self._component_dir("asr")
        if not asr_dir.exists():
            return None
        for name in ("llama-funasr-sensevoice.exe", "llama-funasr-sensevoice"):
            for executable in asr_dir.rglob(name):
                if executable.is_file():
                    return executable
        return None

    def _cached_asr_model(self) -> Path | None:
        candidate = self._component_dir("asr") / FUNASR_MODEL_ASSET
        return candidate if candidate.is_file() else None

    def _cached_asr_vad(self) -> Path | None:
        candidate = self._component_dir("asr") / FUNASR_VAD_ASSET
        return candidate if candidate.is_file() else None

    @staticmethod
    def _system_chrome_candidates() -> list[Path]:
        if sys.platform == "win32":
            candidates = [
                Path(
                    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
                ),
                Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
                Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
                Path(
                    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
                ),
            ]
            local_app_data = os.environ.get("LOCALAPPDATA")
            if local_app_data:
                local = Path(local_app_data)
                candidates.extend(
                    [
                        local / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                        local / "Google" / "Chrome" / "Application" / "chrome.exe",
                    ]
                )
            return candidates
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
        managed = self._managed_node_exe()
        if managed:
            return str(managed)
        cached = self._cached_node_exe()
        return str(cached) if cached else None

    def get_ffmpeg_path(self) -> str | None:
        """Return the ffmpeg executable path (system install or cache)."""
        managed = self._managed_entrypoint("ffmpeg", "ffmpeg")
        if managed:
            return str(managed)
        system = shutil.which("ffmpeg")
        if system:
            return system
        cached = self._cached_ffmpeg_exe()
        return str(cached) if cached else None

    def get_ffprobe_path(self) -> str | None:
        """Return the ffprobe executable path (system install or cache)."""

        managed = self._managed_entrypoint("ffmpeg", "ffprobe")
        if managed:
            return str(managed)
        system = shutil.which("ffprobe")
        if system:
            return system
        cached = self._cached_ffprobe_exe()
        return str(cached) if cached else None

    def get_ytdlp_path(self) -> str | None:
        """Return the cached yt-dlp executable, or a system installation."""
        managed = self._managed_entrypoint("yt-dlp", "yt_dlp")
        if managed:
            return str(managed)
        cached = self._cached_ytdlp_exe()
        if cached:
            return str(cached)
        return shutil.which("yt-dlp")

    def get_asr_paths(self) -> dict[str, str] | None:
        """Return the cached local-ASR executable and weights when complete."""
        managed_executable = self._managed_entrypoint("asr-sensevoice", "transcribe")
        managed_model = self._managed_entrypoint("asr-sensevoice", "model")
        managed_vad = self._managed_entrypoint("asr-sensevoice", "vad")
        if managed_executable and managed_model and managed_vad:
            return {
                "path": str(managed_executable),
                "modelPath": str(managed_model),
                "vadPath": str(managed_vad),
            }
        executable = self._cached_asr_exe()
        model = self._cached_asr_model()
        vad = self._cached_asr_vad()
        if not executable or not model or not vad:
            return None
        return {
            "path": str(executable),
            "modelPath": str(model),
            "vadPath": str(vad),
        }

    def get_chrome_path(self) -> str | None:
        """Return a Chromium-based browser executable path."""
        for cand in self._system_chrome_candidates():
            if cand.exists() and cand.is_file():
                return str(cand)
        return None

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
        node_path = self.get_node_path()
        if node_path:
            paths.append(str(Path(node_path).parent))
        ff_exe = self._cached_ffmpeg_exe()
        if ff_exe:
            paths.append(str(ff_exe.parent))
        ytdlp_exe = self._cached_ytdlp_exe()
        if ytdlp_exe:
            paths.append(str(ytdlp_exe.parent))
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
        probe_path = self.get_ffprobe_path()
        if not probe_path:
            return ComponentStatus(
                ok=False, path=ff_path, error="FFprobe not found"
            )
        probe_code, _, _ = _run_sync([probe_path, "-version"])
        if probe_code != 0:
            return ComponentStatus(
                ok=False, path=ff_path, error="ffprobe -version failed"
            )
        first_line = out.splitlines()[0] if out else ""
        return ComponentStatus(ok=True, version=first_line, path=ff_path)

    def _check_ytdlp(self) -> ComponentStatus:
        ytdlp_path = self.get_ytdlp_path()
        if not ytdlp_path:
            return ComponentStatus(ok=False, error="yt-dlp not found")
        code, out, err = _run_sync([ytdlp_path, "--version"])
        if code != 0:
            return ComponentStatus(
                ok=False, path=ytdlp_path, error=err or "yt-dlp --version failed"
            )
        return ComponentStatus(ok=True, version=out.strip(), path=ytdlp_path)

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
        """Detect available video dependencies.

        Returns ``{node: {...}, ffmpeg: {...}, chrome: {...}, yt_dlp: {...}}``.
        """
        return {
            "node": self._check_node().model_dump(),
            "ffmpeg": self._check_ffmpeg().model_dump(),
            "chrome": self._check_chrome().model_dump(),
            "yt_dlp": self._check_ytdlp().model_dump(),
        }

    # ------------------------------------------------------------------
    # Download / provisioning
    # ------------------------------------------------------------------

    async def _ensure_managed_resource(
        self,
        resource: str,
        progress_cb: "Callable[[int, int], None] | None",
    ) -> None:
        from mona.runtime.official import ensure_official_runtime_resource

        await ensure_official_runtime_resource(
            resource,
            (
                (lambda _ref, current, total: progress_cb(current, total))
                if progress_cb
                else None
            ),
        )

    async def ensure_runtime(
        self,
        component: str,
        progress_cb: "Callable[[int, int], None] | None" = None,
    ) -> dict:
        """Download and extract a component into Mona's resources directory.

        Args:
            component: One of ``"node"``, ``"ffmpeg"``, ``"yt_dlp"``, ``"asr"``.
            progress_cb: Optional callback ``(downloaded_bytes, total_bytes)``.

        Returns a dict with ``ok`` and either ``path`` or ``error``.
        """
        if component == "node":
            return await self._ensure_node(progress_cb)
        if component == "ffmpeg":
            return await self._ensure_ffmpeg(progress_cb)
        if component == "yt_dlp":
            return await self._ensure_ytdlp(progress_cb)
        if component == "asr":
            return await self._ensure_asr(progress_cb)
        return {"ok": False, "error": f"Unknown component: {component}"}

    async def _ensure_node(
        self, progress_cb: "Callable[[int, int], None] | None"
    ) -> dict:
        existing = self.get_node_path()
        if existing:
            return {"ok": True, "path": str(existing), "cached": True}
        try:
            await self._ensure_managed_resource("node", progress_cb)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        managed = self._managed_node_exe()
        if managed:
            return {"ok": True, "path": str(managed)}
        return {"ok": False, "error": "Node.js 组件安装后不可用，请在高级功能中修复"}

    async def _ensure_ffmpeg(
        self, progress_cb: "Callable[[int, int], None] | None"
    ) -> dict:
        existing = self._cached_ffmpeg_exe()
        existing_probe = self._cached_ffprobe_exe()
        if existing and existing_probe:
            return {
                "ok": True,
                "path": str(existing),
                "ffprobePath": str(existing_probe),
                "cached": True,
            }
        try:
            await self._ensure_managed_resource("ffmpeg", progress_cb)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        managed = self.get_ffmpeg_path()
        managed_probe = self.get_ffprobe_path()
        if managed and managed_probe:
            return {"ok": True, "path": managed, "ffprobePath": managed_probe}
        return {"ok": False, "error": "视频处理组件安装后不可用，请在高级功能中修复"}

    async def _ensure_ytdlp(
        self, progress_cb: "Callable[[int, int], None] | None"
    ) -> dict:
        existing = self.get_ytdlp_path()
        if existing:
            return {"ok": True, "path": existing, "cached": True}
        try:
            await self._ensure_managed_resource("yt_dlp", progress_cb)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        managed = self.get_ytdlp_path()
        if managed:
            return {"ok": True, "path": managed}
        return {"ok": False, "error": "视频解析组件安装后不可用，请在高级功能中修复"}

    async def _ensure_asr(
        self, progress_cb: "Callable[[int, int], None] | None"
    ) -> dict:
        existing = self.get_asr_paths()
        if existing:
            return {"ok": True, **existing, "cached": True}
        if sys.platform != "win32":
            return {"ok": False, "error": "本地语音转写暂仅支持 Windows x64"}

        try:
            await self._ensure_managed_resource("asr", progress_cb)
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
        managed = self.get_asr_paths()
        if managed:
            return {"ok": True, **managed}
        return {"ok": False, "error": "本地语音转写组件安装后不完整，请在高级功能中修复"}
