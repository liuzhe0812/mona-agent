"""Local development terminal with an explicitly simulated session connector."""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
from collections import OrderedDict, deque
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, urlsplit

from aiohttp import WSMsgType, web

from . import __version__
from .character import CharacterBundle
from .connector import ConnectorError, MonaConnector, project_record
from .protocol import PROTOCOL_VERSION, ClientMessage, ProtocolError, event, parse_message
from .scene import SceneBundle
from .wake_transport import WAKE_RUNTIME, WakeRuntime, wake_socket
from .tts_transport import TTS_RUNTIME, TTSRuntime, tts_socket

WEB_ROOT = Path(__file__).resolve().parent / "web"
STATIC_FILES = {
    "index.html", "app.js", "style.css", "mona-original.png", "performance-controller.js",
    "character-view.js", "parameter-bindings.js", "speech-timeline.js",
    "office.html", "office.js", "office-scene.js", "office-scene.css", "pose-state.js", "office-pose.js",
    "office-models.js",
    "microphone.js", "microphone-worklet.js", "wake-client.js", "office-voice.js", "office-voice.css", "audio-playback.js",
}
VENDOR_FILES = {"cubism-runtime.js", "cubism-runtime.js.LEGAL.txt", "CubismFramework-LICENSE.md"}
VENDOR_SHADER_FILES = frozenset({
    "fragshadersrcalphablend.frag", "fragshadersrccolorblend.frag", "fragshadersrccopy.frag",
    "fragshadersrcmaskinvertedpremultipliedalpha.frag", "fragshadersrcmaskpremultipliedalpha.frag",
    "fragshadersrcpremultipliedalpha.frag", "fragshadersrcpremultipliedalphablend.frag",
    "fragshadersrcsetupmask.frag", "vertshadersrc.vert", "vertshadersrcblend.vert",
    "vertshadersrccopy.vert", "vertshadersrcmasked.vert", "vertshadersrcsetupmask.vert",
})
MAX_RECORDS = 100
MAX_OBSERVE_EVENTS = 512


@dataclass
class InputRecord:
    text: str
    state: str = "accepted"
    reply: str = ""
    performance: dict | None = None
    performance_status: str = "missing"


@dataclass
class ObserveBuffer:
    events: deque[dict] = field(default_factory=deque)
    overflowed: bool = False


@dataclass
class DemoSession:
    records: OrderedDict[str, InputRecord] = field(default_factory=OrderedDict)
    listeners: set[web.WebSocketResponse] = field(default_factory=set)
    pending_id: str | None = None
    broadcast_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    observe_buffers: dict[web.WebSocketResponse, ObserveBuffer] = field(default_factory=dict)

    def snapshot(self, session_id: str, mode: str = "demo") -> dict:
        return event(
            "session.snapshot", session_id, mode=mode, state="thinking" if self.pending_id else "idle",
            pending_id=self.pending_id,
            records=[{"message_id": key, "text": record.text, "state": record.state, "reply": record.reply,
                      **({"performance": record.performance, "performance_status": record.performance_status}
                         if mode == "mona" else {})}
                     for key, record in self.records.items()],
        )


SESSIONS = web.AppKey("sessions", dict[str, DemoSession])
TASKS = web.AppKey("tasks", set[asyncio.Task])
CONNECTOR = web.AppKey("connector", MonaConnector)
DEMO = web.AppKey("demo", bool)
CHARACTER = web.AppKey("character", CharacterBundle)
OFFICE_CHARACTERS = web.AppKey("office_characters", dict[str, CharacterBundle])
OFFICE_POSES = frozenset({"rest", "work", "dialogue"})
SCENE = web.AppKey("scene", SceneBundle)


def app_mode(app: web.Application) -> str:
    return "mona" if CONNECTOR in app else ("demo" if app[DEMO] else "unconfigured")


def _loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@web.middleware
async def local_only(request: web.Request, handler):
    try:
        target = urlsplit(f"http://{request.host}")
        if target.username is not None or target.password is not None:
            raise ValueError
        if not target.hostname or not _loopback(target.hostname):
            raise ValueError
        _ = target.port
        origin = request.headers.get("Origin")
        if origin:
            parsed = urlsplit(origin)
            if parsed.scheme not in {"http", "https"} or parsed.netloc != request.host:
                raise ValueError
    except ValueError:
        raise web.HTTPForbidden(text="此开发服务仅允许本机访问。") from None
    response = await handler(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; "
        "img-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*; "
        "object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    )
    return response


async def health(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "module": "mona-interaction", "version": __version__,
                              "protocol_version": PROTOCOL_VERSION, "mode": app_mode(request.app)})


