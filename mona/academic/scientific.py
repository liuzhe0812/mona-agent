"""Small, approved scientific-tool backend used when ToolUniverse is absent.

Only two read-only HTTP tools are exposed.  The backend deliberately accepts
structured arguments and returns the upstream response; it never accepts a
file path, uploads data, or invents a result.
"""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qs, quote, urlparse

import httpx

PUBCHEM_TOOL_ID = "pubchem_compound_properties"
UNIPROT_TOOL_ID = "uniprotkb_search"

_DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
_USER_AGENT = "MonaApprovedScientific/0.1"
_PUBCHEM_ENDPOINT = "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name"
_UNIPROT_ENDPOINT = "https://rest.uniprot.org/uniprotkb/search"
_PUBCHEM_PROPERTIES = {
    "MolecularFormula",
    "MolecularWeight",
    "CanonicalSMILES",
    "IsomericSMILES",
    "InChIKey",
    "InChI",
    "XLogP",
    "HBondDonorCount",
    "HBondAcceptorCount",
    "RotatableBondCount",
    "ExactMass",
    "MonoisotopicMass",
    "TPSA",
}
_UNIPROT_FIELDS = {
    "accession",
    "id",
    "protein_name",
    "gene_names",
    "organism_name",
    "organism_id",
    "reviewed",
    "length",
    "sequence",
}
_DEFAULT_PUBCHEM_PROPERTIES = ["MolecularFormula", "MolecularWeight"]
_DEFAULT_UNIPROT_FIELDS = ["accession", "id", "protein_name", "gene_names", "organism_name", "reviewed"]


@dataclass(frozen=True, slots=True)
class _ToolSpec:
    tool_id: str
    name: str
    description: str
    version: str
    endpoint: str
    method: str
    official_source: str
    license_url: str
    citation_url: str
    license: str
    citation: str
    parameters: dict[str, Any]
    limits: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "tool_id": self.tool_id,
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "endpoint": self.endpoint,
            "method": self.method,
            "read_only": True,
            "official_source": self.official_source,
            "license_url": self.license_url,
            "citation_url": self.citation_url,
            "license": self.license,
            "citation": self.citation,
            "parameters": copy.deepcopy(self.parameters),
            "limits": copy.deepcopy(self.limits),
        }


_PUBCHEM_SPEC = _ToolSpec(
    tool_id=PUBCHEM_TOOL_ID,
    name="PubChem compound properties",
    description="Resolve a compound name and return selected precomputed PubChem properties.",
    version="PUG REST",
    endpoint=_PUBCHEM_ENDPOINT,
    method="GET",
    official_source="https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest",
    license_url="https://pubchem.ncbi.nlm.nih.gov/docs/downloads",
    citation_url="https://pubchem.ncbi.nlm.nih.gov/docs/citation-guidelines",
    license="PubChem is free to use; contributor-specific licensing and provenance can apply.",
    citation="PubChem citation guidance; PUG-REST DOI 10.1093/nar/gky294.",
    parameters={
        "name": {"type": "string", "required": True, "description": "Compound name."},
        "properties": {
            "type": "array|string",
            "required": False,
            "default": ["MolecularFormula", "MolecularWeight"],
            "allowed": sorted(_PUBCHEM_PROPERTIES),
        },
    },
    limits={"max_requests_per_second": 5, "server_timeout_seconds": 30},
)

_UNIPROT_SPEC = _ToolSpec(
    tool_id=UNIPROT_TOOL_ID,
    name="UniProtKB search",
    description="Search UniProtKB protein entries and return selected JSON result fields.",
    version="UniProtKB REST API",
    endpoint=_UNIPROT_ENDPOINT,
    method="GET",
    official_source="https://www.uniprot.org/help/api_queries",
    license_url="https://www.uniprot.org/help/license/",
    citation_url="https://www.uniprot.org/help/publications",
    license="Copyrightable database parts are CC BY 4.0; other rights may apply.",
    citation="The UniProt Consortium, UniProt: the Universal Protein Knowledgebase in 2025.",
    parameters={
        "query": {"type": "string", "required": True, "description": "UniProtKB query."},
        "size": {"type": "integer", "required": False, "default": 10, "minimum": 1, "maximum": 100},
        "cursor": {"type": "string", "required": False, "description": "UniProt cursor token."},
        "fields": {
            "type": "array|string",
            "required": False,
            "default": ["accession", "id", "protein_name", "gene_names", "organism_name", "reviewed"],
            "allowed": sorted(_UNIPROT_FIELDS),
        },
    },
    limits={"max_results_per_request": 100},
)

