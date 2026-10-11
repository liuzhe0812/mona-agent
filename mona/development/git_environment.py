"""Discover an existing Git installation; never install tools or change the user's PATH."""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from mona.development.store import DevelopmentError

_ENV_KEYS = ("PATH", "ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")
_CACHE_SECONDS = 30
_PROBE_SECONDS = 3
_DISCOVERY_SECONDS = 12
_cache: tuple[tuple[str, ...], float, str | None] | None = None
_lock = threading.Lock()


def git_command_env() -> dict[str, str]:
    # Read and write commands must agree on the repository, not inherit another tool's index.
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", GCM_INTERACTIVE="never",
               LC_ALL="C", LANG="C", LANGUAGE="C")
    return env


def git_candidates() -> list[str]:
    windows = sys.platform == "win32"
    name = "git.exe" if windows else "git"
    directories = [Path(entry.strip('"')) for entry in os.environ.get("PATH", "").split(os.pathsep)
                   if entry.strip('"')]
    if windows:
        roots = [os.environ.get("ProgramW6432"), os.environ.get("ProgramFiles", r"C:\Program Files"),
                 os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")]
        directories.extend(Path(root) / "Git" / subdir for root in roots if root for subdir in ("cmd", "bin"))
        local = os.environ.get("LOCALAPPDATA")
        if local:
            directories.extend(Path(local) / "Programs" / "Git" / subdir for subdir in ("cmd", "bin"))
    result, seen = [], set()
    for directory in directories:
        # Never implicitly run a repository-local git.exe through cwd or relative PATH entries.
        if not directory.is_absolute():
            continue
        candidate = directory / name
        key = os.path.normcase(str(candidate))
        if key not in seen and candidate.is_file() and os.access(candidate, os.X_OK):
            seen.add(key)
            result.append(str(candidate))
    return result


@contextmanager
def _probe_error_mode():
    if sys.platform != "win32":
        yield
        return
    # Invalid executables can otherwise open an OS dialog inside CreateProcess,
    # before subprocess's timeout starts. Change only this discovery thread.
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetThreadErrorMode.argtypes = []
    kernel.GetThreadErrorMode.restype = wintypes.DWORD
    kernel.SetThreadErrorMode.argtypes = [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    kernel.SetThreadErrorMode.restype = wintypes.BOOL
    previous = kernel.GetThreadErrorMode()
    if not kernel.SetThreadErrorMode(previous | 0x0001 | 0x0002 | 0x8000, None):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        yield
    finally:
        if not kernel.SetThreadErrorMode(previous, None):
            raise ctypes.WinError(ctypes.get_last_error())


def _discover(refresh: bool) -> str | None:
    global _cache
    key = (sys.platform, *(os.environ.get(name, "") for name in _ENV_KEYS))
    with _lock:
        if not refresh and _cache and _cache[0] == key and time.monotonic() < _cache[1]:
            binary = _cache[2]
            if binary is None or (Path(binary).is_file() and os.access(binary, os.X_OK)):
                return binary
        selected = None
        deadline = time.monotonic() + _DISCOVERY_SECONDS
        for candidate in git_candidates():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                with _probe_error_mode():
                    result = subprocess.run([candidate, "--version"], cwd=Path(__file__).parent,
                        env=git_command_env(), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, timeout=min(_PROBE_SECONDS, remaining),
                        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
            except (OSError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0:
                selected = candidate
                break
        _cache = (key, time.monotonic() + _CACHE_SECONDS, selected)
        return selected


async def require_git(*, refresh: bool = False) -> str:
    executable = await asyncio.to_thread(_discover, refresh)
    if executable is None:
        raise DevelopmentError("git_unavailable", "未检测到可运行的 Git；文件编辑与开发会话仍可使用。")
    return executable
