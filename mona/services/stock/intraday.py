"""Shared contract and parsers for the free intraday market feeds."""

from __future__ import annotations

import math
from datetime import date, datetime, time
from typing import Any, Literal

from mona.config.schema import Base
from mona.services.stock.provenance import CN_TZ, SourceRecord
from mona.services.stock.provider import InstrumentRef, ProviderError

IntradayStatus = Literal[
    "preopen", "trading", "lunch_break", "closed", "suspended", "unavailable"
]
IntradayQuality = Literal["complete", "degraded", "stale", "unavailable"]

_OPEN = time(9, 30)
_MORNING_CLOSE = time(11, 30)
_AFTERNOON_OPEN = time(13, 0)
_CLOSE = time(15, 0)
_MIN_PRICE = 1e-9


class IntradayPoint(Base):
    """One minute bar; volume is 手 and amount is CNY."""

    time: str
    open: float
    high: float
    low: float
    close: float
    price: float
    average: float
    volume: float
    amount: float


class IntradaySeries(Base):
    """One complete provider snapshot for one instrument/trading date."""

    instrument_id: str
    instrument_type: str
    trading_date: str
    previous_close: float
    status: IntradayStatus
    as_of: str | None
    source: SourceRecord
    points: list[IntradayPoint]
    stale: bool = False
    quality: IntradayQuality = "complete"
    error: str | None = None


def _finite(value: Any, name: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid {name}: {value!r}") from exc
    if not math.isfinite(result):
        raise ValueError(f"invalid {name}: {value!r}")
    return result


def _positive(value: Any, name: str) -> float:
    result = _finite(value, name)
    if result <= _MIN_PRICE:
        raise ValueError(f"{name} must be positive")
    return result


def _non_negative(value: Any, name: str) -> float:
    result = _finite(value, name)
    if result < 0:
        raise ValueError(f"{name} must be non-negative")
    return result


def parse_intraday_time(raw: Any, trading_date: str | None = None) -> datetime:
    value = str(raw or "").strip().replace("/", "-")
    if len(value) == 4 and value.isdigit():
        if not trading_date:
            raise ValueError("minute time needs trading_date")
        value = f"{trading_date} {value[:2]}:{value[2:]}"
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"invalid minute time: {raw!r}") from exc
    return (parsed.replace(tzinfo=CN_TZ) if parsed.tzinfo is None else parsed).astimezone(CN_TZ)


def canonical_minute_time(value: datetime) -> str:
    return value.astimezone(CN_TZ).replace(second=0, microsecond=0).isoformat()


def status_at(value: datetime | None = None) -> IntradayStatus:
    local = (value or datetime.now(CN_TZ)).astimezone(CN_TZ).time()
    if time(9, 15) <= local < _OPEN:
        return "preopen"
    if _OPEN <= local <= _MORNING_CLOSE or _AFTERNOON_OPEN <= local <= _CLOSE:
        return "trading"
    if _MORNING_CLOSE < local < _AFTERNOON_OPEN:
        return "lunch_break"
    return "closed"


def status_for_date(trading_date: str, now: datetime | None = None) -> IntradayStatus:
    local_now = (now or datetime.now(CN_TZ)).astimezone(CN_TZ)
    if local_now.weekday() >= 5:
        return "closed"
    return status_at(local_now) if local_now.date().isoformat() == trading_date else "closed"


def _is_session_minute(value: datetime) -> bool:
    local = value.astimezone(CN_TZ).time()
    return _OPEN <= local <= _MORNING_CLOSE or _AFTERNOON_OPEN <= local <= _CLOSE


def validate_intraday_points(
    points: list[IntradayPoint], *, trading_date: str
) -> list[IntradayPoint]:
    """Reject bad points, canonicalize minute timestamps, and last-write dedupe."""

    by_time: dict[str, IntradayPoint] = {}
    for point in points:
        parsed = parse_intraday_time(point.time, trading_date)
        if parsed.date().isoformat() != trading_date or not _is_session_minute(parsed):
            raise ValueError(f"point outside trading session: {point.time}")
        for field in ("open", "high", "low", "close", "price", "average"):
            _positive(getattr(point, field), field)
        for field in ("volume", "amount"):
            _non_negative(getattr(point, field), field)
        if point.high < max(point.open, point.close, point.low):
            raise ValueError(f"high is below OHLC values at {point.time}")
        if point.low > min(point.open, point.close, point.high):
            raise ValueError(f"low is above OHLC values at {point.time}")
        canonical = canonical_minute_time(parsed)
        by_time[canonical] = point.model_copy(update={"time": canonical})
    return [by_time[key] for key in sorted(by_time)]


