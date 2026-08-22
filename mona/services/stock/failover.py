"""Primary/fallback provider composition (design §7.4).

Quote and kline go to the primary (Tencent — stable, batched); any
:class:`ProviderError` falls through to the secondary (East Money — the
previous single source). Search / fundamentals / news are East-Money-only
capabilities and delegate straight to the fallback. Each returned datum
still carries the :class:`SourceRecord` of the adapter that actually
produced it, so provenance stays truthful per item.
"""

from __future__ import annotations

from mona.services.stock.provider import (
    Fundamentals,
    InstrumentRef,
    InstrumentSearchResult,
    KlineSeries,
    MarketEventCapture,
    MarketSnapshotIncompleteError,
    NewsItem,
    ProviderError,
    Quote,
)


class IntradayFailoverProvider:
    """Dedicated intraday chain: East Money primary, Tencent heat backup."""

    def __init__(self, primary, fallback):
        self.primary = primary
        self.fallback = fallback
        self.name = f"{primary.name}+{fallback.name}"

    async def intraday(self, inst: InstrumentRef):
        try:
            return await self.primary.intraday(inst)
        except ProviderError:
            return await self.fallback.intraday(inst)


class FailoverProvider:
    def __init__(self, primary, fallback):
        self.primary = primary
        self.fallback = fallback
        self.name = f"{primary.name}+{fallback.name}"

    async def quote(self, inst: InstrumentRef) -> Quote:
        try:
            return await self.primary.quote(inst)
        except ProviderError:
            return await self.fallback.quote(inst)

    async def quotes(self, insts: list[InstrumentRef]) -> dict[str, Quote | ProviderError]:
        results = await self.primary.quotes(insts)
        missing = [inst for inst in insts if not isinstance(results.get(inst.id), Quote)]
        if missing:
            results.update(await self.fallback.quotes(missing))
        return results

    async def market_snapshot(self, *, limit: int = 5000):
        """Use whichever configured provider exposes a market snapshot."""
        for provider in (self.primary, self.fallback):
            method = getattr(provider, "market_snapshot", None)
            if method is None:
                continue
            try:
                return await method(limit=limit)
            except MarketSnapshotIncompleteError:
                # A partial page sequence is evidence, not a provider-level
                # outage.  Preserve its rows/expected count so the evidence
                # layer can mark breadth as degraded; falling through here
                # would silently discard the only coverage signal.
                raise
            except ProviderError:
                continue
        raise ProviderError("no configured provider exposes a market snapshot")

    async def kline(self, inst: InstrumentRef, *, limit: int = 120, klt: int = 101) -> KlineSeries:
        try:
            return await self.primary.kline(inst, limit=limit, klt=klt)
        except ProviderError:
            return await self.fallback.kline(inst, limit=limit, klt=klt)

    # East-Money-only capabilities.

    async def search(self, keyword: str, *, limit: int = 10) -> list[InstrumentSearchResult]:
        return await self.fallback.search(keyword, limit=limit)

    async def fundamentals(self, inst: InstrumentRef) -> Fundamentals:
        return await self.fallback.fundamentals(inst)

    async def fundamentals_history(
        self, inst: InstrumentRef, *, limit: int = 12
    ) -> list[Fundamentals]:
        return await self.fallback.fundamentals_history(inst, limit=limit)

    async def news(self, inst: InstrumentRef, *, limit: int = 10) -> list[NewsItem]:
        return await self.fallback.news(inst, limit=limit)

    async def market_events(
        self,
        *,
        since: str,
        until: str,
        symbols: list[str] | None = None,
        limit: int = 5000,
    ) -> MarketEventCapture:
        """Delegate only to providers that explicitly implement events."""
        configured = False
        last_error: ProviderError | None = None
        for provider in (self.primary, self.fallback):
            method = getattr(provider, "market_events", None)
            if not callable(method):
                continue
            configured = True
            try:
                return await method(
                    since=since,
                    until=until,
                    symbols=symbols,
                    limit=limit,
                )
            except ProviderError as exc:
                last_error = exc
        if not configured:
            raise ProviderError("no configured provider exposes market events")
        raise ProviderError(
            f"market events unavailable from configured providers: {last_error}"
        ) from last_error
