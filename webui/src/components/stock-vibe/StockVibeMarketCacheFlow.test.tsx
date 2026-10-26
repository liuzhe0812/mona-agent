import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workbench: vi.fn(),
  api: {
    getAttention: vi.fn(),
    getAttentionEvents: vi.fn(),
    getMarketData: vi.fn(),
    getWorkbenchMarket: vi.fn(),
    getStatus: vi.fn(),
  },
}));

vi.mock("@/lib/stock-vibe-api", () => ({
  getStockVibeAttention: mocks.api.getAttention,
  getStockVibeAttentionEvents: mocks.api.getAttentionEvents,
  getStockVibeMarketData: mocks.api.getMarketData,
  getStockVibeWorkbenchMarket: mocks.api.getWorkbenchMarket,
  getStockVibeStatus: mocks.api.getStatus,
  StockVibeApiError: class StockVibeApiError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
  },
}));

vi.mock("./StockVibeAttentionSettings", () => ({ StockVibeAttentionSettings: () => null }));
vi.mock("./StockVibeModelSettings", () => ({ StockVibeModelSettings: () => null }));
vi.mock("./StockVibeOperations", () => ({ StockVibeOperations: () => null }));
vi.mock("./StockVibeOpportunity", () => ({ StockVibeOpportunity: () => null }));
vi.mock("./StockVibeResearch", () => ({ StockVibeResearch: () => null }));
vi.mock("./StockVibeScenarios", () => ({ StockVibeScenarios: () => null }));
vi.mock("./StockVibeSavedResearch", () => ({ StockVibeSavedResearch: () => null }));
vi.mock("./StockVibeTeam", () => ({ StockVibeTeam: () => null }));
vi.mock("./StockVibeMessages", () => ({ StockVibeMessages: () => null }));
vi.mock("./StockVibeWorkbench", () => ({
  StockVibeWorkbench: (props: {
    selectedSymbol: string | null;
    interval: string;
    market: { native?: { symbol?: string; interval?: string; quote?: { price?: number | null } } } | null;
    loading: boolean;
    marketNotice?: string | null;
    onSelect: (symbol: string) => void;
    onInterval: (interval: string) => void;
    onRefresh: () => void;
  }) => {
    mocks.workbench(props);
    const native = props.market?.native;
    return <div>
      <button type="button" onClick={() => props.onSelect("600732.SH")}>切换股票</button>
      <button type="button" onClick={() => props.onInterval("1W")}>切换周K</button>
      <button type="button" onClick={props.onRefresh}>刷新行情</button>
      <output data-testid="market-state">
        {native ? `${native.symbol}|${native.interval}|${native.quote?.price}` : "empty"}
      </output>
      {props.loading && <span>行情刷新中</span>}
      {props.marketNotice && <span>{props.marketNotice}</span>}
    </div>;
  },
}));

import { readStockVibeMarketSnapshot, saveStockVibeMarketSnapshot } from "@/lib/stock-vibe-market-cache";
import type { StockVibeChartInterval, StockVibeRead } from "@/lib/stock-vibe-api";
import { StockVibeView } from "./StockVibeView";

const DISPLAY_KEY = "mona.stock-vibe.display.v1";

function market(symbol: string, interval: string, price: number, status: "ok" | "unavailable" = "ok"): StockVibeRead {
  const observedAt = "2026-10-19T02:00:00Z";
  return {
    native: {
      status,
      symbol,
      interval,
      bars: status === "ok" ? [{ trade_date: "2026-10-19T09:30:00+08:00", open: price, high: price + 1, low: price - 1, close: price, volume: 100 }] : [],
      quote: { price: status === "ok" ? price : null, previous_close: price - 1, change: 1, change_pct: 1, name: `股票${symbol.slice(0, 6)}`, as_of: observedAt },
      trading_date: "2026-10-19",
      market_open: false,
      market_state: "closed",
      source: "tencent",
      observed_at: observedAt,
      volume_unit: "手",
      adjustment: "不复权",
    },
    source: { data_root_sha256: "a".repeat(64), instance_id: "instance-a", snapshot_id: "snapshot-a", patches: [] },
    observed_at: observedAt,
  };
}

