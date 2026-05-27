from __future__ import annotations

import asyncio
import sys
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema

_IS_WINDOWS = sys.platform == "win32"

_DEV_NULL = "NUL" if _IS_WINDOWS else "/dev/null"


@tool_parameters(
    tool_parameters_schema(
        host=StringSchema("SSH server hostname or IP address"),
        command=StringSchema("Command to execute on the remote server"),
        username=StringSchema("SSH username", nullable=True),
        port=IntegerSchema(22, description="SSH port number", minimum=1, maximum=65535, nullable=True),
        timeout=IntegerSchema(
            30,
            description="Connection and command timeout in seconds",
            minimum=1,
            maximum=300,
            nullable=True,
        ),
        private_key_path=StringSchema("Path to SSH private key file", nullable=True),
        required=["host", "command"],
    )
)
class SSHExecTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "ssh"

    @property
    def name(self) -> str:
        return "ssh_exec"

    @property
    def description(self) -> str:
        return (
            "[DEPRECATED] Execute a command on a remote SSH server via system ssh. "
            "This tool creates a new connection each time and does not reuse existing sessions. "
            "Prefer using 'terminal_exec' instead, which reuses active SSH sessions "
            "and supports risk-based approval workflow."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        host: str,
        command: str,
        username: str | None = None,
        port: int = 22,
        timeout: int = 30,
        private_key_path: str | None = None,
        **kwargs: Any,
    ) -> str:
        ssh_cmd = self._build_command(host, command, username, port, timeout, private_key_path)
        try:
            process = await asyncio.create_subprocess_exec(
                *ssh_cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            return f"Error: SSH command timed out after {timeout} seconds"
        except FileNotFoundError:
            return (
                "Error: ssh command not found. "
                "Ensure OpenSSH client is installed and available on PATH."
            )
        except Exception as e:
            return f"Error: SSH execution failed: {e}"

        output_parts: list[str] = []
        stdout_text = stdout.decode("utf-8", errors="replace")
        if stdout_text.strip():
            output_parts.append(stdout_text)

        stderr_text = stderr.decode("utf-8", errors="replace")
        if stderr_text.strip():
            output_parts.append(f"STDERR:\n{stderr_text}")

        output_parts.append(f"Exit code: {process.returncode}")
        return "\n".join(output_parts)

    def _build_command(
        self,
        host: str,
        command: str,
        username: str | None,
        port: int,
        timeout: int,
        private_key_path: str | None,
    ) -> list[str]:
        args = ["ssh"]
        args.extend(["-o", "StrictHostKeyChecking=no"])
        args.extend(["-o", f"UserKnownHostsFile={_DEV_NULL}"])
        args.extend(["-o", f"ConnectTimeout={timeout}"])
        if port != 22:
            args.extend(["-p", str(port)])
        if private_key_path:
            args.extend(["-i", private_key_path])
        target = f"{username}@{host}" if username else host
        args.append(target)
        args.append(command)
        return args
