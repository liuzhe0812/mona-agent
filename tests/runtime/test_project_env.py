from __future__ import annotations

import json
import os
import sys
import zipfile
from pathlib import Path

import pytest

from mona.runtime.manager import RuntimeComponentStore
from mona.runtime.project_env import ProjectEnvironmentManager, ProjectRuntimeError


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
    RuntimeComponentStore(root).install_archive(archive)


async def test_missing_project_runtime_uses_global_download_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, list[str]]] = []

    class FakeJobs:
        async def ensure_packs(self, component: str, refs: list[str]) -> None:
            calls.append((component, refs))

    monkeypatch.setattr(
        "mona.runtime.official.get_official_runtime_jobs", lambda: FakeJobs()
    )

    await ProjectEnvironmentManager(tmp_path / "runtimes")._ensure_packs(
        ["node-base@22.23.2"]
    )

    assert calls == [("node", ["node-base@22.23.2"])]


class FakeRunner:
    def __init__(self) -> None:
        self.commands: list[list[str]] = []

    async def __call__(self, command, *, cwd):
        del cwd
        self.commands.append(list(command))
        target = Path(command[-1])
        python = target / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_text("fixture", encoding="utf-8")
        return 0, "", ""


def test_detects_only_shell_runtime_commands() -> None:
    detect = ProjectEnvironmentManager.requested_runtimes

    assert detect("python app.py && npm test") == {"python", "node"}
    assert detect("pytest -q") == {"python"}
    assert detect("pnpm test | vitest run") == {"node"}
    assert detect("echo python") == set()
    assert detect("C:\\custom\\python.exe app.py") == set()


async def test_existing_project_venv_is_preferred(tmp_path: Path) -> None:
    project = tmp_path / "project"
    python = project / (
        ".venv/Scripts/python.exe" if sys.platform == "win32" else ".venv/bin/python"
    )
    python.parent.mkdir(parents=True)
    python.write_text("fixture", encoding="utf-8")
    runner = FakeRunner()

    result = await ProjectEnvironmentManager(
        tmp_path / "runtimes",
        runner=runner,
    ).prepare(
        "python app.py",
        cwd=project,
        workspace_root=project,
        base_env={"PATH": "system"},
    )

    assert result.python == python
    assert result.env["PATH"].split(os.pathsep)[1] == str(python.parent)
    assert runner.commands == []


async def test_missing_project_venv_is_created_from_mona_python(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    runtime_root = tmp_path / "runtimes"
    _install_component(
        runtime_root,
        tmp_path,
        component_id="python-base",
        version="3.13.15",
        entrypoint="python",
        relative="python/python.exe",
    )
    runner = FakeRunner()

    result = await ProjectEnvironmentManager(runtime_root, runner=runner).prepare(
        "python -m pytest",
        cwd=project,
        workspace_root=project,
        base_env={"PATH": "system"},
    )

    assert result.python is not None
    assert result.python.is_file()
    assert result.python.parent.parent == project / ".venv"
    assert runner.commands[0][1:3] == ["-m", "venv"]
    assert not (runtime_root / "skill-envs").exists()


async def test_node_uses_mona_binary_and_keeps_dependencies_in_project(
    tmp_path: Path,
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "package.json").write_text('{"name":"demo"}\n', encoding="utf-8")
    runtime_root = tmp_path / "runtimes"
    _install_component(
        runtime_root,
        tmp_path,
        component_id="node-base",
        version="22.23.2",
        entrypoint="node",
        relative="node/node.exe",
    )

    result = await ProjectEnvironmentManager(runtime_root).prepare(
        "npm install",
        cwd=project,
        workspace_root=project,
        base_env={"PATH": "system"},
    )

    assert result.node is not None
    assert result.env["MONA_PROJECT_ROOT"] == str(project)
    path_entries = result.env["PATH"].split(os.pathsep)
    assert path_entries[0] == str(project / "node_modules" / ".bin")
    assert path_entries[1] == str(result.node.parent)
    assert not (runtime_root / "skill-envs").exists()


async def test_incompatible_project_node_version_is_rejected(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / ".nvmrc").write_text("20\n", encoding="utf-8")
    runtime_root = tmp_path / "runtimes"
    _install_component(
        runtime_root,
        tmp_path,
        component_id="node-base",
        version="22.23.2",
        entrypoint="node",
        relative="node/node.exe",
    )

    with pytest.raises(ProjectRuntimeError, match="requires Node 20"):
        await ProjectEnvironmentManager(runtime_root).prepare(
            "node app.js",
            cwd=project,
            workspace_root=project,
            base_env={"PATH": "system"},
        )
