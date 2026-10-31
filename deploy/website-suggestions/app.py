"""Standalone website suggestions; Auth is consumed only for website identity."""

import argparse
import json
import logging
import re
import sqlite3
import unicodedata
from contextlib import asynccontextmanager, closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    database: Path
    origin: str = "https://mona-ai.cn"
    auth_origin: str = "http://127.0.0.1:8000"
    port: int = Field(default=8002, ge=1024, le=65535)

    @field_validator("database")
    @classmethod
    def absolute_database(cls, value: Path) -> Path:
        if not value.is_absolute():
            raise ValueError("database must be absolute")
        return value.resolve()

    @field_validator("origin")
    @classmethod
    def canonical_origin(cls, value: str) -> str:
        if value != "https://mona-ai.cn":
            raise ValueError("use the canonical website origin")
        return value

    @field_validator("auth_origin")
    @classmethod
    def local_auth(cls, value: str) -> str:
        if value != "http://127.0.0.1:8000":
            raise ValueError("identity is provided by the local Auth service")
        return value


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    body: str = Field(max_length=1000, repr=False)
    request_id: str = Field(max_length=36)

    @field_validator("body", mode="before")
    @classmethod
    def plain_text(cls, value):
        if not isinstance(value, str):
            raise ValueError("text required")
        value = value.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not value or any(unicodedata.category(char) in {"Cc", "Cs"} and char not in "\n\t" for char in value):
            raise ValueError("invalid text")
        return value

    @field_validator("request_id")
    @classmethod
    def valid_request_id(cls, value: str) -> str:
        parsed = UUID(value)
        if parsed.version != 4 or str(parsed) != value:
            raise ValueError("request id must be a UUID4")
        return value


class SuggestionError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def connect(database: Path):
    connection = sqlite3.connect(database, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def public_item(row: sqlite3.Row) -> dict:
    return {"id": str(row["id"]), **{key: row[key] for key in ("body", "display_name", "created_at")}}


def create_app(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app):
        settings.database.parent.mkdir(parents=True, exist_ok=True)
        with closing(connect(settings.database)) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS suggestions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    body TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    UNIQUE(account_id, request_id)
                );
                CREATE INDEX IF NOT EXISTS suggestions_account_time
                    ON suggestions(account_id, created_at);
            """)
        async with httpx.AsyncClient(timeout=5, trust_env=False, follow_redirects=False, transport=transport) as client:
            app.state.identity_client = client
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def response_headers(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(SuggestionError)
    async def problem_handler(request, error):
        return JSONResponse({"error": error.code, "message": error.message}, status_code=error.status)

    @app.exception_handler(sqlite3.Error)
    async def storage_error(request, error):
        logging.getLogger("suggestions").error("Suggestion storage operation failed: %s", type(error).__name__)
        return JSONResponse({"error": "storage_unavailable", "message": "建议暂时无法保存，请保留内容并稍后重试。"}, status_code=503)

    @app.get("/healthz")
    def health():
        with closing(connect(settings.database)) as db:
            db.execute("SELECT id FROM suggestions LIMIT 1").fetchone()
        return {"status": "ok", "service": "mona-website-suggestions"}

    @app.get("/api/suggestions")
    def list_suggestions(before: str | None = None):
        if before is not None and (not re.fullmatch(r"[1-9][0-9]{0,18}", before) or int(before) > 9223372036854775807):
            raise SuggestionError(422, "invalid_cursor", "请重新打开建议区后查看。")
        with closing(connect(settings.database)) as db:
            rows = db.execute("SELECT * FROM suggestions WHERE id < ? ORDER BY id DESC LIMIT 21",
                              (int(before) if before else 9223372036854775807,)).fetchall()
        return {"items": [public_item(row) for row in rows[:20]], "next_before": str(rows[19]["id"]) if len(rows) > 20 else None}

    @app.post("/api/suggestions", status_code=201)
    async def submit(request: Request):
        if request.headers.get("origin") != settings.origin:
            raise SuggestionError(403, "invalid_origin", "请从 Mona 官网提交建议。")
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise SuggestionError(415, "json_required", "请使用文字建议表单提交。")
        authorization = request.headers.get("authorization", "")
        if not re.fullmatch(r"Bearer [A-Za-z0-9_.-]{1,4096}", authorization):
            raise SuggestionError(401, "login_required", "请先登录后再发布建议。")
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 8192:
                raise SuggestionError(413, "body_too_large", "建议内容过长，请控制在 1000 字以内。")
        try:
            body = Submission.model_validate_json(raw)
        except ValidationError:
            raise SuggestionError(422, "invalid_suggestion", "请填写 1–1000 字的文字建议，可使用表情和换行。") from None
        try:
            response = await app.state.identity_client.get(settings.auth_origin + "/auth/web/profile",
                                                            headers={"Authorization": authorization, "Accept": "application/json"})
        except httpx.HTTPError:
            raise SuggestionError(503, "identity_unavailable", "登录状态暂时无法确认，请保留内容并稍后重试。") from None
        if response.status_code in {401, 403}:
            raise SuggestionError(401, "login_required", "登录已失效，请重新登录后发布。")
        if response.status_code != 200:
            raise SuggestionError(503, "identity_unavailable", "登录状态暂时无法确认，请保留内容并稍后重试。")
        try:
            identity = response.json()
            account_id, name = identity["id"], identity["display_name"]
            if not isinstance(account_id, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", account_id) or not isinstance(name, str) or not 1 <= len(name) <= 64:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise SuggestionError(503, "identity_unavailable", "登录状态暂时无法确认，请保留内容并稍后重试。") from None
        now = datetime.now(timezone.utc)
        timestamp = now.isoformat(timespec="microseconds").replace("+00:00", "Z")
        with closing(connect(settings.database)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM suggestions WHERE account_id=? AND request_id=?", (account_id, body.request_id)).fetchone()
            if row:
                if row["body"] != body.body:
                    raise SuggestionError(409, "request_conflict", "这次提交的内容已改变，请刷新后重新填写。")
                return public_item(row)
            since_hour = datetime.fromtimestamp(now.timestamp() - 3600, timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")
            latest, count = db.execute("SELECT MAX(created_at), COUNT(*) FROM suggestions WHERE account_id=? AND created_at>=?", (account_id, since_hour)).fetchone()
            if count >= 10 or (latest and (now - datetime.fromisoformat(latest.replace("Z", "+00:00"))).total_seconds() < 30):
                raise SuggestionError(429, "rate_limited", "提交过于频繁，请稍后再试。每次发布请间隔 30 秒，每小时最多 10 条。")
            cursor = db.execute("INSERT INTO suggestions(account_id,request_id,body,display_name,created_at) VALUES(?,?,?,?,?)",
                                (account_id, body.request_id, body.body, name, timestamp))
            row = db.execute("SELECT * FROM suggestions WHERE id=?", (cursor.lastrowid,)).fetchone()
        return public_item(row)

    return app


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    settings = Settings.model_validate(json.loads(args.config.read_text(encoding="utf-8")))
    uvicorn.run(create_app(settings), host="127.0.0.1", port=settings.port, access_log=False, server_header=False, proxy_headers=False)
