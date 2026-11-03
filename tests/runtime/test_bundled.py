from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import zipfile
from pathlib import Path

import pytest

from mona.runtime.agent_env import AgentEnvironmentManager
from mona.runtime.bundled import load_bundled_runtime
from mona.runtime.jobs import RuntimeInstallJobManager
from mona.runtime.manager import RuntimeComponentStore, RuntimeManagerError
from mona.runtime.python_env import CommandResult, PythonEnvironmentBuilder, _run_command


def _payload(root: Path) -> Path:
    root.mkdir()
    components = []
    for name, version, entrypoints in (
        ("python-base", "3.13.15", {"python": "python/python.exe"}),
        ("node-base", "22.23.2", {"node": "node/node.exe"}),
        ("python-common", "1.0.0", {}),
    ):
        manifest = {
            "schemaVersion": 1, "id": name, "version": version,
            "kind": "python-pack" if name == "python-common" else name.replace("-base", "-runtime"),
            "entrypoints": entrypoints,
        }
        if name == "python-common":
            manifest.update(pythonRequirements="requirements.lock", pythonWheelhouse="wheels",
                            dependencies=["python-base@3.13.15"])
        archive = root / f"{name}.zip"
        with zipfile.ZipFile(archive, "w") as bundle:
            bundle.writestr("runtime-manifest.json", json.dumps(manifest))
            for relative in entrypoints.values():
                bundle.writestr(relative, "fixture")
            if name == "python-common":
                bundle.writestr("requirements.lock", "# empty test wheel pack\n")
                bundle.writestr("wheels/", "")
        components.append({
            "archive": archive.name, "size": archive.stat().st_size,
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "manifest": manifest,
        })
    (root / "manifest.json").write_text(json.dumps({
        "schemaVersion": 1, "platform": "win32", "architecture": "x64", "components": components,
    }), encoding="utf-8")
    return root


class OfflineCatalog:
    async def fetch(self):
        pytest.fail("bundled preparation must not request a network catalog")


def _jobs(tmp_path: Path, resources: Path) -> RuntimeInstallJobManager:
    return RuntimeInstallJobManager(
        catalog_client=OfflineCatalog(), component_store=RuntimeComponentStore(tmp_path / "runtimes"),
        state_path=tmp_path / "jobs.json", installer=None, current_platform="win32",
        current_architecture="x64", auto_download_enabled=lambda: False, bundled_runtime_root=resources,
    )


def test_verifies_payload_and_rejects_wrong_platform(tmp_path: Path) -> None:
    root = _payload(tmp_path / "payload")
    payload = load_bundled_runtime(root, current_platform="win32", current_architecture="x64")
    assert set(payload.python_refs) == {"python-base@3.13.15", "python-common@1.0.0"}
    with pytest.raises(RuntimeManagerError, match="platform or architecture"):
        load_bundled_runtime(root, current_platform="darwin", current_architecture="arm64")


@pytest.mark.parametrize("damage", ["missing", "hash", "inner-manifest", "escape"])
def test_rejects_invalid_archives(tmp_path: Path, damage: str) -> None:
    root = _payload(tmp_path / "payload")
    descriptor = root / "manifest.json"
    data = json.loads(descriptor.read_text(encoding="utf-8"))
    entry = data["components"][0]
    archive = root / entry["archive"]
    if damage == "missing":
        archive.unlink()
    elif damage == "hash":
        archive.write_bytes(b"corrupt")
    elif damage == "escape":
        entry["archive"] = "../python-base.zip"
    else:
        entry["manifest"]["entrypoints"]["python"] = "another-python.exe"
    descriptor.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(RuntimeManagerError):
        load_bundled_runtime(root, current_platform="win32", current_architecture="x64")


async def test_offline_preparation_is_shared_and_reuses_installed_packs(tmp_path: Path, monkeypatch) -> None:
    resources = _payload(tmp_path / "payload")
    manager = _jobs(tmp_path, resources)
    commands = []

    async def runner(command, cwd, env):
        commands.append(command)
        await asyncio.sleep(0)
        if command[1:3] == ["-m", "venv"]:
            python = Path(command[-1]) / "Scripts/python.exe"
            python.parent.mkdir(parents=True)
            python.write_text("fixture", encoding="utf-8")
        return CommandResult(0)

    monkeypatch.setattr("mona.runtime.python_env.PythonEnvironmentBuilder", lambda *args, **kwargs:
                        PythonEnvironmentBuilder(*args, **kwargs, runner=runner))
    assert await asyncio.gather(manager.ensure_bundled(), manager.ensure_bundled()) == [True, True]
    job = await manager.ensure_packs("node", ["node-base@22.23.2"])
    assert job.state == "completed"
    assert manager.get(job.job_id) == job
    assert sum(command[1:3] == ["-m", "venv"] for command in commands) == 1
    current = PythonEnvironmentBuilder(manager.component_store.root, manager.component_store).current()
    assert current is not None and "python-common@1.0.0" in current.packs


