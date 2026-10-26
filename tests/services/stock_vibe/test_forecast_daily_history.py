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
    source = tmp_path_factory.mktemp("vibe-daily-history") / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert any(patch["path"] == "0036-daily-return-history.json" for patch in receipt["patches"])
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
        timeout=90,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.splitlines()[-1])


_SETUP = r'''
import json
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from backtest.loaders.tencent_loader import DataLoader
from src.api import mona_forecast_service as service
from src.api import mona_workbench_market as market

NOW = datetime(2026, 10, 19, 10, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
INDEX = pd.bdate_range("2023-01-02", "2026-10-19")
I = np.arange(len(INDEX), dtype=float)
CLOSE = 20 + I * .01 + np.sin(I / 17) * .2
RAW = pd.DataFrame({
    "open": CLOSE * .999,
    "high": CLOSE * 1.01,
    "low": CLOSE * .99,
    "close": CLOSE,
    "volume": 100_000 + I * 10,
}, index=INDEX)

def qfq_frame(kind, suffix_rows=0):
    frame = RAW.copy()
    price_columns = ["open", "high", "low", "close"]
    if kind == "equal":
        return frame
    if kind == "suffix":
        cutoff = len(frame) - suffix_rows
        factors = np.linspace(.55, .9, cutoff)
        frame.loc[INDEX[:cutoff], price_columns] = RAW.loc[INDEX[:cutoff], price_columns].mul(factors, axis=0)
        frame.loc[INDEX[cutoff]:, price_columns] = RAW.loc[INDEX[cutoff]:, price_columns]
        return frame
    if kind in {"no_suffix", "no_qfq_source"}:
        frame.loc[:, price_columns] *= .8
        return frame
    if kind == "misaligned":
        frame.loc[:, price_columns] *= .8
        return frame.drop(index=INDEX[200])
    raise AssertionError(kind)

def install_market(symbol, kind, suffix_rows=0):
    adjusted = qfq_frame(kind, suffix_rows)
    requests = []

    def request_page(_loader, code, start_date, end_date, forward_adjusted=True):
        requests.append((bool(forward_adjusted), end_date))
        source = adjusted if forward_adjusted else RAW
        source = source.loc[(source.index >= pd.Timestamp(start_date)) &
                            (source.index <= pd.Timestamp(end_date))]
        page = source.tail(500).copy()
        page.attrs["price_series"] = (
            "day" if forward_adjusted and kind == "no_qfq_source"
            else "qfqday" if forward_adjusted
            else "day"
        )
        return page

    quote = {
        "price": float(RAW.iloc[-1]["close"]),
        "previous_close": float(RAW.iloc[-2]["close"]),
        "change": float(RAW.iloc[-1]["close"] - RAW.iloc[-2]["close"]),
        "change_pct": float((RAW.iloc[-1]["close"] / RAW.iloc[-2]["close"] - 1) * 100),
        "name": "测试股票",
        "as_of": NOW.isoformat(),
    }
    with patch.object(market, "_now", return_value=NOW), \
         patch.object(market, "_source_days", return_value=([], quote)), \
         patch.object(DataLoader, "_request_page", new=request_page):
        result = service._prepare(symbol, "1D")
    return result, requests, quote
'''


def test_daily_prepare_uses_completed_cutoff_and_retains_equal_price_suffix(
    native_source: Path, tmp_path: Path
) -> None:
    # Keep the loader-call assertions in the same native process as _prepare.
    probe = _SETUP + r'''
prepared, requests, quote = install_market("600732.SH", "suffix", suffix_rows=810)
now, frame, price, _returned_quote = prepared
completed = "2026-10-16"
assert now == NOW
assert quote["as_of"] == "2026-10-19T10:00:00+08:00"
assert frame.index[-1].date().isoformat() == completed
assert frame.index[0] == INDEX[-810]
assert len(frame) == 809
assert price == float(RAW.loc[pd.Timestamp(completed), "close"])
assert frame.attrs == {
    "adjustment": "none",
    "return_basis": "raw_equals_qfq",
    "excluded_history_rows": len(RAW.loc[:pd.Timestamp(completed)]) - len(frame),
    "raw_source": "tencent",
    "qfq_source": "tencent",
}
qfq_ends = [end for adjusted, end in requests if adjusted]
assert qfq_ends and max(qfq_ends) == completed
assert all(end <= completed for end in qfq_ends)
assert any(not adjusted and end == "2026-10-19" for adjusted, end in requests)
print(json.dumps({"completed_cutoff_and_continuous_equal_suffix": True}))
'''
    result = _run_probe(native_source, tmp_path / "completed-suffix-home", probe)
    assert result["completed_cutoff_and_continuous_equal_suffix"]