def normalize_series(series: IntradaySeries) -> IntradaySeries:
    try:
        trading_date = date.fromisoformat(series.trading_date).isoformat()
    except ValueError as exc:
        raise ValueError(f"invalid trading_date: {series.trading_date!r}") from exc
    previous_close = _positive(series.previous_close, "previous_close")
    points = validate_intraday_points(series.points, trading_date=trading_date)
    if series.as_of:
        parsed_as_of = parse_intraday_time(series.as_of)
        if parsed_as_of.date().isoformat() != trading_date:
            raise ValueError("as_of does not match trading_date")
        as_of = parsed_as_of.isoformat()
    else:
        as_of = points[-1].time if points else None
    return series.model_copy(
        update={
            "trading_date": trading_date,
            "previous_close": previous_close,
            "points": points,
            "as_of": as_of,
        }
    )


def _source(provider: str, url: str, body: bytes, as_of: str | None) -> SourceRecord:
    return SourceRecord.create(
        provider=provider,
        url=url,
        body=body,
        published_at=as_of,
        fields=[
            "trading_date",
            "previous_close",
            "time",
            "open",
            "high",
            "low",
            "close",
            "average",
            "volume",
            "amount",
        ],
    )


def parse_eastmoney_trends(
    payload: Any,
    *,
    instrument: InstrumentRef,
    body: bytes,
    url: str,
    now: datetime | None = None,
) -> IntradaySeries:
    """Parse trends2 rows: time, open, close, high, low, volume, amount, avg."""

    data = payload.get("data") if isinstance(payload, dict) else None
    rows = data.get("trends") if isinstance(data, dict) else None
    if not isinstance(data, dict) or not isinstance(rows, list):
        raise ProviderError(f"invalid East Money intraday data for {instrument.id}")
    points: list[IntradayPoint] = []
    trading_date: str | None = None
    for raw in rows:
        if not isinstance(raw, str):
            continue
        fields = [part.strip() for part in raw.split(",")]
        if len(fields) < 7:
            continue
        try:
            parsed = parse_intraday_time(fields[0])
            trading_date = trading_date or parsed.date().isoformat()
            opening = _positive(fields[1], "open")
            closing = _positive(fields[2], "close")
            high = _positive(fields[3], "high")
            low = _positive(fields[4], "low")
            volume = _non_negative(fields[5], "volume")
            amount = _non_negative(fields[6], "amount")
            average = (
                _positive(fields[7], "average")
                if len(fields) >= 8
                else (amount / (volume * 100) if volume else closing)
            )
            points.append(
                IntradayPoint(
                    time=canonical_minute_time(parsed),
                    open=opening,
                    high=high,
                    low=low,
                    close=closing,
                    price=closing,
                    average=average,
                    volume=volume,
                    amount=amount,
                )
            )
        except (TypeError, ValueError):
            continue
    raw_time = data.get("time")
    if rows and not points:
        raise ProviderError(f"no valid East Money intraday points for {instrument.id}")
    if not trading_date:
        try:
            trading_date = datetime.fromtimestamp(float(raw_time), tz=CN_TZ).date().isoformat()
        except (TypeError, ValueError, OSError):
            trading_date = (now or datetime.now(CN_TZ)).date().isoformat()
    try:
        previous_close = _positive(data.get("preClose", data.get("prePrice")), "previous_close")
    except ValueError as exc:
        raise ProviderError(f"invalid East Money previous close for {instrument.id}") from exc
    try:
        as_of = (
            datetime.fromtimestamp(float(raw_time), tz=CN_TZ).isoformat()
            if raw_time not in (None, "")
            else (points[-1].time if points else None)
        )
    except (TypeError, ValueError, OSError):
        as_of = points[-1].time if points else None
    try:
        return normalize_series(
            IntradaySeries(
                instrument_id=instrument.id,
                instrument_type=instrument.instrument_type,
                trading_date=trading_date,
                previous_close=previous_close,
                status=status_for_date(trading_date, now),
                as_of=as_of,
                source=_source("eastmoney", url, body, as_of),
                points=points,
                quality="complete",
            )
        )
    except ValueError as exc:
        raise ProviderError(f"invalid East Money intraday values for {instrument.id}") from exc


def tx_code(instrument: InstrumentRef) -> str:
    return {"XSHG": "sh", "XSHE": "sz", "BJSE": "bj"}[instrument.exchange] + instrument.symbol


