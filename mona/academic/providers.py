"""Thin, read-only adapters for the supported academic data sources.

The adapters deliberately return the provider's useful fields without trying
to infer missing metadata.  Search orchestration, persistence, and model
policy belong to the academic tool/store layers.
"""

from __future__ import annotations

import asyncio
import hashlib
import html
import random
import re
import time
import unicodedata
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Iterable
from urllib.parse import quote

import httpx
from defusedxml import ElementTree

from .models import SourceRecord

DEFAULT_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)
DEFAULT_USER_AGENT = "MonaAcademicResearch/0.1"

_PROVIDER_REQUEST_LOCKS: dict[str, asyncio.Lock] = {}
_PROVIDER_LAST_REQUEST_AT: dict[str, float] = {}


@dataclass(frozen=True, slots=True)
class ProviderError:
    """A serializable upstream failure; an error is never represented as no results."""

    provider: str
    code: str
    message: str
    status_code: int | None = None
    retry_after: float | None = None
    retryable: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ProviderPage:
    provider: str
    records: list[Any] = field(default_factory=list)
    next_cursor: str | None = None
    error: ProviderError | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "records": [_dump_record(record) for record in self.records],
            "next_cursor": self.next_cursor,
            "provider_errors": [self.error.to_dict()] if self.error else [],
        }


def _dump_record(record: Any) -> dict[str, Any]:
    if hasattr(record, "model_dump"):
        return record.model_dump(mode="json")
    if hasattr(record, "dict"):
        return record.dict()
    return dict(record)


def _text(value: Any) -> str | None:
    if value is None:
        return None
    value = html.unescape(str(value)).strip()
    return value or None


def normalize_doi(value: Any) -> str | None:
    value = _text(value)
    if not value:
        return None
    value = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", value, flags=re.I)
    value = re.sub(r"^doi:\s*", "", value, flags=re.I)
    value = value.strip().rstrip(".,;)").lower()
    return value if re.fullmatch(r"10\.\d{4,9}/\S+", value) else None


def normalize_pmid(value: Any) -> str | None:
    value = _text(value)
    if not value:
        return None
    value = re.sub(r"^https?://(?:www\.)?ncbi\.nlm\.nih\.gov/pubmed/", "", value, flags=re.I)
    value = re.sub(r"^pmid:\s*", "", value, flags=re.I).strip().rstrip(".,;)")
    return value if value.isdigit() else None


def normalize_pmcid(value: Any) -> str | None:
    value = _text(value)
    if not value:
        return None
    value = re.sub(r"^https?://(?:www\.)?ncbi\.nlm\.nih\.gov/pmc/articles/", "", value, flags=re.I)
    value = re.sub(r"^pmcid:\s*", "", value, flags=re.I).strip().rstrip(".,;)/")
    value = value.upper()
    return value if re.fullmatch(r"PMC\d+", value) else None


def normalize_arxiv_id(value: Any) -> tuple[str | None, str | None]:
    """Return the versionless arXiv identifier and its optional version."""

    value = _text(value)
    if not value:
        return None, None
    value = re.sub(r"^https?://arxiv\.org/(?:abs|pdf)/", "", value, flags=re.I)
    value = re.sub(r"^arxiv:\s*", "", value, flags=re.I)
    value = value.rsplit("/", 1)[-1].removesuffix(".pdf")
    match = re.fullmatch(r"(.+?)(v(\d+))?", value, flags=re.I)
    if not match:
        return None, None
    base = match.group(1)
    version = match.group(2)
    if not (re.fullmatch(r"\d{4}\.\d{4,5}", base) or re.fullmatch(r"[a-z-]+(?:\.[A-Z]{2})?/\d{7}", base, re.I)):
        return None, None
    return base, version.lower() if version else None


def normalize_nct(value: Any) -> str | None:
    value = _text(value)
    if not value:
        return None
    value = re.sub(r"^https?://clinicaltrials\.gov/study/", "", value, flags=re.I)
    value = value.strip().rstrip(".,;)/").upper()
    return value if re.fullmatch(r"NCT\d{8}", value) else None


