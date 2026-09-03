"""Generation-based official Python venv builder using signed offline wheel packs."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sys
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from filelock import FileLock, Timeout
from pydantic import Field, field_validator

from mona.config.schema import Base
from mona.runtime.manager import (
    ActiveRuntimeComponent,
    RuntimeComponentManifest,
    RuntimeComponentStore,
    RuntimeManagerError,
    parse_runtime_pack_ref,
)


class ManagedPythonEnvironment(Base):
    schema_version: int = 1
    generation: str
    packs: list[str] = Field(min_length=1)
    base_pack: str
    python_relative: str
    created_at: str

    @field_validator("generation")
    @classmethod
    def _generation(cls, value: str) -> str:
        if len(value) != 32 or any(ch not in "0123456789abcdef" for ch in value):
            raise ValueError("invalid Python environment generation")
        return value


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


@dataclass(frozen=True, slots=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


CommandRunner = Callable[[list[str], Path, dict[str, str]], Awaitable[CommandResult]]


async def _run_command(command: list[str], cwd: Path, env: dict[str, str]) -> CommandResult:
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(cwd),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    return CommandResult(
        returncode=process.returncode or 0,
        stdout=stdout.decode("utf-8", errors="replace"),
        stderr=stderr.decode("utf-8", errors="replace"),
    )


class PythonEnvironmentBuilder:
    """Build one shared official venv generation without mutating the active one."""

    def __init__(
        self,
        root: Path,
        store: RuntimeComponentStore,
        *,
        runner: CommandRunner = _run_command,
        current_platform: str = sys.platform,
    ) -> None:
        self.root = root.resolve()
        self.store = store
        self.runner = runner
        self.current_platform = current_platform
        self.environments_root = self.root / "python" / "official-envs"
        self.current_path = self.environments_root / "current.json"

    async def ensure(self, requested_packs: list[str]) -> ManagedPythonEnvironment:
        current = self.current()
        packs = self._merge_packs(current.packs if current else [], requested_packs)
        components = self._resolve_components(packs)
        base_ref, base_manifest, base_root, _base_receipt = self._python_base(components)
        generation = self._generation(packs, components)
        final = self.environments_root / generation
        expected = ManagedPythonEnvironment(
            generation=generation,
            packs=packs,
            basePack=base_ref,
            pythonRelative=(
                "Scripts/python.exe" if self.current_platform == "win32" else "bin/python"
            ),
            createdAt=datetime.now(timezone.utc).isoformat(),
        )
        lock = FileLock(str(self.environments_root) + ".build.lock", timeout=600)
        await _acquire_file_lock(lock, 600)
        try:
            ready = self._read_environment(final)
            if ready is None:
                if final.exists():
                    shutil.rmtree(final)
                final.mkdir(parents=True, exist_ok=False)
                try:
                    await self._build(
                        final,
                        expected,
                        base_manifest,
                        base_root,
                        components,
                    )
                    self._write_json(final / "environment.json", expected.model_dump(by_alias=True))
                except Exception:
                    shutil.rmtree(final, ignore_errors=True)
                    raise
                ready = expected
            self._write_json(self.current_path, ready.model_dump(by_alias=True))
            self._prune(keep=2)
            return ready
        finally:
            lock.release()

    @staticmethod
    def _merge_packs(current: list[str], requested: list[str]) -> list[str]:
        merged: list[str] = []
        positions: dict[str, int] = {}
        for ref in [*current, *requested]:
            component_id, _version = parse_runtime_pack_ref(ref)
            position = positions.get(component_id)
            if position is None:
                positions[component_id] = len(merged)
                merged.append(ref)
            else:
                merged[position] = ref
        return merged

    def current(self) -> ManagedPythonEnvironment | None:
        try:
            pointer = ManagedPythonEnvironment.model_validate_json(
                self.current_path.read_text(encoding="utf-8")
            )
            if self._read_environment(self.environments_root / pointer.generation) != pointer:
                return None
            python = self.environments_root / pointer.generation / Path(pointer.python_relative)
            return pointer if python.is_file() else None
        except (OSError, ValueError):
            return None

    def python_for(self, requested_packs: list[str]) -> Path | None:
        current = self.current()
        if current is None or not set(requested_packs).issubset(current.packs):
            return None
        return self.environments_root / current.generation / Path(current.python_relative)

    def _resolve_components(
        self,
        packs: list[str],
    ) -> dict[str, tuple[str, RuntimeComponentManifest, Path, ActiveRuntimeComponent]]:
        result: dict[str, tuple[str, RuntimeComponentManifest, Path, ActiveRuntimeComponent]] = {}
        missing: list[str] = []
        for ref in packs:
            component_id, version = parse_runtime_pack_ref(ref)
            active = self.store.active(component_id)
            if active is None or active[0].version != version:
                missing.append(ref)
                continue
            receipt = ActiveRuntimeComponent.model_validate_json(
                (active[1] / "receipt.json").read_text(encoding="utf-8")
            )
            result[ref] = (ref, active[0], active[1], receipt)
        if missing:
            raise RuntimeManagerError("runtime components are not active: " + ", ".join(missing))
        return result

    @staticmethod
    def _python_base(
        components: dict[str, tuple[str, RuntimeComponentManifest, Path, ActiveRuntimeComponent]],
    ) -> tuple[str, RuntimeComponentManifest, Path, ActiveRuntimeComponent]:
        candidates = [value for value in components.values() if "python" in value[1].entrypoints]
        if len(candidates) != 1:
            raise RuntimeManagerError("Python packs must resolve exactly one base interpreter")
        return candidates[0]

    @staticmethod
    def _generation(
        packs: list[str],
        components: dict[str, tuple[str, RuntimeComponentManifest, Path, ActiveRuntimeComponent]],
    ) -> str:
        digest = hashlib.sha256()
        for ref in packs:
            digest.update(ref.encode())
            digest.update(b"\0")
            digest.update(components[ref][3].sha256.encode())
            digest.update(b"\n")
        return digest.hexdigest()[:32]

    async def _build(
        self,
        final: Path,
        environment: ManagedPythonEnvironment,
        base_manifest: RuntimeComponentManifest,
        base_root: Path,
        components: dict[str, tuple[str, RuntimeComponentManifest, Path, ActiveRuntimeComponent]],
    ) -> None:
        base_python = base_root.joinpath(*Path(base_manifest.entrypoints["python"]).parts)
        command_env = os.environ.copy()
        command_env.update(
            {
                "PYTHONNOUSERSITE": "1",
                "PYTHONUTF8": "1",
                "PIP_NO_INPUT": "1",
                "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            }
        )
        await self._checked(
            [str(base_python), "-m", "venv", str(final)],
            self.environments_root,
            command_env,
            "create Python venv",
        )
        venv_python = final / Path(environment.python_relative)
        if not venv_python.is_file():
            raise RuntimeManagerError("venv Python executable was not created")
        health_imports: list[str] = []
        for ref in environment.packs:
            _pack_ref, manifest, root, _receipt = components[ref]
            if manifest.python_requirements is not None:
                requirements = root / Path(manifest.python_requirements)
                wheelhouse = root / Path(manifest.python_wheelhouse or "")
                if not requirements.is_file() or not wheelhouse.is_dir():
                    raise RuntimeManagerError(f"Python wheel pack is incomplete: {ref}")
                await self._checked(
                    [
                        str(venv_python),
                        "-m",
                        "pip",
                        "install",
                        "--no-index",
                        "--require-hashes",
                        "--find-links",
                        str(wheelhouse),
                        "-r",
                        str(requirements),
                    ],
                    final,
                    command_env,
                    f"install Python pack {ref}",
                )
            for module in manifest.health_imports:
                if module not in health_imports:
                    health_imports.append(module)
        health_code = "import importlib\n" + "\n".join(
            f"importlib.import_module({module!r})" for module in health_imports
        )
        await self._checked(
            [str(venv_python), "-c", health_code or "pass"],
            final,
            command_env,
            "verify Python environment",
        )

    async def _checked(
        self,
        command: list[str],
        cwd: Path,
        env: dict[str, str],
        action: str,
    ) -> None:
        result = await self.runner(command, cwd, env)
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()[-2_000:]
            raise RuntimeManagerError(f"failed to {action}: {detail or result.returncode}")

    @staticmethod
    def _read_environment(root: Path) -> ManagedPythonEnvironment | None:
        try:
            return ManagedPythonEnvironment.model_validate_json(
                (root / "environment.json").read_text(encoding="utf-8")
            )
        except (OSError, ValueError):
            return None

    def _prune(self, *, keep: int) -> None:
        current = self.current()
        environments: list[tuple[ManagedPythonEnvironment, Path]] = []
        if not self.environments_root.is_dir():
            return
        for directory in self.environments_root.iterdir():
            if not directory.is_dir():
                continue
            environment = self._read_environment(directory)
            if environment is not None:
                environments.append((environment, directory))
        environments.sort(key=lambda item: item[0].created_at, reverse=True)
        protected = {environment.generation for environment, _path in environments[:keep]}
        if current is not None:
            protected.add(current.generation)
        for environment, directory in environments:
            if environment.generation not in protected:
                shutil.rmtree(directory)

    @staticmethod
    def _write_json(path: Path, payload: dict[str, object]) -> None:
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


__all__ = [
    "CommandResult",
    "ManagedPythonEnvironment",
    "PythonEnvironmentBuilder",
]
