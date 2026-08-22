"""Cached intraday fetch service and subscription refresh loops."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from datetime import datetime, time, timedelta
from typing import Any

from mona.services.stock.intraday import (
    IntradaySeries,
    normalize_series,
    status_at,
    status_for_date,
)
from mona.services.stock.intraday_storage import IntradayStore
from mona.services.stock.provenance import CN_TZ
from mona.services.stock.provider import InstrumentRef, ProviderError

IntradayEvent = tuple[str, IntradaySeries]


def next_workday_preopen_delay(now: datetime) -> float:
    """Seconds until the next weekday 09:15 in Asia/Shanghai."""

    local = now.astimezone(CN_TZ)
    target_date = local.date()
    preopen = time(9, 15)
    if local.weekday() < 5 and local.time() < preopen:
        target = datetime.combine(target_date, preopen, tzinfo=local.tzinfo)
        return max(0.01, (target - local).total_seconds())
    target_date += timedelta(days=1)
    while target_date.weekday() >= 5:
        target_date += timedelta(days=1)
    target = datetime.combine(target_date, preopen, tzinfo=local.tzinfo)
    return max(0.01, (target - local).total_seconds())


def _clock_status(now: datetime) -> str:
    local = now.astimezone(CN_TZ)
    if local.weekday() >= 5:
        return "closed"
    return status_at(local)


def refresh_delay_for_clock(
    now: datetime,
    *,
    refresh_seconds: float = 5.0,
    preopen_seconds: float = 30.0,
    lunch_seconds: float = 60.0,
) -> float:
    """Return the next delay from the current local market clock.

    The snapshot date is intentionally ignored: before the open a free
    provider may still return the previous trading day's snapshot, but the
    subscription must remain alive until today's session starts.
    """

    local = now.astimezone(CN_TZ)
    status = _clock_status(local)
    if status == "closed":
        return next_workday_preopen_delay(local)
    if status == "preopen":
        delay, boundary_time = preopen_seconds, time(9, 30)
    elif status == "lunch_break":
        delay, boundary_time = lunch_seconds, time(13, 0)
    elif local.time() <= time(11, 30):
        delay, boundary_time = refresh_seconds, time(11, 30)
    else:
        delay, boundary_time = refresh_seconds, time(15, 0)
    boundary = datetime.combine(local.date(), boundary_time, tzinfo=local.tzinfo)
    until_boundary = (boundary - local).total_seconds()
    return max(0.01, min(delay, until_boundary)) if until_boundary > 0 else max(0.01, delay)


def _signature(series: IntradaySeries) -> tuple[Any, ...]:
    """Ignore fetch timestamps while detecting actual chart/state changes."""

    return (
        series.instrument_id,
        series.instrument_type,
        series.trading_date,
        series.previous_close,
        series.status,
        series.as_of,
        series.stale,
        series.quality,
        series.error,
        series.source.provider,
        tuple(point.model_dump_json() for point in series.points),
    )


class IntradayService:
    """Singleflight/cache/subscriber coordinator for one complete snapshot."""

    def __init__(
        self,
        provider: Any,
        store: IntradayStore,
        *,
        refresh_seconds: float = 5.0,
        preopen_seconds: float = 30.0,
        lunch_seconds: float = 60.0,
        now: Callable[[], datetime] | None = None,
    ):
        self.provider = provider
        self.store = store
        self.refresh_seconds = max(0.01, refresh_seconds)
        self.preopen_seconds = max(0.01, preopen_seconds)
        self.lunch_seconds = max(0.01, lunch_seconds)
        self.now = now or (lambda: datetime.now(CN_TZ))
        self._cache: dict[str, IntradaySeries] = {}
        self._updated: dict[str, float] = {}
        self._inflight: dict[str, asyncio.Task[IntradaySeries]] = {}
        self._subscribers: dict[str, set[asyncio.Queue[IntradayEvent]]] = {}
        self._refresh_tasks: dict[str, asyncio.Task[None]] = {}
        self._closed = False

    def _cached(self, instrument_id: str) -> IntradaySeries | None:
        cached = self._cache.get(instrument_id)
        if cached is not None:
            return cached
        cached = self.store.load_latest(instrument_id)
        if cached is not None:
            self._cache[instrument_id] = cached
            self._updated[instrument_id] = asyncio.get_running_loop().time()
        return cached

    def _now(self) -> datetime:
        value = self.now()
        return value

    def _project_status(self, series: IntradaySeries) -> IntradaySeries:
        status = status_for_date(series.trading_date, self._now())
        if series.status == status:
            return series
        return series.model_copy(update={"status": status})

    def _project_cached_status(self, instrument_id: str) -> IntradaySeries | None:
        cached = self._cache.get(instrument_id)
        if cached is None:
            return None
        projected = self._project_status(cached)
        if _signature(projected) != _signature(cached):
            self._cache[instrument_id] = projected
            self._notify(instrument_id, "snapshot", projected)
        return projected

    async def get(
        self, instrument: InstrumentRef, *, force: bool = False
    ) -> IntradaySeries:
        if self._closed:
            raise ProviderError("intraday service is closed")
        cached = self._cached(instrument.id)
        if not force and cached is not None:
            age = asyncio.get_running_loop().time() - self._updated.get(instrument.id, 0.0)
            if age < self.refresh_seconds:
                projected = self._project_status(cached)
                self._cache[instrument.id] = projected
                return projected
        task = self._inflight.get(instrument.id)
        if task is None:
            task = asyncio.create_task(self._refresh_once(instrument))
            self._inflight[instrument.id] = task
        try:
            return await task
        finally:
            if self._inflight.get(instrument.id) is task:
                self._inflight.pop(instrument.id, None)

    async def _refresh_once(self, instrument: InstrumentRef) -> IntradaySeries:
        cached = self._cached(instrument.id)
        try:
            fetched = await self.provider.intraday(instrument)
            fresh = normalize_series(fetched)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            failure = exc if isinstance(exc, ProviderError) else ProviderError(str(exc))
            if cached is None:
                raise failure from exc
            stale = cached.model_copy(
                update={"stale": True, "quality": "stale", "error": str(failure)}
            )
            projected_stale = self._project_status(stale)
            previous = self._project_status(cached)
            self._cache[instrument.id] = projected_stale
            self._updated[instrument.id] = asyncio.get_running_loop().time()
            if _signature(projected_stale) != _signature(previous):
                self._notify(instrument.id, "snapshot", projected_stale)
            return projected_stale

        self.store.upsert(fresh)
        previous = self._cache.get(instrument.id)
        projected_fresh = self._project_status(fresh)
        if previous is None or _signature(self._project_status(previous)) != _signature(projected_fresh):
            self._notify(instrument.id, "snapshot", projected_fresh)
        self._cache[instrument.id] = projected_fresh
        self._updated[instrument.id] = asyncio.get_running_loop().time()
        return projected_fresh

    def _notify(self, instrument_id: str, event: str, series: IntradaySeries) -> None:
        for queue in list(self._subscribers.get(instrument_id, ())):
            try:
                queue.put_nowait((event, series))
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait((event, series))
                except asyncio.QueueFull:
                    pass

    def _refresh_delay(self, series: IntradaySeries) -> float:
        return refresh_delay_for_clock(
            self._now(),
            refresh_seconds=self.refresh_seconds,
            preopen_seconds=self.preopen_seconds,
            lunch_seconds=self.lunch_seconds,
        )

    async def _refresh_loop(self, instrument: InstrumentRef) -> None:
        try:
            while self._subscribers.get(instrument.id):
                if _clock_status(self._now()) == "closed":
                    self._project_cached_status(instrument.id)
                    await asyncio.sleep(
                        refresh_delay_for_clock(
                            self._now(),
                            refresh_seconds=self.refresh_seconds,
                            preopen_seconds=self.preopen_seconds,
                            lunch_seconds=self.lunch_seconds,
                        )
                    )
                    continue
                try:
                    # The first pass reuses the just-delivered REST snapshot;
                    # later passes force a fresh upstream request.  This
                    # avoids an immediate duplicate request on SSE connect.
                    series = await self.get(instrument, force=False)
                except ProviderError:
                    # A connected client receives the previous snapshot via
                    # REST/SSE; retry only while the session is active.
                    series = self._cache.get(instrument.id)
                    if series is None:
                        delay = refresh_delay_for_clock(
                            self._now(),
                            refresh_seconds=self.refresh_seconds,
                            preopen_seconds=self.preopen_seconds,
                            lunch_seconds=self.lunch_seconds,
                        )
                        await asyncio.sleep(delay)
                        continue
                delay = self._refresh_delay(series)
                await asyncio.sleep(delay)
                if not self._subscribers.get(instrument.id):
                    return
                if _clock_status(self._now()) == "closed":
                    continue
                try:
                    await self.get(instrument, force=True)
                except ProviderError:
                    pass
        except asyncio.CancelledError:
            raise
        finally:
            task = self._refresh_tasks.get(instrument.id)
            if task is asyncio.current_task():
                self._refresh_tasks.pop(instrument.id, None)

    async def subscribe(self, instrument: InstrumentRef) -> asyncio.Queue[IntradayEvent]:
        if self._closed:
            raise ProviderError("intraday service is closed")
        queue: asyncio.Queue[IntradayEvent] = asyncio.Queue(maxsize=8)
        subscribers = self._subscribers.setdefault(instrument.id, set())
        subscribers.add(queue)
        task = self._refresh_tasks.get(instrument.id)
        if task is None or task.done():
            self._refresh_tasks[instrument.id] = asyncio.create_task(
                self._refresh_loop(instrument)
            )
        return queue

    async def unsubscribe(
        self, instrument: InstrumentRef, queue: asyncio.Queue[IntradayEvent]
    ) -> None:
        subscribers = self._subscribers.get(instrument.id)
        if subscribers is None:
            return
        subscribers.discard(queue)
        if subscribers:
            return
        self._subscribers.pop(instrument.id, None)
        task = self._refresh_tasks.pop(instrument.id, None)
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._subscribers.clear()
        refresh_tasks = list(self._refresh_tasks.values())
        inflight_tasks = list(self._inflight.values())
        self._refresh_tasks.clear()
        self._inflight.clear()
        for task in [*refresh_tasks, *inflight_tasks]:
            if not task.done():
                task.cancel()
        if refresh_tasks or inflight_tasks:
            await asyncio.gather(*refresh_tasks, *inflight_tasks, return_exceptions=True)
        self._cache.clear()
        self.store.close()


__all__ = [
    "IntradayEvent",
    "IntradayService",
    "next_workday_preopen_delay",
    "refresh_delay_for_clock",
]
