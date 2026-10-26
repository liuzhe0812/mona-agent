"""Shared official Python environment generation tests."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import zipfile
from pathlib import Path

import pytest

from mona.runtime.manager import RuntimeComponentStore, RuntimeManagerError
from mona.runtime.python_env import CommandResult, PythonEnvironmentBuilder


def _archive(
    path: Path,
    *,
    component_id: str,
    version: str,
    entrypoints: dict[str, str] | None = None,
    requirements: bool = False,
    environment: str = "official",
) -> Path:
    entrypoints = entrypoints or {}
    manifest: dict[str, object] = {
        "schemaVersion": 1,
        "id": component_id,
        "version": version,
        "kind": "python-runtime" if entrypoints else "python-pack",
        "entrypoints": entrypoints,
    }
    if requirements:
        manifest.update(
            {
                "pythonRequirements": "requirements.lock",
                "pythonWheelhouse": "wheels",
                "healthImports": ["numpy", "pandas.io"],
                "pythonEnvironment": environment,
            }
        )
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("runtime-manifest.json", json.dumps(manifest))
        for relative in entrypoints.values():
            bundle.writestr(relative, "fixture executable")
        if requirements:
            bundle.writestr(
                "requirements.lock",
                "fixture==1 --hash=sha256:" + "0" * 64 + "\n",
            )
            bundle.writestr("wheels/fixture-1-py3-none-any.whl", "fixture wheel")
    return path


class FakeRunner:
    def __init__(self, *, fail_requirements_fragment: str | None = None) -> None:
        self.commands: list[list[str]] = []
        self.fail_requirements_fragment = fail_requirements_fragment

    async def __call__(
        self,
        command: list[str],
        _cwd: Path,
        _env: dict[str, str],
    ) -> CommandResult:
        self.commands.append(command)
        if command[1:3] == ["-m", "venv"]:
            python = Path(command[3]) / "Scripts" / "python.exe"
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_text("fixture venv python", encoding="utf-8")
        if (
            self.fail_requirements_fragment
            and "pip" in command
            and any(self.fail_requirements_fragment in value for value in command)
        ):
            return CommandResult(1, stderr="offline wheel installation failed")
        return CommandResult(0)


def _install_base(store: RuntimeComponentStore, tmp_path: Path) -> None:
    store.install_archive(
        _archive(
            tmp_path / "python-base.zip",
            component_id="python-base",
            version="3.12",
            entrypoints={"python": "python.exe"},
        )
    )


async def test_builds_offline_environment_once_and_resolves_it(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    store = RuntimeComponentStore(root)
    _install_base(store, tmp_path)
    store.install_archive(
        _archive(
            tmp_path / "scientific.zip",
            component_id="scientific",
            version="1",
            requirements=True,
        )
    )
    runner = FakeRunner()
    builder = PythonEnvironmentBuilder(root, store, runner=runner, current_platform="win32")

    first = await builder.ensure(["python-base@3.12", "scientific@1"])
    second = await builder.ensure(["python-base@3.12", "scientific@1"])

    assert second == first
    assert builder.current() == first
    assert len(runner.commands) == 3
    pip_command = runner.commands[1]
    assert pip_command[1:4] == ["-m", "pip", "install"]
    assert "--no-index" in pip_command
    assert "--require-hashes" in pip_command
    assert "--find-links" in pip_command
    assert builder.python_for(["python-base@3.12", "scientific@1"]) == (
        root / "python" / "official-envs" / first.generation / "Scripts" / "python.exe"
    )


async def test_concurrent_official_environment_build_is_shared(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    store = RuntimeComponentStore(root)
    _install_base(store, tmp_path)
    store.install_archive(
        _archive(
            tmp_path / "scientific.zip",
            component_id="scientific",
            version="1",
            requirements=True,
        )
    )

    class SlowRunner(FakeRunner):
        async def __call__(self, command, cwd, env):
            if command[1:3] == ["-m", "venv"]:
                await asyncio.sleep(0.05)
            return await super().__call__(command, cwd, env)

    runner = SlowRunner()
    first, second = await asyncio.wait_for(
        asyncio.gather(
            PythonEnvironmentBuilder(root, store, runner=runner, current_platform="win32").ensure(
                ["python-base@3.12", "scientific@1"]
            ),
            PythonEnvironmentBuilder(root, store, runner=runner, current_platform="win32").ensure(
                ["python-base@3.12", "scientific@1"]
            ),
        ),
        timeout=2,
    )

    assert first.generation == second.generation
    assert sum(command[1:3] == ["-m", "venv"] for command in runner.commands) == 1


async def test_failed_upgrade_keeps_previous_environment_active(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    store = RuntimeComponentStore(root)
    _install_base(store, tmp_path)
    store.install_archive(
        _archive(
            tmp_path / "scientific-v1.zip",
            component_id="scientific",
            version="1",
            requirements=True,
        )
    )
    initial_runner = FakeRunner()
    initial_builder = PythonEnvironmentBuilder(
        root, store, runner=initial_runner, current_platform="win32"
    )
    previous = await initial_builder.ensure(["python-base@3.12", "scientific@1"])
    store.install_archive(
        _archive(
            tmp_path / "scientific-v2.zip",
            component_id="scientific",
            version="2",
            requirements=True,
        )
    )
    failing = PythonEnvironmentBuilder(
        root,
        store,
        runner=FakeRunner(fail_requirements_fragment="requirements.lock"),
        current_platform="win32",
    )

    with pytest.raises(RuntimeManagerError, match="offline wheel installation failed"):
        await failing.ensure(["python-base@3.12", "scientific@2"])

    assert failing.current() == previous
    assert not (
        root
        / "python"
        / "official-envs"
        / PythonEnvironmentBuilder._generation(
            ["python-base@3.12", "scientific@2"],
            failing._resolve_components(["python-base@3.12", "scientific@2"]),
        )
    ).exists()


async def test_financial_environment_does_not_merge_scientific_packs(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    store = RuntimeComponentStore(root)
    _install_base(store, tmp_path)
    for component, environment in (("scientific", "official"), ("stock-vibe", "stock-vibe")):
        store.install_archive(_archive(
            tmp_path / f"{component}.zip", component_id=component, version="1",
            requirements=True, environment=environment,
        ))
    builder = PythonEnvironmentBuilder(root, store, runner=FakeRunner(), current_platform="win32")
    scientific = await builder.ensure(["python-base@3.12", "scientific@1"])
    financial = builder.for_environment("stock-vibe")
    vibe = await financial.ensure(["python-base@3.12", "stock-vibe@1"])
    assert builder.current() == scientific
    assert financial.current() == vibe
    assert vibe.packs == ["python-base@3.12", "stock-vibe@1"]
    assert builder.python_for(["stock-vibe@1"]) is None
    assert financial.python_for(["scientific@1"]) is None
    with pytest.raises(RuntimeManagerError, match="different environment"):
        await builder.ensure(["python-base@3.12", "stock-vibe@1"])
    with pytest.raises(ValueError):
        builder.for_environment("../outside")


async def test_busy_old_environment_does_not_fail_new_activation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    root = tmp_path / "runtimes"
    store = RuntimeComponentStore(root)
    _install_base(store, tmp_path)
    builder = PythonEnvironmentBuilder(root, store, runner=FakeRunner(), current_platform="win32")

    generations = []
    for version in ("1", "2"):
        store.install_archive(
            _archive(
                tmp_path / f"scientific-v{version}.zip",
                component_id="scientific",
                version=version,
                requirements=True,
            )
        )
        generations.append(await builder.ensure(["python-base@3.12", f"scientific@{version}"]))

    oldest, rollback = generations
    oldest_path = builder.environments_root / oldest.generation
    rollback_path = builder.environments_root / rollback.generation
    original_rmtree = shutil.rmtree

    def rmtree_with_busy_old_generation(path: str | Path, *args: object, **kwargs: object) -> None:
        if Path(path) == oldest_path:
            raise PermissionError(13, "file in use")
        original_rmtree(path, *args, **kwargs)

    monkeypatch.setattr("mona.runtime.python_env.shutil.rmtree", rmtree_with_busy_old_generation)
    caplog.set_level(logging.WARNING, logger="mona.runtime.python_env")

    store.install_archive(
        _archive(
            tmp_path / "scientific-v3.zip",
            component_id="scientific",
            version="3",
            requirements=True,
        )
    )
    ready = await builder.ensure(["python-base@3.12", "scientific@3"])

    current = builder.current()
    assert current == ready
    assert json.loads(builder.current_path.read_text(encoding="utf-8"))["generation"] == ready.generation
    assert (builder.environments_root / ready.generation / "environment.json").is_file()
    assert rollback_path.is_dir()
    assert oldest_path.is_dir()
    assert any(
        "Could not prune inactive Python environment generation " + oldest.generation in record.message
        for record in caplog.records
    )
