"""Exercise the administrator catalog boundary without real model requests."""
from __future__ import annotations

import asyncio
import hashlib
import json
import socket
from unittest.mock import AsyncMock

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from mona.config.schema import HostedWorkConfig
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.model_discovery import ModelDiscovery, register_model_discovery

BASE = "https://api.example.com/v1"
KEY_NAME = "MONA_WORK_MODEL_DISCOVERY_KEY"
SECRET = "synthetic-private-key"


class Stream(httpx.AsyncByteStream):
    def __init__(self, raw: bytes):
        self.raw = raw

    async def __aiter__(self):
        yield self.raw


def json_response(value):
    return httpx.Response(200, stream=Stream(json.dumps(value).encode()))


def addresses(*values):
    return [(socket.AF_INET6 if ":" in value else socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "",
             (value, 443, 0, 0) if ":" in value else (value, 443)) for value in values]


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv(KEY_NAME, SECRET)
    config = HostedWorkConfig(auth_origin="https://account.example", public_origin="https://work.example")
    return config, AsyncMock(return_value=addresses("8.8.8.8"))


@pytest.mark.asyncio
async def test_provider_catalog_is_read_once_sorted_deduplicated_and_given_stable_safe_ids(setup):
    config, resolver = setup
    seen = []

    async def upstream(request):
        seen.append(request)
        return json_response({"data": [{"id": "qwen3.7-plus", "ignored": SECRET},
            {"id": "glm-5"}, {"id": "qwen3.7-plus"}, {"id": "MiniMax-M2.5"}, {"id": "@cf/a-model"}]})

    discovery = ModelDiscovery(config, resolver=resolver, inner_transport=httpx.MockTransport(upstream))
    result = await discovery.discover("https://API.EXAMPLE.COM:443/v1/", KEY_NAME)
    rows = result["models"]
    assert [row["id"] for row in rows] == ["@cf/a-model", "glm-5", "MiniMax-M2.5", "qwen3.7-plus"]
    for row in rows:
        digest = hashlib.sha256((BASE + "\0" + KEY_NAME + "\0" + row["id"]).encode()).hexdigest()[:24]
        assert row == {"id": row["id"], "label": row["id"], "suggested_id": "api-" + digest}
    assert SECRET not in json.dumps(result)
    assert len(seen) == 1 and seen[0].method == "GET" and seen[0].url.host == "8.8.8.8"
    assert seen[0].url.path == "/v1/models" and seen[0].headers["Host"] == "api.example.com"
    assert seen[0].headers["Authorization"] == "Bearer " + SECRET and seen[0].headers["Accept-Encoding"] == "identity"
    assert seen[0].extensions["sni_hostname"] == "api.example.com"
    assert resolver.await_count == 2


@pytest.mark.asyncio
async def test_different_model_provider_and_credential_make_distinct_ids(setup, monkeypatch):
    config, resolver = setup
    monkeypatch.setenv("MONA_WORK_MODEL_SECOND_KEY", "other-synthetic-key")
    def factory():
        return httpx.MockTransport(lambda request: json_response({"data": [{"id": "qwen3.7-plus"}]}))
    async def find(base, key):
        return (await ModelDiscovery(config, resolver=resolver, inner_transport=factory()).discover(base, key))["models"][0]["suggested_id"]
    one = await find(BASE, KEY_NAME)
    assert one == await find(BASE + "/", KEY_NAME)
    assert len({one, await find(BASE, "MONA_WORK_MODEL_SECOND_KEY"), await find("https://other.example.com/v1", KEY_NAME)}) == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("url", ["https://127.0.0.1/v1", "http://127.0.0.1:9010/v1", "http://192.168.0.2/v1",
    "https://localhost/v1", "https://user:password@api.example.com/v1", "https://api.example.com/v1?token=secret",
    "https://account.example/v1", "https://account.example:443/v1", "https://account.example/%61uth",
    "https://ACCOUNT.example./models/../v1", "https://account.example/v1/models", "https://account.example/internal"])
async def test_unsafe_or_account_gateway_url_is_never_sent(setup, url):
    config, resolver = setup
    upstream = AsyncMock(return_value=json_response({"data": []}))
    discovery = ModelDiscovery(config, resolver=resolver, inner_transport=httpx.MockTransport(upstream))
    with pytest.raises(WorkError) as error:
        await discovery.discover(url, KEY_NAME)
    assert error.value.code == "invalid_model_endpoint" and error.value.status == 400
    assert SECRET not in error.value.message
    upstream.assert_not_awaited()


