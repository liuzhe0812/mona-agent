from __future__ import annotations

import json

import httpx
import pytest

from mona.config.schema import Config
from mona.providers.factory import make_provider
from mona.security.network import validate_url_target
from mona.webui import settings_api


def test_private_network_bypass_is_request_scoped() -> None:
    url = "http://172.31.13.189:8080/v1/models"

    blocked, _ = validate_url_target(url)
    allowed, error = validate_url_target(url, allow_private=True)
    metadata_allowed, _ = validate_url_target(
        "http://169.254.169.254/latest/meta-data",
        allow_private=True,
    )

    assert blocked is False
    assert allowed is True
    assert error == ""
    assert metadata_allowed is False


@pytest.mark.asyncio
async def test_custom_provider_probe_allows_private_api_base(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    class Response:
        status_code = 200
        text = '{"data":[{"id":"self-hosted-model"}]}'

        def json(self):
            return {"data": [{"id": "self-hosted-model"}]}

    class Client:
        def __init__(self, *args, **kwargs):
            del args, kwargs

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            del args

        async def get(self, url: str, **kwargs):
            del kwargs
            calls.append(url)
            return Response()

    monkeypatch.setattr(settings_api.httpx, "AsyncClient", Client)

    models = await settings_api.probe_provider_models(
        provider_name="custom",
        api_base="http://172.31.13.189:8080/v1",
    )

    assert models == ["self-hosted-model"]
    assert calls == ["http://172.31.13.189:8080/v1/models"]


def _connection(preset, model, *, base=None, key=None, wire=None, transport=None):
    config = Config.model_validate({
        "agents": {"defaults": {"provider": preset, "model": model}},
        "providers": {"cindy": {preset: {"apiKey": key, "apiBase": base, "wireApi": wire}}},
    })
    factory = (lambda: httpx.AsyncClient(transport=httpx.MockTransport(transport))) if transport else None
    return make_provider(config, http_client_factory=factory)


def _chat_result(model):
    return httpx.Response(200, json={"id": "test", "object": "chat.completion", "created": 1, "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}]})


def _messages_result(model):
    return httpx.Response(200, json={"id": "msg_test", "type": "message", "role": "assistant", "model": model,
        "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn",
        "usage": {"input_tokens": 2, "output_tokens": 1}})


@pytest.mark.asyncio
@pytest.mark.parametrize(("base", "model", "wire", "destination"), [
    ("https://custom.example/private/v1", "my-model", "openai-responses", "https://custom.example/private/v1/responses"),
    ("https://custom.example/anthropic/v1", "my-model", "anthropic-messages", "https://custom.example/anthropic/v1/messages"),
    ("https://api.anthropic.com", "claude-sonnet-4-6", None, "https://api.anthropic.com/v1/messages"),
    ("https://api.anthropic.com", "claude-sonnet-4-6", "openai-completions", "https://api.anthropic.com/chat/completions"),
    ("https://opaque.example/v1", "claude-sonnet-4-6", None, "https://opaque.example/v1/chat/completions"),
])
async def test_custom_api_protocol_has_explicit_precedence_and_never_rewrites_its_host(base, model, wire, destination, monkeypatch):
    captured = []
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fixture-ambient-anthropic")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "fixture-ambient-bearer")
    key = None if wire == "anthropic-messages" else "fixture"

    def upstream(request):
        assert "fixture-ambient" not in str(request.headers.get("authorization")) + str(request.headers.get("x-api-key"))
        if key is None:
            assert "authorization" not in request.headers and "x-api-key" not in request.headers
        captured.append((str(request.url), json.loads(request.content)["model"]))
        if request.url.path.endswith("/messages"):
            return _messages_result(model)
        if request.url.path.endswith("/responses"):
            return httpx.Response(200, json={"id": "test", "object": "response", "status": "completed",
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]})
        return _chat_result(model)

    provider = _connection("custom-test", model, base=base, key=key, wire=wire, transport=upstream)
    try:
        assert (await provider.chat([{"role": "user", "content": "fixture"}])).content == "ok"
    finally:
        await provider.aclose()
    assert captured == [(destination, model)]


@pytest.mark.asyncio
async def test_sub2api_forces_responses_for_stream_and_regular_calls_and_does_not_replay_errors():
    requests = []
    success = {"id": "resp_1", "object": "response", "model": "any-id", "status": "completed",
               "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]}

    def upstream(request):
        body = json.loads(request.content)
        requests.append((str(request.url), body.get("stream")))
        if len(requests) > 2:
            return httpx.Response(404, json={"error": {"message": "Unknown endpoint /responses"}})
        if body.get("stream"):
            events = [{"type": "response.output_text.delta", "delta": "ok"},
                      {"type": "response.completed", "response": success}]
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  text="".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n")
        return httpx.Response(200, json=success)

    provider = _connection("sub2api", "any-id", base="https://sub.example/prefix/v1", key="fixture", transport=upstream)
    try:
        messages = [{"role": "user", "content": "fixture"}]
        for call in (provider.chat, provider.chat_stream):
            assert (await call(messages)).content == "ok"
        for call in (provider.chat, provider.chat_stream):
            assert (await call(messages)).finish_reason == "error"
    finally:
        await provider.aclose()
    assert requests == [("https://sub.example/prefix/v1/responses", value) for value in (False, True, False, True)]


@pytest.mark.asyncio
@pytest.mark.parametrize("key", [None, "fixture"])
async def test_keyless_local_servers_do_not_receive_a_placeholder_bearer(monkeypatch, key):
    captured = []
    original = httpx.AsyncClient.__init__

    def upstream(request):
        captured.append((str(request.url), request.headers.get("Authorization")))
        return _chat_result("local")

    def offline(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(upstream)
        original(self, *args, **kwargs)

    # Exercise the ordinary local pool branch, with no injected client factory.
    monkeypatch.setattr(httpx.AsyncClient, "__init__", offline)
    provider = _connection("vllm", "local", key=key)
    try:
        assert (await provider.chat([{"role": "user", "content": "fixture"}])).content == "ok"
    finally:
        await provider.aclose()
    assert captured == [("http://127.0.0.1:8000/v1/chat/completions", f"Bearer {key}" if key else None)]


@pytest.mark.asyncio
async def test_cloudflare_gateway_binds_the_tenant_and_sends_only_gateway_auth():
    captured = []

    def upstream(request):
        body = json.loads(request.content)
        captured.append((str(request.url), body["model"], request.headers.get("cf-aig-authorization"),
                         request.headers.get("authorization"), request.headers.get("x-api-key")))
        return _messages_result(body["model"])

    base = "https://gateway.ai.cloudflare.com/v1/tenant_1/gateway-2/compat"
    provider = _connection("cloudflare-ai-gateway", "claude-fable-5", base=base, key="fixture", transport=upstream)
    try:
        assert (await provider.chat([{"role": "user", "content": "fixture"}])).content == "ok"
    finally:
        await provider.aclose()
    assert captured == [(base.removesuffix("compat") + "anthropic/v1/messages", "claude-fable-5", "Bearer fixture", None, None)]
    from mona.providers.preset_transport import cloudflare_gateway_headers
    with pytest.raises(ValueError):
        cloudflare_gateway_headers("https://gateway.ai.cloudflare.com.other.example/v1/tenant/gw/compat", "fixture")


@pytest.mark.asyncio
async def test_opencode_uses_the_translating_endpoint_and_conversation_scoped_session_header():
    from mona.providers.preset_transport import model_session_key

    captured = []

    def upstream(request):
        model = json.loads(request.content)["model"]
        captured.append((str(request.url), model, request.headers.get("x-opencode-session")))
        return _chat_result(model)

    provider = _connection("opencode-go", "gemini-4-argon", key="fixture", transport=upstream)
    try:
        for session in ("chat-a", "chat-a", "chat-b"):
            binding = model_session_key.set(session)
            try:
                assert (await provider.chat([{"role": "user", "content": "fixture"}])).content == "ok"
            finally:
                model_session_key.reset(binding)
    finally:
        await provider.aclose()
    assert {(url, model) for url, model, _ in captured} == {("https://opencode.ai/inference/go/openai/v1/chat/completions", "gemini-4-argon")}
    assert captured[0][2] == captured[1][2] != captured[2][2]
    assert captured[0][2].startswith("ses_") and "chat-a" not in captured[0][2]


@pytest.mark.asyncio
async def test_vertex_uses_the_google_project_and_refreshes_adc_before_sending(monkeypatch):
    import google.auth
    from mona.providers.vertex_provider import VertexAccess

    class Credentials:
        valid = False
        token = None
        quota_project_id = "quota-project"
        calls = 0

        def refresh(self, request):
            self.calls += 1
            self.valid = True
            self.token = f"fixture-{self.calls}"

    credentials = Credentials()
    monkeypatch.setattr(google.auth, "default", lambda **kwargs: (credentials, "adc-project"))
    captured = []

    def upstream(request):
        model = json.loads(request.content)["model"]
        captured.append((str(request.url), model, request.headers.get("Authorization"), request.headers.get("x-goog-user-project")))
        return _chat_result(model)

    base = "https://aiplatform.googleapis.com/v1/projects/user-project/locations/global/endpoints/openapi"
    provider = _connection("google-vertex", "gemini-2.5-flash", base=base, transport=upstream)
    try:
        for _ in range(2):
            assert (await provider.chat([{"role": "user", "content": "fixture"}])).content == "ok"
            credentials.valid = False
    finally:
        await provider.aclose()
    assert captured == [(base + "/chat/completions", "google/gemini-2.5-flash", f"Bearer fixture-{i}", "quota-project") for i in (1, 2)]
    with pytest.raises(ValueError):
        VertexAccess("https://aiplatform.googleapis.com.attacker.example")


@pytest.mark.asyncio
async def test_copilot_uses_account_scoped_bearer_for_messages_and_catalog(monkeypatch):
    captured = []

    def upstream(request):
        captured.append((str(request.url), request.headers.get("authorization"), request.headers.get("x-api-key")))
        return _messages_result("claude-fable-5")

    provider = _connection("github-copilot", "claude-fable-5", transport=upstream)

    async def credential():
        provider._copilot_base = "https://api.business.githubcopilot.com"
        return "fixture-copilot"

    monkeypatch.setattr(provider, "_get_copilot_access_token", credential)
    try:
        url, headers = await provider.catalog_request()
        assert url == "https://api.business.githubcopilot.com/models" and headers["Authorization"] == "Bearer fixture-copilot"
        assert (await provider.chat([{"role": "user", "content": "fixture"}])).content == "ok"
    finally:
        await provider.aclose()
    assert captured == [("https://api.business.githubcopilot.com/v1/messages", "Bearer fixture-copilot", None)]


@pytest.mark.asyncio
async def test_azure_preset_preserves_the_resource_v1_endpoint_and_deployment():
    captured = []

    def upstream(request):
        body = json.loads(request.content)
        captured.append((str(request.url), body["model"]))
        return httpx.Response(200, json={"id": "test", "object": "response", "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]})

    base = "https://resource.openai.azure.com/openai/v1"
    provider = _connection("azure-openai-responses", "my-deployment", base=base, key="fixture", transport=upstream)
    try:
        assert (await provider.chat([{"role": "user", "content": "fixture"}])).content == "ok"
    finally:
        await provider.aclose()
    assert captured == [(base + "/responses", "my-deployment")]
