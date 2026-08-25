from __future__ import annotations

import json
import os

import httpx
import pytest

from mona.academic.scientific import (
    PUBCHEM_TOOL_ID,
    UNIPROT_TOOL_ID,
    ApprovedScientificBackend,
)

RUN_LIVE_RESEARCH_ACCEPTANCE = os.getenv("RUN_LIVE_RESEARCH_ACCEPTANCE") == "1"


def _json_transport(payload, *, status_code=200, headers=None):
    def handler(request: httpx.Request) -> httpx.Response:
        content = payload if isinstance(payload, (bytes, str)) else json.dumps(payload)
        return httpx.Response(
            status_code,
            content=content,
            headers={"content-type": "application/json", **(headers or {})},
            request=request,
        )

    return httpx.MockTransport(handler)


def _failure_transport(exc: Exception):
    def handler(request: httpx.Request) -> httpx.Response:
        raise exc

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_discover_and_inspect_expose_only_approved_read_only_tools():
    backend = ApprovedScientificBackend(transport=_json_transport({}))
    discovered = await backend.discover("protein", limit=10)
    ids = {tool["tool_id"] for tool in discovered["tools"]}
    assert ids == {UNIPROT_TOOL_ID}
    assert discovered["tools"][0]["read_only"] is True
    assert discovered["tools"][0]["endpoint"] == "https://rest.uniprot.org/uniprotkb/search"

    pubchem = await backend.inspect(PUBCHEM_TOOL_ID)
    assert pubchem is not None
    assert pubchem["read_only"] is True
    assert pubchem["method"] == "GET"
    assert pubchem["license_url"].startswith("https://pubchem.ncbi.nlm.nih.gov/")
    assert pubchem["citation_url"].startswith("https://pubchem.ncbi.nlm.nih.gov/")
    assert await backend.inspect("unapproved.tool") is None


@pytest.mark.asyncio
async def test_pubchem_run_uses_name_property_endpoint_and_preserves_response():
    payload = {
        "PropertyTable": {
            "Properties": [
                {
                    "CID": 2244,
                    "MolecularFormula": "C9H8O4",
                    "MolecularWeight": "180.16",
                }
            ]
        }
    }
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=payload, request=request)

    backend = ApprovedScientificBackend(transport=httpx.MockTransport(handler))
    result = await backend.run_tool(
        PUBCHEM_TOOL_ID,
        {"name": "aspirin", "properties": ["MolecularFormula", "MolecularWeight"]},
    )
    assert result["status"] == "succeeded"
    assert result["result"] == payload
    assert result["data_sources"]
    assert "/compound/name/aspirin/property/MolecularFormula,MolecularWeight/JSON" in str(seen[0].url)
    assert seen[0].headers["accept"] == "application/json"


@pytest.mark.asyncio
async def test_uniprot_run_uses_search_params_and_next_cursor():
    payload = {
        "results": [
            {
                "primaryAccession": "P12345",
                "uniProtkbId": "PROT_HUMAN",
                "proteinDescription": {"recommendedName": {"fullName": {"value": "Example protein"}}},
            }
        ]
    }
    next_url = "https://rest.uniprot.org/uniprotkb/search?cursor=next-token&size=1"
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=payload, headers={"link": f'<{next_url}>; rel="next"'}, request=request)

    backend = ApprovedScientificBackend(transport=httpx.MockTransport(handler))
    result = await backend.run_tool(
        UNIPROT_TOOL_ID,
        {"query": "gene:BRCA1", "size": 1, "fields": ["accession", "id"]},
    )
    assert result["status"] == "succeeded"
    assert result["result"] == payload
    assert result["next_cursor"] == "next-token"
    assert dict(seen[0].url.params)["query"] == "gene:BRCA1"
    assert dict(seen[0].url.params)["format"] == "json"
    assert dict(seen[0].url.params)["size"] == "1"
    assert dict(seen[0].url.params)["fields"] == "accession,id"


@pytest.mark.asyncio
@pytest.mark.parametrize("status_code,error_code", [(429, "rate_limited"), (503, "upstream_error")])
async def test_http_failures_are_structured_and_never_success(status_code, error_code):
    backend = ApprovedScientificBackend(transport=_json_transport({}, status_code=status_code))
    result = await backend.run_tool(PUBCHEM_TOOL_ID, {"name": "aspirin"})
    assert result["status"] == "failed"
    assert result["error_code"] == error_code
    assert result["http_status"] == status_code
    assert result["retryable"] is True


@pytest.mark.asyncio
async def test_timeout_malformed_and_invalid_arguments_fail_closed():
    backend = ApprovedScientificBackend(
        transport=_failure_transport(httpx.ReadTimeout("fixture timeout")),
    )
    timeout = await backend.run_tool(PUBCHEM_TOOL_ID, {"name": "aspirin"})
    assert timeout["status"] == "failed"
    assert timeout["error_code"] == "timeout"

    malformed = await ApprovedScientificBackend(
        transport=_json_transport(b"not-json"),
    ).run_tool(UNIPROT_TOOL_ID, {"query": "P53"})
    assert malformed["status"] == "failed"
    assert malformed["error_code"] == "malformed_json"

    invalid = await ApprovedScientificBackend(transport=_json_transport({})).run_tool(
        PUBCHEM_TOOL_ID,
        {"name": "aspirin", "path": "C:/private/patient.csv"},
    )
    assert invalid["status"] == "failed"
    assert invalid["error_code"] == "invalid_arguments"

    unknown = await ApprovedScientificBackend(transport=_json_transport({})).run_tool(
        "unapproved.tool", {}
    )
    assert unknown["status"] == "failed"
    assert unknown["error_code"] == "unknown_tool"


@pytest.mark.asyncio
@pytest.mark.skipif(
    not RUN_LIVE_RESEARCH_ACCEPTANCE,
    reason="set RUN_LIVE_RESEARCH_ACCEPTANCE=1 to run live scientific API checks",
)
@pytest.mark.parametrize(
    ("tool_id", "arguments"),
    [
        pytest.param(PUBCHEM_TOOL_ID, {"name": "aspirin"}, id="pubchem"),
        pytest.param(UNIPROT_TOOL_ID, {"query": "accession:P04637", "size": 1}, id="uniprot"),
    ],
)
async def test_live_approved_tools_return_one_public_result(tool_id, arguments):
    result = await ApprovedScientificBackend().run_tool(tool_id, arguments)
    assert result["status"] == "succeeded", result
    assert result["result"]
    assert result["data_sources"]
