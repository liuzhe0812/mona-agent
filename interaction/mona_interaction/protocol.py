"""Version-one messages between the terminal and its session connector."""

from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1
MAX_TEXT_LENGTH = 8_000


class ProtocolError(ValueError):
    pass


@dataclass(frozen=True)
class ClientMessage:
    type: str
    session_id: str
    message_id: str
    text: str = ""
    resolve_id: str = ""


def parse_message(raw: Any) -> ClientMessage:
    if (not isinstance(raw, dict) or type(raw.get("version")) is not int
            or raw["version"] != PROTOCOL_VERSION):
        raise ProtocolError("消息版本不受支持，请更新交互程序。")
    kind = raw.get("type")
    if kind not in {"input.text", "session.sync", "input.resolve"}:
        raise ProtocolError("不支持此交互操作。")
    for key in ("session_id", "message_id"):
        value = raw.get(key)
        if not isinstance(value, str) or not 1 <= len(value) <= 128:
            raise ProtocolError("会话或消息标识无效。")
    payload = raw.get("payload", {})
    if not isinstance(payload, dict):
        raise ProtocolError("消息内容格式无效。")
    text = payload.get("text", "")
    if kind == "input.text" and (
        not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH
    ):
        raise ProtocolError("请输入有效内容，最多 8000 个字符。")
    resolve_id = payload.get("message_id", "") if kind == "input.resolve" else ""
    if kind == "input.resolve" and (
        not isinstance(resolve_id, str) or not 1 <= len(resolve_id) <= 128
        or payload.get("acknowledged") is not True
    ):
        raise ProtocolError("请先核对原请求的实际结果。")
    return ClientMessage(kind, raw["session_id"], raw["message_id"], text if kind == "input.text" else "", resolve_id)


def event(kind: str, session_id: str, *, message_id: str | None = None, **payload: Any) -> dict:
    result = {"version": PROTOCOL_VERSION, "type": kind, "session_id": session_id, "payload": payload}
    if message_id is not None:
        result["message_id"] = message_id
    return result