function selectDisplay(symbol: string, interval: StockVibeChartInterval) {
  localStorage.setItem(DISPLAY_KEY, JSON.stringify({ symbols: ["600036.SH", "600732.SH"], selected: symbol, interval, mode: "swing", workbench_version: 2 }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  mocks.workbench.mockClear();
  Object.values(mocks.api).forEach((mock) => mock.mockReset());
  mocks.api.getStatus.mockResolvedValue({ execution_allowed: false, model_preset: null, running: false, diagnostic: null });
  mocks.api.getAttention.mockResolvedValue({ preferences: { proactive_mode: "important_changes", watched_symbols: [], notification_start: "09:30", notification_end: "15:00", attention_interval_sec: 900, data_sources: ["tencent"] }, execution_allowed: false, runtime: null });
  mocks.api.getAttentionEvents.mockResolvedValue({ native: { events: [] } });
  mocks.api.getWorkbenchMarket.mockResolvedValue(market("600036.SH", "intraday", 10));
  mocks.api.getMarketData.mockResolvedValue(market("600036.SH", "1W", 10));
});

describe("StockVibeView行情快照和后台刷新", () => {
  it("先显示缓存，手动刷新期间保留旧图，成功后更新并可在重新挂载时恢复", async () => {
    const symbol = "600036.SH", interval = "intraday";
    const cached = market(symbol, interval, 10);
    const initialRead = deferred<StockVibeRead>();
    const refresh = deferred<StockVibeRead>();
    saveStockVibeMarketSnapshot(symbol, interval, cached);
    selectDisplay(symbol, interval);
    mocks.api.getWorkbenchMarket.mockReturnValueOnce(initialRead.promise).mockReturnValueOnce(refresh.promise);

    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<StockVibeView />); });
    expect(screen.getByTestId("market-state")).toHaveTextContent("600036.SH|intraday|10");
    fireEvent.click(screen.getByRole("button", { name: "刷新行情" }));
    expect(screen.getByTestId("market-state")).toHaveTextContent("600036.SH|intraday|10");

    const fresh = market(symbol, interval, 12);
    await act(async () => refresh.resolve(fresh));
    await waitFor(() => expect(screen.getByTestId("market-state")).toHaveTextContent("600036.SH|intraday|12"));
    expect(readStockVibeMarketSnapshot(symbol, interval)).toEqual(fresh);

    view.unmount();
    mocks.api.getWorkbenchMarket.mockReturnValueOnce(new Promise(() => undefined));
    await act(async () => { render(<StockVibeView />); });
    expect(screen.getByTestId("market-state")).toHaveTextContent("600036.SH|intraday|12");
  });

  it.each([
    ["请求失败", "reject"] as const,
    ["服务返回不可用", "unavailable"] as const,
  ])("%s时保留最后一次成功行情，不覆盖持久快照", async (_label, outcome) => {
    const symbol = "600036.SH", interval = "intraday";
    const cached = market(symbol, interval, 10);
    saveStockVibeMarketSnapshot(symbol, interval, cached);
    selectDisplay(symbol, interval);
    if (outcome === "reject") mocks.api.getWorkbenchMarket.mockRejectedValueOnce(new Error("network"));
    else mocks.api.getWorkbenchMarket.mockResolvedValueOnce(market(symbol, interval, 0, "unavailable"));

    await act(async () => { render(<StockVibeView />); });
    expect(screen.getByTestId("market-state")).toHaveTextContent("600036.SH|intraday|10");
    await screen.findByText("本次行情未能刷新，图中保留上次数据，请留意数据时点。");
    expect(screen.getByTestId("market-state")).toHaveTextContent("600036.SH|intraday|10");
    expect(readStockVibeMarketSnapshot(symbol, interval)).toEqual(cached);
  });

  it("股票或周期切换后只显示对应快照，迟到的旧请求不能覆盖当前行情", async () => {
    const originalSymbol = "600036.SH", nextSymbol = "600732.SH";
    const original = market(originalSymbol, "intraday", 10);
    const nextIntraday = market(nextSymbol, "intraday", 20);
    const nextWeekly = market(nextSymbol, "1W", 30);
    saveStockVibeMarketSnapshot(originalSymbol, "intraday", original);
    saveStockVibeMarketSnapshot(nextSymbol, "intraday", nextIntraday);
    saveStockVibeMarketSnapshot(nextSymbol, "1W", nextWeekly);
    selectDisplay(originalSymbol, "intraday");
    const firstRequest = deferred<StockVibeRead>();
    const symbolRequest = deferred<StockVibeRead>();
    const periodRequest = deferred<StockVibeRead>();
    mocks.api.getWorkbenchMarket.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(symbolRequest.promise);
    mocks.api.getMarketData.mockReturnValueOnce(periodRequest.promise);

    await act(async () => { render(<StockVibeView />); });
    expect(screen.getByTestId("market-state")).toHaveTextContent("600036.SH|intraday|10");
    fireEvent.click(screen.getByRole("button", { name: "切换股票" }));
    expect(screen.getByTestId("market-state")).toHaveTextContent("600732.SH|intraday|20");
    fireEvent.click(screen.getByRole("button", { name: "切换周K" }));
    expect(screen.getByTestId("market-state")).toHaveTextContent("600732.SH|1W|30");

    await act(async () => {
      firstRequest.resolve(market(originalSymbol, "intraday", 99));
      symbolRequest.resolve(market(nextSymbol, "intraday", 88));
      periodRequest.resolve(market(nextSymbol, "1W", 77));
    });
    expect(screen.getByTestId("market-state")).toHaveTextContent("600732.SH|1W|77");
    expect(screen.getByTestId("market-state")).not.toHaveTextContent("99");
    expect(screen.getByTestId("market-state")).not.toHaveTextContent("88");
  });
});
