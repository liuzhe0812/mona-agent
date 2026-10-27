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
import re
import sys
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from loguru import logger

if TYPE_CHECKING:
    from mona.api.video_runtime import VideoRuntime

HYPERFRAMES_VERSION = "0.8.16"
HYPERFRAMES_PACKAGE = f"hyperframes@{HYPERFRAMES_VERSION}"
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_PROGRESS_RE = re.compile(r"\b(\d{1,3})%\s+(.+)$")

__all__ = ("HYPERFRAMES_VERSION", "HyperframesCLI")


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

    def __init__(
        self,
        project_path: Path,
        runtime: "VideoRuntime",
        cancel_event: Any | None = None,
    ) -> None:
        self.project = Path(project_path)
        self.runtime = runtime
        self.cancel_event = cancel_event
        self.env = runtime.build_env()
        browser = runtime.get_chrome_path()
        if browser:
            self.env["HYPERFRAMES_BROWSER_PATH"] = browser
        self.env.setdefault("HYPERFRAMES_SKIP_SKILLS", "1")

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

    async def _stop_process_tree(self, proc: asyncio.subprocess.Process) -> None:
        if sys.platform == "win32" and getattr(proc, "pid", None):
            killer = await asyncio.create_subprocess_exec(
                "taskkill",
                "/PID",
                str(proc.pid),
                "/T",
                "/F",
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await killer.communicate()
            return
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=3)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()

    async def _run(
        self,
        args: list[str],
        cwd: Path | None = None,
        progress_cb: Callable[[int, str], None] | None = None,
    ) -> dict:
        """Run a hyperframes subcommand and return a structured result."""
        node = self._node()
        npx = self._npx()
        cmd = [node, npx, "--yes", HYPERFRAMES_PACKAGE, *args]
        logger.debug("hyperframes cmd: {}", cmd)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.env,
            cwd=str(cwd or self.project),
        )
        if progress_cb is not None:
            stdout_chunks: list[bytes] = []
            stderr_chunks: list[bytes] = []

            async def read_stream(stream, chunks: list[bytes], parse: bool) -> None:
                while True:
                    line = await stream.readline()
                    if not line:
                        return
                    chunks.append(line)
                    if parse:
                        clean = _ANSI_RE.sub(
                            "", line.decode("utf-8", "replace")
                        ).strip()
                        match = _PROGRESS_RE.search(clean)
                        if match:
                            progress_cb(
                                min(100, int(match.group(1))),
                                match.group(2).strip(),
                            )

            stdout_reader = asyncio.create_task(
                read_stream(proc.stdout, stdout_chunks, True)
            )
            stderr_reader = asyncio.create_task(
                read_stream(proc.stderr, stderr_chunks, False)
            )
            wait_task = asyncio.create_task(proc.wait())
            try:
                while not wait_task.done():
                    if self.cancel_event is not None and self.cancel_event.is_set():
                        await self._stop_process_tree(proc)
                        raise asyncio.CancelledError
                    await asyncio.sleep(0.1)
                await asyncio.gather(stdout_reader, stderr_reader)
            except asyncio.CancelledError:
                for task in (stdout_reader, stderr_reader, wait_task):
                    task.cancel()
                await asyncio.gather(
                    stdout_reader, stderr_reader, wait_task, return_exceptions=True
                )
                return {"ok": False, "cancelled": True, "error": "视频导出已取消"}
            stdout = b"".join(stdout_chunks)
            stderr = b"".join(stderr_chunks)
        else:
            communicate = asyncio.create_task(proc.communicate())
            try:
                while not communicate.done():
                    if self.cancel_event is not None and self.cancel_event.is_set():
                        await self._stop_process_tree(proc)
                        communicate.cancel()
                        await asyncio.gather(communicate, return_exceptions=True)
                        return {"ok": False, "cancelled": True, "error": "视频导出已取消"}
                    await asyncio.sleep(0.1)
                stdout, stderr = await communicate
            except asyncio.CancelledError:
                await self._stop_process_tree(proc)
                communicate.cancel()
                await asyncio.gather(communicate, return_exceptions=True)
                raise
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

    async def check(self, samples: int = 9) -> dict:
        """Run the combined lint/runtime/layout/motion/contrast gate."""

        return await self._run(
            [
                "check",
                "--samples",
                str(samples),
                "--timeout",
                "45000",
                "--json",
            ]
        )

    async def render(
        self,
        output: str,
        quality: str = "standard",
        fps: int = 30,
        workers: int = 1,
        progress_cb: Callable[[int, str], None] | None = None,
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
            "--workers",
            str(workers),
            "--browser-timeout",
            "60",
            "--player-ready-timeout",
            "45000",
            "--protocol-timeout",
            "300000",
            "--strict",
        ]
        return await self._run(args, progress_cb=progress_cb)

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
