"""Shared Python and Node work environment for non-project Agent tasks."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from filelock import FileLock, Timeout

from mona.runtime.manager import RuntimeComponentStore, parse_runtime_pack_ref
from mona.runtime.python_env import CommandResult, PythonEnvironmentBuilder
from mona.runtime.skill_env import (
    DEFAULT_NODE_BASE_REF,
    DEFAULT_NPM_REGISTRIES,
    DEFAULT_PYPI_INDEX_URLS,
    DEFAULT_PYTHON_BASE_REF,
    PLATFORM_PYTHON_PROFILES,
    PLATFORM_PYTHON_REQUIREMENTS,
    SkillRuntimeSpec,
)

_RUNTIME_BASENAME = r"(?:python(?:3(?:\.\d+)?)?|py|pip(?:3)?|node|npm|npx)(?:\.exe|\.cmd)?"
_EXPLICIT_RUNTIME_RES = (
    re.compile(
        rf'"(?P<path>(?:[A-Za-z]:[\\/]|/)[^"]*{_RUNTIME_BASENAME})"',
        re.IGNORECASE,
    ),
    re.compile(
        rf"'(?P<path>(?:[A-Za-z]:[\\/]|/)[^']*{_RUNTIME_BASENAME})'",
        re.IGNORECASE,
    ),
    re.compile(
        rf"(?P<path>(?:[A-Za-z]:[\\/]|/)[^\s;&|]*{_RUNTIME_BASENAME})(?=\s|$)",
        re.IGNORECASE,
    ),
)
_AGENT_PYTHON_COMMAND_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])(?:python(?:3(?:\.\d+)?)?|py|pip(?:3)?|pytest|ruff|jupyter|ipython)(?![A-Za-z0-9_.-])",
    re.IGNORECASE,
)
_AGENT_NODE_COMMAND_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])(?:node|npm|npx|pnpm|yarn|vite|vitest|eslint|prettier|tsc)(?![A-Za-z0-9_.-])",
    re.IGNORECASE,
)


class AgentRuntimeError(RuntimeError):
    """Raised when Mona cannot prepare the shared Agent environment."""


@dataclass(frozen=True, slots=True)
class AgentEnvironmentResolution:
    executable: Path
    env: dict[str, str]
    prefix_args: tuple[str, ...] = ()
    environment_id: str | None = None


async def _run_command(
    command: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
) -> tuple[int, str, str]:
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = 0x08000000
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(cwd),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **kwargs,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=900)
    except asyncio.TimeoutError:
        process.kill()
        stdout, stderr = await process.communicate()
        return (
            124,
            stdout.decode(errors="replace"),
            (stderr.decode(errors="replace") + "\nAgent environment command timed out"),
        )
    except asyncio.CancelledError:
        process.kill()
        await process.communicate()
        raise
    return (
        process.returncode or 0,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


CommandRunner = Callable[..., Awaitable[tuple[int, str, str]]]


async def _acquire(lock: FileLock, timeout_seconds: float = 600) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        try:
            lock.acquire(timeout=0)
            return
        except Timeout:
            if asyncio.get_running_loop().time() >= deadline:
                raise
            await asyncio.sleep(0.05)


class AgentEnvironmentManager:
    """Own the single shared Agent work environment outside user projects."""

    def __init__(
        self,
        root: Path,
        *,
        runtime_installer: Any | None = None,
        runner: CommandRunner = _run_command,
    ) -> None:
        self.root = root.resolve()
        self.store = RuntimeComponentStore(self.root)
        self.runtime_installer = runtime_installer
        self.runner = runner
        self.state_root = self.root / "agent-env"
        self.node_root = self.state_root / "node"
        self.shim_root = self.state_root / "bin"
        self.state_path = self.state_root / "state.json"

    def validate_command(self, command: str) -> None:
        for pattern in _EXPLICIT_RUNTIME_RES:
            for match in pattern.finditer(command):
                candidate = Path(match.group("path")).expanduser().resolve(strict=False)
                if candidate == self.root or self.root in candidate.parents:
                    continue
                raise AgentRuntimeError(
                    "Agent tasks cannot select a system Python or Node path; "
                    "use python, pip, node, npm, or npx so Mona can route the shared environment"
                )

    @staticmethod
    def requested_runtimes(command: str) -> set[str]:
        requested: set[str] = set()
        if _AGENT_PYTHON_COMMAND_RE.search(command):
            requested.add("python")
        if _AGENT_NODE_COMMAND_RE.search(command):
            requested.add("node")
        return requested

    async def prepare_command(
        self,
        command: str,
        *,
        base_env: dict[str, str],
    ) -> dict[str, str]:
        requested = self.requested_runtimes(command)
        env = dict(base_env)
        python_resolution: AgentEnvironmentResolution | None = None
        node_resolution: AgentEnvironmentResolution | None = None
        if "python" in requested:
            python_resolution = await self._prepare_python(None, None, env)
            env.update(python_resolution.env)
        if "node" in requested:
            node_resolution = await self._prepare_node(None, None, env)
            env.update(node_resolution.env)
        if requested:
            shims = self._write_shims(
                python_resolution.executable if python_resolution else None,
                node_resolution.executable if node_resolution else None,
            )
            env["PATH"] = os.pathsep.join([str(shims), env.get("PATH", "")])
            env["MONA_EXECUTION_SCOPE"] = "agent"
        return env

    async def prepare_for_skill(
        self,
        suffix: str,
        skill_dir: Path,
        spec: SkillRuntimeSpec | None,
    ) -> AgentEnvironmentResolution:
        normalized = suffix.lower()
        if normalized == ".py":
            return await self._prepare_python(spec, skill_dir.resolve(), os.environ.copy())
        if normalized == ".mjs":
            return await self._prepare_node(spec, skill_dir.resolve(), os.environ.copy())
        if normalized == ".r":
            raise AgentRuntimeError("Mona managed R is not available")
        raise AgentRuntimeError(f"unsupported Skill script type {suffix!r}")

    async def prepare_all(
        self,
        skill_dir: Path,
        spec: SkillRuntimeSpec | None,
    ) -> None:
        scripts = skill_dir / "scripts"
        if not scripts.is_dir():
            return
        suffixes = {
            path.suffix.lower()
            for path in scripts.rglob("*")
            if path.is_file() and path.suffix.lower() in {".py", ".mjs", ".r"}
        }
        optional_suffixes = {
            f".{suffix}" for suffix in (spec.optional_script_types if spec else [])
        }
        suffixes.difference_update(optional_suffixes)
        for suffix in sorted(suffixes):
            await self.prepare_for_skill(suffix, skill_dir, spec)

    async def prepare_packs(self, refs: list[str]) -> None:
        if not refs:
            return
        await self._ensure_packs(refs)
        python_refs, node_refs = self._runtime_refs(refs)
        if python_refs:
            await self._prepare_python(SkillRuntimeSpec(packs=python_refs), None, os.environ.copy())
        if node_refs:
            await self._prepare_node(SkillRuntimeSpec(packs=node_refs), None, os.environ.copy())

    def assert_skill_ready(
        self,
        skill_dir: Path,
        spec: SkillRuntimeSpec | None,
    ) -> None:
        scripts = skill_dir / "scripts"
        if not scripts.is_dir():
            return
        suffixes = {
            path.suffix.lower()
            for path in scripts.rglob("*")
            if path.is_file() and path.suffix.lower() in {".py", ".mjs", ".r"}
        }
        optional_suffixes = {
            f".{suffix}" for suffix in (spec.optional_script_types if spec else [])
        }
        suffixes.difference_update(optional_suffixes)
        if ".r" in suffixes:
            raise AgentRuntimeError("Mona managed R is not available")
        state = self._read_state()
        if ".py" in suffixes:
            current = PythonEnvironmentBuilder(self.root, self.store).current()
            if current is None:
                raise AgentRuntimeError("Mona Agent Python environment is not prepared")
            python = self._python_path(current.generation)
            if not python.is_file():
                raise AgentRuntimeError("Mona Agent Python environment is not prepared")
            requirements = self._python_requirements(spec, skill_dir)
            if requirements and not self._state_has_group(
                state, current.generation, "python", requirements
            ):
                raise AgentRuntimeError(
                    "Skill dependencies are not prepared in the shared Agent environment"
                )
        if ".mjs" in suffixes:
            if not self._node_ready():
                raise AgentRuntimeError("Mona Agent Node environment is not prepared")
            packages = self._node_packages(spec, skill_dir)
            if packages and not self._state_has_group(state, "node", "node", packages):
                raise AgentRuntimeError(
                    "Skill dependencies are not prepared in the shared Agent environment"
                )

    async def _prepare_python(
        self,
        spec: SkillRuntimeSpec | None,
        skill_dir: Path | None,
        base_env: dict[str, str],
    ) -> AgentEnvironmentResolution:
        requested = self._python_pack_refs(spec)
        await self._ensure_packs(requested)
        builder = PythonEnvironmentBuilder(
            self.root,
            self.store,
            runner=self._python_builder_runner,
            current_platform=sys.platform,
        )
        current = await builder.ensure(requested)
        python = self._python_path(current.generation)
        requirements = self._python_requirements(spec, skill_dir)
        if requirements:
            await self._install_python_group(python, current.generation, requirements)
        env = dict(base_env)
        python_path: list[str] = []
        if skill_dir is not None and (skill_dir / "src").is_dir():
            python_path.append(str(skill_dir / "src"))
        if env.get("PYTHONPATH"):
            python_path.append(env["PYTHONPATH"])
        env.update(
            {
                "PATH": os.pathsep.join([str(python.parent), env.get("PATH", "")]),
                "VIRTUAL_ENV": str(python.parent.parent),
                "PYTHONNOUSERSITE": "1",
                "PYTHONUTF8": "1",
                "MONA_AGENT_PYTHON": str(python),
                "MONA_MANAGED_RUNTIME_ROOT": str(self.root),
            }
        )
        if python_path:
            env["PYTHONPATH"] = os.pathsep.join(python_path)
        return AgentEnvironmentResolution(
            executable=python,
            env=env,
            environment_id=f"agent-python:{current.generation}",
        )

    async def _prepare_node(
        self,
        spec: SkillRuntimeSpec | None,
        skill_dir: Path | None,
        base_env: dict[str, str],
    ) -> AgentEnvironmentResolution:
        refs = self._node_pack_refs(spec)
        await self._ensure_packs(refs)
        node = self._entrypoint("node-base", "node")
        await self._ensure_node_root()
        packages = self._node_packages(spec, skill_dir)
        if packages:
            await self._install_node_group(node, packages)
        env = dict(base_env)
        env.update(
            {
                "PATH": os.pathsep.join(
                    [
                        str(self.node_root / "node_modules" / ".bin"),
                        str(node.parent),
                        env.get("PATH", ""),
                    ]
                ),
                "NODE_PATH": str(self.node_root / "node_modules"),
                "MONA_NODE_PROFILE": str(self.node_root),
                "MONA_AGENT_NODE": str(node),
                "MONA_MANAGED_RUNTIME_ROOT": str(self.root),
            }
        )
        return AgentEnvironmentResolution(
            executable=node,
            prefix_args=(
                "--no-warnings",
                "--experimental-loader",
                (self.node_root / "loader.mjs").as_uri(),
            ),
            env=env,
            environment_id="agent-node",
        )

    async def _python_builder_runner(
        self,
        command: list[str],
        cwd: Path,
        env: dict[str, str],
    ) -> CommandResult:
        code, stdout, stderr = await self.runner(command, cwd=cwd, env=env)
        return CommandResult(code, stdout=stdout, stderr=stderr)

    def _python_pack_refs(self, spec: SkillRuntimeSpec | None) -> list[str]:
        refs = [DEFAULT_PYTHON_BASE_REF]
        current = PythonEnvironmentBuilder(self.root, self.store).current()
        if current is not None:
            refs.extend(current.packs)
        if spec is not None:
            for ref in spec.packs:
                component_id, _version = parse_runtime_pack_ref(ref)
                active = self.store.active(component_id)
                manifest = active[0] if active else None
                if component_id.startswith("python-") or (
                    manifest is not None
                    and (
                        "python" in manifest.entrypoints or manifest.python_requirements is not None
                    )
                ):
                    refs.append(ref)
        return self._dedupe_pack_versions(refs)

    def _node_pack_refs(self, spec: SkillRuntimeSpec | None) -> list[str]:
        refs = [DEFAULT_NODE_BASE_REF]
        if spec is not None:
            refs.extend(ref for ref in spec.packs if ref.startswith("node-"))
        return self._dedupe_pack_versions(refs)

    def _runtime_refs(self, refs: list[str]) -> tuple[list[str], list[str]]:
        python_refs: list[str] = []
        node_refs: list[str] = []
        for ref in refs:
            component_id, version = parse_runtime_pack_ref(ref)
            active = self.store.active(component_id)
            if active is None or active[0].version != version:
                continue
            manifest = active[0]
            if "python" in manifest.entrypoints or manifest.python_requirements is not None:
                python_refs.append(ref)
            if "node" in manifest.entrypoints:
                node_refs.append(ref)
        return python_refs, node_refs

    @staticmethod
    def _dedupe_pack_versions(refs: list[str]) -> list[str]:
        by_component: dict[str, str] = {}
        order: list[str] = []
        for ref in refs:
            component_id, _version = parse_runtime_pack_ref(ref)
            if component_id not in by_component:
                order.append(component_id)
            by_component[component_id] = ref
        return [by_component[component_id] for component_id in order]

    @staticmethod
    def _python_requirements(
        spec: SkillRuntimeSpec | None,
        skill_dir: Path | None,
    ) -> list[str]:
        requirements: list[str] = []
        if spec is not None and spec.python is not None:
            if spec.python.profile == "platform":
                requirements.extend(PLATFORM_PYTHON_REQUIREMENTS)
            elif spec.python.profile is not None:
                requirements.extend(PLATFORM_PYTHON_PROFILES[spec.python.profile])
            else:
                requirements.extend(spec.python.requirements)
        if skill_dir is not None:
            requirements.extend(_pyproject_dependencies(skill_dir / "pyproject.toml"))
        return list(dict.fromkeys(requirements))

    @staticmethod
    def _node_packages(
        spec: SkillRuntimeSpec | None,
        skill_dir: Path | None,
    ) -> list[str]:
        packages: list[str] = []
        if spec is not None and spec.node is not None:
            packages.extend(spec.node.packages)
        if skill_dir is not None:
            packages.extend(_package_json_dependencies(skill_dir / "package.json"))
        return list(dict.fromkeys(packages))

    async def _install_python_group(
        self,
        python: Path,
        generation: str,
        requirements: list[str],
    ) -> None:
        lock = FileLock(str(self.state_root / "install.lock"), timeout=600)
        self.state_root.mkdir(parents=True, exist_ok=True)
        await _acquire(lock)
        try:
            state = self._read_state()
            if self._state_has_group(state, generation, "python", requirements):
                return
            env = os.environ.copy()
            env.update(
                {
                    "PIP_NO_INPUT": "1",
                    "PIP_DISABLE_PIP_VERSION_CHECK": "1",
                    "PYTHONNOUSERSITE": "1",
                }
            )
            configured = os.environ.get("MONA_PYPI_INDEX_URL", "").strip()
            indexes = list(
                dict.fromkeys([*([configured] if configured else []), *DEFAULT_PYPI_INDEX_URLS])
            )
            await self._checked_fallback(
                [
                    [
                        str(python),
                        "-m",
                        "pip",
                        "install",
                        "--timeout",
                        "20",
                        "--retries",
                        "1",
                        "--index-url",
                        index,
                        *requirements,
                    ]
                    for index in indexes
                ],
                python.parent.parent,
                env,
                "install shared Agent Python dependencies",
            )
            await self._checked(
                [str(python), "-m", "pip", "check"],
                python.parent.parent,
                env,
                "verify shared Agent Python environment",
            )
            self._record_group(state, generation, "python", requirements)
        finally:
            lock.release()

    async def _ensure_node_root(self) -> None:
        self.node_root.mkdir(parents=True, exist_ok=True)
        package_json = self.node_root / "package.json"
        if not package_json.is_file():
            self._write_json(
                package_json,
                {"name": "mona-agent-environment", "private": True, "type": "module"},
            )
        loader = self.node_root / "loader.mjs"
        if not loader.is_file():
            loader.write_text(
                """import { pathToFileURL } from 'node:url';
