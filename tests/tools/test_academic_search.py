from __future__ import annotations

import json
import os

import httpx
import pytest

from mona.academic.models import SourceRecord
from mona.academic.providers import (
    ArxivProvider,
    ClinicalTrialsProvider,
    CrossrefProvider,
    EuropePMCProvider,
    OpenAlexProvider,
    merge_records,
    normalize_arxiv_id,
    normalize_doi,
    normalize_nct,
    normalize_pmcid,
    normalize_pmid,
    stable_source_id,
)

RUN_LIVE_RESEARCH_ACCEPTANCE = os.getenv("RUN_LIVE_RESEARCH_ACCEPTANCE") == "1"


def _field(record, name):
    if isinstance(record, dict):
        return record.get(name)
    return getattr(record, name)


@pytest.mark.asyncio
@pytest.mark.skipif(
    not RUN_LIVE_RESEARCH_ACCEPTANCE,
    reason="set RUN_LIVE_RESEARCH_ACCEPTANCE=1 to run live academic API checks",
)
@pytest.mark.parametrize(
    ("provider_cls", "query", "kwargs"),
    [
        pytest.param(OpenAlexProvider, "machine learning", {}, id="openalex"),
        pytest.param(CrossrefProvider, "machine learning", {}, id="crossref"),
        pytest.param(EuropePMCProvider, "cancer", {}, id="europe-pmc"),
        pytest.param(ArxivProvider, "electron", {"min_interval": 3.0}, id="arxiv"),
        pytest.param(ClinicalTrialsProvider, "COVID-19", {}, id="clinicaltrials-gov"),
    ],
)
async def test_live_public_academic_sources_return_valid_source_records(provider_cls, query, kwargs):
    page = await provider_cls(**kwargs).search(query, limit=1)
    assert page.error is None, page.error.to_dict() if page.error else None
    assert len(page.records) <= 1
    assert page.records
    record = SourceRecord.model_validate(page.records[0].model_dump())
    assert record.source_id
    assert record.title or record.doi or record.pmid or record.pmcid or record.arxiv_id or record.nct_id


def _transport(payload, *, content_type="application/json", status_code=200, headers=None):
    def handler(request: httpx.Request) -> httpx.Response:
        content = payload if isinstance(payload, bytes) else (
            payload if isinstance(payload, str) else json.dumps(payload)
        )
        return httpx.Response(
            status_code,
            content=content,
            headers={"content-type": content_type, **(headers or {})},
            request=request,
        )

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_openalex_search_parses_metadata_and_cursor():
    payload = {
        "meta": {"count": 1, "next_cursor": "next-1"},
        "results": [
            {
                "id": "https://openalex.org/W1",
                "doi": "https://doi.org/10.1234/ABC",
                "title": "A reproducible result",
                "publication_date": "2025-01-02",
                "authorships": [{"author": {"display_name": "Ada Lovelace"}}],
                "primary_location": {
                    "landing_page_url": "https://example.org/paper",
                    "source": {"display_name": "Journal of Tests"},
                },
                "abstract_inverted_index": {"A": [1], "result": [2], "reproducible": [0]},
            }
        ],
    }
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=payload, request=request)

    page = await OpenAlexProvider(transport=httpx.MockTransport(handler)).search("reproducible", limit=5)
    assert page.error is None
    assert page.next_cursor == "next-1"
    assert len(page.records) == 1
    record = page.records[0]
    assert _field(record, "source_id").startswith("doi_")
    assert _field(record, "doi") == "10.1234/abc"
    assert _field(record, "authors") == ["Ada Lovelace"]
    assert _field(record, "abstract") == "reproducible A result"
    assert dict(seen[0].url.params)["per_page"] == "5"
    assert dict(seen[0].url.params)["cursor"] == "*"


@pytest.mark.asyncio
async def test_bounded_search_all_passes_cursor_and_stops_at_page_budget():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(dict(request.url.params))
        index = len(calls)
        return httpx.Response(
            200,
            json={
                "meta": {"next_cursor": f"cursor-{index}"},
                "results": [{"title": f"Paper {index}", "publication_date": "2024"}],
            },
            request=request,
        )

    page = await OpenAlexProvider(transport=httpx.MockTransport(handler)).search_all(
        "query", limit=1, max_pages=2
    )
    assert len(page.records) == 2
    assert len(calls) == 2
    assert calls[0]["cursor"] == "*"
    assert calls[1]["cursor"] == "cursor-1"
    assert page.next_cursor == "cursor-2"


