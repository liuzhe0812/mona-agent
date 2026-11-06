"""Provider-independent admission until shared-wallet settlement is connected."""
from mona.config.schema import HostedWorkModel
from mona.hosted_work.contracts import WorkError


def model_available(model: HostedWorkModel) -> bool:
    return model.source == "mona" and model.billing_mode == "free"


def require_model_available(model: HostedWorkModel) -> None:
    if model.billing_mode == "wallet":
        raise WorkError("billing_unavailable", "此模型的共用余额计费尚未接通，暂不可调用。", 503)
    if model.source != "mona":
        raise WorkError("provider_unavailable", "此模型的执行接入尚未完成，暂不可调用。", 503)
