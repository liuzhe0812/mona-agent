"""Admission depends on the selected source and its server-side billing readiness."""
import os

from mona.config.schema import HostedWorkConfig, HostedWorkModel
from mona.hosted_work.contracts import WorkError


def billing_ready(config: HostedWorkConfig | None) -> bool:
    if config is None or not config.billing_key_env:
        return False
    value = os.environ.get(config.billing_key_env, "")
    return 32 <= len(value) <= 8192 and value.isascii() and all(33 <= ord(char) < 127 for char in value)


def model_available(model: HostedWorkModel, config: HostedWorkConfig | None = None) -> bool:
    if not model.enabled:
        return False
    if model.source == "mona":
        return model.billing_mode == "free"
    if model.source == "codex" and config is not None and config.operator_config_path:
        return model.billing_mode == "free" or model.price is not None and billing_ready(config)
    return False


def require_model_available(model: HostedWorkModel, config: HostedWorkConfig | None = None, *,
                            billing_authorized: bool = False) -> None:
    if not model.enabled:
        raise WorkError("model_disabled", "此模型暂未开放。")
    if model.source == "codex" and config is not None and config.operator_config_path:
        if (model.billing_mode == "free" or model.price is not None and
                (billing_ready(config) or billing_authorized is True and bool(config.billing_key_env))):
            return
        raise WorkError("billing_unavailable", "此模型的余额计费尚未就绪，暂不可调用。", 503)
    if model.billing_mode == "wallet" and model.source == "mona":
        raise WorkError("billing_unavailable", "此模型的共用余额计费尚未接通，暂不可调用。", 503)
    if model.source != "mona":
        raise WorkError("provider_unavailable", "此模型的执行接入尚未完成，暂不可调用。", 503)