@pytest.mark.asyncio
async def test_crossref_search_metadata_and_references_preserve_formal_fields():
    responses = [
        {
            "message": {
                "next-cursor": "crossref-next",
                "items": [
                    {
                        "DOI": "10.5555/TEST",
                        "title": ["Crossref paper"],
                        "author": [{"given": "Grace", "family": "Hopper"}],
                        "container-title": ["Journal"],
                        "published-print": {"date-parts": [[2024, 4, 5]]},
                        "URL": "https://doi.org/10.5555/TEST",
                        "abstract": "<jats:p>Evidence.</jats:p>",
                    }
                ],
            }
        },
        {"message": {"DOI": "10.5555/TEST", "title": ["Crossref paper"]}},
        {"message": {"reference": [{"DOI": "10.1111/REF", "article-title": "Prior paper"}]}},
    ]
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=responses[len(calls) - 1], request=request)

    provider = CrossrefProvider(transport=httpx.MockTransport(handler), mailto="researcher@example.org")
    search = await provider.search("crossref paper", limit=3)
    metadata = await provider.metadata("https://doi.org/10.5555/TEST")
    citations = await provider.citations("10.5555/TEST")
    record = search.records[0]
    assert _field(record, "published_at") == "2024-4-5"
    assert _field(record, "abstract") == "Evidence."
    assert _field(record, "source_id").startswith("doi_")
    assert _field(metadata.records[0], "doi") == "10.5555/test"
    assert _field(citations.records[0], "source_id").startswith("doi_")
    assert all(request.headers["user-agent"] for request in calls)
    assert all(request.url.params["mailto"] == "researcher@example.org" for request in calls)


@pytest.mark.asyncio
async def test_europe_pmc_search_keeps_pmid_pmcid_and_cursor():
    payload = {
        "hitCount": 1,
        "nextCursorMark": "epmc-next",
        "resultList": {
            "result": [
                {
                    "id": "123456",
                    "pmid": "123456",
                    "pmcid": "PMC7654321",
                    "doi": "10.2222/epmc",
                    "title": "Biomedical result",
                    "authorList": {"author": [{"fullName": "Marie Curie"}]},
                    "journalTitle": "Open Medicine",
                    "firstPublicationDate": "2023-02-03",
                    "abstractText": "An abstract.",
                    "fullTextUrlList": {"fullTextUrl": [{"url": "https://europepmc.org/articles/PMC7654321"}]},
                }
            ]
        },
    }
    page = await EuropePMCProvider(transport=_transport(payload)).search("biomedical", limit=7)
    assert page.next_cursor == "epmc-next"
    record = page.records[0]
    assert _field(record, "source_id").startswith("doi_")
    assert _field(record, "pmid") == "123456"
    assert _field(record, "pmcid") == "PMC7654321"
    assert _field(record, "authors") == ["Marie Curie"]


@pytest.mark.asyncio
async def test_arxiv_atom_parses_versionless_id_and_respects_cursor():
    atom = """<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">2</opensearch:totalResults>
      <entry>
        <id>http://arxiv.org/abs/2301.12345v2</id>
        <title>  A paper  </title>
        <summary> An abstract. </summary>
        <published>2023-01-15T00:00:00Z</published>
        <author><name>Alan Turing</name></author>
        <link title="doi" href="https://doi.org/10.3333/arxiv" />
        <link rel="alternate" href="http://arxiv.org/abs/2301.12345v2" />
      </entry>
    </feed>"""
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=atom, headers={"content-type": "application/atom+xml"}, request=request)

    page = await ArxivProvider(transport=httpx.MockTransport(handler), min_interval=0).search("paper", cursor="1")
    record = page.records[0]
    assert _field(record, "arxiv_id") == "2301.12345"
    assert _field(record, "version") == "v2"
    assert _field(record, "doi") == "10.3333/arxiv"
    assert _field(record, "source_id").startswith("doi_")
    assert dict(seen[0].url.params)["start"] == "1"
    assert page.next_cursor is None


