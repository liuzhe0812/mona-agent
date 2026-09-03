from __future__ import annotations

import json
import os
import sys
import zipfile
from pathlib import Path

import pytest

from mona.runtime.agent_env import AgentEnvironmentManager, AgentRuntimeError
from mona.runtime.manager import RuntimeComponentStore


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
            bundle.writestr("node/node_modules/npm/bin/npx-cli.js", "fixture")
    RuntimeComponentStore(root).install_archive(archive)


async def test_missing_agent_runtime_uses_global_download_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, list[str]]] = []

    class FakeJobs:
        async def ensure_packs(self, component: str, refs: list[str]) -> None:
            calls.append((component, refs))

    monkeypatch.setattr(
        "mona.runtime.official.get_official_runtime_jobs", lambda: FakeJobs()
    )

    await AgentEnvironmentManager(tmp_path / "runtimes")._ensure_packs(
        ["python-base@3.13.15"]
    )

    assert calls == [("python", ["python-base@3.13.15"])]


class FakeRunner:
    def __init__(self) -> None:
        self.commands: list[list[str]] = []

    async def __call__(self, command, *, cwd, env):
        del cwd, env
        self.commands.append(list(command))
        if "venv" in command:
            target = Path(command[-1])
            python = target / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_text("fixture", encoding="utf-8")
        return 0, "", ""


async def test_pyproject_dependencies_share_one_agent_python(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="python-base",
        version="3.13.15",
        entrypoint="python",
        relative="python/python.exe",
    )
    first_skill = tmp_path / "first"
    second_skill = tmp_path / "second"
    first_skill.mkdir()
    second_skill.mkdir()
    (first_skill / "pyproject.toml").write_text(
        '[project]\nname="first"\nversion="1"\ndependencies=["requests>=2"]\n',
        encoding="utf-8",
    )
    (second_skill / "pyproject.toml").write_text(
        '[project]\nname="second"\nversion="1"\ndependencies=["httpx>=0.28"]\n',
        encoding="utf-8",
    )
    runner = FakeRunner()
    manager = AgentEnvironmentManager(root, runner=runner)

    first = await manager.prepare_for_skill(".py", first_skill, None)
    second = await manager.prepare_for_skill(".py", second_skill, None)

    assert first.executable == second.executable
    assert first.environment_id == second.environment_id
    installs = [command for command in runner.commands if "install" in command]
    assert any("requests>=2" in command for command in installs)
    assert any("httpx>=0.28" in command for command in installs)


async def test_agent_command_gets_shared_python_and_node_shims(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="python-base",
        version="3.13.15",
        entrypoint="python",
        relative="python/python.exe",
    )
    _install_component(
        root,
        tmp_path,
        component_id="node-base",
        version="22.23.2",
        entrypoint="node",
        relative="node/node.exe",
    )

    env = await AgentEnvironmentManager(root, runner=FakeRunner()).prepare_command(
        "pip install requests && node app.mjs",
        base_env={"PATH": "system"},
    )

    first_path = Path(env["PATH"].split(os.pathsep)[0])
    assert first_path.name == "bin"
    assert env["MONA_EXECUTION_SCOPE"] == "agent"
    assert env["MONA_AGENT_PYTHON"].endswith("python.exe" if sys.platform == "win32" else "python")
    assert env["MONA_AGENT_NODE"].endswith("node.exe" if sys.platform == "win32" else "node")
    assert (first_path / ("pip.cmd" if sys.platform == "win32" else "pip")).is_file()
    assert (first_path / ("node.cmd" if sys.platform == "win32" else "node")).is_file()


def test_agent_command_rejects_explicit_system_python(tmp_path: Path) -> None:
    manager = AgentEnvironmentManager(tmp_path / "runtimes")
    command = (
        '"C:\\Program Files\\Python\\python.exe" task.py'
        if sys.platform == "win32"
        else "/usr/bin/python3 task.py"
    )

    with pytest.raises(AgentRuntimeError, match="cannot select a system"):
        manager.validate_command(command)


def test_agent_runtime_detection_covers_nested_shell_commands(tmp_path: Path) -> None:
    manager = AgentEnvironmentManager(tmp_path / "runtimes")

    assert manager.requested_runtimes('bash -lc "python task.py"') == {"python"}
    assert manager.requested_runtimes('powershell -Command "npm install"') == {"node"}
    assert manager.requested_runtimes("git status") == set()


async def test_invalid_standard_skill_manifest_fails_loud(tmp_path: Path) -> None:
    root = tmp_path / "runtimes"
    _install_component(
        root,
        tmp_path,
        component_id="python-base",
        version="3.13.15",
        entrypoint="python",
        relative="python/python.exe",
    )
    skill = tmp_path / "broken-skill"
    skill.mkdir()
    (skill / "pyproject.toml").write_text("not toml = [", encoding="utf-8")

    with pytest.raises(AgentRuntimeError, match="invalid Skill pyproject"):
        await AgentEnvironmentManager(root, runner=FakeRunner()).prepare_for_skill(
            ".py", skill, None
        )