def test_daily_prepare_accepts_a_full_history_without_corporate_actions(
    native_source: Path, tmp_path: Path
) -> None:
    probe = _SETUP + r'''
now, frame, price, quote = install_market("600036.SH", "equal")[0]
assert frame.index[-1].date().isoformat() == "2026-10-16"
assert len(frame) > 800
assert frame.attrs == {
    "adjustment": "none", "return_basis": "raw_equals_qfq", "excluded_history_rows": 0,
    "raw_source": "tencent", "qfq_source": "tencent",
}
assert price == float(RAW.loc[pd.Timestamp("2026-10-16"), "close"])
print(json.dumps({"identity_adjustment_preserves_full_history": True}))
'''
    result = _run_probe(native_source, tmp_path / "full-equal-home", probe)
    assert result["identity_adjustment_preserves_full_history"]


def test_daily_prepare_rejects_misaligned_calendar_and_missing_equal_suffix(
    native_source: Path, tmp_path: Path
) -> None:
    probe = _SETUP + r'''
for symbol, kind, message in (
    ("600010.SH", "misaligned", "adjusted return calendars do not align"),
    ("600519.SH", "no_suffix", "adjusted return history unavailable"),
):
    try:
        install_market(symbol, kind)
    except ValueError as exc:
        assert str(exc) == message, (kind, str(exc))
    else:
        raise AssertionError(f"{kind} history should be rejected")
try:
    install_market("600000.SH", "no_qfq_source")
except ValueError:
    pass
else:
    raise AssertionError("the native loader must not treat unadjusted day rows as qfqday")
print(json.dumps({"unsafe_daily_histories_are_rejected": True}))
'''
    result = _run_probe(native_source, tmp_path / "rejected-history-home", probe)
    assert result["unsafe_daily_histories_are_rejected"]


def test_short_valid_suffix_still_fails_native_engine_label_minimum(
    native_source: Path, tmp_path: Path
) -> None:
    probe = _SETUP + r'''
from src.api.mona_forecast_engine import build_models

(_now, frame, _price, _quote), _requests, _source_quote = install_market(
    "002460.SZ", "suffix", suffix_rows=45
)
assert len(frame) < 50
features = pd.DataFrame({"signal": np.arange(len(frame), dtype=float)}, index=frame.index)
try:
    build_models(frame, features, range(1, 6), False)
except ValueError as exc:
    assert "insufficient labeled observations" in str(exc), str(exc)
else:
    raise AssertionError("the native forecast engine must reject fewer than 50 labels")
print(json.dumps({"native_engine_retains_minimum_labeled_rows": True}))
'''
    result = _run_probe(native_source, tmp_path / "short-suffix-home", probe)
    assert result["native_engine_retains_minimum_labeled_rows"]


def test_native_request_page_tags_qfqday_and_raw_day_sources(
    native_source: Path, tmp_path: Path
) -> None:
    probe = r'''
import json
from io import BytesIO
from unittest.mock import patch

from backtest.loaders.tencent_loader import DataLoader

loader = DataLoader()
payload = {
    "code": 0,
    "data": {"sh600732": {
        "qfqday": [["2026-10-16", "8", "8.1", "8.2", "7.9", "100"]],
        "day": [["2026-10-16", "10", "10.1", "10.2", "9.9", "200"]],
    }},
}
def response(_request, **_kwargs):
    return BytesIO(json.dumps(payload).encode("utf-8"))

with patch("urllib.request.urlopen", side_effect=response):
    qfq = loader._request_page("600732.SH", "2026-10-16", "2026-10-16", True)
    raw = loader._request_page("600732.SH", "2026-10-16", "2026-10-16", False)
assert qfq is not None and qfq.iloc[0]["close"] == 8.1
assert qfq.attrs["price_series"] == "qfqday"
assert raw is not None and raw.iloc[0]["close"] == 10.1
assert raw.attrs["price_series"] == "day"

payload["data"]["sh600732"] = {"day": payload["data"]["sh600732"]["day"]}
with patch("urllib.request.urlopen", side_effect=response):
    fallback = loader._request_page("600732.SH", "2026-10-16", "2026-10-16", True)
assert fallback is not None and fallback.iloc[0]["close"] == 10.1
assert fallback.attrs["price_series"] == "day"
print(json.dumps({"native_request_page_proves_qfqday_source": True}))
'''
    result = _run_probe(native_source, tmp_path / "request-page-home", probe)
    assert result["native_request_page_proves_qfqday_source"]


