import json
import secrets

import httpx
import pytest
from pydantic import SecretStr, ValidationError
from test_relay import relay_client

from notebook_relay.config import Settings

FREE_MODEL = "vendor/example-model:free"
OFFICIAL_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter_free": "https://openrouter.ai/api/v1",
}


def settings(**overrides):
    return Settings(api_key=SecretStr(secrets.token_urlsafe(32)), **overrides)


def payload(model):
    return {
        "model": model,
        "messages": [{"role": "system", "content": "保留会话约定。"}, {"role": "user", "content": "hello"}],
        "tools": [{"type": "function", "function": {"name": "caller_sum", "parameters": {"type": "object"}}}],
        "tool_choice": "auto",
        "vendor_extension": {"unchanged": [True, None, 0.125]},
    }


@pytest.fixture
def intercepted_requests(monkeypatch):
    requests = []

    async def handle_request(transport, request):
        requests.append({
            "method": request.method, "url": str(request.url),
            "headers": dict(request.headers), "body": await request.aread(),
        })
        if request.method == "GET":
            return httpx.Response(200, json={"data": [{"id": FREE_MODEL}, {"id": "example-model"}]})
        return httpx.Response(200, json={"id": "completion", "choices": []})

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", handle_request)
    return requests


def test_providers_resolve_only_to_local_or_fixed_official_urls():
    local = settings()
    assert local.upstream_provider == "local"
    assert local.resolved_upstream_base_url is None
    assert settings(upstream_base_url="http://127.0.0.1:8801/v1/").resolved_upstream_base_url == "http://127.0.0.1:8801/v1"
    for provider, url in OFFICIAL_URLS.items():
        assert settings(upstream_provider=provider).resolved_upstream_base_url == url
    with pytest.raises(ValidationError):
        settings(upstream_provider="custom")


def test_remote_presets_cannot_override_the_destination_and_local_cannot_use_public_urls():
    for provider, official_url in OFFICIAL_URLS.items():
        for url in ("http://127.0.0.1:8801/v1", official_url, "https://example.com/v1"):
            with pytest.raises(ValidationError):
                settings(upstream_provider=provider, upstream_base_url=url)
    with pytest.raises(ValidationError):
        settings(upstream_base_url="https://example.com/v1")


def test_openrouter_free_requires_named_models_with_a_single_free_suffix():
    for models in ((), (FREE_MODEL,), ("vendor/model-1.2:free",)):
        assert settings(upstream_provider="openrouter_free", models=models).models == models
    for model in (
        "vendor/paid-model", "vendor/model:online:free", "vendor/model:free:free",
        "openrouter/free", "openrouter/auto", "free", "vendor/model:free/extra",
    ):
        with pytest.raises(ValidationError):
            settings(upstream_provider="openrouter_free", models=(model,))


@pytest.mark.parametrize("provider", ["groq", "openrouter_free"])
async def test_remote_without_an_upstream_key_rejects_ready_and_chat_without_network(provider, intercepted_requests):
    model = FREE_MODEL if provider == "openrouter_free" else "example-model"
    async with relay_client(
        upstream_provider=provider, upstream_api_key=None, models=(model,),
    ) as (client, _):
        for method, path in (("GET", "/ready"), ("POST", "/v1/chat/completions")):
            response = await client.request(method, path, json=payload(model))
            assert response.status_code == 503
            assert response.json()["error"]["code"] == "upstream_key_missing"
        assert intercepted_requests == []


@pytest.mark.parametrize("provider", ["groq", "openrouter_free"])
async def test_official_routes_preserve_body_and_tools_with_only_the_upstream_key(provider, intercepted_requests):
    model = FREE_MODEL if provider == "openrouter_free" else "example-model"
    raw = json.dumps(payload(model), ensure_ascii=False, indent=2).encode()
    async with relay_client(upstream_provider=provider, models=(model,)) as (client, config):
        response = await client.post(
            "/v1/chat/completions?target=https://example.com", content=raw,
            headers={"Content-Type": "application/json", "Cookie": "session=" + secrets.token_urlsafe(16)},
        )
        assert response.status_code == 200
        assert response.json()["id"] == "completion"
        assert len(intercepted_requests) == 1
        request = intercepted_requests[0]
        assert request["method"] == "POST"
        assert request["url"] == OFFICIAL_URLS[provider] + "/chat/completions"
        assert request["body"] == raw
        assert request["headers"]["authorization"] == "Bearer " + config.upstream_api_key.get_secret_value()
        assert config.api_key.get_secret_value() not in str(request["headers"])
        assert "cookie" not in request["headers"]


async def test_openrouter_blocks_paid_overrides_and_server_tools_then_releases_capacity(intercepted_requests):
    valid = payload(FREE_MODEL)
    async with relay_client(upstream_provider="openrouter_free", models=(FREE_MODEL,), max_concurrency=1) as (client, _):
        for override in (
            {"models": ["vendor/paid-model"]},
            {"route": "fallback"},
            {"plugins": [{"id": "web"}]},
            {"web_search_options": {"search_context_size": "low"}},
            {"tools": [{"type": "web_search"}]},
        ):
            before = len(intercepted_requests)
            rejected = await client.post("/v1/chat/completions", json={**valid, **override})
            assert rejected.status_code == 400
            assert rejected.json()["error"]["code"] == "unsupported_free_tier_option"
            assert len(intercepted_requests) == before
            following = await client.post("/v1/chat/completions", json=valid)
            assert following.status_code == 200
            assert len(intercepted_requests) == before + 1


async def test_free_tier_guards_do_not_restrict_local_or_groq_transparent_forwarding(intercepted_requests):
    forwarded = {
        **payload("example-model"), "models": ["alternative-model"], "route": "fallback",
        "plugins": [{"id": "web"}], "web_search_options": {}, "tools": [{"type": "web_search"}],
    }
    raw = json.dumps(forwarded).encode()
    for provider, url in (("local", "http://127.0.0.1:8801/v1"), ("groq", None)):
        async with relay_client(upstream_provider=provider, upstream_base_url=url) as (client, _):
            response = await client.post("/v1/chat/completions", content=raw, headers={"Content-Type": "application/json"})
            assert response.status_code == 200
            assert intercepted_requests[-1]["body"] == raw
