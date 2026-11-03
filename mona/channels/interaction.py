"""Authenticated, optional bridge for an independently running interaction terminal."""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import secrets
from pathlib import Path

from aiohttp import WSMsgType, web

from mona.bus.events import OutboundMessage
from mona.channels.base import BaseChannel
from mona.channels.interaction_support.store import RequestStore
from mona.config.paths import get_data_dir
from mona.config.schema import InteractionChannelConfig

_IDENTIFIER = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")


def _event(kind: str, session_id: str, message_id: str = "", **payload) -> dict:
    return {"version": 1, "type": kind, "session_id": session_id,
            "message_id": message_id, "payload": payload}


class InteractionChannel(BaseChannel):
    name = "interaction"
    display_name = "Mona 交互终端"

    def __init__(self, config, bus, *, state_dir: Path | None = None):
        parsed = config if isinstance(config, InteractionChannelConfig) else InteractionChannelConfig.model_validate(config)
        super().__init__(parsed, bus)
        self.state_dir = (state_dir or get_data_dir() / "channels" / "interaction").resolve()
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        database = self.state_dir / "requests.sqlite3"
        if not database.resolve().is_relative_to(self.state_dir):
            raise ValueError("交互记录文件超出允许目录。")
        self.store = RequestStore(database)
        self.connection_file = self.state_dir / "connection.json"
        if self.connection_file.is_symlink():
            raise ValueError("交互连接文件不能是符号链接。")
        existing = json.loads(self.connection_file.read_text(encoding="utf-8")) if self.connection_file.exists() else {}
        token = existing.get("token") if existing.get("device_id") == parsed.device_id else None
        self._token = token if isinstance(token, str) and len(token) >= 32 else secrets.token_urlsafe(32)
        hostname = f"[{parsed.host}]" if ":" in parsed.host else parsed.host
        connection = {"version": 1, "url": f"ws://{hostname}:{parsed.port}/ws",
                      "device_id": parsed.device_id, "token": self._token}
        temporary = self.state_dir / f"connection-{secrets.token_hex(6)}.tmp"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(connection, handle)
        temporary.replace(self.connection_file)
        self._connections: dict[str, set[web.WebSocketResponse]] = {}
        self._runner: web.AppRunner | None = None
        self._stopped = asyncio.Event()

    @classmethod
    def default_config(cls) -> dict:
        return InteractionChannelConfig().model_dump()

    def is_allowed(self, sender_id: str) -> bool:
        return sender_id == self.config.device_id

    def create_app(self) -> web.Application:
        app = web.Application(client_max_size=40_000)
        app.router.add_get("/ws", self._websocket)
        return app

    async def start(self) -> None:
        self._runner = web.AppRunner(self.create_app(), access_log=None)
        await self._runner.setup()
        await web.TCPSite(self._runner, self.config.host, self.config.port).start()
        self._running = True
        self.logger.info("Interaction channel ready")
        await self._stopped.wait()

    async def stop(self) -> None:
        self._running = False
        self._stopped.set()
        for connections in tuple(self._connections.values()):
            for connection in tuple(connections):
                await connection.close(code=1001)
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None
        self.store.close()

    def _store_session(self, session_id: str) -> str:
        return f"{self.config.device_id}:{session_id}"

    def _snapshot(self, session_id: str) -> dict:
        records = self.store.snapshot(self._store_session(session_id))
        for record in records:
            record.pop("session_id", None)
        return _event("session.snapshot", session_id, mode="mona", records=records)

    async def _broadcast(self, session_id: str, message: dict) -> None:
        for connection in tuple(self._connections.get(session_id, ())):
            try:
                await connection.send_json(message)
            except (ConnectionError, RuntimeError):
                self._connections[session_id].discard(connection)

    async def _websocket(self, request: web.Request) -> web.WebSocketResponse:
        supplied = request.headers.get("Authorization", "")
        if request.headers.get("Origin") or not hmac.compare_digest(
            supplied.encode("utf-8"), f"Bearer {self._token}".encode("utf-8")
        ):
            raise web.HTTPUnauthorized(text="交互连接尚未授权。")
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=40_000)
        await ws.prepare(request)
        session_id = ""
        try:
            async for item in ws:
                if item.type != WSMsgType.TEXT:
                    continue
                try:
                    command = json.loads(item.data)
                    if (not isinstance(command, dict) or type(command.get("version")) is not int
                            or command["version"] != 1):
                        raise ValueError("交互协议版本无效。")
                    incoming = command.get("session_id")
                    message_id = command.get("message_id")
                    if (not isinstance(incoming, str) or not _IDENTIFIER.fullmatch(incoming)
                            or not isinstance(message_id, str) or not _IDENTIFIER.fullmatch(message_id)):
                        raise ValueError("消息或会话标识无效。")
                    if session_id and incoming != session_id:
                        raise ValueError("连接期间不能切换会话。")
                    if not session_id:
                        session_id = incoming
                        self._connections.setdefault(session_id, set()).add(ws)
                    kind = command.get("type")
                    if kind == "session.sync":
                        await ws.send_json(self._snapshot(session_id))
                    elif kind == "input.resolve":
                        payload = command.get("payload")
                        target_id = payload.get("message_id") if isinstance(payload, dict) else None
                        if (not isinstance(target_id, str) or not _IDENTIFIER.fullmatch(target_id)
                                or payload.get("acknowledged") is not True):
                            raise ValueError("请先核对原请求的实际结果。")
                        self.store.acknowledge_unknown(self._store_session(session_id), target_id)
                        await ws.send_json(self._snapshot(session_id))
                    elif kind == "input.text":
                        payload = command.get("payload")
                        text = payload.get("text") if isinstance(payload, dict) else None
                        if not isinstance(text, str) or not text.strip() or len(text) > 8000:
                            raise ValueError("请输入有效内容，最多 8000 个字符。")
                        if text.lstrip().startswith("/"):
                            raise ValueError("请使用自然语言描述需求。此终端尚未接入快捷命令。")
                        stored_session = self._store_session(session_id)
                        if not self.store.admit(stored_session, message_id, text):
                            await ws.send_json(self._snapshot(session_id))
                            continue
                        try:
                            accepted = await self._handle_message(
                                self.config.device_id, stored_session, text,
                                session_key=f"{self.name}:{stored_session}",
                                metadata={"origin_message_id": message_id,
                                          "_interaction_message_id": message_id,
                                          "_interaction_session_id": session_id,
                                          "_wants_channel_turn_end": True},
                            )
                        except Exception:
                            self.store.finish(stored_session, message_id, "unknown")
                            self.logger.exception("Interaction input dispatch failed")
                            await ws.send_json(_event("error", session_id, message_id,
                                                      code="result_unknown", message="输入结果需要核对，请先查看原会话。"))
                            continue
                        if not accepted:
                            self.store.finish(stored_session, message_id, "failed")
                            await ws.send_json(_event("error", session_id, message_id,
                                                      code="not_accepted", message="这条内容未被接受，请检查连接授权。"))
                        else:
                            await ws.send_json(_event("input.accepted", session_id, message_id, text=text))
                    else:
                        raise ValueError("不支持此交互操作。")
                except (ValueError, json.JSONDecodeError):
                    await ws.send_json(_event("error", session_id, code="invalid_input",
                                              message="当前输入无法处理，请检查内容或先核对上一条结果。"))
        finally:
            self._connections.get(session_id, set()).discard(ws)
        return ws

    async def send(self, msg: OutboundMessage) -> None:
        metadata = msg.metadata or {}
        session_id = metadata.get("_interaction_session_id")
        message_id = metadata.get("_interaction_message_id")
        if not isinstance(session_id, str) or not isinstance(message_id, str):
            return
        stored_session = self._store_session(session_id)
        if msg.chat_id != stored_session:
            return
        if metadata.get("_channel_turn_end"):
            state = metadata.get("_channel_turn_status")
            status = state if state in {"completed", "failed"} else "unknown"
            record = self.store.finish(stored_session, message_id, status)
            if record is not None:
                await self._broadcast(session_id, _event("turn.completed", session_id, message_id,
                                                       status=record["status"], parts=record["parts"]))
        elif not metadata.get("_progress") and msg.content:
            self.store.append(stored_session, message_id, msg.content)
