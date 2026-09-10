"""Services 本地 API 令牌鉴权测试（阶段 0 / P0-1）。

令牌来源优先级：环境变量 MONA_SERVICES_TOKEN > app data 目录下 services.token
文件 > 随机生成并持久化。`/api/materials/*`、`/api/profile/*`、`/api/office/*`
与股票预检路由必须校验 X-Mona-Token；Office WebSocket 改用一次性 ticket。
"""

from __future__ import annotations

import importlib

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


@pytest.fixture
def auth_env(tmp_path, monkeypatch):
    """隔离令牌状态：独立 app data 目录，无环境变量令牌。"""
    monkeypatch.delenv("MONA_SERVICES_TOKEN", raising=False)
    monkeypatch.setenv("MONA_APP_DATA_DIR", str(tmp_path))
    import mona.materials.auth as auth

    importlib.reload(auth)
    yield auth, tmp_path
    importlib.reload(auth)


def test_token_generated_and_persisted(auth_env):
    auth, tmp_path = auth_env
    token = auth.get_services_token()
    assert token and len(token) >= 32
    # 持久化到文件，二次调用返回同一令牌
    assert (tmp_path / "services.token").read_text(encoding="utf-8").strip() == token
    assert auth.get_services_token() == token


def test_token_env_overrides_file(auth_env, monkeypatch):
    auth, _ = auth_env
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "env-token")
    assert auth.get_services_token() == "env-token"


def test_token_file_reused_across_calls(auth_env):
    auth, tmp_path = auth_env
    (tmp_path / "services.token").write_text("file-token\n", encoding="utf-8")
    assert auth.get_services_token() == "file-token"


def test_is_valid_token(auth_env):
    auth, _ = auth_env
    token = auth.get_services_token()
    assert auth.is_valid_services_token(token)
    assert not auth.is_valid_services_token("wrong")
    assert not auth.is_valid_services_token(None)
    assert not auth.is_valid_services_token("")


async def _make_client() -> TestClient:
    import mona.materials.auth as auth

    async def ok_handler(_req: web.Request) -> web.Response:
        return web.json_response({"ok": True})

    app = web.Application(middlewares=[auth.materials_auth_middleware])
    app.router.add_get("/api/materials/files", ok_handler)
    app.router.add_get("/api/materials/status", ok_handler)
    app.router.add_route("*", "/api/profile", ok_handler)
    app.router.add_route("*", "/api/profile/user", ok_handler)
    app.router.add_get("/health", ok_handler)
    app.router.add_get("/api/schedule/items", ok_handler)
    app.router.add_post("/api/stock/research/preflight", ok_handler)
    app.router.add_post("/api/office/sessions", ok_handler)
    app.router.add_get("/api/office/ws", ok_handler)
    return TestClient(TestServer(app))


async def test_materials_route_requires_token(auth_env):
    auth, _ = auth_env
    async with await _make_client() as client:
        resp = await client.get("/api/materials/files")
        assert resp.status == 401

        resp = await client.get("/api/materials/status")
        assert resp.status == 401


async def test_materials_route_accepts_valid_token(auth_env):
    auth, _ = auth_env
    token = auth.get_services_token()
    async with await _make_client() as client:
        resp = await client.get("/api/materials/files", headers={"X-Mona-Token": token})
        assert resp.status == 200

        resp = await client.get("/api/materials/files", headers={"X-Mona-Token": "bad"})
        assert resp.status == 401


async def test_non_materials_routes_unaffected(auth_env):
    async with await _make_client() as client:
        assert (await client.get("/health")).status == 200
        assert (await client.get("/api/schedule/items")).status == 200


async def test_stock_preflight_requires_and_accepts_valid_token(auth_env):
    auth, _ = auth_env
    token = auth.get_services_token()
    async with await _make_client() as client:
        assert (await client.post("/api/stock/research/preflight", json={})).status == 401
        assert (
            await client.post(
                "/api/stock/research/preflight",
                json={},
                headers={"X-Mona-Token": token},
        )
        ).status == 200


async def test_profile_routes_require_and_accept_valid_token(auth_env):
    auth, _ = auth_env
    token = auth.get_services_token()
    async with await _make_client() as client:
        assert (await client.get("/api/profile")).status == 401
        assert (await client.get("/api/profile/user")).status == 401
        assert (
            await client.get(
                "/api/profile",
                headers={"X-Mona-Token": token},
            )
        ).status == 200
        assert (
            await client.get(
                "/api/profile/user",
                headers={"X-Mona-Token": token},
            )
        ).status == 200


async def test_profile_options_are_not_rejected_by_token_middleware(auth_env):
    async with await _make_client() as client:
        response = await client.options("/api/profile")
        assert response.status == 200


async def test_office_http_requires_token_but_socket_uses_ticket_auth(auth_env):
    auth, _ = auth_env
    token = auth.get_services_token()
    async with await _make_client() as client:
        assert (await client.post("/api/office/sessions", json={})).status == 401
        assert (
            await client.post(
                "/api/office/sessions",
                json={},
                headers={"X-Mona-Token": token},
            )
        ).status == 200
        assert (await client.get("/api/office/ws")).status == 200
