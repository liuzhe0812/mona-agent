"""East Money public API thin adapter (design §7.3, §7.4).

Dev-stage data source: four endpoints (quote / kline / fundamentals / news)
adapted into unified domain objects. Every outbound request passes two
layers of validation — the global :func:`validate_url_target` SSRF check
first, then the module's exact HTTPS host whitelist — and re-validates on
every redirect hop. 429/5xx responses get a bounded backoff retry; timeouts
and response bodies are capped.

The fetch plumbing lives in :func:`secure_fetch` / :func:`secure_fetch_json`
so sibling adapters (Tencent quotes/kline, failover composition) share the
same SSRF/whitelist/retry guarantees instead of re-implementing them.

``secid`` market mapping: XSHG → ``1.``, XSHE/BJSE → ``0.`` (East Money
distinguishes SZ and BJ by code range, not market id).
"""

from __future__ import annotations

import asyncio
import html
import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Awaitable, Callable, Literal
from urllib.parse import quote as urlquote
from urllib.parse import urlencode, urljoin, urlparse

import httpx
from pydantic import Field

from mona.config.schema import Base
from mona.security.network import validate_url_target
from mona.services.stock.provenance import (
    CN_TZ,
    SourceRecord,
    normalize_asia_datetime,
    parse_asia_datetime,
)
from mona.services.stock.storage import infer_exchange

ALLOWED_HOSTS = frozenset(
    {
        "push2.eastmoney.com",  # realtime quote
        "push2his.eastmoney.com",  # kline history
        "datacenter.eastmoney.com",  # F10 fundamentals
        "np-anotice-stock.eastmoney.com",  # announcements
        "searchapi.eastmoney.com",  # instrument suggest (code / pinyin / name)
    }
)
GOVERNMENT_ALLOWED_HOSTS = frozenset({"sousuo.www.gov.cn"})

# Public web token East Money's own frontend sends to the suggest endpoint.
SEARCH_TOKEN = "D43BF722C8E33BDDC07FB1B03E993A3C"

MAX_REDIRECTS = 5
DEFAULT_TIMEOUT = 10.0
DEFAULT_MAX_BODY_BYTES = 1_000_000  # 1 MB
DEFAULT_MAX_RETRIES = 2
DEFAULT_BACKOFF_BASE = 0.5
_MARKET_SNAPSHOT_PAGE_SIZE = 100
_MARKET_EVENT_PAGE_SIZE = 100
_MARKET_EVENT_MAX_LIMIT = 5000
_MARKET_EVENT_ANN_TYPE = "SHA,CYB,SZA,BJA"
_MARKET_EVENT_NODES = ("1", "2", "3", "5", "6", "7")
_MARKET_EVENT_TYPES = {
    "1": "periodic_report",
    "2": "financing",
    "3": "risk_warning",
    "5": "major_matter",
    "6": "restructuring",
    "7": "shareholder_change",
}

_SECID_MARKET = {"XSHG": "1", "XSHE": "0", "BJSE": "0"}
_EM_CODE_PREFIX = {"XSHG": "SH", "XSHE": "SZ", "BJSE": "BJ"}
_EM_CODE_SUFFIX = {"XSHG": "SH", "XSHE": "SZ", "BJSE": "BJ"}


class ProviderError(Exception):
    """Upstream fetch failed (network, status, validation)."""


class HostNotAllowedError(ProviderError):
    """URL host is outside the stock module whitelist."""


class ResponseTooLargeError(ProviderError):
    """Response body exceeded the configured cap."""


@dataclass(frozen=True)
class InstrumentRef:
    """An instrument the provider can fetch."""

    exchange: str  # XSHG / XSHE / BJSE
    symbol: str  # 6-digit code
    instrument_type: Literal["equity", "etf", "index"] = "equity"

    @property
    def id(self) -> str:
        return f"{self.exchange}:{self.symbol}"

    @property
    def secid(self) -> str:
        return f"{_SECID_MARKET[self.exchange]}.{self.symbol}"

    @property
    def em_code(self) -> str:
        return f"{_EM_CODE_PREFIX[self.exchange]}{self.symbol}"

    @property
    def secu_code(self) -> str:
        return f"{self.symbol}.{_EM_CODE_SUFFIX[self.exchange]}"


class Quote(Base):
    instrument_id: str
    instrument_type: str
    name: str
    price: float
    change_pct: float
    volume: float
    pe: float | None = None
    pb: float | None = None
    market_cap: float | None = None  # CNY
    as_of: str | None = None
    source: SourceRecord


class KlineBar(Base):
    date: str
    open: float
    close: float
    high: float
    low: float
    volume: float


class KlineSeries(Base):
    instrument_id: str
    instrument_type: str
    bars: list[KlineBar]
    source: SourceRecord


class Fundamentals(Base):
    instrument_id: str
    instrument_type: str
    report_period: str | None
    metrics: dict[str, float | None]
    source: SourceRecord


class NewsItem(Base):
    instrument_id: str
    instrument_type: str
    title: str
    url: str
    published_at: str | None
    summary: str = ""
    source: SourceRecord


class MarketEvent(Base):
    """One security-mapped market announcement."""

    event_id: str
    instrument_id: str
    event_type: str
    title: str
    summary: str = ""
    url: str
    published_at: str | None = None
    event_date: str | None = None
    status: Literal["published", "corrected", "withdrawn", "unknown"] = "unknown"
    category_codes: list[str] = Field(default_factory=list)
    category_names: list[str] = Field(default_factory=list)
    source: SourceRecord


