"""Model sources are independent of their protocol and execution engines."""
from mona.providers.cindy_catalog import CINDY_CHAT_PROVIDERS, CindyChatProvider

OFFICIAL_SOURCE_IDS = frozenset({"openai", "anthropic"})
# Official entries retain registry.py's native backend; no protocol conversion.
CHAT_SOURCE_PROVIDERS = (
    CindyChatProvider("openai", "OpenAI", "https://api.openai.com/v1", api_base_editable=True),
    CindyChatProvider("anthropic", "Anthropic", "https://api.anthropic.com", api_base_editable=True),
    *CINDY_CHAT_PROVIDERS,
)
CHAT_SOURCE_PROVIDER_BY_ID = {entry.id: entry for entry in CHAT_SOURCE_PROVIDERS}


def source_group(provider: str) -> str:
    if provider == "mona_managed":
        return "mona"
    return provider if provider in OFFICIAL_SOURCE_IDS else "custom"
