"""Bounded child-process transport. Losing a reply never dispatches a replacement run."""
from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
from pathlib import Path

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.sandbox import DockerSandbox


def child_environment(config: HostedWorkConfig, payload: dict) -> dict[str, str]:
    allowed = {"PATH", "LANG", "LC_ALL", "SYSTEMROOT"}
    if payload.get("action") == "turn":
        selected = config.models.get(payload.get("model_id", ""))
        if selected is not None and selected.source == "mona" and selected.api_key_env:
            allowed.add(selected.api_key_env)
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    environment.update(PYTHONUTF8="1", PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONNOUSERSITE="1")
    return environment


class ProcessExecutor:
    def __init__(self, config: HostedWorkConfig):
        self.config = config
        self.processes: dict[tuple[str, str], asyncio.subprocess.Process] = {}
        self.cancelled: set[tuple[str, str]] = set()

    def cancel(self, owner: str, run_id: str):
        key = (owner, run_id)
        self.cancelled.add(key)
        process = self.processes.get(key)
        if process and process.returncode is None:
            process.send_signal(signal.SIGTERM)

    async def execute(self, payload: dict, on_event) -> dict:
        if sys.platform != "linux":
            raise WorkError("linux_required", "在线任务需要 Ubuntu 隔离环境，未改用本机执行。", 503)
        key = (payload["owner"], payload["run_id"])
        if key in self.processes:
            raise WorkError("duplicate_execution", "此任务已在执行，未重复派发。", 409)
        if key in self.cancelled:
            self.cancelled.discard(key)
            return {"status": "cancelled", "message": "任务在派发前已停止。", "workspace_saved": True}
        frame_limit = max(self.config.max_history_bytes * 2, self.config.max_file_bytes * 2 + 65536)
        environment = child_environment(self.config, payload)
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-u", "-m", "mona.hosted_work.turn", "--parent-pid", str(os.getpid()),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            limit=frame_limit + 1, start_new_session=True, env=environment,
            cwd=Path(__file__).resolve().parents[2],
        )
        self.processes[key] = process
        if key in self.cancelled:
            process.send_signal(signal.SIGTERM)
        result = None

        async def stdout():
            nonlocal result
            while raw := await process.stdout.readline():
                if len(raw) > frame_limit:
                    raise WorkError("protocol_limit", "任务输出超过安全上限。", 503)
                event = json.loads(raw)
                if not isinstance(event, dict) or set(event) != {"kind", "data"} or not isinstance(event["data"], dict):
                    raise WorkError("protocol_error", "任务执行状态无法确认。", 503)
                kind, value = event["kind"], event["data"]
                if result is not None:
                    raise WorkError("protocol_error", "任务结束后返回了额外操作。", 503)
                if kind == "result":
                    if value.get("status") not in {"completed", "failed", "cancelled", "unknown"}:
                        raise WorkError("protocol_error", "任务执行状态无法确认。", 503)
                    result = value
                elif kind in {"delta", "progress", "artifact", "history", "checkpoint"}:
                    await on_event(kind, value)
                else:
                    raise WorkError("protocol_error", "任务执行状态无法确认。", 503)

        async def stderr():
            total = 0
            while raw := await process.stderr.read(65536):
                total += len(raw)
                if total > 1024 * 1024:
                    raise WorkError("diagnostic_limit", "任务诊断输出异常，已停止执行。", 503)
                # Never persist raw engine diagnostics or credential-bearing exceptions.

        readers = [asyncio.create_task(stdout()), asyncio.create_task(stderr())]
        try:
            envelope = {"config": self.config.model_dump(), "payload": payload}
            process.stdin.write(json.dumps(envelope, ensure_ascii=False, allow_nan=False).encode())
            await process.stdin.drain()
            process.stdin.close()
            await asyncio.wait_for(asyncio.gather(*readers, process.wait()),
                                   self.config.run_timeout_seconds + self.config.tool_timeout_seconds + 45)
            if process.returncode != 0 or result is None:
                raise WorkError("execution_unknown", "执行结果待核对，不会自动重新执行。", 503)
            return result
        except BaseException:
            if process.returncode is None:
                process.send_signal(signal.SIGTERM)
                try:
                    await asyncio.wait_for(process.wait(), 20)
                except TimeoutError:
                    os.killpg(process.pid, signal.SIGKILL)
                    await process.wait()
            # A killed CLI is not proof the container stopped. Check and remove
            # only this exact, owner-labelled container before releasing capacity.
            cleanup = DockerSandbox(self.config, key[0], key[1],
                                    Path(self.config.state_dir) / "users" / key[0] / "workspace.zip")
            cleanup.created = True
            try:
                await asyncio.shield(cleanup.close())
            except Exception:
                pass  # The caller records unknown and keeps the user blocked.
            raise
        finally:
            for reader in readers:
                reader.cancel()
            await asyncio.gather(*readers, return_exceptions=True)
            self.processes.pop(key, None)
            self.cancelled.discard(key)