def _year(value: Any) -> str | None:
    value = _text(value)
    match = re.search(r"\b(\d{4})\b", value or "")
    return match.group(1) if match else None


def normalize_title(value: Any) -> str:
    value = unicodedata.normalize("NFKC", _text(value) or "").casefold()
    value = "".join(char for char in value if char.isalnum() or char.isspace())
    return " ".join(value.split())


def stable_source_id(
    *,
    doi: Any = None,
    pmid: Any = None,
    pmcid: Any = None,
    arxiv_id: Any = None,
    nct_id: Any = None,
    title: Any = None,
    published_at: Any = None,
) -> str:
    def _id(prefix: str, value: str) -> str:
        # SourceRecord IDs are path-safe; the original identifier remains in
        # its dedicated field, while this digest avoids punctuation collisions.
        return f"{prefix}_{hashlib.sha256(value.encode('utf-8')).hexdigest()}"

    doi = normalize_doi(doi)
    if doi:
        return _id("doi", doi)
    pmid = normalize_pmid(pmid)
    if pmid:
        return _id("pmid", pmid)
    pmcid = normalize_pmcid(pmcid)
    if pmcid:
        return _id("pmcid", pmcid)
    arxiv_id, _ = normalize_arxiv_id(arxiv_id)
    if arxiv_id:
        return _id("arxiv", arxiv_id)
    nct_id = normalize_nct(nct_id)
    if nct_id:
        return _id("nct", nct_id)
    key = f"{normalize_title(title)}|{_year(published_at) or ''}"
    return f"title_{hashlib.sha256(key.encode('utf-8')).hexdigest()}"


def _record_payload(
    *,
    provider: str,
    title: Any = None,
    authors: Iterable[Any] | None = None,
    published_at: Any = None,
    venue: Any = None,
    source_type: str = "paper",
    doi: Any = None,
    pmid: Any = None,
    pmcid: Any = None,
    arxiv_id: Any = None,
    nct_id: Any = None,
    url: Any = None,
    abstract: Any = None,
    version: Any = None,
) -> dict[str, Any]:
    doi = normalize_doi(doi)
    pmid = normalize_pmid(pmid)
    pmcid = normalize_pmcid(pmcid)
    arxiv_id, arxiv_version = normalize_arxiv_id(arxiv_id)
    nct_id = normalize_nct(nct_id)
    authors_out = [_text(author) for author in authors or []]
    authors_out = [author for author in authors_out if author]
    payload = {
        "schema_version": 1,
        "source_id": stable_source_id(
            doi=doi,
            pmid=pmid,
            pmcid=pmcid,
            arxiv_id=arxiv_id,
            nct_id=nct_id,
            title=title,
            published_at=published_at,
        ),
        "title": _text(title),
        "authors": authors_out,
        "published_at": _text(published_at),
        "venue": _text(venue),
        "source_type": source_type,
        "doi": doi,
        "pmid": pmid,
        "pmcid": pmcid,
        "arxiv_id": arxiv_id,
        "nct_id": nct_id,
        "url": _text(url),
        "abstract": _text(abstract),
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "provider": provider,
        "providers": [provider],
        "version": _text(version) or arxiv_version,
    }
    return payload


def _make_record(payload: dict[str, Any]) -> Any:
    # Keep compatibility with the contract model while retaining the raw
    # provider fields.  A model may choose date/datetime or string types.
    try:
        return SourceRecord.model_validate(payload)
    except AttributeError:
        return SourceRecord(**payload)


def _get(record: Any, name: str, default: Any = None) -> Any:
    if isinstance(record, dict):
        return record.get(name, default)
    return getattr(record, name, default)


def _set(record: Any, name: str, value: Any) -> Any:
    if isinstance(record, dict):
        record[name] = value
        return record
    try:
        setattr(record, name, value)
    except (AttributeError, TypeError):
        # Pydantic models are often frozen.  Rebuild through model validation.
        data = _dump_record(record)
        data[name] = value
        return _make_record(data)
    return record