const profileParent = pathToFileURL(`${process.env.MONA_NODE_PROFILE}/entry.mjs`).href;
export async function resolve(specifier, context, nextResolve) {
  const local = specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:') || specifier.startsWith('file:');
  return nextResolve(specifier, local ? context : { ...context, parentURL: profileParent });
}
""",
                encoding="utf-8",
                newline="\n",
            )

    async def _install_node_group(self, node: Path, packages: list[str]) -> None:
        lock = FileLock(str(self.state_root / "install.lock"), timeout=600)
        await _acquire(lock)
        try:
            state = self._read_state()
            if self._state_has_group(state, "node", "node", packages):
                return
            npm_cli = node.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
            if not npm_cli.is_file():
                raise AgentRuntimeError("managed Node runtime has no npm CLI")
            configured = os.environ.get("MONA_NPM_REGISTRY", "").strip()
            registries = list(
                dict.fromkeys([*([configured] if configured else []), *DEFAULT_NPM_REGISTRIES])
            )
            env = os.environ.copy()
            env["NPM_CONFIG_IGNORE_SCRIPTS"] = "true"
            await self._checked_fallback(
                [
                    [
                        str(node),
                        str(npm_cli),
                        "install",
                        "--prefix",
                        str(self.node_root),
                        "--ignore-scripts",
                        "--omit=dev",
                        "--no-audit",
                        "--no-fund",
                        "--fetch-timeout=20000",
                        "--fetch-retries=1",
                        "--registry",
                        registry,
                        *packages,
                    ]
                    for registry in registries
                ],
                self.node_root,
                env,
                "install shared Agent Node dependencies",
            )
            self._record_group(state, "node", "node", packages)
        finally:
            lock.release()

    def _write_shims(self, python: Path | None, node: Path | None) -> Path:
        self.shim_root.mkdir(parents=True, exist_ok=True)
        commands: dict[str, str] = {}
        if sys.platform == "win32":
            if python is not None:
                commands.update(
                    {
                        "python.cmd": f'@echo off\r\n"{python}" %*\r\n',
                        "python3.cmd": f'@echo off\r\n"{python}" %*\r\n',
                        "py.cmd": f'@echo off\r\n"{python}" %*\r\n',
                        "pip.cmd": f'@echo off\r\n"{python}" -m pip %*\r\n',
                        "pip3.cmd": f'@echo off\r\n"{python}" -m pip %*\r\n',
                    }
                )
            if node is not None:
                npm_cli = node.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
                npx_cli = node.parent / "node_modules" / "npm" / "bin" / "npx-cli.js"
                loader = (self.node_root / "loader.mjs").as_uri()
                commands.update(
                    {
                        "node.cmd": f'@echo off\r\n"{node}" --no-warnings --experimental-loader "{loader}" %*\r\n',
                        "npm.cmd": f'@echo off\r\n"{node}" "{npm_cli}" --prefix "{self.node_root}" %*\r\n',
                        "npx.cmd": f'@echo off\r\n"{node}" "{npx_cli}" --prefix "{self.node_root}" %*\r\n',
                    }
                )
        else:
            if python is not None:
                commands.update(
                    {
                        "python": f'#!/bin/sh\nexec "{python}" "$@"\n',
                        "python3": f'#!/bin/sh\nexec "{python}" "$@"\n',
                        "py": f'#!/bin/sh\nexec "{python}" "$@"\n',
                        "pip": f'#!/bin/sh\nexec "{python}" -m pip "$@"\n',
                        "pip3": f'#!/bin/sh\nexec "{python}" -m pip "$@"\n',
                    }
                )
            if node is not None:
                npm_cli = node.parent / "node_modules" / "npm" / "bin" / "npm-cli.js"
                npx_cli = node.parent / "node_modules" / "npm" / "bin" / "npx-cli.js"
                loader = (self.node_root / "loader.mjs").as_uri()
                commands.update(
                    {
                        "node": f'#!/bin/sh\nexec "{node}" --no-warnings --experimental-loader "{loader}" "$@"\n',
                        "npm": f'#!/bin/sh\nexec "{node}" "{npm_cli}" --prefix "{self.node_root}" "$@"\n',
                        "npx": f'#!/bin/sh\nexec "{node}" "{npx_cli}" --prefix "{self.node_root}" "$@"\n',
                    }
                )
        for name, content in commands.items():
            path = self.shim_root / name
            if not path.is_file() or path.read_text(encoding="utf-8") != content:
                path.write_text(content, encoding="utf-8", newline="")
                if sys.platform != "win32":
                    path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return self.shim_root

    def _read_state(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
            return payload if isinstance(payload, dict) else {}
        except (OSError, ValueError):
            return {}

    @staticmethod
    def _group_id(values: list[str]) -> str:
        return hashlib.sha256(
            json.dumps(values, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()[:24]

    def _state_has_group(
        self,
        state: dict[str, Any],
        generation: str,
        kind: str,
        values: list[str],
    ) -> bool:
        groups = state.get(f"{kind}Groups")
        return (
            state.get(f"{kind}Generation") == generation
            and isinstance(groups, dict)
            and self._group_id(values) in groups
        )

    def _record_group(
        self,
        state: dict[str, Any],
        generation: str,
        kind: str,
        values: list[str],
    ) -> None:
        generation_key = f"{kind}Generation"
        groups_key = f"{kind}Groups"
        if state.get(generation_key) != generation:
            state[generation_key] = generation
            state[groups_key] = {}
        groups = state.setdefault(groups_key, {})
        if not isinstance(groups, dict):
            groups = {}
            state[groups_key] = groups
        groups[self._group_id(values)] = values
        state["schemaVersion"] = 1
        self._write_json(self.state_path, state)

    async def _ensure_packs(self, refs: list[str]) -> None:
        missing: list[str] = []
        for ref in refs:
            component_id, version = parse_runtime_pack_ref(ref)
            active = self.store.active(component_id)
            if active is None or active[0].version != version:
                missing.append(ref)
        if not missing:
            return
        installer = self.runtime_installer
        if installer is None:
            from mona.runtime.official import get_official_runtime_jobs

            component_ids = {parse_runtime_pack_ref(ref)[0] for ref in missing}
            if all(component_id.startswith("node-") for component_id in component_ids):
                component = "node"
            elif any(component_id.startswith("node-") for component_id in component_ids):
                component = "expert"
            else:
                component = "python"
            await get_official_runtime_jobs().ensure_packs(component, missing)
            return
        await installer.ensure_packs(missing)

    def _python_path(self, generation: str) -> Path:
        return (
            self.root
            / "python"
            / "official-envs"
            / generation
            / Path("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        )

    def _entrypoint(self, component_id: str, name: str) -> Path:
        active = self.store.active(component_id)
        if active is None:
            raise AgentRuntimeError(f"Mona runtime {component_id} is not installed")
        manifest, component_root = active
        relative = manifest.entrypoints.get(name)
        if not relative:
            raise AgentRuntimeError(f"Mona runtime {component_id} has no {name}")
        executable = component_root / Path(relative)
        if not executable.is_file():
            raise AgentRuntimeError(f"Mona runtime entrypoint is missing: {executable}")
        return executable

    def _node_ready(self) -> bool:
        return (
            self.store.active("node-base") is not None
            and (self.node_root / "package.json").is_file()
            and (self.node_root / "loader.mjs").is_file()
        )

    async def _checked(
        self,
        command: list[str],
        cwd: Path,
        env: dict[str, str],
        action: str,
    ) -> None:
        code, stdout, stderr = await self.runner(command, cwd=cwd, env=env)
        if code != 0:
            detail = (stderr or stdout).strip()[-2_000:]
            raise AgentRuntimeError(f"failed to {action}: {detail or code}")

    async def _checked_fallback(
        self,
        commands: list[list[str]],
        cwd: Path,
        env: dict[str, str],
        action: str,
    ) -> None:
        errors: list[str] = []
        for command in commands:
            code, stdout, stderr = await self.runner(command, cwd=cwd, env=env)
            if code == 0:
                return
            errors.append((stderr or stdout).strip()[-800:] or str(code))
        raise AgentRuntimeError(f"failed to {action}: " + " | ".join(errors)[-2_000:])

    @staticmethod
    def _write_json(path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary = Path(temporary_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def _pyproject_dependencies(path: Path) -> list[str]:
    if not path.is_file():
        return []
    try:
        payload = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AgentRuntimeError(f"invalid Skill pyproject.toml: {exc}") from exc
    project = payload.get("project")
    if not isinstance(project, dict):
        raise AgentRuntimeError("Skill pyproject.toml requires a [project] table")
    dependencies = project.get("dependencies")
    if dependencies is None:
        return []
    if not isinstance(dependencies, list) or not all(
        isinstance(item, str) and item.strip() for item in dependencies
    ):
        raise AgentRuntimeError("Skill pyproject.toml project.dependencies must be text entries")
    return [item.strip() for item in dependencies]


def _package_json_dependencies(path: Path) -> list[str]:
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise AgentRuntimeError(f"invalid Skill package.json: {exc}") from exc
    dependencies = payload.get("dependencies")
    if dependencies is None:
        return []
    if not isinstance(dependencies, dict):
        raise AgentRuntimeError("Skill package.json dependencies must be an object")
    if not all(
        isinstance(name, str) and name.strip() and isinstance(version, str) and version.strip()
        for name, version in dependencies.items()
    ):
        raise AgentRuntimeError("Skill package.json dependencies must map names to versions")
    return [f"{name}@{version}" for name, version in dependencies.items()]


__all__ = [
    "AgentEnvironmentManager",
    "AgentEnvironmentResolution",
    "AgentRuntimeError",
]
