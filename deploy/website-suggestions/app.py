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


class Moderation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    hidden: bool


class SuggestionError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def connect(database: Path):
    connection = sqlite3.connect(database, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def public_item(row: sqlite3.Row) -> dict:
    return {"id": str(row["id"]), **{key: row[key] for key in ("body", "display_name", "created_at")}}


def admin_item(row: sqlite3.Row) -> dict:
    return {**public_item(row), **{key: row[key] for key in ("account_id", "state", "moderated_at", "moderated_by")}}


def cursor_value(before: str | None) -> int:
    if before is not None and (not re.fullmatch(r"[1-9][0-9]{0,18}", before) or int(before) > 9223372036854775807):
        raise SuggestionError(422, "invalid_cursor", "请刷新页面后重试。")
    return int(before) if before else 9223372036854775807


async def json_body(request: Request, schema):
    if request.headers.get("origin") != "https://mona-ai.cn":
        raise SuggestionError(403, "invalid_origin", "请从 Mona 官网操作。")
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise SuggestionError(415, "json_required", "请通过页面表单操作。")
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 8192:
            raise SuggestionError(413, "body_too_large", "内容过长，请缩短后重试。")
    try:
        return schema.model_validate_json(raw)
    except ValidationError:
        raise SuggestionError(422, "invalid_suggestion", "请检查输入内容；建议支持 1–1000 字文字、表情和换行。") from None


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
            columns = {row[1] for row in db.execute("PRAGMA table_info(suggestions)")}
            for column, definition in {"state": "TEXT NOT NULL DEFAULT 'public'", "moderated_by": "TEXT", "moderated_at": "TEXT"}.items():
                if column not in columns:
                    db.execute(f"ALTER TABLE suggestions ADD COLUMN {column} {definition}")
            db.execute("PRAGMA user_version=2")
        async with httpx.AsyncClient(timeout=5, trust_env=False, follow_redirects=False, transport=transport) as client:
            app.state.identity_client = client
            yield

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    async def identity(request: Request, admin: bool = False) -> dict:
        authorization = request.headers.get("authorization", "")
        if not re.fullmatch(r"Bearer [A-Za-z0-9_.-]{1,4096}", authorization):
            raise SuggestionError(401, "login_required", "请先登录后再操作。")
        route = "/auth/identity/admin" if admin else "/auth/web/profile"
        try:
            response = await app.state.identity_client.get(settings.auth_origin + route,
                headers={"Authorization": authorization, "Accept": "application/json"})
        except httpx.HTTPError:
            raise SuggestionError(503, "identity_unavailable", "登录状态暂时无法确认，请稍后重试。") from None
        if response.status_code == 403 and admin:
            raise SuggestionError(403, "admin_required", "只有管理员可以管理建议。")
        if response.status_code in {401, 403}:
            raise SuggestionError(401, "login_required", "登录已失效，请重新登录。")
        if response.status_code != 200:
            raise SuggestionError(503, "identity_unavailable", "登录状态暂时无法确认，请稍后重试。")
        try:
            value = response.json()
            account_id = value["account_id" if admin else "id"]
            if not isinstance(account_id, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", account_id):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise SuggestionError(503, "identity_unavailable", "登录状态暂时无法确认，请稍后重试。") from None
        return value

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
        with closing(connect(settings.database)) as db:
            rows = db.execute("SELECT * FROM suggestions WHERE state='public' AND id < ? ORDER BY id DESC LIMIT 21",
                              (cursor_value(before),)).fetchall()
        return {"items": [public_item(row) for row in rows[:20]], "next_before": str(rows[19]["id"]) if len(rows) > 20 else None}

    @app.get("/api/suggestions/admin")
    async def admin_list(request: Request, state: str = "all", before: str | None = None):
        await identity(request, admin=True)
        if state not in {"all", "public", "hidden"}:
            raise SuggestionError(422, "invalid_state", "请选择有效的建议状态。")
        with closing(connect(settings.database)) as db:
            rows = db.execute("SELECT * FROM suggestions WHERE state!='deleted' AND (?='all' OR state=?) AND id < ? ORDER BY id DESC LIMIT 21",
                              (state, state, cursor_value(before))).fetchall()
        return {"items": [admin_item(row) for row in rows[:20]], "next_before": str(rows[19]["id"]) if len(rows) > 20 else None}

    async def moderate(request: Request, suggestion_id: int, state: str):
        actor = await identity(request, admin=True)
        if request.headers.get("origin") != settings.origin:
            raise SuggestionError(403, "invalid_origin", "请从 Mona 官网操作。")
        if suggestion_id <= 0 or suggestion_id > 9223372036854775807:
            raise SuggestionError(404, "suggestion_not_found", "这条建议已不存在，请刷新列表。")
        with closing(connect(settings.database)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM suggestions WHERE id=?", (suggestion_id,)).fetchone()
            if row is None:
                raise SuggestionError(404, "suggestion_not_found", "这条建议已不存在，请刷新列表。")
            if row["state"] == "deleted" and state != "deleted":
                raise SuggestionError(409, "suggestion_deleted", "这条建议已删除，请刷新列表。")
            if row["state"] != state:
                db.execute("UPDATE suggestions SET state=?,moderated_by=?,moderated_at=? WHERE id=?",
                           (state, actor["account_id"], datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), suggestion_id))
            row = db.execute("SELECT * FROM suggestions WHERE id=?", (suggestion_id,)).fetchone()
        return {"id": str(suggestion_id), "state": "deleted"} if state == "deleted" else admin_item(row)

    @app.patch("/api/suggestions/admin/{suggestion_id}")
    async def admin_update(suggestion_id: int, request: Request):
        body = await json_body(request, Moderation)
        return await moderate(request, suggestion_id, "hidden" if body.hidden else "public")

    @app.delete("/api/suggestions/admin/{suggestion_id}")
    async def admin_delete(suggestion_id: int, request: Request):
        return await moderate(request, suggestion_id, "deleted")

    @app.post("/api/suggestions", status_code=201)
    async def submit(request: Request):
        if request.headers.get("origin") != settings.origin:
            raise SuggestionError(403, "invalid_origin", "请从 Mona 官网提交建议。")
        authorization = request.headers.get("authorization", "")
        if not re.fullmatch(r"Bearer [A-Za-z0-9_.-]{1,4096}", authorization):
            raise SuggestionError(401, "login_required", "请先登录后再发布建议。")
        body = await json_body(request, Submission)
        profile = await identity(request)
        try:
            account_id, name = profile["id"], profile["display_name"]
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
                if row["state"] != "public":
                    raise SuggestionError(409, "suggestion_moderated", "这条建议已由管理员处理，请刷新列表查看。")
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
