from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import textwrap
from pathlib import Path

import pytest

from mona.runtime.project_env import ProjectEnvironmentManager, ProjectRuntimeError


def _heartbeat_command(ready: Path, heartbeat: Path) -> list[str]:
    script = textwrap.dedent(
        f"""
        import os
        import time
        from pathlib import Path

        ready = Path({json.dumps(str(ready))})
        heartbeat = Path({json.dumps(str(heartbeat))})
        ready.write_text(str(os.getpid()), encoding="ascii")
        while True:
            heartbeat.write_text(str(time.monotonic_ns()), encoding="ascii")
            time.sleep(0.03)
        """
    )
    return [sys.executable, "-I", "-c", script]


async def _wait_for_file(path: Path) -> None:
    async with asyncio.timeout(5):
        while not path.is_file():
            await asyncio.sleep(0.01)


async def _assert_reaped(ready: Path, heartbeat: Path) -> None:
    assert ready.is_file()
    heartbeat_after_cleanup = heartbeat.read_text(encoding="ascii")
    await asyncio.sleep(0.15)
    assert heartbeat.read_text(encoding="ascii") == heartbeat_after_cleanup


async def _cleanup_test_process(ready: Path, heartbeat: Path) -> None:
    if not ready.is_file() or not heartbeat.is_file():
        return
    heartbeat_before_cleanup = heartbeat.read_text(encoding="ascii")
    await asyncio.sleep(0.15)
    if heartbeat.read_text(encoding="ascii") != heartbeat_before_cleanup:
        os.kill(int(ready.read_text(encoding="ascii")), signal.SIGTERM)


async def test_cancelling_project_environment_creation_kills_child_and_removes_staging(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    ready = tmp_path / "ready.txt"
    heartbeat = tmp_path / "heartbeat.txt"
    manager = ProjectEnvironmentManager(tmp_path / "runtimes", timeout_seconds=20)

    async def no_runtime_download(_refs: list[str]) -> None:
        return None

    async def run_controlled_process(_command: list[str], *, cwd: Path) -> tuple[int, str, str]:
        return await manager._run(_heartbeat_command(ready, heartbeat), cwd=cwd)

    monkeypatch.setattr(manager, "_ensure_packs", no_runtime_download)
    monkeypatch.setattr(manager, "_entrypoint", lambda _component, _name: Path(sys.executable))
    manager.runner = run_controlled_process
    request = asyncio.create_task(
        manager.prepare(
            "python app.py",
            cwd=project,
            workspace_root=project,
            base_env={"PATH": os.environ.get("PATH", "")},
        )
    )
    try:
        await _wait_for_file(ready)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request

        assert list(project.glob(".mona-venv-*")) == []
        await _assert_reaped(ready, heartbeat)
    finally:
        if not request.done():
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
        await _cleanup_test_process(ready, heartbeat)


async def test_project_environment_process_timeout_kills_and_reaps_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ready = tmp_path / "ready.txt"
    heartbeat = tmp_path / "heartbeat.txt"
    manager = ProjectEnvironmentManager(tmp_path / "runtimes", timeout_seconds=0.3)

    try:
        with pytest.raises(ProjectRuntimeError, match=r"0\.3"):
            await asyncio.wait_for(
                manager._run(_heartbeat_command(ready, heartbeat), cwd=tmp_path), timeout=4
            )

        await _assert_reaped(ready, heartbeat)
    finally:
        await _cleanup_test_process(ready, heartbeat)


async def test_venv_creation_ignores_project_venv_py_trap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    (project / "pyproject.toml").write_text("[project]\nname='demo'\n", encoding="utf-8")
    marker = tmp_path / "project-venv-module-loaded.txt"
    (project / "venv.py").write_text(
        "from pathlib import Path\n"
        f"Path({json.dumps(str(marker))}).write_text('loaded', encoding='ascii')\n",
        encoding="utf-8",
    )
    manager = ProjectEnvironmentManager(tmp_path / "runtimes", timeout_seconds=20)

    async def no_runtime_download(_refs: list[str]) -> None:
        return None

    async def create_without_pip(command: list[str], *, cwd: Path) -> tuple[int, str, str]:
        assert command[1:3] == ["-I", "-m"]
        return await manager._run([*command, "--without-pip"], cwd=cwd)

    monkeypatch.setattr(manager, "_ensure_packs", no_runtime_download)
    monkeypatch.setattr(manager, "_entrypoint", lambda _component, _name: Path(sys.executable))
    manager.runner = create_without_pip

    result = await manager.prepare(
        "python app.py",
        cwd=project,
        workspace_root=project,
        base_env={"PATH": os.environ.get("PATH", "")},
    )

    assert result.python is not None and result.python.is_file()
    assert not marker.exists()