async def static_file(request: web.Request) -> web.FileResponse:
    name = request.match_info.get("name", "office.html" if SCENE in request.app else "index.html")
    if name not in STATIC_FILES:
        raise web.HTTPNotFound()
    path = (WEB_ROOT / name).resolve()
    if not path.is_relative_to(WEB_ROOT) or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def character_config(request: web.Request) -> web.Response:
    bundle = request.app.get(CHARACTER)
    return web.json_response(bundle.public_config() if bundle else {"available": False},
                             headers={"Cache-Control": "no-store"})


async def character_asset(request: web.Request) -> web.FileResponse:
    bundle = request.app.get(CHARACTER)
    path = bundle.asset(request.match_info["name"]) if bundle else None
    if path is None:
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def office_character_config(request: web.Request) -> web.Response:
    pose = request.match_info["pose"]
    if pose not in OFFICE_POSES:
        raise web.HTTPNotFound()
    bundle = request.app[OFFICE_CHARACTERS].get(pose)
    if bundle is None:
        return web.json_response({"available": False}, headers={"Cache-Control": "no-store"})
    config = bundle.public_config()
    base = f"/office-character/{pose}/assets/"
    config["model_url"] = base + quote(bundle.model_name, safe="/")
    config["core_url"] = base + quote(bundle.core_name, safe="/")
    return web.json_response(config, headers={"Cache-Control": "no-store"})


async def office_character_asset(request: web.Request) -> web.FileResponse:
    pose = request.match_info["pose"]
    if pose not in OFFICE_POSES:
        raise web.HTTPNotFound()
    bundle = request.app[OFFICE_CHARACTERS].get(pose)
    path = bundle.asset(request.match_info["name"]) if bundle else None
    if path is None:
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def scene_config(request: web.Request) -> web.Response:
    bundle = request.app.get(SCENE)
    return web.json_response(bundle.public_config() if bundle else {"available": False},
                             headers={"Cache-Control": "no-store"})


async def scene_asset(request: web.Request) -> web.FileResponse:
    bundle = request.app.get(SCENE)
    path = bundle.asset(request.match_info["name"]) if bundle else None
    if path is None:
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def vendor_file(request: web.Request) -> web.FileResponse:
    name = request.match_info["name"]
    path = (WEB_ROOT / "vendor" / name).resolve()
    if name not in VENDOR_FILES or not path.is_relative_to(WEB_ROOT) or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def vendor_shader(request: web.Request) -> web.FileResponse:
    name = request.match_info["name"]
    if name not in VENDOR_SHADER_FILES:
        raise web.HTTPNotFound()
    root = (WEB_ROOT / "vendor" / "shaders").resolve()
    path = (root / name).resolve()
    if not root.is_relative_to(WEB_ROOT.resolve()) or not path.is_relative_to(root) or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def broadcast(session: DemoSession, message: dict) -> None:
    async with session.broadcast_lock:
        for listener in tuple(session.listeners):
            buffered = session.observe_buffers.get(listener)
            if buffered is not None:
                if len(buffered.events) < MAX_OBSERVE_EVENTS:
                    buffered.events.append(message)
                else:
                    # A stalled snapshot must not allow unbounded retained events.
                    # Closing the observer makes it resynchronise without replaying input.
                    buffered.overflowed = True
                    buffered.events.clear()
                    session.listeners.discard(listener)
                    asyncio.create_task(listener.close(code=1013, message=b"snapshot unavailable"))
                continue
            try:
                await listener.send_json(message)
            except (ConnectionError, RuntimeError):
                session.listeners.discard(listener)


def _advance_observed_pending(pending: str | None, terminal: set[str], message: dict) -> tuple[str | None, bool]:
    """Detect a historical snapshot that conflicts with a newer accepted input."""
    message_id = message.get("message_id")
    if not isinstance(message_id, str) or not message_id or message_id in terminal:
        return pending, False
    kind, payload = message.get("type"), message.get("payload", {})
    if kind == "input.accepted" or (kind == "turn.state" and payload.get("state") == "thinking"):
        if pending is not None and pending != message_id:
            return pending, True
        return message_id, False
    if kind == "turn.state" and payload.get("state") == "idle" and pending == message_id:
        terminal.add(message_id)
        return None, False
    return pending, False


