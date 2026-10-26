import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workbench: vi.fn(),
  opportunity: vi.fn(),
  research: vi.fn(),
  api: {
    createRequestId: vi.fn(),
    getAttention: vi.fn(),
    getMarketData: vi.fn(),
    getWorkbenchMarket: vi.fn(),
    getRequest: vi.fn(),
    getStatus: vi.fn(),
    listJournalSessions: vi.fn(),
    updateAttention: vi.fn(),
  },
  preferences: {
    proactive_mode: "important_changes" as const,
    watched_symbols: ["600519.SH"],
    notification_start: "09:30",
    notification_end: "15:00",
    attention_interval_sec: 900,
    data_sources: ["tencent", "eastmoney"],
  },
}));

vi.mock("@/lib/stock-vibe-api", () => ({
  createStockVibeRequestId: mocks.api.createRequestId,
  getStockVibeAttention: mocks.api.getAttention,
  getStockVibeMarketData: mocks.api.getMarketData,
  getStockVibeWorkbenchMarket: mocks.api.getWorkbenchMarket,
  getStockVibeRequest: mocks.api.getRequest,
  getStockVibeStatus: mocks.api.getStatus,
  listStockVibeJournalSessions: mocks.api.listJournalSessions,
  updateStockVibeAttention: mocks.api.updateAttention,
  StockVibeApiError: class StockVibeApiError extends Error {
    constructor(readonly status: number, readonly code: string) { super(code); }
  },
}));

vi.mock("./StockVibeAttentionSettings", () => ({
  StockVibeAttentionSettings: (props: {
    open: boolean;
    error?: string;
    onSave: (value: typeof mocks.preferences) => void;
  }) => props.open ? (
    <div role="dialog">
      {props.error && <p role="alert">{props.error}</p>}
      <button type="button" onClick={() => props.onSave(mocks.preferences)}>测试保存</button>
    </div>
  ) : null,
}));
vi.mock("./StockVibeModelSettings", () => ({ StockVibeModelSettings: () => null }));
vi.mock("./StockVibeOperations", () => ({ StockVibeOperations: (props: { onReviewQuestion: (input: { operationId: string; filename: string; question: string }) => void }) =>
  <button type="button" onClick={() => props.onReviewQuestion({ operationId: "b".repeat(32), filename: "我的成交.csv", question: "解释这份复盘" })}>解释我的成交</button> }));
vi.mock("./StockVibeOpportunity", () => ({
  StockVibeOpportunity: (props: { mode: string; symbols: string[]; onAdd: (symbol: string) => void; onMarket: (symbol: string) => void; onResearch: (symbol: string) => void }) => {
    mocks.opportunity(props);
    return <p>机会选股双入口</p>;
  },
}));
vi.mock("./StockVibeResearch", () => ({
  StockVibeResearch: (props: { initialQuestion?: string; autoSend?: boolean; context?: { symbol: string; task: string }; open?: boolean; onOpenChange?: (open: boolean) => void }) => {
    mocks.research(props);
    return props.open === false ? null : <><p>{props.initialQuestion}</p>{props.autoSend && <p>打开即派发</p>}{props.context && <p>{`任务 ${props.context.symbol} ${props.context.task}`}</p>}<button type="button" onClick={() => props.onOpenChange?.(false)}>关闭研究</button></>;
  },
}));
vi.mock("./StockVibeScenarios", () => ({
  StockVibeScenarios: (props: { symbol: string | null; mode: string }) => <p>{`情景展示 ${props.symbol} ${props.mode}`}</p>,
}));
vi.mock("./StockVibeTeam", () => ({ StockVibeTeam: () => null }));
vi.mock("./StockVibeSavedResearch", () => ({
  StockVibeSavedResearch: (props: { sessionId: string; attemptId: string; onResume?: (sessionId: string, attemptId?: string) => void }) => <><p>{`已有通知报告 ${props.sessionId} ${props.attemptId}`}</p><button type="button" onClick={() => props.onResume?.(props.sessionId)}>继续原研究</button></>,
}));
vi.mock("./StockVibeWorkbench", () => ({
  StockVibeWorkbench: (props: { interval: string; market: unknown; onInterval: (interval: string) => void; onAsk: (symbol: string, question: string) => void; onResearch: (symbol: string, task: string, resume?: { sessionId: string; attemptId: string; mode: string; readOnly: boolean }) => void }) => {
    mocks.workbench(props);
    return <>
      <button type="button" onClick={() => props.onResearch("600519.SH", "technical")}>走势分析</button>
      <button type="button" onClick={() => props.onInterval("1M")}>月K</button>
      <button type="button" onClick={() => props.onAsk("600519.SH", "这波放量能撑住吗？")}>追问这只股票</button>
      <button type="button" onClick={() => props.onResearch("002460.SZ", "risk", { sessionId: "historic-session", attemptId: "historic-attempt", mode: "medium", readOnly: true })}>打开历史研究</button>
    </>;
  },
}));

