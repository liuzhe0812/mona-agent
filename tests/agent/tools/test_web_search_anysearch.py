from __future__ import annotations

import httpx
import pytest

from mona.agent.tools.web import WebSearchConfig, WebSearchTool
from mona.config.loader import _migrate_config
from mona.webui.settings_api import _WEB_SEARCH_PROVIDER_OPTIONS


def _response(payload: dict) -> httpx.Response:
    return httpx.Response(
        200,
        json=payload,
        request=httpx.Request("POST", "https://api.anysearch.com/v1/search"),
    )


@pytest.mark.asyncio
async def test_anysearch_anonymous_chinese_search(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def post(_client, url: str, **kwargs):
        captured.update(url=url, **kwargs)
        return _response(
            {
                "code": 0,
                "data": {
                    "results": [
                        {
                            "title": "国务院文件",
                            "url": "https://www.gov.cn/policy.html",
                            "snippet": "政策原文",
                        }
                    ]
                },
            }
        )

    monkeypatch.delenv("ANYSEARCH_API_KEY", raising=False)
    monkeypatch.setattr(httpx.AsyncClient, "post", post)

    result = await WebSearchTool().execute("人工智能政策", count=3)

    assert captured["url"] == "https://api.anysearch.com/v1/search"
    assert "Authorization" not in captured["headers"]
    assert captured["json"] == {
        "query": "人工智能政策",
        "max_results": 3,
        "zone": "cn",
        "language": "zh-CN",
        "format": "json",
    }
    assert "国务院文件" in result
    assert "https://www.gov.cn/policy.html" in result
    assert "政策原文" in result


@pytest.mark.asyncio
async def test_anysearch_uses_optional_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    async def post(_client, _url: str, **kwargs):
        captured.update(kwargs)
        return _response(
            {"code": 0, "data": {"results": [{"title": "Result", "url": "https://example.com"}]}}
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    tool = WebSearchTool(config=WebSearchConfig(api_key="test-key"))

    await tool.execute("Mona release notes", count=1)

    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["json"]["zone"] == "intl"
    assert captured["json"]["language"] == "en"


@pytest.mark.asyncio
async def test_anysearch_failure_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    async def post(_client, _url: str, **_kwargs):
        raise httpx.ConnectError("unavailable")

    async def fallback(_tool, query: str, count: int) -> str:
        return f"fallback:{query}:{count}"

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    monkeypatch.setattr(WebSearchTool, "_search_duckduckgo", fallback)

    assert await WebSearchTool().execute("test", count=2) == "fallback:test:2"


def test_anysearch_is_the_default_provider() -> None:
    assert WebSearchConfig().provider == "anysearch"
    assert _WEB_SEARCH_PROVIDER_OPTIONS[0] == {
        "name": "anysearch",
        "label": "AnySearch",
        "credential": "none",
    }


def test_legacy_default_search_provider_migrates_to_anysearch() -> None:
    data = {
        "tools": {
            "web": {
                "search": {
                    "provider": "duckduckgo",
                    "apiKey": "",
                    "baseUrl": "",
                }
            }
        }
    }

    migrated = _migrate_config(data)

    assert migrated["tools"]["web"]["search"]["provider"] == "anysearch"
    assert migrated["tools"]["web"]["search"]["providerDefaultVersion"] == 1


def test_explicit_duckduckgo_selection_is_preserved_after_migration() -> None:
    data = {
        "tools": {
            "web": {
                "search": {
                    "provider": "duckduckgo",
                    "providerDefaultVersion": 1,
                }
            }
        }
    }

    migrated = _migrate_config(data)

    assert migrated["tools"]["web"]["search"]["provider"] == "duckduckgo"
