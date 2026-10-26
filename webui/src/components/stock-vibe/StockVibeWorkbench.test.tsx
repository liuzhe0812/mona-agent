import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ workbench: vi.fn(), forecast: vi.fn(), market: vi.fn(), paper: vi.fn(), search: vi.fn(), history: vi.fn() }));
vi.mock("@/lib/stock-vibe-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stock-vibe-api")>(),
  getStockVibeWorkbench: api.workbench,
  getStockVibeForecast: api.forecast,
  getStockVibeWorkbenchMarket: api.market,
  getStockVibeAnalysisHistory: api.history,
  searchStockVibeSymbols: api.search,
}));

vi.mock("@/lib/stock-vibe-paper-api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/stock-vibe-paper-api")>(), getStockVibePaperAccount: api.paper,
}));

import { StockVibeWorkbench, type StockVibeWorkbenchProps } from "./StockVibeWorkbench";
import type { StockVibeRead, StockVibeWorkbenchData, StockVibeWorkbenchMarketData } from "@/lib/stock-vibe-api";
import { saveStockVibeMarketSnapshot } from "@/lib/stock-vibe-market-cache";

const SYMBOL = "002460.SZ";
const EXCERPT = "这是一份基于公开行情与成交记录完成的真实研究摘要，列明了数据来源与研究范围。";
const DETAIL = "完整证据段落：这一部分应在打开全文后展示，不能在摘要入口触发新研究。";

function workbench(symbol = SYMBOL): StockVibeWorkbenchData {
  return { symbol, sessions: [], latest_report: null, scheduled_jobs: [], scheduler: null, portfolio: null, errors: [] };
}

function market(price = 38): StockVibeRead<StockVibeWorkbenchMarketData> {
  return { source: null, native: {
    status: "ok", symbol: SYMBOL, interval: "intraday",
    bars: [{ trade_date: "2026-10-16T15:00:00+08:00", close: price, volume: 100 }],
    quote: { price, previous_close: 40, change: price - 40, change_pct: (price - 40) / 40 * 100 },
    trading_date: "2026-10-16", market_open: false, market_state: "closed", source: "eastmoney",
    observed_at: "2026-10-16T15:05:00+08:00", volume_unit: "lots", adjustment: "none",
  } };
}

function props(overrides: Partial<StockVibeWorkbenchProps> = {}): StockVibeWorkbenchProps {
  return { symbols: [SYMBOL], selectedSymbol: SYMBOL, interval: "intraday", market: market(), loading: false,
    onSelect: vi.fn(), onAdd: vi.fn(), onRemove: vi.fn(), onReorder: vi.fn(), onInterval: vi.fn(), onResearch: vi.fn(), ...overrides };
}

beforeEach(() => {
  localStorage.clear();
  api.workbench.mockReset(); api.forecast.mockReset();
  api.market.mockReset().mockResolvedValue({ native: { status: "unavailable" }, source: null });
  api.paper.mockReset().mockResolvedValue({ status: "not_created", defaults: { initial_cash: 100000, lot_size: 100 }, account: null, positions: [], valuation: { complete: true } });
  api.search.mockReset().mockRejectedValue(new Error("offline"));
  api.history.mockReset().mockResolvedValue({ source: null, native: { symbol: SYMBOL, offset: 0, limit: 10, total: 0, items: [] } });
  api.workbench.mockImplementation(async (symbol: string) => ({ native: workbench(symbol), source: null }));
});
afterEach(() => vi.useRealTimers());

async function renderWorkbench(symbols: string[] = []) {
  const onAdd = vi.fn();
  await act(async () => { render(
    <StockVibeWorkbench
      symbols={symbols}
      selectedSymbol={null}
      interval="1D"
      market={null}
      loading={false}
      onSelect={vi.fn()}
      onAdd={onAdd}
      onRemove={vi.fn()}
      onReorder={vi.fn()}
      onInterval={vi.fn()}
      onResearch={vi.fn()}
    />,
  ); });
  return onAdd;
}

function addSymbol(value: string) {
  if (!screen.queryByRole("dialog")) fireEvent.click(screen.getByRole("button", { name: "添加自选" }));
  fireEvent.change(screen.getByLabelText("股票名称或代码"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "按代码添加" }));
}

