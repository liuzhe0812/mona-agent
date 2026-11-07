"""Fail closed until the Work image connection and selected billing mode are configured."""
from __future__ import annotations

from mona.config.schema import HostedWorkConfig, HostedWorkImageSettings
from mona.hosted_work.billing import BillingError
from mona.hosted_work.contracts import WorkError
from mona.hosted_work.image_billing import HostedImageBilling
from mona.hosted_work.model_policy import model_available


def resolve_image_model(config: HostedWorkConfig, image: HostedWorkImageSettings | None = None,
                        selected=None) -> str:
    """Use an already-open Codex model; no separate image model is invented."""
    settings = image or config.image_generation
    models = [model for model in config.models.values()
              if model.source == "codex" and model.enabled and model_available(model, config)]
    if settings.model:
        return settings.model if any(model.model == settings.model for model in models) else ""
    if selected is not None and selected in models:
        return selected.model
    return models[0].model if models else ""


def image_ready(config: HostedWorkConfig, settings: HostedWorkImageSettings | None = None) -> bool:
    image = settings or config.image_generation
    if not image.enabled or image.provider != "codex" or not resolve_image_model(config, image) or config.codex.auth_mode != "chatgpt":
        return False
    if image.billing_mode == "wallet" and image.price is None:
        return False
    try:
        from mona.hosted_work.codex_image_provider import codex_image_ready
        from mona.hosted_work.providers import codex_operator

        admin = codex_operator(config)
        if not codex_image_ready(admin, admin.profile(config.codex)):
            return False
        if image.billing_mode == "wallet":
            HostedImageBilling(config)
    except (BillingError, WorkError, OSError, ValueError):
        return False
    return True