import { StockVibeView } from "./StockVibeView";

const PENDING_KEY = "mona.stock-vibe.attention.pending.v1";
const REQUEST_ID = "a".repeat(32);
const HASH = "b".repeat(64);

function attentionRead(executionAllowed = false) {
  return { preferences: mocks.preferences, execution_allowed: executionAllowed, runtime: null };
}

function completedAttentionRecord() {
  return {
    request_id: REQUEST_ID,
    method: "PUT",
    path: "/host/attention",
    payload_sha256: HASH,
    status: "completed",
    error_category: null,
    source: null,
    source_sha256: null,
    receipt: { status_code: 200, body: mocks.preferences },
    receipt_sha256: HASH,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
    receipt_owner: "mona_settings",
  };
}

beforeEach(() => {
  localStorage.clear();
  mocks.workbench.mockClear();
  mocks.opportunity.mockClear();
  mocks.research.mockClear();
  Object.values(mocks.api).forEach((mock) => mock.mockReset());
  mocks.api.getStatus.mockResolvedValue({ execution_allowed: false, model_preset: null, running: false, diagnostic: null });
  mocks.api.getAttention.mockResolvedValue(attentionRead(false));
  mocks.api.getRequest.mockResolvedValue({ request_id: REQUEST_ID, status: "unknown" });
  mocks.api.createRequestId.mockReturnValue(REQUEST_ID);
  mocks.api.getWorkbenchMarket.mockResolvedValue({ native: {}, source: null });
});