async def test_failed_build_does_not_activate_bundled_components(tmp_path: Path, monkeypatch) -> None:
    manager = _jobs(tmp_path, _payload(tmp_path / "payload"))

    async def runner(command, cwd, env):
        return CommandResult(1, stderr="fixture failure")

    monkeypatch.setattr("mona.runtime.python_env.PythonEnvironmentBuilder", lambda *args, **kwargs:
                        PythonEnvironmentBuilder(*args, **kwargs, runner=runner))
    with pytest.raises(RuntimeManagerError, match="fixture failure"):
        await manager.ensure_bundled()
    assert manager.component_store.active("python-base") is None
    assert manager.component_store.active("node-base") is None
    assert PythonEnvironmentBuilder(manager.component_store.root, manager.component_store).current() is None


def _installed_metadata(tmp_path: Path) -> tuple[AgentEnvironmentManager, Path, Path]:
    manager = AgentEnvironmentManager(tmp_path)
    root = tmp_path / "python/official-envs/fixture"
    root.mkdir(parents=True)
    (root / "environment.json").write_text('{"basePack":"python-base@3.13.15"}', encoding="utf-8")
    python = root / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    packages = root / ("Lib/site-packages" if sys.platform == "win32" else "lib/python3.13/site-packages")
    metadata = packages / "fixture-1.0.dist-info/METADATA"
    metadata.parent.mkdir(parents=True)
    metadata.write_text("Metadata-Version: 2.1\nName: fixture\nVersion: 1.0\n", encoding="utf-8")
    return manager, python, metadata


def test_dependency_check_uses_target_venv_and_target_python_markers(tmp_path: Path) -> None:
    manager, python, metadata = _installed_metadata(tmp_path)
    with metadata.open("a", encoding="utf-8") as stream:
        stream.write('Requires-Dist: unavailable; python_version < "3.13"\n')
    assert manager._python_requirements_satisfied(python, ["fixture==1.0"])
    assert not manager._python_requirements_satisfied(python, ["fixture>=2"])
    assert not manager._python_requirements_satisfied(python, ["pytest"])
    assert not manager._python_requirements_satisfied(python, ["fixture[extra]"])
    with metadata.open("a", encoding="utf-8") as stream:
        stream.write("Requires-Dist: missing-transitive-dependency\n")
    assert not manager._python_requirements_satisfied(python, ["fixture"])


async def test_installed_dependencies_do_not_invoke_online_pip(tmp_path: Path) -> None:
    manager, python, _metadata = _installed_metadata(tmp_path)

    async def runner(*args, **kwargs):
        pytest.fail("already installed dependencies must not invoke pip")

    manager.runner = runner
    await manager._install_python_group(python, "fixture", ["fixture==1.0"])
    assert manager._state_has_group(manager._read_state(), "fixture", "python", ["fixture==1.0"])


async def test_cancelling_python_preparation_stops_owned_process(tmp_path: Path) -> None:
    marker = tmp_path / "started"
    task = asyncio.create_task(_run_command([
        sys.executable, "-c", "import pathlib,sys,time; pathlib.Path(sys.argv[1]).write_text('ready'); time.sleep(60)", str(marker),
    ], tmp_path, os.environ.copy()))
    async with asyncio.timeout(5):
        while not marker.exists():
            await asyncio.sleep(0.01)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 10)


async def test_gateway_startup_does_not_wait_for_environment_preparation(tmp_path: Path, monkeypatch) -> None:
    from mona.api.server import _cancel_bundled_runtime_startup, _schedule_bundled_runtime_startup

    started = asyncio.Event()
    release = asyncio.Event()

    class Jobs:
        async def ensure_bundled(self):
            started.set()
            await release.wait()

    monkeypatch.setattr("mona.runtime.bundled.bundled_runtime_root", lambda: tmp_path)
    monkeypatch.setattr("mona.runtime.official.get_official_runtime_jobs", lambda: Jobs())
    app = {}
    await asyncio.wait_for(_schedule_bundled_runtime_startup(app), 1)
    await asyncio.wait_for(started.wait(), 1)
    assert not app["bundled_runtime_startup_task"].done()
    release.set()
    await app["bundled_runtime_startup_task"]
    await _cancel_bundled_runtime_startup(app)
