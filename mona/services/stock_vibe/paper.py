"""Bounded Host routes for the native local reference-price account."""
from __future__ import annotations

import json
import re
from collections.abc import Callable

from aiohttp import web
from pydantic import Field, field_validator

from mona.services.stock_vibe.client import StockVibeClient
from mona.services.stock_vibe.contracts import HostInput


class PaperCreateAccount(HostInput):
    initial_cash: float = Field(gt=0, le=1_000_000_000, allow_inf_nan=False, strict=True)


class PaperResearch(HostInput):
    session_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    attempt_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")


class PaperCommitTrade(HostInput):
    preview_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,128}$")
    note: str = Field(default="", max_length=500)
    research: PaperResearch | None = None


class PaperPreviewQuery(HostInput):
    symbol: str = Field(pattern=r"^[0-9]{6}\.(SH|SZ|BJ)$")
    side: str = Field(pattern=r"^(buy|sell)$")
    quantity: int = Field(ge=1, le=10_000_000)

    @field_validator("quantity", mode="before")
    @classmethod
    def decimal_integer(cls, value):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,8}", value):
            raise ValueError("quantity must be a decimal integer")
        return int(value)


class PaperTradesQuery(HostInput):
    limit: int = Field(default=20, ge=1, le=100)
    offset: int = Field(default=0, ge=0, le=1_000_000)

    @field_validator("limit", "offset", mode="before")
    @classmethod
    def decimal_integer(cls, value):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,8}", value):
            raise ValueError("pagination must use decimal integers")
        return int(value)


def _query(request: web.Request, model: type[HostInput]) -> dict:
    if len(request.query) != len(set(request.query)):
        raise ValueError("duplicate query parameter")
    return model.model_validate(dict(request.query)).model_dump()


async def _body(request: web.Request, model: type[HostInput]) -> dict:
    raw = await request.read()
    if len(raw) > 8192:
        raise web.HTTPRequestEntityTooLarge(max_size=8192, actual_size=len(raw))
    return model.model_validate(json.loads(raw)).model_dump(mode="json", exclude_none=True)


def register_paper_routes(app: web.Application, client: StockVibeClient, submit: Callable,
                          submission_response: Callable) -> None:
    async def account(request: web.Request) -> web.Response:
        if request.query:
            raise ValueError("unexpected account query")
        return web.json_response(await client.read("/mona/paper/account"), headers={"Cache-Control": "no-store"})

    async def preview(request: web.Request) -> web.Response:
        return web.json_response(await client.read("/mona/paper/preview", params=_query(request, PaperPreviewQuery)),
                                 headers={"Cache-Control": "no-store"})

    async def trades(request: web.Request) -> web.Response:
        return web.json_response(await client.read("/mona/paper/trades", params=_query(request, PaperTradesQuery)),
                                 headers={"Cache-Control": "no-store"})

    async def create(request: web.Request) -> web.Response:
        if request.query:
            raise ValueError("unexpected account query")
        result = await submit(request, request.headers.get("X-Mona-Request-ID", ""), "POST", "/mona/paper/account",
                              await _body(request, PaperCreateAccount))
        return submission_response(result)

    async def commit(request: web.Request) -> web.Response:
        if request.query:
            raise ValueError("unexpected trade query")
        result = await submit(request, request.headers.get("X-Mona-Request-ID", ""), "POST", "/mona/paper/trades",
                              await _body(request, PaperCommitTrade))
        return submission_response(result)

    app.router.add_get("/api/stock-vibe/paper/account", account)
    app.router.add_post("/api/stock-vibe/paper/account", create)
    app.router.add_get("/api/stock-vibe/paper/preview", preview)
    app.router.add_get("/api/stock-vibe/paper/trades", trades)
    app.router.add_post("/api/stock-vibe/paper/trades", commit)
