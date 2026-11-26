"""Local TTS transport. No model or voice is selected implicitly."""
import asyncio
import json
import os
import struct
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path

from aiohttp import WSMsgType, web


@dataclass
class TTSRuntime:
    command: tuple[str, ...] | None = None
    busy: bool = False
    enabled: bool = False
    process: asyncio.subprocess.Process | None = None
    preparing: asyncio.Task | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def enable(self) -> None:
        self.enabled = True
        self.prepare()

    def prepare(self) -> asyncio.Task | None:
        if not self.enabled or not self.command:
            return None
        if self.preparing and not self.preparing.done():
            return self.preparing
        if self.process and self.process.returncode is None:
            return None
        self.preparing = asyncio.create_task(self._spawn())
        # Prewarming runs in the background; retrieve failures even when idle.
        self.preparing.add_done_callback(lambda task: None if task.cancelled() else task.exception())
        return self.preparing

    async def _spawn(self) -> None:
        async with self.lock:
            if not self.enabled or not self.command:
                return
            process = await asyncio.create_subprocess_exec(
                *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            self.process = process
            try:
                kind, request_id, payload = await asyncio.wait_for(read_frame(process), 90)
                if kind != b"R" or request_id != "0" * 32 or payload:
                    raise ValueError("invalid model readiness frame")
            except BaseException:
                if process.returncode is None:
                    process.kill()
                await process.wait()
                if self.process is process:
                    self.process = None
                raise

    async def ready(self) -> asyncio.subprocess.Process:
        if not self.enabled or not self.command:
            raise RuntimeError("语音尚未开启或配置。")
        task = self.prepare()
        if task:
            await asyncio.shield(task)
        if not self.enabled or self.process is None or self.process.returncode is not None:
            raise RuntimeError("本地语音暂时不可用。")
        return self.process

    async def stop(self) -> None:
        task = self.preparing
        if task and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await task
        async with self.lock:
            process, self.process = self.process, None
            if process:
                if process.returncode is None:
                    process.kill()
                await process.wait()

    async def restart(self) -> None:
        await self.stop()
        self.prepare()

    async def disable(self) -> None:
        self.enabled = False
        await self.stop()


async def read_frame(process: asyncio.subprocess.Process) -> tuple[bytes, str, bytes]:
    size = struct.unpack(">I", await process.stdout.readexactly(4))[0]
    if not 33 <= size <= 4_000_000:
        raise ValueError("invalid audio frame length")
    data = await process.stdout.readexactly(size)
    return data[:1], data[1:33].decode("ascii"), data[33:]


TTS_RUNTIME = web.AppKey("tts_runtime", TTSRuntime)


async def tts_socket(request: web.Request) -> web.WebSocketResponse:
    if request.headers.get("Origin") != f"{request.scheme}://{request.host}":
        raise web.HTTPForbidden(text="语音连接来源无效。")
    runtime = request.app[TTS_RUNTIME]
    if runtime.busy:
        raise web.HTTPConflict(text="语音正在生成。")
    runtime.busy = True
    ws = web.WebSocketResponse(max_msg_size=20_000, heartbeat=20)
    reader = None
    started = False
    completed = False
    try:
        await ws.prepare(request)
        if runtime.command is None:
            await ws.send_json({"type": "error", "message": "本地语音尚未配置。"})
            return ws
        incoming = await asyncio.wait_for(ws.receive(), 10)
        if incoming.type != WSMsgType.TEXT:
            return ws
        try:
            data = incoming.json()
            text = data.get("text") if isinstance(data, dict) else None
        except ValueError:
            text = None
        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
            await ws.send_json({"type": "error", "message": "朗读内容无效。"})
            return ws
        async def forward():
            nonlocal started, completed
            process = await runtime.ready()
            request_id = uuid.uuid4().hex
            process.stdin.write((json.dumps({"id": request_id, "text": text}, ensure_ascii=False) + "\n").encode("utf-8"))
            started = True
            await process.stdin.drain()
            await ws.send_json({"type": "ready", "sample_rate": 24000})
            while True:
                kind, frame_id, payload = await asyncio.wait_for(read_frame(process), 120)
                if frame_id != request_id:
                    raise ValueError("stale audio frame")
                if kind == b"D" and payload and len(payload) % 2 == 0:
                    await ws.send_bytes(payload)
                elif kind == b"E" and not payload:
                    completed = True
                    await ws.send_json({"type": "end"})
                    return
                else:
                    raise ValueError("invalid audio frame")

        reader = asyncio.create_task(forward())
        while not reader.done():
            received = asyncio.create_task(ws.receive())
            done, _ = await asyncio.wait({reader, received}, return_when=asyncio.FIRST_COMPLETED)
            if received in done:
                break
            received.cancel()
            with suppress(asyncio.CancelledError):
                await received
        if reader.done():
            await reader
    except (asyncio.TimeoutError, ConnectionError, OSError, RuntimeError, ValueError, asyncio.IncompleteReadError):
        if not ws.closed:
            with suppress(ConnectionError, RuntimeError):
                await ws.send_json({"type": "error", "message": "本地语音生成失败。"})
    finally:
        if reader and not reader.done():
            reader.cancel()
            with suppress(asyncio.CancelledError):
                await reader
        if started and not completed:
            await runtime.restart()
        runtime.busy = False
        await ws.close()
    return ws


def build_command(settings: dict) -> tuple[str, ...]:
    """Validate explicit local executable, with worker paths checked inside the worker."""
    root = Path(settings["runtime_root"]).expanduser().resolve(strict=True)
    python = Path(os.path.abspath(root / settings["python"]))
    if (not root.is_dir() or not python.is_relative_to(root) or not python.parent.resolve(strict=True).is_relative_to(root)
            or not python.resolve(strict=True).is_relative_to(root) or not python.is_file()):
        raise ValueError("本地语音运行环境无效。")
    worker = Path(__file__).with_name("cosyvoice_worker.py").resolve(strict=True)
    names = ("runtime_root", "source", "matcha", "model", "reference_root", "reference", "instruction")
    if any(not isinstance(settings.get(name), str) or not settings[name] for name in names):
        raise ValueError("本地语音配置不完整。")
    args = [str(python), str(worker)]
    for name in names:
        args.extend(("--" + name.replace("_", "-"), settings[name]))
    return tuple(args)
