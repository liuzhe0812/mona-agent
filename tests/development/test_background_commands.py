from __future__ import annotations

import asyncio
import re
import shlex
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import pytest

from mona.agent.tools.shell import ExecToolConfig
from mona.development.coding import CodingTools
from mona.development.contracts import ExecutorId, PermissionMode
from tests.development.test_workbench_api import AUTH, setup_client


def _python_command(code: str) -> str:
    if sys.platform == "win32":
        return f"{subprocess.list2cmdline([sys.executable])} -u -c {subprocess.list2cmdline([code])}"
    return f"{shlex.quote(sys.executable)} -u -c {shlex.quote(code)}"


def _session_id(output: str) -> str:
    match = re.search(r"session_id:\s*([0-9a-f]+)", output)
    assert match, output
    return match.group(1)


async def _accept(_name: str, _arguments: dict) -> str:
    return "accept"


def _attach_code_tools(runtime, root: Path, session, *, readonly: bool = False) -> CodingTools:
    tools = CodingTools(root, session.transcript_key, ExecToolConfig(timeout=30), readonly=readonly)
    if not readonly:
        tools.configure_permissions(PermissionMode.FULL_ACCESS, _accept)
    runtime.tools[session.id] = tools
    return tools


def _command_path(session_id: str, command_id: str) -> str:
    return f"/api/development/sessions/{session_id}/commands/{command_id}"