_SPECS = {spec.tool_id: spec for spec in (_PUBCHEM_SPEC, _UNIPROT_SPEC)}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _failure(
    tool_id: str,
    error_code: str,
    message: str,
    *,
    http_status: int | None = None,
    retryable: bool = False,
    parameters: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": "failed",
        "tool_id": tool_id,
        "version": _SPECS.get(tool_id).version if tool_id in _SPECS else None,
        "error_code": error_code,
        "message": message,
        "retryable": retryable,
        "parameters": parameters or {},
        "data_sources": [_SPECS[tool_id].official_source] if tool_id in _SPECS else [],
        "finished_at": _now_iso(),
    }
    if http_status is not None:
        payload["http_status"] = http_status
    return payload


def _values(
    value: Any,
    *,
    allowed: set[str],
    field_name: str,
    default: list[str],
) -> list[str] | dict[str, Any]:
    if value is None:
        return list(default)
    if isinstance(value, str):
        values = [part.strip() for part in value.split(",") if part.strip()]
    elif isinstance(value, list) and all(isinstance(part, str) for part in value):
        values = [part.strip() for part in value if part.strip()]
    else:
        return {"error_code": "invalid_arguments", "message": f"{field_name} must be a string or list of strings"}
    if not values or len(values) > 20 or any(part not in allowed for part in values):
        return {"error_code": "invalid_arguments", "message": f"unsupported {field_name}"}
    return list(dict.fromkeys(values))


def _unknown_arguments(arguments: dict[str, Any], allowed: set[str]) -> str | None:
    unknown = sorted(set(arguments) - allowed)
    if unknown:
        return f"unsupported arguments: {', '.join(unknown)}"
    return None


def _next_cursor(link: str | None) -> str | None:
    if not link:
        return None
    for chunk in link.split(","):
        if 'rel="next"' not in chunk:
            continue
        match = re.search(r"<([^>]+)>", chunk)
        if not match:
            continue
        cursor = parse_qs(urlparse(match.group(1)).query).get("cursor")
        return cursor[0] if cursor else None
    return None


