"""Hosted image generation requires the dedicated Codex identity and explicit price."""
from types import SimpleNamespace

from mona.config.schema import HostedWorkConfig, HostedWorkImagePrice, HostedWorkImageSettings
from mona.hosted_work.executor import child_environment
from mona.hosted_work.image_policy import image_ready, resolve_image_model


def configured():
    image = HostedWorkImageSettings(enabled=True, price=HostedWorkImagePrice(amount_per_image="0.01"))
    return HostedWorkConfig(auth_origin="https://auth.example.test", operator_config_path="/tmp/config.json",
        billing_key_env="MONA_WORK_BILLING_TEST_KEY", image_generation=image,
        models={"codex-one": {"label": "One", "model": "one", "source": "codex", "billing_mode": "free"},
                "codex-two": {"label": "Two", "model": "two", "source": "codex", "billing_mode": "free"}})


def test_image_ready_requires_dedicated_account_and_explicit_price(monkeypatch):
    config = configured()
    from mona.hosted_work import codex_image_provider, providers

    monkeypatch.setattr(providers, "codex_operator", lambda _: SimpleNamespace(profile=lambda _settings: object()))
    monkeypatch.setattr(codex_image_provider, "codex_image_ready", lambda *_: True)
    assert not image_ready(config)
    monkeypatch.setenv("MONA_WORK_BILLING_TEST_KEY", "b" * 32)
    assert image_ready(config)
    config.image_generation.price = None
    assert not image_ready(config)
    config.image_generation.billing_mode = "free"
    assert image_ready(config)
    monkeypatch.setattr(codex_image_provider, "codex_image_ready", lambda *_: False)
    assert not image_ready(config)


def test_open_codex_model_is_selected_without_an_extra_image_setting():
    config = configured()
    assert resolve_image_model(config) == "one"
    assert resolve_image_model(config, selected=config.models["codex-two"]) == "two"
    config.models["codex-two"].enabled = False
    assert resolve_image_model(config, selected=config.models["codex-two"]) == "one"


def test_image_child_receives_no_wallet_or_image_service_key(monkeypatch):
    config = configured()
    monkeypatch.setenv("MONA_WORK_MODEL_IMAGE_KEY", "image-secret")
    monkeypatch.setenv("MONA_WORK_BILLING_TEST_KEY", "b" * 32)
    environment = child_environment(config, {"action": "turn", "model_id": "unused", "hosted_image": {
        "settings": config.image_generation.model_dump(), "capability": "x" * 43}})
    assert "MONA_WORK_MODEL_IMAGE_KEY" not in environment
    assert "MONA_WORK_BILLING_TEST_KEY" not in environment