class MarketEventCapture(list):
    """List-compatible event capture with bounded-window metadata."""

    def __init__(
        self,
        rows: list[MarketEvent] | None = None,
        *,
        window_start: str,
        window_end: str,
        expected_count: int | None,
        complete: bool,
        fetched_at: str | None = None,
        provider: str,
        error: str | None = None,
        cache_status: Literal["live", "fresh_cache", "stale_cache"] = "live",
        requested_limit: int | None = None,
        total_hits: int | None = None,
        raw_hit_count: int | None = None,
        mapped_event_count: int | None = None,
        duplicate_count: int = 0,
    ) -> None:
        super().__init__(rows or [])
        self.window_start = window_start
        self.window_end = window_end
        self.raw_hit_count = raw_hit_count if raw_hit_count is not None else total_hits
        self.mapped_event_count = (
            mapped_event_count if mapped_event_count is not None else len(self)
        )
        # expected_count is the number of deduplicated event mappings expected
        # in this capture; raw_hit_count retains the upstream total_hits value.
        self.expected_count = expected_count
        self.loaded_count = len(self)
        self.complete = complete
        self.fetched_at = fetched_at or datetime.now(CN_TZ).isoformat()
        self.provider = provider
        self.error = error
        self.cache_status = cache_status
        self.requested_limit = requested_limit
        self.total_hits = total_hits if total_hits is not None else self.raw_hit_count
        self.duplicate_count = duplicate_count

    @property
    def events(self) -> list[MarketEvent]:
        """Expose the named schema field while retaining list compatibility."""
        return self

    @property
    def coverage(self) -> float | None:
        if self.expected_count in (None, 0):
            return None
        return self.loaded_count / self.expected_count


class ResearchDocument(Base):
    """One dated document returned by the official State Council library."""

    title: str
    url: str
    published_at: str | None
    issuer: str | None = None
    document_id: str | None = None
    category: str
    summary: str = ""
    # Government-library explainers often describe a concrete statistical
    # period (for example, "7月金融数据") even though their publication date
    # is later.  Keep that period separate from ``published_at``; callers may
    # leave it null when the text does not identify one unambiguously.
    period_end: str | None = None
    source_role: Literal["official_authority", "official_portal_summary"] = "official_authority"
    source: SourceRecord


class MarketSnapshotCapture(list):
    """List-compatible snapshot plus deterministic completeness metadata."""

    def __init__(
        self,
        rows: list[Any] | None = None,
        *,
        expected_count: int | None,
        page_size: int,
        complete: bool,
        error: str | None = None,
        requested_limit: int | None = None,
    ) -> None:
        super().__init__(rows or [])
        self.expected_count = expected_count
        self.loaded_count = len(self)
        self.page_size = page_size
        self.complete = complete
        self.error = error
        self.requested_limit = requested_limit
        # EvidenceService may annotate one capture with its durable cache
        # provenance.  Keep this optional so provider callers remain
        # backwards-compatible and the cache metadata never changes rows.
        self.cache_info: dict[str, Any] | None = None

    @property
    def coverage(self) -> float | None:
        if self.expected_count in (None, 0):
            return None
        return self.loaded_count / self.expected_count


class MarketSnapshotIncompleteError(ProviderError):
    """A paged market snapshot stopped before its advertised total."""

    def __init__(
        self,
        message: str,
        *,
        rows: list[Any],
        expected_count: int | None,
        page_size: int,
        requested_limit: int | None = None,
    ) -> None:
        super().__init__(message)
        self.rows = list(rows)
        self.expected_count = expected_count
        self.loaded_count = len(self.rows)
        self.page_size = page_size
        self.requested_limit = requested_limit


class InstrumentSearchResult(Base):
    """One A-share instrument from the suggest endpoint."""

    instrument_id: str
    symbol: str
    exchange: str
    name: str
    instrument_type: Literal["equity", "etf"]
    pinyin: str = ""


def _infer_search_exchange(code: str) -> str | None:
    """Exchange for a suggest-result code, covering ETF prefixes.

    Equity codes go through :func:`infer_exchange` (6→XSHG, 0/3→XSHE,
    8/4→BJSE); ETF codes use their own ranges (51/56/58→XSHG, 15/16→XSHE).
    """
    try:
        return infer_exchange(code)
    except ValueError:
        head = code[0] if code else ""
        if head == "5":
            return "XSHG"
        if head == "1":
            return "XSHE"
        return None


def _optional_float(value: Any) -> float | None:
    if value in (None, "", "--", "-"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _public_time(row: dict[str, Any]) -> str | None:
    """Return a real upstream publication/update time when one exists."""
    candidates = {
        key.upper(): value
        for key, value in row.items()
        if isinstance(key, str)
    }
    for key in (
        "NOTICE_DATE",
        "UPDATE_DATE",
        "PUBLISH_DATE",
        "ANN_DATE",
        "NOTICE_TIME",
        "UPDATE_TIME",
    ):
        normalized = normalize_asia_datetime(candidates.get(key))
        if normalized is not None:
            return normalized
    return None


def _event_datetime(value: Any) -> str | None:
    """Normalize an upstream event timestamp without inventing a time."""
    normalized = normalize_asia_datetime(value)
    if normalized is not None:
        parsed = parse_asia_datetime(normalized)
        return parsed.replace(microsecond=0).isoformat() if parsed is not None else None
    # East Money sometimes sends milliseconds after a second separator, for
    # example ``2026-08-19 21:50:09:687``.  Convert only that explicit
    # precision marker; never fall back to notice_date at midnight.
    raw = str(value or "").strip()
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}):(\d{1,6})", raw)
    if match is None:
        return None
    fraction = match.group(2).ljust(6, "0")[:6]
    normalized = normalize_asia_datetime(f"{match.group(1)}.{fraction}")
    parsed = parse_asia_datetime(normalized)
    return parsed.replace(microsecond=0).isoformat() if parsed is not None else None


def _event_window(
    value: str, *, field: str, end_of_day: bool = False
) -> tuple[str, str]:
    parsed = parse_asia_datetime(value)
    if parsed is None:
        raise ValueError(f"invalid market event {field}: {value!r}")
    if end_of_day and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()):
        parsed = parsed.replace(hour=23, minute=59, second=59, microsecond=999999)
    return parsed.isoformat(), parsed.date().isoformat()


def _event_symbol(raw: Any) -> tuple[str, str] | None:
    """Return ``(instrument_id, six_digit_code)`` for a requested symbol."""
    text = str(raw or "").strip().upper()
    if ":" in text:
        exchange, code = text.split(":", 1)
        exchange = exchange.strip()
        code = code.strip()
        if exchange not in {"XSHG", "XSHE", "BJSE"}:
            return None
    else:
        prefixes = (("SH", "XSHG"), ("SZ", "XSHE"), ("BJ", "BJSE"))
        exchange = ""
        code = text
        for prefix, mapped in prefixes:
            if text.startswith(prefix):
                exchange, code = mapped, text[len(prefix) :]
                break
        if not exchange:
            try:
                exchange = infer_exchange(code)
            except ValueError:
                return None
    if len(code) != 6 or not code.isdigit():
        return None
    return f"{exchange}:{code}", code


