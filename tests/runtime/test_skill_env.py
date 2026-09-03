from __future__ import annotations

import asyncio
import json
import zipfile
from pathlib import Path

import pytest

from mona.runtime.agent_env import (
    AgentEnvironmentManager,
    AgentRuntimeError,
)
from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.skill_env import (
    NodeSkillDependencies,
    PythonSkillDependencies,
    SkillRuntimeSpec,
    parse_skill_runtime_spec,
)


def _install_component(
    root: Path,
    tmp_path: Path,
    *,
    component_id: str,
    version: str,
    entrypoint: str,
    relative: str,
) -> None:
    archive = tmp_path / f"{component_id}.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "runtime-manifest.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": component_id,
                    "version": version,
                    "kind": f"{entrypoint}-runtime",
                    "entrypoints": {entrypoint: relative},
                }
            ),
        )
        bundle.writestr(relative, "fixture")
        if entrypoint == "node":
            bundle.writestr("node/node_modules/npm/bin/npm-cli.js", "fixture")
    RuntimeComponentStore(root).install_archive(archive)


class FakeRunner:
    def __init__(self) -> None:
        self.commands: list[list[str]] = []

    async def __call__(self, command, *, cwd, env):
        del env
        self.commands.append(list(command))
        if "venv" in command:
            target = Path(command[-1])
            python = target / (
                "Scripts/python.exe" if __import__("sys").platform == "win32" else "bin/python"
            )
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_text("fixture", encoding="utf-8")
        if command[-3:] == ["pip", "freeze", "--all"]:
            return 0, "pip==25.0\nrequests==2.32.5\n", ""
        return 0, "", ""


def test_runtime_declarations_require_exact_dependency_versions() -> None:
    spec = parse_skill_runtime_spec(
        {
            "python": {"requirements": ["requests==2.32.5"]},
            "node": {"packages": ["lodash@4.17.21"]},
        }
    )

    assert spec is not None
    assert spec.python == PythonSkillDependencies(requirements=["requests==2.32.5"])
    assert spec.node == NodeSkillDependencies(packages=["lodash@4.17.21"])
    with pytest.raises(ValueError, match="name==version"):
        PythonSkillDependencies(requirements=["requests>=2"])
    with pytest.raises(ValueError, match="package@version"):
        NodeSkillDependencies(packages=["lodash@latest"])


async def test_python_dependency_profiles_are_reused_by_declaration(
    tmp_path: Path,
) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="python-base",
        version="3.13.15",
        entrypoint="python",
        relative="python/python.exe",
    )
    runner = FakeRunner()
    manager = AgentEnvironmentManager(root, runner=runner)
    spec = SkillRuntimeSpec(python=PythonSkillDependencies(requirements=["requests==2.32.5"]))

    first = await manager.prepare_for_skill(".py", tmp_path, spec)
    command_count = len(runner.commands)
    second = await manager.prepare_for_skill(".py", tmp_path, spec)

    assert first.environment_id == second.environment_id
    assert first.executable == second.executable
    assert len(runner.commands) == command_count
    assert first.env["PYTHONNOUSERSITE"] == "1"
    assert (first.executable.parent.parent / "environment.json").is_file()


async def test_concurrent_python_profile_preparation_does_not_block_event_loop(
    tmp_path: Path,
) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="python-base",
        version="3.13.15",
        entrypoint="python",
        relative="python/python.exe",
    )

    class SlowRunner(FakeRunner):
        async def __call__(self, command, *, cwd, env):
            if "venv" in command:
                await asyncio.sleep(0.05)
            return await super().__call__(command, cwd=cwd, env=env)

    runner = SlowRunner()
    spec = SkillRuntimeSpec(python=PythonSkillDependencies(requirements=["requests==2.32.5"]))
    first, second = await asyncio.wait_for(
        asyncio.gather(
            AgentEnvironmentManager(root, runner=runner).prepare_for_skill(".py", tmp_path, spec),
            AgentEnvironmentManager(root, runner=runner).prepare_for_skill(".py", tmp_path, spec),
        ),
        timeout=2,
    )

    assert first.executable == second.executable
    assert sum("venv" in command for command in runner.commands) == 1


