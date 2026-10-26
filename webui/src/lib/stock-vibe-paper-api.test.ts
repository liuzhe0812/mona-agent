import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("./stock-vibe-api", () => ({ stockVibeRequest: request }));
import {
  commitStockVibePaperTrade, getStockVibePaperAccount, getStockVibePaperPreview,
  listStockVibePaperTrades, StockVibePaperApiError,
} from "./stock-vibe-paper-api";

const quote = { source: "tencent", as_of: "2026-10-21T10:30:00+08:00", observed_at: "2026-10-21T10:30:02+08:00", market_status: "open", adjustment: "none" };
const preview = { status: "ready", preview_id: "a".repeat(32), expires_at: "2026-10-21T10:31:00+08:00", account_version: 2,
  symbol: "002460.SZ", name: "测试股票", side: "buy", quantity: 100, lot_size: 100,
  price: 10, notional: 1000, fee: 5.01, cash_delta: -1005.01, cash_after: 8994.99, available_quantity: 0, quote };

beforeEach(() => request.mockReset());
describe("paper account transport contract", () => {
  it("keeps unavailable valuation null while retaining known cash", async () => {
    const value = { status: "partial", defaults: { initial_cash: 1000000, lot_size: 100, currency: "CNY", fee_model: {} },
      account: { initial_cash: 10000, cash: 8994.99, realized_pnl: 0, unrealized_pnl: null, equity: null, total_pnl: null, total_return: null, version: 2, created_at: quote.as_of },
      positions: [{ symbol: "002460.SZ", name: "测试股票", quantity: 100, available_quantity: 100, average_cost: 10.0501, cost_basis: 1005.01,
        mark_price: null, market_value: null, unrealized_pnl: null }],
      valuation: { complete: false, cached: false, missing_symbols: ["002460.SZ"], as_of: null } };
    request.mockResolvedValue({ native: value });
    const result = await getStockVibePaperAccount();
    expect(result.account?.equity).toBeNull();
    expect(result.account?.cash).toBe(8994.99);
  });
  it("accepts only the exact requested security quantity and raw reference price", async () => {
    request.mockResolvedValue({ native: preview });
    expect((await getStockVibePaperPreview({ symbol: "002460.SZ", side: "buy", quantity: 100 })).price).toBe(10);
    expect(request).toHaveBeenCalledWith("/paper/preview?symbol=002460.SZ&side=buy&quantity=100");
    for (const bad of [{ symbol: "600519.SH" }, { quantity: 200 }, { price: Number.NaN }, { quote: { ...quote, adjustment: "qfq" } }]) {
      request.mockResolvedValue({ native: { ...preview, ...bad } });
      await expect(getStockVibePaperPreview({ symbol: "002460.SZ", side: "buy", quantity: 100 })).rejects.toBeInstanceOf(StockVibePaperApiError);
    }
  });
  it("turns server eligibility failures into an actionable field error", async () => {
    request.mockResolvedValue({ native: { status: "unavailable", code: "insufficient_cash" } });
    await expect(getStockVibePaperPreview({ symbol: "002460.SZ", side: "buy", quantity: 100 })).rejects.toThrow("模拟资金不足");
  });
  it("sends only a frozen preview reference and optional user context", async () => {
    request.mockResolvedValue({ status: "unknown" });
    const body = { preview_id: "a".repeat(32), note: "观察财报后的走势", research: { session_id: "s", attempt_id: "a" } };
    await commitStockVibePaperTrade("b".repeat(32), body);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("/paper/trades", { method: "POST", requestId: "b".repeat(32), body });
  });
  it("rejects malformed history rather than showing an empty account", async () => {
    request.mockResolvedValue({ native: { items: [{}], total: 1, limit: 10, offset: 0 } });
    await expect(listStockVibePaperTrades({ limit: 10 })).rejects.toBeInstanceOf(StockVibePaperApiError);
  });
});
