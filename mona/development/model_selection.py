"""Development consumes the same configured model sources as ordinary chat."""
from mona.config.schema import Config, ModelPresetConfig
from mona.development.store import DevelopmentError
from mona.webui.settings_api import _chat_provider_rows


def coding_models(config: Config, *, include_hidden: bool = False) -> list[dict]:
    result = []
    for source in _chat_provider_rows(config):
        if not source["configured"]:
            continue
        for model in source["models"]:
            if source.get("is_custom") and not model.get("type"):
                continue
            kind = str(model.get("type") or "chat").lower()
            if (not include_hidden and not model.get("enabled")) or kind not in {"chat", "language", "text", "llm"}:
                continue
            result.append({"id": model["id"], "label": model.get("name") or model["id"],
                "engine": "mona",
                "provider": source["name"], "providerLabel": source["label"], "model": model["id"],
                "isBuiltin": bool(source.get("is_builtin")), "contextWindow": model.get("context_window"),
                "description": model.get("description"), "reasoningEfforts": model.get("reasoning_efforts"),
                "reasoningEffort": model.get("default_reasoning_effort"), "preset": False})
    return result


def resolve_coding_model(config: Config, model: str | None, provider: str | None = None,
                         effort: str | None = None, *, require_visible: bool = False) -> ModelPresetConfig:
    if provider is None:
        selected = model or config.development.model_preset
        preset = config.resolve_preset(selected)
        if selected is None or selected == "default":
            coding = config.development.coding
            return preset.model_copy(update={"max_tokens": coding.max_tokens, "temperature": coding.temperature,
                "reasoning_effort": coding.reasoning_effort, "auto_compact_token_limit": None})
        return preset
    choice = next((item for item in coding_models(config, include_hidden=not require_visible) if (item["provider"], item["model"]) == (provider, model)), None)
    if choice is None:
        raise DevelopmentError("model_source_unavailable", "此来源的模型未配置或已隐藏，请在模型供应商中启用后重新选择。")
    if effort is not None and effort not in (choice.get("reasoningEfforts") or []):
        raise DevelopmentError("unsupported_reasoning_effort", "当前模型未声明支持此推理强度，请重新选择。")
    base = resolve_coding_model(config, None)
    return base.model_copy(update={"provider": provider, "model": model,
        "reasoning_effort": effort or choice.get("reasoningEffort")})