async def test_corrupt_python_profile_is_rebuilt(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="python-base",
        version="3.13.15",
        entrypoint="python",
        relative="python/python.exe",
    )
    runner = FakeRunner()
    manager = AgentEnvironmentManager(root, runner=runner)
    spec = SkillRuntimeSpec(python=PythonSkillDependencies())
    first = await manager.prepare_for_skill(".py", tmp_path, spec)
    environment = first.executable.parent.parent / "environment.json"
    environment.unlink()
    first_build_commands = len(runner.commands)

    rebuilt = await manager.prepare_for_skill(".py", tmp_path, spec)

    assert rebuilt.executable == first.executable
    assert environment.is_file()
    assert len(runner.commands) > first_build_commands


async def test_different_python_dependencies_share_one_agent_environment(
    tmp_path: Path,
) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="python-base",
        version="3.13.15",
        entrypoint="python",
        relative="python/python.exe",
    )
    manager = AgentEnvironmentManager(root, runner=FakeRunner())

    first = await manager.prepare_for_skill(
        ".py",
        tmp_path,
        SkillRuntimeSpec(python=PythonSkillDependencies(requirements=["requests==2.32.5"])),
    )
    second = await manager.prepare_for_skill(
        ".py",
        tmp_path,
        SkillRuntimeSpec(python=PythonSkillDependencies(requirements=["httpx==0.28.1"])),
    )

    assert first.environment_id == second.environment_id
    assert first.executable == second.executable


async def test_platform_profiles_install_only_their_capability_dependencies(
    tmp_path: Path,
) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="python-base",
        version="3.13.15",
        entrypoint="python",
        relative="python/python.exe",
    )
    runner = FakeRunner()
    manager = AgentEnvironmentManager(root, runner=runner)

    resolution = await manager.prepare_for_skill(
        ".py",
        tmp_path,
        SkillRuntimeSpec(python=PythonSkillDependencies(profile="platform-docx")),
    )

    install = next(command for command in runner.commands if "install" in command)
    assert "defusedxml==0.7.1" in install
    assert "lxml==6.1.2" in install
    assert "numpy==2.5.2" not in install
    assert resolution.environment_id


async def test_node_profile_uses_managed_node_and_profile_loader(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="node-base",
        version="22.23.2",
        entrypoint="node",
        relative="node/node.exe",
    )
    manager = AgentEnvironmentManager(root, runner=FakeRunner())

    resolution = await manager.prepare_for_skill(
        ".mjs",
        tmp_path,
        SkillRuntimeSpec(node=NodeSkillDependencies(packages=["lodash@4.17.21"])),
    )

    assert "node-base" in str(resolution.executable)
    assert "--experimental-loader" in resolution.prefix_args
    assert resolution.prefix_args[-1].startswith("file:")
    assert resolution.env["MONA_NODE_PROFILE"]


async def test_corrupt_node_profile_is_rebuilt(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="node-base",
        version="22.23.2",
        entrypoint="node",
        relative="node/node.exe",
    )
    runner = FakeRunner()
    manager = AgentEnvironmentManager(root, runner=runner)
    spec = SkillRuntimeSpec(node=NodeSkillDependencies())
    first = await manager.prepare_for_skill(".mjs", tmp_path, spec)
    loader = Path(first.env["MONA_NODE_PROFILE"]) / "loader.mjs"
    loader.unlink()

    rebuilt = await manager.prepare_for_skill(".mjs", tmp_path, spec)

    assert rebuilt.environment_id == first.environment_id
    assert loader.is_file()


async def test_r_scripts_never_fall_back_to_system_r(tmp_path: Path) -> None:
    with pytest.raises(AgentRuntimeError, match="managed R"):
        await AgentEnvironmentManager(tmp_path / "runtimes").prepare_for_skill(".r", tmp_path, None)
