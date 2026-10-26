"""Actual native terminal execution cases; no market-data or runner mocks."""

import json

import pandas as pd

from backtest.engines.china_a import ChinaAEngine


def run(open_prices, closes, targets):
    dates = pd.date_range("2025-06-02", periods=len(closes), freq="B")
    bars = pd.DataFrame({"open": open_prices, "high": [max(a, b) for a, b in zip(open_prices, closes)],
                         "low": [min(a, b) for a, b in zip(open_prices, closes)], "close": closes,
                         "pre_close": [10.0, *closes[:-1]], "volume": 10000}, index=dates)
    engine = ChinaAEngine({"initial_cash": 10000, "slippage": 0})
    engine._execute_bars(dates, {"600000.SH": bars}, pd.DataFrame({"600000.SH": closes}, index=dates),
                         pd.DataFrame({"600000.SH": targets}, index=dates), ["600000.SH"])
    return engine


same_day = run([10, 10], [10, 10.2], [0, 0.5])
assert "600000.SH" in same_day.positions
assert not same_day.trades
assert [fill.action for fill in same_day.fill_records] == ["open"]
assert same_day.equity_snapshots[-1].positions == 1
assert same_day.actual_position_snapshots[-1][1]["600000.SH"] > 0
assert same_day.equity_snapshots[-1].equity > same_day.capital
assert same_day.equity_snapshots[-1].unrealized > 0
assert same_day._plan_rejection_metrics()

limit_down_close = run([10, 10], [10, 9], [0.5, 0.5])
assert "600000.SH" in limit_down_close.positions
assert not limit_down_close.trades
assert not any(fill.action == "close" for fill in limit_down_close.fill_records)
assert limit_down_close.equity_snapshots[-1].positions == 1
assert limit_down_close.actual_position_snapshots[-1][1]["600000.SH"] > 0
assert limit_down_close._plan_rejection_metrics()

tradable_close = run([10, 10.1], [10, 10.2], [0.5, 0.5])
assert not tradable_close.positions
assert len(tradable_close.trades) == 1
assert tradable_close.trades[0].exit_time.date() > tradable_close.trades[0].entry_time.date()
assert tradable_close.equity_snapshots[-1].positions == 0
assert tradable_close.equity_snapshots[-1].equity == tradable_close.capital
print(json.dumps({"same_day_retained": True, "limit_down_retained": True, "tradable_exit": True}))
