import copy

import httpx
import pytest

from mona.config.schema import Config, ModelPresetConfig
from mona.providers.base import LLMProvider, LLMResponse
from mona.providers.mona_managed_media import MonaManagedMediaClient
from mona.providers.mona_managed_provider import MonaManagedProvider
from mona.providers.registry import find_by_name


def test_managed_provider_requires_explicit_selection():
    config = Config()
    assert config.get_provider_name("unmatched-model") != "mona_managed"
    preset = ModelPresetConfig(provider="mona_managed", model="deepseek-v4-flash")
    assert config.get_provider_name(preset=preset) == "mona_managed"


@pytest.mark.asyncio
async def test_managed_provider_fetches_scoped_credentials(monkeypatch):
    from mona.providers import mona_managed_provider

    calls = 0

    def invoke(command):
        nonlocal calls
        calls += 1
        assert command == "get_model_access_credentials"
        return {
            "access_token": "scoped-token",
            "api_base": "https://mona.example/v1",
            "expires_in": 15,
        }

    monkeypatch.setattr(mona_managed_provider, "tauri_invoke", invoke)
    spec = find_by_name("mona_managed")
    assert spec is not None
    provider = MonaManagedProvider(default_model="deepseek-v4-flash", spec=spec)

    await provider._refresh_credentials()
    await provider._refresh_credentials()

    assert calls == 1
    assert provider._api_key_for_client == "scoped-token"
    assert provider._effective_base == "https://mona.example/v1"

    request = provider._build_kwargs(
        [{"role": "user", "content": "hello"}],
        None,
        None,
        100,
        0.7,
        None,
        None,
    )
    assert len(request["extra_headers"]["X-Request-ID"]) == 32

    error = provider._friendly_error(
        LLMResponse(content="raw provider error", error_status_code=402)
    )
    assert error.content == "模型余额不足，请在账户中充值后重试。"
    assert error.error_should_retry is False


def test_managed_billing_errors_keep_details_internal_and_do_not_retry():
    error = RuntimeError("raw internal failure")
    error.body = {"error": "billing_pending", "detail": "有一笔模型费用待核实，请在账户中查看并联系支持处理。"}
    error.status_code = 409
    response = MonaManagedProvider._friendly_error(MonaManagedProvider._handle_error(error))
    assert response.error_code == "billing_pending"
    assert response.content == "模型请求失败，请稍后重试。"
    assert response.error_should_retry is False


@pytest.mark.parametrize(
    ("kind", "status"),
    [("connection", None), ("timeout", None), (None, 500), (None, 502), (None, 504)],
)
def test_managed_request_failure_does_not_delegate_billing_checks_to_users(kind, status):
    response = MonaManagedProvider._friendly_error(
        LLMResponse(
            content="upstream internal failure", finish_reason="error",
            error_kind=kind, error_status_code=status,
        )
    )
    assert response.content == "模型请求失败，请稍后重试。"
    assert response.error_should_retry is False


def test_managed_busy_response_is_not_replaced_by_a_billing_warning():
    response = MonaManagedProvider._friendly_error(
        LLMResponse(content="upstream internal failure", finish_reason="error", error_status_code=503)
    )
    assert response.content == "Mona AI 暂时繁忙，请稍后重试或切换到我的 API Key。"
    assert response.error_should_retry is False


def test_managed_duplicate_request_does_not_ask_users_to_verify_billing():
    response = MonaManagedProvider._friendly_error(
        LLMResponse(
            content="Request ID is already in use", finish_reason="error",
            error_status_code=409, error_code="request_already_exists",
        )
    )
    assert response.content == "模型请求失败，请稍后重试。"
    assert response.error_code == "request_already_exists"
    assert response.error_should_retry is False


class BalanceErrorProvider(LLMProvider):
    def __init__(self, response: LLMResponse):
        super().__init__()
        self.response = response
        self.calls = 0

    async def chat(self, **kwargs):
        self.calls += 1
        return self.response

    async def chat_stream(self, **kwargs):
        return await self.chat(**kwargs)

    def get_default_model(self):
        return "managed-model"


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["chat_with_retry", "chat_stream_with_retry"])
@pytest.mark.parametrize(
    "metadata",
    [{"error_status_code": 402}, {"error_code": "insufficient_credits"}],
)
async def test_insufficient_balance_never_retries_without_images(method, metadata):
    provider = BalanceErrorProvider(
        LLMResponse(content="模型余额不足，请充值后重试。", finish_reason="error", **metadata)
    )
    messages = [{"role": "user", "content": [
        {"type": "text", "text": "describe this"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc"}},
    ]}]
    original = copy.deepcopy(messages)

    response = await getattr(provider, method)(messages=messages)

    assert response is provider.response
    assert provider.calls == 1
    assert messages == original


@pytest.mark.asyncio
async def test_managed_stream_balance_error_maps_to_402_without_retry(monkeypatch):
    calls = []
    deltas = []

    def handle(request):
        calls.append(request)
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            text=(
                'data: {"id":"request-1","object":"chat.completion.chunk","created":0,'
                '"model":"managed-model","choices":[{"index":0,"delta":{"content":"部分结果"},'
                '"finish_reason":null}]}\n\n'
                'data: {"error":{"code":"insufficient_credits","status":402,'
                '"message":"balance exhausted"}}\n\n'
                'data: [DONE]\n\n'
            ),
        )

    async def refresh_credentials(*, force=False):
        pass

    async def on_content_delta(content):
        deltas.append(content)

    provider = MonaManagedProvider(default_model="managed-model", spec=find_by_name("mona_managed"))
    monkeypatch.setattr(provider, "_refresh_credentials", refresh_credentials)
    provider.http_client_factory = lambda: httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        response = await provider.chat_stream_with_retry(
            messages=[{"role": "user", "content": "hello"}],
            on_content_delta=on_content_delta,
        )
    finally:
        await provider.aclose()

    assert len(calls) == 1
    assert deltas == ["部分结果"]
    assert response.finish_reason == "error"
    assert response.error_status_code == 402
    assert response.error_code == "insufficient_credits"
    assert response.error_should_retry is False
    assert response.content == "模型余额不足，请在账户中充值后重试。"


@pytest.mark.asyncio
async def test_managed_media_polls_uncertain_request_until_settled(monkeypatch):
    from mona.providers import mona_managed_media

    monkeypatch.setattr(mona_managed_media, "_tauri_invoke", lambda _: {
        "access_token": "managed-token", "api_base": "https://mona.example/v1",
    })
    calls = []

    def handle(request):
        calls.append((request.method, request.url.path))
        if request.method == "POST":
            return httpx.Response(202, json={"status": "running"})
        if len(calls) == 2:
            return httpx.Response(200, json={"status": "uncertain"})
        return httpx.Response(200, json={"status": "succeeded", "result": {"assets": ["ready"]}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        result = await MonaManagedMediaClient(poll_interval=0, poll_timeout=2, client=client).generate(
            {"model": "image", "prompt": "draw"},
        )

    assert result["result"]["assets"] == ["ready"]
    assert [method for method, _ in calls] == ["POST", "GET", "GET"]
    assert calls[1][1] == calls[2][1]
