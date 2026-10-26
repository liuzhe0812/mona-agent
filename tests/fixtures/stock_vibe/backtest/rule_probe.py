"""Probe native A-share and local-loader behavior without mocks or network data."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd
from backtest.engines.china_a import ChinaAEngine, _price_limit
from backtest.loaders.local_loader import DataLoader
from backtest.models import Position


def main() -> int:
    config_path = Path(sys.argv[1])
    config = json.loads(config_path.read_text(encoding="utf-8"))
    start_date = config["start_date"]
    end_date = config["end_date"]
    engine = ChinaAEngine({"initial_cash": 10000, "slippage": 0.0})
    symbol = "600000.SH"
    engine.positions[symbol] = Position(
        symbol=symbol,
        direction=1,
        entry_price=10.0,
        entry_time=pd.Timestamp("2025-06-03"),
        size=100.0,
    )
    same_day = pd.Series({"open": 10.0, "close": 10.0, "trade_date": pd.Timestamp("2025-06-03")})
    next_day = pd.Series({"open": 10.0, "close": 10.0, "trade_date": pd.Timestamp("2025-06-04")})
    t_plus_one = {
        "same_day_sell_allowed": engine.can_execute(symbol, 0, same_day),
        "next_day_sell_allowed": engine.can_execute(symbol, 0, next_day),
    }

    limit_engine = ChinaAEngine({"initial_cash": 10000, "slippage": 0.0})
    limit_up_bar = pd.Series({"open": 11.0, "close": 11.0, "pre_close": 10.0})
    limit_down_bar = pd.Series({"open": 9.0, "close": 9.0, "pre_close": 10.0})
    limit_engine.positions[symbol] = Position(
        symbol=symbol,
        direction=1,
        entry_price=10.0,
        entry_time=pd.Timestamp("2025-06-02"),
        size=100.0,
    )
    price_limits = {
        "main_board": _price_limit("600000.SH"),
        "chinext": _price_limit("300750.SZ"),
        "star": _price_limit("688001.SH"),
        "beijing": _price_limit("830799.BJ"),
        "st_status_input": "no ST flag/name argument exists in _price_limit(symbol)",
    }

    fee_engine = ChinaAEngine({"initial_cash": 10000, "slippage": 0.0})
    loader = DataLoader()
    halted_bars = loader.fetch(["600001.SH"], start_date, end_date, interval="1D")["600001.SH"]
    gap_day = pd.Timestamp("2025-06-04")
    gap_order_engine = ChinaAEngine({"initial_cash": 10000, "slippage": 0.0})
    gap_order = gap_order_engine._plan_open_order(
        "600001.SH", 0.5, halted_bars, gap_day, 10000.0
    )
    halt_marker_columns = sorted(
        set(halted_bars.columns) & {"halted", "suspended", "suspension", "status"}
    )

    evidence = {
        "t_plus_one": t_plus_one,
        "lots": {
            "round_size_250": fee_engine.round_size(250, 10.0),
            "round_size_99": fee_engine.round_size(99, 10.0),
        },
        "price_limit_bands": price_limits,
        "price_limit_fill_blocks": {
            "main_board_limit_up_buy_allowed": limit_engine.can_execute("600000.SH", 1, limit_up_bar),
            "main_board_limit_down_sell_allowed": limit_engine.can_execute("600000.SH", 0, limit_down_bar),
        },
        "fees": {
            "buy_1000_shares_at_10": fee_engine.calc_commission(1000, 10.0, 1, is_open=True),
            "sell_1000_shares_at_10": fee_engine.calc_commission(1000, 10.0, 1, is_open=False),
            "commission_rate": fee_engine.commission_rate,
            "commission_min": fee_engine.commission_min,
            "transfer_fee_rate": fee_engine.transfer_fee,
            "sell_stamp_tax_rate": fee_engine.stamp_tax,
        },
        "missing_bar": {
            "fixture_gap_day": gap_day.date().isoformat(),
            "gap_day_loaded": gap_day in halted_bars.index,
            "loadable_bar_count": len(halted_bars),
            "columns": list(halted_bars.columns),
            "halt_marker_columns_present": halt_marker_columns,
            "order_rejected_as_no_bar": gap_order is None,
            "no_bar_rejection_count": gap_order_engine.plan_rejections.get(("600001.SH", "no_bar"), 0),
        },
    }
    print(json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
