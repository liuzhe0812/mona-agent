"""Model sources are independent of their protocol and execution engines."""
from dataclasses import replace

from mona.providers.cindy_catalog import CINDY_CHAT_PROVIDERS, CINDY_OFFICIAL_API_PRESETS

OFFICIAL_SOURCE_IDS = frozenset({"openai", "anthropic"})
# Official entries retain registry.py's native backend; no protocol conversion.
CHAT_SOURCE_PROVIDERS = (
    replace(CINDY_OFFICIAL_API_PRESETS["openai"], id="openai", name="OpenAI",
            wire_api="openai-completions", api_base_editable=True),
    replace(CINDY_OFFICIAL_API_PRESETS["anthropic"], id="anthropic", name="Anthropic",
            api_base_editable=True),
    *CINDY_CHAT_PROVIDERS,
)
CHAT_SOURCE_PROVIDER_BY_ID = {entry.id: entry for entry in CHAT_SOURCE_PROVIDERS}


def source_group(provider: str) -> str:
    if provider == "mona_managed":
        return "mona"
    return provider if provider in OFFICIAL_SOURCE_IDS else "custom"
