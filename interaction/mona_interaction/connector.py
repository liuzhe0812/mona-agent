"""Native-service connection to Mona; credentials never enter the web page."""

from __future__ import annotations

import ipaddress
import json
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import aiohttp

from .performance import parse_reply


class ConnectorError(Exception):
    def __init__(self, message: str, *, result_unknown: bool = False):
        super().__init__(message)
        self.result_unknown = result_unknown


@dataclass(frozen=True)
class ConnectionSettings:
    url: str
    token: str

    @classmethod
    def from_file(cls, value: str | Path) -> ConnectionSettings:
        supplied = Path(value).expanduser()
        path = supplied.resolve()
        if not path.is_relative_to(supplied.parent.resolve()) or not path.is_file():
            raise ValueError("连接文件超出允许目录或不存在。")
        if path.stat().st_size > 16_384:
            raise ValueError("连接文件过大。")
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1:
            raise ValueError("连接文件版本无效。")
        url, token = data.get("url"), data.get("token")
        if not isinstance(url, str) or not isinstance(token, str) or not 32 <= len(token) <= 4096:
            raise ValueError("连接文件缺少有效授权信息。")
        target = urlsplit(url)
        if (target.scheme not in {"ws", "wss"} or target.username is not None
                or target.password is not None or target.query or target.fragment or target.path != "/ws"):
            raise ValueError("连接地址格式无效。")
        try:
            local = ipaddress.ip_address(target.hostname or "").is_loopback
            port = target.port
        except ValueError:
            raise ValueError("当前连接仅支持明确的本机地址。") from None
        if not local or port is None or not 1 <= port <= 65535:
            raise ValueError("当前连接仅支持本机服务；远程部署需要单独配置加密连接。")
        return cls(url, token)


def project_record(record: dict) -> dict:
    replies = []
    for part in (record.get("parts", []) if record["status"] != "failed" else []):
        try:
            replies.append(parse_reply(part))
        except (TypeError, ValueError):
            replies.append({"text": "此条回复格式异常，暂时无法展示正文，请查看原会话。",
                            "performance": None, "performance_status": "invalid"})
    latest = next((reply for reply in reversed(replies) if reply["performance"] is not None), None)
    return {
        "message_id": record["message_id"], "text": record["text"], "state": record["status"],
        "reply": "\n\n".join(reply["text"] for reply in replies),
        "performance": latest["performance"] if latest else None,
        "performance_status": latest["performance_status"] if latest else (
            replies[-1]["performance_status"] if replies else "missing"
        ),
    }


