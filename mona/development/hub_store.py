"""Durable origins for main-assistant requests; never replays development work."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any, Literal

from pydantic import Field

from mona.development.contracts import Contract, Identifier, now
from mona.development.store import ConflictError, DevelopmentStore


def hub_id(*parts: str) -> str:
    return "hub_" + hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()[:40]


class HubRequest(Contract):
    id: Identifier
    source_session_key: str
    source_channel: str
    source_chat_id: str
    source_created_at: str
    source_message_id: str | None = None
    action: Literal["create_session", "send_task"]
    fingerprint: str
    project_id: Identifier | None = None
    session_id: Identifier | None = None
    state: Literal["prepared", "accepted", "rejected", "unknown"] = "prepared"
    receipt: dict[str, Any] = Field(default_factory=dict)
    error_code: str | None = None
    notified: list[str] = Field(default_factory=list)
    finished: bool = False
    created_at: datetime = Field(default_factory=now)


class HubStore:
    def __init__(self, store: DevelopmentStore):
        self.store = store
        with store._connection(write=True) as db:
            db.execute("CREATE TABLE IF NOT EXISTS hub_requests (id TEXT PRIMARY KEY, "
                       "source_session_key TEXT NOT NULL, payload TEXT NOT NULL)")
            db.execute("CREATE INDEX IF NOT EXISTS hub_requests_source ON hub_requests(source_session_key)")

    def begin(self, record: HubRequest) -> tuple[HubRequest, bool]:
        with self.store._connection(write=True) as db:
            previous = db.execute("SELECT payload FROM hub_requests WHERE id=?", (record.id,)).fetchone()
            if previous:
                value = HubRequest.model_validate_json(previous[0])
                if value.source_session_key != record.source_session_key or value.fingerprint != record.fingerprint:
                    raise ConflictError("相同请求标识不能更换任务、目标或参数；原请求未重复执行。")
                return value, False
            db.execute("INSERT INTO hub_requests VALUES(?,?,?)",
                       (record.id, record.source_session_key, record.model_dump_json()))
        return record, True

    def save(self, record: HubRequest) -> None:
        with self.store._connection(write=True) as db:
            db.execute("UPDATE hub_requests SET payload=? WHERE id=?", (record.model_dump_json(), record.id))

    def list(self, source_session_key: str | None = None, *, pending: bool = False) -> list[HubRequest]:
        query, args = "SELECT payload FROM hub_requests", []
        if source_session_key is not None:
            query += " WHERE source_session_key=?"
            args.append(source_session_key)
        if pending:
            query += (" AND" if args else " WHERE") + " json_extract(payload,'$.finished')=0"
        with self.store._connection() as db:
            return [HubRequest.model_validate_json(row[0]) for row in db.execute(query + " ORDER BY rowid DESC", args)]