async def _observe(session: DemoSession, app: web.Application, command: ClientMessage,
                   ws: web.WebSocketResponse) -> None:
    # A new observer installs its buffer before being registered as a listener.
    # Re-observation starts the same barrier after any prior broadcast finishes.
    async with session.broadcast_lock:
        buffered = session.observe_buffers.setdefault(ws, ObserveBuffer())
    try:
        observed = session
        if CONNECTOR in app and session.pending_id is None:
            try:
                records = await app[CONNECTOR].lookup(command.session_id)
                observed = DemoSession()
                for row in records:
                    projected = project_record(row)
                    observed.records[row["message_id"]] = InputRecord(
                        projected["text"], projected["state"], projected["reply"],
                        projected["performance"], projected["performance_status"],
                    )
                pending = next((row for row in records if row["status"] == "accepted"), None)
                observed.pending_id = pending["message_id"] if pending else None
            except (ConnectorError, ValueError):
                if not buffered.overflowed:
                    await ws.send_json(event("error", command.session_id, code="sync_failed",
                                             message="会话状态暂时无法确认。"))
                observed = None
        pending_id = None
        terminal_ids: set[str] = set()
        needs_sync = observed is None
        if observed is not None and not buffered.overflowed:
            snapshot = observed.snapshot(command.session_id, app_mode(app))
            pending_id = snapshot["payload"]["pending_id"]
            terminal_ids = {record["message_id"] for record in snapshot["payload"]["records"]
                            if record["state"] in {"completed", "failed", "unknown", "closed_unknown"}}
            # A remote snapshot may describe a former pending task even though a
            # newer task was accepted while the read was in flight. Do not tell
            # clients that both are the active task; ask for another read.
            projected, known = pending_id, set(terminal_ids)
            for queued in buffered.events:
                projected, conflict = _advance_observed_pending(projected, known, queued)
                if conflict:
                    needs_sync = True
                    await ws.send_json(event("error", command.session_id, code="sync_failed",
                                             message="会话状态暂时无法确认。"))
                    break
            if not needs_sync:
                await ws.send_json(snapshot)
        # Keep buffering during each send. The empty check and barrier removal
        # share the broadcast lock so a later event cannot overtake the queue.
        while True:
            async with session.broadcast_lock:
                if buffered.overflowed or not buffered.events:
                    session.observe_buffers.pop(ws, None)
                    return
                pending_event = buffered.events.popleft()
            if not needs_sync:
                pending_id, conflict = _advance_observed_pending(pending_id, terminal_ids, pending_event)
                if conflict:
                    needs_sync = True
                    await ws.send_json(event("error", command.session_id, code="sync_failed",
                                             message="会话状态暂时无法确认。"))
            await ws.send_json(pending_event)
    finally:
        async with session.broadcast_lock:
            if session.observe_buffers.get(ws) is buffered:
                session.observe_buffers.pop(ws, None)


async def demo_reply(session: DemoSession, command: ClientMessage) -> None:
    record = session.records[command.message_id]
    try:
        await asyncio.sleep(0.4)
        reply = f"收到：{command.text}\n\n这是交互模块的模拟回复。真实 Mona 会话尚未接入。"
        for offset in range(0, len(reply), 8):
            chunk = reply[offset:offset + 8]
            record.reply += chunk
            await broadcast(session, event("reply.delta", command.session_id,
                                          message_id=command.message_id, text=chunk))
            await asyncio.sleep(0.025)
        record.state = "completed"
        await broadcast(session, event("reply.completed", command.session_id,
                                      message_id=command.message_id, text=record.reply))
    finally:
        session.pending_id = None
        await broadcast(session, event("turn.state", command.session_id,
                                      message_id=command.message_id, state="idle"))


async def mona_reply(app: web.Application, session: DemoSession, command: ClientMessage, *,
                     recovery: bool = False) -> None:
    record = session.records[command.message_id]

    async def accepted() -> None:
        await broadcast(session, event("input.accepted", command.session_id,
                                      message_id=command.message_id, text=command.text))
        await broadcast(session, event("turn.state", command.session_id,
                                      message_id=command.message_id, state="thinking"))

    try:
        if recovery:
            result = await app[CONNECTOR].request(command, accepted, recovery=True)
        else:
            result = await app[CONNECTOR].request(command, accepted)
        record.state = result["state"]
        if record.state == "failed":
            await broadcast(session, event("error", command.session_id, message_id=command.message_id,
                                          code="reply_failed", message="Mona 已收到你的话，但暂时无法生成回复。请检查对话服务连接后再试。"))
            return
        record.reply = result["reply"]
        record.performance = result["performance"]
        record.performance_status = result["performance_status"]
        await broadcast(session, event("reply.completed", command.session_id,
                                      message_id=command.message_id, text=record.reply,
                                      performance=record.performance, performance_status=record.performance_status))
    except ConnectorError as exc:
        record.state = "unknown" if exc.result_unknown else "failed"
        await broadcast(session, event("error", command.session_id, message_id=command.message_id,
                                      code="result_unknown" if exc.result_unknown else "connection_failed",
                                      message=str(exc)))
    finally:
        session.pending_id = None
        await broadcast(session, event("turn.state", command.session_id,
                                      message_id=command.message_id, state="idle"))