@pytest.mark.asyncio
async def test_mixed_private_dns_fails_before_any_upstream_request(setup):
    config, resolver = setup
    resolver.return_value = addresses("8.8.8.8", "127.0.0.1")
    upstream = AsyncMock(return_value=httpx.Response(200))
    with pytest.raises(WorkError) as error:
        await ModelDiscovery(config, resolver=resolver, inner_transport=httpx.MockTransport(upstream)).discover(BASE, KEY_NAME)
    assert error.value.code == "invalid_model_endpoint"
    upstream.assert_not_awaited()


@pytest.mark.asyncio
async def test_only_existing_literal_loopback_and_credential_can_be_retained(monkeypatch):
    monkeypatch.setenv(KEY_NAME, SECRET)
    monkeypatch.setenv("MONA_WORK_MODEL_OTHER_KEY", "other-secret")
    base = "http://127.0.0.1:18000/v1"
    config = HostedWorkConfig(auth_origin="https://account.example", models={"local": {"label": "Local",
        "model": "local-model", "api_base": base, "api_key_env": KEY_NAME}})
    resolver = AsyncMock(side_effect=AssertionError("literal loopback should not use DNS"))
    upstream = AsyncMock(return_value=json_response({"data": [{"id": "local-model"}]}))
    discovery = ModelDiscovery(config, resolver=resolver, inner_transport=httpx.MockTransport(upstream))
    assert (await discovery.discover(base, KEY_NAME))["models"][0]["id"] == "local-model"
    with pytest.raises(WorkError) as other_key:
        await discovery.discover(base, "MONA_WORK_MODEL_OTHER_KEY")
    with pytest.raises(WorkError) as other_port:
        await discovery.discover("http://127.0.0.1:18001/v1", KEY_NAME)
    assert other_key.value.code == other_port.value.code == "invalid_model_endpoint"
    assert upstream.await_count == 1
    resolver.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_or_invalid_credential_is_not_reflected_or_sent(setup, monkeypatch):
    config, resolver = setup
    upstream = AsyncMock(return_value=httpx.Response(200))
    discovery = ModelDiscovery(config, resolver=resolver, inner_transport=httpx.MockTransport(upstream))
    monkeypatch.delenv(KEY_NAME)
    with pytest.raises(WorkError) as error:
        await discovery.discover(BASE, KEY_NAME)
    assert error.value.code == "model_credentials_unavailable" and error.value.status == 422
    assert getattr(error.value, "field", None) == "api_key_env"
    with pytest.raises(WorkError) as invalid:
        await discovery.discover(BASE, "USER_SUPPLIED_SECRET")
    assert invalid.value.code == "invalid_request" and "USER_SUPPLIED_SECRET" not in invalid.value.message
    upstream.assert_not_awaited()
    resolver.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code", [(401, "model_credentials_unavailable"), (403, "model_credentials_unavailable"),
    (404, "model_catalog_unavailable"), (405, "model_catalog_unavailable"), (429, "model_catalog_unavailable"),
    (500, "model_catalog_unavailable")])
async def test_upstream_errors_do_not_expose_secret_or_raw_response(setup, status, code):
    config, resolver = setup
    transport = httpx.MockTransport(lambda request: httpx.Response(status, text="internal diagnostic " + SECRET))
    with pytest.raises(WorkError) as error:
        await ModelDiscovery(config, resolver=resolver, inner_transport=transport).discover(BASE, KEY_NAME)
    assert error.value.code == code and SECRET not in error.value.message and "internal diagnostic" not in error.value.message


