import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { StockVibeJournalResult, stockVibeJournalMarkdown } from "./StockVibeJournalResult";

it("keeps currency amounts separate and opens scope without raw JSON", async () => {
  render(<StockVibeJournalResult result={{ date_range: "2025-06-09 ~ 2025-06-20", total_records: 10,
    profile: { total_roundtrips: 5, avg_holding_days: 1, total_pnl: { CNY: 71, USD: 5 } } }} />);
  expect(screen.getByText("CNY 71")).toBeInTheDocument();
  expect(screen.getByText("USD 5")).toBeInTheDocument();
  expect(screen.getByText(/原文件区间：2025-06-09 ~ 2025-06-20/)).toBeInTheDocument();
  expect(screen.queryByText(/不代表完整账户净值/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "数据范围与计算口径" }));
  expect(within(screen.getByRole("dialog")).getByText(/不代表完整账户净值/)).toBeInTheDocument();
  expect(document.querySelector("pre")).toBeNull();
});

const result = {
  status: "ok", file: "成交.csv", format_detected: "eastmoney", date_range: "2026-06-09 ~ 2026-06-20", total_records: 10,
  profile: { total_roundtrips: 3, total_pnl: 71, total_dividends: 1, win_rate: 2 / 3, profit_loss_ratio: null, avg_holding_days: 2 },
  behavior: {
    disposition_effect: { severity: "high", avg_winner_hold_days: 1, avg_loser_hold_days: 4 },
    overtrading: { severity: "high", by_currency: { CNY: { busy_day_avg_pnl: -2, quiet_day_avg_pnl: 5 }, USD: { severity: "low", evidence: "insufficient data" } } },
    chasing_momentum: { severity: "high", chase_ratio: 0.5, buys_evaluated: 2 },
    anchoring: { severity: "low", evidence: "no symbol has ≥5 trades" },
  },
  review: {
    schema_version: 1,
    coverage: { source_rows: 12, parsed_records: 10, analyzed_records: 10, buy_records: 5, sell_records: 4, dividend_records: 1, currencies: ["CNY"], fee_columns_present: true, recognized_fee_columns: ["手续费", "印花税"] },
    preview: { rows: [{ datetime: "2026-06-09 09:31", symbol: "600519.SH", name: "测试名称", side: "buy", quantity: 100, price: 10, fee: 1 }], total: 10, limit: 8, truncated: true },
    settlements: [{ currency: "CNY", matched_pnl: 70, recognized_fees: 4, record_count: 10 }],
    by_symbol: [{ symbol: "600519.SH", name: "测试名称", currency: "CNY", matched_count: 3, matched_pnl: 70 }],
    matched_trades: { rows: [{ symbol: "600519.SH", buy_dt: "2026-06-09 10:00", sell_dt: "2026-06-10 11:00", qty: 50, side: "short", currency: "CNY", pnl: 70 }], total: 3, limit: 200, truncated: false },
    unmatched: { rows: [{ symbol: "600519.SH", datetime: "2026-06-20 10:00", side: "sell", quantity: 20, price: 11, currency: "CNY" }], total_lots: 1, limit: 200, truncated: false },
  },
};

it("checks actual parsed rows and missing legs before confirming the exact result", async () => {
  const confirm = vi.fn();
  render(<StockVibeJournalResult result={result} mode="review" onConfirm={confirm} />);
  expect(screen.getByText("东方财富")).toBeInTheDocument();
  expect(screen.getByText("5 / 4")).toBeInTheDocument();
  expect(screen.getByText("手续费、印花税", { exact: false })).toBeInTheDocument();
  expect(screen.getByText("测试名称", { exact: false })).toBeInTheDocument();
  expect(screen.getByText(/有 1 段成交缺少对应成交或期初记录/)).toBeInTheDocument();
  expect(screen.queryByText("这份成交的交易表现")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "确认并查看复盘" }));
  expect(confirm).toHaveBeenCalledTimes(1);
});

it("shows actual observations without psychological labels or false market momentum", async () => {
  render(<StockVibeJournalResult result={result} />);
  expect(screen.getByText("CNY 71")).toBeInTheDocument();
  expect(screen.getByText("66.67%")).toBeInTheDocument();
  expect(screen.getByText("暂不能计算")).toBeInTheDocument();
  expect(screen.getByText(/亏损交易 4 天/)).toBeInTheDocument();
  expect(screen.getByText(/CNY：交易较多日平均每段 -2，较少日 5/)).toBeInTheDocument();
  expect(screen.getByText(/50% 比本人同股此前第 3 笔买价高出 3% 以上/)).toBeInTheDocument();
  expect(screen.getByText(/没有至少交易 5 笔的股票，暂不能比较/)).toBeInTheDocument();
  expect(screen.queryByText(/处置效应|价格锚定|严重追涨|无明显偏差/)).not.toBeInTheDocument();
  await userEvent.click(screen.getAllByRole("button", { name: "看依据" })[2]);
  expect(within(screen.getByRole("dialog")).getByText(/不是股票近期市场涨幅/)).toBeInTheDocument();
});

it("shows native short-leg order honestly and preserves quantities in matched details", async () => {
  render(<StockVibeJournalResult result={result} />);
  await userEvent.click(screen.getByRole("button", { name: "查看配对成交" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByRole("columnheader", { name: "入场时间" })).toBeInTheDocument();
  expect(dialog.getByText("先卖后买")).toBeInTheDocument();
  expect(dialog.getByText("50")).toBeInTheDocument();
  expect(dialog.getByText(/不能据此认定实际做空/)).toBeInTheDocument();
  expect(dialog.queryByRole("columnheader", { name: "买入时间" })).not.toBeInTheDocument();
});

it("explains and exports the same immutable journal scope rather than shadow results", async () => {
  const explain = vi.fn();
  render(<StockVibeJournalResult result={result} onExplain={explain} />);
  await userEvent.click(screen.getByRole("button", { name: "解释这份复盘" }));
  const markdown = stockVibeJournalMarkdown(result);
  expect(explain).toHaveBeenCalledWith(markdown);
  expect(markdown).toContain("成交.csv");
  expect(markdown).toContain("2026-06-09 ~ 2026-06-20");
  expect(markdown).toContain("现金分红）：CNY 71");
  expect(markdown).toContain("600519.SH 测试名称：CNY 70");
  expect(markdown).toContain("未配对成交：1 段");
  expect(markdown).toContain("不代表完整账户净值或账户收益率");
  expect(markdown).not.toMatch(/Shadow|影子|策略收益|Infinity|\{\s*"/);
});