async def accept_command(app: web.Application, session: DemoSession, command: ClientMessage,
                         ws: web.WebSocketResponse) -> None:
    if command.type == "session.observe":
        await _observe(session, app, command, ws)
        return
    if command.type == "input.resolve":
        if CONNECTOR not in app:
            raise ProtocolError("当前没有可核对的 Mona 请求。")
        try:
            local = session.records.get(command.resolve_id)
            missing_upstream = False
            if local is not None and local.state in {"unknown", "closed_unknown"}:
                records = await app[CONNECTOR].lookup(command.session_id)
                missing_upstream = not any(row["message_id"] == command.resolve_id for row in records)
            if (missing_upstream and session.records.get(command.resolve_id) is local
                    and local.state in {"unknown", "closed_unknown"}):
                # The user explicitly acknowledged the uncertain outcome; no
                # upstream row exists to update, so retain a local tombstone.
                local.state = "closed_unknown"
            else:
                await app[CONNECTOR].acknowledge_unknown(command.session_id, command.resolve_id)
        except ConnectorError as exc:
            raise ProtocolError(str(exc)) from None
        except (ValueError, KeyError, TypeError):
            raise ProtocolError("会话状态暂时无法确认，请稍后再试。") from None
        command = ClientMessage("session.sync", command.session_id, command.message_id)
    if command.type == "session.sync":
        if CONNECTOR in app:
            try:
                records = await app[CONNECTOR].lookup(command.session_id)
                if session.pending_id is None:
                    # A vanished upstream record cannot erase the locally
                    # observed unknown result on a later synchronization.
                    unresolved = {key: record for key, record in session.records.items()
                                  if record.state in {"unknown", "closed_unknown"}}
                    session.records.clear()
                    for row in records:
                        projected = project_record(row)
                        session.records[row["message_id"]] = InputRecord(
                            projected["text"], projected["state"], projected["reply"],
                            projected["performance"], projected["performance_status"],
                        )
                    for key, record in unresolved.items():
                        if key not in session.records:
                            session.records[key] = record
                    pending = next((row for row in records if row["status"] == "accepted"), None)
                    if pending is not None:
                        session.pending_id = pending["message_id"]
                        recovery = ClientMessage("input.text", command.session_id, pending["message_id"], pending["text"])
                        task = asyncio.create_task(mona_reply(app, session, recovery, recovery=True))
                        app[TASKS].add(task)
                        task.add_done_callback(app[TASKS].discard)
            except (ConnectorError, ValueError) as exc:
                message = str(exc) if isinstance(exc, ConnectorError) else "回复格式异常，请查看原会话。"
                await ws.send_json(event("error", command.session_id, code="sync_failed", message=message))
                return
        await ws.send_json(session.snapshot(command.session_id, app_mode(app)))
        return
    if app_mode(app) == "unconfigured":
        raise ProtocolError("请先完成与 Mona 的连接配置。")
    previous = session.records.get(command.message_id)
    if previous is not None:
        if previous.text != command.text:
            raise ProtocolError("这条消息的标识已用于其他内容，请重新发送。")
        await ws.send_json(session.snapshot(command.session_id, app_mode(app)))
        return
    if session.pending_id is not None:
        raise ProtocolError("上一条内容仍在处理中，请等回复结束后再发送。")
    while len(session.records) >= MAX_RECORDS:
        session.records.popitem(last=False)
    session.records[command.message_id] = InputRecord(command.text)
    session.pending_id = command.message_id
    if CONNECTOR in app:
        task = asyncio.create_task(mona_reply(app, session, command))
    else:
        await broadcast(session, event("input.accepted", command.session_id,
                                      message_id=command.message_id, text=command.text))
        await broadcast(session, event("turn.state", command.session_id,
                                      message_id=command.message_id, state="thinking"))
        task = asyncio.create_task(demo_reply(session, command))
    app[TASKS].add(task)
    task.add_done_callback(app[TASKS].discard)


