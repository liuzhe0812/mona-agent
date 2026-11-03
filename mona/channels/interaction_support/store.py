"""Durable admission and result records for terminal requests."""

import json
import sqlite3
from pathlib import Path


class RequestStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("""CREATE TABLE IF NOT EXISTS requests (
            session_id TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT NOT NULL,
            status TEXT NOT NULL, parts TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY (session_id, message_id))""")
        self.db.execute("UPDATE requests SET status='unknown' WHERE status='accepted'")
        self.db.commit()

    def get(self, session_id: str, message_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM requests WHERE session_id=? AND message_id=?",
                              (session_id, message_id)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["parts"] = json.loads(result["parts"])
        return result

    def snapshot(self, session_id: str) -> list[dict]:
        rows = self.db.execute("SELECT message_id FROM requests WHERE session_id=? ORDER BY rowid DESC LIMIT 100",
                               (session_id,)).fetchall()
        return [self.get(session_id, row["message_id"]) for row in reversed(rows)]

    def admit(self, session_id: str, message_id: str, text: str) -> bool:
        previous = self.get(session_id, message_id)
        if previous is not None:
            if previous["text"] != text:
                raise ValueError("消息标识已经用于其他内容。")
            return False
        pending = self.db.execute(
            "SELECT 1 FROM requests WHERE session_id=? AND status IN ('accepted','unknown') LIMIT 1",
            (session_id,),
        ).fetchone()
        if pending:
            raise ValueError("上一条内容仍在处理或需要核对结果，请先核对原会话。")
        self.db.execute("INSERT INTO requests(session_id,message_id,text,status) VALUES(?,?,?,'accepted')",
                        (session_id, message_id, text))
        self.db.commit()
        return True

    def append(self, session_id: str, message_id: str, text: str) -> None:
        record = self.get(session_id, message_id)
        if record is None or record["status"] != "accepted":
            return
        parts = [*record["parts"], text]
        self.db.execute("UPDATE requests SET parts=? WHERE session_id=? AND message_id=?",
                        (json.dumps(parts, ensure_ascii=False), session_id, message_id))
        self.db.commit()

    def finish(self, session_id: str, message_id: str, status: str) -> dict | None:
        self.db.execute("UPDATE requests SET status=? WHERE session_id=? AND message_id=? AND status='accepted'",
                        (status, session_id, message_id))
        self.db.commit()
        return self.get(session_id, message_id)

    def close(self) -> None:
        self.db.close()

    def acknowledge_unknown(self, session_id: str, message_id: str) -> None:
        record = self.get(session_id, message_id)
        if record is None or record["status"] not in {"unknown", "closed_unknown"}:
            raise ValueError("这条请求不需要结束核对。")
        self.db.execute("UPDATE requests SET status='closed_unknown' WHERE session_id=? AND message_id=?",
                        (session_id, message_id))
        self.db.commit()
