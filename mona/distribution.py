"""Official public distribution endpoints."""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_EXPERT_CATALOG_URLS = (
    "https://mona-ai.cn/config/experts/catalog-v1.json",
)
DEFAULT_RUNTIME_CATALOG_URLS = (
    "https://mona-ai.cn/config/runtimes/catalog-v1.json",
)


@dataclass(frozen=True, slots=True)
class DistributionSettings:
    expert_catalog_urls: tuple[str, ...]
    runtime_catalog_urls: tuple[str, ...]

    @classmethod
    def load(cls) -> DistributionSettings:
        return cls(
            expert_catalog_urls=DEFAULT_EXPERT_CATALOG_URLS,
            runtime_catalog_urls=DEFAULT_RUNTIME_CATALOG_URLS,
        )


__all__ = [
    "DEFAULT_EXPERT_CATALOG_URLS",
    "DEFAULT_RUNTIME_CATALOG_URLS",
    "DistributionSettings",
]