@pytest.mark.asyncio
async def test_clinicaltrials_search_and_metadata_parse_trial_fields():
    payload = {
        "nextPageToken": "trial-next",
        "studies": [
            {
                "protocolSection": {
                    "identificationModule": {"nctId": "NCT01234567", "briefTitle": "Trial title"},
                    "statusModule": {"studyFirstPostDateStruct": {"date": "2022-06-01"}},
                    "descriptionModule": {"briefSummary": "Trial summary"},
                    "sponsorCollaboratorsModule": {"leadSponsor": {"name": "Example Hospital"}},
                }
            }
        ],
    }
    provider = ClinicalTrialsProvider(transport=_transport(payload))
    page = await provider.search("trial", limit=4)
    record = page.records[0]
    assert page.next_cursor == "trial-next"
    assert _field(record, "source_id").startswith("nct_")
    assert _field(record, "nct_id") == "NCT01234567"
    assert _field(record, "source_type") == "trial"
    assert _field(record, "authors") == ["Example Hospital"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "provider_cls,content_type,payload",
    [
        (OpenAlexProvider, "application/json", b"not-json"),
        (CrossrefProvider, "application/json", b"not-json"),
        (EuropePMCProvider, "application/json", b"not-json"),
        (ArxivProvider, "application/atom+xml", b"<feed>"),
        (ClinicalTrialsProvider, "application/json", b"not-json"),
    ],
)
async def test_malformed_provider_response_is_structured(provider_cls, content_type, payload):
    provider = provider_cls(transport=_transport(payload, content_type=content_type), min_interval=0) if provider_cls is ArxivProvider else provider_cls(transport=_transport(payload, content_type=content_type))
    page = await provider.search("query", limit=1)
    assert page.records == []
    assert page.error is not None
    assert page.error.provider == provider.provider
    assert page.error.code in {"malformed_json", "malformed_xml"}


@pytest.mark.asyncio
async def test_rate_limit_timeout_and_cursor_errors_are_distinct():
    def rate_limited(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"retry-after": "12"}, request=request)

    page = await OpenAlexProvider(transport=httpx.MockTransport(rate_limited)).search("query")
    assert page.error is not None
    assert page.error.code == "rate_limited"
    assert page.error.retry_after == 12
    assert page.error.retryable is True

    def timed_out(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("fixture timeout", request=request)

    page = await OpenAlexProvider(transport=httpx.MockTransport(timed_out)).search("query")
    assert page.error is not None
    assert page.error.code == "timeout"

    page = await ArxivProvider(transport=_transport("unused"), min_interval=0).search("query", cursor="bad")
    assert page.error is not None
    assert page.error.code == "invalid_cursor"


def test_identifier_normalization_and_stable_priority():
    assert normalize_doi(" HTTPS://doi.org/10.1234/ABC. ") == "10.1234/abc"
    assert normalize_pmid("PMID: 12345") == "12345"
    assert normalize_pmcid("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12345/") == "PMC12345"
    assert normalize_arxiv_id("https://arxiv.org/abs/2301.12345v3") == ("2301.12345", "v3")
    assert normalize_nct("https://clinicaltrials.gov/study/NCT01234567") == "NCT01234567"
    assert stable_source_id(doi="10.1234/ABC", pmid="123") == stable_source_id(doi="10.1234/abc")
    assert stable_source_id(title="Same title", published_at="2024-05-01") == stable_source_id(title="Same title", published_at="2024")
    assert stable_source_id(title="Same title", published_at="2023") != stable_source_id(title="Same title", published_at="2024")


def test_merge_records_deduplicates_versions_and_only_fills_empty_fields():
    openalex = {
        "schema_version": 1,
        "source_id": stable_source_id(doi="10.5555/merge"),
        "title": "Formal title",
        "authors": [],
        "published_at": "2024-01-01",
        "venue": "Formal Journal",
        "source_type": "paper",
        "doi": "10.5555/merge",
        "pmid": None,
        "pmcid": None,
        "arxiv_id": None,
        "nct_id": None,
        "url": None,
        "abstract": None,
        "retrieved_at": None,
        "provider": "openalex",
        "providers": ["openalex"],
        "version": None,
    }
    crossref = {**openalex, "provider": "crossref", "providers": ["crossref"], "authors": ["Author"], "abstract": "Abstract"}
    merged = merge_records([openalex, crossref])
    assert len(merged) == 1
    assert _field(merged[0], "authors") == ["Author"]
    assert _field(merged[0], "abstract") == "Abstract"
    assert _field(merged[0], "venue") == "Formal Journal"
    assert set(_field(merged[0], "providers")) == {"openalex", "crossref"}

    v1 = {**openalex, "source_id": stable_source_id(arxiv_id="2301.12345"), "doi": None, "arxiv_id": "2301.12345", "provider": "arxiv", "providers": ["arxiv"], "version": "v1"}
    v2 = {**v1, "version": "v2"}
    assert len(merge_records([v1, v2])) == 1

    different_year = {**openalex, "source_id": "title:other", "doi": None, "title": "Formal title", "published_at": "2023-01-01"}
    assert len(merge_records([openalex, different_year])) == 2
