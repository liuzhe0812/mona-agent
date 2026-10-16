from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import signal
import subprocess
import sys

import pytest

from mona.agent.tools.shell import ExecToolConfig
from mona.development.coding import CodingTools
from mona.development.contracts import PermissionMode


def _python_command(code: str) -> str:
    if sys.platform == "win32":
        return f"{subprocess.list2cmdline([sys.executable])} -u -c {subprocess.list2cmdline([code])}"
    return f"{shlex.quote(sys.executable)} -u -c {shlex.quote(code)}"


def _session_id(output: str) -> str:
    match = re.search(r"session_id:\s*([0-9a-f]+)", output)
    assert match, output
    return match.group(1)


async def _allow_all(_name: str, _arguments: dict) -> str:
    return "accept"


def _coding_tools(root, session_key: str) -> CodingTools:
    tools = CodingTools(root, session_key, ExecToolConfig(timeout=30))
    tools.configure_permissions(PermissionMode.FULL_ACCESS, _allow_all)
    return tools


@pytest.mark.asyncio
async def test_code_exec_yields_persistent_http_server_without_explicit_yield_time(tmp_path):
    session_key = "code-http-server"
    tools = _coding_tools(tmp_path, session_key)
    ready_file = tmp_path / "http-server-ready.txt"
    ready_literal = json.dumps(str(ready_file))
    command = _python_command(
        "from http.server import BaseHTTPRequestHandler, HTTPServer; "
        "from pathlib import Path; import os; "
        "Handler = type('Handler', (BaseHTTPRequestHandler,), {"
        "'do_GET': lambda self: (self.send_response(200), self.end_headers(), "
        "self.wfile.write(b'server-alive')), 'log_message': lambda self, *args: None}); "
        f"server = HTTPServer(('127.0.0.1', 0), Handler); "
        f"Path({ready_literal}).write_text(str(server.server_address[1]) + ' ' + str(os.getpid()), encoding='ascii'); "
        "server.serve_forever()"
    )
    try:
        async with asyncio.timeout(3):
            output = await tools.registry.execute("exec", {"command": command})
        session_id = _session_id(output)

        async with asyncio.timeout(3):
            while not ready_file.exists():
                await asyncio.sleep(0.01)
        port, pid = map(int, ready_file.read_text(encoding="ascii").split())
        reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), timeout=3)
        writer.write(b"GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        await writer.drain()
        response = await asyncio.wait_for(reader.read(), timeout=3)
        writer.close()
        await writer.wait_closed()
        assert response.startswith(b"HTTP/1.0 200")
        assert response.endswith(b"server-alive")

        polled = await tools.registry.execute(
            "write_stdin", {"session_id": session_id, "chars": "", "yield_time_ms": 0},
        )
        assert _session_id(polled) == session_id
        assert "Process running" in polled

        terminated = await tools.registry.execute(
            "write_stdin", {"session_id": session_id, "terminate": True, "yield_time_ms": 0},
        )
        assert "Session terminated." in terminated
        assert "Exit code:" in terminated
        assert await tools.exec_sessions.list() == []

        with pytest.raises(OSError):
            await asyncio.wait_for(asyncio.open_connection("127.0.0.1", port), timeout=2)
    finally:
        await tools.exec_sessions.cancel_by_session(session_key)
        if ready_file.exists():
            port, pid = map(int, ready_file.read_text(encoding="ascii").split())
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", port),
                    timeout=0.5,
                )
            except OSError:
                pass
            else:
                writer.close()
                await writer.wait_closed()
                try:
                    os.kill(pid, signal.SIGTERM)
                except (ProcessLookupError, ValueError):
                    pass


@pytest.mark.asyncio
async def test_code_exec_short_command_returns_output_and_exit_code_without_session(tmp_path):
    session_key = "code-short-command"
    tools = _coding_tools(tmp_path, session_key)
    command = _python_command("print('short-command-output'); raise SystemExit(7)")

    try:
        async with asyncio.timeout(3):
            output = await tools.registry.execute("exec", {"command": command})

        assert "short-command-output" in output
        assert "Exit code: 7" in output
        assert "session_id:" not in output
        assert await tools.exec_sessions.list() == []
    finally:
        await tools.exec_sessions.cancel_by_session(session_key)


@pytest.mark.asyncio
async def test_cancelling_initial_code_exec_kills_process_before_session_id_returns(tmp_path):
    session_key = "code-cancel-start"
    tools = _coding_tools(tmp_path, session_key)
    ready_file = tmp_path / "process-started.txt"
    heartbeat_file = tmp_path / "process-heartbeat.txt"
    heartbeat_loop = (
        "while True:\n"
        "    heartbeat.write_text(str(time.monotonic_ns()), encoding='ascii')\n"
        "    ready.write_text(str(os.getpid()), encoding='ascii')\n"
        "    time.sleep(0.05)\n"
    )
    command = _python_command(
        "from pathlib import Path; import os, time; "
        f"heartbeat = Path({json.dumps(str(heartbeat_file))}); "
        f"ready = Path({json.dumps(str(ready_file))}); "
        f"exec({heartbeat_loop!r})"
    )
    request = asyncio.create_task(
        tools.registry.execute("exec", {"command": command, "yield_time_ms": 30_000}),
    )
    try:
        async with asyncio.timeout(5):
            while not ready_file.exists():
                await asyncio.sleep(0.01)

        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request

        heartbeat_after_cancel = heartbeat_file.read_text(encoding="ascii")
        await asyncio.sleep(0.25)
        assert heartbeat_file.read_text(encoding="ascii") == heartbeat_after_cancel
        assert await tools.exec_sessions.list() == []
    finally:
        if not request.done():
            request.cancel()
            await asyncio.gather(request, return_exceptions=True)
        await tools.exec_sessions.cancel_by_session(session_key)
        if ready_file.exists():
            heartbeat_after_cleanup = heartbeat_file.read_text(encoding="ascii")
            await asyncio.sleep(0.2)
            if heartbeat_file.read_text(encoding="ascii") != heartbeat_after_cleanup:
                # The child process wrote its own PID to this temp file, and a
                # changing heartbeat proves that exact test process is alive.
                try:
                    os.kill(int(ready_file.read_text(encoding="ascii")), signal.SIGTERM)
                except (ProcessLookupError, ValueError):
                    pass