def _error_from_response(provider: str, response: httpx.Response) -> ProviderError:
    status = response.status_code
    retry_after = None
    raw_retry_after = response.headers.get("retry-after")
    if raw_retry_after:
        try:
            retry_after = float(raw_retry_after)
        except ValueError:
            try:
                retry_at = parsedate_to_datetime(raw_retry_after)
                if retry_at.tzinfo is None:
                    retry_at = retry_at.replace(tzinfo=timezone.utc)
                retry_after = max(
                    0.0,
                    (retry_at - datetime.now(timezone.utc)).total_seconds(),
                )
            except (TypeError, ValueError, OverflowError):
                retry_after = None
    return ProviderError(
        provider=provider,
        code="rate_limited" if status == 429 else "http_error",
        message=f"{provider} returned HTTP {status}",
        status_code=status,
        retry_after=retry_after,
        retryable=status == 429 or status >= 500,
    )


class _HTTPProvider:
    provider = "academic"
    default_min_interval = 0.0

    def __init__(
        self,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: httpx.Timeout | float = DEFAULT_TIMEOUT,
        user_agent: str = DEFAULT_USER_AGENT,
        min_interval: float | None = None,
        max_retries: int = 2,
        max_retry_wait: float = 15.0,
        retry_base_delay: float = 0.5,
    ) -> None:
        self.transport = transport
        self.timeout = timeout
        self.user_agent = user_agent
        self.min_interval = max(
            0.0,
            self.default_min_interval if min_interval is None else min_interval,
        )
        self.max_retries = max(0, max_retries)
        self.max_retry_wait = max(0.0, max_retry_wait)
        self.retry_base_delay = max(0.0, retry_base_delay)

    async def _request(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        params: dict[str, Any] | None,
    ) -> httpx.Response:
        lock = _PROVIDER_REQUEST_LOCKS.setdefault(self.provider, asyncio.Lock())
        async with lock:
            wait = self.min_interval - (
                time.monotonic() - _PROVIDER_LAST_REQUEST_AT.get(self.provider, 0.0)
            )
            if wait > 0:
                await asyncio.sleep(wait)
            _PROVIDER_LAST_REQUEST_AT[self.provider] = time.monotonic()
            return await client.get(url, params=params)

    def _retry_delay(self, error: ProviderError, attempt: int) -> float:
        if error.retry_after is not None:
            return max(0.0, error.retry_after)
        base = self.retry_base_delay * (2**attempt)
        return base + random.uniform(0.0, base * 0.25)

    async def _get(self, url: str, *, params: dict[str, Any] | None = None) -> tuple[httpx.Response | None, ProviderError | None]:
        waited = 0.0
        async with httpx.AsyncClient(
            transport=self.transport,
            timeout=self.timeout,
            headers={"Accept": "application/json", "User-Agent": self.user_agent},
            follow_redirects=True,
        ) as client:
            for attempt in range(self.max_retries + 1):
                response: httpx.Response | None = None
                try:
                    response = await self._request(client, url, params=params)
                except httpx.TimeoutException as exc:
                    error = ProviderError(
                        self.provider,
                        "timeout",
                        str(exc) or "request timed out",
                        retryable=True,
                    )
                except httpx.RequestError as exc:
                    error = ProviderError(
                        self.provider,
                        "transport_error",
                        str(exc) or "request failed",
                        retryable=True,
                    )
                else:
                    if response.status_code < 400:
                        return response, None
                    error = _error_from_response(self.provider, response)

                if not error.retryable or attempt >= self.max_retries:
                    return response, error
                delay = self._retry_delay(error, attempt)
                if waited + delay > self.max_retry_wait:
                    return response, error
                if delay > 0:
                    await asyncio.sleep(delay)
                waited += delay

        raise AssertionError("academic provider retry loop ended unexpectedly")

    async def _json(self, url: str, *, params: dict[str, Any] | None = None) -> tuple[Any, ProviderError | None]:
        response, error = await self._get(url, params=params)
        if error:
            return None, error
        try:
            return response.json(), None
        except ValueError as exc:
            return None, ProviderError(self.provider, "malformed_json", str(exc) or "invalid JSON")

    async def _xml(self, url: str, *, params: dict[str, Any] | None = None) -> tuple[Any, ProviderError | None]:
        response, error = await self._get(url, params=params)
        if error:
            return None, error
        try:
            return ElementTree.fromstring(response.content), None
        except ElementTree.ParseError as exc:
            return None, ProviderError(self.provider, "malformed_xml", str(exc) or "invalid XML")

    async def search_all(self, query: str, *, limit: int = 20, max_pages: int = 3) -> ProviderPage:
        """Bounded cursor pagination; the caller can choose a stricter budget."""

        records: list[Any] = []
        cursor: str | None = None
        for _ in range(max(1, max_pages)):
            page = await self.search(query, limit=limit, cursor=cursor)  # type: ignore[attr-defined]
            records.extend(page.records)
            if page.error:
                return ProviderPage(self.provider, records=records, error=page.error)
            if not page.next_cursor or page.next_cursor == cursor:
                cursor = page.next_cursor
                break
            cursor = page.next_cursor
        return ProviderPage(self.provider, records=records, next_cursor=cursor)


