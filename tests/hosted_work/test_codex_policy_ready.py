"""Codex availability is gated by the configured connection and billing state."""

import pytest

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.executor import child_environment
from mona.hosted_work.model_policy import model_available, require_model_available

KEY_NAME = "MONA_WORK_BILLING_POLICY_TEST_KEY"
PRICE = {"input_amount_per_million": "1", "cached_input_amount_per_million": "0.5",
         "output_amount_per_million": "2"}


@pytest.fixture(autouse=True)
def clean_test_key(monkeypatch):
    monkeypatch.delenv(KEY_NAME, raising=False)


@pytest.mark.parametrize("operator,key_name,key_value,price,expected_error", [
    ("", "", None, None, "provider_unavailable"),
    ("", KEY_NAME, "x" * 32, PRICE, "provider_unavailable"),
    ("/trusted/operator.json", "", None, PRICE, "billing_unavailable"),
    ("/trusted/operator.json", KEY_NAME, None, PRICE, "billing_unavailable"),
    ("/trusted/operator.json", KEY_NAME, "x" * 31, PRICE, "billing_unavailable"),
    ("/trusted/operator.json", KEY_NAME, "x" * 31 + " ", PRICE, "billing_unavailable"),
    ("/trusted/operator.json", KEY_NAME, "x" * 32, None, "billing_unavailable"),
])
def test_paid_codex_requires_operator_price_and_usable_key(
    monkeypatch, operator, key_name, key_value, price, expected_error,
):
    if key_value is not None:
        monkeypatch.setenv(KEY_NAME, key_value)
    model = HostedWorkModel(label="Codex", source="codex", model="codex-test", billing_mode="wallet", price=price)
    config = HostedWorkConfig(operator_config_path=operator, billing_key_env=key_name)
    assert not model_available(model, config)
    with pytest.raises(WorkError) as caught:
        require_model_available(model, config)
    assert caught.value.code == expected_error


def test_free_codex_also_requires_an_operator_configuration():
    model = HostedWorkModel(label="Codex", source="codex", model="codex-test", billing_mode="free")
    config = HostedWorkConfig()
    assert not model_available(model, config)
    with pytest.raises(WorkError) as caught:
        require_model_available(model, config)
    assert caught.value.code == "provider_unavailable"


@pytest.mark.parametrize("mode,enabled", [("free", True), ("free", False), ("wallet", True), ("wallet", False)])
def test_configured_codex_respects_billing_mode_and_enabled(monkeypatch, mode, enabled):
    if mode == "wallet":
        monkeypatch.setenv(KEY_NAME, "x" * 32)
    model = HostedWorkModel(label="Codex", source="codex", model="codex-test", enabled=enabled,
                            billing_mode=mode, price=PRICE if mode == "wallet" else None)
    config = HostedWorkConfig(operator_config_path="/trusted/operator.json", billing_key_env=KEY_NAME)
    assert model_available(model, config) is enabled
    if enabled:
        require_model_available(model, config)
    else:
        with pytest.raises(WorkError) as caught:
            require_model_available(model, config)
        assert caught.value.code == "model_disabled"


def test_child_needs_explicit_billing_authorization_without_receiving_service_key(monkeypatch):
    key = "policy-test-service-key-" + "x" * 32
    monkeypatch.setenv(KEY_NAME, key)
    config = HostedWorkConfig(operator_config_path="/trusted/operator.json", billing_key_env=KEY_NAME, models={
        "codex": {"label": "Codex", "source": "codex", "model": "codex-test", "billing_mode": "wallet",
                  "price": PRICE},
    })
    model = config.models["codex"]
    assert model_available(model, config)
    environment = child_environment(config, {"action": "turn", "model_id": "codex"})
    assert KEY_NAME not in environment
    assert key not in environment.values()
    assert key not in str(config.model_dump())

    # The separate turn process has the configuration but not the parent's key.
    child_config = HostedWorkConfig.model_validate(config.model_dump())
    monkeypatch.delenv(KEY_NAME)
    child_model = child_config.models["codex"]
    assert not model_available(child_model, child_config)
    with pytest.raises(WorkError) as missing_authorization:
        require_model_available(child_model, child_config)
    assert missing_authorization.value.code == "billing_unavailable"
    require_model_available(child_model, child_config, billing_authorized=True)

    child_config.billing_key_env = ""
    with pytest.raises(WorkError) as missing_key_name:
        require_model_available(child_model, child_config, billing_authorized=True)
    assert missing_key_name.value.code == "billing_unavailable"
    child_config.billing_key_env = KEY_NAME
    child_model.price = None
    with pytest.raises(WorkError) as missing_price:
        require_model_available(child_model, child_config, billing_authorized=True)
    assert missing_price.value.code == "billing_unavailable"


def test_free_qwen_remains_available_without_codex_or_billing_configuration():
    model = HostedWorkModel(label="Qwen", source="mona", model="qwen-test", billing_mode="free")
    assert model_available(model)
    assert model_available(model, HostedWorkConfig())
    require_model_available(model, HostedWorkConfig())
    model.enabled = False
    assert not model_available(model, HostedWorkConfig())
    with pytest.raises(WorkError) as caught:
        require_model_available(model, HostedWorkConfig())
    assert caught.value.code == "model_disabled"
