"""Browser-style Origin requests and explicitly approved direct LAN access."""
import os
import subprocess

import pytest
import pytest_asyncio
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from yarl import URL

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.access import private_listener, website_origin
from mona.hosted_work.contracts import owner_key
from mona.hosted_work.frontend import register_frontend
from mona.hosted_work.service import WorkService, create_app
from mona.hosted_work.store import WorkStore


@pytest.mark.parametrize("value", ["0.0.0.0", "::", "8.8.8.8", "169.254.169.254", "224.0.0.1", "example.com"])
def test_no_public_wildcard_or_metadata_listener(value):
    with pytest.raises(ValueError):
        private_listener(value)


@pytest.mark.parametrize("value", ["127.0.0.1", "::1", "172.31.3.176", "10.1.2.3", "192.168.2.4", "fd00::1"])
def test_explicit_private_listener(value):
    assert private_listener(value) == value


def test_lan_http_requires_explicit_opt_in_and_matching_interface():
    config = HostedWorkConfig(public_origin="http://172.31.3.176:17175", bind_host="172.31.3.176")
    with pytest.raises(ValueError):
        website_origin(config)
    config.allow_insecure_lan_http = True
    assert website_origin(config) == "http://172.31.3.176:17175"
    for bad in ["http://172.31.3.177:17175", "http://172.31.3.176:8080", "http://example.com:17175",
                "http://8.8.8.8:17175", "http://user:pass@172.31.3.176:17175", "http://172.31.3.176:17175/?key=x"]:
        config.public_origin = bad
        with pytest.raises(ValueError):
            website_origin(config)
    assert website_origin(HostedWorkConfig(public_origin="https://work.example.invalid/")) == "https://work.example.invalid"


@pytest_asyncio.fixture
async def website(tmp_path):
    static = tmp_path / "ui"
    (static / "assets").mkdir(parents=True)
    (static / "hosted-work.html").write_text('<script type="module" crossorigin src="/work/assets/app.js"></script>', encoding="utf-8")
    (static / "assets/app.js").write_text('document.body.dataset.ready="yes";', encoding="utf-8")
    (static / "assets/app.css").write_text("body {margin: 0;}", encoding="utf-8")
    for editor in ("docs", "sheets", "slides"):
        directory = static / "office-editor" / editor
        directory.mkdir(parents=True)
        (directory / "index.html").write_text("<!doctype html><title>Editor</title>", encoding="utf-8")
    for name, contents in (("office-editor/assets/editor.js", "export const editor = true;"),
                           ("office-editor/assets/editor.css", "body {margin: 0;}"),
                           ("brand/sidebar-app-picker-icons.png", "image"),
                           ("fonts/font.woff2", "font"), ("alphatab/font/example.woff", "font"),
                           ("soundfonts/FluidR3_GM/piano.js", "audio")):
        path = static / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")
    (static / "private.txt").write_text("private", encoding="utf-8")
    config = HostedWorkConfig(public_origin="http://172.31.3.176:17175", bind_host="172.31.3.176",
                              allow_insecure_lan_http=True, frontend_dir=str(static))
    calls = []
    class AuthBoundary:
        async def identity(self, token):
            calls.append(("identity", token))
            return owner_key("1")
        async def login(self, account, password):
            calls.append(("login", account))
            return {"access_token": "synthetic-token"}
    store = WorkStore(tmp_path / "state.sqlite3", config)
    client = TestClient(TestServer(create_app(WorkService(config, store, AuthBoundary(), None))))
    await client.start_server()
    try:
        yield client, calls
    finally:
        await client.close()
        store.close()


@pytest.mark.asyncio
async def test_browser_origin_assets_keep_their_mime_type(website):
    client, calls = website
    for origin in ["http://172.31.3.176:17175", "http://127.0.0.1:17175"]:
        for path, content_type in [("/work/assets/app.js", "javascript"), ("/work/assets/app.css", "text/css")]:
            response = await client.get(path, headers={"Host": "172.31.3.176:17175", "Origin": origin})
            assert response.status == 200
            assert content_type in response.headers["Content-Type"]
            assert response.headers["Cross-Origin-Resource-Policy"] == "same-origin"
    assert not calls


