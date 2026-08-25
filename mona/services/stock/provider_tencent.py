"""Tencent (gtimg) public API thin adapter — primary quote/kline source.

Domestic A-share best practice: Tencent's endpoints are the de-facto
fallback for most Chinese market tools — fast, concurrency-tolerant, and
the quote endpoint batches many instruments into ONE request (cutting the
polling fan-out that made East Money throttle us). Coverage here is only
what Tencent serves well: realtime quotes and daily klines (qfq-adjusted).
Search / fundamentals / news stay with East Money (``provider.py``).

Wire formats:
- quote ``qt.gtimg.cn/q=sh600519,sz000001`` → GBK text, one
  ``v_<code>="f0~f1~…"`` line per instrument; index fields used:
  [1] name, [3] latest price, [6] volume (手), [30] yyyymmddhhmmss,
  [32] change %.
- kline ``web.ifzq.gtimg.cn/appstock/app/fqkline/get`` → UTF-8 JSON;
  equities/ETFs key ``qfqday``, indexes key ``day`` (no adjustment);
  rows ``[date, open, close, high, low, volume]`` — same order as
  :class:`KlineBar`.

Every request goes through :func:`secure_fetch` (SSRF + host whitelist +
bounded retry), same as the East Money adapter.
"""

from __future__ import annotations

import asyncio
import re
from datetime import datetime
from typing import Any, Awaitable, Callable

import httpx

from mona.services.stock.provenance import CN_TZ, SourceRecord
from mona.services.stock.provider import (
    DEFAULT_BACKOFF_BASE,
    DEFAULT_MAX_BODY_BYTES,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT,
    InstrumentRef,
    KlineBar,
    KlineSeries,
    ProviderError,
    Quote,
    secure_fetch,
    secure_fetch_json,
)

ALLOWED_HOSTS = frozenset(
    {
        "qt.gtimg.cn",  # realtime quote (batch)
        "web.ifzq.gtimg.cn",  # daily kline
    }
)

_TX_PREFIX = {"XSHG": "sh", "XSHE": "sz", "BJSE": "bj"}

_QUOTE_LINE_RE = re.compile(r'v_([a-z]{2}\d{6})="([^"]*)"')
# Quote payload layout (Tencent public field order; stable for a decade).
_F_NAME = 1
_F_PRICE = 3
_F_PREVIOUS_CLOSE = 4
_F_VOLUME = 6
_F_LIMIT_UP = 47
_F_LIMIT_DOWN = 48
_F_AMOUNT = 37  # upstream unit: ten-thousand CNY
_F_TURNOVER_RATE = 38
_F_TIME = 30
_F_CHANGE_PCT = 32
_F_PE = 39
_F_MARKET_CAP = 45
_F_PB = 46
_F_MIN_LEN = 49

_KLINE_MAX_COUNT = 640  # upstream fqkline ceiling per request

# klt → Tencent fqkline period segment (101 daily / 102 weekly / 103 monthly).
_KLT_PERIOD = {101: "day", 102: "week", 103: "month"}


def tx_code(inst: InstrumentRef) -> str:
    """``sh600519`` / ``sz399001`` / ``bj920001`` style Tencent code."""
    return f"{_TX_PREFIX[inst.exchange]}{inst.symbol}"


