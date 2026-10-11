"""Read-only native executable discovery, never an implicit install or login.

A path existing is not a verified protocol, authentication or isolation check.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import sys
from pathlib import Path

from mona.config.schema import DevelopmentConfig
from mona.development.contracts import ExecutorId
from mona.development.executors.base import ExecutorProbe
from mona.runtime.executors import managed_executor_path
from mona.runtime.manager import RuntimeManagerError


def _codex_package_binary(entry: Path) -> Path | None:
    """Resolve OpenAI's platform package, never execute npm's shell wrapper."""
    if entry.name.lower() not in {"codex", "codex.cmd", "codex.ps1", "codex.js"}:
        return None
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64" if machine in {"amd64", "x86_64"} else None
    triples = {("win32", "x64"): "x86_64-pc-windows-msvc", ("win32", "arm64"): "aarch64-pc-windows-msvc",
               ("darwin", "x64"): "x86_64-apple-darwin", ("darwin", "arm64"): "aarch64-apple-darwin",
               ("linux", "x64"): "x86_64-unknown-linux-musl", ("linux", "arm64"): "aarch64-unknown-linux-musl"}
    triple = triples.get((sys.platform, arch))
    if not triple:
        return None
    roots = [entry.parent / "node_modules" / "@openai" / "codex", entry.parent.parent]
    for root in roots:
        try:
            with (root / "package.json").open(encoding="utf8") as file:
                metadata = json.loads(file.read(65537))
            if metadata.get("name") != "@openai/codex":
                continue
            for vendor in (root / "vendor", root.parent / f"codex-{sys.platform}-{arch}" / "vendor",
                           root / "node_modules" / "@openai" / f"codex-{sys.platform}-{arch}" / "vendor"):
                candidate = vendor / triple / "codex" / ("codex.exe" if os.name == "nt" else "codex")
                if (candidate.is_file() and candidate.resolve().is_relative_to(vendor.resolve())
                        and (os.name == "nt" or os.access(candidate, os.X_OK))):
                    return candidate.resolve()
        except (OSError, ValueError, AttributeError):
            continue
    return None


def resolve_executable(executor: ExecutorId, path: Path) -> tuple[Path, bool]:
    """An explicit path never falls back to another installation."""
    candidate = path.expanduser()
    if not candidate.is_absolute() or not candidate.is_file():
        raise ValueError("invalid_executable")
    candidate = candidate.resolve(strict=True)
    script = candidate.suffix.lower() in {".cmd", ".bat", ".ps1", ".js", ".mjs", ".cjs"}
    if executor == ExecutorId.CODEX and (script or candidate.name == "codex"):
        native = _codex_package_binary(candidate)
        if native:
            return native, True
    if script:
        raise ValueError("unsupported_launcher")
    if os.name != "nt" and not os.access(candidate, os.X_OK):
        raise PermissionError("executable_access_denied")
    return candidate, False


def _standard_candidates(executor: ExecutorId, home: Path) -> list[Path]:
    name = executor.value + (".exe" if os.name == "nt" else "")
    candidates = [home / ".local" / "bin" / name]
    if os.name == "nt":
        local = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
        if executor == ExecutorId.CODEBUDDY:
            candidates.append(local / "codebuddy" / "bin" / name)
        if executor == ExecutorId.CODEX:
            roaming = Path(os.environ.get("APPDATA", str(home / "AppData" / "Roaming")))
            candidates.append(roaming / "npm" / "codex.cmd")
    else:
        candidates.extend(Path(directory) / name for directory in ("/opt/homebrew/bin", "/usr/local/bin"))
    return candidates


def _codex_desktop_candidates(home: Path) -> list[Path]:
    if sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
        root = local / "OpenAI" / "Codex" / "bin"
        try:
            candidates = [p for p in root.glob("*/codex.exe") if p.is_file()
                          and p.resolve().is_relative_to(root.resolve())]
            return sorted(candidates, key=lambda p: p.stat().st_mtime_ns, reverse=True)
        except OSError:
            return []
    if sys.platform == "darwin":
        return [root / "Codex.app" / "Contents" / "Resources" / "codex"
                for root in (home / "Applications", Path("/Applications"))]
    return []


def discover_executors(config: DevelopmentConfig, *, search_path: str | None = None,
                       include_managed: bool = True) -> list[ExecutorProbe]:
    result: list[ExecutorProbe] = []
    for executor, configured in (
        (ExecutorId.CODEX, config.codex_path),
        (ExecutorId.CLAUDE, config.claude_path),
        (ExecutorId.CODEBUDDY, config.codebuddy_path),
    ):
        source = "configured" if configured is not None else "path"
        located = configured
        if configured is None and search_path is None and executor == ExecutorId.CODEX:
            located = next((str(p) for p in _codex_desktop_candidates(Path.home()) if p.is_file()), None)
            if located:
                source = "desktop_application"
        if configured is None and located is None:
            located = shutil.which(executor.value, path=search_path) if search_path != "" else None
            if not located and search_path is None:
                # Desktop launches often omit a newly installed CLI's PATH. Only
                # inspect documented install locations, never shell profiles.
                located = next((str(p) for p in _standard_candidates(executor, Path.home()) if p.is_file()), None)
                source = "standard_location"
        if include_managed and configured is None and not located and search_path is None:
            try:
                managed = managed_executor_path(executor.value)
                if managed:
                    located, source = str(managed), "managed_runtime"
            except RuntimeManagerError:
                result.append(ExecutorProbe(executor=executor, state="unavailable", source="managed_runtime",
                    error_code="managed_runtime_invalid", reason="Mona 管理的模型引擎程序需要修复。",
                    next_action="在对应模型来源的引擎管理中修复程序。"))
                continue
        if not located:
            result.append(ExecutorProbe(executor=executor, state="not_detected", error_code="executable_not_found",
                reason="尚未找到此执行者的本地程序。", next_action="选择已安装的原生程序路径，或先按官方说明安装。"))
            continue
        try:
            native, projected = resolve_executable(executor, Path(located))
        except (OSError, ValueError) as exc:
            code = "unsupported_launcher" if isinstance(exc, ValueError) and str(exc) == "unsupported_launcher" else (
                "executable_access_denied" if isinstance(exc, PermissionError) else "invalid_executable")
            result.append(ExecutorProbe(executor=executor, state="invalid_path", executable=str(located), source=source,
                error_code=code, reason="所选入口不能作为原生程序启动；没有改用其他安装。",
                next_action="选择该执行者的原生可执行文件；不会执行任意终端包装脚本。" if code == "unsupported_launcher" else "核对程序路径与访问权限，然后重新检查。"))
            continue
        result.append(ExecutorProbe(executor=executor, state="detected", executable=str(native),
            source="npm_platform_package" if projected else source,
            reason="已定位本地程序，尚未验证启动、协议或认证。", next_action="点击检查连接。"))
    return result
