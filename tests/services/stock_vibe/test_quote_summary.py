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

symbol = "002460.SZ"
token = "sz002460"
now = datetime(2026, 10, 16, 15, 0, tzinfo=ZoneInfo("Asia/Shanghai"))


def qt_fields():
    quote = [""] * 53
    quote[1] = "赣锋锂业"
    quote[2] = "002460"
    quote[3] = "39.29"
    quote[4] = "40.01"
    quote[5] = "38.08"
    quote[6] = "175700"
    quote[30] = "20261016150000"
    quote[33] = "38.74"
    quote[34] = "37.74"
    quote[37] = "66900"  # Tencent amount is in ten-thousand yuan.
    quote[38] = "1.45"
    quote[39] = "888"  # The generic P/E field must not replace dynamic P/E.
    quote[44] = "460.3"  # Float market value is in hundred-million yuan.
    quote[45] = "796.7"
    quote[52] = "11.92"
    return quote


def response_for(quote):
    days = [{"date": "20261016", "data": [
        "0930 38.08 100 380800", "1000 38.50 300 1155800",
        "1500 39.29 500 1950000",
    ]}]
    return {"code": 0, "data": {token: {"qt": {token: quote}, "data": days}}}


class Response:
    def __init__(self, payload):
        self.raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, size):
        return self.raw[:size]


class Opener:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return Response(self.payload)


quote = qt_fields()
opener = Opener(response_for(quote))
with patch.object(market.urllib.request, "build_opener", return_value=opener):
    days, parsed = market._source_days(symbol)
assert len(days) == 1
assert parsed["price"] == 39.29 and parsed["previous_close"] == 40.01
assert parsed["change"] == 39.29 - 40.01
assert parsed["name"] == "赣锋锂业"
assert parsed["as_of"] == "2026-10-16T15:00:00+08:00"
assert parsed["open"] == 38.08 and parsed["high"] == 38.74 and parsed["low"] == 37.74
assert parsed["volume"] == 175700  # Preserve the provider's hand unit; do not multiply by 100.
assert parsed["amount"] == 669_000_000
assert parsed["turnover_rate"] == 1.45  # Already a percentage value.
assert parsed["float_market_cap"] == 46_030_000_000
assert parsed["market_cap"] == 79_670_000_000
assert parsed["pe_ratio"] == 11.92 and parsed["pe_label"] == "市盈率(动)"
assert parsed["pe_ratio"] != float(quote[39])

# Missing, empty, placeholder, non-finite and invalid optional fields do not
# discard the valid identity and last-price quote.
malformed = qt_fields()
for index, value in ((5, ""), (33, "--"), (34, None), (6, "NaN"),
                     (37, "inf"), (38, "invalid"), (44, "0"),
                     (45, "-1"), (52, "0")):
    malformed[index] = value
with patch.object(market.urllib.request, "build_opener", return_value=Opener(response_for(malformed))):
    _, partial = market._source_days(symbol)
assert partial["price"] == 39.29 and partial["previous_close"] == 40.01
assert partial["name"] == "赣锋锂业" and partial["as_of"] == "2026-10-16T15:00:00+08:00"
assert all(partial[field] is None for field in (
    "open", "high", "low", "volume", "amount", "turnover_rate",
    "float_market_cap", "market_cap", "pe_ratio",
))

# Older/shorter Tencent quote arrays keep base quote fields and parse the
# optional indicators that are present.
short = qt_fields()[:38]
with patch.object(market.urllib.request, "build_opener", return_value=Opener(response_for(short))):
    _, short_quote = market._source_days(symbol)
assert short_quote["price"] == 39.29 and short_quote["name"] == "赣锋锂业"
assert short_quote["open"] == 38.08 and short_quote["high"] == 38.74
assert short_quote["amount"] == 669_000_000 and short_quote["turnover_rate"] is None
assert short_quote["pe_ratio"] is None

# Zero is valid for turnover, volume, and amount; negative P/E is meaningful.
zero_activity = qt_fields()
for index in (6, 37, 38):
    zero_activity[index] = "0"
zero_activity[52] = "-3.25"
with patch.object(market.urllib.request, "build_opener", return_value=Opener(response_for(zero_activity))):
    _, zero_quote = market._source_days(symbol)
assert zero_quote["volume"] == zero_quote["amount"] == zero_quote["turnover_rate"] == 0
assert zero_quote["pe_ratio"] == -3.25

wrong_identity = qt_fields()
wrong_identity[2] = "600519"
try:
    with patch.object(market.urllib.request, "build_opener", return_value=Opener(response_for(wrong_identity))):
        market._source_days(symbol)
except ValueError as exc:
    assert "security does not match" in str(exc)
else:
    raise AssertionError("quote response for a different security must be rejected")

# Exercise the actual native snapshot and HTTP route. Only the Tencent HTTP
# leaf and daily-history leaf are replaced; quote parsing and projection run.
daily = pd.DataFrame(
    {"open": [38.08], "high": [38.74], "low": [37.74], "close": [39.29], "volume": [175700]},
    index=pd.to_datetime(["2026-10-16"]),
)
route_opener = Opener(response_for(qt_fields()))
app = FastAPI()
market.register_mona_workbench_market(app)
app.dependency_overrides[market.require_auth] = lambda: None
with patch.object(market, "_now", return_value=now), \
     patch.object(market, "_daily_bars", return_value=daily), \
     patch.object(market.urllib.request, "build_opener", return_value=route_opener):
    client = TestClient(app)
    intraday_response = client.get("/mona/workbench-market", params={"symbol": symbol, "interval": "intraday"})
    daily_response = client.get("/mona/workbench-market", params={"symbol": symbol, "interval": "1D"})
    client.close()
assert intraday_response.status_code == daily_response.status_code == 200
intraday, daily_result = intraday_response.json(), daily_response.json()
assert intraday["status"] == daily_result["status"] == "ok"
assert intraday["interval"] == "intraday" and daily_result["interval"] == "1D"
assert intraday["trading_date"] == daily_result["trading_date"] == "2026-10-16"
quote_fields = (
    "price", "previous_close", "change", "change_pct", "name", "as_of",
    "open", "high", "low", "volume", "amount", "turnover_rate",
    "float_market_cap", "market_cap", "pe_ratio", "pe_label",
)
assert {field: intraday["quote"][field] for field in quote_fields} == {
    field: daily_result["quote"][field] for field in quote_fields
}
assert intraday["quote"]["amount"] == 669_000_000
assert intraday["quote"]["market_cap"] == 79_670_000_000
assert len(route_opener.requests) == 2

print(json.dumps({
    "tencent_quote_field_units": True,
    "optional_field_validation": True,
    "partial_quote_preserves_base": True,
    "zero_activity_and_negative_pe": True,
    "security_identity_guard": True,
    "snapshot_and_route_quote_projection": True,
    "quote_summary_stable_across_intervals": True,
}))
'''


def test_native_quote_summary_parsing_and_projection(tmp_path: Path) -> None:
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    source = tmp_path / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert any(patch["path"] == "0037-quote-summary.json" for patch in receipt["patches"])
    home = tmp_path / "private-home"
    home.mkdir()
    environment = {
        key: value
        for key, value in os.environ.items()
        if key.upper() in {
            "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
            "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
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