def test_daily_prepare_uses_eastmoney_adjusted_history_when_tencent_qfq_is_missing(
    native_source: Path, tmp_path: Path
) -> None:
    probe = _SETUP + r'''
from backtest.loaders import eastmoney_client

adjusted = qfq_frame("suffix", suffix_rows=810)
tencent_calls = []
eastmoney_calls = []

def tencent_page(_loader, _code, start_date, end_date, forward_adjusted=True):
    tencent_calls.append((forward_adjusted, end_date))
    if forward_adjusted:
        return None  # Tencent WAF-style adjusted series miss; raw pages still work.
    page = RAW.loc[(RAW.index >= pd.Timestamp(start_date)) &
                   (RAW.index <= pd.Timestamp(end_date))].tail(500).copy()
    page.attrs["price_series"] = "day"
    return page

def eastmoney_response(_url, *, params):
    eastmoney_calls.append(dict(params))
    frame = adjusted if params["fqt"] == "1" else RAW
    start = pd.to_datetime(params["beg"])
    end = pd.to_datetime(params["end"])
    frame = frame.loc[(frame.index >= start) & (frame.index <= end)]
    rows = [
        ",".join([
            stamp.strftime("%Y-%m-%d"),
            *(f"{row[column]:.10f}" for column in ("open", "close", "high", "low", "volume")),
            "0",
        ])
        for stamp, row in frame.iterrows()
    ]
    return {"data": {"klines": rows}}

quote = {
    "price": float(RAW.iloc[-1]["close"]),
    "previous_close": float(RAW.iloc[-2]["close"]),
    "change": float(RAW.iloc[-1]["close"] - RAW.iloc[-2]["close"]),
    "change_pct": float((RAW.iloc[-1]["close"] / RAW.iloc[-2]["close"] - 1) * 100),
    "name": "测试股票",
    "as_of": NOW.isoformat(),
}
with patch.object(market, "_now", return_value=NOW), \
     patch.object(market, "_source_days", return_value=([], quote)), \
     patch.object(DataLoader, "_request_page", new=tencent_page), \
     patch.object(eastmoney_client, "get_json", side_effect=eastmoney_response):
    now, frame, price, _returned_quote = service._prepare("600732.SH", "1D")

assert now == NOW
assert frame.index[-1].date().isoformat() == "2026-10-16"
assert frame.index[0] == INDEX[-810]
assert len(frame) == 809
assert frame.attrs == {
    "adjustment": "none",
    "return_basis": "raw_equals_qfq",
    "excluded_history_rows": len(RAW.loc[:pd.Timestamp("2026-10-16")]) - len(frame),
    "raw_source": "tencent",
    "qfq_source": "eastmoney",
}
assert price == float(RAW.loc[pd.Timestamp("2026-10-16"), "close"])
assert any(forward_adjusted and end == "2026-10-16" for forward_adjusted, end in tencent_calls)
assert any(not forward_adjusted and end == "2026-10-19" for forward_adjusted, end in tencent_calls)
assert {item["fqt"] for item in eastmoney_calls} == {"0", "1"}
assert all(item["end"] <= "20261016" for item in eastmoney_calls)
assert len(eastmoney_calls) == 2  # fqt=1 plus its raw fqt=0 converter companion.
print(json.dumps({"eastmoney_adjusted_fallback_keeps_verified_suffix": True}))
'''
    result = _run_probe(native_source, tmp_path / "eastmoney-fallback-home", probe)
    assert result["eastmoney_adjusted_fallback_keeps_verified_suffix"]