class ApprovedScientificBackend:
    """Approved, read-only PubChem and UniProt backend for ``ScientificTool``."""

    __version__ = "approved-1"

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: httpx.Timeout | float = _DEFAULT_TIMEOUT,
        user_agent: str = _USER_AGENT,
    ) -> None:
        self.transport = transport
        self.timeout = timeout
        self.user_agent = user_agent

    async def discover(self, query: str = "", limit: int = 10) -> dict[str, Any]:
        needle = (query or "").strip().casefold()
        matches = []
        for spec in _SPECS.values():
            payload = spec.as_dict()
            searchable = " ".join((payload["tool_id"], payload["name"], payload["description"])).casefold()
            if not needle or needle in searchable:
                matches.append(payload)
        return {"backend": "approved", "tools": matches[: max(1, min(limit, 50))]}

    async def inspect(self, tool_id: str) -> dict[str, Any] | None:
        spec = _SPECS.get((tool_id or "").strip())
        return spec.as_dict() if spec else None

    async def status(self, tool_id: str | None = None) -> dict[str, Any]:
        if tool_id and tool_id not in _SPECS:
            return {"status": "failed", "error_code": "unknown_tool", "tool_id": tool_id}
        payload: dict[str, Any] = {"status": "ready", "backend": "approved"}
        if tool_id:
            payload.update({"tool_id": tool_id, "version": _SPECS[tool_id].version})
        else:
            payload["tools"] = sorted(_SPECS)
        return payload

    async def _request_json(
        self,
        tool_id: str,
        url: str,
        *,
        params: dict[str, Any],
    ) -> tuple[dict[str, Any] | None, httpx.Response | None, dict[str, Any] | None]:
        try:
            async with httpx.AsyncClient(
                transport=self.transport,
                timeout=self.timeout,
                headers={"Accept": "application/json", "User-Agent": self.user_agent},
                follow_redirects=True,
            ) as client:
                response = await client.get(url, params=params)
        except httpx.TimeoutException as exc:
            return None, None, _failure(tool_id, "timeout", str(exc) or "request timed out", retryable=True)
        except httpx.RequestError as exc:
            return None, None, _failure(tool_id, "transport_error", str(exc) or "request failed", retryable=True)
        if response.status_code >= 400:
            code = "rate_limited" if response.status_code == 429 else "upstream_error" if response.status_code >= 500 else "http_error"
            return None, response, _failure(
                tool_id,
                code,
                f"official service returned HTTP {response.status_code}",
                http_status=response.status_code,
                retryable=response.status_code == 429 or response.status_code >= 500,
            )
        try:
            payload = response.json()
        except ValueError as exc:
            return None, response, _failure(tool_id, "malformed_json", str(exc) or "invalid JSON")
        if not isinstance(payload, dict):
            return None, response, _failure(tool_id, "invalid_payload", "official service returned a non-object JSON payload")
        return payload, response, None

    async def _run_pubchem(self, arguments: dict[str, Any]) -> dict[str, Any]:
        unknown = _unknown_arguments(arguments, {"name", "properties"})
        if unknown:
            return _failure(PUBCHEM_TOOL_ID, "invalid_arguments", unknown, parameters=arguments)
        name = arguments.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 256:
            return _failure(PUBCHEM_TOOL_ID, "invalid_arguments", "name must be a non-empty string", parameters=arguments)
        properties = _values(
            arguments.get("properties"),
            allowed=_PUBCHEM_PROPERTIES,
            field_name="properties",
            default=_DEFAULT_PUBCHEM_PROPERTIES,
        )
        if isinstance(properties, dict):
            return _failure(PUBCHEM_TOOL_ID, properties["error_code"], properties["message"], parameters=arguments)
        props = ",".join(properties)
        url = f"{_PUBCHEM_ENDPOINT}/{quote(name.strip(), safe='')}/property/{quote(props, safe=',')}/JSON"
        payload, response, error = await self._request_json(PUBCHEM_TOOL_ID, url, params={})
        if error:
            error["parameters"] = {"name": name, "properties": properties}
            return error
        if not isinstance(payload.get("PropertyTable"), dict) or not isinstance(payload["PropertyTable"].get("Properties"), list):
            return _failure(PUBCHEM_TOOL_ID, "invalid_payload", "PubChem response lacks PropertyTable.Properties", parameters={"name": name, "properties": properties})
        return {
            "status": "succeeded",
            "tool_id": PUBCHEM_TOOL_ID,
            "version": _PUBCHEM_SPEC.version,
            "parameters": {"name": name, "properties": properties},
            "data_sources": [url, _PUBCHEM_SPEC.official_source],
            "result": payload,
            "raw_status": "succeeded",
            "retrieved_at": _now_iso(),
        }

    async def _run_uniprot(self, arguments: dict[str, Any]) -> dict[str, Any]:
        unknown = _unknown_arguments(arguments, {"query", "size", "cursor", "fields"})
        if unknown:
            return _failure(UNIPROT_TOOL_ID, "invalid_arguments", unknown, parameters=arguments)
        query = arguments.get("query")
        if not isinstance(query, str) or not query.strip() or len(query) > 2000:
            return _failure(UNIPROT_TOOL_ID, "invalid_arguments", "query must be a non-empty string", parameters=arguments)
        size = arguments.get("size", 10)
        if isinstance(size, bool) or not isinstance(size, int) or not 1 <= size <= 100:
            return _failure(UNIPROT_TOOL_ID, "invalid_arguments", "size must be an integer from 1 to 100", parameters=arguments)
        fields = _values(
            arguments.get("fields"),
            allowed=_UNIPROT_FIELDS,
            field_name="fields",
            default=_DEFAULT_UNIPROT_FIELDS,
        )
        if isinstance(fields, dict):
            return _failure(UNIPROT_TOOL_ID, fields["error_code"], fields["message"], parameters=arguments)
        cursor = arguments.get("cursor")
        if cursor is not None and (not isinstance(cursor, str) or len(cursor) > 512):
            return _failure(UNIPROT_TOOL_ID, "invalid_arguments", "cursor must be a short string", parameters=arguments)
        params: dict[str, Any] = {"query": query.strip(), "format": "json", "size": size, "fields": ",".join(fields)}
        if cursor:
            params["cursor"] = cursor
        payload, response, error = await self._request_json(UNIPROT_TOOL_ID, _UNIPROT_ENDPOINT, params=params)
        if error:
            error["parameters"] = params
            return error
        if not isinstance(payload.get("results"), list):
            return _failure(UNIPROT_TOOL_ID, "invalid_payload", "UniProt response lacks results", parameters=params)
        version = response.headers.get("x-uniprot-release") if response else None
        return {
            "status": "succeeded",
            "tool_id": UNIPROT_TOOL_ID,
            "version": version or _UNIPROT_SPEC.version,
            "parameters": params,
            "data_sources": [_UNIPROT_ENDPOINT, _UNIPROT_SPEC.official_source],
            "result": payload,
            "next_cursor": _next_cursor(response.headers.get("link") if response else None),
            "raw_status": "succeeded",
            "retrieved_at": _now_iso(),
        }

    async def run_tool(self, tool_id: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        tool_id = (tool_id or "").strip()
        if tool_id not in _SPECS:
            return _failure(tool_id, "unknown_tool", "tool is not in the approved read-only set")
        arguments = dict(arguments or {})
        if tool_id == PUBCHEM_TOOL_ID:
            return await self._run_pubchem(arguments)
        return await self._run_uniprot(arguments)


__all__ = ["ApprovedScientificBackend", "PUBCHEM_TOOL_ID", "UNIPROT_TOOL_ID"]
