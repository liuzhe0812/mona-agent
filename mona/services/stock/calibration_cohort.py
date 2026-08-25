"""Append-only full-universe calibration cohorts for stock selection.

This module stores frozen eligible universes and later full-pool price
observations in SQLite.  It never reconstructs a historical universe from
today's constituents and never invents missing trading dates.
"""

from __future__ import annotations

import hashlib
import json
import math
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Mapping

COHORT_SCHEMA_VERSION = 1
COHORT_DB_NAME = "calibration_cohorts.db"
WINDOWS = (5, 10, 20, 60)
VALIDATION_WINDOWS = (10, 60, 120)


def _hash(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _finite(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    result = float(value)
    return result if math.isfinite(result) else None


def _date(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value[:10]


def _bar_value(bar: Any, name: str) -> Any:
    if isinstance(bar, Mapping):
        return bar.get(name)
    return getattr(bar, name, None)


def _forward_bars(bars: Iterable[Any], *, after: str | None = None) -> list[dict[str, Any]]:
    """Normalize close-only or OHLC bars without inferring missing dates."""
    rows: dict[str, dict[str, Any]] = {}
    for bar in bars or []:
        date = _date(_bar_value(bar, "date") or _bar_value(bar, "as_of"))
        close = _finite(_bar_value(bar, "close"))
        if date is None or close is None or close <= 0 or (after and date <= after):
            continue
        source_ids = _bar_value(bar, "source_ids") or []
        if isinstance(source_ids, str):
            source_ids = [source_ids]
        rows[date] = {
            "date": date,
            "close": close,
            "source_ids": sorted({item for item in source_ids if isinstance(item, str) and item}),
        }
    return [rows[key] for key in sorted(rows)]


class CalibrationCohortStore:
    def __init__(self, workspace: str | Path):
        self.root = Path(workspace).expanduser() / "stock_projects"
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / COHORT_DB_NAME
        self._init()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _init(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS calibration_cohort (
                  cohort_id TEXT PRIMARY KEY,
                  strategy_id TEXT NOT NULL,
                  as_of TEXT NOT NULL,
                  payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS calibration_observation (
                  cohort_id TEXT NOT NULL,
                  instrument_id TEXT NOT NULL,
                  as_of TEXT NOT NULL,
                  payload TEXT NOT NULL,
                  PRIMARY KEY (cohort_id, instrument_id, as_of),
                  FOREIGN KEY (cohort_id) REFERENCES calibration_cohort(cohort_id)
                );
                """
            )

    def create(self, payload: Mapping[str, Any]) -> str:
        cohort_id = str(payload.get("cohort_id") or "")
        if not cohort_id:
            raise ValueError("calibration cohort_id is required")
        encoded = json.dumps(dict(payload), ensure_ascii=False, sort_keys=True)
        with self._connect() as connection:
            existing = connection.execute(
                "SELECT payload FROM calibration_cohort WHERE cohort_id = ?", (cohort_id,)
            ).fetchone()
            if existing is not None:
                if existing["payload"] != encoded:
                    raise ValueError("calibration cohort is immutable")
                return cohort_id
            connection.execute(
                "INSERT INTO calibration_cohort(cohort_id,strategy_id,as_of,payload) VALUES (?,?,?,?)",
                (cohort_id, payload["strategy_id"], payload["as_of"], encoded),
            )
        return cohort_id

    def append_observations(self, cohort_id: str, observations: Iterable[Mapping[str, Any]]) -> int:
        rows = []
        for observation in observations:
            instrument_id = observation.get("instrument_id")
            as_of = observation.get("as_of")
            if not isinstance(instrument_id, str) or not isinstance(as_of, str):
                continue
            rows.append(
                (
                    cohort_id,
                    instrument_id,
                    as_of,
                    json.dumps(dict(observation), ensure_ascii=False, sort_keys=True),
                )
            )
        if not rows:
            return 0
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            inserted = 0
            for cohort_key, instrument_id, as_of, encoded in rows:
                existing = connection.execute(
                    "SELECT payload FROM calibration_observation WHERE cohort_id = ? AND instrument_id = ? AND as_of = ?",
                    (cohort_key, instrument_id, as_of),
                ).fetchone()
                if existing is not None:
                    if existing["payload"] != encoded:
                        raise ValueError("calibration observation is immutable")
                    continue
                connection.execute(
                    "INSERT INTO calibration_observation(cohort_id,instrument_id,as_of,payload) VALUES (?,?,?,?)",
                    (cohort_key, instrument_id, as_of, encoded),
                )
                inserted += 1
            return inserted

    def list(self, strategy_id: str | None = None) -> list[dict[str, Any]]:
        with self._connect() as connection:
            if strategy_id:
                rows = connection.execute(
                    "SELECT cohort_id,payload FROM calibration_cohort WHERE strategy_id = ? ORDER BY as_of,cohort_id",
                    (strategy_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT cohort_id,payload FROM calibration_cohort ORDER BY as_of,cohort_id"
                ).fetchall()
            result = []
            for row in rows:
                payload = json.loads(row["payload"])
                observations = connection.execute(
                    "SELECT payload FROM calibration_observation WHERE cohort_id = ? ORDER BY as_of,instrument_id",
                    (row["cohort_id"],),
                ).fetchall()
                payload["observations"] = [json.loads(item["payload"]) for item in observations]
                result.append(payload)
            return result


def make_cohort_payload(
    *,
    strategy_id: str,
    strategy_fingerprint: str,
    as_of: str,
    factor_version: str,
    rank_version: str,
    rows: list[Mapping[str, Any]],
    universe_count: int,
    observed_count: int,
    validation_window: int = 20,
    validation_windows: Iterable[int] | None = None,
    benchmark_reference: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    frozen_rows = [dict(row) for row in rows]
    windows = sorted(
        {
            int(window)
            for window in (validation_windows or (validation_window,))
            if isinstance(window, int) and not isinstance(window, bool) and window > 0
        }
    )
    if not windows:
        raise ValueError("calibration validation windows are required")
    snapshot_hash = _hash(
        {
            "strategyFingerprint": strategy_fingerprint,
            "asOf": as_of,
            "factorVersion": factor_version,
            "rankVersion": rank_version,
            "validationWindow": validation_window,
            "validationWindows": windows,
            "benchmarkReference": dict(benchmark_reference or {}),
            "rows": frozen_rows,
        }
    )
    cohort_id = f"cohort_{snapshot_hash[:24]}"
    return {
        "schema_version": COHORT_SCHEMA_VERSION,
        "cohort_id": cohort_id,
        "strategy_id": strategy_id,
        "strategy_fingerprint": strategy_fingerprint,
        "as_of": as_of,
        "factor_version": factor_version,
        "rank_version": rank_version,
        "sample_scope": "full_eligible_universe",
        "universe_count": universe_count,
        "observed_count": observed_count,
        "validation_window": validation_window,
        "validation_windows": windows,
        "benchmark_reference_price": (benchmark_reference or {}).get("price"),
        "benchmark_reference_as_of": (benchmark_reference or {}).get("as_of"),
        "benchmark_reference_source_ids": list((benchmark_reference or {}).get("source_ids") or []),
        "snapshot_hash": snapshot_hash,
        "rows": frozen_rows,
    }


def _cohort_windows(cohort: Mapping[str, Any]) -> list[int]:
    raw = cohort.get("validation_windows")
    if not isinstance(raw, (list, tuple)):
        raw = (cohort.get("validation_window"),)
    return sorted(
        {
            int(value)
            for value in raw
            if isinstance(value, int) and not isinstance(value, bool) and value > 0
        }
    )


def _build_kline_validation_records(
    cohort: Mapping[str, Any],
    cohort_rows: list[Mapping[str, Any]],
    *,
    benchmark_bars: Iterable[Any],
    instrument_bars: Mapping[str, Iterable[Any]],
    source_ids: Iterable[str],
) -> dict[str, Any]:
    """Calculate all configured forward windows from exact trading dates."""
    cohort_date = _date(cohort.get("as_of"))
    benchmark = _forward_bars(benchmark_bars, after=cohort_date)
    benchmark_reference = _finite(cohort.get("benchmark_reference_price"))
    benchmark_sources = {
        item
        for item in [*(cohort.get("benchmark_reference_source_ids") or []), *source_ids]
        if isinstance(item, str) and item
    }
    if benchmark_reference is None or not benchmark_sources or cohort_date is None:
        return {"status": "incomplete", "missing_dates": ["benchmark_reference_missing"], "records": []}
    windows = _cohort_windows(cohort)
    if not windows:
        return {"status": "incomplete", "missing_dates": ["validation_window_invalid"], "records": []}
    benchmark_by_date = {row["date"]: row for row in benchmark}
    missing: set[str] = set()
    records: list[dict[str, Any]] = []
    for window in windows:
        dates = sorted(benchmark_by_date)[:window]
        if len(dates) < window:
            missing.add(f"window_{window}_not_mature")
            continue
        benchmark_exit = benchmark_by_date[dates[-1]]
        benchmark_return = benchmark_exit["close"] / benchmark_reference - 1.0
        for row in cohort_rows:
            instrument_id = row.get("instrument_id")
            reference_price = _finite(row.get("reference_price"))
            if not isinstance(instrument_id, str) or reference_price is None or reference_price <= 0:
                missing.add(f"{instrument_id or 'unknown'}:reference_price_missing")
                continue
            row_sources = {
                item for item in (row.get("source_ids") or [])
                if isinstance(item, str) and item
            }
            if not row_sources:
                missing.add(f"{instrument_id}:cohort_source_missing")
                continue
            bars = _forward_bars(instrument_bars.get(instrument_id, ()), after=cohort_date)
            target_by_date = {bar["date"]: bar for bar in bars}
            if any(date not in target_by_date for date in dates):
                missing.add(f"{instrument_id}:window_{window}_not_mature")
                continue
            target_rows = [target_by_date[date] for date in dates]
            target_sources = {
                item for bar in target_rows for item in bar.get("source_ids") or []
            }
            if not target_sources:
                missing.add(f"{instrument_id}:kline_source_missing")
                continue
            target_exit = target_rows[-1]
            outcome_snapshot_hash = _hash(
                {
                    "instrument_id": instrument_id,
                    "window": window,
                    "dates": [
                        {
                            "date": date,
                            "target_close": target_by_date[date]["close"],
                            "target_source_ids": target_by_date[date].get("source_ids") or [],
                            "benchmark_close": benchmark_by_date[date]["close"],
                            "benchmark_source_ids": benchmark_by_date[date].get("source_ids") or [],
                        }
                        for date in dates
                    ],
                }
            )
            records.append(
                {
                    "as_of": cohort["as_of"],
                    "outcome_as_of": dates[-1],
                    "instrument_id": instrument_id,
                    "factor": row.get("composite_score"),
                    "forward_return": (target_exit["close"] / reference_price - 1.0) - benchmark_return,
                    "snapshot_hash": cohort["snapshot_hash"],
                    "factor_version": cohort["factor_version"],
                    "strategy_fingerprint": cohort["strategy_fingerprint"],
                    "report_id": cohort["cohort_id"],
                    "workflow_run_id": cohort["cohort_id"],
                    "factor_id": "composite_score",
                    "factor_direction": "desc",
                    "sample_scope": "full_eligible_universe",
                    "universe_count": cohort["universe_count"],
                    "observed_count": cohort["observed_count"],
                    "source_ids": sorted(row_sources | target_sources | benchmark_sources),
                    "outcome_snapshot_hash": outcome_snapshot_hash,
                    "window": window,
                }
            )
    return {
        "status": "complete" if records and not missing else "incomplete",
        "missing_dates": sorted(missing),
        "records": records if not missing else [],
    }


def build_validation_records(
    cohort: Mapping[str, Any],
    *,
    benchmark_bars: Iterable[Mapping[str, Any]],
    source_ids: Iterable[str] = (),
    instrument_bars: Mapping[str, Iterable[Any]] | None = None,
) -> dict[str, Any]:
    """Build full-cohort forward records without using future report data.

    New cohorts use the supplied immutable daily bars directly.  The old
    observation path remains readable for previously persisted cohorts.
    """
    hash_payload = {
        "strategyFingerprint": cohort.get("strategy_fingerprint"),
        "asOf": cohort.get("as_of"),
        "factorVersion": cohort.get("factor_version"),
        "rankVersion": cohort.get("rank_version"),
        "validationWindow": cohort.get("validation_window"),
        "benchmarkReference": {
            "price": cohort.get("benchmark_reference_price"),
            "as_of": cohort.get("benchmark_reference_as_of"),
            "source_ids": cohort.get("benchmark_reference_source_ids") or [],
        },
        "rows": [dict(row) for row in cohort.get("rows") or [] if isinstance(row, Mapping)],
    }
    # Cohorts written before multi-horizon support have no validation_windows
    # field and must continue to verify against their original hash.
    if "validation_windows" in cohort:
        hash_payload["validationWindows"] = cohort.get("validation_windows") or []
    expected_hash = _hash(hash_payload)
    if expected_hash != cohort.get("snapshot_hash"):
        return {"status": "incomplete", "missing_dates": ["cohort_snapshot_hash_mismatch"], "records": []}
    cohort_rows = [row for row in cohort.get("rows") or [] if isinstance(row, Mapping)]
    if instrument_bars is not None:
        return _build_kline_validation_records(
            cohort,
            cohort_rows,
            benchmark_bars=benchmark_bars,
            instrument_bars=instrument_bars,
            source_ids=source_ids,
        )
    observations = [row for row in cohort.get("observations") or [] if isinstance(row, Mapping)]
    if any(
        not isinstance(row.get("source_ids"), list) or not row.get("source_ids")
        or not isinstance(row.get("snapshot_hash"), str) or not row.get("snapshot_hash")
        for row in observations
    ):
        return {"status": "incomplete", "missing_dates": ["observation_source_closure_missing"], "records": []}
    snapshot_hashes_by_date: dict[str, set[str]] = {}
    for observation in observations:
        observation_date = _date(observation.get("as_of"))
        snapshot_hashes_by_date.setdefault(observation_date or "", set()).add(
            str(observation.get("snapshot_hash"))
        )
    if any(len(values) != 1 for values in snapshot_hashes_by_date.values()):
        return {"status": "incomplete", "missing_dates": ["observation_snapshot_hash_inconsistent"], "records": []}
    benchmark = {
        _date(row.get("date")): _finite(row.get("close"))
        for row in benchmark_bars
        if _date(row.get("date")) and _finite(row.get("close")) is not None
    }
    cohort_date = _date(cohort.get("as_of"))
    benchmark_reference_price = _finite(cohort.get("benchmark_reference_price"))
    benchmark_reference_source_ids = cohort.get("benchmark_reference_source_ids") or []
    if (
        benchmark_reference_price is None
        or not benchmark_reference_source_ids
        or _date(cohort.get("benchmark_reference_as_of")) != cohort_date
    ):
        return {"status": "incomplete", "missing_dates": ["benchmark_reference_missing"], "records": []}
    dates = sorted(date for date in benchmark if cohort_date and date > cohort_date)
    observation_dates = sorted({_date(row.get("as_of")) for row in observations if _date(row.get("as_of"))})
    missing_dates: set[str] = set()
    records: list[dict[str, Any]] = []
    window = int(cohort.get("validation_window") or 20)
    if window <= 0:
        return {"status": "incomplete", "missing_dates": ["validation_window_invalid"], "records": []}
    if len(dates) < window:
        return {"status": "incomplete", "missing_dates": ["window_not_mature"], "records": []}
    required_dates = dates[:window]
    missing_dates.update(date for date in required_dates if date not in observation_dates)
    if missing_dates:
        return {"status": "incomplete", "missing_dates": sorted(missing_dates), "records": []}
    benchmark_entry = benchmark_reference_price
    benchmark_exit = benchmark[required_dates[-1]]
    benchmark_return = benchmark_exit / benchmark_entry - 1.0
    for window in (window,):
        target_date = dates[window - 1]
        benchmark_exit = benchmark[target_date]
        for row in cohort_rows:
            instrument_id = row.get("instrument_id")
            price = _finite(row.get("reference_price"))
            if not isinstance(instrument_id, str) or price is None or price <= 0:
                continue
            if not row.get("source_ids"):
                missing_dates.add("cohort_source_closure_missing")
                continue
            prices = {
                _date(observation.get("as_of")): _finite(observation.get("price"))
                for observation in observations
                if observation.get("instrument_id") == instrument_id
                and _date(observation.get("as_of"))
                and _finite(observation.get("price")) is not None
            }
            if any(date not in prices for date in required_dates):
                missing_dates.add(f"{instrument_id}:missing_price")
                continue
            target_observations = {
                _date(observation.get("as_of")): observation
                for observation in observations
                if observation.get("instrument_id") == instrument_id
                and _date(observation.get("as_of")) in required_dates
            }
            if any(
                not isinstance(target_observations.get(date, {}).get("source_ids"), list)
                or not target_observations.get(date, {}).get("source_ids")
                for date in required_dates
            ):
                missing_dates.add(f"{instrument_id}:missing_source")
                continue
            exit_price = prices[target_date]
            target_source_ids = {
                source_id
                for observation in target_observations.values()
                for source_id in observation.get("source_ids") or []
            }
            outcome_snapshot_hash = _hash(
                {
                    "instrument_id": instrument_id,
                    "dates": [
                        {
                            "date": date,
                            "price": prices[date],
                            "source_ids": sorted(target_observations[date]["source_ids"]),
                            "snapshot_hash": target_observations[date]["snapshot_hash"],
                        }
                        for date in required_dates
                    ],
                }
            )
            records.append(
                {
                    "as_of": cohort["as_of"],
                    "outcome_as_of": target_date,
                    "instrument_id": instrument_id,
                    "factor": row.get("composite_score"),
                    "forward_return": (exit_price / price - 1.0) - benchmark_return,
                    "snapshot_hash": cohort["snapshot_hash"],
                    "factor_version": cohort["factor_version"],
                    "strategy_fingerprint": cohort["strategy_fingerprint"],
                    "report_id": cohort["cohort_id"],
                    "workflow_run_id": cohort["cohort_id"],
                    "factor_id": "composite_score",
                    "factor_direction": "desc",
                    "sample_scope": "full_eligible_universe",
                    "universe_count": cohort["universe_count"],
                    "observed_count": cohort["observed_count"],
                    "source_ids": sorted(
                        set(row.get("source_ids") or [])
                        | set(source_ids)
                        | set(benchmark_reference_source_ids)
                        | target_source_ids
                    ),
                    "outcome_snapshot_hash": outcome_snapshot_hash,
                    "window": window,
                }
            )
    return {
        "status": "complete" if records and not missing_dates else "incomplete",
        "missing_dates": sorted(missing_dates),
        "records": records if not missing_dates else [],
    }
