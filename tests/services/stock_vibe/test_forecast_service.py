from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"


@pytest.fixture(scope="module")
def native_source(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path_factory.mktemp("vibe-native") / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert any(patch["path"] == "0034-daily-forecast-cache.json" for patch in receipt["patches"])
    assert any(patch["path"] == "0035-directional-curve.json" for patch in receipt["patches"])
    return source


def _run_probe(source: Path, home: Path, probe: str) -> dict:
    home.mkdir()
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {
            "PATH",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "HOME",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
        }
    }
    environment.update(
        PYTHONPATH=str(source / "agent"),
        PYTHONUTF8="1",
        PYTHONDONTWRITEBYTECODE="1",
        PYTHONNOUSERSITE="1",
        VIBE_TRADING_HOME=str(home),
        VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1",
    )
    result = subprocess.run(
        [str(PYTHON), "-c", probe],
        cwd=home,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.splitlines()[-1])


def test_forecast_route_deduplicates_a_real_background_job(
    native_source: Path, tmp_path: Path
) -> None:
    probe = r'''
import json
import threading
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api import mona_forecast_service as service
from src.api import mona_workbench_market as market

entered = threading.Event()
release = threading.Event()
calls = []
symbol = "002460.SZ"

def blocked_compute(requested_symbol, interval, progress):
    calls.append((requested_symbol, interval))
    entered.set()
    if not release.wait(10):
        raise TimeoutError("test worker was not released")
    return {"symbol": requested_symbol, "interval": interval, "status": "ok",
            "experimental": True, "marker": "computed once"}

service.compute_forecast = blocked_compute
app = FastAPI()
market.register_mona_workbench_market(app)
app.dependency_overrides[market.require_auth] = lambda: None
path = "/mona/workbench-forecast?symbol=002460.SZ&interval=1D"
try:
    with TestClient(app) as client:
        first = client.get(path).json()
        assert first["status"] == "pending" and first["experimental"] is True
        assert entered.wait(5)
        second = client.get(path).json()
        assert second["status"] == "pending" and second["experimental"] is True
        assert second["job_id"] == first["job_id"]
        assert len(calls) == 1
        assert service.active_forecast_count() == 1

        release.set()
        deadline = time.monotonic() + 5
        ready = None
        while time.monotonic() < deadline:
            ready = client.get(path).json()
            if ready["status"] != "pending":
                break
            time.sleep(.01)
        assert ready is not None
        assert ready["status"] == "ok" and ready["marker"] == "computed once"
        cached = client.get(path).json()
        assert cached == ready
        assert len(calls) == 1
        assert service.active_forecast_count() == 0
finally:
    release.set()
    service._WORKER.shutdown(wait=True, cancel_futures=True)

print(json.dumps({"pending_deduplicated_ready_cached": True}))
'''
    assert _run_probe(native_source, tmp_path / "worker-home", probe)[
        "pending_deduplicated_ready_cached"
    ]


def test_daily_prepare_excludes_today_when_quote_is_stale_after_close(
    native_source: Path, tmp_path: Path
) -> None:
    probe = r'''
import json
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pandas as pd
from src.api import mona_forecast_service as service
from src.api import mona_workbench_market as market

now = datetime(2026, 10, 16, 15, 1, tzinfo=ZoneInfo("Asia/Shanghai"))
days = [{"date": "20261016", "data": ["1458 10 100 1000", "1459 10.1 110 1111",
                                      "1500 10.2 120 1235"]}]
quote = {"price": 10.1, "previous_close": 10.0, "change": 0.1,
         "change_pct": 1.0, "name": "测试股票", "as_of": "2026-10-16T14:59:00+08:00"}
dates = pd.to_datetime(["2026-10-15", "2026-10-16"])
raw = pd.DataFrame({"open": [9.7, 10.0], "high": [9.9, 10.3], "low": [9.6, 9.9],
                    "close": [9.8, 10.2], "volume": [100, 200]}, index=dates)
adjusted = raw.copy()
adjusted[["open", "high", "low", "close"]] *= .5

def bars(_symbol, _now, adjusted=False, **_kwargs):
    return globals()["adjusted"].copy() if adjusted else raw.copy()

with patch.object(market, "_now", return_value=now), \
     patch.object(market, "_source_days", return_value=(days, quote)), \
     patch.object(market, "_daily_bars", side_effect=bars):
    observed_now, frame, price, returned_quote = service._prepare("002460.SZ", "1D")

assert observed_now == now
assert frame.index[-1].date().isoformat() == "2026-10-15"
assert "2026-10-16" not in {stamp.date().isoformat() for stamp in frame.index}
assert price == 9.8
assert returned_quote["as_of"] == "2026-10-16T14:59:00+08:00"

print(json.dumps({"stale_quote_excludes_incomplete_daily_bar": True}))
'''
    assert _run_probe(native_source, tmp_path / "daily-home", probe)[
        "stale_quote_excludes_incomplete_daily_bar"
    ]


