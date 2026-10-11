from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import Config, DevelopmentConfig, _resolve_tool_config_refs
from mona.development.api import RUNTIME_KEY, register_development_routes
from mona.development.executors.discovery import discover_executors
from mona.development.runtime import DevelopmentRuntime
from mona.development.store import DevelopmentStore
from mona.session.manager import SessionManager


async def setup_client(tmp_path, monkeypatch, config_loader=Config):
    _resolve_tool_config_refs()
    monkeypatch.setenv("MONA_SERVICES_TOKEN", "synthetic-development-test")
    root = tmp_path / "项目"
    root.mkdir()
    (root / "file.txt").write_text("original\n", encoding="utf-8")
    runtime = DevelopmentRuntime(DevelopmentStore(tmp_path / "state.sqlite3"), SessionManager(tmp_path / "sessions"), config_loader)
    app = web.Application()
    app[RUNTIME_KEY] = runtime
    register_development_routes(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client, runtime, root


AUTH = {"X-Mona-Token": "synthetic-development-test"}


def use_missing_programs(tmp_path, monkeypatch):
    config = DevelopmentConfig(**{f"{name}_path": str(tmp_path / f"missing-{name}.exe")
                                  for name in ("codex", "claude", "codebuddy")})
    monkeypatch.setattr("mona.development.native_manager.discover_executors",
                        lambda _: discover_executors(config, search_path=""))


@pytest.mark.asyncio
async def test_auth_project_sessions_snapshot_and_view(tmp_path, monkeypatch):
    use_missing_programs(tmp_path, monkeypatch)
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    try:
        denied = await client.post("/api/development/projects", json={"path": str(root)})
        assert denied.status == 401 and runtime.store.list_projects() == []
        response = await client.post("/api/development/projects", json={"path": str(root)}, headers=AUTH)
        project = await response.json()
        assert response.status == 200 and project["rootPath"] == str(root.resolve())
        session = await (await client.post(f"/api/development/projects/{project['id']}/sessions", json={}, headers=AUTH)).json()
        response = await client.get(f"/api/development/sessions/{session['id']}/snapshot", headers=AUTH)
        snapshot = await response.json()
        assert response.status == 200 and snapshot["messages"] == [] and snapshot["runs"] == []
        saved = await client.put("/api/development/views/view_test", headers=AUTH, json={"view": {
            "id": "view_test", "projectId": project["id"], "layout": "split2", "focusedPaneId": "pane_1",
            "panes": [{"id": "pane_1", "sessionId": session["id"]}, {"id": "pane_2"}],
        }, "expectedRevision": None})
        assert saved.status == 200 and not runtime.tasks
        caps = await (await client.get("/api/development/capabilities", headers=AUTH)).json()
        assert caps["executors"][0]["available"]
        assert all(not executor["available"] for executor in caps["executors"][1:])
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_file_read_cas_and_path_escape(tmp_path, monkeypatch):
    client, runtime, root = await setup_client(tmp_path, monkeypatch)
    project = runtime.store.open_project(root)
    prefix = f"/api/development/projects/{project.id}"
    try:
        original = await (await client.get(prefix + "/file?path=file.txt", headers=AUTH)).json()
        (root / "file.txt").write_text("manual edit\n", encoding="utf-8")
        conflict = await client.put(prefix + "/file", headers=AUTH, json={"path": "file.txt", "content": "overwrite", "expectedSha256": original["sha256"]})
        assert conflict.status == 409 and (root / "file.txt").read_text() == "manual edit\n"
        current = await (await client.get(prefix + "/file?path=file.txt", headers=AUTH)).json()
        saved = await client.put(prefix + "/file", headers=AUTH, json={"path": "file.txt", "content": "accepted", "expectedSha256": current["sha256"]})
        assert saved.status == 200 and (root / "file.txt").read_text() == "accepted"
        outside = tmp_path / "outside.txt"
        outside.write_text("DO_NOT_READ")
        denied = await client.get(prefix + "/file?path=../outside.txt", headers=AUTH)
        assert denied.status == 422 and "DO_NOT_READ" not in await denied.text()
        negative = await client.get(prefix + "/directory?offset=-1", headers=AUTH)
        assert negative.status == 422
        missing = await client.get(prefix + "/file?path=gone.txt", headers=AUTH)
        assert missing.status == 404
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_non_json_invalid_body_and_native_not_silently_executed(tmp_path, monkeypatch):
    use_missing_programs(tmp_path, monkeypatch)
    config = Config(development=DevelopmentConfig(enabled_engines=["codebuddy"]))
    client, runtime, root = await setup_client(tmp_path, monkeypatch, config_loader=lambda: config)
    project = runtime.store.open_project(root)
    try:
        invalid = await client.post("/api/development/projects", headers=AUTH, data="not json")
        assert invalid.status == 400
        created = await (await client.post(f"/api/development/projects/{project.id}/sessions", headers=AUTH, json={"executor": "codebuddy"})).json()
        failed = await client.post(f"/api/development/sessions/{created['id']}/send", headers=AUTH, json={"requestId": "request_native", "content": "task"})
        assert failed.status == 422 and runtime.store.list_runs(created["id"]) == []
        malformed = await client.get(f"/api/development/sessions/{created['id']}/snapshot?limit=9999", headers=AUTH)
        assert malformed.status == 400
    finally:
        await client.close()


def test_gateway_registration_and_rust_token_contract():
    from mona.api.server import create_app
    app = create_app(None)
    paths = {route.resource.canonical for route in app.router.routes()}
    assert "/api/development/projects" in paths
    rust = (Path(__file__).parents[2] / "src-tauri/src/lib.rs").read_text(encoding="utf-8-sig")
    assert 'path.starts_with("/api/development/")' in rust
    assert 'needs_services_token("/api/development/sessions/id/send")' in rust
