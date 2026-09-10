from __future__ import annotations

import sys
from unittest.mock import AsyncMock

from mona.agent.tools.context import PROJECT_WORKSPACE_META, RequestContext
from mona.agent.tools.shell import ExecTool
from mona.runtime.project_env import ProjectRuntimeError, ProjectRuntimeResolution


async def test_exec_injects_project_runtime_environment(tmp_path, monkeypatch) -> None:
    from mona.runtime import project_env

    project = tmp_path / "project"
    project.mkdir()

    async def prepare(self, command, *, cwd, workspace_root, base_env):
        del self, command, workspace_root
        return ProjectRuntimeResolution(
            env={**base_env, "MONA_PROJECT_PYTHON": "managed-python"},
            project_root=cwd,
        )

    monkeypatch.setattr(project_env.ProjectEnvironmentManager, "prepare", prepare)
    process = AsyncMock()
    process.communicate.return_value = (b"ok", b"")
    process.returncode = 0
    captured = {}

    async def spawn(self, command, cwd, env, shell_program=None, login=True):
        del self, shell_program, login
        captured.update(command=command, cwd=cwd, env=env)
        return process

    monkeypatch.setattr(ExecTool, "_spawn", spawn)
    tool = ExecTool(working_dir=str(project), restrict_to_workspace=True)

    output = await tool.execute(command="python app.py")

    assert "Exit code: 0" in output
    assert captured["env"]["MONA_PROJECT_PYTHON"] == "managed-python"
    assert captured["cwd"] == str(project)


async def test_exec_uses_shared_agent_environment_for_non_project_tasks(
    tmp_path,
    monkeypatch,
) -> None:
    from mona.runtime import agent_env, project_env

    async def prepare_command(self, command, *, base_env):
        del self, command
        return {**base_env, "MONA_EXECUTION_SCOPE": "agent"}

    monkeypatch.setattr(agent_env.AgentEnvironmentManager, "prepare_command", prepare_command)
    project_prepare = AsyncMock()
    monkeypatch.setattr(project_env.ProjectEnvironmentManager, "prepare", project_prepare)
    process = AsyncMock()
    process.communicate.return_value = (b"ok", b"")
    process.returncode = 0
    captured = {}

    async def spawn(self, command, cwd, env, shell_program=None, login=True):
        del self, command, cwd, shell_program, login
        captured.update(env)
        return process

    monkeypatch.setattr(ExecTool, "_spawn", spawn)

    output = await ExecTool(
        working_dir=str(tmp_path),
        use_agent_runtime=True,
    ).execute(command="pip install requests")

    assert "Exit code: 0" in output
    assert captured["MONA_EXECUTION_SCOPE"] == "agent"
    project_prepare.assert_not_called()


async def test_exec_rejects_explicit_system_runtime_in_agent_scope(
    tmp_path,
    monkeypatch,
) -> None:
    spawn = AsyncMock()
    monkeypatch.setattr(ExecTool, "_spawn", spawn)
    command = (
        '"C:\\Program Files\\Python\\python.exe" task.py'
        if sys.platform == "win32"
        else "/usr/bin/python3 task.py"
    )

    output = await ExecTool(
        working_dir=str(tmp_path),
        use_agent_runtime=True,
    ).execute(command=command)

    assert "cannot select a system Python or Node path" in output
    spawn.assert_not_called()


def test_exec_runtime_scope_follows_each_session_context(tmp_path) -> None:
    tool = ExecTool(working_dir=str(tmp_path), use_agent_runtime=False)

    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="agent-task",
            metadata={PROJECT_WORKSPACE_META: False},
        )
    )
    assert tool.use_agent_runtime is True

    tool.set_context(
        RequestContext(
            channel="websocket",
            chat_id="project-task",
            metadata={PROJECT_WORKSPACE_META: True},
        )
    )
    assert tool.use_agent_runtime is False


async def test_non_runtime_exec_does_not_prepare_project_environment(
    tmp_path,
    monkeypatch,
) -> None:
    from mona.runtime import project_env

    prepare = AsyncMock()
    monkeypatch.setattr(project_env.ProjectEnvironmentManager, "prepare", prepare)
    process = AsyncMock()
    process.communicate.return_value = (b"ok", b"")
    process.returncode = 0
    monkeypatch.setattr(ExecTool, "_spawn", AsyncMock(return_value=process))

    await ExecTool(working_dir=str(tmp_path)).execute(command="git status")

    prepare.assert_not_called()


async def test_exec_does_not_fall_back_when_project_runtime_prepare_fails(
    tmp_path,
    monkeypatch,
) -> None:
    from mona.runtime import project_env

    async def prepare(self, command, *, cwd, workspace_root, base_env):
        del self, command, cwd, workspace_root, base_env
        raise ProjectRuntimeError("managed Python is unavailable")

    spawn = AsyncMock()
    monkeypatch.setattr(project_env.ProjectEnvironmentManager, "prepare", prepare)
    monkeypatch.setattr(ExecTool, "_spawn", spawn)

    output = await ExecTool(working_dir=str(tmp_path)).execute(command="python app.py")

    assert "managed Python is unavailable" in output
    spawn.assert_not_called()