def test_experiment_archive_is_hashed_and_immutable(
    native_source: Path, tmp_path: Path
) -> None:
    probe = r'''
import gzip
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd
from src.api import mona_forecast_service as service
from src.api.mona_forecast_engine import _fit

count = 300
rng = np.random.default_rng(41)
index = pd.bdate_range("2025-01-01", periods=count)
features = pd.DataFrame({"signal": rng.normal(size=count), "noise": rng.normal(size=count)}, index=index)
targets = .006 * features["signal"].to_numpy() + rng.normal(0, .001, count)
frame = pd.DataFrame({"close": 50 * np.exp(np.cumsum(targets))}, index=index)
fitted = _fit("logistic", features, targets)
models = {1: {"model": fitted, "audit": {"selected": "logistic"},
              "validation": {"mae": .001, "samples": 100}}}
coverage = {"source": "native registry", "counts": {"computed": 2}}
training_hash = service._fingerprint(frame)
experiment_id = service._archive_experiment(
    "mona-directional-curve-v4", training_hash, frame, models, coverage
)

directory = Path(os.environ["VIBE_TRADING_HOME"]) / "forecast-evidence"
csv_path = directory / (experiment_id + ".csv.gz")
json_path = directory / (experiment_id + ".json")
csv_before, report_before = csv_path.read_bytes(), json_path.read_bytes()
csv_content = gzip.decompress(csv_before)
assert hashlib.sha256(csv_content).hexdigest() == training_hash
report = json.loads(report_before)
assert report["training_data_fingerprint"] == training_hash

# Same experiment identity with changed content must preserve the first archive.
changed_frame = frame.copy()
changed_frame["close"] *= 1.25
changed_coverage = {"source": "replacement must not be written", "counts": {"computed": 99}}
same_id = service._archive_experiment(
    "mona-directional-curve-v4", training_hash, changed_frame, models, changed_coverage
)
assert same_id == experiment_id
assert csv_path.read_bytes() == csv_before
assert json_path.read_bytes() == report_before

print(json.dumps({"archive_hash_and_write_once": True}))
'''
    assert _run_probe(native_source, tmp_path / "archive-home", probe)[
        "archive_hash_and_write_once"
    ]


