"""Fail-closed gVisor execution with a bounded, per-user tmpfs workspace.

No host directory, credential, engine home or socket is mounted into the sandbox.
Only a validated, bounded workspace archive crosses the process boundary.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path
from uuid import uuid4

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError, identifier


class SandboxError(WorkError):
    def __init__(self, code: str = "sandbox_unavailable", message: str = "隔离环境不可用，本次操作未在宿主上执行。"):
        super().__init__(code, message, 503)


def container_name(owner: str, run_id: str) -> str:
    identifier(run_id)
    if not re.fullmatch(r"[a-f0-9]{64}", owner):
        raise ValueError("invalid owner")
    return "mona-work-" + hashlib.sha256((owner + run_id).encode()).hexdigest()[:40]


def create_arguments(config: HostedWorkConfig, owner: str, run_id: str) -> list[str]:
    if not re.fullmatch(r"(?:[A-Za-z0-9][A-Za-z0-9./:_-]*@)?sha256:[a-f0-9]{64}", config.sandbox_image):
        raise SandboxError(message="尚未配置经过核验的隔离镜像，未执行任务。")
    if config.sandbox_runtime != "runsc":
        raise SandboxError()
    return ["create", "--pull=never", "--name", container_name(owner, run_id),
            "--label", "mona.hosted-work=v1", "--label", f"mona.owner={owner}",
            "--runtime=runsc", "--network=none", "--read-only", "--user=1000:1000", "--no-healthcheck",
            "--cap-drop=ALL", "--security-opt=no-new-privileges:true", "--pids-limit=64",
            f"--memory={config.sandbox_memory_mb}m", f"--memory-swap={config.sandbox_memory_mb}m",
            f"--cpus={config.sandbox_cpus}", "--log-driver=none",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000,mode=700",
            "--tmpfs", f"/workspace:rw,nosuid,nodev,size={config.workspace_bytes},uid=1000,gid=1000,mode=700",
            "--workdir=/workspace", "--env=HOME=/tmp", "--env=PYTHONDONTWRITEBYTECODE=1",
            "--entrypoint=/bin/sleep", config.sandbox_image, "infinity"]


def verify_inspection(value: dict, owner: str, config: HostedWorkConfig) -> None:
    host, image = value.get("HostConfig", {}), value.get("Config", {})
    labels = image.get("Labels") or {}
    valid = (host.get("Runtime") == "runsc" and host.get("NetworkMode") == "none"
             and host.get("ReadonlyRootfs") is True and not host.get("Privileged")
             and image.get("User") == "1000:1000" and "ALL" in host.get("CapDrop", [])
             and "no-new-privileges:true" in host.get("SecurityOpt", [])
             and host.get("PidsLimit") == 64 and host.get("Memory") == config.sandbox_memory_mb * 1024 * 1024
             and host.get("MemorySwap") == host.get("Memory")
             and host.get("NanoCpus") == int(config.sandbox_cpus * 1_000_000_000)
             and not host.get("CapAdd") and not host.get("DeviceRequests")
             and labels.get("mona.hosted-work") == "v1" and labels.get("mona.owner") == owner
             and not host.get("Binds") and not host.get("Devices")
             and host.get("PidMode", "") == "" and host.get("IpcMode") in ("private", "")
             and set(host.get("Tmpfs") or {}) == {"/tmp", "/workspace"}
             and all(m.get("Type") == "tmpfs" for m in value.get("Mounts", [])))
    if not valid:
        raise SandboxError("sandbox_policy", "隔离策略未能确认，已拒绝执行。")


class DockerSandbox:
    def __init__(self, config: HostedWorkConfig, owner: str, run_id: str, snapshot: Path):
        self.config, self.owner, self.run_id, self.snapshot = config, owner, run_id, snapshot
        self.name = container_name(owner, run_id)
        self.docker = shutil.which("docker")
        self.started = False
        self.created = False
        self._source = Path(__file__).with_name("sandbox_files.py").read_text(encoding="utf-8")

    async def _invoke(self, arguments: list[str], *, data: bytes | None = None,
                      limit: int = 65536, timeout: float = 30, check: bool = True) -> tuple[int, bytes]:
        if sys.platform != "linux" or not self.docker:
            raise SandboxError(message="在线执行需要 Ubuntu 上的隔离运行环境，未降级到本机执行。")
        environment = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL") if key in os.environ}
        # Ignore ambient DOCKER_HOST/contexts and all provider credentials.
        process = await asyncio.create_subprocess_exec(
            self.docker, "--host=unix:///var/run/docker.sock", *arguments,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=environment,
        )

        async def read(stream, maximum):
            chunks, total = [], 0
            while chunk := await stream.read(65536):
                total += len(chunk)
                if total > maximum:
                    raise SandboxError("output_limit", "操作输出超过上限，已停止本次操作。")
                chunks.append(chunk)
            return b"".join(chunks)

        async def write():
            try:
                if data:
                    process.stdin.write(data)
                    await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                process.stdin.close()

        tasks = [asyncio.create_task(read(process.stdout, limit)), asyncio.create_task(read(process.stderr, 65536)),
                 asyncio.create_task(write()), asyncio.create_task(process.wait())]
        try:
            stdout, _, _, code = await asyncio.wait_for(asyncio.gather(*tasks), timeout)
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.wait()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        if check and code:
            raise SandboxError("sandbox_operation_failed", "隔离环境中的操作失败；未改用宿主执行。")
        return code, stdout

    async def preflight(self):
        create_arguments(self.config, self.owner, self.run_id)
        _, raw = await self._invoke(["info", "--format", "{{json .Runtimes}}"])
        runtimes = json.loads(raw)
        if not isinstance(runtimes, dict) or "runsc" not in runtimes:
            raise SandboxError(message="Ubuntu 尚未配置所需的隔离运行时，未接收执行任务。")
        _, raw = await self._invoke(["image", "inspect", self.config.sandbox_image])
        images = json.loads(raw)
        if (not isinstance(images, list) or len(images) != 1 or images[0].get("Os") != "linux"
                or images[0].get("Config", {}).get("Volumes")):
            raise SandboxError(message="隔离镜像不满足在线执行策略。")

    async def start(self):
        arguments = create_arguments(self.config, self.owner, self.run_id)
        # An uncertain creation is never retried under a new identity.
        self.created = True
        await self._invoke(arguments)
        _, raw = await self._invoke(["inspect", self.name])
        inspected = json.loads(raw)
        if not isinstance(inspected, list) or len(inspected) != 1:
            raise SandboxError()
        verify_inspection(inspected[0], self.owner, self.config)
        await self._invoke(["start", self.name])
        self.started = True
        if self.snapshot.exists():
            if self.snapshot.is_symlink() or self.snapshot.stat().st_size > self.config.workspace_bytes + 512 * 1024:
                raise SandboxError("invalid_snapshot", "已保存的工作区无法安全恢复，原数据保留。")
            await self._helper("restore", self.config.workspace_bytes, self.snapshot.read_bytes())

    async def _helper(self, mode: str, maximum: int, data: bytes | None = None, limit: int = 65536):
        if not self.started:
            raise SandboxError()
        _, output = await self._invoke(["exec", "-i", self.name, "python3", "-I", "-c", self._source, mode, str(maximum)],
                                       data=data, limit=limit, timeout=self.config.tool_timeout_seconds)
        return output

    async def file(self, request: dict) -> dict:
        data = json.dumps(request, ensure_ascii=False, allow_nan=False).encode()
        raw = await self._helper("file", self.config.max_file_bytes, data, limit=2 * self.config.max_file_bytes + 65536)
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise SandboxError("invalid_file_reply", "工作区文件操作未返回有效结果。")
        return result

    async def execute(self, command: str) -> dict:
        if not self.started or not command or len(command) > 32000 or "\x00" in command:
            raise SandboxError("invalid_command", "命令无效或隔离环境尚未就绪。")
        code, output = await self._invoke(["exec", "--workdir=/workspace", self.name, "/bin/sh", "-c", command],
                                          timeout=self.config.tool_timeout_seconds, check=False)
        return {"exit_code": code, "output": output.decode("utf-8", errors="replace")}

    async def save(self):
        raw = await self._helper("export", self.config.workspace_bytes, limit=self.config.workspace_bytes + 512 * 1024)
        self.snapshot.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.snapshot.with_name(f".{uuid4().hex}.snapshot")
        try:
            with temporary.open("xb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.snapshot)
        finally:
            temporary.unlink(missing_ok=True)

    async def close(self):
        if not self.created:
            return
        # Inspect before deleting: do not remove another task's pre-existing container.
        code, raw = await self._invoke(["inspect", self.name], check=False)
        if code:
            # A failed observation does not prove absence. Docker's exact filtered
            # successful listing is required before declaring cleanup complete.
            _, listing = await self._invoke(["ps", "-a", "--filter", f"name=^/{self.name}$", "--format", "{{.Names}}"])
            if listing.strip():
                raise SandboxError("cleanup_unknown", "隔离任务状态待核对，未再次执行。")
        else:
            values = json.loads(raw)
            labels = values[0].get("Config", {}).get("Labels", {}) if len(values) == 1 else {}
            if labels.get("mona.owner") != self.owner or labels.get("mona.hosted-work") != "v1":
                raise SandboxError("cleanup_unknown", "隔离任务归属无法确认，未删除。")
            await self._invoke(["rm", "--force", "--volumes", self.name])
            _, listing = await self._invoke(["ps", "-a", "--filter", f"name=^/{self.name}$", "--format", "{{.Names}}"])
            if listing.strip():
                raise SandboxError("cleanup_unknown", "隔离任务尚未结束，未再次执行。")
        self.started = self.created = False