@pytest.mark.asyncio
async def test_background_snapshot_and_inspection_leave_model_output_available(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    session = runtime.store.create_session(project.id, permission_mode=PermissionMode.FULL_ACCESS)
    tools = _attach_code_tools(runtime, root, session)
    gate = tmp_path / "release-output.txt"
    pid_file = tmp_path / "command-pid.txt"
    command = _python_command(
        "from pathlib import Path; import os, time; "
        f"gate = Path({str(gate)!r}); "
        f"pid_file = Path({str(pid_file)!r}); pid_file.write_text(str(os.getpid()), encoding='ascii'); "
        "exec('while not gate.exists():\\n    time.sleep(0.01)'); "
        "print('output-after-yield', flush=True); time.sleep(20)"
    )
    execution = None
    command_id = None
    try:
        execution = asyncio.create_task(tools.registry.execute("exec", {"command": command}))
        await asyncio.sleep(0.1)
        assert not execution.done()
        assert (await client.get(
            f"/api/development/sessions/{session.id}/snapshot", headers=AUTH,
        )).status == 200
        before_yield = await (await client.get(
            f"/api/development/sessions/{session.id}/snapshot", headers=AUTH,
        )).json()
        assert before_yield["backgroundCommands"] == []

        initial_output = await asyncio.wait_for(execution, timeout=4)
        command_id = _session_id(initial_output)
        assert "output-after-yield" not in initial_output
        gate.write_text("go", encoding="ascii")

        snapshot = await (await client.get(
            f"/api/development/sessions/{session.id}/snapshot", headers=AUTH,
        )).json()
        assert len(snapshot["backgroundCommands"]) == 1
        listed = snapshot["backgroundCommands"][0]
        assert listed["id"] == command_id
        assert "while not gate.exists()" in listed["command"]
        assert listed["cwd"] == str(root.resolve())
        assert datetime.fromisoformat(listed["startedAt"])
        assert listed["elapsedSeconds"] >= 0
        assert listed["status"] == "running" and listed["exitCode"] is None

        path = _command_path(session.id, command_id)
        assert (await client.get(path)).status == 401

        async with asyncio.timeout(3):
            while True:
                response = await client.get(path, headers=AUTH)
                detail = await response.json()
                if "output-after-yield" in detail.get("output", ""):
                    break
                await asyncio.sleep(0.02)
        assert response.status == 200
        observed_pid = pid_file.read_text(encoding="ascii")
        assert observed_pid.isdigit()
        repeated = await (await client.get(path, headers=AUTH)).json()
        assert repeated["output"] == detail["output"]
        assert repeated["truncated"] is False
        assert pid_file.read_text(encoding="ascii") == observed_pid

        polled = await tools.registry.execute(
            "write_stdin", {"session_id": command_id, "chars": "", "yield_time_ms": 0},
        )
        assert "output-after-yield" in polled
        assert pid_file.read_text(encoding="ascii") == observed_pid
    finally:
        if execution is not None and not execution.done():
            execution.cancel()
            await asyncio.gather(execution, return_exceptions=True)
        await tools.exec_sessions.cancel_by_session(session.transcript_key)
        await client.close()


@pytest.mark.asyncio
async def test_background_stop_is_session_scoped_and_native_sessions_are_not_projected(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    first = runtime.store.create_session(project.id, permission_mode=PermissionMode.FULL_ACCESS)
    second = runtime.store.create_session(project.id, permission_mode=PermissionMode.FULL_ACCESS)
    readonly = runtime.store.create_session(project.id, readonly=True)
    native = runtime.store.create_session(project.id, ExecutorId.CODEX)
    first_tools = _attach_code_tools(runtime, root, first)
    second_tools = _attach_code_tools(runtime, root, second)
    _attach_code_tools(runtime, root, readonly, readonly=True)
    command = _python_command("import time; print('owned-process', flush=True); time.sleep(20)")
    first_id = second_id = None
    try:
        first_id = _session_id(await first_tools.registry.execute(
            "exec", {"command": command, "yield_time_ms": 0},
        ))
        second_id = _session_id(await second_tools.registry.execute(
            "exec", {"command": command, "yield_time_ms": 0},
        ))

        wrong_session = await client.post(
            _command_path(second.id, first_id) + "/stop", headers=AUTH,
        )
        assert wrong_session.status == 404
        first_after_wrong_stop = await client.get(_command_path(first.id, first_id), headers=AUTH)
        assert first_after_wrong_stop.status == 200
        assert (await first_after_wrong_stop.json())["status"] == "running"

        readonly_stop = await client.post(
            _command_path(readonly.id, first_id) + "/stop", headers=AUTH,
        )
        assert readonly_stop.status == 422

        native_snapshot = await (await client.get(
            f"/api/development/sessions/{native.id}/snapshot", headers=AUTH,
        )).json()
        assert native_snapshot["backgroundCommands"] == []
        native_detail = await client.get(_command_path(native.id, first_id), headers=AUTH)
        assert native_detail.status == 404

        stopped = await client.post(
            _command_path(first.id, first_id) + "/stop", headers=AUTH,
        )
        assert stopped.status == 200
        stopped_detail = await stopped.json()
        assert stopped_detail["id"] == first_id
        assert stopped_detail["status"] == "terminated"
        assert stopped_detail["exitCode"] is not None

        other = await (await client.get(_command_path(second.id, second_id), headers=AUTH)).json()
        assert other["status"] == "running"
        second_stopped = await client.post(
            _command_path(second.id, second_id) + "/stop", headers=AUTH,
        )
        assert second_stopped.status == 200
        assert (await second_stopped.json())["status"] == "terminated"
    finally:
        await asyncio.gather(
            first_tools.exec_sessions.cancel_by_session(first.transcript_key),
            second_tools.exec_sessions.cancel_by_session(second.transcript_key),
        )
        await client.close()


@pytest.mark.asyncio
async def test_exited_background_command_remains_inspectable_with_bounded_output(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    session = runtime.store.create_session(project.id, permission_mode=PermissionMode.FULL_ACCESS)
    tools = _attach_code_tools(runtime, root, session)
    command = _python_command(
        "import time; print('x' * 60000, flush=True); print('recent-output-tail', flush=True); time.sleep(1.5); raise SystemExit(7)"
    )
    command_id = None
    try:
        initial_output = await tools.registry.execute(
            "exec", {"command": command, "yield_time_ms": 0},
        )
        command_id = _session_id(initial_output)
        path = _command_path(session.id, command_id)

        async with asyncio.timeout(5):
            while True:
                response = await client.get(path, headers=AUTH)
                detail = await response.json()
                if detail.get("status") == "exited":
                    break
                await asyncio.sleep(0.03)
        assert response.status == 200
        assert detail["exitCode"] == 7
        assert "recent-output-tail" in detail["output"]
        assert len(detail["output"]) <= 50_000
        assert detail["truncated"] is True

        model_poll = await tools.registry.execute(
            "write_stdin", {"session_id": command_id, "chars": "", "yield_time_ms": 0},
        )
        assert "recent-output-tail" in model_poll and "Exit code: 7" in model_poll
        after_model_cleanup = await (await client.get(path, headers=AUTH)).json()
        assert after_model_cleanup["status"] == "exited"
        assert after_model_cleanup["output"] == detail["output"]
        assert after_model_cleanup["truncated"] is True
    finally:
        await tools.exec_sessions.cancel_by_session(session.transcript_key)
        await client.close()
