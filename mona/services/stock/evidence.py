"""EvidenceBundle service (design §5.2, §7.4, §9).

One trimmed, immutable evidence bundle per ``(workflow_run_id, symbol)``,
stored at ``<workspace>/stock_projects/<run_id>/evidence.json`` with a
``symbols`` map. Agents read this bundle — they never fetch data directly.
The raw full kline goes to the TTL'd cache (``~/.mona/stock/cache/``) and is
referenced by hash + adjustment method; every value the report cites must
live inside ``evidence.json`` itself because the cache can expire.

- Idempotent: a second build for the same key reads from disk, no refetch.
- ``research_cutoff_at`` default: actual runtime in Asia/Shanghai.  The legacy
  ``as_of`` field remains the most recent trading close (15:00), derived from
  SH index daily bars. Calendar failure raises
  :class:`TradingCalendarUnavailable` — callers record a skip; we never
  degrade to weekday guessing.
- Trimming: news capped + summaries truncated, indicators reduced to the
  latest values, source records kept complete.
- Atomic writes (temp file + flush + ``os.replace``) guarded by a
  process-local asyncio lock; preflight promotion additionally uses a
  per-context cross-process file lock.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
import re
import statistics
from datetime import datetime, time, timedelta
from pathlib import Path
from typing import Any, Callable

from filelock import FileLock
from filelock import Timeout as FileLockTimeout
from loguru import logger

from mona.services.stock.fundamental_factors import build_fundamental_factors
from mona.services.stock.indicators import (
    macd,
    rsi,
    sma,
    swing_high_low,
    volume_change_pct,
)
from mona.services.stock.market_intelligence import (
    build_market_sentiment,
    build_public_opinion_state,
    load_local_public_opinion_snapshot,
)
from mona.services.stock.material_evidence import MaterialBindingStore
from mona.services.stock.outcomes import (
    PUBLIC_MARKET_BENCHMARK,
    build_v6_derived_decision_metrics,
)
from mona.services.stock.provenance import (
    CN_TZ,
    SourceRecord,
    compare_asia_datetime,
    normalize_asia_datetime,
    parse_asia_datetime,
)
from mona.services.stock.provider import (
    Fundamentals,
    InstrumentRef,
    MarketSnapshotCapture,
    MarketSnapshotIncompleteError,
)
from mona.services.stock.valuation import (
    build_valuation_result,
    is_policy_sensitive_industry,
)
from mona.services.stock.westock_provider import WESTOCK_COMMANDS

SCHEMA_VERSION = 2
DEFAULT_BATCH_CAPACITY = 20
DEFAULT_NEWS_LIMIT = 5
DEFAULT_NEWS_SUMMARY_CHARS = 200
DEFAULT_KLINE_BARS = 120
CONTEXT_PROMOTE_LOCK_TIMEOUT_SECONDS = 5.0
SWING_WINDOW = 20
CASH_MARKET_OPEN_TIME = time(9, 30)
CLOSE_TIME = time(15, 0)  # A-share close, Asia/Shanghai
_CONTEXT_ID_RE = re.compile(r"^ctx_[a-z0-9]{12,64}$")
_EVENT_DATE_PATTERNS = (
    re.compile(r"(20\d{2})年(\d{1,2})月(\d{1,2})日"),
    re.compile(r"(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})"),
)
_MACRO_INDICATOR_PATTERNS = (
    (
        "social_financing_yoy",
        re.compile(
            r"社会融资规模(?:存量)?[^%]{0,30}?(?:同比)?(?:增长|增速为|为)\s*([+-]?\d+(?:\.\d+)?)%"
        ),
    ),
    (
        "m2_yoy",
        re.compile(
            r"(?:M2|广义货币)[^%]{0,30}?(?:同比)?(?:增长|增速为|为)\s*([+-]?\d+(?:\.\d+)?)%",
            re.IGNORECASE,
        ),
    ),
)
_MACRO_POLICY_TITLE_SIGNALS = (
    "货币政策",
    "存款准备金",
    "公开市场操作",
    "逆回购",
    "中期借贷便利",
    "再贷款",
    "再贴现",
    "宏观审慎",
    "金融稳定",
    "社会融资",
    "广义货币",
    "M2",
    "降准",
    "降息",
    "利率",
    "流动性",
    "资本市场",
    "证券市场",
    "股票市场",
    "债券市场",
    "上市公司",
    "证券监管",
    "金融监管",
    "注册制",
    "发行上市",
    "退市",
    "投资者保护",
    "交易所",
    "证券发行",
    "基金监管",
    "期货监管",
    "金融支持",
    "信贷政策",
    "外汇管理",
    "跨境融资",
    "金融机构监管",
    "银行业监管",
    "保险业监管",
)
_MACRO_POLICY_PROCEDURAL_TITLE_SIGNALS = (
    "行政法规制定",
    "法规制定程序",
    "立法程序",
    "条例制定程序",
    "规章制定",
)
_EVENT_TYPES = (
    ("share_unlock", ("解禁", "限售股上市流通")),
    ("share_reduction", ("减持",)),
    ("share_pledge", ("质押",)),
    ("guarantee", ("担保", "对外担保")),
    ("capital_change", ("募集资金", "注册资本", "增资", "股份变动")),
    ("earnings_forecast", ("业绩预告", "业绩快报")),
    ("periodic_report", ("年度报告", "半年度报告", "季度报告", "季报")),
    ("shareholder_meeting", ("股东大会",)),
    ("dividend", ("分红", "权益分派", "利润分配")),
    ("restructuring", ("重组", "重大资产", "收购", "并购")),
    ("regulatory", ("问询", "监管", "处罚", "立案")),
    ("suspension", ("停牌", "复牌")),
    ("major_contract", ("重大合同", "中标")),
)
_STRUCTURED_EVENT_WINDOW_DAYS = 7

V2_SECTIONS = (
    "market_regime",
    "market_sentiment",
    "public_opinion",
    "industry_context",
    "policy_context",
    "cycle_context",
    "company_quality",
    "capital_positioning",
    "event_calendar",
    "tradeability",
)

SH_INDEX = InstrumentRef(exchange="XSHG", symbol="000001", instrument_type="index")
PUBLIC_BENCHMARK = InstrumentRef(
    exchange="XSHG", symbol="000985", instrument_type="index"
)
BENCHMARK_WINDOWS = (5, 20, 60, 120)
BENCHMARK_KLINE_LIMIT = 130
MARKET_SNAPSHOT_CACHE_VERSION = "market-snapshot-v1"
DECISION_READINESS_VERSION = "decision-readiness-v5-b2"
DERIVED_DECISION_METRICS_VERSION = "decision-derived-v5-b2"
MIN_DECISION_KLINE_BARS = 60


def _finite_number(value: Any) -> float | None:
    number = numeric_value(value)
    return number if number is not None and math.isfinite(number) else None


def _bar_observed_at(bar: Any) -> datetime | None:
    raw = getattr(bar, "date", None)
    parsed = parse_asia_datetime(raw)
    if parsed is not None and len(str(raw).strip()) <= 10:
        parsed = parsed.replace(
            hour=CLOSE_TIME.hour,
            minute=CLOSE_TIME.minute,
            second=0,
            microsecond=0,
        )
    return parsed


def _true_range_values(bars: list[Any]) -> list[float] | None:
    values: list[float] = []
    previous_close: float | None = None
    for bar in bars:
        high = _finite_number(getattr(bar, "high", None))
        low = _finite_number(getattr(bar, "low", None))
        close = _finite_number(getattr(bar, "close", None))
        if high is None or low is None or close is None or high < low:
            return None
        if previous_close is None:
            values.append(high - low)
        else:
            values.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
        previous_close = close
    return values


def _derived_decision_metrics(
    bars: list[Any],
    quote: Any,
    *,
    source_ids: list[str],
    research_cutoff: str,
) -> dict[str, Any] | None:
    """Build immutable, deterministic inputs for the V5 price plan.

    This function consumes the already-fetched bundle inputs only.  It never
    infers values from news or substitutes a missing technical field.
    """
    if len(bars) < MIN_DECISION_KLINE_BARS:
        return None
    closes = [_finite_number(getattr(bar, "close", None)) for bar in bars]
    highs = [_finite_number(getattr(bar, "high", None)) for bar in bars]
    lows = [_finite_number(getattr(bar, "low", None)) for bar in bars]
    volumes = [_finite_number(getattr(bar, "volume", None)) for bar in bars]
    price = _finite_number(getattr(quote, "price", None))
    if (
        price is None
        or price <= 0
        or any(value is None or value <= 0 for value in closes)
        or any(value is None or value < 0 for value in volumes)
        or any(value is None for value in highs)
        or any(value is None for value in lows)
    ):
        return None
    close_values = [float(value) for value in closes]
    high_values = [float(value) for value in highs]
    low_values = [float(value) for value in lows]
    true_ranges = _true_range_values(bars)
    if true_ranges is None or len(true_ranges) < MIN_DECISION_KLINE_BARS:
        return None
    atr20 = sum(true_ranges[-20:]) / 20
    ma20_series = sma(close_values, 20)
    ma60_series = sma(close_values, 60)
    ma20 = ma20_series[-1]
    ma60 = ma60_series[-1]
    previous_ma20 = sma(close_values[:-1], 20)[-1]
    if ma20 is None or ma60 is None or previous_ma20 is None or atr20 <= 0:
        return None
    swing = swing_high_low(high_values, low_values, SWING_WINDOW)
    support = _finite_number(swing.get("support"))
    resistance = _finite_number(swing.get("resistance"))
    if support is None or resistance is None:
        return None
    returns = [
        close_values[index] / close_values[index - 1] - 1
        for index in range(1, len(close_values))
        if close_values[index - 1] > 0
    ]
    return_std20_pct = statistics.pstdev(returns[-20:]) * 100 if len(returns) >= 20 else None
    atr20_pct = atr20 / price * 100
    ma20_slope_pct = (ma20 / previous_ma20 - 1) * 100 if previous_ma20 else None
    if price > ma20 and ma20 >= ma60 and ma20_slope_pct >= 0:
        trend_value = "up"
    elif price < ma20 and ma20 <= ma60 and ma20_slope_pct <= 0:
        trend_value = "down"
    else:
        trend_value = "sideways"
    stop_candidates = [level for level in (support, ma20) if level < price]
    stop_reference = max(stop_candidates) if stop_candidates else price - (2 * atr20)
    stop_loss = stop_reference - atr20 * 0.5
    stop_distance_pct = (price - stop_loss) / price * 100
    if stop_loss <= 0 or stop_distance_pct <= 0 or not math.isfinite(stop_distance_pct):
        return None
    quote_observed_at = parse_asia_datetime(
        getattr(quote, "as_of", None)
        or getattr(getattr(quote, "source", None), "published_at", None)
    )
    kline_observed_at = _bar_observed_at(bars[-1])
    cutoff_at = parse_asia_datetime(research_cutoff)
    if cutoff_at is not None:
        if quote_observed_at is not None and quote_observed_at > cutoff_at:
            quote_observed_at = None
        if kline_observed_at is not None and kline_observed_at > cutoff_at:
            kline_observed_at = None
    price_as_of = quote_observed_at.isoformat() if quote_observed_at is not None else None
    kline_as_of = kline_observed_at.isoformat() if kline_observed_at is not None else None
    available_times = [value for value in (quote_observed_at, kline_observed_at) if value is not None]
    as_of = max(available_times).isoformat() if available_times else research_cutoff
    sources = sorted(set(source_ids))

    def metric(payload: dict[str, Any], method_version: str) -> dict[str, Any]:
        return {
            **payload,
            "source_ids": sources,
            "as_of": as_of,
            "price_as_of": price_as_of,
            "kline_as_of": kline_as_of,
            "method_version": method_version,
        }

    return {
        "schema_version": 1,
        "method_version": DERIVED_DECISION_METRICS_VERSION,
        "source_ids": sources,
        "as_of": as_of,
        "price_as_of": price_as_of,
        "kline_as_of": kline_as_of,
        "price": price,
        "momentum": metric(
            {
                "momentum20_pct": (price / close_values[-21] - 1) * 100,
                # 60 bars provide 59 completed return intervals; do not
                # invent a 61st bar merely to label this observation.
                "momentum60_pct": (price / close_values[0] - 1) * 100,
            },
            "momentum-close-return-v1",
        ),
        "atr20": metric(
            {
                "value": atr20,
                "period": 20,
                "method": "true-range-simple-average",
            },
            "atr20-v1",
        ),
        "trend": metric(
            {
                "value": trend_value,
                "price": price,
                "ma20": ma20,
                "ma60": ma60,
                "ma20_slope_pct": ma20_slope_pct,
            },
            "trend-ma20-ma60-v1",
        ),
        "volatility": metric(
            {
                "atr20_pct": atr20_pct,
                "return_std20_pct": return_std20_pct,
            },
            "volatility-atr-return-std-v1",
        ),
        "swing": metric(
            {
                "support": support,
                "resistance": resistance,
                "window": SWING_WINDOW,
                "method": swing.get("method"),
            },
            "swing-high-low-v1",
        ),
        "stop_distance": metric(
            {
                "stop_loss": stop_loss,
                "value_pct": stop_distance_pct,
                "reference": "swing_support_or_ma20_minus_half_atr",
            },
            "stop-distance-atr-buffer-v1",
        ),
    }


def numeric_value(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _style_label(advance_ratio: float | None) -> str | None:
    if advance_ratio is None:
        return None
    if advance_ratio >= 0.55:
        return "breadth_positive"
    if advance_ratio <= 0.45:
        return "breadth_negative"
    return "breadth_balanced"


def _quote_source_ids(sources: dict[str, dict]) -> list[str]:
    return sorted(
        source_id
        for source_id, source in sources.items()
        if "price" in (source.get("fields") or [])
        and "title" not in (source.get("fields") or [])
        and "report_period" not in (source.get("fields") or [])
    )


def _event_type(text: str) -> str:
    for event_type, keywords in _EVENT_TYPES:
        if any(keyword in text for keyword in keywords):
            return event_type
    return "announcement"


def _event_date(text: str) -> str | None:
    for pattern in _EVENT_DATE_PATTERNS:
        match = pattern.search(text)
        if match is None:
            continue
        try:
            return datetime(
                int(match.group(1)), int(match.group(2)), int(match.group(3))
            ).date().isoformat()
        except ValueError:
            continue
    return None


def _structured_event_value(event: Any, *keys: str) -> Any:
    if isinstance(event, dict):
        for key in keys:
            if key in event:
                return event[key]
            camel = key.split("_")[0] + "".join(part.title() for part in key.split("_")[1:])
            if camel in event:
                return event[camel]
        return None
    for key in keys:
        value = getattr(event, key, None)
        if value is not None:
            return value
    return None


def _structured_event_payload(event: Any) -> dict[str, Any]:
    source = _structured_event_value(event, "source")
    source_ids = _structured_event_value(event, "source_ids", "source_id")
    if isinstance(source_ids, str):
        source_ids = [source_ids]
    source_id = _structured_event_value(source, "id") if source is not None else None
    source_ids = sorted({str(item).strip() for item in [*(source_ids or []), source_id] if str(item or "").strip()})
    categories = {
        "category_codes": _structured_event_value(event, "category_codes", "category_code") or [],
        "category_names": _structured_event_value(event, "category_names", "category_name") or [],
    }
    for key, value in categories.items():
        if isinstance(value, str):
            categories[key] = [value]
    return {
        "event_id": _structured_event_value(event, "event_id", "id"),
        "instrument_id": _structured_event_value(event, "instrument_id"),
        "event_type": _structured_event_value(event, "event_type", "type") or "announcement",
        "published_at": _structured_event_value(event, "published_at", "publish_time", "notice_time"),
        "event_date": _structured_event_value(event, "event_date"),
        "status": _structured_event_value(event, "status") or "published",
        "title": _structured_event_value(event, "title") or "",
        "summary": _structured_event_value(event, "summary") or "",
        "url": _structured_event_value(event, "url") or "",
        **categories,
        "source_ids": source_ids,
        "_source": source,
    }


def _macro_indicators(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract only explicitly stated macro percentages from portal text.

    The government search endpoint returns official-portal summaries rather
    than a stable numeric-series API.  Parsing a stated percentage is a
    transparent fact extraction; missing periods/units remain missing.
    """
    explicit = document.get("indicators")
    if isinstance(explicit, list):
        return [dict(item) for item in explicit if isinstance(item, dict)]
    text = f"{document.get('title') or ''} {document.get('summary') or ''}"
    indicators: list[dict[str, Any]] = []
    for name, pattern in _MACRO_INDICATOR_PATTERNS:
        match = pattern.search(text)
        if match is None:
            continue
        try:
            value = float(match.group(1))
        except (TypeError, ValueError):
            continue
        indicators.append(
            {
                "name": name,
                "value": value,
                "unit": "percent",
                "period_end": document.get("period_end"),
                "published_at": document.get("published_at"),
                "source_ids": document.get("source_ids") or [],
                "claim_type": "fact",
            }
        )
    return indicators


def _research_document_field(document: Any, field: str) -> Any:
    if isinstance(document, dict):
        return document.get(field)
    return getattr(document, field, None)


def _is_relevant_macro_policy_document(document: Any) -> bool:
    """Keep policy hits with a substantive macro or market-regulation signal.

    The official search endpoint matches keywords anywhere in a document
    summary.  A formal but procedural law can therefore be returned merely
    because it cites monetary policy.  Titles are the deterministic primary
    signal; a summary-only match needs two distinct substantive signals.
    """
    title = str(_research_document_field(document, "title") or "")
    summary = str(_research_document_field(document, "summary") or "")
    if any(marker in title for marker in _MACRO_POLICY_PROCEDURAL_TITLE_SIGNALS):
        return False
    if any(marker.casefold() in title.casefold() for marker in _MACRO_POLICY_TITLE_SIGNALS):
        return True
    text = f"{title} {summary}".casefold()
    matched = {
        marker.casefold()
        for marker in _MACRO_POLICY_TITLE_SIGNALS
        if marker.casefold() in text
    }
    return len(matched) >= 2


def _is_relevant_industry_policy_document(
    document: Any, target_industry: Any
) -> bool:
    """Require the returned industry policy to map to the snapshot industry."""
    industry = str(target_industry or "").strip().casefold()
    if not industry:
        return False
    text = " ".join(
        str(_research_document_field(document, field) or "")
        for field in ("title", "summary")
    ).casefold()
    return industry in text


class TradingCalendarUnavailableError(Exception):
    """Trading calendar could not be obtained; callers record a skip."""


class BatchCapacityError(Exception):
    """Batch exceeds the single-prompt evidence capacity."""


def _purge_expired_kline_cache(cache_dir: Path, *, ttl_days: int, now_ts: float) -> None:
    """Drop kline cache files older than the TTL (design §9).

    Raises on OS errors — the caller logs and continues, so a failing purge
    never breaks an evidence build.
    """
    cutoff = now_ts - ttl_days * 86400
    for entry in cache_dir.iterdir():
        if not entry.is_file() or entry.suffix != ".json":
            continue
        if entry.stat().st_mtime < cutoff:
            entry.unlink(missing_ok=True)