def _event_market(exchange_hint: Any, code: str, ann_type: Any = None) -> str | None:
    """Map East Money's market hints to the canonical exchange names."""
    raw_ann = str(ann_type or "").upper()
    if "SHA" in raw_ann:
        return "XSHG"
    if "BJA" in raw_ann:
        return "BJSE"
    if "SZA" in raw_ann or "CYB" in raw_ann:
        return "XSHE"
    raw_market = str(exchange_hint or "").strip().upper()
    if raw_market in {"SH", "SHA", "XSHG", "1"}:
        return "XSHG"
    if raw_market in {"SZ", "SZA", "CYB", "XSHE", "0"}:
        return "XSHE"
    if raw_market in {"BJ", "BJA", "BJSE"}:
        return "BJSE"
    try:
        return infer_exchange(code)
    except ValueError:
        return None


def _event_instruments(entry: dict[str, Any]) -> list[tuple[str, str]]:
    """Read all security mappings from one announcement row."""
    rows = entry.get("codes")
    if not isinstance(rows, list):
        rows = []
    if not rows:
        rows = [entry]
    refs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = str(
            row.get("stock_code")
            or row.get("security_code")
            or row.get("secu_code")
            or row.get("code")
            or ""
        ).strip()
        if "." in code:
            code = code.split(".", 1)[0]
        if len(code) != 6 or not code.isdigit():
            continue
        exchange = _event_market(
            row.get("market_code") or row.get("market"),
            code,
            row.get("ann_type") or entry.get("ann_type"),
        )
        if exchange is None:
            continue
        instrument_id = f"{exchange}:{code}"
        if instrument_id in seen:
            continue
        seen.add(instrument_id)
        refs.append((instrument_id, code))
    return refs


def _event_status(entry: dict[str, Any]) -> Literal["published", "corrected", "withdrawn", "unknown"]:
    raw = str(entry.get("status") or entry.get("event_status") or "").strip().lower()
    if any(token in raw for token in ("withdraw", "撤回", "作废", "取消")):
        return "withdrawn"
    if any(token in raw for token in ("correct", "更正", "修订", "修正")):
        return "corrected"
    if raw or entry.get("display_time") or entry.get("notice_date"):
        return "published"
    return "unknown"


def _event_date(entry: dict[str, Any]) -> str | None:
    """Use an explicit upstream effective/planned date only."""
    for key in (
        "event_date",
        "eventDate",
        "effective_date",
        "effectiveDate",
        "plan_date",
        "planned_date",
    ):
        value = entry.get(key)
        parsed = parse_asia_datetime(value)
        if parsed is not None:
            return parsed.date().isoformat()
    return None


def _event_categories(entry: dict[str, Any]) -> tuple[list[str], list[str]]:
    # ``f_node`` is represented by event_type.  These two fields stay a
    # faithful projection of the upstream column arrays.
    codes: list[str] = []
    names: list[str] = []
    columns = entry.get("columns")
    if isinstance(columns, list):
        for column in columns:
            if not isinstance(column, dict):
                continue
            code = str(column.get("column_code") or "").strip()
            name = str(column.get("column_name") or "").strip()
            if code and code not in codes:
                codes.append(code)
            if name and name not in names:
                names.append(name)
    return codes, names


def _document_period_end(text: str, published_at: str | None) -> str | None:
    """Extract an explicit month covered by a government statistics note.

    This is deliberately narrow: only a month that is stated in the title or
    summary is converted to a month-end date.  Phrases such as "前4个月"
    remain unknown rather than being guessed from publication time.
    """
    if not text or not published_at:
        return None
    year_match = re.search(r"(20\d{2})年", text)
    month_match = re.search(r"(?<!前)(\d{1,2})月(?:末|份|金融|数据)", text)
    if month_match is None:
        return None
    try:
        year = int(year_match.group(1)) if year_match else int(published_at[:4])
        month = int(month_match.group(1))
        if not 1 <= month <= 12:
            return None
        # Month 12 rolls to the following January; using datetime keeps leap
        # years and month lengths correct without a second dependency.
        from calendar import monthrange

        return f"{year:04d}-{month:02d}-{monthrange(year, month)[1]:02d}"
    except (TypeError, ValueError, IndexError):
        return None


# --- shared secure fetch plumbing (SSRF + host whitelist + bounded retry) ---


async def secure_fetch(
    url: str,
    *,
    allowed_hosts: frozenset[str],
    timeout: float = DEFAULT_TIMEOUT,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    max_retries: int = DEFAULT_MAX_RETRIES,
    backoff_base: float = DEFAULT_BACKOFF_BASE,
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], Awaitable[Any]] | None = None,
) -> tuple[bytes, str]:
    """Fetch ``url`` returning (body, final_url); validates every hop."""
    sleep_fn = sleep or asyncio.sleep
    current = url
    async with httpx.AsyncClient(
        timeout=timeout,
        transport=transport,
        follow_redirects=False,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 Chrome/124 Safari/537.36"
            ),
            "Referer": "https://quote.eastmoney.com/center/gridlist.html",
        },
        trust_env=False,
    ) as client:
        for _ in range(MAX_REDIRECTS + 1):
            ok, err = validate_url_target(current)
            if not ok:
                raise ProviderError(f"SSRF check failed for {current}: {err}")
            host = urlparse(current).hostname
            if host not in allowed_hosts:
                raise HostNotAllowedError(f"host {host!r} not in stock whitelist")
            resp = await _request_with_retry(
                client,
                current,
                max_retries=max_retries,
                backoff_base=backoff_base,
                sleep=sleep_fn,
            )
            if resp.is_redirect:
                location = resp.headers.get("location")
                if not location:
                    raise ProviderError(f"redirect from {current} without Location")
                current = urljoin(current, location)
                continue
            if resp.status_code != 200:
                raise ProviderError(f"unexpected status {resp.status_code} for {current}")
            body = resp.content
            if len(body) > max_body_bytes:
                raise ResponseTooLargeError(
                    f"response from {current} is {len(body)} bytes > {max_body_bytes}"
                )
            return body, current
    raise ProviderError(f"too many redirects (>{MAX_REDIRECTS}) from {url}")