@pytest.mark.asyncio
async def test_shared_office_and_sidebar_assets_are_public(website):
    client, calls = website
    paths = [(f"/work/office-editor/{editor}/index.html", "text/html") for editor in ("docs", "sheets", "slides")]
    paths += [("/work/office-editor/assets/editor.js", "javascript"),
              ("/work/office-editor/assets/editor.css", "text/css"),
              ("/work/brand/sidebar-app-picker-icons.png", "image/png"),
              ("/work/fonts/font.woff2", None),
              ("/work/alphatab/font/example.woff", None),
              ("/work/soundfonts/FluidR3_GM/piano.js", "javascript")]
    for path, content_type in paths:
        for method in ("GET", "HEAD"):
            response = await client.request(method, path, headers={"Host": "172.31.3.176:17175"})
            assert response.status == 200
            if content_type:
                assert content_type in response.headers["Content-Type"]
            assert response.headers["Cross-Origin-Resource-Policy"] == "same-origin"
            assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert not calls


@pytest.mark.asyncio
async def test_frontend_works_without_optional_assets_or_state_dir(tmp_path):
    static = tmp_path / "ui"
    (static / "assets").mkdir(parents=True)
    (static / "hosted-work.html").write_text("<!doctype html>", encoding="utf-8")
    app = web.Application()
    register_frontend(app, HostedWorkConfig(frontend_dir=str(static)))
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        response = await client.get("/work/")
        assert response.status == 200
        assert "font-src 'self' data:;" in response.headers["Content-Security-Policy"]
        assert "script-src 'self';" in response.headers["Content-Security-Policy"]
    finally:
        await client.close()


@pytest.mark.parametrize("location", ["office-editor", "office-editor/docs/shortcut"])
def test_frontend_rejects_linked_static_paths(tmp_path, location):
    static = tmp_path / "ui"
    (static / "assets").mkdir(parents=True)
    (static / "hosted-work.html").write_text("<!doctype html>", encoding="utf-8")
    external = tmp_path / "outside"
    external.mkdir()
    link = static / location
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        link.symlink_to(external, target_is_directory=True)
    except OSError:
        if os.name != "nt":
            pytest.skip("creating symlinks is unavailable on this system")
        if any(char in str(link) + str(external) for char in "&|<>^%!"):
            pytest.skip("temporary path contains Windows command characters")
        subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(external)], check=True, capture_output=True)
    with pytest.raises(ValueError, match="invalid static Work release"):
        register_frontend(web.Application(), HostedWorkConfig(frontend_dir=str(static)))


@pytest.mark.asyncio
async def test_root_and_favicon_are_not_login_protected(website):
    client, calls = website
    response = await client.get("/", allow_redirects=False)
    assert response.status == 302 and response.headers["Location"] == "/work/"
    assert (await client.get("/favicon.ico")).status == 204
    assert (await client.head("/work/assets/app.css", headers={"Origin": "http://172.31.3.176:17175"})).status == 200
    assert not calls


@pytest.mark.asyncio
async def test_lan_api_stays_authenticated_and_rejects_foreign_origins(website):
    client, calls = website
    origin = {"Origin": "http://172.31.3.176:17175", "Host": "172.31.3.176:17175"}
    assert (await client.get("/api/work/sessions", headers=origin)).status == 401
    assert not calls
    response = await client.post("/api/work/auth/login", headers=origin, json={"account": "student", "password": "synthetic"})
    assert response.status == 200
    calls.clear()
    for path, method in [("/api/work/sessions", "GET"), ("/api/work/auth/login", "POST")]:
        response = await client.request(method, path, headers={**origin, "Origin": "https://attacker.invalid", "Authorization": "Bearer synthetic"})
        assert response.status == 403
    assert not calls
    assert (await client.get("/api/work/sessions", headers={**origin, "Authorization": "Bearer synthetic"})).status == 200


@pytest.mark.asyncio
async def test_unknown_host_cannot_bypass_origin_with_dns_rebinding(website):
    client, calls = website
    for path in ["/work/", "/work/assets/app.js", "/work/office-editor/docs/index.html", "/api/work/sessions"]:
        response = await client.get(path, headers={"Host": "attacker.invalid", "Authorization": "Bearer synthetic"})
        assert response.status == 403
    assert not calls


@pytest.mark.asyncio
async def test_static_allowlist_does_not_open_file_or_task_routes(website):
    client, calls = website
    assert (await client.post("/work/assets/app.js")).status == 401
    assert (await client.get("/work/assets/../hosted-work.html")).status == 200  # Only the public HTML entry.
    assert (await client.get("/work/assets/missing.js")).status == 404
    assert (await client.get("/api/work/sessions/" + "a" * 32 + "/files/" + "b" * 32)).status == 401
    assert (await client.get("/api/work/desktop/api/office/sessions")).status == 401
    assert (await client.post("/work/office-editor/docs/index.html")).status == 401
    assert (await client.get(URL("/work/office-editor/%2e%2e/private.txt", encoded=True))).status in (401, 403, 404)
    assert not calls
