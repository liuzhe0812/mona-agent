from __future__ import annotations

import asyncio
import sys
from typing import Any

from mona.agent.tools.base import Tool, tool_parameters
from mona.agent.tools.schema import IntegerSchema, StringSchema, tool_parameters_schema

_IS_WINDOWS = sys.platform == "win32"
_DEV_NULL = "NUL" if _IS_WINDOWS else "/dev/null"

_VALID_ACTIONS = ("list", "download", "upload", "mkdir", "rm", "rename", "stat")


@tool_parameters(
    tool_parameters_schema(
        host=StringSchema("SFTP server hostname or IP address"),
        action=StringSchema(
            "Action to perform: list, download, upload, mkdir, rm, rename, stat"
        ),
        path=StringSchema("Remote file or directory path"),
        username=StringSchema("SFTP username", nullable=True),
        port=IntegerSchema(22, description="SFTP port number", minimum=1, maximum=65535, nullable=True),
        local_path=StringSchema("Local file path for download/upload operations", nullable=True),
        new_path=StringSchema("New path for rename operation", nullable=True),
        timeout=IntegerSchema(
            30,
            description="Connection timeout in seconds",
            minimum=1,
            maximum=300,
            nullable=True,
        ),
        private_key_path=StringSchema("Path to SSH private key file", nullable=True),
        required=["host", "action", "path"],
    )
)
class SFTPTool(Tool):
    _scopes = {"core", "subagent"}
    config_key = "sftp"

    @property
    def name(self) -> str:
        return "sftp"

    @property
    def description(self) -> str:
        return (
            "Perform SFTP file operations on a remote server. "
            "Supported actions: list (directory listing), download (remote to local), "
            "upload (local to remote), mkdir (create directory), rm (remove file), "
            "rename (move/rename file), stat (file metadata)."
        )

    @property
    def read_only(self) -> bool:
        return False

    async def execute(
        self,
        host: str,
        action: str,
        path: str,
        username: str | None = None,
        port: int = 22,
        local_path: str | None = None,
        new_path: str | None = None,
        timeout: int = 30,
        private_key_path: str | None = None,
        **kwargs: Any,
    ) -> str:
        if action not in _VALID_ACTIONS:
            return f"Error: Invalid action '{action}'. Must be one of: {', '.join(_VALID_ACTIONS)}"

        handler = {
            "list": self._list,
            "download": self._download,
            "upload": self._upload,
            "mkdir": self._mkdir,
            "rm": self._rm,
            "rename": self._rename,
            "stat": self._stat,
        }[action]

        return await handler(
            host=host,
            path=path,
            username=username,
            port=port,
            local_path=local_path,
            new_path=new_path,
            timeout=timeout,
            private_key_path=private_key_path,
        )

    async def _run_ssh_command(
        self,
        host: str,
        command: str,
        username: str | None,
        port: int,
        timeout: int,
        private_key_path: str | None,
    ) -> tuple[int, str, str]:
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

        process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=timeout,
        )
        return (
            process.returncode or 0,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )

    async def _run_sftp_batch(
        self,
        host: str,
        commands: list[str],
        username: str | None,
        port: int,
        timeout: int,
        private_key_path: str | None,
    ) -> tuple[int, str, str]:
        args = ["sftp"]
        args.extend(["-o", "StrictHostKeyChecking=no"])
        args.extend(["-o", f"UserKnownHostsFile={_DEV_NULL}"])
        args.extend(["-o", f"ConnectTimeout={timeout}"])
        if port != 22:
            args.extend(["-P", str(port)])
        if private_key_path:
            args.extend(["-i", private_key_path])
        args.extend(["-b", "-"])
        target = f"{username}@{host}" if username else host
        args.append(target)

        batch_input = "\n".join(commands) + "\n"
        process = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(
            process.communicate(input=batch_input.encode()),
            timeout=timeout,
        )
        return (
            process.returncode or 0,
            stdout.decode("utf-8", errors="replace"),
            stderr.decode("utf-8", errors="replace"),
        )

    async def _list(
        self,
        host: str,
        path: str,
        username: str | None,
        port: int,
        timeout: int,
        **kwargs: Any,
    ) -> str:
        rc, stdout, stderr = await self._run_ssh_command(
            host, f"ls -la {path}", username, port, timeout, kwargs.get("private_key_path"),
        )
        if rc != 0 and stderr.strip():
            return f"Error listing directory: {stderr.strip()}"
        return stdout.strip() if stdout.strip() else f"(empty directory: {path})"

    async def _download(
        self,
        host: str,
        path: str,
        username: str | None,
        port: int,
        timeout: int,
        local_path: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not local_path:
            return "Error: local_path is required for download operation"
        rc, _, stderr = await self._run_sftp_batch(
            host,
            [f"get {path} {local_path}"],
            username,
            port,
            timeout,
            kwargs.get("private_key_path"),
        )
        if rc != 0 and stderr.strip():
            return f"Error downloading file: {stderr.strip()}"
        return f"Downloaded {path} -> {local_path}"

    async def _upload(
        self,
        host: str,
        path: str,
        username: str | None,
        port: int,
        timeout: int,
        local_path: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not local_path:
            return "Error: local_path is required for upload operation"
        rc, _, stderr = await self._run_sftp_batch(
            host,
            [f"put {local_path} {path}"],
            username,
            port,
            timeout,
            kwargs.get("private_key_path"),
        )
        if rc != 0 and stderr.strip():
            return f"Error uploading file: {stderr.strip()}"
        return f"Uploaded {local_path} -> {path}"

    async def _mkdir(
        self,
        host: str,
        path: str,
        username: str | None,
        port: int,
        timeout: int,
        **kwargs: Any,
    ) -> str:
        rc, _, stderr = await self._run_sftp_batch(
            host,
            [f"mkdir {path}"],
            username,
            port,
            timeout,
            kwargs.get("private_key_path"),
        )
        if rc != 0 and stderr.strip():
            return f"Error creating directory: {stderr.strip()}"
        return f"Created directory: {path}"

    async def _rm(
        self,
        host: str,
        path: str,
        username: str | None,
        port: int,
        timeout: int,
        **kwargs: Any,
    ) -> str:
        rc, _, stderr = await self._run_sftp_batch(
            host,
            [f"rm {path}"],
            username,
            port,
            timeout,
            kwargs.get("private_key_path"),
        )
        if rc != 0 and stderr.strip():
            return f"Error removing file: {stderr.strip()}"
        return f"Removed: {path}"

    async def _rename(
        self,
        host: str,
        path: str,
        username: str | None,
        port: int,
        timeout: int,
        new_path: str | None = None,
        **kwargs: Any,
    ) -> str:
        if not new_path:
            return "Error: new_path is required for rename operation"
        rc, _, stderr = await self._run_sftp_batch(
            host,
            [f"rename {path} {new_path}"],
            username,
            port,
            timeout,
            kwargs.get("private_key_path"),
        )
        if rc != 0 and stderr.strip():
            return f"Error renaming: {stderr.strip()}"
        return f"Renamed: {path} -> {new_path}"

    async def _stat(
        self,
        host: str,
        path: str,
        username: str | None,
        port: int,
        timeout: int,
        **kwargs: Any,
    ) -> str:
        rc, stdout, stderr = await self._run_ssh_command(
            host, f"stat {path}", username, port, timeout, kwargs.get("private_key_path"),
        )
        if rc != 0 and stderr.strip():
            return f"Error getting file info: {stderr.strip()}"
        return stdout.strip()
