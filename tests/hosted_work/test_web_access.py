"""Browser-style Origin requests and explicitly approved direct LAN access."""
import pytest
import pytest_asyncio
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.access import private_listener, website_origin
from mona.hosted_work.contracts import owner_key
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
    for path in ["/work/", "/work/assets/app.js", "/api/work/sessions"]:
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
    assert not calls