async def _request_with_retry(
    client: httpx.AsyncClient,
    url: str,
    *,
    max_retries: int,
    backoff_base: float,
    sleep: Callable[[float], Awaitable[Any]],
) -> httpx.Response:
    for attempt in range(max_retries + 1):
        try:
            resp = await client.get(url)
        except httpx.TransportError as exc:
            if attempt < max_retries:
                await sleep(backoff_base * (2**attempt))
                continue
            label = "timeout" if isinstance(exc, httpx.TimeoutException) else "fetch failed"
            raise ProviderError(f"{label} for {url}: {exc}") from exc
        if resp.status_code == 429 or 500 <= resp.status_code < 600:
            if attempt < max_retries:
                await sleep(backoff_base * (2**attempt))
                continue
            raise ProviderError(
                f"upstream {resp.status_code} after {attempt + 1} attempts for {url}"
            )
        return resp
    raise ProviderError(f"unreachable retry state for {url}")  # pragma: no cover


async def secure_fetch_json(
    url: str,
    *,
    jsonp: bool = False,
    allowed_hosts: frozenset[str],
    timeout: float = DEFAULT_TIMEOUT,
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
    max_retries: int = DEFAULT_MAX_RETRIES,
    backoff_base: float = DEFAULT_BACKOFF_BASE,
    transport: httpx.BaseTransport | None = None,
    sleep: Callable[[float], Awaitable[Any]] | None = None,
) -> tuple[Any, bytes, str]:
    body, final_url = await secure_fetch(
        url,
        allowed_hosts=allowed_hosts,
        timeout=timeout,
        max_body_bytes=max_body_bytes,
        max_retries=max_retries,
        backoff_base=backoff_base,
        transport=transport,
        sleep=sleep,
    )
    payload = body
    if jsonp:
        text = body.decode("utf-8", errors="replace")
        start, end = text.find("("), text.rfind(")")
        if start == -1 or end <= start:
            raise ProviderError(f"malformed JSONP from {final_url}")
        payload = text[start + 1 : end].encode("utf-8")
    try:
        return json.loads(payload), body, final_url
    except json.JSONDecodeError as exc:
        raise ProviderError(f"invalid JSON from {final_url}: {exc}") from exc


