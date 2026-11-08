"""Hosted command deadlines match the desktop contract inside the sandbox."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from mona.agent.tools.shell import ExecTool, ExecToolConfig
from mona.config.schema import HostedWorkConfig
from mona.hosted_work import sandbox as sandbox_module
from mona.hosted_work.contracts import owner_key
from mona.hosted_work.sandbox import DockerSandbox, SandboxError
from mona.hosted_work.tools import HostedTools


@pytest.mark.asyncio
async def test_command_deadline_is_independent_of_file_transport_timeout(tmp_path):
    config = HostedWorkConfig(tool_timeout_seconds=1)
    sandbox = DockerSandbox(config, owner_key("1"), "a" * 32, tmp_path / "workspace.zip")
    sandbox.started = True
    sandbox._invoke = AsyncMock(return_value=(0, b"finished"))

    for timeout in (None, 600, 1800):
        assert await sandbox.execute("printf finished", timeout=timeout) == {"exit_code": 0, "output": "finished"}
        call = sandbox._invoke.await_args
        assert call.args[0] == ["exec", "--workdir=/workspace", sandbox.name, "/bin/sh", "-c",
                                'exec /bin/sh -c "$1" 2>&1', "mona-hosted", "printf finished"]
        assert call.kwargs["timeout"] == (ExecToolConfig().timeout if timeout is None else timeout)
    before = sandbox._invoke.await_count
    for invalid in (True, 0, 1801):
        with pytest.raises(SandboxError):
            await sandbox.execute("printf finished", timeout=invalid)
    assert sandbox._invoke.await_count == before


@pytest.mark.asyncio
async def test_command_output_does_not_include_docker_client_diagnostics(tmp_path, monkeypatch):
    stdout, stderr = asyncio.StreamReader(), asyncio.StreamReader()
    stdout.feed_data(b"standard output; command error")
    stdout.feed_eof()
    stderr.feed_data(b"docker-host-diagnostic")
    stderr.feed_eof()
    process = SimpleNamespace(stdout=stdout, stderr=stderr, stdin=SimpleNamespace(close=lambda: None),
                              returncode=7, wait=AsyncMock(return_value=7))
    monkeypatch.setattr(sandbox_module, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(sandbox_module.asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    sandbox = DockerSandbox(HostedWorkConfig(), owner_key("1"), "a" * 32, tmp_path / "workspace.zip")
    sandbox.docker, sandbox.started = "docker", True
    reply = await sandbox.execute("example")
    assert reply == {"exit_code": 7, "output": "standard output; command error"}
    assert "docker-host-diagnostic" not in str(reply)


@pytest.mark.asyncio
async def test_model_can_choose_desktop_exec_deadline_but_not_exceed_its_limit():
    config = HostedWorkConfig()
    sandbox = SimpleNamespace(config=config, execute=AsyncMock(return_value={"exit_code": 0, "output": "done"}))
    tools = HostedTools(sandbox, AsyncMock())
    tool = tools.registry.get("exec")
    spec = tool.parameters["properties"]["timeout"]
    assert spec["minimum"] == 1 and spec["maximum"] == ExecTool._MAX_TIMEOUT
    assert not tool.validate_params({"command": "true", "timeout": 600})
    assert tool.validate_params({"command": "true", "timeout": 601})
    await tool.execute(command="true", timeout=600)
    sandbox.execute.assert_awaited_once_with("true", timeout=600)


@pytest.mark.asyncio
async def test_unknown_command_timeout_stops_the_turn_without_retry():
    config = HostedWorkConfig()
    sandbox = SimpleNamespace(config=config, execute=AsyncMock(side_effect=TimeoutError("unconfirmed")))
    tools = HostedTools(sandbox, AsyncMock())
    with pytest.raises(asyncio.CancelledError):
        await tools.execute("write-something", timeout=600)
    sandbox.execute.assert_awaited_once_with("write-something", timeout=600)
    assert tools.fault and "不要自动重跑" in tools.fault


@pytest.mark.asyncio
async def test_user_stop_interrupts_long_command_before_its_deadline():
    entered = asyncio.Event()
    async def running(_command, *, timeout):
        entered.set()
        await asyncio.Event().wait()

    sandbox = SimpleNamespace(config=HostedWorkConfig(), execute=AsyncMock(side_effect=running))
    tools = HostedTools(sandbox, AsyncMock())
    task = asyncio.create_task(tools.execute("long-command", timeout=600))
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    sandbox.execute.assert_awaited_once_with("long-command", timeout=600)
    assert tools.fault is None
