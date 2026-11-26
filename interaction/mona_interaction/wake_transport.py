"""One local, same-origin, bounded PCM stream for keyword detection."""
import asyncio
import json
import uuid
from dataclasses import dataclass
from typing import Callable

from aiohttp import WSMsgType, web

from .voice_wake import WakeDependencyError, WakeModelError
from .voice_asr import ASRDependencyError, ASRModelError
from .tts_transport import TTS_RUNTIME

FRAME_BYTES = 640  # 20 ms of 16 kHz mono PCM16 little-endian
IDLE_SECONDS = 10
BURST_FRAMES = 100


@dataclass
class WakeRuntime:
    factory: Callable | None = None
    asr_factory: Callable | None = None
    busy: bool = False


WAKE_RUNTIME = web.AppKey("wake_runtime", WakeRuntime)


async def wake_socket(request: web.Request) -> web.WebSocketResponse:
    # Unlike normal read-only HTTP, microphone access must originate from the
    # page served by this exact local origin; a missing Origin is not accepted.
    if request.headers.get("Origin") != f"{request.scheme}://{request.host}":
        raise web.HTTPForbidden(text="语音连接来源无效。")
    runtime = request.app[WAKE_RUNTIME]
    if runtime.busy:
        # Browsers hide HTTP handshake status from WebSocket clients. Identify
        # a releasing or already occupied device without allocating another model.
        busy = web.WebSocketResponse(max_msg_size=FRAME_BYTES + 1)
        await busy.prepare(request)
        await busy.send_json({"type": "error", "code": "wake_busy", "message": "另一个 Mona 窗口正在使用麦克风。请切回那个窗口，或关闭它后重试。"})
        await busy.close()
        return busy
    runtime.busy = True
    # aiohttp rejects messages whose size is greater than or equal to the cap.
    # A compressed, non-silent PCM frame can exceed the raw 640-byte frame
    # limit on the wire. Keep the limit and the local audio transport uncompressed.
    ws = web.WebSocketResponse(max_msg_size=FRAME_BYTES + 1, heartbeat=20, compress=False)
    voice_enabled = False
    try:
        await ws.prepare(request)
        if runtime.factory is None:
            await ws.send_json({"type": "error", "code": "not_configured", "message": "请先配置语音唤醒资源。"})
            return ws
        try:
            detector = await asyncio.to_thread(runtime.factory)
        except WakeDependencyError:
            await ws.send_json({"type": "error", "code": "dependency_missing", "message": "语音唤醒组件未安装。"})
            return ws
        except (WakeModelError, OSError, ValueError):
            await ws.send_json({"type": "error", "code": "model_unavailable", "message": "语音唤醒资源不可用，请检查配置。"})
            return ws
        except Exception:
            await ws.send_json({"type": "error", "code": "wake_failed", "message": "语音唤醒暂时无法启动。"})
            return ws
        asr = None
        asr_problem = {"type": "asr.unavailable", "code": "asr_not_configured", "message": "语音识别资源尚未配置。"}
        if runtime.asr_factory is not None:
            try:
                asr = await asyncio.to_thread(runtime.asr_factory)
                asr_problem = None
            except ASRDependencyError:
                asr_problem = {"type": "asr.unavailable", "code": "asr_dependency_missing", "message": "语音识别组件未安装。"}
            except (ASRModelError, OSError, ValueError):
                asr_problem = {"type": "asr.unavailable", "code": "asr_model_unavailable", "message": "语音识别资源不可用，请检查配置。"}
            except Exception:
                asr_problem = {"type": "asr.unavailable", "code": "asr_failed", "message": "语音识别暂时无法启动。"}
        stream_id = uuid.uuid4().hex
        await ws.send_json({"type": "ready", "sample_rate": 16000, "frame_bytes": FRAME_BYTES,
                            "asr_available": asr is not None, "stream_id": stream_id})
        if asr_problem:
            await ws.send_json(asr_problem)
        loop = asyncio.get_running_loop()
        started = loop.time()
        frames = 0
        listening = False
        generation = 0
        while not ws.closed:
            try:
                incoming = await asyncio.wait_for(ws.receive(), timeout=IDLE_SECONDS)
            except asyncio.TimeoutError:
                await ws.send_json({"type": "error", "code": "capture_timeout", "message": "未收到麦克风音频，请检查设备。"})
                break
            if incoming.type in {WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.ERROR}:
                break
            if incoming.type == WSMsgType.TEXT:
                try:
                    command = json.loads(incoming.data)
                except ValueError:
                    command = None
                if (not isinstance(command, dict) or command.get("type") != "wake.rearm"
                        or type(command.get("version")) is not int or command["version"] != 1
                        or command.get("stream_id") != stream_id or type(command.get("generation")) is not int):
                    await ws.send_json({"type": "error", "code": "invalid_control", "message": "语音会话状态未能同步。"})
                    break
                if listening and command["generation"] == generation:
                    try:
                        await asyncio.to_thread(asr.reset)
                        await asyncio.to_thread(detector.reset)
                    except Exception:
                        await ws.send_json({"type": "error", "code": "rearm_failed", "message": "暂时无法恢复语音唤醒。"})
                        break
                    listening = False
                    await ws.send_json({"type": "wake.standby", "stream_id": stream_id, "generation": generation})
                continue
            if incoming.type != WSMsgType.BINARY or len(incoming.data) != FRAME_BYTES:
                await ws.send_json({"type": "error", "code": "invalid_audio", "message": "麦克风音频格式无效。"})
                break
            frames += 1
            if frames > BURST_FRAMES + 50 * (loop.time() - started):
                await ws.send_json({"type": "error", "code": "audio_rate_exceeded", "message": "麦克风音频速度异常，已停止。"})
                break
            if not listening:
                try:
                    detections = await asyncio.to_thread(detector.feed, incoming.data)
                except Exception:
                    await ws.send_json({"type": "error", "code": "wake_failed", "message": "语音唤醒失败，请重新开启。"})
                    break
                if not detections:
                    continue
                if asr is None:
                    await ws.send_json({"type": "wake.detected"})
                    continue
                if not voice_enabled:
                    request.app[TTS_RUNTIME].enable()
                    voice_enabled = True
                listening = True
                generation += 1
                await ws.send_json({"type": "wake.detected", "stream_id": stream_id, "generation": generation})
                # The keyword and all preceding room audio belong to the detector.
                # Recognition starts at the next microphone frame.
                continue
            try:
                events = await asyncio.to_thread(asr.feed, incoming.data)
                for result in events:
                    if result.get("type") not in {"asr.partial", "asr.final", "asr.endpoint"}:
                        raise ValueError("Invalid recognition event")
                    await ws.send_json({**result, "stream_id": stream_id, "generation": generation})
            except Exception:
                await ws.send_json({"type": "error", "code": "asr_failed", "message": "语音识别失败，请重新开启。"})
                break
    finally:
        if voice_enabled:
            await request.app[TTS_RUNTIME].disable()
        runtime.busy = False
        await ws.close()
    return ws
