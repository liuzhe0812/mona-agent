import pytest

from mona.config.schema import Config, ModelPresetConfig
from mona.providers.base import LLMResponse
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