def test_service_persists_computed_curve_when_validation_is_worse_than_baseline(
    native_source: Path, tmp_path: Path
) -> None:
    probe = r'''
import json
import sqlite3
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from src.api import mona_forecast_engine as engine
from src.api import mona_forecast_service as service
from src.api import mona_workbench_market as market
from src.api.mona_forecast_store import ForecastStore

now = datetime(2026, 10, 18, 10, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
index = pd.bdate_range(end="2026-10-16", periods=400)
rng = np.random.default_rng(87)
returns = rng.normal(0, .012, len(index))
base_close = 50 * np.exp(np.cumsum(returns))
base = pd.DataFrame({
    "open": base_close * (1 + rng.normal(0, .002, len(index))),
    "high": base_close * 1.012,
    "low": base_close * .988,
    "close": base_close,
    "volume": rng.integers(100_000, 2_000_000, len(index)).astype(float),
}, index=index)
base["amount"] = base["volume"] * base["close"]

def bars(symbol, _now, adjusted=False, **_kwargs):
    scale = 1.0 if symbol == "002460.SZ" else 1.37
    result = base.copy()
    result[["open", "high", "low", "close", "amount"]] *= scale
    return result

def source(symbol):
    scale = 1.0 if symbol == "002460.SZ" else 1.37
    last, previous = float(base["close"].iloc[-1] * scale), float(base["close"].iloc[-2] * scale)
    return [{"date": "20261016", "data": ["1459 10 100 1000", "1500 10.1 110 1111"]}], \
        {"price": last, "previous_close": previous, "change": last-previous,
                "change_pct": (last/previous-1)*100, "name": "测试股票",
                "as_of": "2026-10-16T15:00:00+08:00"}

def prepared_models(frame, features, horizons, intraday, progress):
    assert not intraday
    feature_name = next(name for name in features.columns
                        if features[name].notna().sum() >= 150 and features[name].nunique() > 2)
    signal = features[[feature_name]].replace([np.inf, -np.inf], np.nan)
    signal = signal.fillna(signal.median())
    target = frame["close"].pct_change(fill_method=None).fillna(0).to_numpy()
    model = engine._fit("logistic", signal, target)
    return {
        step: {
            "model": model, "band": [-.02, .02], "training_rows": len(frame),
            "audit": {"selected_challenger": model.name, "published_model": model.name,
                      "final_selection": {"folds": 2}},
            "validation": {"step": step, "selection_validated": True,
                           "mae": .05, "baseline_mae": .01, "samples": 100,
                           "folds": 3, "beat_baseline": False},
        }
        for step in horizons
    }

engine.build_models = prepared_models
with patch.object(market, "_now", return_value=now), \
     patch.object(market, "_source_days", side_effect=source), \
     patch.object(market, "_daily_bars", side_effect=bars):
    result = service.compute_forecast("002460.SZ", "1D")
    store = ForecastStore()
    with sqlite3.connect(store._database) as connection:
        saved_forecasts = connection.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0]
        saved_daily = connection.execute("SELECT COUNT(*) FROM daily_forecast_results").fetchone()[0]

assert result["status"] == "ok" and result["signal_state"] == "available"
assert [point["step"] for point in result["points"]] == [1, 2, 3, 4, 5]
assert all("return_estimate" in point and "direction_score" in point for point in result["points"])
assert result["selection"]["baseline_selected"] is False
assert result["validation"]["mae"] > result["validation"]["baseline_mae"]
assert result["validation"]["beat_baseline"] is False
assert "forecast_id" in result and "issued_at" in result
assert saved_forecasts == 1 and saved_daily == 1
print(json.dumps({"poor_validation_does_not_suppress_or_discard_computed_curve": True}))
'''
    assert _run_probe(native_source, tmp_path / "service-home", probe)[
        "poor_validation_does_not_suppress_or_discard_computed_curve"
    ]


