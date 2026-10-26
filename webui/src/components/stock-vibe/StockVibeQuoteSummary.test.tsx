import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StockVibeWorkbenchMarketData } from "@/lib/stock-vibe-api";
import { StockVibeQuoteSummary } from "./StockVibeQuoteSummary";

const SYMBOL = "002460.SZ";

function market(quote: Record<string, unknown> = {}): StockVibeWorkbenchMarketData {
  return {
    status: "ok", symbol: SYMBOL, interval: "1D", bars: [],
    quote: { price: 38, previous_close: 39, change: -1, change_pct: -2.56, name: "赣锋锂业", as_of: "2026-10-16T15:00:00+08:00", ...quote } as StockVibeWorkbenchMarketData["quote"],
    trading_date: "2026-10-16", market_open: false, market_state: "closed", source: "test",
    observed_at: "2026-10-16T15:00:00+08:00", volume_unit: "lots", adjustment: "none",
  };
}

describe("StockVibeQuoteSummary", () => {
  it("shows the stock identity, latest quote, change, and price direction", () => {
    const { container } = render(<StockVibeQuoteSummary symbol={SYMBOL} market={market({ open: 40, high: 41, low: 38 })} />);

    expect(screen.getByRole("heading", { name: "赣锋锂业" })).toBeVisible();
    expect(screen.getByText("002460")).toBeVisible();
    expect(screen.getByText("行情时点 2026-10-16 15:00")).toBeVisible();
    expect(container.querySelector(".stock-vibe-quote-price")).toHaveClass("stock-vibe-down");
    expect(screen.getByText("-1.00")).toBeVisible();
    expect(screen.getByText("-2.56%")).toBeVisible();
    expect(screen.getByText("今开").nextElementSibling).toHaveClass("stock-vibe-up");
    expect(screen.getByText("最高").nextElementSibling).toHaveClass("stock-vibe-up");
    expect(screen.getByText("最低").nextElementSibling).toHaveClass("stock-vibe-down");
    expect(container.querySelector(".stock-vibe-quote-stats")).toBeInTheDocument();
  });

  it("formats yuan-denominated amounts compactly", () => {
    render(<StockVibeQuoteSummary symbol={SYMBOL} market={market({
      volume: 175700, amount: 669000000, market_cap: 79670000000, float_market_cap: 46030000000,
      turnover_rate: 1.45, pe_ratio: 11.92, pe_label: "市盈率",
    })} />);

    const summary = screen.getByRole("region", { name: "赣锋锂业 002460行情" });
    expect(within(summary).getByText("换手率").nextElementSibling).toHaveTextContent("1.45%");
    expect(within(summary).getByText("成交额").nextElementSibling).toHaveTextContent("6.69亿");
    expect(within(summary).getByText("总市值").nextElementSibling).toHaveTextContent("796.70亿");
    expect(within(summary).getByText("市盈率").nextElementSibling).toHaveTextContent("11.92");
  });

  it("keeps legitimate zero values and marks missing cached indicators with a dash", () => {
    render(<StockVibeQuoteSummary symbol={SYMBOL} market={market({
      price: 0, change: 0, change_pct: 0, open: 0, high: null, low: 0, turnover_rate: 0,
      volume: 0, amount: 0, market_cap: null, pe_ratio: 0,
    })} />);

    const summary = screen.getByRole("region", { name: "赣锋锂业 002460行情" });
    expect(within(summary).getByText("今开").nextElementSibling).toHaveTextContent("0.00");
    expect(within(summary).getByText("换手率").nextElementSibling).toHaveTextContent("0.00%");
    expect(within(summary).getByText("成交额").nextElementSibling).toHaveTextContent("0.00元");
    expect(within(summary).getByText("总市值").nextElementSibling).toHaveTextContent("—");
    expect(within(summary).getByText("市盈率").nextElementSibling).toHaveTextContent("0.00");
  });

  it("shows the last quote status and keeps the no-selection state concise", () => {
    const { rerender } = render(<StockVibeQuoteSummary symbol={SYMBOL} market={market()} stale />);
    expect(screen.getByText("显示上次行情")).toBeVisible();

    rerender(<StockVibeQuoteSummary symbol={null} market={null} />);
    expect(screen.getByRole("heading", { name: "A 股行情" })).toBeVisible();
    expect(screen.queryByText("成交额")).not.toBeInTheDocument();
    expect(screen.queryByText("正在获取行情…")).not.toBeInTheDocument();
  });

  it("labels dynamic PE explicitly and keeps negative valuations neutral", () => {
    render(<StockVibeQuoteSummary symbol={SYMBOL} market={market({ pe_ratio: -12.5, pe_label: "市盈率(动)" })} />);
    const pe = screen.getByText("市盈率(动)").nextElementSibling;
    expect(pe).toHaveTextContent("-12.50");
    expect(pe).not.toHaveClass("stock-vibe-up", "stock-vibe-down");
  });
});