class EvidenceService:
    def __init__(
        self,
        workspace: Path,
        provider: Any,
        *,
        research_provider: Any | None = None,
        supplement_provider: Any | None = None,
        westock_provider: Any | None = None,
        cache_root: Path | None = None,
        batch_capacity: int = DEFAULT_BATCH_CAPACITY,
        news_limit: int = DEFAULT_NEWS_LIMIT,
        news_summary_chars: int = DEFAULT_NEWS_SUMMARY_CHARS,
        kline_bars: int = DEFAULT_KLINE_BARS,
        kline_cache_ttl_days: int = 14,
        clock: Callable[[], datetime] | None = None,
    ):
        self.workspace = Path(workspace)
        self.provider = provider
        self.research_provider = research_provider
        # Optional external supplements are an explicit seam.  Keep the
        # existing Tencent/EastMoney provider as the primary source and never
        # let an Agent/tool obtain this object directly.
        self.supplement_provider = (
            supplement_provider if supplement_provider is not None else westock_provider
        )
        self.cache_root = (
            Path(cache_root)
            if cache_root is not None
            else Path.home() / ".mona" / "stock" / "cache"
        )
        self.batch_capacity = batch_capacity
        self.news_limit = news_limit
        self.news_summary_chars = news_summary_chars
        self.kline_bars = kline_bars
        self.kline_cache_ttl_days = kline_cache_ttl_days
        self._clock = clock or (lambda: datetime.now(CN_TZ))
        self._lock = asyncio.Lock()
        # Populated by the existing SH index calendar lookup.  This is kept
        # in-memory for the duration of a build so a cutoff can distinguish a
        # current trading session from a weekend/holiday without guessing.
        self._trading_dates: set[str] = set()

    # --- paths ---

    @staticmethod
    def _check_run_id(run_id: str) -> None:
        if not run_id or any(c in run_id for c in ("/", "\\", "..")):
            raise ValueError(f"invalid run_id {run_id!r}")

    def _evidence_path(self, run_id: str) -> Path:
        self._check_run_id(run_id)
        from mona.config.paths import get_stock_project_dir

        return get_stock_project_dir(self.workspace, run_id) / "evidence.json"

    @staticmethod
    def _check_context_id(context_id: str) -> None:
        if not isinstance(context_id, str) or not _CONTEXT_ID_RE.fullmatch(context_id):
            raise ValueError(f"invalid context_id {context_id!r}")

    def _context_path(self, context_id: str) -> Path:
        """Return the durable, non-workflow context path.

        Direct-agent contexts are deliberately kept outside ``stock_projects``
        run directories.  They contain the same immutable evidence shape but
        are not workflow runs and must never be mistaken for one.
        """
        self._check_context_id(context_id)
        from mona.config.paths import get_stock_projects_dir

        return get_stock_projects_dir(self.workspace).parent / "stock_contexts" / f"{context_id}.json"

    @staticmethod
    def _market_observation_date(value: Any) -> str | None:
        parsed = parse_asia_datetime(value)
        return parsed.date().isoformat() if parsed is not None else None

    def _effective_market_snapshot_date(
        self,
        *,
        as_of: Any = None,
        research_cutoff_at: Any = None,
        legacy_as_of: Any = None,
    ) -> str | None:
        """Resolve the cache key for the observation relevant to a cutoff.

        An explicit ``as_of`` is a historical replay key and remains exact.
        For a research cutoff, pre-open and non-trading-day observations use
        the latest resolved close (``legacy_as_of``).  Once a known trading
        day is open, the key is that current date so a prior-day cache can
        never masquerade as an intraday snapshot.  If the trading calendar is
        unavailable, retain the current date after open rather than guessing
        that it is a holiday.
        """
        if as_of is not None:
            return self._market_observation_date(as_of)

        cutoff = parse_asia_datetime(research_cutoff_at)
        if cutoff is None:
            cutoff = parse_asia_datetime(self._clock())
        previous_close = self._market_observation_date(legacy_as_of)
        if cutoff is None:
            return previous_close
        if cutoff.time() < CASH_MARKET_OPEN_TIME:
            return previous_close

        current_date = cutoff.date().isoformat()
        if self._trading_dates and current_date not in self._trading_dates:
            return previous_close
        return current_date

    def _market_snapshot_cache_path(self, observation_date: str) -> Path:
        parsed = parse_asia_datetime(observation_date)
        if (
            not isinstance(observation_date, str)
            or parsed is None
            or len(observation_date.strip()) != 10
        ):
            raise ValueError(f"invalid market snapshot observation date {observation_date!r}")
        return self.cache_root / "market_snapshot" / f"{parsed.date().isoformat()}.json"

    @staticmethod
    def _snapshot_row_payload(row: Any) -> dict[str, Any] | None:
        if isinstance(row, dict):
            payload = dict(row)
        elif hasattr(row, "model_dump"):
            payload = row.model_dump()
        else:
            return None
        source = EvidenceService._snapshot_value(row, "source")
        if hasattr(source, "model_dump"):
            payload["source"] = source.model_dump()
        elif isinstance(source, dict):
            payload["source"] = dict(source)
        return payload

    @classmethod
    def _snapshot_rows_observation_date(cls, rows: list[Any]) -> str | None:
        dates = []
        for row in rows:
            payload = cls._snapshot_row_payload(row)
            if payload is None:
                return None
            observation_date = cls._market_observation_date(
                payload.get("observed_at") or payload.get("as_of")
            )
            if observation_date is None:
                return None
            dates.append(observation_date)
        if not dates or len(set(dates)) != 1:
            return None
        return dates[0]

    @classmethod
    def _snapshot_latest_observed_at(cls, rows: list[Any]) -> str | None:
        parsed_values = []
        for row in rows:
            payload = cls._snapshot_row_payload(row)
            if payload is None:
                continue
            value = payload.get("observed_at") or payload.get("as_of")
            parsed = parse_asia_datetime(value)
            if parsed is not None:
                parsed_values.append(parsed)
        return max(parsed_values).isoformat() if parsed_values else None

    def _snapshot_cache_payload(
        self,
        capture: MarketSnapshotCapture,
    ) -> tuple[str, dict[str, Any]] | None:
        if not capture.complete or not capture:
            return None
        observation_date = self._snapshot_rows_observation_date(list(capture))
        if observation_date is None:
            return None
        rows = []
        for row in capture:
            payload = self._snapshot_row_payload(row)
            source = payload.get("source") if payload is not None else None
            source_ids = payload.get("source_ids") if payload is not None else None
            source_id = source.get("id") if isinstance(source, dict) else None
            if (
                payload is None
                or not isinstance(source, dict)
                or not isinstance(source_id, str)
                or not isinstance(source_ids, list)
                or source_id not in source_ids
            ):
                return None
            rows.append(payload)
        return observation_date, {
            "schema_version": MARKET_SNAPSHOT_CACHE_VERSION,
            "observation_date": observation_date,
            "captured_at": self._clock().isoformat(),
            "expected_count": capture.expected_count,
            "page_size": capture.page_size,
            "requested_limit": capture.requested_limit,
            "complete": True,
            "error": capture.error,
            "rows": rows,
        }

    @classmethod
    def _snapshot_cache_info(
        cls,
        status: str,
        observation_date: str | None,
        rows: list[Any],
        *,
        freshness: str,
        **extra: Any,
    ) -> dict[str, Any]:
        info = {
            "status": status,
            "observation_date": observation_date,
            "observed_at": cls._snapshot_latest_observed_at(rows),
            "freshness": freshness,
        }
        info.update(extra)
        return info

    @classmethod
    def _decode_market_snapshot_row(cls, value: Any) -> Any | None:
        if not isinstance(value, dict):
            return None
        payload = dict(value)
        source_value = payload.get("source")
        if not isinstance(source_value, dict):
            return None
        try:
            source = SourceRecord.model_validate(source_value)
        except Exception:
            return None
        source_ids = payload.get("source_ids")
        if not isinstance(source_ids, list) or source.id not in source_ids:
            return None
        payload["source"] = source
        observation_date = cls._market_observation_date(
            payload.get("observed_at") or payload.get("as_of")
        )
        if observation_date is None:
            return None
        try:
            from mona.services.stock.screening import MarketSnapshot

            return MarketSnapshot.model_validate(payload)
        except Exception:
            # Preserve a provider-compatible mapping if a future provider
            # adds fields that the current screening model does not know.
            return payload

    def _read_market_snapshot_cache(
        self,
        observation_date: str | None,
    ) -> MarketSnapshotCapture | None:
        if observation_date is None:
            return None
        try:
            path = self._market_snapshot_cache_path(observation_date)
        except ValueError:
            return None
        if not path.is_file():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if (
                not isinstance(payload, dict)
                or payload.get("schema_version") != MARKET_SNAPSHOT_CACHE_VERSION
                or payload.get("observation_date") != observation_date
                or payload.get("complete") is not True
                or not isinstance(payload.get("rows"), list)
            ):
                raise ValueError("invalid market snapshot cache metadata")
            rows = [self._decode_market_snapshot_row(item) for item in payload["rows"]]
            if not rows or any(row is None for row in rows):
                raise ValueError("invalid market snapshot cache rows")
            capture = MarketSnapshotCapture(
                rows,
                expected_count=payload.get("expected_count"),
                page_size=payload.get("page_size") or len(rows),
                complete=True,
                error=payload.get("error"),
                requested_limit=payload.get("requested_limit"),
            )
            capture.cache_info = self._snapshot_cache_info(
                "hit",
                observation_date,
                rows,
                freshness="same_trading_day",
                cache_key=path.name,
            )
            return capture
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            logger.warning("ignoring invalid market snapshot cache {}: {}", path, exc)
            return None

    def _read_latest_prior_market_snapshot_cache(
        self,
        observation_date: str | None,
    ) -> MarketSnapshotCapture | None:
        """Return the newest valid completed capture not newer than cutoff.

        Exact-day cache remains the preferred path.  This fallback is only
        used after a live provider failure and is marked stale by callers, so
        a prior close cannot be presented as the current market state.
        """
        cache_dir = self.cache_root / "market_snapshot"
        if not cache_dir.is_dir():
            return None
        cutoff = parse_asia_datetime(observation_date) if observation_date else None
        candidates: list[str] = []
        for path in cache_dir.glob("*.json"):
            parsed = parse_asia_datetime(path.stem)
            if parsed is None or (cutoff is not None and parsed.date() > cutoff.date()):
                continue
            candidates.append(parsed.date().isoformat())
        for candidate in sorted(set(candidates), reverse=True):
            capture = self._read_market_snapshot_cache(candidate)
            if capture is not None:
                return capture
        return None

    def _mark_stale_market_snapshot(
        self,
        capture: MarketSnapshotCapture,
        *,
        fallback_reason: str,
    ) -> MarketSnapshotCapture:
        """Make cache age visible in deterministic section readiness."""
        capture.complete = False
        observation_date = self._snapshot_rows_observation_date(list(capture))
        capture.cache_info = self._snapshot_cache_info(
            "fallback",
            observation_date,
            list(capture),
            freshness="prior_trading_day",
            fallback_reason=fallback_reason,
        )
        return capture

    def _write_market_snapshot_cache(
        self,
        capture: MarketSnapshotCapture,
    ) -> str | None:
        prepared = self._snapshot_cache_payload(capture)
        if prepared is None:
            return None
        observation_date, payload = prepared
        try:
            path = self._market_snapshot_cache_path(observation_date)
            self._atomic_write(path, payload)
        except (OSError, TypeError, ValueError) as exc:
            logger.warning(
                "market snapshot cache write failed for {}: {}",
                observation_date,
                exc,
            )
            return None
        return observation_date

    # --- read ---

    def read(self, run_id: str, instrument_id: str | None = None) -> dict | None:
        path = self._evidence_path(run_id)
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        if instrument_id is None:
            return data
        return (data.get("symbols") or {}).get(instrument_id)

    def read_context(self, context_id: str) -> dict | None:
        """Read one direct-chat context without contacting a provider."""
        path = self._context_path(context_id)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid stock context {context_id!r}: {exc}") from exc
        return data if isinstance(data, dict) else None

    @staticmethod
    def _context_source_ids(value: Any) -> set[str]:
        """Collect source references from a persisted evidence bundle."""
        if isinstance(value, dict):
            source_ids = value.get("source_ids")
            found = {
                item for item in source_ids or [] if isinstance(item, str) and item
            }
            for key, child in value.items():
                if key != "source_ids":
                    found.update(EvidenceService._context_source_ids(child))
            return found
        if isinstance(value, list):
            found: set[str] = set()
            for child in value:
                found.update(EvidenceService._context_source_ids(child))
            return found
        return set()

    @classmethod
    def _validate_context_bundle(
        cls,
        context_id: str,
        run_id: str,
        instrument_id: str,
        payload: dict,
    ) -> dict:
        """Return the exact immutable bundle after checking its trust boundary."""
        if payload.get("context_id") != context_id:
            raise ValueError(f"stock context {context_id!r} has a mismatched context_id")
        owner = payload.get("owner")
        owner_run_id = (
            owner.get("workflow_run_id") or owner.get("run_id")
            if isinstance(owner, dict)
            else None
        )
        # A preflight context is intentionally unbound while the confirmation
        # dialog is open.  It may be consumed once by the run allocated after
        # confirmation; every other context must remain explicitly owned by
        # the target run.
        is_unbound_preflight = (
            owner_run_id is None
            and isinstance(owner, dict)
            and owner.get("kind") == "stock_preflight"
        )
        if owner_run_id != run_id and not is_unbound_preflight:
            raise ValueError(
                f"stock context {context_id!r} does not belong to run {run_id!r}"
            )
        symbols = payload.get("symbols")
        bundle = symbols.get(instrument_id) if isinstance(symbols, dict) else None
        if not isinstance(bundle, dict):
            raise ValueError(
                f"stock context {context_id!r} has no exact evidence for {instrument_id}"
            )
        instrument = bundle.get("instrument")
        actual_id = (
            f"{instrument.get('exchange')}:{instrument.get('symbol')}"
            if isinstance(instrument, dict)
            else None
        )
        if actual_id != instrument_id:
            raise ValueError(
                f"stock context {context_id!r} instrument does not match {instrument_id}"
            )
        research_cutoff = bundle.get("research_cutoff_at")
        if parse_asia_datetime(research_cutoff) is None:
            raise ValueError(
                f"stock context {context_id!r} has incomplete research_cutoff_at"
            )
        sources = bundle.get("sources")
        if not isinstance(sources, list) or not sources:
            raise ValueError(f"stock context {context_id!r} has incomplete sources")
        source_ids = set()
        for source in sources:
            source_id = source.get("id") if isinstance(source, dict) else None
            if not isinstance(source_id, str) or not source_id:
                raise ValueError(f"stock context {context_id!r} has incomplete sources")
            source_ids.add(source_id)
        missing_source_ids = cls._context_source_ids(bundle) - source_ids
        if missing_source_ids:
            missing = ", ".join(sorted(missing_source_ids))
            raise ValueError(
                f"stock context {context_id!r} is missing source records: {missing}"
            )
        return bundle

    async def promote_context(
        self,
        context_id: str,
        run_id: str,
        instrument_id: str,
        material_binding_ids: list[str] | None = None,
    ) -> dict:
        """Promote an immutable context bundle into a workflow run.

        Promotion is a local, atomic copy.  It never contacts a provider and
        refuses to overwrite a different bundle already persisted for the
        same run/instrument.
        """
        self._check_context_id(context_id)
        if not isinstance(run_id, str):
            raise ValueError(f"invalid run_id {run_id!r}")
        self._check_run_id(run_id)
        if not isinstance(instrument_id, str) or not instrument_id:
            raise ValueError(f"invalid instrument_id {instrument_id!r}")
        async with self._lock:
            # ``EvidenceService`` instances are split between services and the
            # gateway.  Keep the synchronous, short file transaction off the
            # event loop and coordinate those instances with a lock dedicated
            # to this exact context file.
            return await asyncio.to_thread(
                self._promote_context_with_file_lock,
                context_id,
                run_id,
                instrument_id,
                material_binding_ids,
            )

    def _promote_context_with_file_lock(
        self,
        context_id: str,
        run_id: str,
        instrument_id: str,
        material_binding_ids: list[str] | None = None,
    ) -> dict:
        context_path = self._context_path(context_id)
        context_path.parent.mkdir(parents=True, exist_ok=True)
        lock = FileLock(
            f"{context_path}.lock",
            timeout=CONTEXT_PROMOTE_LOCK_TIMEOUT_SECONDS,
        )
        try:
            with lock:
                return self._promote_context_locked(
                    context_path,
                    context_id,
                    run_id,
                    instrument_id,
                    material_binding_ids,
                )
        except FileLockTimeout as exc:
            raise RuntimeError(
                f"stock context {context_id!r} lock timeout after "
                f"{CONTEXT_PROMOTE_LOCK_TIMEOUT_SECONDS:g}s"
            ) from exc

    def _promote_context_locked(
        self,
        context_path: Path,
        context_id: str,
        run_id: str,
        instrument_id: str,
        material_binding_ids: list[str] | None = None,
    ) -> dict:
        context = self._load_file(context_path)
        if not isinstance(context, dict) or not context:
            raise ValueError(f"stock context {context_id!r} not found")
        owner = context.get("owner")
        owner_run_id = (
            owner.get("workflow_run_id") or owner.get("run_id")
            if isinstance(owner, dict)
            else None
        )
        is_unbound_preflight = (
            owner_run_id is None
            and isinstance(owner, dict)
            and owner.get("kind") == "stock_preflight"
        )
        bundle = self._validate_context_bundle(
            context_id, run_id, instrument_id, context
        )
        if material_binding_ids:
            bundle = self._attach_materials(
                bundle,
                instrument_id,
                material_binding_ids,
                research_cutoff_at=bundle.get("research_cutoff_at"),
            )

        path = self._evidence_path(run_id)
        data = self._load_file(path)
        if not isinstance(data, dict):
            raise ValueError(f"invalid evidence bundle for run {run_id!r}")
        persisted_run_id = data.get("run_id")
        if persisted_run_id is not None and persisted_run_id != run_id:
            raise ValueError(f"evidence bundle run_id mismatch for {run_id!r}")
        symbols = data.get("symbols")
        if symbols is None:
            symbols = {}
        if not isinstance(symbols, dict):
            raise ValueError(f"invalid evidence symbols for run {run_id!r}")
        existing = symbols.get(instrument_id)
        if existing is not None:
            if existing == bundle:
                return existing
            raise ValueError(
                f"conflicting evidence bundle for {run_id!r}/{instrument_id}"
            )

        if is_unbound_preflight:
            # Bind the envelope before writing the run evidence.  If the
            # process stops between the two atomic writes, a retry for the
            # same run remains safe while another run cannot replay it.
            bound_context = dict(context)
            bound_owner = dict(owner)
            bound_owner["workflow_run_id"] = run_id
            bound_context["owner"] = bound_owner
            bound_symbols = dict(bound_context.get("symbols") or {})
            bound_symbols[instrument_id] = bundle
            bound_context["symbols"] = bound_symbols
            self._atomic_write(context_path, bound_context)

        updated = dict(data)
        updated["schema_version"] = data.get("schema_version", SCHEMA_VERSION)
        updated["run_id"] = run_id
        updated["symbols"] = dict(symbols)
        updated["symbols"][instrument_id] = bundle
        self._atomic_write(path, updated)
        return bundle

    # --- as_of / trading calendar ---

    async def resolve_as_of(self) -> str:
        """Most recent trading close (15:00 Asia/Shanghai) as ISO string."""
        now = parse_asia_datetime(self._clock())
        if now is None:
            raise TradingCalendarUnavailableError("clock returned an unknown time")
        return await self._resolve_as_of_at(now)

    async def _resolve_as_of_at(self, cutoff: datetime) -> str:
        """Resolve the latest known trading close at or before ``cutoff``."""
        try:
            series = await self.provider.kline(SH_INDEX, limit=30)
        except Exception as exc:
            raise TradingCalendarUnavailableError(
                f"trading calendar fetch failed: {exc}"
            ) from exc
        dates = [b.date for b in series.bars]
        if not dates:
            raise TradingCalendarUnavailableError("trading calendar is empty")
        closes = []
        for d in dates:
            parsed = parse_asia_datetime(d)
            if parsed is None:
                continue
            closes.append(
                parsed.replace(
                    hour=CLOSE_TIME.hour,
                    minute=CLOSE_TIME.minute,
                    second=0,
                    microsecond=0,
                )
            )
        self._trading_dates = {close.date().isoformat() for close in closes}
        past = [c for c in closes if c <= cutoff]
        if not past:
            raise TradingCalendarUnavailableError(
                f"no trading close on or before {cutoff.isoformat()}"
            )
        return max(past).isoformat()

    # --- build ---

    def _attach_materials(
        self,
        bundle: dict[str, Any],
        instrument_id: str,
        material_binding_ids: list[str],
        *,
        research_cutoff_at: str | None = None,
    ) -> dict[str, Any]:
        """Attach revalidated user-confirmed report pages without fetching."""
        effective_cutoff = research_cutoff_at or bundle.get("research_cutoff_at")
        projections = MaterialBindingStore(self.workspace).confirmed_projections(
            material_binding_ids,
            instrument_id=instrument_id,
            research_cutoff_at=effective_cutoff,
        )
        enriched = dict(bundle)
        sources: dict[str, dict[str, Any]] = {
            source["id"]: dict(source)
            for source in bundle.get("sources") or []
            if isinstance(source, dict) and isinstance(source.get("id"), str)
        }
        material_items: list[dict[str, Any]] = []
        material_summaries: list[dict[str, Any]] = []
        confirmed_user_metrics: list[dict[str, Any]] = []
        all_material_source_ids: list[str] = []
        for projection in projections:
            pages: list[dict[str, Any]] = []
            source_ids: list[str] = []
            for page in projection.get("pages") or []:
                source = page.get("source")
                if not isinstance(source, dict):
                    raise ValueError("confirmed material page is missing its source record")
                source_id = page.get("source_id") or source.get("id")
                if not isinstance(source_id, str) or not source_id:
                    raise ValueError("confirmed material page is missing its source id")
                source = dict(source)
                source["location_label"] = f"用户上传财报，第 {page['page']} 页"
                source["source_role"] = "user_confirmed_financial_report"
                source["instrument_id"] = instrument_id
                sources[source_id] = source
                source_ids.append(source_id)
                all_material_source_ids.append(source_id)
                pages.append(
                    {
                        "page": page["page"],
                        "text": page["text"],
                        "file_hash": page["file_hash"],
                        "location": {"page": page["page"]},
                        "source_id": source_id,
                    }
                )
            source_ids = list(dict.fromkeys(source_ids))
            material_items.append(
                {
                    "material_id": projection["material_id"],
                    "material_name": projection.get("material_name") or projection["material_id"],
                    "report_type": projection["report_type"],
                    "report_period": projection["report_period"],
                    "first_published_at": projection["first_published_at"],
                    "confirmed_facts": projection.get("confirmed_facts") or [],
                    "pages": pages,
                    "source_ids": source_ids,
                }
            )
            confirmed_user_metrics.extend(projection.get("confirmed_facts") or [])
            material_summaries.append(
                {
                    "label": "已确认用户财报",
                    "material_name": projection.get("material_name") or projection["material_id"],
                    "report_period": projection["report_period"],
                    "pages": [page["page"] for page in projection.get("pages") or []],
                    "source_ids": source_ids,
                }
            )

        enriched["materials"] = {
            "status": "available",
            "items": material_items,
            "source_ids": list(dict.fromkeys(all_material_source_ids)),
        }
        fundamentals = enriched.get("fundamentals")
        if not isinstance(fundamentals, dict):
            fundamentals = {
                "report_period": None,
                "period_end": None,
                "published_at": None,
                "availability_status": "missing",
                "metrics": None,
                "source_ids": [],
            }
        fundamentals = dict(fundamentals)
        fundamentals["confirmed_user_materials"] = material_summaries
        fundamentals["confirmed_user_metrics"] = confirmed_user_metrics
        fundamentals["source_ids"] = list(
            dict.fromkeys(
                [
                    *(
                        source_id
                        for source_id in fundamentals.get("source_ids") or []
                        if isinstance(source_id, str)
                    ),
                    *all_material_source_ids,
                ]
            )
        )
        enriched["fundamentals"] = fundamentals
        enriched["sources"] = list(sources.values())
        return enriched

    async def build(
        self,
        run_id: str,
        inst: InstrumentRef,
        *,
        as_of: str | None = None,
        research_cutoff_at: str | None = None,
        _legacy_as_of: str | None = None,
        _market_snapshot: list[Any] | None = None,
        _market_snapshot_loaded: bool = False,
        _benchmark_series: Any | None = None,
        _benchmark_series_loaded: bool = False,
        name: str = "",
        material_binding_ids: list[str] | None = None,
    ) -> dict:
        """Build or load the bundle for ``(run_id, inst.id)``."""
        async with self._lock:
            path = self._evidence_path(run_id)
            data = self._load_file(path)
            existing = (data.get("symbols") or {}).get(inst.id)
            if existing is not None:
                if material_binding_ids:
                    enriched = self._attach_materials(
                        existing,
                        inst.id,
                        material_binding_ids,
                        research_cutoff_at=research_cutoff_at,
                    )
                    if enriched != existing:
                        data.setdefault("symbols", {})[inst.id] = enriched
                        self._atomic_write(path, data)
                    return enriched
                return existing
            benchmark_series = (
                _benchmark_series
                if _benchmark_series_loaded
                else await self._fetch_benchmark_series()
            )
            bundle = await self._build_one(
                inst,
                as_of=as_of,
                research_cutoff_at=research_cutoff_at,
                _legacy_as_of=_legacy_as_of,
                _market_snapshot=_market_snapshot,
                _market_snapshot_loaded=_market_snapshot_loaded,
                _benchmark_series=benchmark_series,
                name=name,
                material_binding_ids=material_binding_ids,
            )
            data.setdefault("schema_version", SCHEMA_VERSION)
            data.setdefault("run_id", run_id)
            data.setdefault("symbols", {})[inst.id] = bundle
            self._atomic_write(path, data)
            return bundle

    async def build_context(
        self,
        context_id: str,
        inst: InstrumentRef,
        *,
        as_of: str | None = None,
        research_cutoff_at: str | None = None,
        name: str = "",
        sections: set[str] | None = None,
        owner: dict[str, str] | None = None,
        material_binding_ids: list[str] | None = None,
    ) -> dict:
        """Build one immutable evidence context for a direct chat.

        This intentionally delegates all fetching and normalization to the
        existing EvidenceBundle builder.  The only extra state is the
        context envelope used by ``stock_source_open`` to prove that a source
        id came from this exact context.
        """
        self._check_context_id(context_id)
        path = self._context_path(context_id)
        async with self._lock:
            existing = self._load_file(path)
            if existing:
                symbols = existing.get("symbols") or {}
                bundle = symbols.get(inst.id)
                if bundle is not None:
                    if material_binding_ids:
                        enriched = self._attach_materials(
                            bundle,
                            inst.id,
                            material_binding_ids,
                            research_cutoff_at=research_cutoff_at,
                        )
                        if enriched != bundle:
                            updated = dict(existing)
                            updated["symbols"] = dict(symbols)
                            updated["symbols"][inst.id] = enriched
                            self._atomic_write(path, updated)
                            return updated
                    return existing
            bundle = await self._build_one(
                inst,
                as_of=as_of,
                research_cutoff_at=research_cutoff_at,
                _legacy_as_of=None,
                _market_snapshot=None,
                _market_snapshot_loaded=False,
                _benchmark_series=await self._fetch_benchmark_series(),
                name=name,
                sections=sections,
                material_binding_ids=material_binding_ids,
            )
            payload = {
                "schema_version": SCHEMA_VERSION,
                "context_id": context_id,
                "owner": dict(owner or {}),
                "created_at": self._clock().isoformat(),
                "symbols": {inst.id: bundle},
            }
            self._atomic_write(path, payload)
            return payload

    async def build_batch(
        self,
        run_id: str,
        instruments: list[InstrumentRef],
        *,
        as_of: str | None = None,
        research_cutoff_at: str | None = None,
        material_binding_ids: list[str] | None = None,
    ) -> dict[str, dict]:
        if len(instruments) > self.batch_capacity:
            raise BatchCapacityError(
                f"{len(instruments)} instruments exceed batch capacity "
                f"{self.batch_capacity}; trim the watchlist or split the review"
            )
        path = self._evidence_path(run_id)
        existing_data = self._load_file(path)
        existing_symbols = existing_data.get("symbols") or {}
        out = {
            inst.id: existing_symbols[inst.id]
            for inst in instruments
            if inst.id in existing_symbols
        }
        if material_binding_ids:
            for inst in instruments:
                if inst.id in out:
                    out[inst.id] = await self.build(
                        run_id,
                        inst,
                        as_of=as_of,
                        research_cutoff_at=research_cutoff_at,
                        material_binding_ids=material_binding_ids,
                    )
        pending = [inst for inst in instruments if inst.id not in existing_symbols]
        if not pending:
            return out
        legacy_as_of = as_of
        if legacy_as_of is None:
            if research_cutoff_at is None:
                legacy_as_of = await self.resolve_as_of()
            else:
                normalized_cutoff = normalize_asia_datetime(research_cutoff_at)
                cutoff = parse_asia_datetime(normalized_cutoff)
                if cutoff is None:
                    raise ValueError(f"invalid research_cutoff_at {research_cutoff_at!r}")
                legacy_as_of = await self._resolve_as_of_at(cutoff)
        market_snapshot = await self._fetch_market_snapshot(
            target_date=self._effective_market_snapshot_date(
                as_of=as_of,
                research_cutoff_at=research_cutoff_at,
                legacy_as_of=legacy_as_of,
            )
        )
        benchmark_series = await self._fetch_benchmark_series()
        for inst in pending:
            out[inst.id] = await self.build(
                run_id,
                inst,
                as_of=as_of,
                research_cutoff_at=research_cutoff_at,
                _legacy_as_of=legacy_as_of,
                _market_snapshot=market_snapshot,
                _market_snapshot_loaded=True,
                _benchmark_series=benchmark_series,
                _benchmark_series_loaded=True,
                material_binding_ids=material_binding_ids,
            )
        return out

    async def _fetch_benchmark_series(self):
        """Fetch the fixed public benchmark once; failures stay explicit."""
        method = getattr(self.provider, "kline", None)
        if method is None:
            logger.warning("stock benchmark unavailable: provider has no kline")
            return None
        try:
            series = await method(PUBLIC_BENCHMARK, limit=BENCHMARK_KLINE_LIMIT)
        except Exception as exc:  # benchmark gaps must not block stock evidence
            logger.warning("stock benchmark unavailable: {}", exc)
            return None
        if (
            getattr(series, "instrument_id", None) != PUBLIC_BENCHMARK.id
            or not getattr(series, "bars", None)
            or getattr(series, "source", None) is None
        ):
            logger.warning("stock benchmark returned unverifiable instrument data")
            return None
        return series

    @staticmethod
    def _westock_result_data(result: Any) -> tuple[dict[str, Any] | list[Any] | None, Any, str | None]:
        """Read one adapter result without depending on its concrete class."""
        if hasattr(result, "model_dump"):
            result = result.model_dump()
        if not isinstance(result, dict):
            return None, None, None
        data = result.get("data")
        if not isinstance(data, (dict, list)):
            return None, None, None
        return data, result.get("source"), result.get("data_as_of") or result.get("as_of")

    @staticmethod
    def _trim_westock_data(command: str, data: Any) -> Any:
        """Keep structured signals while excluding report/news text tables."""
        if command in {"report", "notice"}:
            rows = data if isinstance(data, list) else [data]
            allowed = {
                "title",
                "url",
                "published_at",
                "publish_time",
                "notice_date",
                "report_period",
                "period_end",
                "issuer",
                "category",
                "document_id",
                "event_type",
            }
            return [
                {key: row[key] for key in allowed if key in row}
                for row in rows
                if isinstance(row, dict)
            ][:20]
        if isinstance(data, list):
            return [item for item in data[:100] if isinstance(item, (dict, str, int, float, bool))]
        if isinstance(data, dict):
            return {
                key: value
                for key, value in list(data.items())[:100]
                if key not in {"text", "content", "body", "raw", "summary", "html"}
            }
        return data

    async def _fetch_westock_supplements(
        self,
        inst: InstrumentRef,
        *,
        research_cutoff: str,
        keep_source: Callable[[Any], None],
        data_quality: dict[str, Any],
    ) -> dict[str, dict[str, Any]]:
        """Fetch only through the explicit optional supplement seam.

        A failed optional command is recorded as a fallback reason and never
        raises out of Evidence.  Future or timestamp-unknown rows are not
        promoted into the immutable bundle.
        """
        provider = self.supplement_provider
        if provider is None:
            return {}
        fetch = getattr(provider, "fetch", None) or getattr(provider, "query", None)
        if not callable(fetch):
            data_quality.setdefault("westock", {})["status"] = "unavailable"
            data_quality["westock"]["reason"] = "provider_missing_fetch"
            return {}
        output: dict[str, dict[str, Any]] = {}
        status_by_command: dict[str, Any] = {}
        semaphore = asyncio.Semaphore(3)

        async def fetch_one(command: str) -> tuple[str, Any, Exception | None]:
            try:
                async with semaphore:
                    return command, await fetch(command, inst), None
            except Exception as exc:
                return command, None, exc

        results = await asyncio.gather(
            *(fetch_one(command) for command in sorted(WESTOCK_COMMANDS))
        )
        for command, result, error in results:
            if error is not None:
                status_by_command[command] = {
                    "status": "fallback",
                    "reason": type(error).__name__,
                }
                continue
            data, source, data_as_of = self._westock_result_data(result)
            if data is None or source is None:
                status_by_command[command] = {
                    "status": "fallback",
                    "reason": "invalid_adapter_result",
                }
                continue
            source_id = getattr(source, "id", None)
            if isinstance(source, dict):
                try:
                    source = SourceRecord.model_validate(source)
                    source_id = source.id
                except Exception:
                    source_id = None
            if not isinstance(source, SourceRecord) or not source_id:
                status_by_command[command] = {
                    "status": "fallback",
                    "reason": "missing_source_record",
                }
                continue
            relation = compare_asia_datetime(data_as_of, research_cutoff)
            if relation is False:
                data_quality.setdefault("excluded_future", []).append(
                    {
                        "section": f"westock_{command}",
                        "field": "data_as_of",
                        "value": data_as_of,
                        "reason": "after_research_cutoff",
                    }
                )
                status_by_command[command] = {
                    "status": "fallback",
                    "reason": "after_research_cutoff",
                }
                continue
            if relation is None:
                data_quality.setdefault("unknown_availability", []).append(
                    {
                        "section": f"westock_{command}",
                        "field": "data_as_of",
                        "value": data_as_of,
                        "reason": "unparseable_or_missing_public_time",
                    }
                )
                status_by_command[command] = {
                    "status": "fallback",
                    "reason": "unknown_public_time",
                }
                continue
            keep_source(source)
            payload = result if isinstance(result, dict) else result.model_dump()
            output[command] = {
                "status": "available",
                "data": self._trim_westock_data(command, data),
                "data_as_of": normalize_asia_datetime(data_as_of),
                "source_ids": [source.id],
                "source": source.model_dump(),
                "package_name": payload.get("package_name", "westock-data-skillhub"),
                "package_version": payload.get("package_version"),
                "contract_version": payload.get("contract_version"),
                "raw_output_hash": payload.get("raw_output_hash"),
                "validation_mode": payload.get("validation_mode", "unknown"),
            }
            status_by_command[command] = {
                "status": "available",
                "source_ids": [source.id],
                "data_as_of": normalize_asia_datetime(data_as_of),
            }
        data_quality["westock"] = {
            "status": "available" if output else "fallback",
            "commands": status_by_command,
            "capability_matrix": (
                provider.capability_matrix() if callable(getattr(provider, "capability_matrix", None)) else {}
            ),
        }
        return output

    @staticmethod
    def _westock_fundamental_rows(
        result: dict[str, Any], inst: InstrumentRef
    ) -> list[Fundamentals]:
        """Convert a validated asfund supplement only when the primary is absent."""
        data = result.get("data")
        source_ids = result.get("source_ids") or []
        source = result.get("source")
        if isinstance(source, dict):
            try:
                source = SourceRecord.model_validate(source)
            except Exception:
                source = None
        if not isinstance(source, SourceRecord) or not source_ids:
            return []
        raw_rows = data if isinstance(data, list) else [data]
        out: list[Fundamentals] = []
        for row in raw_rows:
            if not isinstance(row, dict):
                continue
            metrics = {
                key: value
                for key, value in row.items()
                if key
                in {
                    "eps",
                    "roe",
                    "roic",
                    "gross_margin",
                    "net_margin",
                    "revenue",
                    "revenue_yoy",
                    "net_profit",
                    "profit_yoy",
                    "operating_cashflow",
                    "debt_ratio",
                    "capex",
                    "pe",
                    "pb",
                    "cashflow_to_profit",
                }
            }
            if not metrics:
                continue
            report_period = row.get("report_period") or row.get("period_end")
            out.append(
                Fundamentals(
                    instrument_id=inst.id,
                    instrument_type=inst.instrument_type,
                    report_period=str(report_period)[:10] if report_period else None,
                    metrics=metrics,
                    source=source,
                )
            )
        return out

    @staticmethod
    def _merge_westock_fundamentals(
        bundle: dict[str, Any], result: dict[str, Any]
    ) -> None:
        data = result.get("data")
        rows = data if isinstance(data, list) else [data]
        source_ids = [item for item in result.get("source_ids") or [] if isinstance(item, str)]
        history = bundle.get("fundamentals_history")
        history = [dict(item) for item in history if isinstance(item, dict)] if isinstance(history, list) else []
        by_period = {
            str(item.get("report_period")): item
            for item in history
            if item.get("report_period")
        }
        metric_names = {
            "eps", "roe", "roic", "gross_margin", "net_margin", "revenue",
            "revenue_yoy", "net_profit", "profit_yoy", "operating_cashflow",
            "cashflow_to_profit", "debt_ratio", "capex", "pe", "pb",
            "interest_coverage", "current_ratio",
        }
        for raw in rows:
            if not isinstance(raw, dict):
                continue
            period = str(raw.get("report_period") or raw.get("period_end") or "")[:10]
            published_at = normalize_asia_datetime(raw.get("published_at"))
            if not period or published_at is None:
                continue
            metrics = {key: raw[key] for key in metric_names if raw.get(key) is not None}
            if not metrics:
                continue
            target = by_period.get(period)
            if target is None:
                target = {
                    "report_period": period,
                    "period_end": period,
                    "published_at": published_at,
                    "availability_status": "known",
                    "metrics": {},
                    "source_ids": [],
                }
                history.append(target)
                by_period[period] = target
            target_metrics = target.get("metrics")
            if not isinstance(target_metrics, dict):
                target_metrics = {}
                target["metrics"] = target_metrics
            contributed = False
            for key, value in metrics.items():
                if target_metrics.get(key) is None:
                    target_metrics[key] = value
                    contributed = True
            if contributed:
                target["source_ids"] = sorted(set((target.get("source_ids") or []) + source_ids))
                existing_published = normalize_asia_datetime(target.get("published_at"))
                target["published_at"] = max(
                    [value for value in (existing_published, published_at) if value]
                )
        history.sort(key=lambda item: str(item.get("report_period") or ""), reverse=True)
        bundle["fundamentals_history"] = history
        if history:
            bundle["fundamentals"] = dict(history[0])

    @staticmethod
    def _merge_westock_supplements(
        bundle: dict[str, Any], supplements: dict[str, dict[str, Any]]
    ) -> None:
        profile = supplements.get("profile")
        if isinstance(profile, dict) and profile.get("status") == "available":
            bundle["company_profile"] = {
                **(profile.get("data") if isinstance(profile.get("data"), dict) else {}),
                "source_ids": profile.get("source_ids") or [],
                "as_of": profile.get("data_as_of"),
            }

        finance = supplements.get("asfund")
        if isinstance(finance, dict) and finance.get("status") == "available":
            EvidenceService._merge_westock_fundamentals(bundle, finance)

        technical = supplements.get("technical")
        if isinstance(technical, dict) and technical.get("status") == "available":
            bundle["technical_supplement"] = {
                **(technical.get("data") if isinstance(technical.get("data"), dict) else {}),
                "source_ids": technical.get("source_ids") or [],
            }

        chip = supplements.get("chip")
        if isinstance(chip, dict) and chip.get("status") == "available":
            bundle["chip_data"] = {
                **(chip.get("data") if isinstance(chip.get("data"), dict) else {}),
                "source_ids": chip.get("source_ids") or [],
            }

        sector = supplements.get("sector")
        if isinstance(sector, dict) and sector.get("status") == "available":
            rows = sector.get("data")
            bundle["industry_operating_data"] = {
                "status": "available" if isinstance(rows, list) and rows else "missing",
                "indicators": rows if isinstance(rows, list) else [],
                "as_of": sector.get("data_as_of"),
                "source_ids": sector.get("source_ids") or [],
            }

        macro = supplements.get("macro")
        if isinstance(macro, dict) and macro.get("status") == "available":
            indicators = macro.get("data")
            if isinstance(indicators, list) and indicators:
                source_ids = macro.get("source_ids") or []
                normalized = [
                    {**item, "source_ids": source_ids, "claim_type": "fact"}
                    for item in indicators
                    if isinstance(item, dict)
                ]
                bundle.setdefault("macro_documents", []).append(
                    {
                        "title": "公开宏观指标",
                        "published_at": max(
                            (item.get("published_at") for item in normalized if item.get("published_at")),
                            default=macro.get("data_as_of"),
                        ),
                        "period_end": max(
                            (item.get("period_end") for item in normalized if item.get("period_end")),
                            default=None,
                        ),
                        "summary": "",
                        "indicators": normalized,
                        "source_ids": source_ids,
                    }
                )

        report = supplements.get("report")
        if isinstance(report, dict) and report.get("status") == "available":
            rows = report.get("data")
            bundle["research_reports"] = [
                {**item, "source_ids": report.get("source_ids") or []}
                for item in rows if isinstance(item, dict)
            ] if isinstance(rows, list) else []

        notice = supplements.get("notice")
        if isinstance(notice, dict) and notice.get("status") == "available":
            existing = {
                (item.get("title"), item.get("published_at"))
                for item in bundle.get("news") or []
                if isinstance(item, dict)
            }
            for item in notice.get("data") or []:
                if not isinstance(item, dict):
                    continue
                key = (item.get("title"), item.get("published_at"))
                if key in existing:
                    continue
                bundle.setdefault("news", []).append(
                    {
                        "title": item.get("title") or "",
                        "url": item.get("url") or "",
                        "published_at": item.get("published_at"),
                        "summary": "",
                        "source_ids": notice.get("source_ids") or [],
                    }
                )
                existing.add(key)

    async def _fetch_westock_profile(self, inst: InstrumentRef) -> dict[str, Any] | None:
        provider = self.supplement_provider
        fetch = getattr(provider, "fetch", None) if provider is not None else None
        if not callable(fetch):
            return None
        try:
            result = await fetch("profile", inst)
        except Exception as exc:
            logger.warning("stock WeStock profile unavailable for {}: {}", inst.id, exc)
            return None
        data, source, data_as_of = self._westock_result_data(result)
        if isinstance(data, list):
            data = data[0] if data else None
        if not isinstance(data, dict) or source is None:
            return None
        if isinstance(source, dict):
            try:
                source = SourceRecord.model_validate(source)
            except Exception:
                return None
        if not isinstance(source, SourceRecord):
            return None
        industry = data.get("industry") or data.get("industry_name") or data.get("sector")
        observed_at = data_as_of or data.get("observed_at") or data.get("as_of") or source.published_at
        if not isinstance(industry, str) or not industry.strip() or parse_asia_datetime(observed_at) is None:
            return None
        return {
            "instrument_id": inst.id,
            "symbol": inst.symbol,
            "exchange": inst.exchange,
            "instrument_type": inst.instrument_type,
            "name": data.get("name") or data.get("security_name") or "",
            "company_name": data.get("company_name"),
            "industry": industry.strip(),
            "industry_code": data.get("industry_code"),
            "classification_scheme": data.get("classification_scheme") or "westock",
            "main_business": data.get("main_business") or data.get("business_scope"),
            "listing_date": data.get("listing_date"),
            "board": data.get("board"),
            "observed_at": normalize_asia_datetime(observed_at),
            "as_of": normalize_asia_datetime(observed_at),
            "source_ids": [source.id],
            "source": source,
        }

    async def _fetch_instrument_profile(self, inst: InstrumentRef) -> dict[str, Any] | None:
        """Read static instrument metadata through an optional provider seam.

        Classification is not a property of a live market breadth request.
        Providers may supply an independently cached profile (industry and
        business metadata) without changing the evidence fetch contract.
        """
        method = getattr(self.provider, "instrument_profile", None)
        if not callable(method):
            return await self._fetch_westock_profile(inst)
        try:
            raw = await method(inst)
        except Exception as exc:
            logger.warning("stock instrument profile unavailable for {}: {}", inst.id, exc)
            return await self._fetch_westock_profile(inst)
        if hasattr(raw, "model_dump"):
            raw = raw.model_dump()
        if not isinstance(raw, dict):
            return await self._fetch_westock_profile(inst)
        industry = raw.get("industry")
        source = raw.get("source")
        if not isinstance(industry, str) or not industry.strip():
            return await self._fetch_westock_profile(inst)
        if isinstance(source, dict):
            try:
                source = SourceRecord.model_validate(source)
            except Exception:
                return await self._fetch_westock_profile(inst)
        if not isinstance(source, SourceRecord) or not source.id:
            return await self._fetch_westock_profile(inst)
        observed_at = raw.get("observed_at") or raw.get("as_of") or source.published_at
        if parse_asia_datetime(observed_at) is None:
            return await self._fetch_westock_profile(inst)
        return {
            "instrument_id": inst.id,
            "symbol": inst.symbol,
            "exchange": inst.exchange,
            "instrument_type": inst.instrument_type,
            "industry": industry.strip(),
            "industry_code": raw.get("industry_code"),
            "classification_scheme": raw.get("classification_scheme"),
            "industry_member_coverage": raw.get("industry_member_coverage"),
            "industry_benchmark": raw.get("industry_benchmark"),
            "listing_date": raw.get("listing_date"),
            "board": raw.get("board"),
            "observed_at": normalize_asia_datetime(observed_at),
            "as_of": normalize_asia_datetime(observed_at),
            "source_ids": [source.id],
            "source": source,
        }

    async def _fetch_industry_valuation(self, inst: InstrumentRef) -> dict[str, Any] | None:
        """Fetch independent same-industry valuation facts when supported."""
        method = getattr(self.provider, "industry_valuation", None)
        if not callable(method):
            return None
        try:
            raw = await method(inst)
        except Exception as exc:
            logger.warning("stock industry valuation unavailable for {}: {}", inst.id, exc)
            return None
        if hasattr(raw, "model_dump"):
            raw = raw.model_dump()
        if not isinstance(raw, dict):
            return None
        source = raw.get("source")
        if isinstance(source, dict):
            try:
                source = SourceRecord.model_validate(source)
            except Exception:
                return None
        observed_at = raw.get("observed_at") or getattr(source, "published_at", None)
        if not isinstance(source, SourceRecord) or not source.id or parse_asia_datetime(observed_at) is None:
            return None
        peers = raw.get("peers")
        if not isinstance(peers, list):
            return None
        return {
            **raw,
            "peers": [item for item in peers if isinstance(item, dict)],
            "observed_at": normalize_asia_datetime(observed_at),
            "source": source,
        }

    def _read_screening_snapshot_cache(self) -> list[Any]:
        """Read the existing screening snapshot database as a stale backup."""
        try:
            from mona.services.stock.screening import ScreeningStore

            store = ScreeningStore(self.cache_root.parent)
            rows = []
            for snapshot, source in store.latest_snapshots_with_sources():
                if not isinstance(source, SourceRecord):
                    continue
                payload = snapshot.model_copy(
                    update={
                        "source": source,
                        "source_ids": sorted(set(snapshot.source_ids + [source.id])),
                    }
                )
                rows.append(payload)
            return rows
        except (OSError, RuntimeError, TypeError, ValueError) as exc:
            logger.warning("ignoring screening snapshot cache: {}", exc)
            return []

    def _screening_snapshot_fallback(
        self,
        *,
        fallback_reason: str,
    ) -> MarketSnapshotCapture | None:
        rows = self._read_screening_snapshot_cache()
        if not rows:
            return None
        capture = MarketSnapshotCapture(
            rows,
            expected_count=None,
            page_size=len(rows),
            complete=False,
            error="screening_snapshot_cache",
            requested_limit=5000,
        )
        observation_date = self._snapshot_rows_observation_date(rows)
        capture.cache_info = self._snapshot_cache_info(
            "fallback",
            observation_date,
            rows,
            freshness="screening_cache",
            fallback_reason=fallback_reason,
        )
        return capture

    def _save_screening_snapshot_cache(
        self,
        rows: list[Any],
        *,
        observation_date: str | None,
    ) -> None:
        if not rows or observation_date is None:
            return
        try:
            from mona.services.stock.screening import ScreeningStore

            ScreeningStore(self.cache_root.parent).save_snapshots(rows, observation_date)
        except (OSError, RuntimeError, TypeError, ValueError) as exc:
            logger.warning("screening snapshot cache write failed: {}", exc)

    async def _fetch_market_snapshot(
        self,
        *,
        target_date: str | None = None,
    ) -> MarketSnapshotCapture:
        """Capture or reuse one complete full-market observation day.

        Market breadth and industry relative strength are optional evidence.
        A provider without this capability, or an upstream timeout, therefore
        returns an empty capture and lets the deterministic sections report
        ``missing`` rather than failing the whole bundle.  Partial/error
        captures may use only an exact same-day complete cache entry.
        """
        requested_date = target_date
        cached = self._read_market_snapshot_cache(requested_date)
        if cached is not None:
            return cached

        method = getattr(self.provider, "market_snapshot", None)
        if method is None:
            fallback = self._screening_snapshot_fallback(
                fallback_reason="provider_missing_screening_cache"
            )
            if fallback is not None:
                return fallback
            fallback = self._read_latest_prior_market_snapshot_cache(requested_date)
            if fallback is not None:
                return self._mark_stale_market_snapshot(
                    fallback,
                    fallback_reason="provider_missing_prior_cache",
                )
            capture = MarketSnapshotCapture(
                [], expected_count=None, page_size=0, complete=False,
                error="provider_missing_market_snapshot",
                requested_limit=5000,
            )
            capture.cache_info = self._snapshot_cache_info(
                "miss", requested_date, [], freshness="unavailable"
            )
            return capture
        try:
            rows = await method(limit=5000)
        except MarketSnapshotIncompleteError as exc:
            logger.warning("market snapshot incomplete: {}", exc)
            partial = MarketSnapshotCapture(
                exc.rows,
                expected_count=exc.expected_count,
                page_size=exc.page_size,
                complete=False,
                error=str(exc),
                requested_limit=exc.requested_limit,
            )
            fallback_date = requested_date or self._snapshot_rows_observation_date(list(partial))
            fallback = self._read_market_snapshot_cache(fallback_date)
            if fallback is not None:
                fallback.cache_info = self._snapshot_cache_info(
                    "fallback",
                    fallback_date,
                    list(fallback),
                    freshness="same_trading_day",
                    fallback_reason="provider_partial",
                )
                return fallback
            fallback = self._read_latest_prior_market_snapshot_cache(requested_date)
            if fallback is not None:
                return self._mark_stale_market_snapshot(
                    fallback,
                    fallback_reason="provider_partial_prior_cache",
                )
            fallback = self._screening_snapshot_fallback(
                fallback_reason="provider_partial_screening_cache"
            )
            if fallback is not None:
                return fallback
            partial.cache_info = self._snapshot_cache_info(
                "miss",
                fallback_date,
                list(partial),
                freshness="unavailable",
                fallback_reason="provider_partial_no_same_day_cache",
            )
            return partial
        except Exception as exc:  # provider failures are evidence gaps
            logger.warning("market snapshot unavailable: {}", exc)
            fallback = self._read_market_snapshot_cache(requested_date)
            if fallback is not None:
                fallback.cache_info = self._snapshot_cache_info(
                    "fallback",
                    requested_date,
                    list(fallback),
                    freshness="same_trading_day",
                    fallback_reason="provider_failure",
                )
                return fallback
            fallback = self._read_latest_prior_market_snapshot_cache(requested_date)
            if fallback is not None:
                return self._mark_stale_market_snapshot(
                    fallback,
                    fallback_reason="provider_failure_prior_cache",
                )
            fallback = self._screening_snapshot_fallback(
                fallback_reason="provider_failure_screening_cache"
            )
            if fallback is not None:
                return fallback
            capture = MarketSnapshotCapture(
                [], expected_count=None, page_size=0, complete=False,
                error=str(exc),
                requested_limit=5000,
            )
            capture.cache_info = self._snapshot_cache_info(
                "miss",
                requested_date,
                [],
                freshness="unavailable",
                fallback_reason="provider_failure_no_same_day_cache",
            )
            return capture
        if isinstance(rows, MarketSnapshotCapture):
            if not rows.complete:
                fallback_date = requested_date or self._snapshot_rows_observation_date(list(rows))
                fallback = self._read_market_snapshot_cache(fallback_date)
                if fallback is not None:
                    fallback.cache_info = self._snapshot_cache_info(
                        "fallback",
                        fallback_date,
                        list(fallback),
                        freshness="same_trading_day",
                        fallback_reason="provider_partial",
                    )
                    return fallback
                fallback = self._read_latest_prior_market_snapshot_cache(requested_date)
                if fallback is not None:
                    return self._mark_stale_market_snapshot(
                        fallback,
                        fallback_reason="provider_partial_prior_cache",
                    )
                fallback = self._screening_snapshot_fallback(
                    fallback_reason="provider_partial_screening_cache"
                )
                if fallback is not None:
                    return fallback
                rows.cache_info = self._snapshot_cache_info(
                    "miss",
                    fallback_date,
                    list(rows),
                    freshness="unavailable",
                    fallback_reason="provider_partial_no_same_day_cache",
                )
                return rows
            cache_date = self._write_market_snapshot_cache(rows)
            observation_date = cache_date or self._snapshot_rows_observation_date(list(rows))
            self._save_screening_snapshot_cache(
                list(rows), observation_date=observation_date
            )
            rows.cache_info = self._snapshot_cache_info(
                "live",
                observation_date,
                list(rows),
                freshness=(
                    "same_trading_day"
                    if observation_date == requested_date
                    else "observed_trading_day"
                ),
                cache_written=cache_date is not None,
            )
            return rows
        if isinstance(rows, (list, tuple)):
            # Test/different providers without coverage metadata are not
            # allowed to claim full-market completeness from an arbitrary
            # list; keep the legacy in-memory shape, but do not persist it as
            # a durable full-market cache.
            capture = MarketSnapshotCapture(
                list(rows),
                expected_count=len(rows),
                page_size=len(rows),
                complete=True,
                requested_limit=len(rows),
            )
            observation_date = self._snapshot_rows_observation_date(list(capture))
            capture.cache_info = self._snapshot_cache_info(
                "live",
                observation_date,
                list(capture),
                freshness=(
                    "same_trading_day"
                    if observation_date == requested_date
                    else "observed_trading_day"
                ),
                cache_written=False,
                cache_write_reason="capture_metadata_unavailable",
            )
            return capture
        capture = MarketSnapshotCapture(
            [], expected_count=None, page_size=0, complete=False,
            error="provider_returned_non_list_market_snapshot",
            requested_limit=5000,
        )
        capture.cache_info = self._snapshot_cache_info(
            "miss", requested_date, [], freshness="unavailable"
        )
        return capture

    async def _build_one(
        self,
        inst: InstrumentRef,
        *,
        as_of: str | None,
        research_cutoff_at: str | None,
        _legacy_as_of: str | None,
        _market_snapshot: list[Any] | None,
        _market_snapshot_loaded: bool,
        _benchmark_series: Any | None,
        name: str,
        sections: set[str] | None = None,
        material_binding_ids: list[str] | None = None,
    ) -> dict:
        if as_of is not None and research_cutoff_at is not None:
            as_of_time = normalize_asia_datetime(as_of)
            cutoff_time = normalize_asia_datetime(research_cutoff_at)
            if as_of_time is None or cutoff_time is None or as_of_time != cutoff_time:
                raise ValueError("as_of and research_cutoff_at must identify the same time")
        if research_cutoff_at is not None:
            research_cutoff = normalize_asia_datetime(research_cutoff_at)
            if research_cutoff is None:
                raise ValueError(f"invalid research_cutoff_at {research_cutoff_at!r}")
            cutoff_time = parse_asia_datetime(research_cutoff)
            if cutoff_time is None:  # normalize_asia_datetime already guards this
                raise ValueError(f"invalid research_cutoff_at {research_cutoff_at!r}")
            legacy_as_of = (
                as_of
                or _legacy_as_of
                or await self._resolve_as_of_at(cutoff_time)
            )
            historical_replay = True
        elif as_of is not None:
            research_cutoff = normalize_asia_datetime(as_of)
            if research_cutoff is None:
                raise ValueError(f"invalid as_of {as_of!r}")
            legacy_as_of = as_of
            # ``as_of`` is the V1 compatibility input. Keep its old behavior;
            # callers opting into the V2 cutoff get strict replay.
            historical_replay = False
        else:
            research_cutoff = normalize_asia_datetime(self._clock())
            if research_cutoff is None:
                raise ValueError("clock returned an unknown research cutoff")
            legacy_as_of = _legacy_as_of or await self.resolve_as_of()
            historical_replay = False
            realtime_collection = True
        if research_cutoff_at is not None or as_of is not None:
            realtime_collection = False
        requested = sections or {"quote", "kline", "fundamentals", "news"}
        unknown = requested - {"quote", "kline", "fundamentals", "news"}
        if unknown:
            raise ValueError(f"unknown evidence sections: {sorted(unknown)}")
        effective_market_snapshot_date = self._effective_market_snapshot_date(
            as_of=as_of,
            research_cutoff_at=(research_cutoff if realtime_collection else research_cutoff_at),
            legacy_as_of=legacy_as_of,
        )
        market_capture = (
            _market_snapshot
            if isinstance(_market_snapshot, MarketSnapshotCapture)
            else MarketSnapshotCapture(
                list(_market_snapshot or []),
                expected_count=(len(_market_snapshot or []) if _market_snapshot_loaded else None),
                page_size=(len(_market_snapshot or []) if _market_snapshot_loaded else 0),
                complete=bool(_market_snapshot_loaded),
                requested_limit=(len(_market_snapshot or []) if _market_snapshot_loaded else None),
            )
            if _market_snapshot_loaded
            else await self._fetch_market_snapshot(
                target_date=effective_market_snapshot_date
            )
        )
        market_snapshot = list(market_capture)
        instrument_profile = await self._fetch_instrument_profile(inst)
        industry_valuation = await self._fetch_industry_valuation(inst)
        if instrument_profile is not None:
            # Keep the profile in the same deterministic row path so the
            # industry classification carries its own source and timestamp;
            # it contributes no market breadth values.
            market_snapshot.append(instrument_profile)
        missing: list[str] = []
        omitted = [kind for kind in ("quote", "kline", "fundamentals", "news") if kind not in requested]
        data_quality = {
            "missing": missing,
            "omitted": omitted,
            "excluded_future": [],
            "unknown_availability": [],
            "excluded_irrelevant_policy_documents": [],
        }
        sources: dict[str, dict] = {}

        quote = await self._section("quote", missing, inst) if "quote" in requested else None
        series = await self._section("kline", missing, inst) if "kline" in requested else None
        fundamentals_history = []
        fundamentals = None
        if inst.instrument_type != "etf" and "fundamentals" in requested:
            history_method = getattr(self.provider, "fundamentals_history", None)
            if history_method is not None:
                try:
                    fundamentals_history = list(await history_method(inst, limit=12))
                except Exception as exc:
                    logger.warning(
                        "stock evidence fundamentals history unavailable for {}: {}",
                        inst.id,
                        exc,
                    )
            if fundamentals_history:
                fundamentals = fundamentals_history[0]
            else:
                fundamentals = await self._section("fundamentals", missing, inst)
                if fundamentals is not None:
                    fundamentals_history = [fundamentals]
        news = await self._section("news", missing, inst) if "news" in requested else None
        # A live capture may take long enough for a quote to be stamped after
        # the initial clock read. Freeze the evidence only after all primary
        # sections have been fetched; explicit historical cutoffs stay strict.
        if realtime_collection:
            research_cutoff = normalize_asia_datetime(self._clock())
            if research_cutoff is None:
                raise ValueError("clock returned an unknown research cutoff")
        structured_events: list[dict[str, Any]] = []
        structured_event_coverage: dict[str, Any] = {"status": "not_requested", "source": "structured_market_events"}
        if "news" in requested:
            structured_events, structured_event_coverage = await self._structured_events(
                inst,
                research_cutoff,
                data_quality=data_quality,
            )

        market_observation_times: list[datetime] = []

        def keep(source, *, published_at: str | None = None) -> None:
            # artifact JSON keeps snake_case keys per design §7.3
            record = source.model_dump()
            if published_at is not None:
                record["published_at"] = published_at
            sources.setdefault(source.id, record)

        def mark_missing(section: str) -> None:
            if section not in missing:
                missing.append(section)

        def excluded_future(section: str, field: str, value: Any) -> None:
            data_quality["excluded_future"].append(
                {
                    "section": section,
                    "field": field,
                    "value": value,
                    "reason": "after_research_cutoff",
                }
            )

        def unknown_availability(section: str, field: str, value: Any) -> None:
            data_quality["unknown_availability"].append(
                {
                    "section": section,
                    "field": field,
                    "value": value,
                    "reason": "unparseable_or_missing_public_time",
                }
            )

        westock_supplements: dict[str, dict[str, Any]] = {}
        if self.supplement_provider is not None:
            westock_supplements = await self._fetch_westock_supplements(
                inst,
                research_cutoff=research_cutoff,
                keep_source=keep,
                data_quality=data_quality,
            )
            # WeStock is a supplement, but a missing primary fundamentals
            # section may safely use its validated finance rows as a fallback.
            # An existing provider result is never overwritten.
            if (
                inst.instrument_type != "etf"
                and "fundamentals" in requested
                and not fundamentals_history
                and westock_supplements.get("asfund", {}).get("status") == "available"
            ):
                fundamentals_history = self._westock_fundamental_rows(
                    westock_supplements["asfund"], inst
                )
                if fundamentals_history:
                    data_quality.setdefault("fallbacks", []).append(
                        {"section": "fundamentals", "provider": "westock", "reason": "primary_unavailable"}
                    )

        bundle: dict[str, Any] = {
            "instrument": {
                "symbol": inst.symbol,
                "exchange": inst.exchange,
                "instrument_type": inst.instrument_type,
                "name": name or (quote.name if quote else ""),
            },
            "as_of": legacy_as_of,
            "research_cutoff_at": research_cutoff,
            "market_as_of": None,
            "quote": None,
            "indicators": None,
            "fundamentals": None,
            "fundamentals_history": [],
            "valuation": None,
            "policy_documents": [],
            "macro_policy_documents": [],
            "macro_documents": [],
            "news": [],
            "event_capture": structured_event_coverage,
            "_structured_events": structured_events,
            "_structured_event_coverage": structured_event_coverage,
            **(
                {"westock_supplements": westock_supplements}
                if self.supplement_provider is not None
                else {}
            ),
            "kline_ref": None,
            "relative_benchmarks": None,
            "derived_decision_metrics": None,
            "decision_readiness": None,
            "sources": [],
            "data_quality": data_quality,
        }

        if quote is not None:
            quote_time = quote.as_of or quote.source.published_at
            quote_relation = compare_asia_datetime(quote_time, research_cutoff)
            if quote_relation is False:
                excluded_future("quote", "as_of", quote_time)
                mark_missing("quote")
                quote = None
            elif quote_relation is None:
                unknown_availability("quote", "as_of", quote_time)
                mark_missing("quote")
                quote = None

        if quote is not None:
            normalized_quote_time = normalize_asia_datetime(
                quote.as_of or quote.source.published_at
            )
            keep(quote.source, published_at=normalized_quote_time)
            bundle["quote"] = {
                "price": quote.price,
                "change_pct": quote.change_pct,
                "volume": quote.volume,
                "amount": quote.amount,
                "previous_close": quote.previous_close,
                "turnover_rate": quote.turnover_rate,
                "limit_up": quote.limit_up,
                "limit_down": quote.limit_down,
                "pe": quote.pe,
                "pb": quote.pb,
                "market_cap": quote.market_cap,
                "as_of": quote.as_of,
                "source_ids": [quote.source.id],
            }
            bundle["instrument"]["name"] = bundle["instrument"]["name"] or quote.name
            if normalized_quote_time is not None:
                market_observation_times.append(parse_asia_datetime(normalized_quote_time))

        completed_target_bars = []
        if series is not None and series.bars:
            completed_bars = []
            for bar in series.bars:
                parsed_bar = parse_asia_datetime(bar.date)
                if parsed_bar is not None and len(bar.date.strip()) <= 10:
                    parsed_bar = parsed_bar.replace(
                        hour=CLOSE_TIME.hour,
                        minute=CLOSE_TIME.minute,
                        second=0,
                        microsecond=0,
                    )
                relation = compare_asia_datetime(
                    parsed_bar,
                    research_cutoff,
                )
                if relation is True:
                    completed_bars.append(bar)
                elif relation is False:
                    excluded_future("kline", "date", bar.date)
                else:
                    unknown_availability("kline", "date", bar.date)
            completed_target_bars = completed_bars
            if completed_bars:
                completed_series = series.model_copy(update={"bars": completed_bars})
                last_bar_time = parse_asia_datetime(completed_bars[-1].date)
                if last_bar_time is not None and len(completed_bars[-1].date.strip()) <= 10:
                    last_bar_time = last_bar_time.replace(
                        hour=CLOSE_TIME.hour,
                        minute=CLOSE_TIME.minute,
                        second=0,
                        microsecond=0,
                    )
                keep(
                    series.source,
                    published_at=last_bar_time.isoformat() if last_bar_time else None,
                )
                bundle["indicators"] = self._indicator_summary(completed_bars)
                bundle["kline_ref"] = self._cache_kline(inst, completed_series)
                source_ids = [series.source.id]
                if quote is not None:
                    source_ids.append(quote.source.id)
                bundle["derived_decision_metrics"] = _derived_decision_metrics(
                    completed_bars,
                    quote,
                    source_ids=source_ids,
                    research_cutoff=research_cutoff,
                ) if quote is not None else None
                if last_bar_time is not None:
                    market_observation_times.append(last_bar_time)
            else:
                mark_missing("kline")
        elif series is not None:
            mark_missing("kline")

        eligible_fundamentals = []
        for item in fundamentals_history:
            public_time = item.source.published_at
            relation = compare_asia_datetime(public_time, research_cutoff)
            if relation is False:
                excluded_future("fundamentals", "published_at", public_time)
                continue
            if relation is None:
                unknown_availability("fundamentals", "published_at", public_time)
                if historical_replay:
                    continue
            keep(item.source, published_at=normalize_asia_datetime(public_time))
            eligible_fundamentals.append(item)
        fundamentals = eligible_fundamentals[0] if eligible_fundamentals else None
        if fundamentals is not None:
            bundle["fundamentals"] = {
                "report_period": fundamentals.report_period,
                "period_end": fundamentals.source.period_end or fundamentals.report_period,
                "published_at": normalize_asia_datetime(fundamentals.source.published_at),
                "availability_status": (
                    "known" if fundamentals.source.published_at else "unknown"
                ),
                "metrics": fundamentals.metrics,
                "source_ids": [fundamentals.source.id],
            }
            bundle["fundamentals_history"] = [
                {
                    "report_period": item.report_period,
                    "period_end": item.source.period_end or item.report_period,
                    "published_at": normalize_asia_datetime(item.source.published_at),
                    "availability_status": "known" if item.source.published_at else "unknown",
                    "metrics": item.metrics,
                    "source_ids": [item.source.id],
                }
                for item in eligible_fundamentals
            ]
        elif "fundamentals" in requested and inst.instrument_type != "etf":
            mark_missing("fundamentals")

        if news:
            trimmed = []
            for item in news:
                relation = compare_asia_datetime(item.published_at, research_cutoff)
                if relation is False:
                    excluded_future("news", "published_at", item.published_at)
                    continue
                if relation is None:
                    unknown_availability("news", "published_at", item.published_at)
                    continue
                keep(item.source, published_at=normalize_asia_datetime(item.published_at))
                trimmed.append(
                    {
                        "title": item.title,
                        "url": item.url,
                        "published_at": item.published_at,
                        "summary": item.summary[: self.news_summary_chars],
                        "source_ids": [item.source.id],
                    }
                )
                if len(trimmed) >= self.news_limit:
                    break
            bundle["news"] = trimmed
            if not trimmed:
                mark_missing("news")

        target_industry = None
        for row in market_snapshot:
            if self._snapshot_value(row, "instrument_id") != inst.id:
                continue
            observed_at = self._snapshot_value(row, "observed_at") or self._snapshot_value(row, "as_of")
            if compare_asia_datetime(observed_at, research_cutoff) is True:
                target_industry = self._snapshot_value(row, "industry")
                break
        if self.research_provider is not None:
            requests = []
            if target_industry:
                requests.append(("policy_documents", self.research_provider.search_documents(str(target_industry), limit=5)))
            macro_policy_method = getattr(
                self.research_provider, "search_policy_documents", None
            )
            if macro_policy_method is not None:
                requests.append(
                    ("macro_policy_documents", macro_policy_method(limit=5))
                )
            else:
                async def _fallback_macro_policy_documents():
                    documents = []
                    for keyword in ("货币政策", "资本市场监管"):
                        documents.extend(
                            await self.research_provider.search_documents(
                                keyword, limit=5, include_explainers=False
                            )
                        )
                    seen = set()
                    return [
                        item
                        for item in documents
                        if not (item.source.id in seen or seen.add(item.source.id))
                    ][:5]

                requests.append(
                    ("macro_policy_documents", _fallback_macro_policy_documents())
                )
            requests.append(("macro_documents", self.research_provider.search_documents("M2", limit=5, include_explainers=True)))
            results = await asyncio.gather(
                *(request for _, request in requests), return_exceptions=True
            )
            for (section, _), result in zip(requests, results):
                if isinstance(result, Exception):
                    logger.warning("stock evidence {} unavailable for {}: {}", section, inst.id, result)
                    continue
                documents = []
                for item in result:
                    if section == "macro_policy_documents" and not _is_relevant_macro_policy_document(item):
                        data_quality["excluded_irrelevant_policy_documents"].append(
                            {
                                "section": section,
                                "title": _research_document_field(item, "title"),
                                "source_id": _research_document_field(
                                    _research_document_field(item, "source"), "id"
                                ),
                                "reason": "no_substantive_macro_or_market_regulation_signal",
                            }
                        )
                        continue
                    if section == "policy_documents" and not _is_relevant_industry_policy_document(
                        item, target_industry
                    ):
                        data_quality["excluded_irrelevant_policy_documents"].append(
                            {
                                "section": section,
                                "title": _research_document_field(item, "title"),
                                "source_id": _research_document_field(
                                    _research_document_field(item, "source"), "id"
                                ),
                                "reason": "industry_mapping_not_confirmed",
                                "target_industry": target_industry,
                            }
                        )
                        continue
                    relation = compare_asia_datetime(item.published_at, research_cutoff)
                    if relation is False:
                        excluded_future(section, "published_at", item.published_at)
                        continue
                    if relation is None:
                        unknown_availability(section, "published_at", item.published_at)
                        continue
                    keep(item.source, published_at=normalize_asia_datetime(item.published_at))
                    documents.append(
                        {
                            "title": item.title,
                            "url": item.url,
                            "published_at": normalize_asia_datetime(item.published_at),
                            "issuer": item.issuer,
                            "document_id": item.document_id,
                            "category": item.category,
                            "source_role": item.source_role,
                            "period_end": item.period_end or item.source.period_end,
                            "effective_from": getattr(item, "effective_from", None),
                            "effective_to": getattr(item, "effective_to", None),
                            "summary": item.summary[: self.news_summary_chars],
                            "source_ids": [item.source.id],
                        }
                    )
                bundle[section] = documents

        if westock_supplements:
            self._merge_westock_supplements(bundle, westock_supplements)

        if market_observation_times:
            bundle["market_as_of"] = max(market_observation_times).isoformat()

        bundle["relative_benchmarks"] = self._build_relative_benchmarks(
            inst=inst,
            target_bars=completed_target_bars,
            target_source=series.source if completed_target_bars and series is not None else None,
            benchmark_series=_benchmark_series,
            research_cutoff=research_cutoff,
            keep_source=keep,
            data_quality=data_quality,
        )

        # Coverage metadata needs the same source list as the final bundle;
        # populate it before deterministic sections are assembled.
        bundle["sources"] = list(sources.values())
        v2_sections = self._build_v2_sections(
                inst=inst,
                bundle=bundle,
            market_snapshot=market_snapshot,
            market_capture=market_capture,
            instrument_profile=instrument_profile,
            industry_valuation=industry_valuation,
            research_cutoff=research_cutoff,
                sources=sources,
                keep_source=keep,
                data_quality=data_quality,
        )
        public_opinion_snapshot = load_local_public_opinion_snapshot(
            self.cache_root / "public_opinion" / "latest.json"
        )
        if isinstance(public_opinion_snapshot, dict):
            local_source = public_opinion_snapshot.get("source") or public_opinion_snapshot.get(
                "source_record"
            )
            if isinstance(local_source, dict) and local_source.get("id") and all(
                local_source.get(field)
                for field in ("provider", "url", "fetched_at", "content_hash", "fields")
            ):
                sources.setdefault(str(local_source["id"]), dict(local_source))
        known_source_ids = set(sources)
        market_sentiment = build_market_sentiment(
            market_regime=v2_sections.get("market_regime"),
            relative_benchmarks=bundle.get("relative_benchmarks"),
            research_cutoff_at=research_cutoff,
            known_source_ids=known_source_ids,
        )
        data_quality["excluded_future"].extend(market_sentiment.get("excluded_future") or [])
        public_opinion = build_public_opinion_state(
            snapshot=public_opinion_snapshot,
            research_cutoff_at=research_cutoff,
            known_source_ids=known_source_ids,
        )
        if public_opinion.get("excluded_future"):
            data_quality["excluded_future"].extend(public_opinion["excluded_future"])
        v2_sections["market_sentiment"] = market_sentiment
        v2_sections["public_opinion"] = public_opinion
        v2_sections["evidence_coverage"] = self._coverage(
            bundle,
            {
                name: section
                for name, section in v2_sections.items()
                if name != "evidence_coverage"
            },
        )
        bundle.update(v2_sections)
        derived_sections = {
            name: section
            for name, section in v2_sections.items()
            if name != "evidence_coverage" and isinstance(section, dict)
        }
        optional_derived = {"public_opinion"}
        derived_missing = sorted(
            name
            for name, section in derived_sections.items()
            if name not in optional_derived and section.get("status") == "missing"
        )
        derived_degraded = sorted(
            name
            for name, section in derived_sections.items()
            if name not in optional_derived and section.get("status") == "degraded"
        )
        data_quality["optional_derived_missing"] = [
            name
            for name in optional_derived
            if (derived_sections.get(name) or {}).get("status") != "available"
        ]
        data_quality["derived_missing"] = derived_missing
        data_quality["derived_degraded"] = derived_degraded
        data_quality["missing"] = sorted(set(missing) | set(derived_missing))
        data_quality["status"] = (
            "degraded"
            if data_quality["missing"] or derived_degraded
            else "complete"
        )
        # Structured events are consumed by the deterministic V2 calendar;
        # keep only the coverage metadata in the public bundle.
        bundle.pop("_structured_events", None)
        bundle.pop("_structured_event_coverage", None)
        snapshot_observed = (v2_sections.get("market_regime") or {}).get("observed_at")
        snapshot_time = parse_asia_datetime(snapshot_observed)
        current_market_time = parse_asia_datetime(bundle.get("market_as_of"))
        if snapshot_time is not None and (current_market_time is None or snapshot_time > current_market_time):
            bundle["market_as_of"] = snapshot_time.isoformat()
        bundle["sources"] = list(sources.values())
        if material_binding_ids:
            bundle = self._attach_materials(
                bundle,
                inst.id,
                material_binding_ids,
                research_cutoff_at=research_cutoff,
            )
        bundle["fundamental_factors"] = build_fundamental_factors(
            bundle,
            research_cutoff_at=research_cutoff,
        )
        bundle["valuation"] = build_valuation_result(bundle)
        bundle["decision_readiness"] = self._decision_readiness(bundle)
        if isinstance(bundle["decision_readiness"].get("research_ready"), dict):
            try:
                deterministic_plan = build_v6_derived_decision_metrics(
                    bundle,
                    generated_at=research_cutoff,
                )
            except (TypeError, ValueError, KeyError) as exc:
                logger.warning(
                    "stock V5 decision plan derivation failed for {}: {}",
                    inst.id,
                    exc,
                )
                readiness = bundle["decision_readiness"]
                readiness["status"] = "failed"
                readiness["failure_reasons"] = list(
                    dict.fromkeys(
                        [
                            *(readiness.get("failure_reasons") or []),
                            "decision_plan_derivation_failed",
                        ]
                    )
                )
                trade_ready = readiness.get("trade_ready")
                if isinstance(trade_ready, dict):
                    trade_ready["status"] = "failed"
                    trade_ready["failure_reasons"] = list(
                        dict.fromkeys(
                            [
                                *(trade_ready.get("failure_reasons") or []),
                                "decision_plan_derivation_failed",
                            ]
                        )
                    )
                for horizon in readiness.get("horizons", {}).values():
                    if not isinstance(horizon, dict):
                        continue
                    horizon["status"] = "failed"
                    horizon["missing"] = list(
                        dict.fromkeys([*(horizon.get("missing") or []), "trading_plan"])
                    )
                    horizon["failure_reasons"] = list(
                        dict.fromkeys(
                            [
                                *(horizon.get("failure_reasons") or []),
                                "decision_plan_derivation_failed",
                            ]
                        )
                    )
                # Do not leave a partial deterministic plan in Evidence.
                raw_metrics = bundle.get("derived_decision_metrics")
                if isinstance(raw_metrics, dict):
                    raw_metrics.pop("generated_at", None)
                    raw_metrics.pop("method_versions", None)
                    raw_metrics.pop("horizons", None)
                    raw_metrics.pop("eligible_horizons", None)
                    raw_metrics.pop("generated_horizons", None)
                    raw_metrics["eligible_horizons"] = []
                    raw_metrics["generated_horizons"] = []
            else:
                raw_metrics = bundle.get("derived_decision_metrics")
                if not isinstance(deterministic_plan, dict):
                    raise ValueError("V6 decision plan derivation returned an invalid object")
                if set(deterministic_plan.get("horizons") or {}) != {
                    *deterministic_plan.get("eligible_horizons", [])
                }:
                    raise ValueError("V6 decision plan derivation did not match eligible horizons")
                # Keep the auditable technical inputs alongside the full V5
                # plan so later validation can replay both layers.
                if not isinstance(raw_metrics, dict):
                    raw_metrics = {}
                    bundle["derived_decision_metrics"] = raw_metrics
                raw_metrics.update(deterministic_plan)
        return bundle

    @staticmethod
    def _decision_readiness(bundle: dict[str, Any]) -> dict[str, Any]:
        """Separate research availability from executable trade readiness."""
        quote = bundle.get("quote")
        kline_ref = bundle.get("kline_ref")
        derived = bundle.get("derived_decision_metrics")
        short_missing: list[str] = []
        short_failure_reasons: list[str] = []
        if not isinstance(quote, dict) or _finite_number(quote.get("price")) is None or _finite_number(quote.get("price")) <= 0:
            short_missing.append("quote")
            short_failure_reasons.append("quote_unavailable")
        try:
            kline_bars = int(kline_ref.get("bars") or 0) if isinstance(kline_ref, dict) else 0
        except (TypeError, ValueError):
            kline_bars = 0
        if kline_bars < MIN_DECISION_KLINE_BARS:
            short_missing.append("kline")
            short_failure_reasons.append("kline_history_under_60_bars")
        technical_ready = isinstance(derived, dict) and all(
            isinstance(derived.get(name), dict)
            for name in ("atr20", "trend", "volatility", "swing", "stop_distance")
        )
        if not technical_ready:
            short_missing.append("technical_indicators")
            short_failure_reasons.append("derived_indicators_unavailable")

        fundamentals = bundle.get("fundamentals")
        fundamentals_metrics = fundamentals.get("metrics") if isinstance(fundamentals, dict) else None
        fundamentals_ready = bool(
            isinstance(fundamentals, dict)
            and isinstance(fundamentals.get("report_period"), str)
            and fundamentals.get("report_period")
            and isinstance(fundamentals.get("published_at"), str)
            and parse_asia_datetime(fundamentals.get("published_at")) is not None
            and isinstance(fundamentals.get("source_ids"), list)
            and bool(fundamentals.get("source_ids"))
            and isinstance(fundamentals_metrics, dict)
            and any(_finite_number(value) is not None for value in fundamentals_metrics.values())
        )
        company_quality = bundle.get("company_quality")
        company_quality_ready = bool(
            fundamentals_ready
            and isinstance(company_quality, dict)
            and isinstance(company_quality.get("source_ids"), list)
            and bool(company_quality.get("source_ids"))
        )
        fundamentals_history = bundle.get("fundamentals_history") or []
        multi_period_ready = bool(
            fundamentals_ready
            and isinstance(fundamentals_history, list)
            and len(
                {
                    item.get("report_period")
                    for item in fundamentals_history
                    if isinstance(item, dict) and item.get("report_period")
                }
            ) >= 4
        )
        cashflow_rows = (company_quality or {}).get("cashflow_quality") if isinstance(company_quality, dict) else None
        cashflow_ready = bool(
            isinstance(cashflow_rows, list)
            and len(
                [
                    item
                    for item in cashflow_rows
                    if isinstance(item, dict)
                    and _finite_number(item.get("operating_cashflow")) is not None
                    and _finite_number(item.get("net_profit")) is not None
                    and item.get("source_ids")
                ]
            ) >= 2
        )
        valuation = bundle.get("valuation")
        valuation_ready = bool(
            isinstance(valuation, dict)
            and valuation.get("trade_ready") is True
            and int(valuation.get("usable_method_count") or 0) >= 2
            and isinstance(valuation.get("cross_range"), dict)
            and valuation["cross_range"].get("status") == "available"
            and int(valuation["cross_range"].get("method_count") or 0) >= 2
        )

        industry_context = bundle.get("industry_context")
        industry = (
            str(industry_context.get("target_industry") or "")
            if isinstance(industry_context, dict)
            else ""
        )
        industry_ready = isinstance(industry_context, dict) and industry_context.get("status") == "available"
        policy_context = bundle.get("policy_context")
        policy_ready = isinstance(policy_context, dict) and policy_context.get("status") == "available"
        cycles = (bundle.get("cycle_context") or {}).get("cycles") if isinstance(bundle.get("cycle_context"), dict) else None
        cycles = cycles if isinstance(cycles, dict) else {}
        industry_cycle = cycles.get("industry_supply_demand")
        earnings_cycle = cycles.get("company_earnings")
        industry_cycle_ready = isinstance(industry_cycle, dict) and industry_cycle.get("status") == "available"
        earnings_cycle_ready = isinstance(earnings_cycle, dict) and earnings_cycle.get("status") == "available"
        medium_cycle_ready = industry_cycle_ready and earnings_cycle_ready

        medium_missing = list(short_missing)
        medium_reasons = list(short_failure_reasons)
        if not fundamentals_ready:
            medium_missing.append("fundamentals")
            medium_reasons.append("medium_fundamentals_missing")
        if not industry_ready:
            medium_missing.append("industry_context")
            medium_reasons.append("medium_industry_context_missing")
        if not medium_cycle_ready:
            medium_missing.append("cycle_context")
            medium_reasons.append("medium_cycle_context_missing")
        if is_policy_sensitive_industry(industry) and not policy_ready:
            medium_missing.append("policy_context")
            medium_reasons.append("medium_policy_context_missing")
        long_missing = list(medium_missing)
        long_reasons = list(medium_reasons)
        if not multi_period_ready:
            long_missing.append("multi_period_financials")
            long_reasons.append("long_multi_period_financials_missing")
        if not company_quality_ready:
            long_missing.append("company_quality")
            long_reasons.append("long_company_quality_missing")
        if not cashflow_ready:
            long_missing.append("cashflow_quality")
            long_reasons.append("long_cashflow_quality_missing")
        if not valuation_ready:
            long_missing.append("valuation_basis")
            long_reasons.append("long_valuation_basis_missing")

        def horizon(
            required: list[str], missing: list[str], reasons: list[str]
        ) -> dict[str, Any]:
            status = "ready" if not missing else "failed"
            return {
                "status": status,
                "required": required,
                "available": [item for item in required if item not in missing],
                "missing": list(dict.fromkeys(missing)),
                "failure_reasons": list(dict.fromkeys(reasons)),
            }

        horizons = {
            "short_term": horizon(
                ["quote", "kline", "technical_indicators"],
                short_missing,
                short_failure_reasons,
            ),
            "medium_term": horizon(
                [
                    "quote",
                    "kline",
                    "technical_indicators",
                    "fundamentals",
                    "industry_context",
                    "cycle_context",
                    *(["policy_context"] if is_policy_sensitive_industry(industry) else []),
                ],
                medium_missing,
                medium_reasons,
            ),
            "long_term": horizon(
                [
                    "quote",
                    "kline",
                    "technical_indicators",
                    "fundamentals",
                    "company_quality",
                    "multi_period_financials",
                    "cashflow_quality",
                    "valuation_basis",
                ],
                long_missing,
                long_reasons,
            ),
        }
        core_status = horizons["short_term"]["status"]
        trade_failure_reasons = list(
            dict.fromkeys(
                reason
                for item in horizons.values()
                for reason in item.get("failure_reasons") or []
            )
        )
        research_medium_missing: list[str] = []
        research_medium_reasons: list[str] = []
        if not fundamentals_ready:
            research_medium_missing.append("fundamentals")
            research_medium_reasons.append("research_medium_fundamentals_missing")
        industry_research_ready = bool(
            isinstance(industry_context, dict)
            and industry_context.get("target_industry")
            and industry_context.get("source_ids")
        )
        if not industry_research_ready:
            research_medium_missing.append("industry_context")
            research_medium_reasons.append("research_medium_industry_input_missing")
        cycle_research_ready = bool(
            isinstance(bundle.get("cycle_context"), dict)
            and cycles
            and any(
                isinstance(item, dict) and item.get("source_ids")
                for item in cycles.values()
            )
        )
        if not cycle_research_ready:
            research_medium_missing.append("cycle_context")
            research_medium_reasons.append("research_medium_cycle_input_missing")
        research_long_missing: list[str] = []
        research_long_reasons: list[str] = []
        if not fundamentals_ready:
            research_long_missing.append("fundamentals")
            research_long_reasons.append("research_long_fundamentals_missing")
        if not company_quality_ready:
            research_long_missing.append("company_quality")
            research_long_reasons.append("research_long_company_quality_missing")

        research_horizons = {
            "short_term": horizon(
                ["quote", "kline", "technical_indicators"],
                short_missing,
                short_failure_reasons,
            ),
            "medium_term": horizon(
                ["fundamentals", "industry_context", "cycle_context"],
                research_medium_missing,
                research_medium_reasons,
            ),
            "long_term": horizon(
                ["fundamentals", "company_quality"],
                research_long_missing,
                research_long_reasons,
            ),
        }
        available_research_horizons = [
            horizon_name
            for horizon_name in ("short_term", "medium_term", "long_term")
            if research_horizons[horizon_name]["status"] == "ready"
        ]
        research_status = "ready" if available_research_horizons else "failed"
        research_failure_reasons = list(
            dict.fromkeys(
                reason
                for item in research_horizons.values()
                for reason in item.get("failure_reasons") or []
            )
        )
        enhanced_sections = (
            "market_regime",
            "industry_context",
            "tradeability",
            "policy_context",
            "cycle_context",
            "capital_positioning",
            "event_calendar",
            "relative_benchmarks",
        )
        enhanced_available: list[str] = []
        enhanced_degraded: list[str] = []
        for section in enhanced_sections:
            value = bundle.get(section)
            status = value.get("status") if isinstance(value, dict) else None
            if status == "available":
                enhanced_available.append(section)
            else:
                enhanced_degraded.append(section)
        source_ids = list((derived or {}).get("source_ids") or []) if isinstance(derived, dict) else []
        source_ids.extend((fundamentals or {}).get("source_ids") or [] if isinstance(fundamentals, dict) else [])
        source_ids.extend((company_quality or {}).get("source_ids") or [] if isinstance(company_quality, dict) else [])
        source_ids.extend((valuation or {}).get("source_ids") or [] if isinstance(valuation, dict) else [])
        as_of = (derived or {}).get("as_of") if isinstance(derived, dict) else None
        trade_status = "ready" if not trade_failure_reasons else "failed"
        return {
            # V5 callers treat the top-level status as the permission to
            # create an executable plan; keep it equivalent to trade_ready.
            "status": trade_status,
            "method_version": DECISION_READINESS_VERSION,
            "as_of": as_of or bundle.get("market_as_of") or bundle.get("research_cutoff_at"),
            "source_ids": sorted(set(source_ids)),
            "core": {
                "status": core_status,
                "required": ["quote", "kline", "technical_indicators"],
                "available": [
                    item for item in ("quote", "kline", "technical_indicators")
                    if item not in short_missing
                ],
                "missing": short_missing,
                "failure_reasons": short_failure_reasons,
            },
            "horizons": horizons,
            "research_ready": {
                "status": research_status,
                "failure_reasons": research_failure_reasons,
                "available_horizons": available_research_horizons,
                "horizons": research_horizons,
            },
            "trade_ready": {
                "status": trade_status,
                "failure_reasons": trade_failure_reasons,
                "horizons": horizons,
            },
            "enhanced": {
                "status": "available" if not enhanced_degraded else "degraded",
                "purpose": "only_affects_evidence_strength",
                "available": enhanced_available,
                "missing": enhanced_degraded,
            },
        }

    @staticmethod
    def _bar_time(bar: Any) -> datetime | None:
        value = parse_asia_datetime(getattr(bar, "date", None))
        if value is not None and len(str(getattr(bar, "date", "")).strip()) <= 10:
            return value.replace(
                hour=CLOSE_TIME.hour,
                minute=CLOSE_TIME.minute,
                second=0,
                microsecond=0,
            )
        return value

    @classmethod
    def _build_relative_benchmarks(
        cls,
        *,
        inst: InstrumentRef,
        target_bars: list[Any],
        target_source: Any | None,
        benchmark_series: Any | None,
        research_cutoff: datetime,
        keep_source: Callable[..., None],
        data_quality: dict[str, Any],
    ) -> dict[str, Any]:
        """Build auditable target-vs-public-index returns on shared dates."""
        cutoff = parse_asia_datetime(research_cutoff)
        if cutoff is None:
            raise ValueError("relative benchmark requires a valid research cutoff")
        missing: list[str] = []
        if not target_bars:
            missing.append("target_kline")
        if benchmark_series is None:
            missing.append("benchmark_kline")

        target_by_date: dict[str, Any] = {}
        for bar in target_bars:
            timestamp = cls._bar_time(bar)
            if timestamp is None:
                data_quality["unknown_availability"].append(
                    {
                        "section": "relative_benchmarks",
                        "field": "target_bar_date",
                        "value": getattr(bar, "date", None),
                        "reason": "unparseable_or_missing_public_time",
                    }
                )
                continue
            if timestamp <= cutoff:
                target_by_date[timestamp.date().isoformat()] = bar
            else:
                data_quality["excluded_future"].append(
                    {
                        "section": "relative_benchmarks",
                        "field": "target_bar_date",
                        "value": getattr(bar, "date", None),
                        "reason": "after_research_cutoff",
                    }
                )

        benchmark_by_date: dict[str, Any] = {}
        benchmark_source_ids: list[str] = []
        if benchmark_series is not None:
            benchmark_source = getattr(benchmark_series, "source", None)
            benchmark_source_id = getattr(benchmark_source, "id", None)
            if benchmark_source_id:
                benchmark_source_ids.append(benchmark_source_id)
            for bar in benchmark_series.bars:
                timestamp = cls._bar_time(bar)
                if timestamp is None:
                    data_quality["unknown_availability"].append(
                        {
                            "section": "relative_benchmarks",
                            "field": "benchmark_bar_date",
                            "value": getattr(bar, "date", None),
                            "reason": "unparseable_or_missing_public_time",
                        }
                    )
                    continue
                if timestamp <= cutoff:
                    benchmark_by_date[timestamp.date().isoformat()] = bar
                else:
                    data_quality["excluded_future"].append(
                        {
                            "section": "relative_benchmarks",
                            "field": "benchmark_bar_date",
                            "value": getattr(bar, "date", None),
                            "reason": "after_research_cutoff",
                        }
                    )
            if benchmark_source_id and benchmark_by_date:
                latest = max(benchmark_by_date)
                keep_source(
                    benchmark_source,
                    published_at=f"{latest}T15:00:00+08:00",
                )

        aligned_dates = sorted(set(target_by_date) & set(benchmark_by_date))
        if not aligned_dates:
            missing.append("aligned_trading_days")

        target_source_ids = [
            source_id
            for source_id in [getattr(target_source, "id", None)]
            if source_id
        ]
        source_ids = sorted(set(target_source_ids + benchmark_source_ids))
        windows: list[dict[str, Any]] = []
        for window in BENCHMARK_WINDOWS:
            window_missing = list(missing)
            if len(aligned_dates) < window + 1:
                required = f"aligned_trading_days>={window + 1}"
                if required not in window_missing:
                    window_missing.append(required)
            dates = aligned_dates[-(window + 1):] if not window_missing or len(aligned_dates) >= window + 1 else []
            target_return = None
            benchmark_return = None
            relative_return = None
            market_as_of = None
            if len(dates) == window + 1:
                first_target = float(target_by_date[dates[0]].close)
                last_target = float(target_by_date[dates[-1]].close)
                first_benchmark = float(benchmark_by_date[dates[0]].close)
                last_benchmark = float(benchmark_by_date[dates[-1]].close)
                if first_target != 0 and first_benchmark != 0:
                    target_return = (last_target / first_target - 1) * 100
                    benchmark_return = (last_benchmark / first_benchmark - 1) * 100
                    relative_return = target_return - benchmark_return
                    market_as_of = f"{dates[-1]}T15:00:00+08:00"
                else:
                    window_missing.append("zero_start_close")
            windows.append(
                {
                    "window": window,
                    "status": "available" if relative_return is not None else "missing",
                    "target_return": target_return,
                    "benchmark_return": benchmark_return,
                    "relative_return": relative_return,
                    "unit": "percent",
                    "method": "aligned-close-return-v1",
                    "version": "1",
                    "market_as_of": market_as_of,
                    "source_ids": source_ids,
                    "missing": sorted(set(window_missing)),
                }
            )

        available_windows = sum(item["status"] == "available" for item in windows)
        status = (
            "available"
            if available_windows == len(windows)
            else ("degraded" if available_windows else "missing")
        )
        top_missing = sorted(
            set(missing)
            | {
                item
                for window in windows
                for item in window["missing"]
            }
        )
        return {
            "status": status,
            "benchmark": dict(PUBLIC_MARKET_BENCHMARK),
            "target_instrument_id": inst.id,
            "windows": windows,
            "market_as_of": (
                f"{aligned_dates[-1]}T15:00:00+08:00" if aligned_dates else None
            ),
            "method": "aligned-close-return-v1",
            "version": "1",
            "source_ids": source_ids,
            "missing": top_missing,
            "coverage": {
                "target_bars": len(target_by_date),
                "benchmark_bars": len(benchmark_by_date),
                "aligned_trading_days": len(aligned_dates),
            },
        }

    @staticmethod
    def _snapshot_value(row: Any, key: str) -> Any:
        value = getattr(row, key, None)
        if value is not None:
            return value
        if isinstance(row, dict):
            return row.get(key)
        return None

    @classmethod
    def _build_v2_sections(
        cls,
        *,
        inst: InstrumentRef,
        bundle: dict[str, Any],
        market_snapshot: list[Any],
        market_capture: MarketSnapshotCapture | None,
        instrument_profile: Any | None,
        research_cutoff: datetime,
        industry_valuation: dict[str, Any] | None = None,
        sources: dict[str, dict],
        keep_source: Callable[..., None],
        data_quality: dict[str, Any],
    ) -> dict[str, Any]:
        """Build the deterministic V2 context from already fetched data.

        This layer intentionally has no network access.  Anything unavailable
        in the current free source combination remains missing/degraded and
        is never inferred from a news title or a generic market convention.
        """
        capture = (
            market_capture
            if market_capture is not None
            else MarketSnapshotCapture(
                list(market_snapshot),
                expected_count=len(market_snapshot),
                page_size=len(market_snapshot),
                complete=True,
                requested_limit=len(market_snapshot),
            )
        )
        capture_info = {
            "expected_count": capture.expected_count,
            "loaded_count": capture.loaded_count,
            "coverage": capture.coverage,
            "page_size": capture.page_size,
            "requested_limit": capture.requested_limit,
            "complete": capture.complete,
            "error": capture.error,
            "cache": getattr(capture, "cache_info", None),
        }
        rows: list[tuple[Any, str, list[str]]] = []
        for row in market_snapshot:
            observed = cls._snapshot_value(row, "observed_at")
            if observed is None:
                observed = cls._snapshot_value(row, "as_of")
            source = cls._snapshot_value(row, "source")
            relation = compare_asia_datetime(observed, research_cutoff)
            if relation is False:
                data_quality["excluded_future"].append(
                    {
                        "section": "market_snapshot",
                        "field": "observed_at",
                        "value": observed,
                        "reason": "after_research_cutoff",
                    }
                )
                continue
            if relation is None:
                data_quality["unknown_availability"].append(
                    {
                        "section": "market_snapshot",
                        "field": "observed_at",
                        "value": observed,
                        "reason": "unparseable_or_missing_public_time",
                    }
                )
                continue
            if source is not None:
                keep_source(source, published_at=normalize_asia_datetime(observed))
            source_ids = set()
            for source_id in cls._snapshot_value(row, "source_ids") or []:
                if source_id in sources:
                    source_ids.add(source_id)
            if source is not None and source.id in sources:
                source_ids.add(source.id)
            rows.append((row, normalize_asia_datetime(observed) or str(observed), sorted(source_ids)))

        all_snapshot_ids = sorted({sid for _, _, ids in rows for sid in ids})
        target_entries = [entry for entry in rows if cls._snapshot_value(entry[0], "instrument_id") == inst.id]
        # The independent instrument profile is appended to the snapshot for
        # industry context.  It is not a market quote row, so keep the two
        # roles separate when the breadth snapshot is unavailable.
        eligible_profile = (
            instrument_profile
            if any(entry[0] is instrument_profile for entry in rows)
            else None
        )
        target = next(
            (
                entry[0]
                for entry in target_entries
                if eligible_profile is None or entry[0] is not eligible_profile
            ),
            None,
        )
        profile = eligible_profile

        industry_valuation_source = None
        industry_valuation_observed = None
        if isinstance(industry_valuation, dict):
            candidate_source = industry_valuation.get("source")
            candidate_observed = industry_valuation.get("observed_at")
            relation = compare_asia_datetime(candidate_observed, research_cutoff)
            if relation is True and isinstance(candidate_source, SourceRecord):
                industry_valuation_source = candidate_source
                industry_valuation_observed = normalize_asia_datetime(candidate_observed)
                keep_source(candidate_source, published_at=industry_valuation_observed)
            elif relation is False:
                data_quality["excluded_future"].append(
                    {
                        "section": "industry_valuation",
                        "field": "observed_at",
                        "value": candidate_observed,
                        "reason": "after_research_cutoff",
                    }
                )
            elif candidate_observed is not None:
                data_quality["unknown_availability"].append(
                    {
                        "section": "industry_valuation",
                        "field": "observed_at",
                        "value": candidate_observed,
                        "reason": "unparseable_or_missing_public_time",
                    }
                )

        valuation_peer_values = {"pe": [], "pb": []}
        valuation_peer_companies: list[dict[str, Any]] = []
        if industry_valuation_source is not None and isinstance(industry_valuation, dict):
            for peer in industry_valuation.get("peers") or []:
                if not isinstance(peer, dict):
                    continue
                code = str(peer.get("symbol") or "")
                pe = numeric_value(peer.get("pe_ttm"))
                pb = numeric_value(peer.get("pb_mrq"))
                if (
                    not re.fullmatch(r"\d{6}", code)
                    or code == inst.symbol
                    or pe is None
                    or pe <= 0
                    or pb is None
                    or pb <= 0
                ):
                    continue
                valuation_peer_values["pe"].append(pe)
                valuation_peer_values["pb"].append(pb)
                valuation_peer_companies.append(
                    {
                        "instrument_id": peer.get("instrument_id"),
                        "symbol": code,
                        "name": peer.get("name") or "",
                        "pe_ttm": pe,
                        "pb_mrq": pb,
                        "report_period": peer.get("report_period"),
                        "source_ids": [industry_valuation_source.id],
                    }
                )

        def numeric(row: Any, *keys: str) -> float | None:
            for key in keys:
                value = cls._snapshot_value(row, key)
                if value is None or isinstance(value, bool):
                    continue
                try:
                    return float(value)
                except (TypeError, ValueError):
                    continue
            return None

        def distribution(value: float | None, values: list[float]) -> dict[str, Any]:
            usable = sorted(item for item in values if item > 0)
            if value is None or value <= 0 or len(usable) < 2:
                return {"value": value, "peer_count": len(usable), "median": None, "percentile": None}
            middle = len(usable) // 2
            median = (
                usable[middle]
                if len(usable) % 2
                else (usable[middle - 1] + usable[middle]) / 2
            )
            return {
                "value": value,
                "peer_count": len(usable),
                "median": median,
                "percentile": sum(item <= value for item in usable) / len(usable),
            }

        def status_for_old(section: str) -> str:
            value = bundle.get(section)
            return "available" if value not in (None, [], {}) else "missing"

        if rows:
            changes = [numeric(row, "change_pct") for row, _, _ in rows]
            changes = [value for value in changes if value is not None]
            amounts = [numeric(row, "amount", "turnover") for row, _, _ in rows]
            amounts = [value for value in amounts if value is not None and value >= 0]
            advancing = sum(value > 0 for value in changes)
            declining = sum(value < 0 for value in changes)
            unchanged = sum(value == 0 for value in changes)
            suspended = sum(bool(cls._snapshot_value(row, "is_suspended")) for row, _, _ in rows)
            market_regime = {
                "status": (
                    "available"
                    if capture.complete and (changes or amounts)
                    else "degraded"
                ),
                "claim_type": "inference",
                "basis": "按研究截止前同一快照的可用标的确定性汇总，不代表授权的官方市场统计",
                "method": "market-breadth-v1",
                "version": "1",
                "inputs": ["change_pct", "amount", "is_suspended"],
                "observed_at": max(observed for _, observed, _ in rows),
                "member_count": len(rows),
                "available_change_count": len(changes),
                "breadth": {
                    "advancing": advancing,
                    "declining": declining,
                    "unchanged": unchanged,
                    "suspended": suspended,
                    "advance_ratio": advancing / len(changes) if changes else None,
                },
                "turnover_amount": sum(amounts) if amounts else None,
                "coverage": capture_info,
                "source_ids": all_snapshot_ids,
                "missing_fields": [
                    field
                    for field, value in {
                        "change_pct": changes,
                        "turnover_amount": amounts,
                    }.items()
                    if not value
                ] + ["limit_up_count", "limit_down_count"] + (
                    [] if capture.complete else ["market_snapshot_complete"]
                ),
            }
        else:
            market_regime = {
                "status": "missing",
                "claim_type": "inference",
                "basis": "没有研究截止前可核验的全市场快照",
                "method": "market-breadth-v1",
                "version": "1",
                "inputs": [],
                "member_count": 0,
                "coverage": capture_info,
                "source_ids": [],
                "missing_fields": [
                    "market_snapshot", "breadth", "turnover_amount", "observed_at",
                ] + ([] if capture.complete else ["market_snapshot_complete"]),
            }

        target_industry = (
            cls._snapshot_value(target, "industry")
            if target is not None and cls._snapshot_value(target, "industry") is not None
            else cls._snapshot_value(profile, "industry")
        )
        industry_rows = [
            item for item in rows
            if target_industry and cls._snapshot_value(item[0], "industry") == target_industry
        ]
        industry_changes = [numeric(row, "change_pct") for row, _, _ in industry_rows]
        industry_changes = [value for value in industry_changes if value is not None]
        market_changes = [numeric(row, "change_pct") for row, _, _ in rows]
        market_changes = [value for value in market_changes if value is not None]
        industry_avg = sum(industry_changes) / len(industry_changes) if industry_changes else None
        market_avg = sum(market_changes) / len(market_changes) if market_changes else None
        relative = industry_avg - market_avg if industry_avg is not None and market_avg is not None else None
        industry_ids = sorted({sid for _, _, ids in industry_rows for sid in ids})
        if not target_industry:
            industry_context = {
                "status": "missing",
                "claim_type": "inference",
                "basis": "目标标的没有可核验行业分类",
                "method": "industry-relative-strength-v1",
                "version": "1",
                "target_industry": None,
                "coverage": capture_info,
                "source_ids": [],
                "missing_fields": ["industry_classification", "industry_members", "relative_change_pct"],
            }
        else:
            classification_scheme = (
                cls._snapshot_value(target, "classification_scheme")
                or cls._snapshot_value(profile, "classification_scheme")
            )
            industry_code = (
                cls._snapshot_value(target, "industry_code")
                or cls._snapshot_value(profile, "industry_code")
            )
            industry_member_coverage = cls._snapshot_value(
                target, "industry_member_coverage"
            ) or cls._snapshot_value(profile, "industry_member_coverage")
            industry_benchmark = (
                cls._snapshot_value(target, "industry_benchmark")
                or cls._snapshot_value(profile, "industry_benchmark")
            )
            industry_core_missing = [
                field
                for field, value in {
                    "classification_scheme": classification_scheme,
                    "industry_code": industry_code,
                    "industry_member_coverage": industry_member_coverage,
                    "industry_benchmark": industry_benchmark,
                }.items()
                if value is None
            ]
            industry_context = {
                "status": (
                    "available"
                    if relative is not None and capture.complete and not industry_core_missing
                    else "degraded"
                ),
                "claim_type": "inference",
                "basis": "行业成员等权平均涨跌幅减去同一快照全市场等权平均涨跌幅",
                "method": "industry-relative-strength-v1",
                "version": "1",
                "inputs": ["industry", "change_pct"],
                "target_industry": target_industry,
                "classification_scheme": classification_scheme,
                "industry_code": industry_code,
                "industry_member_coverage": industry_member_coverage,
                "industry_benchmark": industry_benchmark,
                "observed_at": max((observed for _, observed, _ in industry_rows), default=None),
                "member_count": len(industry_rows),
                "available_member_count": len(industry_changes),
                "industry_change_pct": industry_avg,
                "market_change_pct": market_avg,
                "relative_change_pct": relative,
                "coverage": capture_info,
                "source_ids": sorted(set(industry_ids + all_snapshot_ids)),
                "missing_fields": [
                    field for field, value in {
                        "industry_change_pct": industry_avg,
                        "market_change_pct": market_avg,
                        "relative_change_pct": relative,
                    }.items() if value is None
                ] + industry_core_missing + ([] if capture.complete else ["market_snapshot_complete"]),
            }

        # Keep the two policy scopes separate.  ``macro_documents`` is a
        # statistics search (currently M2) and must never be promoted to a
        # policy fact.  A market-snapshot outage only removes the industry
        # scope; formal macro/regulatory documents remain usable on their own.
        industry_policy_documents = bundle.get("policy_documents") or []
        macro_regulatory_documents = bundle.get("macro_policy_documents") or []
        formal_policy_documents: list[dict[str, Any]] = []
        seen_policy_sources: set[str] = set()
        for document in (*industry_policy_documents, *macro_regulatory_documents):
            source_ids = document.get("source_ids") or []
            if source_ids and all(source_id in seen_policy_sources for source_id in source_ids):
                continue
            formal_policy_documents.append(document)
            seen_policy_sources.update(source_ids)
        policy_ids = sorted(
            {
                source_id
                for item in formal_policy_documents
                for source_id in item.get("source_ids") or []
            }
        )
        policy_missing_fields = []
        if not industry_policy_documents:
            policy_missing_fields.append("industry_policy_documents")
        if not macro_regulatory_documents:
            policy_missing_fields.append("macro_regulatory_policy_documents")
        policy_core_missing_fields = list(policy_missing_fields)
        for field in (
            "title",
            "issuer",
            "document_id",
            "published_at",
            "effective_from",
            "effective_to",
            "url",
            "summary",
            "source_ids",
        ):
            if formal_policy_documents and any(
                not document.get(field) for document in formal_policy_documents
            ):
                policy_core_missing_fields.append(field)
        if formal_policy_documents and not policy_core_missing_fields:
            policy_status = "available"
        elif formal_policy_documents:
            policy_status = "degraded"
        else:
            policy_status = "missing"
        policy_context = {
            "status": policy_status,
            "claim_type": "fact",
            "industry": target_industry,
            # ``documents`` remains as a compatibility view for existing
            # readers; the scoped fields are the contract for new reports.
            "documents": formal_policy_documents,
            "industry_policy_documents": industry_policy_documents,
            "macro_regulatory_documents": macro_regulatory_documents,
            "macro_policy_documents": macro_regulatory_documents,
            "latest_published_at": max(
                (
                    item.get("published_at")
                    for item in formal_policy_documents
                    if item.get("published_at")
                ),
                default=None,
            ),
            "source_ids": policy_ids,
            "missing_fields": list(
                dict.fromkeys(
                    policy_core_missing_fields
                    + (
                        [
                            "effective_from",
                            "policy_stage",
                            "transmission_chain",
                            "realization_window",
                        ]
                        if formal_policy_documents
                        else ["issuer", "document_id", "published_at"]
                    )
                )
            ),
            "reason": (
                "已取得正式行业政策与宏观/监管政策；政策阶段、传导链和兑现窗口由行业 Agent 基于文件推断"
                if policy_status == "available"
                else (
                    "已取得正式行业与宏观/监管政策，但原始字段或生效日期不完整"
                    if industry_policy_documents and macro_regulatory_documents
                    else (
                        "已取得正式宏观/监管政策，但目标行业分类或行业政策缺失；不能把宏观政策当作行业政策"
                        if macro_regulatory_documents
                        else (
                            "已取得正式行业政策，但正式宏观/监管政策缺失"
                            if industry_policy_documents
                            else "研究截止前未取得可核验的正式行业或宏观/监管政策文件"
                        )
                    )
                )
            ),
        }

        fundamental_ids = sorted(
            source_id for source_id, source in sources.items()
            if "report_period" in (source.get("fields") or [])
        )
        fundamentals = bundle.get("fundamentals")
        fundamentals_history = bundle.get("fundamentals_history") or []
        company_profile = (
            bundle.get("company_profile")
            if isinstance(bundle.get("company_profile"), dict)
            else {}
        )
        fundamental_ids = sorted(
            set(fundamental_ids)
            | set((fundamentals or {}).get("source_ids") or [])
            | set(company_profile.get("source_ids") or [])
        )
        if fundamentals:
            periods = [item for item in fundamentals_history if item.get("report_period")]
            growth_history = [
                {
                    "period_end": item.get("period_end") or item.get("report_period"),
                    "published_at": item.get("published_at"),
                    "revenue_yoy": (item.get("metrics") or {}).get("revenue_yoy"),
                    "profit_yoy": (item.get("metrics") or {}).get("profit_yoy"),
                    "source_ids": item.get("source_ids") or [],
                }
                for item in periods
            ]
            cashflow_quality = []
            for item in periods:
                metrics = item.get("metrics") or {}
                profit = numeric_value(metrics.get("net_profit"))
                cashflow = numeric_value(metrics.get("operating_cashflow"))
                cashflow_quality.append(
                    {
                        "period_end": item.get("period_end") or item.get("report_period"),
                        "operating_cashflow": cashflow,
                        "net_profit": profit,
                        "cashflow_to_profit": (
                            cashflow / profit if cashflow is not None and profit not in (None, 0) else None
                        ),
                        "source_ids": item.get("source_ids") or [],
                    }
                )
            provider_target_pe = (
                numeric_value(industry_valuation.get("target_pe_ttm"))
                if industry_valuation_source is not None and isinstance(industry_valuation, dict)
                else None
            )
            provider_target_pb = (
                numeric_value(industry_valuation.get("target_pb_mrq"))
                if industry_valuation_source is not None and isinstance(industry_valuation, dict)
                else None
            )
            target_pe = (
                numeric(target, "pe")
                if target is not None
                else numeric_value((bundle.get("quote") or {}).get("pe"))
            ) or provider_target_pe
            target_pb = (
                numeric(target, "pb")
                if target is not None
                else numeric_value((bundle.get("quote") or {}).get("pb"))
            ) or provider_target_pb
            valuation_peer_rows = [
                (row, observed, ids)
                for row, observed, ids in industry_rows
                if cls._snapshot_value(row, "instrument_id") != inst.id
            ]
            peer_pe = list(valuation_peer_values["pe"])
            peer_pb = list(valuation_peer_values["pb"])
            if not peer_pe and not peer_pb:
                peer_pe = [
                    value for row, _, _ in valuation_peer_rows
                    if (value := numeric(row, "pe")) is not None and value > 0
                ]
                peer_pb = [
                    value for row, _, _ in valuation_peer_rows
                    if (value := numeric(row, "pb")) is not None and value > 0
                ]
            valuation_source_ids = (
                [industry_valuation_source.id]
                if industry_valuation_source is not None
                else []
            )
            peer_sample_required = 3 if valuation_source_ids else 2
            valuation = {
                "status": "available" if (
                    (target_pe is not None and target_pe > 0 and len(peer_pe) >= peer_sample_required)
                    or (target_pb is not None and target_pb > 0 and len(peer_pb) >= peer_sample_required)
                ) else "missing",
                "method": (
                    "same-industry-f10-current-percentile-v1"
                    if valuation_source_ids
                    else "same-industry-current-snapshot-percentile-v1"
                ),
                "basis": (
                    "目标 PE/PB 与独立行业估值端点返回的排除目标、ST和非正值同行样本比较"
                    if valuation_source_ids
                    else "目标 PE/PB 与研究截止前同一行业、排除目标公司的其他正值同行样本比较"
                ),
                "pe": distribution(target_pe, peer_pe),
                "pb": distribution(target_pb, peer_pb),
                # Preserve the observed peer multiples for the V6 valuation
                # engine; the public compatibility fields above remain unchanged.
                "peer_values": {"pe": sorted(peer_pe), "pb": sorted(peer_pb)},
                "peer_companies": valuation_peer_companies,
                "as_of": industry_valuation_observed or industry_context.get("observed_at") or market_regime.get("observed_at"),
                "source_ids": sorted(set(industry_ids + valuation_source_ids + _quote_source_ids(sources))),
            }
            missing_fields = []
            if len(periods) < 4:
                missing_fields += ["multi_period_financials", "cashflow_quality_trend"]
            current_metrics = fundamentals.get("metrics") or {}
            optional_missing_fields = [
                field
                for field, value in {
                    "capital_expenditure": current_metrics.get("capex", current_metrics.get("capital_expenditure")),
                    "governance": bundle.get("governance"),
                    "dilution_history": current_metrics.get("dilution_ratio", bundle.get("dilution_history")),
                    "audit_or_restatement_status": current_metrics.get("audit_qualification", bundle.get("audit_or_restatement_status")),
                    "customer_supplier_concentration": bundle.get("customer_supplier_concentration"),
                    "segment_revenue_profit": bundle.get("segment_revenue_profit"),
                    "management_commitment_delivery": bundle.get("management_commitment_delivery"),
                }.items()
                if value in (None, [], {})
            ]
            if valuation["status"] == "missing":
                optional_missing_fields.append("peer_valuation")
            company_quality = {
                "status": "degraded" if missing_fields else "available",
                "claim_type": "fact",
                "report_period": fundamentals.get("report_period"),
                "period_end": fundamentals.get("period_end"),
                "published_at": fundamentals.get("published_at"),
                "metrics": fundamentals.get("metrics") or {},
                "company_profile": company_profile,
                "main_business": company_profile.get("main_business"),
                "period_count": len(periods),
                "periods": periods,
                "growth_history": growth_history,
                "cashflow_quality": cashflow_quality,
                "valuation_context": valuation,
                "source_ids": sorted(set(fundamental_ids + valuation["source_ids"])),
                "missing_fields": missing_fields,
                "optional_missing_fields": optional_missing_fields,
                "reason": "核心经营与现金流数据用于结论；仅在公司实际披露时增强治理、分部与集中度分析",
            }
        else:
            company_quality = {
                "status": "missing",
                "claim_type": "fact",
                "source_ids": [],
                "missing_fields": [
                    "financial_period", "multi_period_financials", "cashflow_quality_trend",
                ],
                "optional_missing_fields": [
                    "capital_expenditure", "governance", "dilution_history",
                    "audit_or_restatement_status", "customer_supplier_concentration",
                    "segment_revenue_profit", "management_commitment_delivery",
                ],
            }

        news_ids = sorted(
            source_id for source_id, source in sources.items()
            if "title" in (source.get("fields") or [])
        )
        structured_events = bundle.get("_structured_events") or []
        structured_event_coverage = bundle.get("_structured_event_coverage") or {
            "status": "unavailable",
            "source": "structured_market_events",
        }
        events = []
        structured_capture_available = structured_event_coverage.get("status") in {"available", "degraded"}
        if structured_capture_available:
            for raw_event in structured_events:
                event = dict(raw_event)
                source = event.pop("_source", None)
                if source is not None:
                    source_id = getattr(source, "id", None)
                    if source_id and hasattr(source, "model_dump"):
                        keep_source(source, published_at=normalize_asia_datetime(event.get("published_at")))
                    elif source_id and isinstance(source, dict):
                        sources.setdefault(source_id, dict(source))
                events.append(event)
        else:
            for item in bundle.get("news") or []:
                event_text = f"{item.get('title') or ''} {item.get('summary') or ''}"
                events.append({
                    "event_type": _event_type(event_text),
                    "instrument_id": inst.id,
                    "published_at": item.get("published_at"),
                    "event_date": _event_date(event_text),
                    "status": "published",
                    "title": item.get("title"),
                    "url": item.get("url"),
                    "source_ids": item.get("source_ids") or news_ids,
                })
        event_ids = sorted({source_id for item in events for source_id in item["source_ids"]})
        has_event_dates = bool(events) and all(item["event_date"] for item in events)
        known_event_types = [event_type for event_type, _ in _EVENT_TYPES]
        observed_event_types = sorted({item["event_type"] for item in events})
        if structured_capture_available:
            # A complete structured feed is not required to contain one sample
            # of every taxonomy value.  Treating absent categories as missing
            # would turn a valid no-event window into a false coverage failure.
            known_event_types = observed_event_types
            missing_event_types = []
        else:
            missing_event_types = sorted(set(known_event_types) - set(observed_event_types))
        event_type_coverage = {
            "known_types": known_event_types,
            "observed_types": observed_event_types,
            "missing_types": missing_event_types,
            "sample_size": len(events),
            "complete": (
                structured_capture_available and structured_event_coverage.get("complete", False)
                if structured_capture_available
                else bool(events) and not missing_event_types
            ),
            "method": "structured-market-events-v1" if structured_events else "observed-news-taxonomy-v1",
            "basis": (
                "基于同一运行的结构化事件 capture；事件事实与 source_id 保持同源"
                if structured_events
                else "仅依据本次可核验公告样本的已识别类型，未把最近N条公告当作全量覆盖"
            ),
        }
        structured_complete = structured_capture_available and bool(structured_event_coverage.get("complete", False))
        event_calendar = {
            # An announcement without a scheduled/effective date is still
            # useful event-risk evidence, but cannot support an available
            # calendar suitable for timing decisions.
            "status": (
                "available"
                if ((structured_complete and (not events or has_event_dates)) or (has_event_dates and event_type_coverage["complete"]))
                else ("degraded" if events or structured_event_coverage.get("status") == "degraded" else "missing")
            ),
            "claim_type": "fact",
            "events": events,
            "event_type_coverage": event_type_coverage,
            "latest_published_at": max(
                (item.get("published_at") for item in events if item.get("published_at")),
                default=None,
            ),
            "source_ids": event_ids,
            "capture": structured_event_coverage,
            "missing_fields": (
                (
                    ([] if (not events or has_event_dates) else ["event_date"])
                    + ([] if event_type_coverage["complete"] else ["event_type_coverage"])
                )
                if events or structured_complete
                else ["announcements", "event_date", "event_type_coverage"]
            ),
        }

        target_ids = sorted({sid for _, _, ids in target_entries for sid in ids})
        target_quote = bundle.get("quote") or {}
        quote_ids = sorted(
            set(_quote_source_ids(sources)) | set(target_quote.get("source_ids") or [])
        )
        kline_ids = sorted(
            source_id
            for source_id, source in sources.items()
            if "date" in (source.get("fields") or [])
        )
        def snapshot_or_quote(*snapshot_keys: str, quote_key: str) -> float | None:
            value = numeric(target, *snapshot_keys) if target is not None else None
            return value if value is not None else numeric_value(target_quote.get(quote_key))

        target_amount = snapshot_or_quote("amount", "turnover", quote_key="amount")
        target_turnover_rate = snapshot_or_quote("turnover_rate", quote_key="turnover_rate")
        target_volume = snapshot_or_quote("volume", quote_key="volume")
        target_price = snapshot_or_quote("price", quote_key="price")
        target_suspended = (
            cls._snapshot_value(target, "is_suspended") if target is not None else None
        )
        target_change_pct = snapshot_or_quote("change_pct", quote_key="change_pct")
        explicit_active_member = cls._snapshot_value(target, "active_universe_member") if target is not None else None
        active_member = explicit_active_member
        active_member_method = cls._snapshot_value(target, "status_method") if target is not None else None
        if active_member is None and capture.complete and target is not None and target_price is not None and target_price > 0:
            active_member = True
            active_member_method = "complete-market-capture-current-quote-v1"
        risk_warning = cls._snapshot_value(target, "is_st") if target is not None else None
        is_delisting = cls._snapshot_value(target, "is_delisting") if target is not None else None
        status_method = cls._snapshot_value(target, "status_method") if target is not None else None
        name_status_proxy = cls._snapshot_value(target, "name_status_proxy") if target is not None else None
        listing_days = cls._snapshot_value(target, "listing_days") if target is not None else None
        listing_date = (
            cls._snapshot_value(target, "listing_date")
            if target is not None and cls._snapshot_value(target, "listing_date") is not None
            else cls._snapshot_value(profile, "listing_date")
        )
        listing_lower_bound = None
        listing_lower_bound_method = None
        kline_ref = bundle.get("kline_ref")
        try:
            kline_bar_count = int(kline_ref.get("bars") or 0) if isinstance(kline_ref, dict) else 0
        except (TypeError, ValueError):
            kline_bar_count = 0
        if listing_days is None and kline_bar_count >= 6:
            listing_lower_bound = kline_bar_count
            listing_lower_bound_method = "completed-kline-session-count-v1"
        previous_close = snapshot_or_quote("previous_close", quote_key="previous_close")
        previous_close_method = (
            "provided-market-or-quote-v1" if previous_close is not None else None
        )
        if previous_close is None and target_price is not None and target_change_pct is not None:
            denominator = 1.0 + target_change_pct / 100.0
            if denominator > 0 and target_change_pct != -100:
                candidate_previous_close = target_price / denominator
                if math.isfinite(candidate_previous_close) and candidate_previous_close > 0:
                    previous_close = candidate_previous_close
                    previous_close_method = "price-change-reverse-v1"
        chip_data = bundle.get("chip_data") if isinstance(bundle.get("chip_data"), dict) else {}
        chip_source_ids = chip_data.get("source_ids") or []
        capital_positioning = {
            "status": "available" if target is not None or target_quote else "missing",
            "claim_type": "inference",
            "basis": "仅用公开快照的成交额/换手/成交量变化与正式公告事件构造可复核信号，不推断机构净买入",
            "method": "public-capital-signals-v1",
            "version": "1",
            "source_ids": sorted(set(target_ids + quote_ids + kline_ids + chip_source_ids)),
            "observed_at": (
                cls._snapshot_value(target, "observed_at")
                if target is not None and cls._snapshot_value(target, "observed_at") is not None
                else target_quote.get("as_of") or bundle.get("market_as_of")
            ),
            "published_at": None,
            "period_end": None,
            "turnover": target_amount,
            "turnover_rate": target_turnover_rate,
            "volume": target_volume,
            "price_change_pct": target_change_pct,
            "volume_change_pct_5d": (bundle.get("indicators") or {}).get("volume_change_pct"),
            "chip_profit_ratio": chip_data.get("profit_ratio"),
            "chip_average_cost": chip_data.get("average_cost"),
            "chip_concentration70": chip_data.get("concentration70"),
            "chip_concentration90": chip_data.get("concentration90"),
            "public_signals": [],
            "disclosure_signals": [
                item for item in events
                if item["event_type"] in {"share_unlock", "share_reduction", "share_pledge"}
            ],
            "missing_fields": [],
            "optional_missing_fields": [
                "financing_balance", "short_balance", "financing_flow", "institutional_flow",
                "etf_flow", *( [] if chip_data.get("concentration") is not None else ["shareholder_concentration"] ),
            ],
        }
        if chip_data.get("average_cost") is not None:
            capital_positioning["public_signals"].append(
                {
                    "signal_type": "chip_average_cost",
                    "value": chip_data.get("average_cost"),
                    "unit": "yuan",
                    "observed_at": chip_data.get("as_of"),
                    "claim_type": "fact",
                    "source_ids": chip_source_ids,
                }
            )
        if chip_data.get("profit_ratio") is not None:
            capital_positioning["public_signals"].append(
                {
                    "signal_type": "chip_profit_ratio",
                    "value": chip_data.get("profit_ratio"),
                    "unit": "percent",
                    "observed_at": chip_data.get("as_of"),
                    "claim_type": "fact",
                    "source_ids": chip_source_ids,
                }
            )
        if target_amount is not None:
            capital_positioning["public_signals"].append(
                {
                    "signal_type": "turnover_amount",
                    "value": target_amount,
                    "unit": "source_amount",
                    "observed_at": capital_positioning["observed_at"],
                    "claim_type": "fact",
                    "source_ids": sorted(set(target_ids + quote_ids)),
                }
            )
        if target_turnover_rate is not None:
            capital_positioning["public_signals"].append(
                {
                    "signal_type": "turnover_rate",
                    "value": target_turnover_rate,
                    "unit": "percent",
                    "observed_at": capital_positioning["observed_at"],
                    "claim_type": "fact",
                    "source_ids": sorted(set(target_ids + quote_ids)),
                }
            )
        volume_change = (bundle.get("indicators") or {}).get("volume_change_pct")
        if volume_change is not None:
            capital_positioning["public_signals"].append(
                {
                    "signal_type": "volume_change_pct_5d",
                    "value": volume_change,
                    "unit": "percent",
                    "observed_at": bundle.get("market_as_of"),
                    "claim_type": "inference",
                    "basis": "K线最近5个交易日成交量相对前5个交易日的确定性变化",
                    "source_ids": kline_ids,
                }
            )
        disclosed_event_types = {item["event_type"] for item in capital_positioning["disclosure_signals"]}
        capital_positioning["optional_missing_fields"] += [
            field for field, event_type in (
                ("pledge", "share_pledge"), ("reduction", "share_reduction"), ("unlock", "share_unlock")
            ) if event_type not in disclosed_event_types
        ]
        capital_positioning["source_ids"] = sorted(
            set(capital_positioning["source_ids"] + [
                source_id for item in capital_positioning["disclosure_signals"] for source_id in item["source_ids"]
            ])
        )
        if target is None and not target_quote:
            capital_positioning["status"] = "missing"

        exchange = (
            cls._snapshot_value(target, "exchange")
            if target is not None and cls._snapshot_value(target, "exchange") is not None
            else inst.exchange
        )
        board = (
            cls._snapshot_value(target, "board")
            if target is not None and cls._snapshot_value(target, "board") is not None
            else cls._snapshot_value(target, "board_type") if target is not None else None
        ) or cls._snapshot_value(profile, "board")
        limit_up = snapshot_or_quote("limit_up", quote_key="limit_up")
        limit_down = snapshot_or_quote("limit_down", quote_key="limit_down")
        price_limit_rule = cls._snapshot_value(target, "price_limit_rule") if target is not None else None
        price_limit_rule_method = "provided-market-snapshot-v1" if price_limit_rule is not None else None
        if price_limit_rule is None and limit_up is not None and limit_down is not None:
            price_limit_rule = {
                "status": "confirmed",
                "upper_limit_price": limit_up,
                "lower_limit_price": limit_down,
                "method": "quote-trading-bounds-v1",
                "source_ids": quote_ids,
            }
            price_limit_rule_method = "quote-trading-bounds-v1"
        t_plus_one = cls._snapshot_value(target, "t_plus_one") if target is not None else None
        t_plus_one_method = "provided-market-snapshot-v1" if t_plus_one is not None else None
        if (
            t_plus_one is None
            and inst.instrument_type == "equity"
            and exchange in {"XSHG", "XSHE", "BJSE"}
        ):
            # A-share equities follow the exchange T+1 delivery rule.  Keep
            # ETFs and other instruments unknown unless their provider gives
            # an explicit rule; their settlement/trading rules differ.
            t_plus_one = "restricted"
            t_plus_one_method = "a-share-equity-t-plus-one-rule-v1"
        execution_rule_missing = [
            field for field, value in {
                "price_limit_rule": price_limit_rule,
                "t_plus_one": t_plus_one,
            }.items() if value is None
        ]
        execution_data_missing = [
            field for field, value in {
                "price": target_price,
                "volume": target_volume,
                "amount": target_amount,
                "turnover_rate": target_turnover_rate,
            }.items() if value is None
        ]
        execution_optional_missing = [
            "order_book_depth", "realized_slippage", "tick_trade_data"
        ]
        tradeability_missing = execution_data_missing + execution_rule_missing
        tradeability_required_missing = [
            field
            for field, value in {
                "price": target_price,
                "volume": target_volume,
                "amount": target_amount,
                # These are deliberately not inferred from a stock code or a
                # generic A-share convention; a traced rules source is still
                # required before this section can be complete.
                "price_limit_rule": price_limit_rule,
                "t_plus_one": t_plus_one,
            }.items()
            if value is None
        ]
        liquidity_proxy = None
        if target_turnover_rate is not None:
            liquidity_proxy = {
                "value": target_turnover_rate,
                "unit": "percent",
                "method": "provided-turnover-rate-v1",
                "basis": "采用快照提供的换手率，不等同于实际可实现滑点",
            }
        elif target_amount is not None:
            liquidity_proxy = {
                "value": target_amount,
                "unit": "source_amount",
                "method": "turnover-amount-presence-v1",
                "basis": "仅作为成交额存在性代理，未推断实际滑点",
            }
        trade_source_ids = sorted(set(target_ids + quote_ids + kline_ids))
        has_trade_data = bool(target is not None or target_quote)
        tradeability = {
            "status": (
                "degraded"
                if has_trade_data and tradeability_required_missing
                else ("available" if has_trade_data else "missing")
            ),
            "claim_type": "inference",
            "basis": "使用可核验快照的价格、成交量、成交额、换手和停牌字段；订单簿与实际滑点没有来源",
            "method": "tradeability-observation-v1",
            "version": "1",
            "observed_at": (
                cls._snapshot_value(target, "observed_at")
                if target is not None and cls._snapshot_value(target, "observed_at") is not None
                else target_quote.get("as_of") or cls._snapshot_value(profile, "observed_at")
            ),
            "published_at": None,
            "period_end": None,
            "price": target_price,
            "volume": target_volume,
            "amount": target_amount,
            "turnover_rate": target_turnover_rate,
            "turnover_rate_pct": target_turnover_rate,
            "limit_up": limit_up,
            "limit_down": limit_down,
            "upper_limit_price": limit_up,
            "lower_limit_price": limit_down,
            "exchange": exchange,
            "board": board,
            "risk_warning": risk_warning,
            "is_st": risk_warning,
            "risk_warning_method": status_method,
            "name_status_proxy": name_status_proxy,
            "active_universe_member": active_member,
            "active_universe_member_method": active_member_method,
            "listing_days": listing_days,
            "listing_date": listing_date,
            "listing_age_lower_bound_sessions": listing_lower_bound,
            "listing_age_lower_bound_method": listing_lower_bound_method,
            "is_suspended": target_suspended,
            "suspended": target_suspended,
            # These fields require an explicit provider fact; absence stays
            # unknown and is never inferred from a code or missing quote.
            "delisted": cls._snapshot_value(target, "delisted") if target is not None else None,
            "delisting": (
                cls._snapshot_value(target, "delisting")
                if target is not None and cls._snapshot_value(target, "delisting") is not None
                else is_delisting
            ),
            "is_delisting": is_delisting,
            "registration_listing": cls._snapshot_value(target, "registration_listing") if target is not None else None,
            "price_limit_rule": price_limit_rule,
            "price_limit_rule_method": price_limit_rule_method,
            "t_plus_one": t_plus_one,
            "t_plus_one_method": t_plus_one_method,
            "t_plus_one_rule": (
                {
                    "status": "confirmed",
                    "value": t_plus_one,
                    "applies_to": "A股股票",
                    "method": t_plus_one_method,
                }
                if t_plus_one is not None
                else None
            ),
            "previous_close": previous_close,
            "previous_close_method": previous_close_method,
            "previous_close_source_ids": sorted(set(target_ids + quote_ids)) if previous_close is not None else [],
            "liquidity_proxy": liquidity_proxy,
            "source_ids": trade_source_ids,
            "missing_fields": tradeability_missing,
            "optional_missing_fields": execution_optional_missing,
        }
        tradeability["execution_facts_projection"] = {
            key: tradeability.get(key)
            for key in (
                "exchange",
                "board",
                "risk_warning",
                "suspended",
                "is_suspended",
                "delisted",
                "delisting",
                "is_delisting",
                "listing_days",
                "listing_date",
                "listing_age_lower_bound_sessions",
                "price",
                "previous_close",
                "amount",
                "turnover_rate_pct",
                "limit_up",
                "limit_down",
                "source_ids",
            )
        }
        tradeability["proxy_methods"] = {
            key: value
            for key, value in {
                "active_universe_member": active_member_method,
                "risk_warning": status_method,
                "listing_age_lower_bound_sessions": listing_lower_bound_method,
                "previous_close": previous_close_method,
                "price_limit_rule": price_limit_rule_method,
                "t_plus_one": t_plus_one_method,
            }.items()
            if value
        }

        market_style = {
            "status": (
                "available"
                if capture.complete
                and rows
                and market_regime.get("breadth", {}).get("advance_ratio") is not None
                else ("degraded" if rows else "missing")
            ),
            "claim_type": "inference",
            "basis": "由快照上涨占比确定性映射为宽度风格标签，不代表资金流向",
            "method": "market-style-breadth-v1",
            "version": "1",
            "advance_ratio": market_regime.get("breadth", {}).get("advance_ratio"),
            "style": _style_label(market_regime.get("breadth", {}).get("advance_ratio")),
            "coverage": capture_info,
            "source_ids": all_snapshot_ids,
            "missing_fields": (
                ([] if rows else ["market_snapshot", "advance_ratio"])
                + ([] if capture.complete else ["market_snapshot_complete"])
            ),
        }
        growth_points = [
            item for item in (company_quality.get("growth_history") or [])
            if item.get("profit_yoy") is not None or item.get("revenue_yoy") is not None
        ]
        latest_growth = growth_points[0] if growth_points else {}
        previous_growth = growth_points[1] if len(growth_points) > 1 else {}
        latest_profit_yoy = numeric_value(latest_growth.get("profit_yoy"))
        previous_profit_yoy = numeric_value(previous_growth.get("profit_yoy"))
        if latest_profit_yoy is None:
            earnings_stage = "unknown"
        elif previous_profit_yoy is None:
            earnings_stage = "single_period_growth"
        elif latest_profit_yoy > previous_profit_yoy:
            earnings_stage = "profit_growth_accelerating"
        elif latest_profit_yoy < previous_profit_yoy:
            earnings_stage = "profit_growth_decelerating"
        else:
            earnings_stage = "profit_growth_flat"
        company_cycle = {
            "status": "available" if len(fundamentals_history) >= 4 and len(growth_points) >= 2 else ("degraded" if fundamentals else "missing"),
            "claim_type": "inference",
            "basis": "按已公开多期收入/利润同比与经营现金流质量序列比较，不使用机构一致预期",
            "method": "company-earnings-cycle-v1",
            "version": "1",
            "stage": earnings_stage,
            "report_period": fundamentals.get("report_period") if fundamentals else None,
            "growth_history": growth_points,
            "cashflow_quality": company_quality.get("cashflow_quality") or [],
            "source_ids": fundamental_ids,
            "missing_fields": (
                (["earnings_revision"] if len(fundamentals_history) >= 4 else ["multi_period_earnings", "earnings_revision", "cashflow_trend"])
                if fundamentals else ["multi_period_earnings", "earnings_revision", "cashflow_trend"]
            ),
        }
        macro_documents = bundle.get("macro_documents") or []
        macro_ids = sorted(
            {source_id for item in macro_documents for source_id in item.get("source_ids") or []}
        )
        macro_indicators = [
            indicator
            for document in macro_documents
            for indicator in _macro_indicators(document)
        ]
        macro_periods = sorted(
            {
                indicator.get("period_end")
                for indicator in macro_indicators
                if indicator.get("period_end")
            }
        )
        macro_published_at = max(
            (item.get("published_at") for item in macro_documents if item.get("published_at")),
            default=None,
        )
        macro_liquidity = {
            "status": (
                "available"
                if len(macro_indicators) >= 2 and macro_periods
                else ("degraded" if macro_documents else "missing")
            ),
            "claim_type": "fact",
            "documents": macro_documents,
            "indicators": macro_indicators,
            "latest_published_at": macro_published_at,
            "published_at": macro_published_at,
            "period_end": macro_periods[-1] if macro_periods else None,
            "source_ids": macro_ids,
            "missing_fields": [
                field
                for field, value in {
                    "macro_indicator_series": macro_indicators,
                    "liquidity_indicator_series": macro_indicators,
                    "period_end": macro_periods,
                }.items()
                if not value
            ],
            "reason": (
                (
                    "正式门户材料含明确的宏观增速事实；仍需连续序列才能提高周期可信度"
                    if macro_indicators
                    else "正式门户材料可用于识别宏观方向，量化序列未取得，不能宣称周期已确认"
                )
                if macro_documents
                else "未取得研究截止前的正式宏观与流动性材料"
            ),
        }
        industry_operating = (
            bundle.get("industry_operating_data")
            if isinstance(bundle.get("industry_operating_data"), dict)
            else {}
        )
        industry_indicators = [
            item
            for item in industry_operating.get("indicators") or []
            if isinstance(item, dict)
        ]
        indicator_text = " ".join(
            str(item.get("indicator_name") or "") for item in industry_indicators
        )
        optional_industry_gaps = [
            field
            for field, markers in {
                "inventory": ("库存",),
                "capacity_utilization": ("产能", "开工率", "产量"),
                "product_price": ("价格", "指数", "期货"),
                "industry_demand": ("需求", "消费", "出口"),
            }.items()
            if not any(marker in indicator_text for marker in markers)
        ]
        industry_supply_demand = {
            "status": (
                "available"
                if industry_indicators and industry_operating.get("source_ids")
                else ("degraded" if industry_context.get("status") != "missing" else "missing")
            ),
            "claim_type": "inference",
            "basis": (
                "行业公开经营指标用于识别产量、价格与需求变化；行业相对强弱仅作为市场预期补充"
                if industry_indicators
                else "行业相对强弱只作为市场预期代理，不替代库存、产能利用率、产品价格与需求数据"
            ),
            "method": "industry-operating-signals-v1" if industry_indicators else "industry-expectation-proxy-v1",
            "version": "1",
            "industry": target_industry,
            "relative_change_pct": industry_context.get("relative_change_pct"),
            "policy_documents": industry_policy_documents,
            "operating_indicators": industry_indicators,
            "source_ids": sorted(
                set(industry_ids + policy_ids + (industry_operating.get("source_ids") or []))
            ),
            "missing_fields": [],
            "optional_missing_fields": optional_industry_gaps,
        }
        lifecycle_raw = cls._snapshot_value(target, "industry_lifecycle") if target is not None else None
        lifecycle_source_ids = sorted(set(target_ids + industry_ids))
        if isinstance(lifecycle_raw, dict):
            lifecycle_stage = lifecycle_raw.get("stage") or lifecycle_raw.get("value")
            lifecycle_source_ids = sorted(
                set(lifecycle_source_ids + [item for item in lifecycle_raw.get("source_ids") or [] if isinstance(item, str)])
            )
        else:
            lifecycle_stage = lifecycle_raw if isinstance(lifecycle_raw, str) else None
        industry_lifecycle = {
            "status": "available" if lifecycle_stage and lifecycle_source_ids else "missing",
            "claim_type": "fact",
            "stage": lifecycle_stage,
            "method": "provided-industry-lifecycle-v1",
            "version": "1",
            "source_ids": lifecycle_source_ids,
            "missing_fields": [] if lifecycle_stage and lifecycle_source_ids else ["industry_lifecycle"],
        }
        cycles = {
            "macro_liquidity": macro_liquidity,
            "industry_supply_demand": industry_supply_demand,
            "company_earnings": company_cycle,
            "market_style": market_style,
            "industry_lifecycle": industry_lifecycle,
        }
        cycle_statuses = {item["status"] for item in cycles.values()}
        cycle_context = {
            "status": "available" if cycle_statuses == {"available"} else ("missing" if cycle_statuses == {"missing"} else "degraded"),
            "claim_type": "inference",
            "basis": "四类周期只由各自公开观测或明确缺失字段组成；不以新闻标题替代行业供需",
            "cycles": cycles,
            "source_ids": sorted({sid for item in cycles.values() for sid in item.get("source_ids", [])}),
            "missing_fields": sorted({field for item in cycles.values() for field in item.get("missing_fields", [])}),
        }

        sections = {
            "market_regime": market_regime,
            "industry_context": industry_context,
            "policy_context": policy_context,
            "cycle_context": cycle_context,
            "company_quality": company_quality,
            "capital_positioning": capital_positioning,
            "event_calendar": event_calendar,
            "tradeability": tradeability,
        }
        # Every V2 section exposes the same time/status contract.  Keeping
        # nulls explicit prevents a report renderer from confusing an unknown
        # publication date with an observed market timestamp.
        default_claim_types = {
            "market_regime": "inference",
            "industry_context": "inference",
            "policy_context": "fact",
            "cycle_context": "inference",
            "company_quality": "fact",
            "capital_positioning": "inference",
            "event_calendar": "fact",
            "tradeability": "inference",
        }
        research_cutoff_iso = normalize_asia_datetime(research_cutoff) or str(research_cutoff)
        for name, section in sections.items():
            nested = section.get("cycles") if name == "cycle_context" else None
            nested = nested if isinstance(nested, dict) else {}
            observed_values = [
                section.get("observed_at"),
                *(item.get("observed_at") for item in nested.values() if isinstance(item, dict)),
            ]
            published_values = [
                section.get("published_at") or section.get("latest_published_at"),
                *(item.get("published_at") for item in nested.values() if isinstance(item, dict)),
                *(item.get("latest_published_at") for item in nested.values() if isinstance(item, dict)),
            ]
            period_values = [
                section.get("period_end"),
                *(item.get("period_end") for item in nested.values() if isinstance(item, dict)),
            ]
            section["observed_at"] = max((value for value in observed_values if value), default=None)
            section["published_at"] = max((value for value in published_values if value), default=None)
            section["period_end"] = max((value for value in period_values if value), default=None)
            section["research_cutoff_at"] = research_cutoff_iso
            section.setdefault("claim_type", default_claim_types[name])
            section.setdefault("status", "missing")
            section["availability_status"] = section["status"]
            section.setdefault("source_ids", [])
            section.setdefault("missing_fields", [])
            for cycle in nested.values():
                if not isinstance(cycle, dict):
                    continue
                cycle.setdefault("research_cutoff_at", research_cutoff_iso)
                cycle.setdefault("observed_at", None)
                cycle.setdefault("published_at", cycle.get("latest_published_at"))
                cycle.setdefault("period_end", None)
                cycle.setdefault("claim_type", "inference")
                cycle.setdefault("source_ids", [])
                cycle.setdefault("missing_fields", [])
                cycle["availability_status"] = cycle.get("status", "missing")
        sections["evidence_coverage"] = cls._coverage(bundle, sections)
        return sections

    @staticmethod
    def _coverage(bundle: dict[str, Any], sections: dict[str, dict]) -> dict[str, Any]:
        statuses = {
            name: {
                "status": section.get("status", "missing"),
                "availability_status": section.get("availability_status", section.get("status", "missing")),
                "claim_type": section.get("claim_type", "inference"),
                "observed_at": section.get("observed_at"),
                "published_at": section.get("published_at"),
                "period_end": section.get("period_end"),
                "research_cutoff_at": section.get("research_cutoff_at"),
                "missing_fields": section.get("missing_fields") or [],
                "source_ids": section.get("source_ids") or [],
                "coverage": section.get("coverage"),
            }
            for name, section in sections.items()
        }
        statuses.update(
            {
                "quote": {
                    "status": "available" if bundle.get("quote") else "missing",
                    "missing_fields": [],
                    "source_ids": (bundle.get("quote") or {}).get("source_ids") or [],
                },
                "kline": {
                    "status": "available" if bundle.get("kline_ref") else "missing",
                    "missing_fields": [],
                    "source_ids": sorted(
                        source_id
                        for source in (bundle.get("sources") or [])
                        if "date" in (source.get("fields") or [])
                        for source_id in [source.get("id")]
                        if source_id
                    ),
                },
                "fundamentals": {
                    "status": "available" if bundle.get("fundamentals") else "missing",
                    "missing_fields": [],
                    "source_ids": (bundle.get("fundamentals") or {}).get("source_ids") or [],
                },
                "news": {
                    "status": "available" if bundle.get("news") else "missing",
                    "missing_fields": [],
                    "source_ids": sorted(
                        {
                            source_id
                            for item in bundle.get("news") or []
                            for source_id in item.get("source_ids") or []
                        }
                    ),
                },
                "relative_benchmarks": {
                    "status": (bundle.get("relative_benchmarks") or {}).get(
                        "status", "missing"
                    ),
                    "market_as_of": (bundle.get("relative_benchmarks") or {}).get(
                        "market_as_of"
                    ),
                    "missing_fields": (bundle.get("relative_benchmarks") or {}).get(
                        "missing"
                    )
                    or [],
                    "source_ids": (bundle.get("relative_benchmarks") or {}).get(
                        "source_ids"
                    )
                    or [],
                },
            }
        )

        def gate(name: str, required: list[str]) -> dict[str, Any]:
            missing = [item for item in required if statuses[item]["status"] == "missing"]
            degraded = [item for item in required if statuses[item]["status"] == "degraded"]
            return {
                "status": "insufficient_data" if missing or degraded else "available",
                "required_sections": required,
                "missing_sections": missing,
                "degraded_sections": degraded,
            }

        short = gate(
            "short_term",
            ["quote", "kline", "market_regime", "industry_context", "tradeability"],
        )
        medium_required = ["industry_context", "policy_context", "cycle_context", "event_calendar"]
        medium_missing = [item for item in medium_required if statuses[item]["status"] == "missing"]
        medium_degraded = [item for item in medium_required if statuses[item]["status"] == "degraded"]
        industry_and_cycle_missing = all(
            statuses[item]["status"] == "missing" for item in ("industry_context", "cycle_context")
        )
        medium = {
            "status": "insufficient_data" if industry_and_cycle_missing else ("degraded" if medium_missing or medium_degraded else "available"),
            "required_sections": medium_required,
            "missing_sections": medium_missing,
            "degraded_sections": medium_degraded,
        }
        long_required = ["company_quality", "industry_context", "cycle_context"]
        long_missing = [item for item in long_required if statuses[item]["status"] == "missing"]
        long_degraded = [item for item in long_required if statuses[item]["status"] == "degraded"]
        quality_multi_period_missing = "multi_period_financials" in (sections["company_quality"].get("missing_fields") or [])
        long = {
            "status": "insufficient_data" if long_missing or quality_multi_period_missing else ("degraded" if long_degraded else "available"),
            "required_sections": long_required,
            "missing_sections": long_missing,
            "degraded_sections": long_degraded,
            "missing_fields": ["multi_period_financials"] if quality_multi_period_missing else [],
        }
        return {
            "schema_version": "coverage-v1",
            "sections": statuses,
            "short_term": short,
            "medium_term": medium,
            "long_term": long,
        }

    async def _structured_events(
        self,
        inst: InstrumentRef,
        research_cutoff: str,
        *,
        data_quality: dict[str, Any] | None = None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """Read the provider's structured event feed for the same evidence run.

        This is intentionally optional for backwards compatibility with older
        providers.  When present, its source records are authoritative for the
        event calendar; news remains a compatibility fallback, never a source
        for full-market catalyst screening.
        """
        method = getattr(self.provider, "market_events", None)
        if method is None:
            return [], {"status": "unavailable", "reason": "provider_missing_market_events"}
        cutoff = parse_asia_datetime(research_cutoff)
        if cutoff is None:
            return [], {"status": "unavailable", "reason": "invalid_research_cutoff"}
        window_start = (cutoff - timedelta(days=_STRUCTURED_EVENT_WINDOW_DAYS)).isoformat()
        try:
            capture = await method(
                since=window_start,
                until=research_cutoff,
                symbols=[inst.id],
                limit=500,
            )
        except Exception as exc:
            logger.warning("stock structured events unavailable for {}: {}", inst.id, exc)
            return [], {"status": "unavailable", "reason": "provider_market_events_failed"}
        raw_events = _structured_event_value(capture, "events")
        if raw_events is None and isinstance(capture, (list, tuple)):
            raw_events = list(capture)
        raw_events = raw_events or []
        events = []
        for raw in raw_events:
            event = _structured_event_payload(raw)
            if event.get("instrument_id") not in (None, inst.id):
                continue
            event["instrument_id"] = inst.id
            relation = compare_asia_datetime(event.get("published_at"), research_cutoff)
            if relation is False:
                if data_quality is not None:
                    data_quality.setdefault("excluded_future", []).append(
                        {"section": "event_calendar", "field": "published_at", "value": event.get("published_at"), "reason": "after_research_cutoff"}
                    )
                continue
            if relation is None:
                if data_quality is not None:
                    data_quality.setdefault("unknown_availability", []).append(
                        {"section": "event_calendar", "field": "published_at", "value": event.get("published_at"), "reason": "unparseable_or_missing_public_time"}
                    )
                continue
            events.append(event)
        coverage = {
            "status": "available" if _structured_event_value(capture, "complete", True) else "degraded",
            "window_start": _structured_event_value(capture, "window_start") or window_start,
            "window_end": _structured_event_value(capture, "window_end") or research_cutoff,
            "expected_count": _structured_event_value(capture, "expected_count"),
            "loaded_count": _structured_event_value(capture, "loaded_count", len(raw_events)) or len(raw_events),
            "complete": bool(_structured_event_value(capture, "complete", True)),
            "cache_status": _structured_event_value(capture, "cache_status") or "live",
            "provider": _structured_event_value(capture, "provider") or "market_events",
            "source": "structured_market_events",
        }
        if not events:
            coverage["status"] = "degraded" if coverage["status"] == "degraded" else "available"
        return events, coverage

    async def _section(self, kind: str, missing: list[str], inst: InstrumentRef):
        """Fetch one section; provider failures become missing markers."""
        try:
            if kind == "quote":
                return await self.provider.quote(inst)
            if kind == "kline":
                return await self.provider.kline(
                    inst,
                    limit=max(self.kline_bars, max(BENCHMARK_WINDOWS) + 1),
                )
            if kind == "fundamentals":
                return await self.provider.fundamentals(inst)
            if kind == "news":
                items = await self.provider.news(inst, limit=self.news_limit)
                if not items:
                    missing.append("news")
                    return None
                return items
        except Exception as exc:
            logger.warning("stock evidence section {} unavailable for {}: {}", kind, inst.id, exc)
            missing.append(kind)
            return None
        raise ValueError(f"unknown section {kind!r}")  # pragma: no cover

    @staticmethod
    def _indicator_summary(bars) -> dict:
        closes = [b.close for b in bars]
        highs = [b.high for b in bars]
        lows = [b.low for b in bars]
        volumes = [b.volume for b in bars]
        dif, dea, hist = macd(closes)
        return {
            "ma5": sma(closes, 5)[-1],
            "ma10": sma(closes, 10)[-1],
            "ma20": sma(closes, 20)[-1],
            "ma60": sma(closes, 60)[-1],
            "macd": {"dif": dif[-1], "dea": dea[-1], "hist": hist[-1]},
            "rsi14": rsi(closes, 14)[-1],
            "volume_change_pct": volume_change_pct(volumes, 5),
            "swing": swing_high_low(highs, lows, SWING_WINDOW),
        }

    def _cache_kline(self, inst: InstrumentRef, series) -> dict:
        cache_dir = self.cache_root / "kline"
        cache_dir.mkdir(parents=True, exist_ok=True)
        filename = f"{inst.exchange}_{inst.symbol}.json"
        path = cache_dir / filename
        payload = json.dumps(series.model_dump(by_alias=True), ensure_ascii=False).encode(
            "utf-8"
        )
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "wb") as f:
            f.write(payload)
            f.flush()
        os.replace(tmp, path)
        try:
            _purge_expired_kline_cache(
                cache_dir,
                ttl_days=self.kline_cache_ttl_days,
                now_ts=self._clock().timestamp(),
            )
        except OSError:
            logger.warning("Kline cache TTL purge failed for {}", cache_dir)
        return {
            "cache": filename,
            "content_hash": "sha256:" + hashlib.sha256(payload).hexdigest(),
            "adjust": "qfq",
            "bars": len(series.bars),
            "last_date": series.bars[-1].date,
        }

    # --- file helpers ---

    @staticmethod
    def _load_file(path: Path) -> dict:
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    @staticmethod
    def _atomic_write(path: Path, data: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
        os.replace(tmp, path)