def test_daily_computed_curve_is_reused_after_process_restart(
    native_source: Path, tmp_path: Path
) -> None:
    probe = r'''
import json
import os
import sqlite3
import subprocess
import sys
from datetime import timedelta
from unittest.mock import patch

import numpy as np
import pandas as pd
from src.api import mona_forecast_engine as engine
from src.api import mona_forecast_service as service
from src.api import mona_workbench_market as market
from src.api.mona_forecast_store import ForecastStore

now = market._now()
close_day = now.date()
if now.hour * 60 + now.minute < 900:
    close_day -= timedelta(days=1)
while close_day.weekday() >= 5:
    close_day -= timedelta(days=1)
index = pd.bdate_range(end=close_day.isoformat(), periods=400)
rng = np.random.default_rng(118)
returns = rng.normal(0, .01, len(index))
close = 40 * np.exp(np.cumsum(returns))
bars = pd.DataFrame({
    "open": close * (1 + rng.normal(0, .002, len(index))),
    "high": close * 1.01, "low": close * .99, "close": close,
    "volume": rng.integers(100_000, 1_000_000, len(index)).astype(float),
}, index=index)
bars["amount"] = bars["close"] * bars["volume"]
stamp = close_day.isoformat() + "T15:00:00+08:00"
symbol = "002460.SZ"
quote = {"price": float(close[-1]), "previous_close": float(close[-2]),
         "change": float(close[-1] - close[-2]),
         "change_pct": float((close[-1] / close[-2] - 1) * 100),
         "name": "测试股票", "as_of": stamp}
day_data = [{"date": close_day.strftime("%Y%m%d"),
             "data": ["1459 10 100 1000", "1500 10.1 110 1111"]}]

def bars_leaf(_symbol, _now, adjusted=False, **_kwargs):
    return bars.copy()

def source_leaf(_symbol):
    return day_data, quote

def computed_models(frame, features, horizons, intraday, progress):
    assert not intraday
    feature_name = next(name for name in features.columns
                        if features[name].notna().sum() >= 150 and features[name].nunique() > 2)
    signal = features[[feature_name]].replace([np.inf, -np.inf], np.nan)
    signal = signal.fillna(signal.median())
    target = frame["close"].pct_change(fill_method=None).fillna(0).to_numpy()
    model = engine._fit("logistic", signal, target)
    return {
        step: {
            "model": model, "band": [-.02, .02], "training_rows": len(frame),
            "audit": {"selected_challenger": model.name, "published_model": model.name,
                      "final_selection": {"folds": 2}},
            "validation": {"step": step, "selection_validated": True,
                           "mae": .05, "baseline_mae": .01, "samples": 100,
                           "folds": 3, "beat_baseline": False},
        }
        for step in horizons
    }

engine.build_models = computed_models
with patch.object(market, "_now", return_value=now), \
     patch.object(market, "_source_days", side_effect=source_leaf), \
     patch.object(market, "_daily_bars", side_effect=bars_leaf):
    first = service.compute_forecast(symbol, "1D")

assert first["status"] == "ok" and first["signal_state"] == "available"
assert [point["step"] for point in first["points"]] == [1, 2, 3, 4, 5]
assert first["validation"]["mae"] > first["validation"]["baseline_mae"]
first_points = first["points"]
assert first["computed_at"] and first["generation"] == {"policy": "daily", "reused": False}
assert "forecast_id" in first and "issued_at" in first
database = ForecastStore()._database
with sqlite3.connect(database) as connection:
    assert connection.execute("SELECT COUNT(*) FROM daily_forecast_results").fetchone()[0] == 1
    assert connection.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0] == 1

second_process = r"""
import json
import sqlite3
import sys
import threading
from src.api import mona_forecast_engine as engine
from src.api import mona_forecast_service as service
from src.api.mona_forecast_store import ForecastStore

assert not service._MODELS and not service._JOBS
def must_not_recompute(*_args, **_kwargs):
    raise AssertionError("daily cache miss invoked source preparation or training")
service._prepare = must_not_recompute
engine.build_models = must_not_recompute
symbol = "002460.SZ"
cached = service.request_forecast(symbol, "1D")
assert cached["status"] == "ok" and cached["status"] != "pending"
assert cached["computed_at"] == sys.argv[1]
assert cached["signal_state"] == "available"
assert cached["points"] == json.loads(sys.argv[2])
assert cached["generation"] == {"policy": "daily", "reused": True}
assert "forecast_id" in cached and "issued_at" in cached
store = ForecastStore()
with sqlite3.connect(store._database) as connection:
    assert connection.execute("SELECT COUNT(*) FROM daily_forecast_results").fetchone()[0] == 1
    assert connection.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0] == 1

# A daily row for this stock must not satisfy an intraday request.
entered, release = threading.Event(), threading.Event()
def blocked_compute(requested_symbol, interval, progress):
    assert requested_symbol == symbol and interval == "intraday"
    entered.set()
    if not release.wait(10):
        raise TimeoutError("intraday worker was not released")
    return {"symbol": symbol, "interval": interval, "status": "unavailable"}
service.compute_forecast = blocked_compute
try:
    intraday = service.request_forecast(symbol, "intraday")
    assert intraday["status"] == "pending"
    assert entered.wait(5)
    assert service.active_forecast_count() == 1
finally:
    release.set()
    service._WORKER.shutdown(wait=True, cancel_futures=True)
assert service.active_forecast_count() == 0
print(json.dumps({"restart_reused_computed_curve_and_intraday_bypassed_daily_cache": True}))
"""
child_env = os.environ.copy()
second = subprocess.run(
    [sys.executable, "-c", second_process, first["computed_at"], json.dumps(first_points)],
    cwd=os.environ["VIBE_TRADING_HOME"], env=child_env, capture_output=True,
    text=True, encoding="utf-8", timeout=30, check=False,
)
assert second.returncode == 0, second.stdout + second.stderr
print(second.stdout.splitlines()[-1])
'''
    assert _run_probe(native_source, tmp_path / "daily-restart-home", probe)[
        "restart_reused_computed_curve_and_intraday_bypassed_daily_cache"
    ]