class OpenAlexProvider(_HTTPProvider):
    provider = "openalex"
    base_url = "https://api.openalex.org"
    default_min_interval = 0.1

    def __init__(self, *, mailto: str | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.mailto = mailto

    def _params(self, params: dict[str, Any]) -> dict[str, Any]:
        return {**params, **({"mailto": self.mailto} if self.mailto else {})}

    @staticmethod
    def _abstract(value: Any) -> str | None:
        if not isinstance(value, dict):
            return _text(value)
        words: list[tuple[int, str]] = []
        for word, positions in value.items():
            for position in positions or []:
                words.append((position, word))
        return " ".join(word for _, word in sorted(words)) or None

    def _record(self, item: dict[str, Any]) -> Any:
        location = item.get("primary_location") or {}
        source = location.get("source") or {}
        authors = [
            (entry.get("author") or {}).get("display_name")
            for entry in item.get("authorships") or []
        ]
        return _make_record(
            _record_payload(
                provider=self.provider,
                title=item.get("title"),
                authors=authors,
                published_at=item.get("publication_date"),
                venue=source.get("display_name"),
                doi=item.get("doi") or (item.get("ids") or {}).get("doi"),
                pmid=(item.get("ids") or {}).get("pmid"),
                url=(location.get("landing_page_url") or item.get("id")),
                abstract=self._abstract(item.get("abstract_inverted_index")),
            )
        )

    async def search(self, query: str, *, limit: int = 20, cursor: str | None = None) -> ProviderPage:
        params: dict[str, Any] = {"search": query, "per_page": min(max(limit, 1), 100), "cursor": cursor or "*"}
        data, error = await self._json(f"{self.base_url}/works", params=self._params(params))
        if error:
            return ProviderPage(self.provider, error=error)
        return ProviderPage(
            self.provider,
            records=[self._record(item) for item in data.get("results") or []],
            next_cursor=((data.get("meta") or {}).get("next_cursor")),
        )

    async def metadata(self, identifier: str) -> ProviderPage:
        normalized = normalize_doi(identifier)
        path = f"/works/https://doi.org/{quote(normalized, safe='') if normalized else quote(identifier, safe='')}"
        data, error = await self._json(f"{self.base_url}{path}", params=self._params({}))
        if error:
            return ProviderPage(self.provider, error=error)
        return ProviderPage(self.provider, records=[self._record(data)])

    async def citations(self, identifier: str, *, limit: int = 20, cursor: str | None = None) -> ProviderPage:
        work_id = _text(identifier)
        if work_id and not re.fullmatch(r"W\d+", work_id.rsplit("/", 1)[-1], flags=re.I):
            normalized = normalize_doi(identifier)
            if normalized:
                lookup_path = f"/works/https://doi.org/{quote(normalized, safe='')}"
                lookup, lookup_error = await self._json(
                    f"{self.base_url}{lookup_path}", params=self._params({})
                )
                if lookup_error:
                    return ProviderPage(self.provider, error=lookup_error)
                work_id = _text(lookup.get("id"))
        work_id = (work_id or "").rsplit("/", 1)[-1]
        if not re.fullmatch(r"W\d+", work_id, flags=re.I):
            return ProviderPage(
                self.provider,
                error=ProviderError(self.provider, "invalid_identifier", "OpenAlex citations require a work ID or DOI"),
            )
        params: dict[str, Any] = {"filter": f"cites:{work_id}", "per_page": min(max(limit, 1), 100), "cursor": cursor or "*"}
        data, error = await self._json(f"{self.base_url}/works", params=self._params(params))
        if error:
            return ProviderPage(self.provider, error=error)
        return ProviderPage(
            self.provider,
            records=[self._record(item) for item in data.get("results") or []],
            next_cursor=((data.get("meta") or {}).get("next_cursor")),
        )


class CrossrefProvider(_HTTPProvider):
    provider = "crossref"
    base_url = "https://api.crossref.org"
    default_min_interval = 0.2

    def __init__(self, *, mailto: str | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.mailto = mailto

    def _params(self, params: dict[str, Any]) -> dict[str, Any]:
        return {**params, **({"mailto": self.mailto} if self.mailto else {})}

    @staticmethod
    def _authors(item: dict[str, Any]) -> list[str]:
        result: list[str] = []
        for author in item.get("author") or []:
            name = author.get("name") or " ".join(
                part for part in (author.get("given"), author.get("family")) if part
            )
            if name:
                result.append(name)
        return result

    @staticmethod
    def _date(item: dict[str, Any]) -> str | None:
        for key in ("published-print", "published-online", "issued", "created"):
            parts = (item.get(key) or {}).get("date-parts") or []
            if parts and parts[0]:
                return "-".join(str(part) for part in parts[0])
        return None

    @staticmethod
    def _strip_abstract(value: Any) -> str | None:
        value = _text(value)
        if not value:
            return None
        return re.sub(r"<[^>]+>", "", value).strip() or None

    def _record(self, item: dict[str, Any]) -> Any:
        item_type = _text(item.get("type")) or "article"
        source_type = "preprint" if "posted" in item_type else "paper"
        return _make_record(
            _record_payload(
                provider=self.provider,
                title=(item.get("title") or [None])[0],
                authors=self._authors(item),
                published_at=self._date(item),
                venue=(item.get("container-title") or [None])[0],
                source_type=source_type,
                doi=item.get("DOI"),
                url=item.get("URL") or ((item.get("link") or [{}])[0].get("URL")),
                abstract=self._strip_abstract(item.get("abstract")),
            )
        )

    async def search(self, query: str, *, limit: int = 20, cursor: str | None = None) -> ProviderPage:
        params: dict[str, Any] = {
            "query.bibliographic": query,
            "rows": min(max(limit, 1), 1000),
            "cursor": cursor or "*",
        }
        data, error = await self._json(f"{self.base_url}/works", params=self._params(params))
        if error:
            return ProviderPage(self.provider, error=error)
        message = data.get("message") or {}
        return ProviderPage(
            self.provider,
            records=[self._record(item) for item in message.get("items") or []],
            next_cursor=message.get("next-cursor"),
        )

    async def metadata(self, identifier: str) -> ProviderPage:
        doi = normalize_doi(identifier) or identifier.strip()
        data, error = await self._json(f"{self.base_url}/works/{quote(doi, safe='')}", params=self._params({}))
        if error:
            return ProviderPage(self.provider, error=error)
        return ProviderPage(self.provider, records=[self._record(data.get("message") or {})])

    async def citations(self, identifier: str, *, limit: int = 20, cursor: str | None = None) -> ProviderPage:
        doi = normalize_doi(identifier) or identifier.strip()
        data, error = await self._json(
            f"{self.base_url}/works/{quote(doi, safe='')}",
            params=self._params({}),
        )
        if error:
            return ProviderPage(self.provider, error=error)
        message = data.get("message") or {}
        records = []
        for item in message.get("reference") or []:
            if not isinstance(item, dict):
                continue
            records.append(
                _make_record(
                    _record_payload(
                        provider=self.provider,
                        title=item.get("article-title") or item.get("unstructured"),
                        authors=[],
                        doi=item.get("DOI"),
                        url=(f"https://doi.org/{normalize_doi(item.get('DOI'))}" if normalize_doi(item.get("DOI")) else None),
                    )
                )
            )
        return ProviderPage(self.provider, records=records[:limit])


class EuropePMCProvider(_HTTPProvider):
    provider = "europe_pmc"
    base_url = "https://www.ebi.ac.uk/europepmc/webservices/rest"
    default_min_interval = 0.1

    @staticmethod
    def _authors(item: dict[str, Any]) -> list[str]:
        author_list = item.get("authorList") or {}
        result = []
        for author in author_list.get("author") or []:
            name = author.get("fullName") or " ".join(
                part for part in (author.get("firstName"), author.get("lastName")) if part
            )
            if name:
                result.append(name)
        if result:
            return result
        return [name.strip() for name in (_text(item.get("authorString")) or "").split(",") if name.strip()]

    def _record(self, item: dict[str, Any]) -> Any:
        full_text_urls = ((item.get("fullTextUrlList") or {}).get("fullTextUrl") or [])
        url = next((entry.get("url") for entry in full_text_urls if entry.get("url")), None)
        pmid = item.get("pmid") or item.get("id")
        return _make_record(
            _record_payload(
                provider=self.provider,
                title=item.get("title"),
                authors=self._authors(item),
                published_at=item.get("firstPublicationDate") or item.get("pubYear"),
                venue=item.get("journalTitle"),
                doi=item.get("doi"),
                pmid=pmid,
                pmcid=item.get("pmcid"),
                url=url,
                abstract=item.get("abstractText"),
            )
        )

    async def search(self, query: str, *, limit: int = 20, cursor: str | None = None) -> ProviderPage:
        params: dict[str, Any] = {
            "query": query,
            "format": "json",
            "resultType": "core",
            "pageSize": min(max(limit, 1), 1000),
        }
        if cursor:
            params["cursorMark"] = cursor
        data, error = await self._json(f"{self.base_url}/search", params=params)
        if error:
            return ProviderPage(self.provider, error=error)
        return ProviderPage(
            self.provider,
            records=[self._record(item) for item in ((data.get("resultList") or {}).get("result") or [])],
            next_cursor=data.get("nextCursorMark"),
        )

    async def metadata(self, identifier: str) -> ProviderPage:
        pmid = normalize_pmid(identifier)
        pmcid = normalize_pmcid(identifier)
        doi = normalize_doi(identifier)
        query = f"EXT_ID:{pmid}" if pmid else f"PMCID:{pmcid}" if pmcid else f'DOI:"{doi}"' if doi else identifier
        return await self.search(query, limit=1)

    async def citations(self, identifier: str, *, limit: int = 20, cursor: str | None = None) -> ProviderPage:
        pmid = normalize_pmid(identifier)
        pmcid = normalize_pmcid(identifier)
        normalized = pmid or pmcid or _text(identifier)
        source = "MED" if pmid else "PMC" if pmcid else "MED"
        params: dict[str, Any] = {"format": "json", "pageSize": min(max(limit, 1), 1000)}
        if cursor:
            params["cursorMark"] = cursor
        data, error = await self._json(f"{self.base_url}/{source}/{quote(normalized, safe='')}/references", params=params)
        if error:
            return ProviderPage(self.provider, error=error)
        container = data.get("referenceList") or data.get("resultList") or {}
        items = container.get("reference") or container.get("result") or []
        return ProviderPage(
            self.provider,
            records=[self._record(item) for item in items if isinstance(item, dict)],
            next_cursor=data.get("nextCursorMark"),
        )


class ArxivProvider(_HTTPProvider):
    provider = "arxiv"
    base_url = "https://export.arxiv.org/api/query"
    default_min_interval = 3.0

    @staticmethod
    def _child(element: Any, name: str) -> str | None:
        node = element.find(f"{{http://www.w3.org/2005/Atom}}{name}")
        return _text(node.text if node is not None else None)

    def _record(self, entry: Any) -> Any:
        identifier = self._child(entry, "id")
        links = entry.findall("{http://www.w3.org/2005/Atom}link")
        doi = next((link.attrib.get("href") for link in links if link.attrib.get("title") == "doi"), None)
        authors = []
        for node in entry.findall("{http://www.w3.org/2005/Atom}author"):
            name_node = node.find("{http://www.w3.org/2005/Atom}name")
            name = _text(name_node.text if name_node is not None else None)
            if name:
                authors.append(name)
        authors = [author for author in authors if author]
        return _make_record(
            _record_payload(
                provider=self.provider,
                title=self._child(entry, "title"),
                authors=authors,
                published_at=self._child(entry, "published"),
                venue=self._child(entry, "journal_ref"),
                source_type="preprint",
                doi=doi,
                arxiv_id=identifier,
                url=identifier,
                abstract=self._child(entry, "summary"),
            )
        )

    async def _query(self, *, search_query: str | None = None, id_list: str | None = None, start: int = 0, limit: int = 20) -> ProviderPage:
        params = {"max_results": min(max(limit, 1), 2000), "start": max(0, start)}
        if search_query:
            params["search_query"] = f"all:{search_query}"
        if id_list:
            params["id_list"] = id_list
        root, error = await self._xml(self.base_url, params=params)
        if error:
            return ProviderPage(self.provider, error=error)
        entries = root.findall("{http://www.w3.org/2005/Atom}entry")
        total_node = root.find("{http://a9.com/-/spec/opensearch/1.1/}totalResults")
        total = _text(total_node.text if total_node is not None else None)
        next_cursor = str(start + len(entries)) if total and int(total) > start + len(entries) else None
        return ProviderPage(self.provider, records=[self._record(entry) for entry in entries], next_cursor=next_cursor)

    async def search(self, query: str, *, limit: int = 20, cursor: str | None = None) -> ProviderPage:
        try:
            start = int(cursor or 0)
        except ValueError:
            return ProviderPage(self.provider, error=ProviderError(self.provider, "invalid_cursor", "arXiv cursor must be an integer"))
        return await self._query(search_query=query, start=start, limit=limit)

    async def metadata(self, identifier: str) -> ProviderPage:
        arxiv_id, _ = normalize_arxiv_id(identifier)
        if not arxiv_id:
            return ProviderPage(self.provider, error=ProviderError(self.provider, "invalid_identifier", "invalid arXiv identifier"))
        return await self._query(id_list=arxiv_id, limit=1)

    async def citations(self, identifier: str, **_: Any) -> ProviderPage:
        return ProviderPage(
            self.provider,
            error=ProviderError(self.provider, "unsupported", "arXiv API does not provide citation relations"),
        )


class ClinicalTrialsProvider(_HTTPProvider):
    provider = "clinicaltrials_gov"
    base_url = "https://clinicaltrials.gov/api/v2"
    default_min_interval = 0.1

    @staticmethod
    def _date(module: dict[str, Any]) -> str | None:
        for key in ("studyFirstPostDateStruct", "studyFirstSubmitDate", "lastUpdatePostDateStruct"):
            value = module.get(key)
            if isinstance(value, dict):
                value = value.get("date")
            if value:
                return _text(value)
        return None

    def _record(self, study: dict[str, Any]) -> Any:
        protocol = study.get("protocolSection") or study
        ident = protocol.get("identificationModule") or {}
        status = protocol.get("statusModule") or {}
        description = protocol.get("descriptionModule") or {}
        sponsor = ((protocol.get("sponsorCollaboratorsModule") or {}).get("leadSponsor") or {}).get("name")
        nct_id = ident.get("nctId")
        return _make_record(
            _record_payload(
                provider=self.provider,
                title=ident.get("briefTitle") or ident.get("officialTitle"),
                authors=[sponsor] if sponsor else [],
                published_at=self._date(status),
                venue="ClinicalTrials.gov",
                source_type="trial",
                nct_id=nct_id,
                url=f"https://clinicaltrials.gov/study/{normalize_nct(nct_id)}" if normalize_nct(nct_id) else None,
                abstract=description.get("briefSummary") or description.get("detailedDescription"),
            )
        )

    async def search(self, query: str, *, limit: int = 20, cursor: str | None = None) -> ProviderPage:
        params: dict[str, Any] = {"query.term": query, "pageSize": min(max(limit, 1), 100)}
        if cursor:
            params["pageToken"] = cursor
        data, error = await self._json(f"{self.base_url}/studies", params=params)
        if error:
            return ProviderPage(self.provider, error=error)
        return ProviderPage(
            self.provider,
            records=[self._record(item) for item in data.get("studies") or []],
            next_cursor=data.get("nextPageToken"),
        )

    async def metadata(self, identifier: str) -> ProviderPage:
        nct_id = normalize_nct(identifier)
        if not nct_id:
            return ProviderPage(self.provider, error=ProviderError(self.provider, "invalid_identifier", "invalid NCT identifier"))
        data, error = await self._json(f"{self.base_url}/studies/{nct_id}")
        if error:
            return ProviderPage(self.provider, error=error)
        return ProviderPage(self.provider, records=[self._record(data)])

    async def citations(self, identifier: str, **_: Any) -> ProviderPage:
        return ProviderPage(
            self.provider,
            error=ProviderError(self.provider, "unsupported", "ClinicalTrials.gov API does not provide citation relations"),
        )


PROVIDERS: dict[str, type[_HTTPProvider]] = {
    "openalex": OpenAlexProvider,
    "crossref": CrossrefProvider,
    "europe_pmc": EuropePMCProvider,
    "arxiv": ArxivProvider,
    "clinicaltrials_gov": ClinicalTrialsProvider,
}


def _merge_key(record: Any) -> tuple[str, str]:
    source_id = _text(_get(record, "source_id"))
    if source_id:
        return "id", source_id
    return "title", f"{normalize_title(_get(record, 'title'))}|{_year(_get(record, 'published_at')) or ''}"


def _provider_rank(record: Any) -> int:
    provider = _text(_get(record, "provider")) or ""
    source_type = _text(_get(record, "source_type")) or ""
    if source_type == "trial":
        return 0
    return {"crossref": 0, "europe_pmc": 1, "openalex": 2, "arxiv": 3}.get(provider, 4)


def merge_records(records: Iterable[Any]) -> list[Any]:
    """Merge records by canonical identifier, filling only missing fields."""

    grouped: dict[tuple[str, str], list[Any]] = {}
    for record in records:
        grouped.setdefault(_merge_key(record), []).append(record)
    merged: list[Any] = []
    for group in grouped.values():
        group.sort(key=_provider_rank)
        base = group[0]
        providers: list[str] = []
        for record in group:
            for provider in (_get(record, "providers") or [_get(record, "provider")]):
                if provider and provider not in providers:
                    providers.append(provider)
            for field_name in (
                "title",
                "authors",
                "published_at",
                "venue",
                "source_type",
                "doi",
                "pmid",
                "pmcid",
                "arxiv_id",
                "nct_id",
                "url",
                "abstract",
                "retrieved_at",
                "version",
            ):
                current = _get(base, field_name)
                candidate = _get(record, field_name)
                if current in (None, "", [] ) and candidate not in (None, "", []):
                    base = _set(base, field_name, candidate)
        base = _set(base, "providers", providers)
        merged.append(base)
    return merged


__all__ = [
    "ArxivProvider",
    "ClinicalTrialsProvider",
    "CrossrefProvider",
    "EuropePMCProvider",
    "OpenAlexProvider",
    "PROVIDERS",
    "ProviderError",
    "ProviderPage",
    "merge_records",
    "normalize_arxiv_id",
    "normalize_doi",
    "normalize_nct",
    "normalize_pmcid",
    "normalize_pmid",
    "normalize_title",
    "stable_source_id",
]