class EastMoneyProvider:
    """Thin adapter over East Money public endpoints."""

    name = "eastmoney"

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
        max_retries: int = DEFAULT_MAX_RETRIES,
        backoff_base: float = DEFAULT_BACKOFF_BASE,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], Awaitable[Any]] | None = None,
    ):
        self._timeout = timeout
        self._max_body = max_body_bytes
        self._max_retries = max_retries
        self._backoff_base = backoff_base
        self._transport = transport
        self._sleep = sleep or asyncio.sleep

    # --- fetch plumbing (delegates to the shared secure pipeline) ---

    async def _fetch(self, url: str) -> tuple[bytes, str]:
        return await secure_fetch(
            url,
            allowed_hosts=ALLOWED_HOSTS,
            timeout=self._timeout,
            max_body_bytes=self._max_body,
            max_retries=self._max_retries,
            backoff_base=self._backoff_base,
            transport=self._transport,
            sleep=self._sleep,
        )

    async def _fetch_json(self, url: str, *, jsonp: bool = False) -> tuple[Any, bytes, str]:
        return await secure_fetch_json(
            url,
            jsonp=jsonp,
            allowed_hosts=ALLOWED_HOSTS,
            timeout=self._timeout,
            max_body_bytes=self._max_body,
            max_retries=self._max_retries,
            backoff_base=self._backoff_base,
            transport=self._transport,
            sleep=self._sleep,
        )

    # --- endpoints ---

    async def quote(self, inst: InstrumentRef) -> Quote:
        fields = "f43,f44,f45,f46,f47,f57,f58,f59,f60,f116,f162,f167,f169,f170,f124"
        url = f"https://push2.eastmoney.com/api/qt/stock/get?secid={inst.secid}&fields={fields}"
        payload, body, final_url = await self._fetch_json(url)
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            raise ProviderError(f"invalid quote data from {final_url}")
        price_raw = _optional_float(data.get("f43"))
        change_raw = _optional_float(data.get("f170"))
        volume = _optional_float(data.get("f47"))
        scale_raw = _optional_float(data.get("f59"))
        if None in (price_raw, change_raw, volume, scale_raw):
            raise ProviderError(f"invalid quote values from {final_url}")
        scale = 10 ** int(scale_raw)
        epoch = data.get("f124")
        as_of = (
            datetime.fromtimestamp(int(epoch), tz=CN_TZ).isoformat() if epoch else None
        )
        source = SourceRecord.create(
            provider=self.name,
            url=final_url,
            body=body,
            fields=["price", "change_pct", "volume", "pe", "pb", "market_cap"],
            published_at=as_of,
        )
        return Quote(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            name=data.get("f58") or "",
            price=price_raw / scale,
            change_pct=change_raw / 100,
            volume=volume,
            pe=_optional_float(data.get("f162")),
            pb=_optional_float(data.get("f167")),
            market_cap=_optional_float(data.get("f116")),
            as_of=as_of,
            source=source,
        )

    async def quotes(self, insts: list[InstrumentRef]) -> dict[str, Quote | ProviderError]:
        """Batch snapshot: one entry per requested id; per-item failures are
        isolated as :class:`ProviderError` values instead of failing the lot."""

        async def one(inst: InstrumentRef) -> Quote | ProviderError:
            try:
                return await self.quote(inst)
            except ProviderError as exc:
                return exc

        results = await asyncio.gather(*(one(inst) for inst in insts))
        return dict(zip((inst.id for inst in insts), results))

    async def market_snapshot(self, *, limit: int = 5000):
        """Fetch a lightweight A-share universe snapshot.

        The East Money endpoint sorts by ``fid=f3`` (change percentage), so a
        single large request is a *ranking slice*, not a full market capture
        when it disconnects or truncates.  Read its advertised ``total`` and
        fetch bounded pages; callers only receive a complete capture as
        ``complete=True``.  An incomplete page sequence raises an exception
        carrying the partial rows so the evidence layer can expose coverage
        instead of treating a top-gainers slice as market breadth.
        """
        from mona.services.stock.screening import MarketSnapshot

        limit = max(1, min(int(limit), 50000))
        page_size = min(_MARKET_SNAPSHOT_PAGE_SIZE, limit)
        fields = "f2,f3,f5,f6,f8,f9,f12,f13,f14,f20,f23,f100,f124"
        base_url = (
            "https://push2.eastmoney.com/api/qt/clist/get"
            "?po=1&np=1&fltt=2&invt=2&fid=f3"
            "&ut=bd1d9ddb04089700cf9c27f6f7426281"
            "&fs=m:0+t:6,m:0+t:80,m:0+t:81+s:2048,m:1+t:2,m:1+t:23"
            f"&fields={fields}"
        )
        out: list[Any] = []
        seen_ids: set[str] = set()
        expected_count: int | None = None
        target_count: int | None = None
        page = 1

        while target_count is None or len(out) < target_count:
            url = f"{base_url}&pn={page}&pz={page_size}"
            try:
                payload, body, final_url = await self._fetch_json(url)
            except ProviderError as exc:
                raise MarketSnapshotIncompleteError(
                    f"market snapshot page {page} failed: {exc}",
                    rows=out,
                    expected_count=expected_count,
                    page_size=page_size,
                    requested_limit=limit,
                ) from exc
            data = payload.get("data") if isinstance(payload, dict) else None
            if not isinstance(data, dict):
                raise MarketSnapshotIncompleteError(
                    f"invalid market snapshot page {page}",
                    rows=out,
                    expected_count=expected_count,
                    page_size=page_size,
                    requested_limit=limit,
                )
            if expected_count is None:
                raw_total = data.get("total") or data.get("totalCount")
                try:
                    total = int(raw_total)
                except (TypeError, ValueError):
                    total = 0
                expected_count = total if total > 0 else None
                if expected_count is None:
                    raise MarketSnapshotIncompleteError(
                        f"market snapshot page {page} has no valid total",
                        rows=out,
                        expected_count=None,
                        page_size=page_size,
                        requested_limit=limit,
                    )
                target_count = min(expected_count, limit)

            diff = data.get("diff")
            if isinstance(diff, dict):
                entries = list(diff.values())
            elif isinstance(diff, list):
                entries = diff
            else:
                entries = []
            if not entries:
                raise MarketSnapshotIncompleteError(
                    f"market snapshot page {page} is empty before advertised total",
                    rows=out,
                    expected_count=expected_count,
                    page_size=page_size,
                    requested_limit=limit,
                )

            observed_at = None
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                raw_epoch = entry.get("f124")
                try:
                    if raw_epoch not in (None, ""):
                        observed_at = datetime.fromtimestamp(
                            int(raw_epoch), tz=CN_TZ
                        ).isoformat()
                        break
                except (TypeError, ValueError, OSError, OverflowError):
                    continue
            source = SourceRecord.create(
                provider=self.name,
                url=final_url,
                body=body,
                fields=[
                    "price", "change_pct", "volume", "turnover", "amount",
                    "turnover_rate", "market_cap", "pe", "pb", "industry",
                    "observed_at", "page", "page_size", "expected_count",
                ],
                published_at=observed_at,
            )
            before = len(out)
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                code = str(entry.get("f12") or "")
                if len(code) != 6 or not code.isdigit():
                    continue
                try:
                    exchange = infer_exchange(code)
                except ValueError:
                    continue
                instrument_id = f"{exchange}:{code}"
                if instrument_id in seen_ids:
                    continue
                seen_ids.add(instrument_id)
                price = _optional_float(entry.get("f2"))
                change_pct = _optional_float(entry.get("f3"))
                name = str(entry.get("f14") or "")
                out.append(
                    MarketSnapshot(
                        instrument_id=instrument_id,
                        symbol=code,
                        exchange=exchange,
                        name=name,
                        industry=(str(entry.get("f100")) if entry.get("f100") else None),
                        price=price,
                        change_pct=change_pct,
                        volume=_optional_float(entry.get("f5")),
                        turnover=_optional_float(entry.get("f6")),
                        amount=_optional_float(entry.get("f6")),
                        turnover_rate=_optional_float(entry.get("f8")),
                        market_cap=_optional_float(entry.get("f20")),
                        pe=_optional_float(entry.get("f9")),
                        pb=_optional_float(entry.get("f23")),
                        is_st="ST" in name.upper(),
                        is_suspended=price is None,
                        as_of=observed_at,
                        observed_at=observed_at,
                        source_ids=[source.id],
                        source=source,
                    )
                )
            if len(out) == before:
                raise MarketSnapshotIncompleteError(
                    f"market snapshot page {page} has no new valid rows",
                    rows=out,
                    expected_count=expected_count,
                    page_size=page_size,
                    requested_limit=limit,
                )
            page += 1

        if not out:
            raise ProviderError("market snapshot has no valid A-share rows")
        complete = (
            expected_count is not None
            and target_count is not None
            and target_count >= expected_count
            and len(out) >= expected_count
        )
        return MarketSnapshotCapture(
            out,
            expected_count=expected_count,
            page_size=page_size,
            complete=complete,
            error=(
                None
                if complete
                else "requested_limit_below_advertised_total"
            ),
            requested_limit=limit,
        )

    async def kline(self, inst: InstrumentRef, *, limit: int = 120, klt: int = 101) -> KlineSeries:
        if klt not in (101, 102, 103):
            raise ProviderError(f"unsupported klt {klt!r} (expect 101/102/103)")
        url = (
            "https://push2his.eastmoney.com/api/qt/stock/kline/get"
            f"?secid={inst.secid}&klt={klt}&fqt=1&beg=0&end=20500101&lmt={limit}"
            "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56"
        )
        payload, body, final_url = await self._fetch_json(url)
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict):
            raise ProviderError(f"invalid kline data from {final_url}")
        bars = []
        for row in data.get("klines") or []:
            if not isinstance(row, str):
                continue
            parts = row.split(",")
            if len(parts) < 6:
                continue
            try:
                bars.append(
                    KlineBar(
                        date=parts[0],
                        open=float(parts[1]),
                        close=float(parts[2]),
                        high=float(parts[3]),
                        low=float(parts[4]),
                        volume=float(parts[5]),
                    )
                )
            except (TypeError, ValueError):
                continue
        if not bars:
            raise ProviderError(f"no valid kline data from {final_url}")
        # Upstream ignores ``lmt`` when beg=0 (returns full history); honor
        # the limit contract here by keeping the most recent bars.
        if limit > 0 and len(bars) > limit:
            bars = bars[-limit:]
        source = SourceRecord.create(
            provider=self.name,
            url=final_url,
            body=body,
            fields=["date", "open", "close", "high", "low", "volume"],
            published_at=bars[-1].date if bars else None,
        )
        return KlineSeries(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            bars=bars,
            source=source,
        )

    async def intraday(self, inst: InstrumentRef):
        """Fetch the complete current-day ``trends2`` minute snapshot.

        The import stays local because the intraday contract imports the
        provider's shared ``InstrumentRef``/``ProviderError`` types.
        """
        from mona.services.stock.intraday import parse_eastmoney_trends

        url = (
            "https://push2his.eastmoney.com/api/qt/stock/trends2/get"
            f"?fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13"
            "&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0"
            f"&secid={inst.secid}"
        )
        payload, body, final_url = await self._fetch_json(url)
        return parse_eastmoney_trends(
            payload,
            instrument=inst,
            body=body,
            url=final_url,
        )

    async def fundamentals_history(
        self, inst: InstrumentRef, *, limit: int = 12
    ) -> list[Fundamentals]:
        limit = max(1, min(int(limit), 40))
        filter_value = urlquote('(SECUCODE="' + inst.secu_code + '")')
        url = (
            "https://datacenter.eastmoney.com/securities/api/data/get"
            "?type=RPT_F10_FINANCE_MAINFINADATA&sty=ALL"
            f"&filter={filter_value}"
            f"&p=1&ps={limit}&sr=-1&st=REPORT_DATE"
        )
        payload, body, final_url = await self._fetch_json(url)
        result = payload.get("result") if isinstance(payload, dict) else None
        rows = result.get("data") if isinstance(result, dict) else None
        if not isinstance(rows, list) or not rows:
            raise ProviderError(f"no fundamentals data from {final_url}")
        out: list[Fundamentals] = []
        seen: set[str] = set()
        for row in rows:
            if not isinstance(row, dict):
                continue
            report_period = str(row.get("REPORT_DATE") or "")[:10] or None
            if not report_period or report_period in seen:
                continue
            seen.add(report_period)
            metrics = {
                "eps": _optional_float(row.get("EPSJB")),
                "roe": _optional_float(row.get("ROEJQ")),
                "gross_margin": _optional_float(row.get("XSMLL")),
                "net_margin": _optional_float(row.get("XSJLL")),
                "revenue": _optional_float(row.get("TOTALOPERATEREVE")),
                "revenue_yoy": _optional_float(row.get("TOTALOPERATEREVETZ")),
                "net_profit": _optional_float(row.get("PARENTNETPROFIT")),
                "profit_yoy": _optional_float(row.get("PARENTNETPROFITTZ")),
                "operating_cashflow": _optional_float(row.get("NETCASH_OPERATE_PK")),
                "debt_ratio": _optional_float(row.get("ZCFZL")),
                "roic": _optional_float(row.get("ROIC")),
            }
            published_at = _public_time(row)
            # One response contains many reporting periods.  Hash the
            # stable raw row, rather than the whole response, so each period
            # retains an independently auditable source record.
            row_body = json.dumps(
                row, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
            source = SourceRecord.create(
                provider=self.name,
                url=final_url,
                body=row_body,
                fields=[*list(metrics), "report_period", "published_at"],
                published_at=published_at,
                period_end=report_period,
            )
            out.append(
                Fundamentals(
                    instrument_id=inst.id,
                    instrument_type=inst.instrument_type,
                    report_period=report_period,
                    metrics=metrics,
                    source=source,
                )
            )
        if not out:
            raise ProviderError(f"no fundamentals data from {final_url}")
        return out

    async def fundamentals(self, inst: InstrumentRef) -> Fundamentals:
        return (await self.fundamentals_history(inst, limit=1))[0]

    async def news(self, inst: InstrumentRef, *, limit: int = 10) -> list[NewsItem]:
        url = (
            "https://np-anotice-stock.eastmoney.com/api/security/ann"
            f"?sr=-1&page_size={limit}&page_index=1&ann_type=A"
            f"&client_source=web&stock_list={inst.symbol}"
        )
        payload, body, final_url = await self._fetch_json(url)
        data = payload.get("data") if isinstance(payload, dict) else None
        entries = data.get("list") if isinstance(data, dict) else None
        if not isinstance(entries, list):
            raise ProviderError(f"invalid announcement data from {final_url}")
        items: list[NewsItem] = []
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            art_code = str(entry.get("art_code") or "")
            title = str(entry.get("title_ch") or entry.get("title") or "")
            if not art_code or not title:
                continue
            published_at = entry.get("notice_date") or entry.get("display_time")
            columns = entry.get("columns") or []
            summary = " / ".join(
                str(column.get("column_name"))
                for column in columns
                if isinstance(column, dict) and column.get("column_name")
            )
            # Keep announcement provenance one-to-one with the returned
            # entry.  Hashing the complete list response would make every
            # notice share one source id and lose per-notice dates.
            row_body = json.dumps(
                entry, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ).encode("utf-8")
            source = SourceRecord.create(
                provider=self.name,
                url=final_url,
                body=row_body,
                fields=["title", "url", "published_at", "summary"],
                published_at=published_at,
            )
            items.append(
                NewsItem(
                    instrument_id=inst.id,
                    instrument_type=inst.instrument_type,
                    title=title,
                    url=(
                        "https://data.eastmoney.com/notices/detail/"
                        f"{inst.symbol}/{art_code}.html"
                    ),
                    published_at=published_at,
                    summary=summary,
                    source=source,
                )
            )
        return items[:limit]

    async def market_events(
        self,
        *,
        since: str,
        until: str,
        symbols: list[str] | None = None,
        limit: int = _MARKET_EVENT_MAX_LIMIT,
    ) -> MarketEventCapture:
        """Capture market announcements in a bounded time window.

        The endpoint is queried once per supported announcement category.  A
        full-market query deliberately omits ``stock_list``; when symbols are
        supplied the six-digit codes are passed through and returned rows are
        still filtered by canonical instrument id.
        """
        window_start, since_date = _event_window(since, field="since")
        window_end, until_date = _event_window(until, field="until", end_of_day=True)
        window_start_dt = parse_asia_datetime(window_start)
        window_end_dt = parse_asia_datetime(window_end)
        if window_start_dt is None or window_end_dt is None:
            raise ValueError("invalid market event time window")
        if window_end_dt < window_start_dt:
            raise ValueError("market event until must not precede since")
        limit = max(1, min(int(limit), _MARKET_EVENT_MAX_LIMIT))

        requested_ids: set[str] | None = None
        requested_codes: list[str] = []
        if symbols is not None:
            requested_ids = set()
            for raw in symbols:
                parsed = _event_symbol(raw)
                if parsed is None:
                    continue
                instrument_id, code = parsed
                requested_ids.add(instrument_id)
                if code not in requested_codes:
                    requested_codes.append(code)
            if not requested_codes:
                return MarketEventCapture(
                    [],
                    window_start=window_start,
                    window_end=window_end,
                    expected_count=0,
                    complete=True,
                    provider=self.name,
                    requested_limit=limit,
                    total_hits=0,
                )

        events_by_id: dict[str, MarketEvent] = {}
        duplicate_count = 0
        total_hits = 0
        pagination_complete = True
        pagination_error: str | None = None

        for node in _MARKET_EVENT_NODES:
            page = 1
            node_total: int | None = None
            node_loaded = 0
            while True:
                query: list[tuple[str, str]] = [
                    ("sr", "-1"),
                    ("page_size", str(_MARKET_EVENT_PAGE_SIZE)),
                    ("page_index", str(page)),
                    ("ann_type", _MARKET_EVENT_ANN_TYPE),
                    ("client_source", "web"),
                    ("f_node", node),
                    ("s_node", "0"),
                    ("begin_time", since_date),
                    ("end_time", until_date),
                ]
                if requested_codes:
                    query.append(("stock_list", ",".join(requested_codes)))
                url = (
                    "https://np-anotice-stock.eastmoney.com/api/security/ann?"
                    + urlencode(query)
                )
                try:
                    payload, _body, final_url = await self._fetch_json(url)
                except ProviderError as exc:
                    raise ProviderError(
                        f"market events node {node} page {page} failed: {exc}"
                    ) from exc
                data = payload.get("data") if isinstance(payload, dict) else None
                entries = data.get("list") if isinstance(data, dict) else None
                if not isinstance(data, dict) or not isinstance(entries, list):
                    raise ProviderError(
                        f"invalid market event data from {final_url}"
                    )
                node_loaded += len(entries)

                if node_total is None:
                    raw_total = data.get("total_hits")
                    if raw_total is None:
                        raw_total = data.get("total") or data.get("totalCount")
                    try:
                        node_total = max(0, int(raw_total))
                    except (TypeError, ValueError):
                        node_total = None
                    if node_total is not None:
                        total_hits += node_total

                if not entries:
                    if node_total is not None and node_loaded < node_total:
                        pagination_complete = False
                        pagination_error = (
                            f"event node {node} ended before total_hits={node_total}"
                        )
                    break

                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    art_code = str(entry.get("art_code") or "").strip()
                    title = str(entry.get("title_ch") or entry.get("title") or "").strip()
                    if not art_code or not title:
                        continue
                    refs = _event_instruments(entry)
                    if requested_ids is not None:
                        refs = [ref for ref in refs if ref[0] in requested_ids]
                    if not refs:
                        continue

                    # display_time is the public availability time.  Do not
                    # substitute notice_date 00:00, which is often a date
                    # label rather than the actual publication timestamp.
                    published_at = _event_datetime(
                        entry.get("display_time")
                        or entry.get("displayTime")
                        or entry.get("eiTime")
                    )
                    if published_at is None:
                        continue
                    published_dt = parse_asia_datetime(published_at)
                    if published_dt is None:
                        continue
                    if published_dt < window_start_dt or published_dt > window_end_dt:
                        continue
                    category_codes, category_names = _event_categories(entry)
                    # summary is sourced from the upstream column names.
                    summary = " / ".join(
                        str(column.get("column_name")).strip()
                        for column in (entry.get("columns") or [])
                        if isinstance(column, dict) and column.get("column_name")
                    )
                    status = _event_status(entry)
                    event_date = _event_date(entry)
                    event_type = _MARKET_EVENT_TYPES.get(node, "market_event")
                    # Full-market and single-security queries can return the
                    # same notice with different millisecond timestamps. Hash
                    # the canonical upstream fields so one notice keeps one
                    # source id across screening and Evidence reads.
                    row_body = json.dumps(
                        {
                            "art_code": art_code,
                            "title": title,
                            "summary": summary,
                            "published_at": published_at,
                            "event_date": event_date,
                            "status": status,
                            "event_type": event_type,
                            "category_codes": category_codes,
                            "category_names": category_names,
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    ).encode("utf-8")
                    for instrument_id, code in refs:
                        event_id = f"{art_code}:{instrument_id}"
                        if event_id in events_by_id:
                            duplicate_count += 1
                            continue
                        event_url = (
                            "https://data.eastmoney.com/notices/detail/"
                            f"{code}/{art_code}.html"
                        )
                        source = SourceRecord.create(
                            provider=self.name,
                            url=event_url,
                            body=row_body,
                            fields=[
                                "event_id",
                                "instrument_id",
                                "event_type",
                                "title",
                                "summary",
                                "url",
                                "published_at",
                                "event_date",
                                "status",
                                "category_codes",
                                "category_names",
                            ],
                            published_at=published_at,
                        )
                        events_by_id[event_id] = MarketEvent(
                            event_id=event_id,
                            instrument_id=instrument_id,
                            event_type=event_type,
                            title=title,
                            summary=summary,
                            url=event_url,
                            published_at=published_at,
                            event_date=event_date,
                            status=status,
                            category_codes=category_codes,
                            category_names=category_names,
                            source=source,
                        )

                if node_total is not None:
                    if page * _MARKET_EVENT_PAGE_SIZE >= node_total:
                        if node_loaded < node_total:
                            pagination_complete = False
                            pagination_error = (
                                f"event node {node} loaded {node_loaded} "
                                f"of total_hits={node_total}"
                            )
                        break
                elif len(entries) < _MARKET_EVENT_PAGE_SIZE:
                    break
                page += 1

        events = sorted(
            events_by_id.values(),
            key=lambda event: (
                event.published_at is not None,
                event.published_at or "",
                event.event_id,
            ),
            reverse=True,
        )
        truncated = len(events) > limit
        if truncated:
            events = events[:limit]
        error = pagination_error
        if truncated:
            truncation_error = "market event result truncated by requested limit"
            error = f"{error}; {truncation_error}" if error else truncation_error
        raw_count = total_hits
        return MarketEventCapture(
            events,
            window_start=window_start,
            window_end=window_end,
            expected_count=len(events_by_id),
            complete=pagination_complete and not truncated,
            provider=self.name,
            error=error,
            requested_limit=limit,
            total_hits=raw_count,
            raw_hit_count=raw_count,
            mapped_event_count=len(events_by_id),
            duplicate_count=duplicate_count,
        )

    async def search(self, keyword: str, *, limit: int = 10) -> list[InstrumentSearchResult]:
        """A-share instrument suggest by code, pinyin or name."""
        keyword = keyword.strip()
        if not keyword:
            return []
        url = (
            "https://searchapi.eastmoney.com/api/suggest/get"
            f"?input={urlquote(keyword)}&type=14&token={SEARCH_TOKEN}&count={limit}"
        )
        payload, _body, _final_url = await self._fetch_json(url)
        table = (payload or {}).get("QuotationCodeTable") or {}
        results: list[InstrumentSearchResult] = []
        for entry in table.get("Data") or []:
            code = str(entry.get("Code") or "")
            if len(code) != 6 or not code.isdigit():
                continue
            classify = str(entry.get("Classify") or "")
            type_name = str(entry.get("SecurityTypeName") or "")
            if classify == "AStock" or "A股" in type_name:
                instrument_type = "equity"
            elif classify == "Fund" or "ETF" in type_name:
                instrument_type = "etf"
            else:
                continue
            exchange = _infer_search_exchange(code)
            if exchange is None:
                continue
            results.append(
                InstrumentSearchResult(
                    instrument_id=f"{exchange}:{code}",
                    symbol=code,
                    exchange=exchange,
                    name=str(entry.get("Name") or ""),
                    instrument_type=instrument_type,  # type: ignore[arg-type]
                    pinyin=str(entry.get("PinYin") or ""),
                )
            )
            if len(results) >= limit:
                break
        return results


class GovernmentResearchProvider:
    """Official policy-library search; no API key and no inferred facts."""

    name = "gov.cn-policy-library"

    def __init__(
        self,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_body_bytes: int = DEFAULT_MAX_BODY_BYTES,
        transport: httpx.BaseTransport | None = None,
    ):
        self._timeout = timeout
        self._max_body = max_body_bytes
        self._transport = transport

    async def search_policy_documents(self, *, limit: int = 5) -> list[ResearchDocument]:
        """Search formal macro/regulatory policy documents independently.

        This deliberately does not use the M2/statistics search.  The
        government library's formal-document categories are retained, while
        duplicate documents returned for the two policy scopes are removed by
        their row-derived source id.
        """
        limit = max(1, min(int(limit), 20))
        documents: list[ResearchDocument] = []
        seen: set[str] = set()
        last_error: Exception | None = None
        for keyword in ("货币政策", "资本市场监管"):
            try:
                found = await self.search_documents(
                    keyword, limit=limit, include_explainers=False
                )
            except Exception as exc:
                last_error = exc
                continue
            for item in found:
                if item.source.id in seen:
                    continue
                seen.add(item.source.id)
                documents.append(item)
                if len(documents) >= limit:
                    return documents
        if not documents and last_error is not None:
            raise last_error
        return documents

    async def search_documents(
        self,
        keyword: str,
        *,
        limit: int = 5,
        include_explainers: bool = False,
    ) -> list[ResearchDocument]:
        keyword = keyword.strip()
        if not keyword:
            return []
        limit = max(1, min(int(limit), 20))
        query = urlencode(
            {
                "t": "zhengcelibrary",
                "q": keyword,
                "timetype": "timeyn",
                "sort": "pubtime",
                "sortType": 1,
                "searchfield": "all",
                "p": 1,
                "n": limit,
                "type": "gwyzcwjk",
            }
        )
        url = f"https://sousuo.www.gov.cn/search-gov/data?{query}"
        payload, _body, _final_url = await secure_fetch_json(
            url,
            allowed_hosts=GOVERNMENT_ALLOWED_HOSTS,
            timeout=self._timeout,
            max_body_bytes=self._max_body,
            transport=self._transport,
        )
        search = payload.get("searchVO") if isinstance(payload, dict) else None
        categories = search.get("catMap") if isinstance(search, dict) else None
        if not isinstance(categories, dict):
            return []
        allowed = ("gongwen", "bumenfile", "otherfile") if include_explainers else ("gongwen", "bumenfile")
        out: list[ResearchDocument] = []
        for category in allowed:
            group = categories.get(category)
            rows = group.get("listVO") if isinstance(group, dict) else None
            for row in rows or []:
                if not isinstance(row, dict):
                    continue
                title = html.unescape(re.sub(r"<[^>]+>", "", str(row.get("title") or ""))).strip()
                document_url = str(row.get("url") or "").strip()
                summary = html.unescape(
                    re.sub(r"<[^>]+>", "", str(row.get("summary") or ""))
                ).strip()
                if not title or not document_url or keyword.lower() not in f"{title} {summary}".lower():
                    continue
                published_at = str(row.get("pubtimeStr") or "").replace(".", "-") or None
                period_end = _document_period_end(
                    f"{title} {summary}", published_at
                )
                row_body = json.dumps(row, ensure_ascii=False, sort_keys=True).encode("utf-8")
                source = SourceRecord.create(
                    provider=self.name,
                    url=document_url,
                    body=row_body,
                    fields=[
                        "title", "url", "published_at", "issuer", "document_id",
                        "summary", "period_end",
                    ],
                    published_at=published_at,
                    period_end=period_end,
                )
                out.append(
                    ResearchDocument(
                        title=title,
                        url=document_url,
                        published_at=published_at,
                        issuer=str(row.get("puborg") or "").strip() or None,
                        document_id=str(row.get("pcode") or "").strip() or None,
                        category=category,
                        summary=summary,
                        period_end=period_end,
                        source_role=(
                            "official_authority"
                            if category in {"gongwen", "bumenfile"}
                            else "official_portal_summary"
                        ),
                        source=source,
                    )
                )
                if len(out) >= limit:
                    return out
        return out

