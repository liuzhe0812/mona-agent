"""Local development terminal with an explicitly simulated session connector."""

from __future__ import annotations

import asyncio
import ipaddress
import json
from collections import OrderedDict
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

from . import __version__
from .protocol import PROTOCOL_VERSION, ClientMessage, ProtocolError, event, parse_message

WEB_ROOT = Path(__file__).resolve().parent / "web"
STATIC_FILES = {"index.html", "app.js", "style.css", "mona-original.png"}
MAX_RECORDS = 100


@dataclass
class InputRecord:
    text: str
    state: str = "accepted"
    reply: str = ""


@dataclass
class DemoSession:
    records: OrderedDict[str, InputRecord] = field(default_factory=OrderedDict)
    listeners: set[web.WebSocketResponse] = field(default_factory=set)
    pending_id: str | None = None

    def snapshot(self, session_id: str) -> dict:
        return event(
            "session.snapshot", session_id, mode="demo", state="thinking" if self.pending_id else "idle",
            pending_id=self.pending_id,
            records=[{"message_id": key, "text": record.text, "state": record.state, "reply": record.reply}
                     for key, record in self.records.items()],
        )


SESSIONS = web.AppKey("sessions", dict[str, DemoSession])
TASKS = web.AppKey("tasks", set[asyncio.Task])


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
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self' data:; connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*; "
        "object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    )
    return response


async def health(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "module": "mona-interaction", "version": __version__,
                              "protocol_version": PROTOCOL_VERSION, "mode": "demo"})


async def static_file(request: web.Request) -> web.FileResponse:
    name = request.match_info.get("name", "index.html")
    if name not in STATIC_FILES:
        raise web.HTTPNotFound()
    path = (WEB_ROOT / name).resolve()
    if not path.is_relative_to(WEB_ROOT) or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path)


async def broadcast(session: DemoSession, message: dict) -> None:
    for listener in tuple(session.listeners):
        try:
            await listener.send_json(message)
        except (ConnectionError, RuntimeError):
            session.listeners.discard(listener)


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


async def accept_command(app: web.Application, session: DemoSession, command: ClientMessage,
                         ws: web.WebSocketResponse) -> None:
    if command.type == "session.sync":
        await ws.send_json(session.snapshot(command.session_id))
        return
    previous = session.records.get(command.message_id)
    if previous is not None:
        if previous.text != command.text:
            raise ProtocolError("这条消息的标识已用于其他内容，请重新发送。")
        await ws.send_json(session.snapshot(command.session_id))
        return
    if session.pending_id is not None:
        raise ProtocolError("上一条内容仍在处理中，请等回复结束后再发送。")
    while len(session.records) >= MAX_RECORDS:
        session.records.popitem(last=False)
    session.records[command.message_id] = InputRecord(command.text)
    session.pending_id = command.message_id
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
    try:
        async for message in ws:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                command = parse_message(json.loads(message.data))
                if session_id is None:
                    session_id = command.session_id
                    sessions = request.app[SESSIONS]
                    if session_id not in sessions and len(sessions) >= 32:
                        raise ProtocolError("演示会话数量已达上限，请重启交互程序后继续。")
                    session = sessions.setdefault(session_id, DemoSession())
                    session.listeners.add(ws)
                elif session_id != command.session_id:
                    raise ProtocolError("连接期间不能切换会话。")
                assert session is not None
                await accept_command(request.app, session, command, ws)
            except (ProtocolError, json.JSONDecodeError) as exc:
                text = str(exc) if isinstance(exc, ProtocolError) else "消息格式无效。"
                await ws.send_json(event("error", session_id or "", code="invalid_input", message=text))
    finally:
        if session is not None:
            session.listeners.discard(ws)
    return ws


async def cleanup(app: web.Application) -> None:
    for session in app[SESSIONS].values():
        for listener in tuple(session.listeners):
            await listener.close(code=1001, message=b"shutdown")
    tasks = tuple(app[TASKS])
    for task in tasks:
        task.cancel()
    for task in tasks:
        with suppress(asyncio.CancelledError):
            await task


def create_app() -> web.Application:
    app = web.Application(middlewares=[local_only], client_max_size=40_000)
    app[SESSIONS], app[TASKS] = {}, set()
    app.router.add_get("/health", health)
    app.router.add_get("/ws", websocket)
    app.router.add_get("/", static_file)
    app.router.add_get("/{name}", static_file)
    app.on_cleanup.append(cleanup)
    return app
