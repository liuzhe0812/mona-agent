import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  readStockVibeMarketSnapshot,
  readStockVibeQuoteSnapshots,
  saveStockVibeMarketSnapshot,
} from "./stock-vibe-market-cache";
import type { StockVibeRead, StockVibeWorkbenchMarketData } from "./stock-vibe-api";

const STORAGE_KEY = "mona.stock-vibe.market-snapshots.v1";

function market(symbol: string, interval: "intraday" | "1D", observedAt: string, price = 10): StockVibeRead<StockVibeWorkbenchMarketData> {
  return {
    source: null,
    observed_at: observedAt,
    native: {
      status: "ok", symbol, interval,
      bars: [{ trade_date: observedAt, open: price, high: price + 1, low: price - 1, close: price, volume: 10 }],
      quote: { price, previous_close: price - 0.5, change: 0.5, change_pct: 5, as_of: observedAt },
      trading_date: observedAt.slice(0, 10), market_open: interval === "intraday", market_state: "open",
      source: "tencent", observed_at: observedAt, volume_unit: "lots", adjustment: "none",
    },
  };
}

function legacy(symbol: string): StockVibeRead {
  return { source: null, native: { [symbol]: [{ trade_date: "2026-10-19", open: 9, high: 11, low: 8, close: 10, volume: 20 }] } };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("stock-vibe market display snapshots", () => {
  it("persists the full response so a newly loaded module can restore it", async () => {
    const response = market("600000.SH", "intraday", "2026-10-19T10:00:00+08:00");
    saveStockVibeMarketSnapshot("600000.SH", "intraday", response);

    vi.resetModules();
    const reloaded = await import("./stock-vibe-market-cache");
    expect(reloaded.readStockVibeMarketSnapshot("600000.SH", "intraday")).toEqual(response);
  });

  it("isolates snapshots by both symbol and chart interval", () => {
    const intraday = market("600000.SH", "intraday", "2026-10-19T10:00:00+08:00", 10);
    const daily = market("600000.SH", "1D", "2026-10-19T10:00:00+08:00", 11);
    const otherSymbol = market("600001.SH", "intraday", "2026-10-19T10:00:00+08:00", 12);
    saveStockVibeMarketSnapshot("600000.SH", "intraday", intraday);
    saveStockVibeMarketSnapshot("600000.SH", "1D", daily);
    saveStockVibeMarketSnapshot("600001.SH", "intraday", otherSymbol);

    expect(readStockVibeMarketSnapshot("600000.SH", "intraday")).toEqual(intraday);
    expect(readStockVibeMarketSnapshot("600000.SH", "1D")).toEqual(daily);
    expect(readStockVibeMarketSnapshot("600001.SH", "intraday")).toEqual(otherSymbol);
    expect(readStockVibeMarketSnapshot("600001.SH", "1D")).toBeNull();
  });

  it("saves valid legacy bars under their own interval", () => {
    const response = legacy("600000.SH");
    saveStockVibeMarketSnapshot("600000.SH", "1W", response);

    expect(readStockVibeMarketSnapshot("600000.SH", "1W")).toEqual(response);
    expect(readStockVibeMarketSnapshot("600000.SH", "1M")).toBeNull();
  });

  it("does not replace a successful snapshot with an empty, failed, or mismatched response", () => {
    const response = market("600000.SH", "1D", "2026-10-19T10:00:00+08:00", 10);
    saveStockVibeMarketSnapshot("600000.SH", "1D", response);
    const failed = market("600000.SH", "1D", "2026-10-19T11:00:00+08:00", 99);
    (failed.native as StockVibeWorkbenchMarketData).status = "unavailable";
    const empty = market("600000.SH", "1D", "2026-10-19T11:00:00+08:00", 99);
    (empty.native as StockVibeWorkbenchMarketData).bars = [];
    const wrongSymbol = market("600001.SH", "1D", "2026-10-19T11:00:00+08:00", 99);

    saveStockVibeMarketSnapshot("600000.SH", "1D", failed);
    saveStockVibeMarketSnapshot("600000.SH", "1D", empty);
    saveStockVibeMarketSnapshot("600000.SH", "1D", wrongSymbol);
    expect(readStockVibeMarketSnapshot("600000.SH", "1D")).toEqual(response);
  });

  it("keeps the response with the newer observed market time when reads finish out of order", () => {
    const recent = market("600000.SH", "intraday", "2026-10-19T10:02:00+08:00", 12);
    const late = market("600000.SH", "intraday", "2026-10-19T10:01:00+08:00", 11);
    saveStockVibeMarketSnapshot("600000.SH", "intraday", recent);
    saveStockVibeMarketSnapshot("600000.SH", "intraday", late);

    expect(readStockVibeMarketSnapshot("600000.SH", "intraday")).toEqual(recent);
  });

  it("rejects noncanonical symbols and invalid structured quotes", () => {
    const valid = market("600000.SH", "intraday", "2026-10-19T10:00:00+08:00");
    (valid.native as StockVibeWorkbenchMarketData).quote.name = 1 as unknown as string;
    saveStockVibeMarketSnapshot("600000.SH", "intraday", valid);
    saveStockVibeMarketSnapshot("600000", "intraday", market("600000", "intraday", "2026-10-19T10:00:00+08:00"));

    expect(readStockVibeMarketSnapshot("600000.SH", "intraday")).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("ignores damaged storage and continues to save a later valid response", () => {
    localStorage.setItem(STORAGE_KEY, "not-json");
    expect(readStockVibeMarketSnapshot("600000.SH", "intraday")).toBeNull();
    expect(() => saveStockVibeMarketSnapshot("600000.SH", "intraday", market("600000.SH", "intraday", "2026-10-19T10:00:00+08:00"))).not.toThrow();
    expect(readStockVibeMarketSnapshot("600000.SH", "intraday")).not.toBeNull();
  });

  it("ignores a localStorage quota failure without losing the prior snapshot", () => {
    const previous = market("600000.SH", "intraday", "2026-10-19T10:00:00+08:00", 10);
    saveStockVibeMarketSnapshot("600000.SH", "intraday", previous);
    vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => { throw new DOMException("full", "QuotaExceededError"); });

    expect(() => saveStockVibeMarketSnapshot("600001.SH", "intraday", market("600001.SH", "intraday", "2026-10-19T10:01:00+08:00", 11))).not.toThrow();
    expect(readStockVibeMarketSnapshot("600000.SH", "intraday")).toEqual(previous);
    expect(readStockVibeMarketSnapshot("600001.SH", "intraday")).toBeNull();
  });

  it("keeps the most recently saved 24 snapshots and removes the oldest", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
    for (let index = 0; index < 25; index += 1) {
      const symbol = `${String(index).padStart(6, "0")}.SH`;
      saveStockVibeMarketSnapshot(symbol, "intraday", market(symbol, "intraday", "2026-10-19T10:00:00+08:00", index + 1));
      vi.setSystemTime(Date.now() + 1000);
    }

    expect(readStockVibeMarketSnapshot("000000.SH", "intraday")).toBeNull();
    expect(readStockVibeMarketSnapshot("000001.SH", "intraday")).not.toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").entries).toHaveLength(24);
  });

  it("evicts old entries to keep the serialized store near two megabytes", () => {
    const old = market("600000.SH", "1D", "2026-10-19T10:00:00+08:00") as StockVibeRead<{ [key: string]: unknown }>;
    old.native.large_payload = "a".repeat(600_000);
    const newest = market("600001.SH", "1D", "2026-10-19T10:01:00+08:00") as StockVibeRead<{ [key: string]: unknown }>;
    newest.native.large_payload = "b".repeat(600_000);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T00:00:00Z"));
    saveStockVibeMarketSnapshot("600000.SH", "1D", old);
    vi.setSystemTime(Date.now() + 1000);
    saveStockVibeMarketSnapshot("600001.SH", "1D", newest);

    expect(readStockVibeMarketSnapshot("600000.SH", "1D")).toBeNull();
    expect(readStockVibeMarketSnapshot("600001.SH", "1D")).not.toBeNull();
    expect((localStorage.getItem(STORAGE_KEY)?.length ?? 0) * 2).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("returns the newest observed quote per symbol without rewriting source or timestamps", () => {
    const recent = market("600000.SH", "intraday", "2026-10-19T10:02:00+08:00", 12);
    const older = market("600000.SH", "1D", "2026-10-19T10:01:00+08:00", 11);
    saveStockVibeMarketSnapshot("600000.SH", "intraday", recent);
    saveStockVibeMarketSnapshot("600000.SH", "1D", older);

    expect(readStockVibeQuoteSnapshots()["600000.SH"]).toEqual(recent.native);
  });
});