describe("StockVibeView attention and scenario wiring", () => {
  it("restores review research by the exact native operation without guessing a title", async () => {
    mocks.api.listJournalSessions.mockResolvedValue({ native: [{ session_id: "review-session", journal_operation_id: "b".repeat(32) }], source: null });
    render(<StockVibeView />);
    fireEvent.click(screen.getByRole("button", { name: "账户与复盘" }));
    expect(screen.queryByLabelText("投资风格")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "解释我的成交" }));
    await waitFor(() => expect(mocks.research).toHaveBeenCalled());
    expect(mocks.api.listJournalSessions).toHaveBeenCalledWith("b".repeat(32));
    expect(mocks.research.mock.calls.at(-1)?.[0]).toMatchObject({ journalOperationId: "b".repeat(32), resumeSession: { sessionId: "review-session" }, open: true });
  });

  it("does not open a new review when its saved research lookup fails", async () => {
    mocks.api.listJournalSessions.mockRejectedValue(new Error("offline"));
    render(<StockVibeView />);
    fireEvent.click(screen.getByRole("button", { name: "账户与复盘" }));
    fireEvent.click(screen.getByRole("button", { name: "解释我的成交" }));
    await screen.findByText("暂时无法核对这份复盘的解读记录，请稍后重试。");
    expect(mocks.research).not.toHaveBeenCalled();
  });

  it("opens historical reports read-only and continues the original session without changing the selected stock", async () => {
    localStorage.setItem("mona.stock-vibe.display.v1", JSON.stringify({ symbols: ["600519.SH"], selected: "600519.SH", interval: "intraday", mode: "swing" }));
    mocks.api.getStatus.mockResolvedValue({ execution_allowed: true, model_preset: "default", running: true, diagnostic: null });
    const { rerender } = render(<StockVibeView />);
    expect(screen.queryByRole("button", { name: "AI投研" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开历史研究" }));
    await screen.findByText("已有通知报告 historic-session historic-attempt");
    expect(mocks.research).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续原研究" }));
    await waitFor(() => expect(mocks.research.mock.calls.at(-1)?.[0]).toMatchObject({
      symbol: null, resumeSession: { sessionId: "historic-session" },
    }));
    expect(mocks.research.mock.calls.at(-1)?.[0].context).toBeUndefined();
    expect(mocks.research.mock.calls.at(-1)?.[0].resumeScope).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("mona.stock-vibe.display.v1")!).selected).toBe("600519.SH");
    rerender(<StockVibeView notificationTarget={{ symbol: "000001.SZ", session_id: "other-session", attempt_id: "other-attempt" }} />);
    expect(await screen.findByText("已有通知报告 other-session other-attempt")).toBeInTheDocument();
    expect(screen.queryByText("已有通知报告 historic-session historic-attempt")).not.toBeInTheDocument();
    expect(mocks.research.mock.calls.at(-1)?.[0].open).toBe(false);
  });

  it("opens a candidate in research details while keeping the opportunity tab and watchlist unchanged", async () => {
    mocks.api.getStatus.mockResolvedValue({ execution_allowed: true, model_preset: "default", running: true, diagnostic: null });
    render(<StockVibeView />);
    fireEvent.click(screen.getByRole("button", { name: "机会选股" }));
    await screen.findByText("机会选股双入口");
    act(() => mocks.opportunity.mock.lastCall![0].onResearch("002460.SZ"));
    await waitFor(() => expect(mocks.research.mock.lastCall![0].context).toEqual({ symbol: "002460.SZ", task: "comprehensive", mode: "swing" }));
    expect(screen.getByRole("button", { name: "机会选股" })).toHaveAttribute("aria-current", "page");
    expect(JSON.parse(localStorage.getItem("mona.stock-vibe.display.v1")!).symbols).toEqual([]);
  });
  it("keeps opportunity available without a model and adds candidates without navigation or duplication", async () => {
    render(<StockVibeView />);
    fireEvent.click(screen.getByRole("button", { name: "机会选股" }));
    await screen.findByText("机会选股双入口");
    expect(screen.queryByText("先选择研究模型")).not.toBeInTheDocument();
    act(() => mocks.opportunity.mock.lastCall![0].onAdd("600519.SH"));
    act(() => mocks.opportunity.mock.lastCall![0].onAdd("600519.SH"));
    expect(screen.getByText("机会选股双入口")).toBeInTheDocument();
    expect(mocks.opportunity.mock.lastCall![0].symbols).toEqual(["600519.SH"]);
    expect(JSON.parse(localStorage.getItem("mona.stock-vibe.display.v1") ?? "{}").selected).toBeNull();
  });

  it("opens a candidate's intraday market without adding it to the watchlist", async () => {
    render(<StockVibeView />);
    fireEvent.click(screen.getByRole("button", { name: "机会选股" }));
    await screen.findByText("机会选股双入口");
    act(() => mocks.opportunity.mock.lastCall![0].onMarket("600519.SH"));
    await waitFor(() => expect(mocks.workbench.mock.lastCall![0].selectedSymbol).toBe("600519.SH"));
    expect(mocks.workbench.mock.lastCall![0].interval).toBe("intraday");
    expect(mocks.workbench.mock.lastCall![0].symbols).toEqual([]);
    expect(mocks.api.getWorkbenchMarket).toHaveBeenCalledWith("600519.SH", "intraday");
  });

  it("persists reordered watchlist symbols without changing the selected stock or reloading its chart", async () => {
    const key = "mona.stock-vibe.display.v1";
    localStorage.setItem(key, JSON.stringify({
      symbols: ["002460.SZ", "600000.SH"], selected: "002460.SZ", interval: "intraday", mode: "swing", workbench_version: 2,
    }));
    let unmount!: () => void;
    await act(async () => { ({ unmount } = render(<StockVibeView />)); });
    await waitFor(() => expect(mocks.api.getWorkbenchMarket).toHaveBeenCalledOnce());
    act(() => mocks.workbench.mock.lastCall![0].onReorder(["600000.SH", "002460.SZ"]));
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({
      symbols: ["600000.SH", "002460.SZ"], selected: "002460.SZ",
    }));
    expect(mocks.api.getWorkbenchMarket).toHaveBeenCalledOnce();
    unmount();
    await act(async () => { render(<StockVibeView />); });
    expect(mocks.workbench.mock.lastCall![0]).toMatchObject({ symbols: ["600000.SH", "002460.SZ"], selectedSymbol: "002460.SZ" });
  });

  it("never supplies the previous period's response in a render after switching from weekly to monthly", async () => {
    localStorage.setItem("mona.stock-vibe.display.v1", JSON.stringify({
      symbols: ["600519.SH"], selected: "600519.SH", interval: "1W", mode: "swing", workbench_version: 2,
    }));
    const weekly = { source: null, native: { "600519.SH": [{ trade_date: "2026-10-16", open: 10, high: 12, low: 9, close: 11, volume: 100 }] } };
    const monthly = { source: null, native: { "600519.SH": [{ trade_date: "2026-09-30", open: 9, high: 13, low: 8, close: 12, volume: 400 }] } };
    let resolveMonthly!: (value: typeof monthly) => void;
    mocks.api.getMarketData.mockResolvedValueOnce(weekly).mockImplementationOnce(() => new Promise((resolve) => { resolveMonthly = resolve; }));
    render(<StockVibeView />);
    await waitFor(() => expect(mocks.workbench).toHaveBeenCalledWith(expect.objectContaining({ interval: "1W", market: weekly })));

    fireEvent.click(screen.getByRole("button", { name: "月K" }));
    expect(mocks.workbench.mock.calls.filter(([props]) => props.interval === "1M").every(([props]) => props.market === null)).toBe(true);
    await act(async () => resolveMonthly(monthly));
    await waitFor(() => expect(mocks.workbench).toHaveBeenCalledWith(expect.objectContaining({ interval: "1M", market: monthly })));
    expect(mocks.workbench.mock.calls.some(([props]) => props.interval === "1M" && props.market === weekly)).toBe(false);
  });

  it("repairs and de-duplicates a saved stock exchange before reading quotes", async () => {
    localStorage.setItem("mona.stock-vibe.display.v1", JSON.stringify({
      symbols: ["002460.SH", "002460.SZ"], selected: "002460.SH", interval: "1D", mode: "swing",
    }));
    mocks.api.getMarketData.mockResolvedValue({ native: [], source: null });
    render(<StockVibeView />);

    await waitFor(() => expect(mocks.api.getWorkbenchMarket).toHaveBeenCalledOnce());
    expect(mocks.api.getWorkbenchMarket).toHaveBeenCalledWith("002460.SZ", "intraday");
    expect(JSON.parse(localStorage.getItem("mona.stock-vibe.display.v1") ?? "null")).toMatchObject({
      symbols: ["002460.SZ"], selected: "002460.SZ",
    });
  });

  it("preserves an existing ambiguous Shanghai index reference", async () => {
    localStorage.setItem("mona.stock-vibe.display.v1", JSON.stringify({
      symbols: ["000001.SH"], selected: "000001.SH", interval: "1D", mode: "swing",
    }));
    mocks.api.getMarketData.mockResolvedValue({ native: [], source: null });
    render(<StockVibeView />);

    await waitFor(() => expect(mocks.api.getWorkbenchMarket).toHaveBeenCalledWith("000001.SH", "intraday"));
  });

  it("keeps all stock modules and quote reads available when writes are unavailable", async () => {
    localStorage.setItem("mona.stock-vibe.display.v1", JSON.stringify({
      symbols: ["600519.SH"], selected: "600519.SH", interval: "1D", mode: "swing",
    }));
    mocks.api.getMarketData.mockResolvedValue({ native: [], source: null });
    render(<StockVibeView />);

    for (const label of ["投资工作台", "机会选股", "账户与复盘"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "策略实验室" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AI投研" })).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.api.getWorkbenchMarket).toHaveBeenCalledOnce());
  });

  it("opens the notification's existing report without dispatching research or loading a chart", async () => {
    mocks.api.getStatus.mockResolvedValue({ execution_allowed: true, model_preset: null, running: false, diagnostic: null });
    const consume = vi.fn();
    render(<StockVibeView notificationTarget={{ symbol: "600519.SH", session_id: "session-a", attempt_id: "attempt-a" }} onConsumeNotification={consume} />);
    expect(await screen.findByText("已有通知报告 session-a attempt-a")).toBeInTheDocument();
    expect(mocks.api.getMarketData).not.toHaveBeenCalled();
    expect(mocks.api.updateAttention).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledOnce();
  });

  it("checks a stored unknown receipt with GET only and blocks a second PUT", async () => {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ requestId: REQUEST_ID, preferences: mocks.preferences }));
    render(<StockVibeView />);

    const open = await screen.findByRole("button", { name: "关注与提醒" });
    expect(mocks.api.getAttention).not.toHaveBeenCalled();
    expect(mocks.api.getRequest).not.toHaveBeenCalled();
    fireEvent.click(open);
    await screen.findByRole("dialog");
    expect(mocks.api.getRequest).toHaveBeenCalledWith(REQUEST_ID);
    expect(mocks.api.updateAttention).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("只查询回执，没有重新提交");

    fireEvent.click(screen.getByRole("button", { name: "测试保存" }));
    expect(mocks.api.updateAttention).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null").requestId).toBe(REQUEST_ID);
  });

  it("persists a stable pending request before one user-triggered PUT and reports disabled runtime", async () => {
    mocks.api.updateAttention.mockImplementation(async (requestId: string, preferences: typeof mocks.preferences) => {
      expect(JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null")).toEqual({ requestId, preferences });
      return completedAttentionRecord();
    });
    render(<StockVibeView />);

    fireEvent.click(await screen.findByRole("button", { name: "关注与提醒" }));
    await screen.findByRole("dialog");
    expect(mocks.api.updateAttention).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "测试保存" }));

    await waitFor(() => expect(mocks.api.updateAttention).toHaveBeenCalledOnce());
    expect(mocks.api.updateAttention).toHaveBeenCalledWith(REQUEST_ID, mocks.preferences);
    await waitFor(() => expect(localStorage.getItem(PENDING_KEY)).toBeNull());
    expect(await screen.findByText(/设置已保存.*后台关注运行态尚未启用/)).toBeInTheDocument();
    expect(mocks.api.getAttention).toHaveBeenCalledTimes(2);
  });

  it("queries an unknown PUT receipt without replaying the write", async () => {
    mocks.api.updateAttention.mockResolvedValue({ request_id: REQUEST_ID, status: "unknown" });
    mocks.api.getRequest.mockResolvedValue({ request_id: REQUEST_ID, status: "unknown" });
    render(<StockVibeView />);

    fireEvent.click(await screen.findByRole("button", { name: "关注与提醒" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "测试保存" }));

    await waitFor(() => expect(mocks.api.updateAttention).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.api.getRequest).toHaveBeenCalledWith(REQUEST_ID));
    expect(mocks.api.updateAttention).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null").requestId).toBe(REQUEST_ID);
  });

  it("opens the selected native research task with stock context and an evidence-based prompt", async () => {
    mocks.api.getStatus.mockResolvedValue({ execution_allowed: true, model_preset: "default", running: true, diagnostic: null });
    render(<StockVibeView />);

    fireEvent.click(await screen.findByRole("button", { name: "走势分析" }));

    expect(await screen.findByText("任务 600519.SH technical")).toBeInTheDocument();
    const prompt = await screen.findByText(/基于真实历史行情分析/);
    expect(prompt).toHaveTextContent(/区间与来源/);
    expect(prompt).toHaveTextContent(/不把技术指标当未来上涨概率/);
  });
});

describe("股票追问", () => {
  it("把问题随对话直接派发，不让人在弹窗里重打一遍", async () => {
    render(<StockVibeView />);
    fireEvent.click(await screen.findByRole("button", { name: "追问这只股票" }));

    expect(await screen.findByText("这波放量能撑住吗？")).toBeInTheDocument();
    expect(screen.getByText("打开即派发")).toBeInTheDocument();
    expect(mocks.research.mock.calls.at(-1)?.[0]).toMatchObject({
      initialQuestion: "这波放量能撑住吗？", autoSend: true, open: true,
    });
  });
});
