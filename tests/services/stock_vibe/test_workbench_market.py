from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"
PROBE = r'''
import json
from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pandas as pd
from fastapi import FastAPI
from fastapi.testclient import TestClient
from src.api import mona_workbench_market as market

tz = ZoneInfo("Asia/Shanghai")
symbol = "002460.SZ"
now = datetime(2026, 10, 18, 12, tzinfo=tz)
quote = {"price": 39.29, "previous_close": 40.01, "change": -0.72,
         "change_pct": (39.29 / 40.01 - 1) * 100, "name": "测试股票", "as_of": "2026-10-16T16:14:15+08:00"}
days = [{"date": "20261016", "data": ["0930 41 100 410000", "0931 40.9 120 491800",
         "1130 39 150 608800", "1200 39 151 612700", "1300 39.1 180 726100",
         "1500 39.29 200 804680", "1530 39.29 205 824325"]}]

minutes = market._minute_days(days, now)
assert len(minutes) == 5
assert minutes["volume"].tolist() == [100, 20, 30, 30, 20]
assert minutes.iloc[-1]["trade_date"].isoformat() == "2026-10-16T15:00:00+08:00"
assert market._market_state(minutes, now) == "closed"
before_open = market._minute_days(days, datetime(2026, 10, 16, 9, 30, tzinfo=tz))
assert len(before_open) == 1  # Provider points after the observation time are excluded.

raw = pd.DataFrame({"open": [40, 41], "high": [41, 41.5], "low": [39, 38.7],
                    "close": [40.01, 39.29], "volume": [100, 200]},
                   index=pd.to_datetime(["2026-10-15", "2026-10-16"]))
with patch.object(market, "_now", return_value=now), \
     patch.object(market, "_source_days", return_value=(days, quote)), \
     patch.object(market, "_daily_bars", return_value=raw):
    minute = market.market_snapshot(symbol, "intraday")
    daily = market.market_snapshot(symbol, "1D")
    assert minute["status"] == daily["status"] == "ok"
    assert minute["trading_date"] == daily["trading_date"] == "2026-10-16"
    assert minute["quote"]["previous_close"] == 40.01 != 41
    assert minute["quote"]["change"] == -0.72
    assert daily["adjustment"] == "none" and daily["bars"][-1]["close"] == 39.29

app = FastAPI()
market.register_mona_workbench_market(app)
app.dependency_overrides[market.require_auth] = lambda: None
with TestClient(app) as client, patch.object(market, "_source_days", side_effect=OSError("market source unavailable")):
    invalid_queries = (
        "interval=1D&symbol=../../etc",
        "interval=1W&symbol=002460.SZ",
        "interval=1D&symbol=002460.SZ&url=http://x",
        "interval=1D&symbol=002460.SZ&symbol=600519.SH",
    )
    for query in invalid_queries:
        assert client.get("/mona/workbench-market?" + query).status_code == 422
    response = client.get("/mona/workbench-market?interval=intraday&symbol=002460.SZ")
    assert response.status_code == 200 and response.json()["status"] == "unavailable"
    assert "market source unavailable" not in response.text

print(json.dumps({"minute_source_protocol": True, "market_snapshot": True, "route_validation": True}))
'''


def test_workbench_native_market_and_route_contract(tmp_path: Path) -> None:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert any(patch["path"] == "0032-forecast-abstention.json" for patch in receipt["patches"])
    home = tmp_path / "private-home"
    home.mkdir()
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() in {
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
        VIBE_TRADING_HOME=str(home),
        VIBE_TRADING_HOSTED="1",
        PYTHON_DOTENV_DISABLED="1",
    )
    result = subprocess.run(
        [str(PYTHON), "-c", PROBE],
        cwd=home,
        env=environment,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert all(json.loads(result.stdout.splitlines()[-1]).values())