def test_daily_cache_expiry_tracks_the_next_market_close(
    native_source: Path, tmp_path: Path
) -> None:
    probe = r'''
import json
from datetime import datetime
from zoneinfo import ZoneInfo
from src.api.mona_forecast_service import _daily_valid_until

tz = ZoneInfo("Asia/Shanghai")
friday_close = _daily_valid_until(datetime(2026, 10, 16, 16, 0, tzinfo=tz), "2026-10-16")
monday_intraday = _daily_valid_until(datetime(2026, 10, 19, 10, 0, tzinfo=tz), "2026-10-19")
monday_stale = _daily_valid_until(datetime(2026, 10, 19, 15, 1, tzinfo=tz), "2026-10-16")
assert friday_close == "2026-10-19T15:00:00+08:00"
assert monday_intraday == "2026-10-19T15:00:00+08:00"
assert monday_stale == "2026-10-19T15:02:00+08:00"
print(json.dumps({"daily_cache_expires_at_market_close": True}))
'''
    assert _run_probe(native_source, tmp_path / "daily-expiry-home", probe)[
        "daily_cache_expires_at_market_close"
    ]


def test_cached_intraday_curve_drops_elapsed_minutes(
    native_source: Path, tmp_path: Path
) -> None:
    probe = r'''
import json
from datetime import datetime
from zoneinfo import ZoneInfo
from src.api.mona_forecast_service import _current_result

now = datetime(2026, 10, 19, 9, 31, 30, tzinfo=ZoneInfo("Asia/Shanghai"))
cached = {
    "symbol": "002460.SZ", "interval": "intraday", "status": "ok",
    "points": [
        {"step": 1, "trade_date": "2026-10-19T09:31:00+08:00", "price": 10.1},
        {"step": 5, "trade_date": "2026-10-19T09:32:00+08:00", "price": 10.2},
    ],
    "validation": {"step": 1, "mae": .1, "by_horizon": [
        {"step": 1, "mae": .1}, {"step": 5, "mae": .5},
    ]},
    "audit": {"private": "removed from public copy"},
}
current = _current_result(cached, now)
assert [point["step"] for point in current["points"]] == [5]
assert current["validation"]["step"] == 5 and current["validation"]["mae"] == .5
assert "audit" not in current

expired = _current_result({**cached, "points": cached["points"][:1]}, now)
assert expired["status"] == "unavailable"
assert expired["reason_code"] == "intraday_no_future_minutes"
assert expired["points"] == []
print(json.dumps({"cached_intraday_points_are_filtered_against_current_time": True}))
'''
    assert _run_probe(native_source, tmp_path / "intraday-expiry-home", probe)[
        "cached_intraday_points_are_filtered_against_current_time"
    ]