class TencentProvider:
    """Thin adapter over Tencent public endpoints."""

    name = "tencent"

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

    async def quote(self, inst: InstrumentRef) -> Quote:
        result = (await self.quotes([inst]))[inst.id]
        if isinstance(result, ProviderError):
            raise result
        return result

    async def quotes(self, insts: list[InstrumentRef]) -> dict[str, Quote | ProviderError]:
        """Batch snapshot in ONE request; per-item failures are isolated as
        :class:`ProviderError` values instead of failing the lot."""
        if not insts:
            return {}
        by_tx = {tx_code(inst): inst for inst in insts}
        url = "https://qt.gtimg.cn/q=" + ",".join(by_tx)
        try:
            body, final_url = await secure_fetch(
                url,
                allowed_hosts=ALLOWED_HOSTS,
                timeout=self._timeout,
                max_body_bytes=self._max_body,
                max_retries=self._max_retries,
                backoff_base=self._backoff_base,
                transport=self._transport,
                sleep=self._sleep,
            )
        except ProviderError as exc:
            # Whole-request failure: mark every instrument, the failover
            # composition retries each against the secondary source.
            return {inst.id: exc for inst in insts}
        text = body.decode("gbk", errors="replace")
        lines = {code: payload for code, payload in _QUOTE_LINE_RE.findall(text)}
        results: dict[str, Quote | ProviderError] = {}
        for code, inst in by_tx.items():
            payload = lines.get(code) or ""
            fields = payload.split("~") if payload else []
            if len(fields) < _F_MIN_LEN:
                results[inst.id] = ProviderError(f"no tencent quote data for {inst.id}")
                continue
            try:
                price = float(fields[_F_PRICE])
                change_pct = float(fields[_F_CHANGE_PCT])
                volume = float(fields[_F_VOLUME])
            except ValueError:
                results[inst.id] = ProviderError(
                    f"malformed tencent quote payload for {inst.id}"
                )
                continue
            raw_time = fields[_F_TIME]
            as_of = None
            if re.fullmatch(r"\d{14}", raw_time):
                as_of = datetime.strptime(raw_time, "%Y%m%d%H%M%S").replace(
                    tzinfo=CN_TZ
                ).isoformat()
            source = SourceRecord.create(
                provider=self.name,
                url=final_url,
                body=body,
                fields=[
                    "price", "change_pct", "volume", "amount", "previous_close",
                    "turnover_rate", "limit_up", "limit_down", "pe", "pb",
                    "market_cap",
                ],
                published_at=as_of,
            )
            results[inst.id] = Quote(
                instrument_id=inst.id,
                instrument_type=inst.instrument_type,
                name=fields[_F_NAME],
                price=price,
                change_pct=change_pct,
                volume=volume,
                amount=(
                    value * 10_000
                    if (value := _optional_float(fields, _F_AMOUNT)) is not None
                    else None
                ),
                previous_close=_optional_float(fields, _F_PREVIOUS_CLOSE),
                turnover_rate=_optional_float(fields, _F_TURNOVER_RATE),
                limit_up=_optional_float(fields, _F_LIMIT_UP),
                limit_down=_optional_float(fields, _F_LIMIT_DOWN),
                pe=_optional_float(fields, _F_PE),
                pb=_optional_float(fields, _F_PB),
                market_cap=(
                    value * 100_000_000
                    if (value := _optional_float(fields, _F_MARKET_CAP)) is not None
                    else None
                ),
                as_of=as_of,
                source=source,
            )
        return results

    async def kline(self, inst: InstrumentRef, *, limit: int = 120, klt: int = 101) -> KlineSeries:
        period = _KLT_PERIOD.get(klt)
        if period is None:
            raise ProviderError(f"unsupported klt {klt!r} (expect 101/102/103)")
        code = tx_code(inst)
        count = max(1, min(limit, _KLINE_MAX_COUNT))
        url = (
            "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
            f"?param={code},{period},,,{count},qfq"
        )
        payload, body, final_url = await secure_fetch_json(
            url,
            allowed_hosts=ALLOWED_HOSTS,
            timeout=self._timeout,
            max_body_bytes=self._max_body,
            max_retries=self._max_retries,
            backoff_base=self._backoff_base,
            transport=self._transport,
            sleep=self._sleep,
        )
        if not isinstance(payload, dict) or payload.get("code") != 0:
            raise ProviderError(f"tencent kline error for {inst.id}: {payload!r}")
        node = (payload.get("data") or {}).get(code) or {}
        rows = node.get(f"qfq{period}") or node.get(period) or []
        if not rows:
            raise ProviderError(f"no tencent kline data for {inst.id}")
        bars: list[KlineBar] = []
        for row in rows:
            # Rows may carry a 7th dividend-info element; first six are
            # date/open/close/high/low/volume (same order as KlineBar).
            if not isinstance(row, list) or len(row) < 6:
                continue
            try:
                bars.append(
                    KlineBar(
                        date=str(row[0]),
                        open=float(row[1]),
                        close=float(row[2]),
                        high=float(row[3]),
                        low=float(row[4]),
                        volume=float(row[5]),
                    )
                )
            except (TypeError, ValueError):
                continue
        if not bars:
            raise ProviderError(f"unparseable tencent kline data for {inst.id}")
        if limit > 0 and len(bars) > limit:
            bars = bars[-limit:]
        source = SourceRecord.create(
            provider=self.name,
            url=final_url,
            body=body,
            fields=["date", "open", "close", "high", "low", "volume"],
            published_at=bars[-1].date,
        )
        return KlineSeries(
            instrument_id=inst.id,
            instrument_type=inst.instrument_type,
            bars=bars,
            source=source,
        )

    async def intraday(self, inst: InstrumentRef):
        """Fetch Tencent's cumulative minute feed for heat-backup use."""
        from mona.services.stock.intraday import parse_tencent_minutes

        url = f"https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={tx_code(inst)}"
        payload, body, final_url = await secure_fetch_json(
            url,
            allowed_hosts=ALLOWED_HOSTS,
            timeout=self._timeout,
            max_body_bytes=self._max_body,
            max_retries=self._max_retries,
            backoff_base=self._backoff_base,
            transport=self._transport,
            sleep=self._sleep,
        )
        if not isinstance(payload, dict) or payload.get("code") != 0:
            raise ProviderError(f"tencent intraday error for {inst.id}: {payload!r}")
        return parse_tencent_minutes(
            payload,
            instrument=inst,
            body=body,
            url=final_url,
        )


def _optional_float(fields: list[str], index: int) -> float | None:
    try:
        value = fields[index]
        return float(value) if value else None
    except (IndexError, ValueError):
        return None
