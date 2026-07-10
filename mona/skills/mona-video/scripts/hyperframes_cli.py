#!/usr/bin/env python3
"""Hyperframes CLI wrapper.

Wraps ``npx hyperframes`` subcommands (init / lint / validate / inspect /
render / preview) with the correct Node + npx invocation and an environment
whose PATH includes the provisioned Node and FFmpeg binaries.

Commands are executed via ``asyncio.create_subprocess_exec`` using the form
``[node_path, npx_cli_js, "hyperframes", ...]`` to sidestep Windows
``.cmd`` quoting issues.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    from mona.api.video_runtime import VideoRuntime

__all__ = ("HyperframesCLI",)


def _try_parse_json(text: str) -> Any:
    """Best-effort parse of JSON from stdout.

    Hyperframes emits a JSON object when ``--json`` is passed; if the output
    contains surrounding log lines, attempt to locate the first ``{``.
    """
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    start = text.find("{")
    if start == -1:
        return None
    try:
        return json.loads(text[start:])
    except (json.JSONDecodeError, ValueError):
        return None


class HyperframesCLI:
    """Asynchronous wrapper around ``npx hyperframes``."""

    def __init__(self, project_path: Path, runtime: "VideoRuntime") -> None:
        self.project = Path(project_path)
        self.runtime = runtime
        self.env = runtime.build_env()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _node(self) -> str:
        path = self.runtime.get_node_path()
        if not path:
            raise RuntimeError("Node.js not available — run ensure_runtime('node')")
        return path

    def _npx(self) -> str:
        path = self.runtime.get_npx_path()
        if not path:
            raise RuntimeError("npx-cli.js not available alongside Node")
        return path

    async def _run(
        self,
        args: list[str],
        cwd: Path | None = None,
    ) -> dict:
        """Run a hyperframes subcommand and return a structured result."""
        node = self._node()
        npx = self._npx()
        cmd = [node, npx, "hyperframes", *args]
        logger.debug("hyperframes cmd: {}", cmd)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.env,
            cwd=str(cwd or self.project),
        )
        stdout, stderr = await proc.communicate()
        out_text = (stdout or b"").decode("utf-8", "replace")
        err_text = (stderr or b"").decode("utf-8", "replace")
        if proc.returncode != 0:
            return {
                "ok": False,
                "returncode": proc.returncode,
                "stdout": out_text,
                "stderr": err_text,
            }
        parsed = _try_parse_json(out_text)
        if parsed is not None:
            return {"ok": True, "data": parsed, "stdout": out_text}
        return {"ok": True, "stdout": out_text}

    # ------------------------------------------------------------------
    # Subcommands
    # ------------------------------------------------------------------

    async def init_project(
        self,
        name: str,
        resolution: str = "landscape",
    ) -> dict:
        """Create a new Hyperframes project.

        Runs ``npx hyperframes init <name> --example blank --resolution <r>
        --non-interactive`` in the project's parent directory.
        """
        args = [
            "init",
            name,
            "--example",
            "blank",
            "--resolution",
            resolution,
            "--non-interactive",
        ]
        cwd = self.project.parent if self.project.parent.exists() else None
        return await self._run(args, cwd=cwd)

    async def lint(self) -> dict:
        """Run ``npx hyperframes lint --json``."""
        return await self._run(["lint", "--json"])

    async def validate(self) -> dict:
        """Run ``npx hyperframes validate --json``."""
        return await self._run(["validate", "--json"])

    async def inspect(self, samples: int = 15) -> dict:
        """Run ``npx hyperframes inspect --samples <n> --json``."""
        return await self._run(["inspect", "--samples", str(samples), "--json"])

    async def render(
        self,
        output: str,
        quality: str = "standard",
        fps: int = 30,
    ) -> dict:
        """Render the project to MP4.

        Runs ``npx hyperframes render --output <path> --quality <q>
        --fps <f> --strict``.
        """
        args = [
            "render",
            "--output",
            output,
            "--quality",
            quality,
            "--fps",
            str(fps),
            "--strict",
        ]
        return await self._run(args)

    async def preview_server(
        self,
        port: int = 3017,
    ) -> asyncio.subprocess.Process:
        """Start a long-running preview server.

        Returns the subprocess handle; the caller is responsible for
        terminating it.
        """
        node = self._node()
        npx = self._npx()
        cmd = [node, npx, "hyperframes", "preview", "--port", str(port)]
        logger.debug("hyperframes preview: {}", cmd)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.env,
            cwd=str(self.project),
        )
        return proc
