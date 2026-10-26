import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { StockVibeShadowResult } from "./StockVibeShadowResult";

it("shows independent Shadow metrics without comparing a journal's different window", () => {
  render(<StockVibeShadowResult operation="run_shadow_backtest" result={{ combined: { total_return: 0.0185, max_drawdown: 0, trade_count: 0 },
    equity_points: 7, real_total_pnl: 71, window: ["2025-06-23", "2025-07-01"], source: "local" }} />);
  expect(screen.getByText("1.85%")).toBeInTheDocument();
  expect(screen.getByText("0%")).toBeInTheDocument();
  expect(screen.getByText("不可用")).toBeInTheDocument();
  expect(screen.queryByText("71")).not.toBeInTheDocument();
  expect(screen.getByText(/未计算真实账户同期收益或经济归因/)).toBeInTheDocument();
  expect(screen.getByText(/本窗口未记录已完成交易/)).toBeInTheDocument();
});

it("keeps partial fixed-basket coverage distinct from a full market scan", () => {
  render(<StockVibeShadowResult operation="scan_shadow_signals" result={{ status: "partial", target_date: "2025-07-01",
    scanned_symbols: ["600519.SH"], available_symbols: ["600519.SH"], unscanned_symbols: ["000858.SZ"], matches: [] }} />);
  expect(screen.getByText(/已扫描 1 个 · 有数据 1 个 · 未覆盖 1 个/)).toBeInTheDocument();
  expect(screen.getByText(/仅适用于.*固定篮子样本/)).toBeInTheDocument();
});
