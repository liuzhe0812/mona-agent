import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ account: vi.fn(), create: vi.fn(), preview: vi.fn(), commit: vi.fn(), history: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/stock-vibe-paper-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-paper-api")>(),
  getStockVibePaperAccount: api.account, createStockVibePaperAccount: api.create, getStockVibePaperPreview: api.preview,
  commitStockVibePaperTrade: api.commit, listStockVibePaperTrades: api.history,
}));
vi.mock("@/lib/stock-vibe-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-api")>(), getStockVibeRequest: api.request }));

import { StockVibePaperTrading } from "./StockVibePaperTrading";
import { StockVibePaperApiError, type StockVibePaperAccount, type StockVibePaperPreview, type StockVibePaperTrade } from "@/lib/stock-vibe-paper-api";
import { StockVibeApiError, type StockVibeRequestRecord, type StockVibeWorkbenchReport } from "@/lib/stock-vibe-api";

const SYMBOL = "002460.SZ";
const REQUEST = "00000000-0000-4000-8000-000000000001";
const defaults = { initial_cash: 100000, lot_size: 100, fee_model: {}, currency: "CNY" as const };
const quote = { source: "tencent", as_of: "2026-10-20T15:00:00+08:00", observed_at: "2026-10-20T15:05:00+08:00", market_status: "closed", adjustment: "none" };
function account(created = true): StockVibePaperAccount {
  return { status: created ? "ok" : "uninitialized", defaults, account: created ? { initial_cash: 100000, cash: 96000, realized_pnl: 30, unrealized_pnl: -10,
    equity: 99990, total_pnl: -10, total_return: -0.0001, version: 1, created_at: quote.as_of } : null,
    positions: created ? [{ symbol: SYMBOL, name: "赣锋锂业", quantity: 100, available_quantity: 100, average_cost: 40, cost_basis: 4000,
      mark_price: 39.9, mark_as_of: quote.as_of, quote_source: "tencent", mark_status: "ok", market_value: 3990, unrealized_pnl: -10 }] : [],
    valuation: { complete: true, cached: false, missing_symbols: [], as_of: quote.as_of } };
}
function preview(side: "buy" | "sell" = "buy"): StockVibePaperPreview {
  return { status: "ready", preview_id: "preview-1", expires_at: new Date(Date.now() + 60000).toISOString(), account_version: 1,
    symbol: SYMBOL, name: "赣锋锂业", side, quantity: 100, lot_size: 100, price: 39.9, notional: 3990, fee: 5,
    cash_delta: side === "buy" ? -3995 : 3985, cash_after: 92005, available_quantity: 100, quote };
}
function trade(): StockVibePaperTrade {
  return { trade_id: "trade-1", request_id: REQUEST, symbol: SYMBOL, name: "赣锋锂业", side: "buy", quantity: 100, price: 39.9,
    notional: 3990, fee: 5, cash_after: 92005, quantity_after: 200, realized_pnl: null, note: "等需求回升", quote,
    research: { session_id: "session-old", attempt_id: "attempt-old", title: "当时的趋势报告", summary: "原报告快照内容", summary_sha256: "a".repeat(64), completed_at: quote.as_of, task: "technical", mode: "swing" },
    recorded_at: quote.observed_at, account_version: 2 };
}
function receipt(id: string, kind: "account" | "trade", body: unknown): StockVibeRequestRecord {
  return { request_id: id, method: "POST", path: kind === "account" ? "/mona/paper/account" : "/mona/paper/trades", payload_sha256: "a".repeat(64),
    status: "completed", error_category: null, source: null, source_sha256: null, receipt: { status_code: 200, body }, receipt_sha256: "b".repeat(64), created_at: quote.as_of, updated_at: quote.as_of };
}
function input() { return { selectedSymbol: SYMBOL, onSelect: vi.fn(), onResearch: vi.fn(), onError: vi.fn(),
  latest: { session_id: "session-old", attempt_id: "attempt-old", task: "technical", mode: "swing", summary: "原报告", created_at: quote.as_of, completed_at: quote.as_of } as StockVibeWorkbenchReport,
  children: ({ panel, actions }: { panel: React.ReactNode; actions: React.ReactNode }) => <>{panel}{actions}</>,
}; }
async function open(side: "buy" | "sell" = "buy") {
  await waitFor(() => expect(screen.getByRole("button", { name: side === "buy" ? "模拟买入" : "模拟卖出" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: side === "buy" ? "模拟买入" : "模拟卖出" }));
}
async function check() { fireEvent.click(screen.getByRole("button", { name: "核对参考价与费用" })); await screen.findByLabelText("模拟交易核对"); }

beforeEach(() => {
  localStorage.clear(); vi.restoreAllMocks();
  api.account.mockReset().mockResolvedValue(account()); api.create.mockReset(); api.preview.mockReset().mockImplementation(async (value) => preview(value.side));
  api.commit.mockReset().mockImplementation(async (id) => receipt(id, "trade", { trade: { ...trade(), request_id: id } }));
  api.history.mockReset().mockResolvedValue({ items: [trade()], total: 1, limit: 10, offset: 0 });
  api.request.mockReset().mockRejectedValue(new Error("pending"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("StockVibePaperTrading", () => {
  it("requires explicit initial funds and confirmation before any simulated trade", async () => {
    api.account.mockResolvedValue(account(false));
    api.create.mockImplementation(async (id) => { api.account.mockResolvedValue(account()); return receipt(id, "account", account()); });
    render(<StockVibePaperTrading {...input()} />);
    await screen.findByText("还没有模拟持仓。");
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
    await open();
    expect(screen.getByRole("dialog")).toHaveTextContent("设置模拟资金");
    expect(screen.getByRole("spinbutton", { name: "初始资金（元）" })).toHaveValue(100000);
    expect(api.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "初始资金（元）" }), { target: { value: "200000" } });
    fireEvent.click(screen.getByRole("button", { name: "创建模拟账户" }));
    await screen.findByRole("spinbutton", { name: "数量（股）" });
    expect(api.create).toHaveBeenCalledWith(expect.any(String), { initial_cash: 200000 });
    expect(api.preview).not.toHaveBeenCalled(); expect(api.commit).not.toHaveBeenCalled();
  });
  it("uses server totals, records only the frozen preview and optional explicit reason/research", async () => {
    const props = input(); render(<StockVibePaperTrading {...props} />);
    await open(); await check();
    const checked = within(screen.getByLabelText("模拟交易核对"));
    expect(checked.getByText("5.00 元")).toBeInTheDocument(); expect(checked.getByText("3,995.00 元")).toBeInTheDocument();
    expect(checked.getByText(/10.*20.*腾讯行情/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "买入理由（选填）" }), { target: { value: "我认为需求回升" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /关联最近研究/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认模拟买入" }));
    await waitFor(() => expect(api.commit).toHaveBeenCalledTimes(1));
    expect(api.commit.mock.calls[0][1]).toEqual({ preview_id: "preview-1", note: "我认为需求回升", research: { session_id: "session-old", attempt_id: "attempt-old" } });
    await screen.findByText("已模拟买入 002460 · 100 股");
    expect(localStorage.getItem("mona.stock-vibe.paper.pending.v1")).toBeNull();
    expect(api.account).toHaveBeenCalledTimes(3);
  });
  it("clears an old preview when quantity changes and ignores an in-flight old preview", async () => {
    let resolve!: (value: StockVibePaperPreview) => void;
    api.preview.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<StockVibePaperTrading {...input()} />); await open();
    fireEvent.click(screen.getByRole("button", { name: "核对参考价与费用" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "数量（股）" }), { target: { value: "200" } });
    await act(async () => resolve(preview()));
    expect(screen.queryByLabelText("模拟交易核对")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认模拟买入" })).not.toBeInTheDocument();
    expect(api.commit).not.toHaveBeenCalled();
  });
  it("shows controlled cash and sell-quantity errors beside the form without a second popup", async () => {
    api.preview.mockRejectedValue(new StockVibePaperApiError("insufficient_quantity"));
    const props = input(); render(<StockVibePaperTrading {...props} />); await open("sell");
    fireEvent.change(screen.getByRole("spinbutton", { name: "数量（股）" }), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: "核对参考价与费用" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("卖出数量超过模拟持仓");
    expect(props.onError).not.toHaveBeenCalled(); expect(api.commit).not.toHaveBeenCalled();
  });
  it("invalidates an expired preview before confirmation", async () => {
    api.preview.mockResolvedValue({ ...preview(), expires_at: new Date(Date.now() - 1000).toISOString() });
    render(<StockVibePaperTrading {...input()} />); await open(); await check();
    expect(screen.getByRole("button", { name: "确认模拟买入" })).toBeDisabled();
    expect(screen.getByText("核对已过期或账户已更新，请重新核对。")).toBeInTheDocument();
    expect(api.commit).not.toHaveBeenCalled();
  });
  it("invalidates the preview when another action has changed the account", async () => {
    render(<StockVibePaperTrading {...input()} />); await open(); await check();
    await waitFor(() => expect(api.account).toHaveBeenCalledTimes(2));
    const updated = account(); updated.account!.version = 2; api.account.mockResolvedValue(updated);
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认模拟买入" })).toBeDisabled());
    expect(api.commit).not.toHaveBeenCalled();
  });
  it("does not submit if durable tracking cannot be saved", async () => {
    const props = input(); render(<StockVibePaperTrading {...props} />); await open(); await check();
    const storage = localStorage;
    vi.stubGlobal("localStorage", { getItem: storage.getItem.bind(storage), removeItem: storage.removeItem.bind(storage), setItem: () => { throw new Error("quota"); } });
    fireEvent.click(screen.getByRole("button", { name: "确认模拟买入" }));
    expect(api.commit).not.toHaveBeenCalled(); expect(props.onError).toHaveBeenCalledWith(expect.stringContaining("尚未提交"));
  });
  it("restores an unknown write using only receipt reads and never repeats a trade", async () => {
    api.commit.mockRejectedValue(new Error("connection interrupted"));
    const props = input(); const first = render(<StockVibePaperTrading {...props} />); await open(); await check();
    fireEvent.click(screen.getByRole("button", { name: "确认模拟买入" }));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(expect.stringContaining("尚未确认")));
    const saved = JSON.parse(localStorage.getItem("mona.stock-vibe.paper.pending.v1")!);
    expect(Object.keys(saved).sort()).toEqual(["kind", "path", "requestId", "symbol"]);
    first.unmount();
    api.request.mockResolvedValue(receipt(saved.requestId, "trade", { trade: { ...trade(), request_id: saved.requestId } }));
    render(<StockVibePaperTrading {...props} />);
    await waitFor(() => expect(localStorage.getItem("mona.stock-vibe.paper.pending.v1")).toBeNull());
    expect(api.request).toHaveBeenCalledWith(saved.requestId); expect(api.commit).toHaveBeenCalledTimes(1);
  });
  it("does not accept a completed receipt for another request or symbol", async () => {
    api.commit.mockImplementation(async (id) => receipt(id, "trade", { trade: { ...trade(), request_id: id, symbol: "600000.SH" } }));
    render(<StockVibePaperTrading {...input()} />); await open(); await check();
    fireEvent.click(screen.getByRole("button", { name: "确认模拟买入" }));
    await waitFor(() => expect(api.commit).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem("mona.stock-vibe.paper.pending.v1")).not.toBeNull();
    expect(screen.queryByText("已模拟买入 002460 · 100 股")).not.toBeInTheDocument();
  });
  it("opens the recorded research snapshot rather than the latest report", async () => {
    const props = input(); render(<StockVibePaperTrading {...props} latest={{ ...props.latest, session_id: "session-new", attempt_id: "attempt-new" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "交易记录" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
    const details = within(screen.getByRole("dialog", { name: "模拟交易详情" }));
    expect(details.getByText(/参考行情：腾讯行情/)).toBeInTheDocument();
    expect(details.getByText("等需求回升")).toBeInTheDocument(); expect(details.getByText("原报告快照内容")).toBeInTheDocument();
    fireEvent.click(details.getByRole("button", { name: "查看当时的报告 →" }));
    expect(props.onResearch).toHaveBeenCalledWith(SYMBOL, "technical", { sessionId: "session-old", attemptId: "attempt-old", mode: "swing", readOnly: true });
    expect(api.commit).not.toHaveBeenCalled(); expect(api.create).not.toHaveBeenCalled();
  });
  it("uses red for realized gains and green for realized losses in the trade list", async () => {
    api.history.mockResolvedValue({ items: [{ ...trade(), trade_id: "gain", side: "sell", realized_pnl: 125.5 }, { ...trade(), trade_id: "loss", side: "sell", realized_pnl: -48 }], total: 2, limit: 10, offset: 0 });
    render(<StockVibePaperTrading {...input()} />);
    fireEvent.click(await screen.findByRole("button", { name: "交易记录" }));
    const history = within(screen.getByRole("dialog", { name: "模拟交易记录" }));
    expect(await history.findByText("+125.50")).toHaveClass("stock-vibe-up");
    expect(history.getByText("-48.00")).toHaveClass("stock-vibe-down");
    expect(api.commit).not.toHaveBeenCalled();
  });
  it("pages persistent history and returns from a detail without running a trade", async () => {
    api.history.mockImplementation(async ({ offset }) => ({ items: [{ ...trade(), trade_id: `trade-${offset}`, quantity: offset ? 200 : 100 }], total: 11, limit: 10, offset }));
    render(<StockVibePaperTrading {...input()} />);
    fireEvent.click(await screen.findByRole("button", { name: "交易记录" }));
    await screen.findByRole("button", { name: "查看详情" });
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(api.history).toHaveBeenLastCalledWith({ limit: 10, offset: 10 }));
    fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "← 返回记录" }));
    expect(screen.getByRole("dialog", { name: "模拟交易记录" })).toBeInTheDocument();
    expect(api.commit).not.toHaveBeenCalled();
  });
  it.each([[400, "invalid_input"], [401, "http_error"], [403, "http_error"], [413, "invalid_input"]] as const)("clears a known pre-dispatch HTTP %s refusal and permits corrected explicit submission", async (status, code) => {
    api.account.mockResolvedValue(account(false));
    api.create.mockRejectedValueOnce(new StockVibeApiError(status, code)).mockImplementation(async (id) => {
      api.account.mockResolvedValue(account()); return receipt(id, "account", account());
    });
    render(<StockVibePaperTrading {...input()} />); await open();
    fireEvent.click(screen.getByRole("button", { name: "创建模拟账户" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("本次尚未提交");
    expect(localStorage.getItem("mona.stock-vibe.paper.pending.v1")).toBeNull();
    fireEvent.change(screen.getByRole("spinbutton", { name: "初始资金（元）" }), { target: { value: "200000" } });
    fireEvent.click(screen.getByRole("button", { name: "创建模拟账户" }));
    await screen.findByRole("spinbutton", { name: "数量（股）" });
    expect(api.create).toHaveBeenCalledTimes(2);
    expect(api.create.mock.calls[1][1]).toEqual({ initial_cash: 200000 });
    expect(api.create.mock.calls[0][0]).not.toBe(api.create.mock.calls[1][0]);
    expect(api.request).not.toHaveBeenCalled();
  });
  it("validates the same initial-funds upper bound as the Host before dispatch", async () => {
    api.account.mockResolvedValue(account(false));
    render(<StockVibePaperTrading {...input()} />); await open();
    fireEvent.change(screen.getByRole("spinbutton", { name: "初始资金（元）" }), { target: { value: "1000000001" } });
    fireEvent.click(screen.getByRole("button", { name: "创建模拟账户" }));
    expect(screen.getByRole("alert")).toHaveTextContent("不超过 10 亿元");
    expect(api.create).not.toHaveBeenCalled();
  });
  it.each([[503, "native_unavailable"], [409, "request_conflict"]] as const)("keeps HTTP %s uncertainty for receipt reconciliation without resubmission", async (status, code) => {
    api.commit.mockRejectedValue(new StockVibeApiError(status, code));
    const props = input(); render(<StockVibePaperTrading {...props} />); await open(); await check();
    fireEvent.click(screen.getByRole("button", { name: "确认模拟买入" }));
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith(expect.stringContaining("尚未确认")));
    expect(localStorage.getItem("mona.stock-vibe.paper.pending.v1")).not.toBeNull();
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "确认模拟买入" })).toBeDisabled();
  });
  it("shows a read failure and retry beside actions even when the paper panel is hidden", async () => {
    let reject!: (error: unknown) => void;
    api.account.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    render(<StockVibePaperTrading {...input()}>{({ actions }) => <>{actions}</>}</StockVibePaperTrading>);
    expect(screen.getByRole("button", { name: "模拟买入" })).toBeDisabled();
    await act(async () => reject(new Error("offline")));
    expect(screen.getByText("模拟持仓暂未取得。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试读取" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "模拟买入" })).toBeEnabled());
    expect(screen.queryByText("模拟持仓暂未取得。")).not.toBeInTheDocument();
  });
  it("does not starve a slow first read with repeated timer or visibility reads", async () => {
    let resolve!: (value: StockVibePaperAccount) => void;
    api.account.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    vi.useFakeTimers(); render(<StockVibePaperTrading {...input()} />);
    expect(api.account).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(45000); });
    fireEvent(document, new Event("visibilitychange"));
    expect(api.account).toHaveBeenCalledTimes(1);
    await act(async () => resolve(account()));
    expect(screen.getByRole("button", { name: "模拟买入" })).toBeEnabled();
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(api.account).toHaveBeenCalledTimes(2);
  });
  it("keeps a newer native account version when an older snapshot is returned", async () => {
    const newer = account(); newer.account!.version = 2; newer.account!.cash = 85000; api.account.mockResolvedValueOnce(newer);
    render(<StockVibePaperTrading {...input()} />);
    await screen.findByText("85,000.00");
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(api.account).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(screen.getByText("85,000.00")).toBeInTheDocument();
    expect(screen.queryByText("96,000.00")).not.toBeInTheDocument();
  });
  it("shows partial valuations as missing rather than zero and keeps selection independent of watchlist", async () => {
    const value = account(); value.account!.equity = null; value.account!.unrealized_pnl = null; value.account!.total_pnl = null;
    value.positions[0].mark_price = null; value.positions[0].unrealized_pnl = null; value.positions[0].mark_as_of = null;
    value.valuation.complete = false; api.account.mockResolvedValue(value);
    const props = input(); render(<StockVibePaperTrading {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /赣锋锂业.*成本/ }));
    expect(props.onSelect).toHaveBeenCalledWith(SYMBOL);
    expect(screen.getByText(/部分持仓缺少现价/)).toBeInTheDocument();
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
    expect(screen.getByText("现价 —")).toBeInTheDocument();
  });
});