describe("StockVibeWorkbench symbol input", () => {
  it("infers Shenzhen for a bare six-digit A-share code", async () => {
    const onAdd = await renderWorkbench();

    addSymbol("002460");

    expect(onAdd).toHaveBeenCalledWith("002460.SZ");
  });

  it("infers Shanghai and Beijing from their confirmed stock code ranges", async () => {
    const onAdd = await renderWorkbench();

    addSymbol("600000");
    addSymbol("920001");

    expect(onAdd.mock.calls).toEqual([["600000.SH"], ["920001.BJ"]]);
  });

  it("asks users to check unknown codes without suggesting an exchange suffix", async () => {
    const onAdd = await renderWorkbench();

    addSymbol("999999");

    expect(screen.getByRole("alert")).toHaveTextContent("暂无法识别该代码，请核对六位 A 股代码。");
    expect(screen.getByRole("alert")).not.toHaveTextContent("后缀");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("rejects non-numeric or non-six-digit input", async () => {
    const onAdd = await renderWorkbench();
    fireEvent.click(screen.getByRole("button", { name: "添加自选" }));
    const input = screen.getByLabelText("股票名称或代码");

    expect(input).toHaveAttribute("role", "combobox");
    addSymbol("00246x");

    expect(screen.getByRole("alert")).toHaveTextContent("请选择搜索结果，或输入六位数字代码添加。");
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("does not add a normalized duplicate", async () => {
    const onAdd = await renderWorkbench(["002460.SZ"]);

    addSymbol("002460");

    expect(screen.getByRole("alert")).toHaveTextContent("这只股票已在自选中。");
    expect(onAdd).not.toHaveBeenCalled();
  });
});

describe("StockVibeWorkbench user flows", () => {
  it("opens analysis history on demand without adding an inline list or starting analysis", async () => {
    const input = props();
    render(<StockVibeWorkbench {...input} />);
    const analysisHeader = screen.getByRole("heading", { name: "研究这只股票" }).parentElement?.parentElement;
    const recentResearch = screen.getByRole("region", { name: "最近研究" });
    expect(within(analysisHeader!).getByRole("button", { name: "分析记录" })).toBeInTheDocument();
    expect(within(recentResearch).queryByRole("button", { name: "分析记录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "问这份报告" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "附加资料" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "关联研究与任务" })).not.toBeInTheDocument();
    expect(api.history).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "分析记录" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("还没有这只股票的分析记录。");
    expect(api.history).toHaveBeenCalledWith(SYMBOL, { q: "", task: "all", state: "all", offset: 0, limit: 10 });
    expect(input.onResearch).not.toHaveBeenCalled();
  });

  it("restores watchlist names and quotes before background requests finish", async () => {
    const saved = market(38); saved.native.quote.name = "赣锋锂业";
    const other = market(20); other.native.symbol = "600000.SH"; other.native.quote.name = "浦发银行";
    saveStockVibeMarketSnapshot(SYMBOL, "intraday", saved);
    saveStockVibeMarketSnapshot("600000.SH", "intraday", other);
    api.market.mockImplementation(() => new Promise(() => undefined));
    render(<StockVibeWorkbench {...props({ symbols: [SYMBOL, "600000.SH"], market: null, loading: true })} />);
    const list = within(screen.getByRole("list", { name: "自选股票" }));
    expect(list.getByRole("button", { name: /赣锋锂业.*38.00/ })).toBeVisible();
    expect(list.getByRole("button", { name: /浦发银行.*20.00/ })).toBeVisible();
    await act(async () => undefined);
  });
  it("selects a simulated holding without adding it to watchlist and retains trade actions", async () => {
    api.paper.mockResolvedValue({ status: "ready", defaults: { initial_cash: 100000, lot_size: 100 }, account: { cash: 90000, equity: 100000, unrealized_pnl: 0, total_pnl: 0, version: 1 }, positions: [{ symbol: SYMBOL, name: "赣锋锂业", quantity: 100, available_quantity: 100, average_cost: 38, mark_price: 39, unrealized_pnl: 100 }], valuation: { complete: true } });
    const input = props({ symbols: [], selectedSymbol: null, market: null });
    render(<StockVibeWorkbench {...input} />);
    fireEvent.click(screen.getByRole("tab", { name: "模拟持仓" }));
    const list = await screen.findByRole("list", { name: "模拟持仓股票" });
    fireEvent.click(within(list).getByRole("button", { name: /赣锋锂业/ }));
    expect(input.onSelect).toHaveBeenCalledWith(SYMBOL);
    expect(input.onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "模拟交易操作" })).toBeInTheDocument();
  });

  it("shows six-digit symbols and consistent previous-close red/green quotes", async () => {
    const input = props();
    const { rerender } = render(<StockVibeWorkbench {...input} />);
    await waitFor(() => expect(api.workbench).toHaveBeenCalledWith(SYMBOL));
    expect(screen.getByRole("heading", { name: "002460" })).toBeInTheDocument();
    expect(screen.queryByText(SYMBOL)).not.toBeInTheDocument();
    const watchlist = within(screen.getByRole("list", { name: "自选股票" }));
    const quoteSummary = within(screen.getByRole("region", { name: "002460行情" }));
    expect(watchlist.getByText("38.00").closest(".stock-vibe-down")).not.toBeNull();
    expect(quoteSummary.getByText("38.00").closest(".stock-vibe-quote-price")).toHaveClass("stock-vibe-down");
    expect(watchlist.getByText("-5.00%")).toBeInTheDocument();
    expect(quoteSummary.getByText("-5.00%")).toBeInTheDocument();

    rerender(<StockVibeWorkbench {...input} market={market(42)} />);
    expect(watchlist.getByText("42.00").closest(".stock-vibe-up")).not.toBeNull();
    expect(quoteSummary.getByText("42.00").closest(".stock-vibe-quote-price")).toHaveClass("stock-vibe-up");
    expect(watchlist.getByText("+5.00%")).toBeInTheDocument();
    expect(quoteSummary.getByText("+5.00%")).toBeInTheDocument();
  });

  it("opens the four research tasks with one primary entry and three quiet entries", async () => {
    const input = props();
    render(<StockVibeWorkbench {...input} />);
    await screen.findByText("还没有这只股票的已完成研究。选择上方分析内容开始。");
    const entries = [["综合分析", "comprehensive"], ["财报与估值", "fundamental"],
      ["走势分析", "technical"], ["风险检查", "risk"]];
    const buttons = entries.map(([label, task]) => {
      const button = screen.getByRole("button", { name: label });
      fireEvent.click(button);
      expect(input.onResearch).toHaveBeenLastCalledWith(SYMBOL, task);
      return button;
    });
    // 综合研判是唯一主操作，其余三项保持低权重文字动作，不再四项同权。
    expect(buttons[0]).toHaveClass("stock-vibe-primary");
    for (const quiet of buttons.slice(1)) {
      expect(quiet).toHaveClass("stock-vibe-analysis-action");
      expect(quiet).not.toHaveClass("stock-vibe-primary");
    }
  });

  it("keeps current quote indicators above historical weekly candles", async () => {
    const current = market(42);
    current.native.quote.open = 40;
    current.native.quote.high = 43;
    current.native.quote.low = 39;
    current.native.quote.amount = 669000000;
    api.market.mockResolvedValue(current);
    render(<StockVibeWorkbench {...props({ interval: "1W", market: { source: null, native: {
      [SYMBOL]: [{ trade_date: "2025-01-03", open: 9, high: 11, low: 8, close: 10, volume: 100 }],
    } } })} />);
    await waitFor(() => expect(screen.getByText("成交额").nextElementSibling).toHaveTextContent("6.69亿"));
    expect(api.market).toHaveBeenCalledWith(SYMBOL, "intraday");
    expect(screen.getByText("今开").nextElementSibling).toHaveTextContent("40.00");
    expect(screen.getByText("收 10.00")).toBeVisible();
  });

  it("opens the latest native report in shared read-only details with its original identity", async () => {
    const data = workbench();
    data.latest_report = { session_id: "session-original", attempt_id: "attempt-original", task: "technical", mode: "medium",
      summary: `# 走势研究\n\n${EXCERPT}\n\n${DETAIL}`, created_at: "2026-10-16T08:00:00Z", completed_at: "2026-10-16T08:10:00Z" };
    api.workbench.mockResolvedValue({ native: data, source: null });
    const input = props();
    render(<StockVibeWorkbench {...input} />);
    await screen.findByText(EXCERPT);
    expect(screen.queryByText(DETAIL)).not.toBeInTheDocument();
    expect(input.onResearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "查看完整报告 →" }));
    expect(input.onResearch).toHaveBeenCalledOnce();
    expect(input.onResearch).toHaveBeenCalledWith(SYMBOL, "technical", {
      sessionId: "session-original", attemptId: "attempt-original", mode: "medium", readOnly: true,
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("rereads native summaries after a research completion without rerunning research", async () => {
    const input = props({ researchRevision: 0 });
    const { rerender } = render(<StockVibeWorkbench {...input} />);
    await waitFor(() => expect(api.workbench).toHaveBeenCalledOnce());
    const data = workbench();
    data.latest_report = { session_id: "new-session", attempt_id: "new-attempt", task: "risk", mode: "swing",
      summary: "刚完成的真实研究摘要", created_at: "2026-10-19T08:00:00Z", completed_at: "2026-10-19T08:10:00Z" };
    api.workbench.mockResolvedValue({ native: data, source: null });
    rerender(<StockVibeWorkbench {...input} researchRevision={1} />);
    expect(await screen.findByText("刚完成的真实研究摘要")).toBeInTheDocument();
    expect(api.workbench).toHaveBeenCalledTimes(2);
    expect(input.onResearch).not.toHaveBeenCalled();
  });

  it("clears the previous stock report while the next stock is still loading", async () => {
    const data = workbench();
    data.latest_report = { session_id: "session-a", attempt_id: "attempt-a", task: "risk", mode: "swing",
      summary: EXCERPT, created_at: "2026-10-16T08:00:00Z", completed_at: "2026-10-16T08:10:00Z" };
    let finishNext!: (value: StockVibeRead<StockVibeWorkbenchData>) => void;
    api.workbench.mockImplementation((symbol: string) => symbol === SYMBOL
      ? Promise.resolve({ native: data, source: null }) : new Promise((resolve) => { finishNext = resolve; }));
    const input = props();
    const { rerender } = render(<StockVibeWorkbench {...input} />);
    await screen.findByText(EXCERPT);
    rerender(<StockVibeWorkbench {...input} selectedSymbol="600000.SH" market={null} />);
    expect(screen.queryByText(EXCERPT)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "问这份报告" })).not.toBeInTheDocument();
    await act(async () => finishNext({ native: workbench("600000.SH"), source: null }));
    expect(screen.getByText("还没有这只股票的已完成研究。选择上方分析内容开始。")).toBeInTheDocument();
  });

  it("keeps intraday and daily prediction preferences independent and draws no unavailable forecast", async () => {
    api.forecast.mockImplementation(async (symbol: string, interval: string) => ({ source: null, native: {
      symbol, interval, status: "unavailable", experimental: true, as_of: null, last_price: null, points: [],
      reason_code: "intraday_market_closed", reason: "休市后没有待预测的盘中分钟。",
    } }));
    const input = props();
    const { container, rerender } = render(<StockVibeWorkbench {...input} />);
    const intraday = screen.getByRole("switch", { name: "分时走势预测" });
    expect(intraday).toHaveAttribute("aria-checked", "false");
    fireEvent.click(intraday);
    await screen.findByText("盘中预测仅在交易时段更新。");
    expect(api.forecast).toHaveBeenLastCalledWith(SYMBOL, "intraday");
    expect(container.querySelector('line[stroke-dasharray="5 4"]')).toBeNull();
    const daily = market(); daily.native.interval = "1D";
    daily.native.bars = [{ trade_date: "2026-10-16", close: 38, open: 40, high: 41, low: 37, volume: 100 }];
    rerender(<StockVibeWorkbench {...input} interval="1D" market={daily} />);
    expect(screen.getByRole("switch", { name: "日K走势预测" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("switch", { name: "日K走势预测" }));
    await waitFor(() => expect(api.forecast).toHaveBeenLastCalledWith(SYMBOL, "1D"));
    rerender(<StockVibeWorkbench {...input} />);
    expect(screen.getByRole("switch", { name: "分时走势预测" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch", { name: "分时走势预测" }));
    rerender(<StockVibeWorkbench {...input} interval="1D" market={daily} />);
    expect(screen.getByRole("switch", { name: "日K走势预测" })).toHaveAttribute("aria-checked", "true");
    await act(async () => {});
    expect(container.querySelector('line[stroke-dasharray="5 4"]')).toBeNull();
  });

  it("polls pending predictions only after each response and stops after completion without an error dialog", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    api.forecast.mockResolvedValueOnce({ source: null, native: { symbol: SYMBOL, interval: "intraday", status: "pending", phase: "validation", retry_after_ms: 2000 } })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const input = props({ onError: vi.fn() });
    render(<StockVibeWorkbench {...input} />);
    fireEvent.click(screen.getByRole("switch", { name: "分时走势预测" }));
    await act(async () => {});
    expect(screen.getByText("正在核对历史表现")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
    expect(api.forecast).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.forecast).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.forecast).toHaveBeenCalledTimes(2);
    await act(async () => finish({ source: null, native: { symbol: SYMBOL, interval: "intraday", status: "unavailable", reason_code: "intraday_market_closed" } }));
    expect(screen.getByText("盘中预测仅在交易时段更新。")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.forecast).toHaveBeenCalledTimes(2);
    expect(input.onError).not.toHaveBeenCalled();
  });

  it("cancels pending timers when prediction is disabled or the period changes", async () => {
    vi.useFakeTimers();
    api.forecast.mockResolvedValue({ source: null, native: { symbol: SYMBOL, interval: "intraday", status: "pending", phase: "features", retry_after_ms: 2000 } });
    const input = props();
    const { rerender } = render(<StockVibeWorkbench {...input} />);
    fireEvent.click(screen.getByRole("switch", { name: "分时走势预测" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("switch", { name: "分时走势预测" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.forecast).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("正在整理走势依据")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "分时走势预测" }));
    await act(async () => {});
    expect(api.forecast).toHaveBeenCalledTimes(2);
    rerender(<StockVibeWorkbench {...input} interval="1W" market={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.forecast).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("switch", { name: /走势预测/ })).not.toBeInTheDocument();
  });

  it("serializes a new selection behind an unfinished read and discards the stale response", async () => {
    vi.useFakeTimers();
    localStorage.setItem("mona.stock-vibe.forecast-display.v1", JSON.stringify({ intraday: true }));
    let finish!: (value: unknown) => void;
    api.forecast.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ source: null, native: { symbol: "600000.SH", interval: "intraday", status: "pending", phase: "features", retry_after_ms: 2000 } });
    const input = props({ onError: vi.fn() });
    const { rerender, unmount } = render(<StockVibeWorkbench {...input} />);
    await act(async () => {});
    expect(api.forecast).toHaveBeenCalledTimes(1);
    const next = market(); next.native.symbol = "600000.SH";
    rerender(<StockVibeWorkbench {...input} symbols={["600000.SH"]} selectedSymbol="600000.SH" market={next} />);
    await act(async () => {});
    expect(api.forecast).toHaveBeenCalledTimes(1);
    await act(async () => finish({ source: null, native: { symbol: SYMBOL, interval: "intraday", status: "pending", phase: "validation", retry_after_ms: 2000 } }));
    expect(api.forecast).toHaveBeenCalledTimes(2);
    expect(api.forecast).toHaveBeenLastCalledWith("600000.SH", "intraday");
    expect(screen.getByText("正在整理走势依据")).toBeVisible();
    expect(screen.queryByText("正在核对历史表现")).not.toBeInTheDocument();
    expect(input.onError).not.toHaveBeenCalled();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.forecast).toHaveBeenCalledTimes(2);
  });
});