class MonaConnector:
    def __init__(self, settings: ConnectionSettings):
        self.settings = settings

    async def _client(self) -> aiohttp.ClientSession:
        trace = aiohttp.TraceConfig()

        async def reject_redirect(*_):
            raise ConnectorError("会话服务返回了意外跳转，连接已停止。")

        trace.on_request_redirect.append(reject_redirect)
        return aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=10),
            trace_configs=[trace], trust_env=False,
        )

    async def _receive(self, ws) -> dict:
        message = await ws.receive()
        if message.type != aiohttp.WSMsgType.TEXT:
            raise ConnectorError("连接已中断，需核对原输入的处理结果。", result_unknown=True)
        data = json.loads(message.data)
        if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1:
            raise ConnectorError("会话服务的消息版本无效。", result_unknown=True)
        return data

    async def lookup(self, session_id: str) -> list[dict]:
        try:
            async with await self._client() as client, client.ws_connect(
                self.settings.url, headers={"Authorization": f"Bearer {self.settings.token}"},
                heartbeat=20, max_msg_size=4 * 1024 * 1024,
            ) as ws:
                await ws.send_json({"version": 1, "type": "session.sync", "session_id": session_id,
                                    "message_id": uuid4().hex, "payload": {}})
                result = await self._receive(ws)
                if result.get("type") != "session.snapshot" or result.get("session_id") != session_id:
                    raise ConnectorError("会话状态暂时无法确认。")
                return result["payload"]["records"]
        except ConnectorError:
            raise
        except (aiohttp.ClientError, OSError, ValueError, KeyError):
            raise ConnectorError("暂时无法连接 Mona，请确认交互渠道已启用且连接文件有效。") from None

    async def request(self, command, on_accepted, *, recovery: bool = False) -> dict:
        # A recovered input was already accepted before this connection.  Even
        # a failure before we send anything leaves its original result unknown.
        sent = recovery
        try:
            async with await self._client() as client, client.ws_connect(
                self.settings.url, headers={"Authorization": f"Bearer {self.settings.token}"},
                heartbeat=20, max_msg_size=4 * 1024 * 1024,
            ) as ws:
                await ws.send_json({"version": 1, "type": "session.sync", "session_id": command.session_id,
                                    "message_id": uuid4().hex, "payload": {}})
                snapshot = await self._receive(ws)
                if snapshot.get("type") != "session.snapshot" or snapshot.get("session_id") != command.session_id:
                    raise ConnectorError("会话状态暂时无法确认。", result_unknown=recovery)
                previous = next((item for item in snapshot["payload"]["records"]
                                 if item["message_id"] == command.message_id), None)
                if previous:
                    if previous["text"] != command.text:
                        raise ConnectorError("消息标识已被用于其他内容。", result_unknown=recovery)
                    if previous["status"] in {"completed", "failed"}:
                        await on_accepted()
                        return project_record(previous)
                    if previous["status"] == "unknown":
                        raise ConnectorError("原输入的结果需要核对，程序没有重新执行。", result_unknown=True)
                    if previous["status"] == "closed_unknown":
                        raise ConnectorError("原请求已结束核对，请发送新的内容。")
                    if previous["status"] != "accepted":
                        raise ConnectorError("原输入的状态无法确认，请先核对原会话。", result_unknown=True)
                    sent = True
                    await on_accepted()
                else:
                    if recovery:
                        raise ConnectorError("未找到原输入的处理记录，结果尚未确认。请先核对原会话；程序没有重新执行。",
                                             result_unknown=True)
                    sent = True
                    await ws.send_json({"version": 1, "type": "input.text", "session_id": command.session_id,
                                        "message_id": command.message_id, "payload": {"text": command.text}})
                while True:
                    result = await self._receive(ws)
                    if result.get("session_id") != command.session_id:
                        continue
                    kind, payload = result.get("type"), result.get("payload", {})
                    if kind == "error":
                        raise ConnectorError(payload.get("message", "这条内容暂时无法处理。"),
                                             result_unknown=recovery or payload.get("code") == "result_unknown")
                    if result.get("message_id") != command.message_id:
                        continue
                    if kind == "input.accepted":
                        await on_accepted()
                    elif kind == "turn.completed":
                        if payload.get("status") == "unknown":
                            raise ConnectorError("原输入的结果需要核对，程序没有重新执行。", result_unknown=True)
                        return project_record({"message_id": command.message_id, "text": command.text,
                                               "status": payload["status"], "parts": payload["parts"]})
        except ConnectorError:
            raise
        except (aiohttp.ClientError, OSError, ValueError, KeyError, TypeError):
            raise ConnectorError(
                "连接中断，请先核对原输入的结果。" if sent else "暂时无法连接 Mona，请检查交互渠道。",
                result_unknown=sent,
            ) from None

    async def acknowledge_unknown(self, session_id: str, message_id: str) -> None:
        try:
            async with await self._client() as client, client.ws_connect(
                self.settings.url, headers={"Authorization": f"Bearer {self.settings.token}"},
                heartbeat=20, max_msg_size=4 * 1024 * 1024,
            ) as ws:
                await ws.send_json({"version": 1, "type": "input.resolve", "session_id": session_id,
                                    "message_id": uuid4().hex,
                                    "payload": {"message_id": message_id, "acknowledged": True}})
                response = await self._receive(ws)
                if response.get("type") != "session.snapshot":
                    raise ConnectorError("核对状态尚未更新，请稍后重试。")
        except ConnectorError:
            raise
        except (aiohttp.ClientError, OSError, ValueError, KeyError):
            raise ConnectorError("核对状态尚未确认，程序不会重新执行原请求。") from None
