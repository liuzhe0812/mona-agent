from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import sys
import types
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT_ROOT = ROOT / "third_party/vibe-trading"
SHANGHAI = ZoneInfo("Asia/Shanghai")


@pytest.fixture(scope="session")
def prepared_store_source(tmp_path_factory: pytest.TempPathFactory) -> Path:
    from tools.stock_vibe.prepare import prepare

    destination = tmp_path_factory.mktemp("forecast-store-source") / "native"
    prepare(SNAPSHOT_ROOT, destination)
    return destination / "agent/src/api/mona_forecast_store.py"


def _load_store(monkeypatch: pytest.MonkeyPatch, runtime_root: Path, source_path: Path):

    src = types.ModuleType("src")
    src.__path__ = []
    config = types.ModuleType("src.config")
    config.__path__ = []
    paths = types.ModuleType("src.config.paths")
    paths.get_runtime_root = lambda: runtime_root
    monkeypatch.setitem(sys.modules, "src", src)
    monkeypatch.setitem(sys.modules, "src.config", config)
    monkeypatch.setitem(sys.modules, "src.config.paths", paths)

    spec = importlib.util.spec_from_file_location("forecast_store_under_test", source_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.ForecastStore()


def _daily_forecast(
    *,
    as_of: str = "2020-01-02",
    price: float = 55.0,
    fingerprint: str = "f" * 64,
    bounds: tuple[float, float] | None = None,
    include_bounds: bool = True,
    model_version: str = "ridge-v1",
):
    lower, upper = bounds or (price - 1, price + 1)
    if not include_bounds:
        lower = upper = None
    return {
        "symbol": "600000.SH",
        "interval": "1D",
        "status": "ok",
        "as_of": as_of,
        "last_price": 50.0,
        "model_version": model_version,
        "data_fingerprint": fingerprint,
        "evaluation_basis": "adjusted_return",
        "points": [{"step": 1, "price": price, "lower": lower, "upper": upper}],
    }


def _daily_cached_result(
    *,
    symbol: str = "600000.SH",
    model_version: str = "adaptive-v2",
    as_of: str = "2026-10-16",
    computed_at: str = "2026-10-16T07:00:00Z",
    signal_state: str = "available",
    prediction_id: str = "prediction-first",
) -> dict:
    return {
        "symbol": symbol,
        "interval": "1D",
        "status": "ok",
        "signal_state": signal_state,
        "model_version": model_version,
        "as_of": as_of,
        "computed_at": computed_at,
        "prediction_id": prediction_id,
        "points": [{"step": 1, "price": 52.0}] if signal_state == "available" else [],
    }


def _set_issued_at(store, forecast_id: str, issued_at: datetime) -> None:
    with closing(sqlite3.connect(store._database)) as connection:
        with connection:
            connection.execute(
                "UPDATE forecasts SET issued_at = ? WHERE forecast_id = ?",
                (issued_at.astimezone(UTC).isoformat().replace("+00:00", "Z"), forecast_id),
            )


def _minute_frame(rows: list[tuple]) -> pd.DataFrame:
    frame = pd.DataFrame(rows, columns=("trade_date", "close", "volume", "amount", "day", "position"))
    frame["trade_date"] = pd.to_datetime(frame["trade_date"])
    return frame


def test_save_is_immutable_idempotent_and_get_returns_latest_cache_entry(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    first = store.save("600000.SH:1D", _daily_forecast())
    identity = json.dumps(
        ["ridge-v1", "600000.SH", "1D", "2020-01-02", "f" * 64],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    expected_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()
    assert first["forecast_id"] == expected_id

    changed_duplicate = _daily_forecast(price=99.0)
    duplicate = store.save("600000.SH:1D", changed_duplicate)
    assert duplicate == first
    assert store.get("600000.SH:1D") == first

    _set_issued_at(store, first["forecast_id"], datetime(2020, 1, 1, tzinfo=UTC))
    latest = store.save("600000.SH:1D", _daily_forecast(as_of="2020-01-03", fingerprint="a" * 64))
    assert latest["forecast_id"] != first["forecast_id"]
    assert store.get("600000.SH:1D") == latest


def test_daily_cache_reuses_available_and_abstained_results_after_reopening(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    available = _daily_cached_result()
    abstained = _daily_cached_result(as_of="2026-10-17", signal_state="abstain", prediction_id="prediction-abstain")
    store.save_daily(available, valid_until="2026-10-17T00:00:00+08:00")
    store.save_daily(abstained, valid_until="2026-10-18T00:00:00+08:00")

    reopened = type(store)()
    assert reopened.get_daily("600000.SH", "adaptive-v2", as_of="2026-10-16") == available
    assert reopened.get_daily("600000.SH", "adaptive-v2", valid_at="2026-10-17T15:59:59Z") == abstained
    assert reopened.get_daily("600000.SH", "adaptive-v2", as_of="2026-10-17", valid_at="2026-10-17T16:00:00Z") is None


def test_daily_cache_keeps_first_result_and_only_extends_expiry(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    first = _daily_cached_result()
    first_expiry = "2026-10-17T00:00:00+08:00"
    store.save_daily(first, valid_until=first_expiry)
    duplicate = _daily_cached_result(
        computed_at="2026-10-16T09:00:00Z",
        signal_state="abstain",
        prediction_id="prediction-recomputed",
    )
    assert store.save_daily(duplicate, valid_until="2026-10-18T00:00:00+08:00") == first
    assert store.save_daily(duplicate, valid_until=first_expiry) == first

    assert store.get_daily("600000.SH", "adaptive-v2", as_of="2026-10-16", valid_at="2026-10-17T15:59:59Z") == first
    assert store.get_daily("600000.SH", "adaptive-v2", as_of="2026-10-16", valid_at="2026-10-17T16:00:00Z") is None


def test_daily_cache_isolates_symbol_version_and_as_of_without_scoring(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    results = [
        _daily_cached_result(as_of="2026-10-16"),
        _daily_cached_result(as_of="2026-10-17", prediction_id="next-day"),
        _daily_cached_result(model_version="adaptive-v3", prediction_id="new-model"),
        _daily_cached_result(symbol="600001.SH", prediction_id="other-symbol"),
    ]
    for result in results:
        store.save_daily(result, valid_until="2026-10-19T00:00:00+08:00")

    assert store.get_daily("600000.SH", "adaptive-v2") == results[1]
    assert store.get_daily("600000.SH", "adaptive-v2", as_of="2026-10-16") == results[0]
    assert store.get_daily("600000.SH", "adaptive-v3") == results[2]
    assert store.get_daily("600001.SH", "adaptive-v2") == results[3]
    assert store.get_daily("600002.SH", "adaptive-v2") is None
    with closing(sqlite3.connect(store._database)) as connection:
        assert connection.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM forecast_scores").fetchone()[0] == 0


def test_forward_score_uses_adjusted_returns_and_rejects_not_due_or_late_issued_forecasts(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    due = store.save("due", _daily_forecast())
    late = store.save("late", _daily_forecast(fingerprint="l" * 64))
    _set_issued_at(store, due["forecast_id"], datetime(2020, 1, 1, tzinfo=UTC))

    today = datetime.now(SHANGHAI).date().isoformat()
    future_day = (datetime.now(SHANGHAI) + timedelta(days=1)).date().isoformat()
    not_due_forecast = {
        **_daily_forecast(as_of=today, fingerprint="n" * 64),
        "points": [{"step": 1, "price": 55.0, "lower": 54.0, "upper": 56.0}],
    }
    not_due = store.save("not-due", not_due_forecast)
    _set_issued_at(store, not_due["forecast_id"], datetime(2020, 1, 1, tzinfo=UTC))

    observations = pd.DataFrame(
        {"close": [100.0, 110.0, 100.0, 101.0]},
        index=["2020-01-02", "2020-01-03", today, future_day],
    )
    summary = store.evaluate("600000.SH", "1D", observations)
    assert summary["status"] == "tracking"
    assert summary["forecasts"] == 3
    assert summary["completed_points"] == 1
    assert summary["mae"] == pytest.approx(0.0)
    assert summary["baseline_mae"] == pytest.approx(0.1)
    assert summary["coverage"] == pytest.approx(1.0)

    with closing(sqlite3.connect(store._database)) as connection:
        scores = connection.execute("SELECT forecast_id, actual_return FROM forecast_scores").fetchall()
    assert scores == [(due["forecast_id"], pytest.approx(0.1))]
    assert late["forecast_id"] not in {row[0] for row in scores}
    assert not_due["forecast_id"] not in {row[0] for row in scores}


def test_coverage_is_prediction_range_hit_rate_and_ignores_missing_ranges(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    outside = store.save(
        "outside",
        _daily_forecast(as_of="2020-01-02", price=50.75, fingerprint="o" * 64, bounds=(50.5, 51.0)),
    )
    inside = store.save(
        "inside",
        _daily_forecast(as_of="2020-01-05", price=55.0, fingerprint="i" * 64, bounds=(54.0, 56.0)),
    )
    no_range = store.save(
        "no-range",
        _daily_forecast(as_of="2020-01-10", fingerprint="n" * 64, include_bounds=False),
    )
    for result in (outside, inside, no_range):
        _set_issued_at(store, result["forecast_id"], datetime(2020, 1, 1, tzinfo=UTC))

    observations = pd.DataFrame(
        {"close": [100.0, 110.0, 100.0, 100.0, 110.0, 100.0, 100.0, 100.0, 100.0, 110.0]},
        index=pd.date_range("2020-01-02", periods=10, freq="D").strftime("%Y-%m-%d"),
    )
    summary = store.evaluate("600000.SH", "1D", observations)
    assert summary["completed_points"] == 3
    assert summary["coverage"] == pytest.approx(0.5)
    assert summary["by_horizon"] == [{
        "step": 1,
        "samples": 3,
        "mae": pytest.approx(0.085 / 3),
        "baseline_mae": pytest.approx(0.1),
        "coverage": pytest.approx(0.5),
    }]
    with closing(sqlite3.connect(store._database)) as connection:
        scores = connection.execute(
            "SELECT forecast_id, range_covered FROM forecast_scores ORDER BY target_trade_date",
        ).fetchall()
    assert scores == [(outside["forecast_id"], 0), (inside["forecast_id"], 1), (no_range["forecast_id"], None)]


def test_forward_validation_filters_model_version(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    first_model = store.save(
        "ridge-a",
        _daily_forecast(price=50.5, fingerprint="a" * 64, bounds=(50.0, 51.0), model_version="ridge-a"),
    )
    second_model = store.save(
        "ridge-b",
        _daily_forecast(price=55.0, fingerprint="b" * 64, bounds=(54.0, 56.0), model_version="ridge-b"),
    )
    for result in (first_model, second_model):
        _set_issued_at(store, result["forecast_id"], datetime(2020, 1, 1, tzinfo=UTC))
    observations = pd.DataFrame({"close": [100.0, 110.0]}, index=["2020-01-02", "2020-01-03"])

    first_summary = store.evaluate("600000.SH", "1D", observations, model_version="ridge-a")
    second_summary = store.evaluate("600000.SH", "1D", observations, model_version="ridge-b")
    combined = store.evaluate("600000.SH", "1D", observations)

    assert first_summary["forecasts"] == first_summary["completed_points"] == 1
    assert second_summary["forecasts"] == second_summary["completed_points"] == 1
    assert first_summary["mae"] == pytest.approx(0.09)
    assert second_summary["mae"] == pytest.approx(0.0)
    assert combined["forecasts"] == combined["completed_points"] == 2
    assert combined["mae"] == pytest.approx(0.045)


def test_merge_minutes_deduplicates_updates_changes_and_isolates_symbols(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    day = "2025-02-03"
    first_batch = _minute_frame([
        (f"{day}T09:30:00+08:00", 10.0, 100.0, 1000.0, day, 0),
        (f"{day}T09:31:00+08:00", 10.1, 120.0, 1212.0, day, 1),
    ])
    first = store.merge_minutes("600000.SH", first_batch)
    assert list(first.columns) == ["trade_date", "close", "volume", "amount", "day", "position"]
    assert isinstance(first.index, pd.RangeIndex)
    assert str(first["trade_date"].dt.tz) == "Asia/Shanghai"

    with closing(sqlite3.connect(store._database)) as observer:
        before = observer.execute("PRAGMA data_version").fetchone()[0]
        duplicate = store.merge_minutes("600000.SH", first_batch.copy())
        after = observer.execute("PRAGMA data_version").fetchone()[0]
    assert after == before
    assert len(duplicate) == 2

    second_batch = _minute_frame([
        (f"{day}T09:31:00+08:00", 10.2, 130.0, 1326.0, day, 1),
        (f"{day}T09:32:00+08:00", 10.3, 90.0, 927.0, day, 2),
    ])
    revised = store.merge_minutes("600000.SH", second_batch)
    other_symbol = store.merge_minutes("600001.SH", first_batch.iloc[:1].copy())

    assert len(revised) == 3
    assert revised["close"].tolist() == [10.0, 10.2, 10.3]
    assert revised["amount"].tolist() == [1000.0, 1326.0, 927.0]
    assert revised["day"].tolist() == [day, day, day]
    assert revised["position"].tolist() == [0, 1, 2]
    assert len(other_symbol) == 1
    assert len(store.merge_minutes("600001.SH", first_batch.iloc[:1].copy())) == 1


def test_merge_minutes_retains_twenty_complete_days_when_current_day_grows(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    days = pd.bdate_range("2025-01-01", periods=20)
    records = []
    for current_day in days:
        day = current_day.strftime("%Y-%m-%d")
        start = current_day.tz_localize(SHANGHAI) + pd.Timedelta(hours=9, minutes=30)
        for position in range(251):
            trade_date = start + pd.Timedelta(minutes=position)
            records.append((trade_date, 10.0 + position / 1000, 100.0, 1000.0, day, position))

    initial = store.merge_minutes("600000.SH", _minute_frame(records))
    last_day = days[-1]
    last_day_text = last_day.strftime("%Y-%m-%d")
    appended_at = last_day.tz_localize(SHANGHAI) + pd.Timedelta(hours=9, minutes=30 + 251)
    after_append = store.merge_minutes(
        "600000.SH",
        _minute_frame([(appended_at, 11.0, 101.0, 1111.0, last_day_text, 251)]),
    )

    first_day_text = days[0].strftime("%Y-%m-%d")
    first_day = after_append.loc[after_append["day"] == first_day_text]
    assert len(initial) == 20 * 251
    assert len(after_append) == 20 * 251 + 1
    assert first_day["position"].tolist() == list(range(251))
    assert after_append["day"].nunique() == 20
    assert after_append.iloc[-1]["position"] == 251


def test_intraday_evaluation_never_crosses_trading_days(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    result = store.save(
        "intraday",
        {
            "symbol": "600000.SH",
            "interval": "intraday",
            "status": "ok",
            "as_of": "2020-01-03T14:59:00+08:00",
            "last_price": 10.0,
            "model_version": "minute-ridge-v1",
            "data_fingerprint": "m" * 64,
            "evaluation_basis": "intraday_raw_return",
            "points": [{"step": 3, "price": 10.1, "lower": 10.0, "upper": 10.2,
                        "trade_date": "2020-01-06T09:31:00+08:00"}],
        },
    )
    _set_issued_at(store, result["forecast_id"], datetime(2020, 1, 1, tzinfo=UTC))
    observations = pd.DataFrame(
        {"close": [10.0, 10.01, 10.02, 10.03]},
        index=pd.to_datetime([
            "2020-01-03T14:59:00+08:00",
            "2020-01-03T15:00:00+08:00",
            "2020-01-06T09:30:00+08:00",
            "2020-01-06T09:31:00+08:00",
        ]),
    )
    summary = store.evaluate("600000.SH", "intraday", observations)
    assert summary["status"] == "waiting"
    assert summary["completed_points"] == 0


def test_intraday_score_waits_until_target_minute_is_complete(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    target = datetime.now(SHANGHAI).replace(second=0, microsecond=0)
    as_of = target - timedelta(minutes=1)
    result = store.save(
        "minute-not-final",
        {
            "symbol": "600000.SH",
            "interval": "intraday",
            "status": "ok",
            "as_of": as_of.isoformat(),
            "last_price": 10.0,
            "model_version": "minute-ridge-v1",
            "data_fingerprint": "u" * 64,
            "evaluation_basis": "intraday_raw_return",
            "points": [{"step": 1, "price": 10.1, "lower": 10.0, "upper": 10.2,
                        "trade_date": target.isoformat()}],
        },
    )
    _set_issued_at(store, result["forecast_id"], (as_of + timedelta(seconds=1)).astimezone(UTC))
    observations = pd.DataFrame(
        {"close": [10.0, 10.1]},
        index=pd.to_datetime([as_of.isoformat(), target.isoformat()]),
    )

    summary = store.evaluate("600000.SH", "intraday", observations)
    assert summary["status"] == "waiting"
    assert summary["completed_points"] == 0


def test_first_forward_score_survives_later_price_revisions(monkeypatch, tmp_path: Path, prepared_store_source: Path) -> None:
    store = _load_store(monkeypatch, tmp_path / "runtime", prepared_store_source)
    result = store.save("revision", _daily_forecast())
    _set_issued_at(store, result["forecast_id"], datetime(2020, 1, 1, tzinfo=UTC))

    initial = pd.DataFrame({"close": [100.0, 110.0]}, index=["2020-01-02", "2020-01-03"])
    first_summary = store.evaluate("600000.SH", "1D", initial)
    revised = pd.DataFrame({"close": [100.0, 120.0]}, index=["2020-01-02", "2020-01-03"])
    revised_summary = store.evaluate("600000.SH", "1D", revised)
    repeated_summary = store.evaluate("600000.SH", "1D", revised)

    assert first_summary["mae"] == pytest.approx(0.0)
    assert revised_summary["mae"] == pytest.approx(0.0)
    assert revised_summary["baseline_mae"] == pytest.approx(0.1)
    assert revised_summary["revised_points"] == repeated_summary["revised_points"] == 1
    with closing(sqlite3.connect(store._database)) as connection:
        score = connection.execute(
            "SELECT actual_price, actual_return, latest_observed_price, revision_count FROM forecast_scores WHERE forecast_id = ?",
            (result["forecast_id"],),
        ).fetchone()
    assert score == (110.0, pytest.approx(0.1), 120.0, 1)
