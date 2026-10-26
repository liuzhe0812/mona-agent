"""Journal review projects the real pinned parser/FIFO, including coverage gaps."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from tools.stock_vibe.prepare import prepare

ROOT = Path(__file__).resolve().parents[3]
PYTHON = ROOT / ".codex_tmp/vibe-venv-313/Scripts/python.exe"

_PROBE = r'''
import csv
import hashlib
import json
import sys
from pathlib import Path

from src.config.paths import get_runtime_root
from src.tools.trade_journal_parsers import parse_file, records_to_dataframe
from src.tools.trade_journal_tool import analyze_trade_journal, pair_trades_fifo

home = get_runtime_root()
uploads = home / "uploads"
uploads.mkdir(parents=True, exist_ok=True)
scenario = sys.argv[1]


def row(symbol, side, quantity=100, price=10, fee=0, date="2026-06-09 10:00:00"):
    return {"datetime": date, "symbol": symbol, "name": "synthetic fixture", "side": side,
            "quantity": quantity, "price": price, "amount": quantity * price, "fee": fee}


def journal(rows, filename="journal.csv", **kwargs):
    path = uploads / filename
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    result = json.loads(analyze_trade_journal(str(path), **kwargs))
    assert result["status"] == "ok", result
    review = result["review"]
    assert review["source_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()
    assert review["method"]["account_return"] is False
    assert review["method"]["currency_conversion"] is False
    assert review["method"]["opening_balance"] == "not_provided"
    return path, result, review


if scenario == "partial_sell":
    path, result, review = journal([
        row("600519.SH", "buy", fee=2),
        row("600519.SH", "sell", quantity=40, price=12, fee=1, date="2026-06-10 10:00:00"),
    ])
    assert result["profile"]["total_pnl"] == 78.2
    assert result["profile"]["total_roundtrips"] == 1
    assert review["settlements"] == [{"currency": "CNY", "matched_pnl": 78.2,
                                      "recognized_fees": 3.0, "record_count": 2}]
    assert review["by_symbol"][0]["matched_quantity"] == 40
    assert review["unmatched"]["by_symbol"] == [{"symbol": "600519.SH", "name": "synthetic fixture",
        "currency": "CNY", "side": "buy", "quantity": 60.0, "lots": 1}]
    fmt, records = parse_file(path)
    frame = records_to_dataframe(records)
    remaining = []
    assert pair_trades_fifo(frame, unmatched=remaining) == pair_trades_fifo(frame)
    assert len(remaining) == 1 and remaining[0]["quantity"] == 60
    assert review["coverage"]["recognized_fee_columns"] == ["fee"]
    assert review["coverage"]["buy_records"] == review["coverage"]["sell_records"] == 1

elif scenario == "sell_without_opening":
    _, result, review = journal([row("600519.SH", "sell", quantity=10)])
    assert result["profile"]["total_roundtrips"] == 0
    assert result["profile"]["total_pnl"] == 0
    assert review["matched_trades"]["rows"] == []
    assert review["unmatched"]["by_symbol"][0]["side"] == "sell"
    assert review["unmatched"]["by_symbol"][0]["quantity"] == 10
    assert "not_proof_of_short_selling" in review["method"]["short_scope"]
    assert "avg_winner_hold_days" not in result["behavior"]["disposition_effect"]
    _, result, review = journal([
        row("600519.SH", "sell", quantity=10, price=10),
        row("600519.SH", "buy", quantity=4, price=9, date="2026-06-10 10:00:00"),
    ], filename="short-remainder.csv")
    assert review["matched_trades"]["rows"][0]["side"] == "short"
    assert review["matched_trades"]["rows"][0]["pnl"] == 4
    assert review["unmatched"]["by_symbol"][0]["quantity"] == 6

elif scenario == "currency_and_dividend":
    rows = []
    for symbol, quantity, buy, sell, fee in (("600519.SH", 100, 10, 12, 2), ("AAPL", 10, 50, 49, 1)):
        rows += [row(symbol, "buy", quantity, buy, fee),
                 row(symbol, "sell", quantity, sell, fee, "2026-06-10 10:00:00")]
    dividend = row("600519.SH", "dividend", quantity=0, price=0)
    dividend["amount"] = 5
    rows.append(dividend)
    _, result, review = journal(rows)
    settlement = {value["currency"]: value for value in review["settlements"]}
    assert set(settlement) == {"CNY", "USD"}
    assert settlement["CNY"]["matched_pnl"] == 196
    assert settlement["CNY"]["recognized_fees"] == 4
    assert settlement["USD"]["matched_pnl"] == -12
    assert settlement["USD"]["recognized_fees"] == 2
    assert result["profile"]["total_pnl"] == {"CNY": 201.0, "USD": -12.0}
    assert review["coverage"]["dividend_records"] == 1
    assert len(review["by_symbol"]) == 2
    assert "by_currency" in result["behavior"]["overtrading"]

elif scenario == "empty_filtered_sample":
    _, result, review = journal([row("600519.SH", "buy")], filter_expr="2020-01 to 2020-02")
    assert result["profile"] == {"error": "empty trade journal"}
    assert review["coverage"]["parsed_records"] == 1
    assert review["coverage"]["analyzed_records"] == 0
    assert review["coverage"]["filtered_out_records"] == 1
    assert review["coverage"]["date_start"] is None
    assert review["settlements"] == review["by_symbol"] == []
    assert review["matched_trades"]["total"] == review["unmatched"]["total_lots"] == 0

elif scenario == "bounded_details":
    rows = []
    for index in range(205):
        rows += [row("600519.SH", "buy", quantity=1, price=10,
                     date=f"2026-06-09 10:{index // 60:02d}:{index % 60:02d}"),
                 row("600519.SH", "sell", quantity=1, price=11,
                     date=f"2026-06-10 10:{index // 60:02d}:{index % 60:02d}")]
    _, result, review = journal(rows)
    assert result["profile"]["total_roundtrips"] == 205
    assert len(result["profile"]["roundtrips_sample"]) == 5
    assert review["matched_trades"]["total"] == 205
    assert review["matched_trades"]["limit"] == len(review["matched_trades"]["rows"]) == 200
    assert review["matched_trades"]["truncated"] is True
    assert review["by_symbol"][0]["matched_count"] == review["by_symbol"][0]["matched_pnl"] == 205
    assert review["preview"]["limit"] == len(review["preview"]["rows"]) == 8
    assert review["preview"]["total"] == 410 and review["preview"]["truncated"] is True
    _, _, review = journal([row("600519.SH", "buy", quantity=1) for _ in range(205)], filename="unmatched.csv")
    assert review["unmatched"]["total_lots"] == 205 and len(review["unmatched"]["rows"]) == 200
    assert review["unmatched"]["truncated"] is True
    assert review["unmatched"]["by_symbol"][0]["quantity"] == 205

elif scenario == "fee_and_source_coverage":
    fixture = [
        {"成交日期": "20260609", "成交时间": "10:00:00", "股票代码": "600519", "股票名称": "fixture",
         "买卖标志": "买入", "成交数量": "100", "成交均价": "10", "成交金额": "1000",
         "佣金": "1", "印花税": "0", "过户费": "100"},
        {"成交日期": "20260610", "成交时间": "10:00:00", "股票代码": "600519", "股票名称": "fixture",
         "买卖标志": "卖出", "成交数量": "100", "成交均价": "11", "成交金额": "1100",
         "佣金": "1", "印花税": "1", "过户费": "100"},
    ]
    _, result, review = journal(fixture, filename="东方财富.csv")
    assert result["format_detected"] == "eastmoney"
    assert review["coverage"]["source_rows"] == review["coverage"]["parsed_records"] == 2
    assert review["coverage"]["recognized_fee_columns"] == ["佣金", "印花税"]
    assert "过户费" in review["coverage"]["raw_columns"]
    assert review["settlements"][0]["recognized_fees"] == 3
    assert review["settlements"][0]["matched_pnl"] == 97
    no_fee = row("600519.SH", "buy")
    no_fee.pop("fee")
    _, _, review = journal([no_fee], filename="no-fee.csv")
    assert review["coverage"]["fee_columns_present"] is False
    assert review["coverage"]["recognized_fee_columns"] == []
    assert review["settlements"][0]["recognized_fees"] == 0

elif scenario == "safe_inputs_and_original_modes":
    path, result, review = journal([row("600519.SH", "buy")])
    profile = json.loads(analyze_trade_journal(str(path), analysis_type="profile"))
    assert profile["profile"] == result["profile"] and "review" not in profile
    behavior = json.loads(analyze_trade_journal(str(path), analysis_type="behavior"))
    assert behavior["behavior"] == result["behavior"] and "review" not in behavior
    outside = home.parent / "outside.csv"
    outside.write_text(path.read_text(encoding="utf-8-sig"), encoding="utf-8")
    for unsafe in (str(outside), str(uploads / ".." / ".." / "outside.csv"), "\\\\server\\share\\journal.csv"):
        rejected = json.loads(analyze_trade_journal(unsafe))
        assert rejected["status"] == "error" and "review" not in rejected
    invalid = uploads / "invalid.csv"
    invalid.write_text("datetime,symbol,side,quantity,price\n2026-06-09,600519.SH,unknown,1,10\n", encoding="utf-8")
    assert json.loads(analyze_trade_journal(str(invalid)))["status"] == "error"
else:
    raise AssertionError(scenario)

print(json.dumps({"scenario": scenario, "native_parser_fifo": True, "synthetic_data": True}))
'''


@pytest.fixture(scope="module")
def native_source(tmp_path_factory: pytest.TempPathFactory) -> Path:
    source = tmp_path_factory.mktemp("journal-native") / "source"
    receipt = prepare(ROOT / "third_party/vibe-trading", source)
    assert any(item["path"] == "0045-journal-review.json" for item in receipt["patches"])
    if not PYTHON.is_file():
        pytest.skip("controlled native Python 3.13 environment required")
    return source / "agent"


@pytest.mark.parametrize("scenario", [
    "partial_sell", "sell_without_opening", "currency_and_dividend", "empty_filtered_sample",
    "bounded_details", "fee_and_source_coverage", "safe_inputs_and_original_modes",
])
def test_native_journal_review_projection(native_source: Path, tmp_path: Path, scenario: str) -> None:
    home = tmp_path / "private-home"
    home.mkdir()
    environment = {key: value for key, value in os.environ.items() if key.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE",
        "LOCALAPPDATA", "APPDATA",
    }}
    environment.update(PYTHONPATH=str(native_source), PYTHONUTF8="1", PYTHONNOUSERSITE="1",
                       PYTHONDONTWRITEBYTECODE="1", PYTHON_DOTENV_DISABLED="1",
                       VIBE_TRADING_HOME=str(home), VIBE_TRADING_HOSTED="1",
                       VIBE_TRADING_ALLOWED_FILE_ROOTS=str(home / "uploads"))
    completed = subprocess.run([str(PYTHON), "-B", "-c", _PROBE, scenario], cwd=home,
                               env=environment, capture_output=True, text=True,
                               encoding="utf-8", timeout=40, check=False)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert json.loads(completed.stdout.splitlines()[-1])["native_parser_fifo"] is True