def _previous_close_from_tencent_quote(quote: Any) -> float:
    try:
        value = _positive(quote[4], "previous_close")
    except (IndexError, TypeError, ValueError) as exc:
        raise ProviderError("missing Tencent previous close") from exc
    return value


def parse_tencent_minutes(
    payload: Any,
    *,
    instrument: InstrumentRef,
    body: bytes,
    url: str,
    now: datetime | None = None,
) -> IntradaySeries:
    """Convert Tencent cumulative volume/amount into non-negative increments."""

    root = payload.get("data") if isinstance(payload, dict) else None
    node = root.get(tx_code(instrument)) if isinstance(root, dict) else None
    data = node.get("data") if isinstance(node, dict) else None
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(data, dict) or not isinstance(rows, list):
        raise ProviderError(f"invalid Tencent intraday data for {instrument.id}")
    date_raw = str(data.get("date") or "")
    trading_date = (
        f"{date_raw[:4]}-{date_raw[4:6]}-{date_raw[6:8]}"
        if len(date_raw) == 8 and date_raw.isdigit()
        else None
    )
    quote_map = node.get("qt") or {}
    code = tx_code(instrument)
    # Current Tencent responses use qt["sz000001"].  A few older captures
    # used the v_ prefix; keep that only as a compatibility fallback.
    quote = quote_map[code] if code in quote_map else quote_map.get(f"v_{code}")
    previous_close = _previous_close_from_tencent_quote(quote)
    points: list[IntradayPoint] = []
    previous_volume: float | None = None
    previous_amount: float | None = None
    previous_price: float | None = None
    for raw in rows:
        if not isinstance(raw, str):
            continue
        fields = raw.split()
        if len(fields) < 4:
            continue
        try:
            parsed = parse_intraday_time(fields[0], trading_date)
            trading_date = trading_date or parsed.date().isoformat()
            if not _is_session_minute(parsed):
                continue
            price = _positive(fields[1], "price")
            cumulative_volume = _non_negative(fields[2], "cumulative_volume")
            cumulative_amount = _non_negative(fields[3], "cumulative_amount")
            volume = (
                cumulative_volume
                if previous_volume is None or cumulative_volume < previous_volume
                else cumulative_volume - previous_volume
            )
            amount = (
                cumulative_amount
                if previous_amount is None or cumulative_amount < previous_amount
                else cumulative_amount - previous_amount
            )
            opening = previous_price if previous_price is not None else price
            points.append(
                IntradayPoint(
                    time=canonical_minute_time(parsed),
                    open=opening,
                    high=max(opening, price),
                    low=min(opening, price),
                    close=price,
                    price=price,
                    average=(
                        cumulative_amount / (cumulative_volume * 100)
                        if cumulative_volume
                        else price
                    ),
                    volume=volume,
                    amount=amount,
                )
            )
            previous_volume = cumulative_volume
            previous_amount = cumulative_amount
            previous_price = price
        except (TypeError, ValueError):
            continue
    if not trading_date:
        trading_date = (now or datetime.now(CN_TZ)).date().isoformat()
    if rows and not points:
        raise ProviderError(f"no valid Tencent intraday points for {instrument.id}")
    as_of = points[-1].time if points else None
    if not points and isinstance(quote, list) and len(quote) > 30:
        raw_quote_time = str(quote[30] or "")
        if len(raw_quote_time) == 14 and raw_quote_time.isdigit():
            try:
                as_of = datetime.strptime(raw_quote_time, "%Y%m%d%H%M%S").replace(
                    tzinfo=CN_TZ
                ).isoformat()
            except ValueError:
                pass
    try:
        return normalize_series(
            IntradaySeries(
                instrument_id=instrument.id,
                instrument_type=instrument.instrument_type,
                trading_date=trading_date,
                previous_close=previous_close,
                status=status_for_date(trading_date, now),
                as_of=as_of,
                source=_source("tencent", url, body, as_of),
                points=points,
                quality="degraded",
            )
        )
    except ValueError as exc:
        raise ProviderError(f"invalid Tencent intraday values for {instrument.id}") from exc


__all__ = [
    "IntradayPoint",
    "IntradaySeries",
    "IntradayQuality",
    "IntradayStatus",
    "canonical_minute_time",
    "normalize_series",
    "parse_eastmoney_trends",
    "parse_intraday_time",
    "parse_tencent_minutes",
    "status_at",
    "status_for_date",
    "tx_code",
    "validate_intraday_points",
]
