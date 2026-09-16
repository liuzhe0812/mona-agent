"""Model information helpers for the onboard wizard.

Provides a static curated table of mainstream chat models, used by the
onboard wizard for autocomplete. This is a lightweight fallback — it does not attempt to
enumerate every model from every provider; users can always type a custom
model name that is not in this table.
"""

from __future__ import annotations

from typing import Any

# Curated model table: { model_name: context_window_tokens }
# Keys are lowercase for case-insensitive lookup; suggestions preserve the
# original casing shown to the user.
_KNOWN_MODELS: dict[str, dict[str, Any]] = {
    # --- Anthropic ---
    "claude-opus-4.5": {"context_window": 200_000},
    "claude-opus-4.1": {"context_window": 200_000},
    "claude-opus-4": {"context_window": 200_000},
    "claude-sonnet-4.5": {"context_window": 200_000},
    "claude-sonnet-4.1": {"context_window": 200_000},
    "claude-sonnet-4": {"context_window": 200_000},
    "claude-3-7-sonnet": {"context_window": 200_000},
    "claude-3-5-sonnet": {"context_window": 200_000},
    "claude-3-5-haiku": {"context_window": 200_000},
    "claude-3-opus": {"context_window": 200_000},
    "claude-3-haiku": {"context_window": 200_000},
    # --- OpenAI ---
    "gpt-5": {"context_window": 272_000},
    "gpt-5-mini": {"context_window": 272_000},
    "gpt-4.1": {"context_window": 1_047_576},
    "gpt-4.1-mini": {"context_window": 1_047_576},
    "gpt-4.1-nano": {"context_window": 1_047_576},
    "gpt-4o": {"context_window": 128_000},
    "gpt-4o-mini": {"context_window": 128_000},
    "gpt-4-turbo": {"context_window": 128_000},
    "gpt-4": {"context_window": 8_192},
    "gpt-3.5-turbo": {"context_window": 16_385},
    "o4-mini": {"context_window": 200_000},
    "o3": {"context_window": 200_000},
    "o3-mini": {"context_window": 200_000},
    "o1": {"context_window": 200_000},
    "o1-mini": {"context_window": 128_000},
    # --- DeepSeek ---
    "deepseek-v3.2": {"context_window": 128_000},
    "deepseek-v3.1": {"context_window": 128_000},
    "deepseek-v3": {"context_window": 64_000},
    "deepseek-r1": {"context_window": 64_000},
    "deepseek-chat": {"context_window": 64_000},
    # --- Google Gemini ---
    "gemini-2.5-pro": {"context_window": 1_048_576},
    "gemini-2.5-flash": {"context_window": 1_048_576},
    "gemini-2.0-flash": {"context_window": 1_048_576},
    "gemini-1.5-pro": {"context_window": 2_097_152},
    "gemini-1.5-flash": {"context_window": 1_048_576},
    # --- Qwen / DashScope ---
    "qwen3-max": {"context_window": 256_000},
    "qwen3-coder-plus": {"context_window": 256_000},
    "qwen3-235b-a22b": {"context_window": 128_000},
    "qwen-max": {"context_window": 32_768},
    "qwen-plus": {"context_window": 131_072},
    "qwen-turbo": {"context_window": 1_000_000},
    # --- Zhipu GLM ---
    "glm-4.6": {"context_window": 200_000},
    "glm-4.5": {"context_window": 128_000},
    "glm-4-plus": {"context_window": 128_000},
    "glm-4-air": {"context_window": 128_000},
    # --- Moonshot Kimi ---
    "kimi-k2.6": {"context_window": 256_000},
    "kimi-k2.5": {"context_window": 256_000},
    "moonshot-v1-128k": {"context_window": 128_000},
    "moonshot-v1-32k": {"context_window": 32_768},
    "moonshot-v1-8k": {"context_window": 8_192},
    # --- MiniMax ---
    "abab7-chat-preview": {"context_window": 245_760},
    "abab6.5s-chat": {"context_window": 245_760},
    "abab6.5-chat": {"context_window": 245_760},
    # --- Mistral ---
    "mistral-large-latest": {"context_window": 128_000},
    "mistral-medium-latest": {"context_window": 32_000},
    "mistral-small-latest": {"context_window": 32_000},
    "codestral-latest": {"context_window": 32_000},
    # --- Meta Llama (via gateways) ---
    "llama-3.3-70b-instruct": {"context_window": 128_000},
    "llama-3.1-405b-instruct": {"context_window": 128_000},
    "llama-3.1-70b-instruct": {"context_window": 128_000},
    "llama-3.1-8b-instruct": {"context_window": 128_000},
}


def get_all_models() -> list[str]:
    """Return all known model names (for autocomplete listing)."""
    return list(_KNOWN_MODELS.keys())


def find_model_info(model_name: str) -> dict[str, Any] | None:
    """Return info dict for a known model, or None if unknown.

    Lookup is case-insensitive.
    """
    return _KNOWN_MODELS.get(model_name.lower())


def get_model_suggestions(_partial: str, provider: str = "auto", limit: int = 20) -> list[str]:
    """Return model names matching the partial input (case-insensitive).

    The `provider` argument is accepted for API compatibility but ignored.
    """
    partial = _partial.lower()
    matches = [m for m in _KNOWN_MODELS if partial in m]
    return matches[:limit]
