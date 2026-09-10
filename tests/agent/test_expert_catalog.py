"""Expert catalog network/cache contracts."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

import mona.agent.expert_catalog as catalog_module
from mona.agent.expert_catalog import ExpertCatalogClient, ExpertCatalogError


def _catalog(
    version: str = "1.0.0",
    generated_at: str = "2026-08-29T00:00:00Z",
) -> dict:
    return {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "experts": [
            {
                "schemaVersion": 1,
                "id": "com.example.expert",
                "displayName": "Expert",
                "version": version,
                "downloadUrl": "https://downloads.example.test/expert.zip",
                "size": 100,
                "sha256": "a" * 64,
                "runtimePacks": ["python-base@3.12"],
            }
        ],
    }


@pytest.fixture(autouse=True)
def allow_test_hosts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(catalog_module, "validate_url_target", lambda _url: (True, ""))


async def test_fetches_and_caches_valid_catalog(tmp_path: Path) -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json=_catalog(),
            headers={"ETag": '"catalog-v1"'},
            request=request,
        )
    )
    cache = tmp_path / "catalog-cache.json"
    client = ExpertCatalogClient(
        ["https://catalog.example.test/catalog.json"],
        cache,
        transport=transport,
    )

    snapshot = await client.fetch()

    assert snapshot.source == "remote"
    assert snapshot.stale is False
    assert snapshot.catalog.experts[0].id == "com.example.expert"
    assert cache.is_file()
    assert json.loads(cache.read_text(encoding="utf-8"))["etag"] == '"catalog-v1"'


async def test_uses_cache_on_network_failure(tmp_path: Path) -> None:
    cache = tmp_path / "catalog-cache.json"
    first = ExpertCatalogClient(
        ["https://catalog.example.test/catalog.json"],
        cache,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=_catalog(), request=request)
        ),
    )
    await first.fetch()
    failing = ExpertCatalogClient(
        ["https://catalog.example.test/catalog.json"],
        cache,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(503, text="unavailable", request=request)
        ),
    )

    snapshot = await failing.fetch()

    assert snapshot.source == "cache"
    assert snapshot.stale is True
    assert snapshot.catalog.experts[0].version == "1.0.0"


async def test_follows_only_validated_redirects(tmp_path: Path) -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if request.url.host == "catalog.example.test":
            return httpx.Response(
                302,
                headers={"Location": "https://cdn.example.test/catalog.json"},
                request=request,
            )
        return httpx.Response(200, json=_catalog(), request=request)

    client = ExpertCatalogClient(
        ["https://catalog.example.test/catalog.json"],
        tmp_path / "catalog.json",
        transport=httpx.MockTransport(handler),
    )

    snapshot = await client.fetch()

    assert snapshot.source_url == "https://cdn.example.test/catalog.json"
    assert seen == [
        "https://catalog.example.test/catalog.json",
        "https://cdn.example.test/catalog.json",
    ]


async def test_rejects_oversized_catalog_and_does_not_replace_cache(tmp_path: Path) -> None:
    cache = tmp_path / "catalog.json"
    cache.write_text("existing", encoding="utf-8")
    payload = b"x" * 101
    client = ExpertCatalogClient(
        ["https://catalog.example.test/catalog.json"],
        cache,
        max_bytes=100,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, content=payload, request=request)
        ),
    )

    with pytest.raises(ExpertCatalogError, match="size limit"):
        await client.fetch(allow_stale=False)

    assert cache.read_text(encoding="utf-8") == "existing"


async def test_rejects_redirect_to_blocked_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        catalog_module,
        "validate_url_target",
        lambda url: (False, "private") if "127.0.0.1" in url else (True, ""),
    )
    client = ExpertCatalogClient(
        ["https://catalog.example.test/catalog.json"],
        tmp_path / "catalog.json",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                302,
                headers={"Location": "http://127.0.0.1/catalog.json"},
                request=request,
            )
        ),
    )

    with pytest.raises(ExpertCatalogError, match="blocked"):
        await client.fetch(allow_stale=False)


async def test_rejects_catalog_rollback_against_cached_generation(tmp_path: Path) -> None:
    cache = tmp_path / "catalog.json"
    current = ExpertCatalogClient(
        ["https://catalog.example.test/catalog.json"],
        cache,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json=_catalog(generated_at="2026-08-29T00:00:00Z"),
                request=request,
            )
        ),
    )
    await current.fetch()
    rollback = ExpertCatalogClient(
        ["https://catalog.example.test/catalog.json"],
        cache,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                json=_catalog(generated_at="2026-08-28T00:00:00Z"),
                request=request,
            )
        ),
    )

    with pytest.raises(ExpertCatalogError, match="rollback"):
        await rollback.fetch(allow_stale=False)