async def websocket(request: web.Request) -> web.WebSocketResponse:
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=40_000)
    await ws.prepare(request)
    session: DemoSession | None = None
    session_id: str | None = None
    observe_only = False
    try:
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                command = parse_message(json.loads(message.data))
                if session_id is None:
                    session_id = command.session_id
                    observe_only = command.type == "session.observe"
                    sessions = request.app[SESSIONS]
                    if session_id not in sessions and len(sessions) >= 32:
                        raise ProtocolError("演示会话数量已达上限，请重启交互程序后继续。")
                    session = sessions.setdefault(session_id, DemoSession())
                    if observe_only:
                        session.observe_buffers[ws] = ObserveBuffer()
                    session.listeners.add(ws)
                elif session_id != command.session_id:
                    raise ProtocolError("连接期间不能切换会话。")
                if observe_only and command.type != "session.observe":
                    raise ProtocolError("此连接仅用于查看会话状态。")
                assert session is not None
                await accept_command(request.app, session, command, ws)
            except (ProtocolError, json.JSONDecodeError) as exc:
                text = str(exc) if isinstance(exc, ProtocolError) else "消息格式无效。"
                await ws.send_json(event("error", session_id or "", code="invalid_input", message=text))
    finally:
        if session is not None:
            async with session.broadcast_lock:
                session.listeners.discard(ws)
                session.observe_buffers.pop(ws, None)
    return ws


async def cleanup(app: web.Application) -> None:
    await app[TTS_RUNTIME].disable()
    for session in app[SESSIONS].values():
        for listener in tuple(session.listeners):
            await listener.close(code=1001, message=b"shutdown")
    tasks = tuple(app[TASKS])
    for task in tasks:
        task.cancel()
    for task in tasks:
        with suppress(asyncio.CancelledError):
            await task


def create_app(connector: MonaConnector | None = None, *, demo: bool = False,
               character: CharacterBundle | None = None,
               scene: SceneBundle | None = None, wake_factory=None, asr_factory=None,
               office_characters: Mapping[str, CharacterBundle] | None = None, tts_command=None) -> web.Application:
    poses = dict(office_characters) if office_characters is not None else {}
    if not poses.keys() <= OFFICE_POSES or any(not isinstance(bundle, CharacterBundle) for bundle in poses.values()):
        raise ValueError("办公室角色配置无效。")
    core_hashes = set()
    for bundle in poses.values():
        path = bundle.asset(bundle.core_name)
        if path is None:
            raise ValueError("办公室角色运行组件不可用。")
        digest = hashlib.sha256()
        try:
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
        except OSError as exc:
            raise ValueError("办公室角色运行组件不可用。") from exc
        core_hashes.add(digest.digest())
    if len(core_hashes) > 1:
        raise ValueError("办公室各姿态必须使用相同版本的角色运行组件。")
    app = web.Application(middlewares=[local_only], client_max_size=40_000)
    app[SESSIONS], app[TASKS] = {}, set()
    app[DEMO] = demo
    app[WAKE_RUNTIME] = WakeRuntime(factory=wake_factory, asr_factory=asr_factory)
    app[TTS_RUNTIME] = TTSRuntime(command=tts_command)
    if connector is not None:
        app[CONNECTOR] = connector
    if character is not None:
        app[CHARACTER] = character
    app[OFFICE_CHARACTERS] = poses
    if scene is not None:
        app[SCENE] = scene
    app.router.add_get("/health", health)
    app.router.add_get("/ws", websocket)
    app.router.add_get("/wake", wake_socket)
    app.router.add_get("/tts", tts_socket)
    app.router.add_get("/character", character_config)
    app.router.add_get("/character/assets/{name:.*}", character_asset)
    app.router.add_get("/office-character/{pose}", office_character_config)
    app.router.add_get("/office-character/{pose}/assets/{name:.*}", office_character_asset)
    app.router.add_get("/scene", scene_config)
    app.router.add_get("/scene/assets/{name:.*}", scene_asset)
    app.router.add_get("/vendor/shaders/{name}", vendor_shader)
    app.router.add_get("/vendor/{name}", vendor_file)
    app.router.add_get("/", static_file)
    app.router.add_get("/{name}", static_file)
    app.on_cleanup.append(cleanup)
    return app