@pytest.mark.asyncio
async def test_redirect_is_not_followed_and_secret_never_reaches_redirect_target(setup):
    config, resolver = setup
    requests = []
    async def redirect(request):
        requests.append(request)
        return httpx.Response(302, headers={"Location": "https://elsewhere.example/models"})
    with pytest.raises(WorkError) as error:
        await ModelDiscovery(config, resolver=resolver, inner_transport=httpx.MockTransport(redirect)).discover(BASE, KEY_NAME)
    assert error.value.code == "invalid_model_endpoint" and len(requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("data", [None, {}, {"data": {}}, {"data": [{}]}, {"data": [{"id": "bad model"}]},
    {"data": [{"id": "<script>"}]}, {"data": [{"id": "bad\nmodel"}]}, {"data": [{"id": SECRET}]},
    {"data": [{"id": "中"}]}, {"data": [{"id": "x" * 201}]}])
async def test_invalid_provider_model_data_is_rejected_without_partial_results(setup, data):
    config, resolver = setup
    transport = httpx.MockTransport(lambda request: json_response(data))
    with pytest.raises(WorkError) as error:
        await ModelDiscovery(config, resolver=resolver, inner_transport=transport).discover(BASE, KEY_NAME)
    assert error.value.code == "model_catalog_unavailable" and SECRET not in error.value.message


@pytest.mark.asyncio
async def test_empty_catalog_is_an_honest_empty_result(setup):
    config, resolver = setup
    transport = httpx.MockTransport(lambda request: json_response({"data": []}))
    assert await ModelDiscovery(config, resolver=resolver, inner_transport=transport).discover(BASE, KEY_NAME) == {"models": []}


@pytest.mark.asyncio
async def test_long_model_id_is_preserved_while_display_label_fits_existing_schema(setup):
    config, resolver = setup
    model_id = "vendor/" + "a" * 170
    transport = httpx.MockTransport(lambda request: json_response({"data": [{"id": model_id}]}))
    row = (await ModelDiscovery(config, resolver=resolver, inner_transport=transport).discover(BASE, KEY_NAME))["models"][0]
    assert row["id"] == model_id and len(row["label"]) == 80 and row["label"].endswith("...")


@pytest.mark.asyncio
async def test_size_limit_and_content_encoding_are_rejected_without_decompression(setup, monkeypatch):
    config, resolver = setup
    monkeypatch.setattr("mona.hosted_work.model_discovery.MAX_RESPONSE", 8)
    responses = [httpx.Response(200, stream=Stream(b"x" * 9)),
                 httpx.Response(200, headers={"Content-Encoding": "gzip"}, stream=Stream(b"compressed"))]
    for response in responses:
        with pytest.raises(WorkError) as error:
            await ModelDiscovery(config, resolver=resolver, inner_transport=httpx.MockTransport(lambda request: response)).discover(BASE, KEY_NAME)
        assert error.value.code == "model_catalog_unavailable"


@pytest.mark.asyncio
async def test_catalog_size_limit_never_returns_a_silently_partial_list(setup, monkeypatch):
    config, resolver = setup
    monkeypatch.setattr("mona.hosted_work.model_discovery.MAX_MODELS", 1)
    transport = httpx.MockTransport(lambda request: json_response({"data": [{"id": "one"}, {"id": "two"}]}))
    with pytest.raises(WorkError) as error:
        await ModelDiscovery(config, resolver=resolver, inner_transport=transport).discover(BASE, KEY_NAME)
    assert error.value.code == "model_catalog_unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize("pagination", [{"has_more": True}, {"has_more": "false"}, {"next": "https://evil.invalid/next"},
    {"next_cursor": "cursor"}, {"links": {"next": "/next"}}])
async def test_unhandled_pagination_does_not_present_partial_catalog(setup, pagination):
    config, resolver = setup
    transport = httpx.MockTransport(lambda request: json_response({"data": [{"id": "one"}], **pagination}))
    with pytest.raises(WorkError) as error:
        await ModelDiscovery(config, resolver=resolver, inner_transport=transport).discover(BASE, KEY_NAME)
    assert error.value.code == "model_catalog_unavailable" and "分页" in error.value.message


@pytest.mark.asyncio
async def test_registered_handler_bounds_body_and_does_not_reflect_unknown_fields(setup):
    config, resolver = setup
    async def error_boundary(request, handler):
        try:
            return await handler(request)
        except WorkError as exc:
            return web.json_response({"error": exc.code, "message": exc.message}, status=exc.status)
    app = web.Application(middlewares=[web.middleware(error_boundary)])
    register_model_discovery(app, config, resolver=resolver, inner_transport=httpx.MockTransport(
        lambda request: json_response({"data": [{"id": "qwen3.7-plus"}]})))
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        url = "/api/work/admin/models/discover"
        response = await client.post(url, json={"api_base": BASE, "api_key_env": KEY_NAME})
        assert response.status == 200 and (await response.json())["models"][0]["id"] == "qwen3.7-plus"
        response = await client.post(url, json={"api_base": BASE, "api_key_env": KEY_NAME, "api_key": SECRET})
        assert response.status == 400 and SECRET not in await response.text()
        response = await client.post(url, data=b"x" * 8193)
        assert response.status == 413
        async def chunks():
            yield b"x" * 4096
            await asyncio.sleep(0)
            yield b"x" * 4097
        response = await client.post(url, data=chunks())
        assert response.status == 413
    finally:
        await client.close()
