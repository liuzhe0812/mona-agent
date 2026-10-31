import importlib.util
import json
import sqlite3
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

spec = importlib.util.spec_from_file_location("suggestions_app", Path(__file__).with_name("app.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@pytest.fixture
def service(tmp_path):
    state = {"revoked": False, "unavailable": False, "calls": 0, "admin": True}

    def identity(request):
        assert request.url.path in {"/auth/web/profile", "/auth/identity/admin"}
        state["calls"] += 1
        if state["unavailable"]:
            raise httpx.ConnectError("identity unavailable")
        token = request.headers.get("authorization", "")
        if state["revoked"] or not token.startswith(("Bearer test-session-", "Bearer test-admin-")):
            return httpx.Response(401)
        if request.url.path == "/auth/identity/admin":
            return httpx.Response(200, json={"account_id": "9"}) if state["admin"] and token.startswith("Bearer test-admin-") else httpx.Response(403)
        return httpx.Response(200, json={"id": token.rsplit("-", 1)[1], "display_name": "测试用户 💡", "email": "private@example.com"})

    settings = module.Settings(database=(tmp_path / "suggestions.sqlite3").resolve())
    app = module.create_app(settings, httpx.MockTransport(identity))
    with TestClient(app) as client:
        yield client, settings, state


def post(client, text="建议支持快捷操作 👍\n谢谢！", request_id=None, account="1", **kwargs):
    headers = {"Origin": "https://mona-ai.cn", "Authorization": "Bearer test-session-" + account, "Content-Type": "application/json"}
    headers.update(kwargs.pop("headers", {}))
    return client.post("/api/suggestions", content=json.dumps({"body": text, "request_id": request_id or str(uuid4())}), headers=headers, **kwargs)


def test_real_storage_unicode_public_projection_and_restart(service):
    client, settings, _ = service
    body = "文字 👩🏽‍💻 ❤️\n<img src=x onerror=alert(1)>"
    result = post(client, body)
    assert result.status_code == 201
    value = result.json()
    assert value["body"] == body
    assert set(value) == {"id", "body", "display_name", "created_at"}
    assert value["created_at"].endswith("Z")
    assert client.get("/api/suggestions").json()["items"] == [value]
    with TestClient(module.create_app(settings)) as restarted:
        assert restarted.get("/api/suggestions").json()["items"] == [value]
        assert restarted.get("/healthz").json()["service"] == "mona-website-suggestions"


def test_anonymous_cross_origin_and_revoked_session_cannot_write(service):
    client, _, state = service
    assert post(client, headers={"Authorization": ""}).status_code == 401
    assert post(client, headers={"Origin": "https://evil.example"}).status_code == 403
    assert post(client, headers={"Origin": ""}).status_code == 403
    assert state["calls"] == 0
    identifier = str(uuid4())
    assert post(client, request_id=identifier).status_code == 201
    state["revoked"] = True
    assert post(client, request_id=identifier).status_code == 401
    assert len(client.get("/api/suggestions").json()["items"]) == 1


def test_idempotent_retry_conflict_rate_limit_and_account_scope(service):
    client, _, _ = service
    identifier = str(uuid4())
    first = post(client, request_id=identifier)
    assert post(client, request_id=identifier).json() == first.json()
    assert post(client, "改变后的正文", request_id=identifier).status_code == 409
    assert post(client).status_code == 429
    assert post(client, request_id=identifier, account="2").status_code == 201
    assert len(client.get("/api/suggestions").json()["items"]) == 2


@pytest.mark.parametrize("text", ["  \n ", "x" * 1001, "bad\x00text", "bad\ud800text"])
def test_invalid_body_does_not_echo_input(service, text):
    client, _, state = service
    response = post(client, text)
    assert response.status_code == 422
    assert "input" not in response.json()
    assert state["calls"] == 0


def test_streamed_oversize_and_unknown_fields_rejected(service):
    client, _, state = service
    headers = {"Origin": "https://mona-ai.cn", "Authorization": "Bearer test-session-1", "Content-Type": "application/json"}
    result = client.post("/api/suggestions", headers=headers, content=iter([b"a" * 4096, b"b" * 4097]))
    assert result.status_code == 413
    result = client.post("/api/suggestions", headers=headers, json={"body": "ok", "request_id": str(uuid4()), "account_id": "another"})
    assert result.status_code == 422
    assert state["calls"] == 0


def test_auth_failure_is_not_saved_and_pagination_has_no_gaps(service):
    client, settings, state = service
    state["unavailable"] = True
    assert post(client).status_code == 503
    assert client.get("/api/suggestions").json()["items"] == []
    state["unavailable"] = False
    with sqlite3.connect(settings.database) as db:
        for index in range(25):
            db.execute("INSERT INTO suggestions(account_id,request_id,body,display_name,created_at) VALUES(?,?,?,?,?)",
                       (str(index + 1), str(uuid4()), str(index), "测试", "2026-10-31T00:00:00.000000Z"))
    page1 = client.get("/api/suggestions").json()
    assert len(page1["items"]) == 20
    page2 = client.get("/api/suggestions", params={"before": page1["next_before"]}).json()
    assert len(page2["items"]) == 5 and page2["next_before"] is None
    assert len({row["id"] for row in page1["items"] + page2["items"]}) == 25
    assert client.get("/api/suggestions?before=-1").status_code == 422
    assert client.get("/api/suggestions?before=9999999999999999999999").status_code == 422
    assert client.get("/api/suggestions").headers["cache-control"] == "no-store"


def test_admin_moderation_is_live_authorized_and_filters_public_list(service):
    client, settings, state = service
    request_id = str(uuid4())
    created = post(client, request_id=request_id).json()
    route = "/api/suggestions/admin/" + created["id"]
    admin = {"Authorization": "Bearer test-admin-9", "Origin": "https://mona-ai.cn"}
    regular = {"Authorization": "Bearer test-session-1", "Origin": "https://mona-ai.cn"}
    assert client.get("/api/suggestions/admin").status_code == 401
    assert client.get("/api/suggestions/admin", headers=regular).status_code == 403
    assert client.patch(route, headers=regular, json={"hidden": True}).status_code == 403
    assert client.delete(route, headers=regular).status_code == 403
    hidden = client.patch(route, headers=admin, json={"hidden": True})
    assert hidden.status_code == 200 and hidden.json()["state"] == "hidden"
    assert hidden.json()["moderated_by"] == "9"
    assert client.get("/api/suggestions").json()["items"] == []
    assert client.get("/api/suggestions/admin?state=hidden", headers=admin).json()["items"][0]["id"] == created["id"]
    assert post(client, request_id=request_id).status_code == 409
    state["admin"] = False
    assert client.patch(route, headers=admin, json={"hidden": False}).status_code == 403
    state["admin"] = True
    assert client.patch(route, headers=admin, json={"hidden": False}).json()["state"] == "public"
    assert len(client.get("/api/suggestions").json()["items"]) == 1
    assert client.delete(route, headers=admin).json() == {"id": created["id"], "state": "deleted"}
    assert client.delete(route, headers=admin).status_code == 200
    assert client.get("/api/suggestions").json()["items"] == []
    assert client.get("/api/suggestions/admin", headers=admin).json()["items"] == []
    assert client.patch(route, headers=admin, json={"hidden": False}).status_code == 409
    assert post(client, request_id=request_id).status_code == 409
    with sqlite3.connect(settings.database) as db:
        assert db.execute("SELECT state FROM suggestions WHERE id=?", (created["id"],)).fetchone() == ("deleted",)
    state["revoked"] = True
    assert client.get("/api/suggestions/admin", headers=admin).status_code == 401


def test_admin_origin_validation_and_dependency_failure_cannot_change_rows(service):
    client, _, state = service
    row = post(client).json()
    route = "/api/suggestions/admin/" + row["id"]
    headers = {"Authorization": "Bearer test-admin-9", "Origin": "https://evil.example"}
    assert client.patch(route, headers=headers, json={"hidden": True}).status_code == 403
    assert client.delete(route, headers=headers).status_code == 403
    headers["Origin"] = "https://mona-ai.cn"
    assert client.patch(route, headers=headers, json={"hidden": "false"}).status_code == 422
    assert client.patch(route, headers=headers, json={"hidden": True, "account_id": "9"}).status_code == 422
    state["unavailable"] = True
    assert client.delete(route, headers=headers).status_code == 503
    assert client.get("/api/suggestions/admin", headers=headers).status_code == 503
    assert client.get("/api/suggestions").json()["items"] == [row]


def test_legacy_database_migration_preserves_real_rows(tmp_path):
    path = (tmp_path / "legacy.sqlite3").resolve()
    with sqlite3.connect(path) as db:
        db.execute("CREATE TABLE suggestions(id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, request_id TEXT NOT NULL, body TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(account_id,request_id))")
        db.execute("INSERT INTO suggestions(account_id,request_id,body,display_name,created_at) VALUES(?,?,?,?,?)", ("1", str(uuid4()), "原建议 👩🏽‍💻", "原作者", "2026-10-31T00:00:00Z"))
    settings = module.Settings(database=path)
    for _ in range(2):
        with TestClient(module.create_app(settings)) as client:
            assert client.get("/api/suggestions").json()["items"][0]["body"] == "原建议 👩🏽‍💻"
    with sqlite3.connect(path) as db:
        assert db.execute("PRAGMA user_version").fetchone() == (2,)
        assert db.execute("SELECT state,moderated_by,moderated_at FROM suggestions").fetchone() == ("public", None, None)
