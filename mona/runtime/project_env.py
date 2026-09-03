"""Project-scoped Python and Node routing on Mona-managed runtimes."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from filelock import FileLock, Timeout

from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.skill_env import DEFAULT_NODE_BASE_REF, DEFAULT_PYTHON_BASE_REF

_PYTHON_COMMANDS = {
    "alembic",
    "black",
    "django-admin",
    "ipython",
    "isort",
    "jupyter",
    "mypy",
    "pip",
    "pip3",
    "py",
    "pytest",
    "ruff",
}
_NODE_COMMANDS = {
    "corepack",
    "eslint",
    "jest",
    "next",
    "node",
    "npm",
    "npx",
    "nuxt",
    "pnpm",
    "prettier",
    "tsc",
    "vite",
    "vitest",
    "webpack",
    "yarn",
    "yarnpkg",
}
_RUNTIME_COMMAND_RE = re.compile(
    r"(?:^|[;&|]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*"
    r"(?P<command>python(?:3(?:\.\d+)?)?|"
    + "|".join(sorted(_PYTHON_COMMANDS | _NODE_COMMANDS, key=len, reverse=True))
    + r")(?=\s|$)",
    re.IGNORECASE,
)
_PROJECT_MARKERS = (
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "package.json",
    ".git",
)


async def _acquire_file_lock(lock: FileLock, timeout_seconds: float) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        try:
            lock.acquire(timeout=0)
            return
        except Timeout:
            if asyncio.get_running_loop().time() >= deadline:
                raise
            await asyncio.sleep(0.05)


class ProjectRuntimeError(RuntimeError):
    """Raised when an explicit project runtime command cannot be prepared."""


@dataclass(frozen=True, slots=True)
class ProjectRuntimeResolution:
    env: dict[str, str]
    project_root: Path
    python: Path | None = None
    node: Path | None = None


class ProjectEnvironmentManager:
    """Route project commands without sharing Skill dependency environments."""

    def __init__(
        self,
        runtime_root: Path,
        *,
        runtime_installer: Any | None = None,
        runner: Callable[..., Awaitable[tuple[int, str, str]]] | None = None,
    ) -> None:
        self.runtime_root = runtime_root.resolve()
        self.store = RuntimeComponentStore(self.runtime_root)
        self.runtime_installer = runtime_installer
        self.runner = runner or self._run

    @staticmethod
    def requested_runtimes(command: str) -> set[str]:
        result: set[str] = set()
        for match in _RUNTIME_COMMAND_RE.finditer(command):
            name = match.group("command").lower()
            result.add("node" if name in _NODE_COMMANDS else "python")
        return result

    async def prepare(
        self,
        command: str,
        *,
        cwd: Path,
        workspace_root: Path,
        base_env: dict[str, str],
    ) -> ProjectRuntimeResolution:
        requested = self.requested_runtimes(command)
        root = self._project_root(cwd.resolve(), workspace_root.resolve())
        if not requested:
            return ProjectRuntimeResolution(env=base_env, project_root=root)

        env = dict(base_env)
        prepend: list[str] = []
        python: Path | None = None
        node: Path | None = None
        if "python" in requested:
            python = await self._project_python(root)
            prepend.extend([str(self._python_shims(root, python)), str(python.parent)])
            env.update(
                {
                    "VIRTUAL_ENV": str(python.parent.parent),
                    "PYTHONNOUSERSITE": "1",
                    "PYTHONUTF8": "1",
                    "MONA_PROJECT_PYTHON": str(python),
                }
            )
        if "node" in requested:
            await self._ensure_packs([DEFAULT_NODE_BASE_REF])
            node = self._entrypoint("node-base", "node")
            self._validate_node_version(root, node)
            prepend.extend([str(root / "node_modules" / ".bin"), str(node.parent)])
            env["MONA_PROJECT_NODE"] = str(node)
        env["PATH"] = os.pathsep.join([*prepend, env.get("PATH", "")])
        env["MONA_PROJECT_ROOT"] = str(root)
        env["MONA_MANAGED_RUNTIME_ROOT"] = str(self.runtime_root)
        return ProjectRuntimeResolution(
            env=env,
            project_root=root,
            python=python,
            node=node,
        )

    @staticmethod
    def _project_root(cwd: Path, workspace_root: Path) -> Path:
        if cwd != workspace_root and workspace_root not in cwd.parents:
            raise ProjectRuntimeError("project command is outside the active workspace")
        current = cwd
        while True:
            if any((current / marker).exists() for marker in _PROJECT_MARKERS):
                return current
            if current == workspace_root:
                return workspace_root
            current = current.parent

    async def _project_python(self, project_root: Path) -> Path:
        candidates = [project_root / ".venv", project_root / "venv"]
        for environment in candidates:
            python = environment / (
                "Scripts/python.exe" if sys.platform == "win32" else "bin/python"
            )
            if python.is_file():
                return python

        await self._ensure_packs([DEFAULT_PYTHON_BASE_REF])
        destination = project_root / ".venv"
        python_relative = Path("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        lock_root = self.runtime_root / "project-locks"
        lock_root.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(str(project_root).encode()).hexdigest()[:24]
        lock = FileLock(str(lock_root / f"{key}.lock"), timeout=600)
        await _acquire_file_lock(lock, 600)
        try:
            python = destination / python_relative
            if python.is_file():
                return python
            staging = Path(tempfile.mkdtemp(prefix=".mona-venv-", dir=project_root))
            try:
                base_python = self._entrypoint("python-base", "python")
                code, stdout, stderr = await self.runner(
                    [str(base_python), "-m", "venv", str(staging)],
                    cwd=project_root,
                )
                if code != 0:
                    raise ProjectRuntimeError(
                        "failed to create project Python environment: "
                        + ((stderr or stdout).strip()[-2_000:] or str(code))
                    )
                if not (staging / python_relative).is_file():
                    raise ProjectRuntimeError("project Python environment is incomplete")
                os.replace(staging, destination)
            except Exception:
                shutil.rmtree(staging, ignore_errors=True)
                raise
        finally:
            lock.release()
        return destination / python_relative

    def _python_shims(self, project_root: Path, python: Path) -> Path:
        key = hashlib.sha256(f"{project_root}\0{python}".encode()).hexdigest()[:24]
        root = self.runtime_root / "project-shims" / key
        root.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            commands = {
                "py.cmd": f'@echo off\r\n"{python}" %*\r\n',
                "python3.cmd": f'@echo off\r\n"{python}" %*\r\n',
                "pip3.cmd": f'@echo off\r\n"{python}" -m pip %*\r\n',
            }
        else:
            commands = {
                "py": f'#!/bin/sh\nexec "{python}" "$@"\n',
                "python3": f'#!/bin/sh\nexec "{python}" "$@"\n',
                "pip3": f'#!/bin/sh\nexec "{python}" -m pip "$@"\n',
            }
        for name, content in commands.items():
            path = root / name
            if not path.is_file() or path.read_text(encoding="utf-8") != content:
                path.write_text(content, encoding="utf-8", newline="")
                if sys.platform != "win32":
                    path.chmod(0o755)
        return root

    async def _ensure_packs(self, refs: list[str]) -> None:
        missing: list[str] = []
        for ref in refs:
            component_id, version = ref.split("@", 1)
            active = self.store.active(component_id)
            if active is None or active[0].version != version:
                missing.append(ref)
        if not missing:
            return
        installer = self.runtime_installer
        if installer is None:
            from mona.runtime.official import get_official_runtime_jobs

            component = "node" if missing[0].startswith("node-") else "python"
            await get_official_runtime_jobs().ensure_packs(component, missing)
            return
        await installer.ensure_packs(missing)

    def _entrypoint(self, component_id: str, name: str) -> Path:
        active = self.store.active(component_id)
        if active is None:
            raise ProjectRuntimeError(f"Mona runtime {component_id} is not installed")
        manifest, root = active
        relative = manifest.entrypoints.get(name)
        if not relative:
            raise ProjectRuntimeError(f"Mona runtime {component_id} has no {name}")
        executable = root / Path(relative)
        if not executable.is_file():
            raise ProjectRuntimeError(f"Mona runtime entrypoint is missing: {executable}")
        return executable

    @staticmethod
    def _validate_node_version(project_root: Path, node: Path) -> None:
        expected: str | None = None
        for name in (".nvmrc", ".node-version"):
            path = project_root / name
            if path.is_file():
                expected = path.read_text(encoding="utf-8").strip().lstrip("v")
                break
        package_json = project_root / "package.json"
        if expected is None and package_json.is_file():
            try:
                payload = json.loads(package_json.read_text(encoding="utf-8"))
                expected = str(payload.get("volta", {}).get("node") or "").strip() or None
            except (OSError, ValueError, AttributeError):
                expected = None
        if expected is None:
            return
        active_version = node.parents[1].name if node.parents[1].name != "node-base" else ""
        if active_version and not active_version.startswith(expected.split(".")[0] + "."):
            raise ProjectRuntimeError(
                f"project requires Node {expected}, but Mona currently provides {active_version}"
            )

    @staticmethod
    async def _run(command: list[str], *, cwd: Path) -> tuple[int, str, str]:
        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = 0x08000000
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **kwargs,
        )
        stdout, stderr = await process.communicate()
        return (
            process.returncode or 0,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )


__all__ = [
    "ProjectEnvironmentManager",
    "ProjectRuntimeError",
    "ProjectRuntimeResolution",
]
