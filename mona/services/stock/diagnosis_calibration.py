"""Forward-only calibration cohorts for standard AI diagnosis factors."""

from __future__ import annotations

import asyncio
import inspect
import math
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from mona.services.stock.calibration_cohort import (
    CalibrationCohortStore,
    build_validation_records,
    make_cohort_payload,
)
from mona.services.stock.provider import InstrumentRef

BENCHMARK = InstrumentRef(exchange="XSHG", symbol="000985", instrument_type="index")
MIN_CROSS_SECTION = 30
MIN_COVERAGE = 0.8
REQUIRED_COHORTS = 11
DIAGNOSIS_CALIBRATION_VERSION = "diagnosis-forward-cohort-v1"


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _date(value: Any) -> str | None:
    return value[:10] if isinstance(value, str) and value.strip() else None


def _source_id(value: Any) -> str | None:
    source = getattr(value, "source", None)
    source_id = getattr(source, "id", None)
    return source_id if isinstance(source_id, str) and source_id else None


async def _await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


class DiagnosisCalibrationService:
    def __init__(self, *, workspace: str | Path, provider: Any | None):
        self.store = CalibrationCohortStore(workspace)
        self.provider = provider

    async def _benchmark(self) -> tuple[list[dict[str, Any]], str | None]:
        if self.provider is None or not hasattr(self.provider, "kline"):
            return [], None
        try:
            series = await _await(self.provider.kline(BENCHMARK, limit=640))
        except Exception:
            return [], None
        source_id = _source_id(series)
        bars = [
            {
                "date": getattr(bar, "date", None),
                "close": getattr(bar, "close", None),
                "source_ids": [source_id] if source_id else [],
            }
            for bar in getattr(series, "bars", []) or []
        ]
        return bars, source_id

    async def _benchmark_reference(
        self, as_of: str, benchmark_bars: list[dict[str, Any]], benchmark_source_id: str | None
    ) -> dict[str, Any] | None:
        as_of_date = _date(as_of)
        if self.provider is not None and hasattr(self.provider, "quote"):
            try:
                quote = await _await(self.provider.quote(BENCHMARK))
                price = _finite(getattr(quote, "price", None))
                quote_as_of = getattr(quote, "as_of", None)
                source_id = _source_id(quote)
                if price is not None and price > 0 and _date(quote_as_of) == as_of_date and source_id:
                    return {"price": price, "as_of": quote_as_of, "source_ids": [source_id]}
            except Exception:
                pass
        exact = next(
            (bar for bar in benchmark_bars if _date(bar.get("date")) == as_of_date),
            None,
        )
        price = _finite(exact.get("close")) if isinstance(exact, Mapping) else None
        source_ids = exact.get("source_ids") if isinstance(exact, Mapping) else []
        if price is None or price <= 0 or not source_ids:
            return None
        return {
            "price": price,
            "as_of": as_of,
            "source_ids": list(source_ids or ([benchmark_source_id] if benchmark_source_id else [])),
        }

    @staticmethod
    def _mature(cohort: Mapping[str, Any], benchmark_bars: list[dict[str, Any]]) -> bool:
        cohort_date = _date(cohort.get("as_of"))
        window = cohort.get("validation_window")
        if cohort_date is None or isinstance(window, bool) or not isinstance(window, int) or window <= 0:
            return False
        dates = {
            date
            for row in benchmark_bars
            if (date := _date(row.get("date"))) is not None and date > cohort_date
        }
        return len(dates) >= window

    async def _instrument_bars(self, instrument_id: str) -> tuple[str, list[dict[str, Any]]]:
        if self.provider is None or not hasattr(self.provider, "kline") or ":" not in instrument_id:
            return instrument_id, []
        exchange, symbol = instrument_id.split(":", 1)
        try:
            series = await _await(
                self.provider.kline(
                    InstrumentRef(exchange=exchange, symbol=symbol, instrument_type="equity"),
                    limit=640,
                )
            )
        except Exception:
            return instrument_id, []
        source_id = _source_id(series)
        return instrument_id, [
            {
                "date": getattr(bar, "date", None),
                "close": getattr(bar, "close", None),
                "source_ids": [source_id] if source_id else [],
            }
            for bar in getattr(series, "bars", []) or []
        ]

    async def update(self, candidates: Mapping[str, Any]) -> dict[str, Any]:
        records: dict[str, list[dict[str, Any]]] = {
            horizon: [] for horizon in candidates
        }
        progress: dict[str, dict[str, int]] = {}
        for horizon, candidate in candidates.items():
            strategy_id = candidate.get("strategy_id") if isinstance(candidate, Mapping) else None
            count = len(self.store.list(strategy_id)) if isinstance(strategy_id, str) else 0
            progress[horizon] = {
                "cohortCount": count,
                "matureCohortCount": 0,
                "requiredCohortCount": REQUIRED_COHORTS,
            }
        if self.provider is None:
            return {"records": records, "progress": progress}
        benchmark_bars, benchmark_source_id = await self._benchmark()
        if not benchmark_bars:
            return {"records": records, "progress": progress}

        for horizon, raw_candidate in candidates.items():
            if not isinstance(raw_candidate, Mapping):
                continue
            candidate = dict(raw_candidate)
            strategy_id = candidate.get("strategy_id")
            as_of = candidate.get("as_of")
            rows = [row for row in candidate.get("rows") or [] if isinstance(row, Mapping)]
            universe_count = candidate.get("universe_count")
            observed_count = candidate.get("observed_count")
            if not isinstance(strategy_id, str) or not isinstance(as_of, str):
                continue
            existing = self.store.list(strategy_id)
            coverage = (
                observed_count / universe_count
                if isinstance(observed_count, int)
                and isinstance(universe_count, int)
                and universe_count > 0
                else 0.0
            )
            if (
                not any(item.get("as_of") == as_of for item in existing)
                and candidate.get("cohort_eligible") is not False
                and len(rows) >= MIN_CROSS_SECTION
                and coverage >= MIN_COVERAGE
            ):
                reference = await self._benchmark_reference(
                    as_of, benchmark_bars, benchmark_source_id
                )
                if reference is not None:
                    self.store.create(
                        make_cohort_payload(
                            strategy_id=strategy_id,
                            strategy_fingerprint=str(candidate["strategy_fingerprint"]),
                            as_of=as_of,
                            factor_version=str(candidate["factor_version"]),
                            rank_version=str(candidate["rank_version"]),
                            rows=rows,
                            universe_count=int(universe_count),
                            observed_count=int(observed_count),
                            validation_window=int(candidate["validation_window"]),
                            validation_windows=(int(candidate["validation_window"]),),
                            benchmark_reference=reference,
                        )
                    )
                existing = self.store.list(strategy_id)
            mature = [item for item in existing if self._mature(item, benchmark_bars)]
            progress[horizon] = {
                "cohortCount": len(existing),
                "matureCohortCount": len(mature),
                "requiredCohortCount": REQUIRED_COHORTS,
            }
            if not mature:
                continue
            instrument_ids = sorted(
                {
                    str(row.get("instrument_id"))
                    for cohort in mature
                    for row in cohort.get("rows") or []
                    if isinstance(row, Mapping) and isinstance(row.get("instrument_id"), str)
                }
            )
            semaphore = asyncio.Semaphore(8)

            async def load(instrument_id: str) -> tuple[str, list[dict[str, Any]]]:
                async with semaphore:
                    return await self._instrument_bars(instrument_id)

            instrument_bars = dict(
                await asyncio.gather(*(load(instrument_id) for instrument_id in instrument_ids))
            )
            window = int(candidate["validation_window"])
            for cohort in mature:
                result = build_validation_records(
                    cohort,
                    benchmark_bars=benchmark_bars,
                    source_ids=[benchmark_source_id] if benchmark_source_id else [],
                    instrument_bars=instrument_bars,
                )
                if result.get("status") == "complete":
                    records[horizon].extend(
                        row for row in result.get("records") or [] if row.get("window") == window
                    )
            records[horizon].sort(
                key=lambda row: (str(row.get("as_of")), str(row.get("instrument_id")))
            )
        return {"records": records, "progress": progress}


__all__ = [
    "DIAGNOSIS_CALIBRATION_VERSION",
    "DiagnosisCalibrationService",
    "REQUIRED_COHORTS",
]
