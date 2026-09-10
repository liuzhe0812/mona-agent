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
