"""Explicit Work tools: nothing is discovered from desktop plugins or user configuration."""
from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from mona.agent.tools.base import Tool
from mona.agent.tools.registry import ToolRegistry
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.public_web import fetch_public_text
from mona.hosted_work.sandbox import DockerSandbox, SandboxError


class HostedTool(Tool):
    def __init__(self, name: str, description: str, properties: dict, required: list[str],
                 callback: Callable[..., Awaitable[Any]]):
        self._name, self._description = name, description
        self._parameters = {"type": "object", "properties": properties, "required": required,
                            "additionalProperties": False}
        self.callback = callback

    @property
    def name(self):
        return self._name

    @property
    def description(self):
        return self._description

    @property
    def parameters(self):
        return self._parameters

    async def execute(self, **kwargs):
        if set(kwargs) - set(self.parameters["properties"]):
            return "Error: Unsupported tool parameters."
        return await self.callback(**kwargs)


class HostedTools:
    def __init__(self, sandbox: DockerSandbox, emit: Callable[[str, dict], Awaitable[None]]):
        self.sandbox, self.emit = sandbox, emit
        self.fault: str | None = None
        self.registry = ToolRegistry()
        text = {"type": "string", "minLength": 1, "maxLength": 1024}
        definitions = [
            ("list_dir", "List the current user's isolated workspace. No host or other user's files are accessible.",
             {"path": text}, [], self.list_dir),
            ("read_file", "Read a UTF-8 workspace file. Use the returned next_offset to continue a truncated read.",
             {"path": text, "offset": {"type": "integer", "minimum": 0}}, ["path"], self.read_file),
            ("write_file", "Create or replace a UTF-8 workspace file. Existing files require expected_sha256 from a prior read.",
             {"path": text, "content": {"type": "string", "maxLength": 200000},
              "expected_sha256": {"type": "string", "pattern": "^[a-f0-9]{64}$"}},
             ["path", "content"], self.write_file),
            ("exec", "Execute a shell command inside the user's isolated Linux workspace. No network, host files, credentials, or desktop access. Installed Python/system libraries are read-only.",
             {"command": {"type": "string", "minLength": 1, "maxLength": 32000}}, ["command"], self.execute),
            ("web_fetch", "Read a public webpage as untrusted reference text. Private networks, credentials, arbitrary ports, and network writes are blocked.",
             {"url": {"type": "string", "minLength": 1, "maxLength": 4096}}, ["url"], self.web_fetch),
            ("deliver_file", "Offer an existing regular workspace file to the user for download; the saved content is verified before publication.",
             {"path": text}, ["path"], self.deliver_file),
        ]
        for name, description, properties, required, callback in definitions:
            self.registry.register(HostedTool(name, description, properties, required, callback))
        self.registry.set_allowed_tool_names({item[0] for item in definitions})

    async def _file(self, action: str, **kwargs):
        try:
            return await self.sandbox.file({"action": action, **kwargs})
        except (SandboxError, TimeoutError) as exc:
            self.fault = "工作区操作未能安全完成，已停止本轮；请核对已有文件后继续。"
            # ToolRegistry catches Exception; cancellation deliberately stops the
            # turn instead of giving the model permission to repeat unknown writes.
            raise asyncio.CancelledError(self.fault) from exc

    async def list_dir(self, path: str = "."):
        return json.dumps(await self._file("list", path=path), ensure_ascii=False)

    async def read_file(self, path: str, offset: int = 0):
        return json.dumps(await self._file("read", path=path, offset=offset), ensure_ascii=False)

    async def write_file(self, path: str, content: str, expected_sha256: str | None = None):
        return json.dumps(await self._file("write", path=path, content=content,
                                          expected_sha256=expected_sha256), ensure_ascii=False)

    async def execute(self, command: str):
        try:
            return json.dumps(await self.sandbox.execute(command), ensure_ascii=False)
        except (SandboxError, TimeoutError) as exc:
            self.fault = "工作区命令已停止等待，已中止本轮并核对隔离进程；不要自动重跑该命令。"
            raise asyncio.CancelledError(self.fault) from exc

    async def web_fetch(self, url: str):
        try:
            return json.dumps(await fetch_public_text(url), ensure_ascii=False)
        except WorkError as exc:
            return "Error: " + exc.message

    async def deliver_file(self, path: str):
        metadata = await self._file("stat", path=path)
        await self.emit("artifact", metadata)
        return json.dumps({"offered": True, **metadata}, ensure_ascii=False)
