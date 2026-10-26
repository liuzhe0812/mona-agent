import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ catalog: vi.fn(), batch: vi.fn(), request: vi.fn(), operation: vi.fn(), transport: vi.fn() }));
vi.mock("@/lib/stock-vibe-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-api")>(), getStockVibeRequest: api.request, getStockVibeOperation: api.operation, stockVibeRequest: api.transport }));
vi.mock("@/lib/stock-vibe-opportunity-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-opportunity-api")>(), getStockVibeOpportunityHistory: api.catalog, getStockVibeOpportunityHistoryBatch: api.batch }));

import type { StockVibeOpportunityHistoryRecord, StockVibeOpportunityHistoryResult, StockVibeOpportunityHistoryRangeResult, StockVibeOpportunityInput } from "@/lib/stock-vibe-opportunity-api";
import * as historyComponents from "./StockVibeOpportunityHistory";
import { StockVibeOpportunityHistoryRecords } from "./StockVibeOpportunityHistory";

const STORAGE = "mona.stock-vibe.opportunity-history-pending.v2";
const input: StockVibeOpportunityInput = { plan_id: "multifactor", mode: "swing", universe: "csi300" };
const receipt = (id: string, operationId = "history-1") => ({ request_id: id, method: "POST", path: "/mona/operations", status: "completed", receipt: { status_code: 201, body: { operation_id: operationId } }, receipt_sha256: "b".repeat(64) });
function output(overrides: Partial<StockVibeOpportunityHistoryResult> = {}): StockVibeOpportunityHistoryResult {
  return {
    kind: "opportunity_history", version: 1, status: "completed", selection_date: "2025-10-10", horizon: 5, top_n: 5, plan_ids: ["multifactor"], universe: "csi300",
    window: { start_date: "2025-10-13", end_date: "2025-10-17", available_trading_days: 5 },
    candidates: [{ symbol: "600519.SH", name: "当日入选股票", rank: 1, start_price: 100, end_price: 108, return: .08, status: "observed", market_excess: .05, industry: { name: "当时所属行业", return: .06, excess: .02, status: "observed" } }],
    summary: { selected: 1, observed: 1, average_return: .08, market_return: .03, industry_return: .06, excess_market: .05, excess_industry: .02 },
    benchmark: { name: "沪深300指数", symbol: "000300.SH", return: .03, start_price: 4000, end_price: 4120, status: "observed" },
    calculation: { start_basis: "下一市场交易日开盘", end_basis: "第5个市场交易日收盘", weighting: "起初等金额、不调仓", fees: "未扣交易费用", adjustment: "同源前复权" },
    method: { version: "historical-method-1" }, coverage: {}, limitations: [], request: { ...input, selection_date: "2025-10-10", horizon: 5, top_n: 5 }, ...overrides,
  };
}
function rangeOutput(): StockVibeOpportunityHistoryRangeResult {
  const single = output();
  return { kind: "opportunity_history_range", version: 1, status: "completed", start_date: "2025-10-10", end_date: "2025-10-20", horizon: 5, top_n: 5, plan_ids: ["multifactor"], universe: "csi300", frequency_trading_days: 5, batches: [{ batch_id: "batch-1", selection_date: single.selection_date, status: "completed", summary: single.summary, window: single.window }], summary: { total_batches: 1, complete_batches: 1, average_return: .08, market_return: .03, industry_return: .06, excess_market: .05, excess_industry: .02, outperform_market_count: 1, comparable_market_batches: 1 }, calculation: single.calculation, limitations: [], request: { ...input, start_date: "2025-10-10", end_date: "2025-10-20", horizon: 5, top_n: 5 } };
}
function standardOutput(): StockVibeOpportunityHistoryRangeResult {
  const old = rangeOutput(), original = old.batches[0];
  return { ...old, status: "incomplete", sampling: "all_market_days_v1", frequency_trading_days: 1, roster_scopes: ["current_scope_historical_check"],
    start_date: "2023-10-10", end_date: "2026-10-10", request: { ...old.request, start_date: "2023-10-10", end_date: "2026-10-10" },
    batches: [
      { ...original, batch_id: "complete-1", selection_date: "2024-01-02" },
      { ...original, batch_id: "complete-2", selection_date: "2025-10-10", summary: { ...original.summary, average_return: .04, excess_market: .01 } },
      { ...original, batch_id: "pending", selection_date: "2026-10-09", status: "incomplete", summary: { ...original.summary, observed: 0, average_return: null }, window: { ...original.window, end_date: null, available_trading_days: 1 } },
      { ...original, batch_id: "missing", selection_date: "2023-10-10", status: "unavailable", summary: { ...original.summary, selected: 0, observed: 0, average_return: null } },
      { ...original, batch_id: "empty", selection_date: "2026-10-08", summary: { ...original.summary, selected: 0, observed: 0, average_return: null } },
    ],
    summary: { ...old.summary, total_batches: 5, complete_batches: 2, average_return: .06, excess_market: .03, evaluated_start_date: "2024-01-02", evaluated_end_date: "2025-10-10", incomplete_batches: 1, unavailable_batches: 1, empty_batches: 1 },
    period_summaries: [{ label: "2024年", start_date: "2024-01-01", end_date: "2024-12-31", total_batches: 3, complete_batches: 1, average_return: .08, market_return: .03, industry_return: .06, excess_market: .05, excess_industry: .02 }, { label: "2025年", start_date: "2025-01-01", end_date: "2025-12-31", total_batches: 2, complete_batches: 1, average_return: .04, market_return: .03, industry_return: .06, excess_market: .01, excess_industry: -.02 }],
    offset_stability: { groups: [{ offset: 0, total_batches: 3, complete_batches: 1, average_return: .08, excess_market: .05 }, { offset: 1, total_batches: 2, complete_batches: 1, average_return: .04, excess_market: .01 }], min_average_return: .04, max_average_return: .08 },
  };
}
function record(overrides: Partial<StockVibeOpportunityHistoryRecord> = {}): StockVibeOpportunityHistoryRecord {
  return { operation_id: "history-1", operation: "opportunity_history", status: "completed", result_status: "completed", created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", input: { ...input, selection_date: "2025-10-10", horizon: 5, top_n: 5 }, ...overrides };
}
function records() {
  const onError = vi.fn();
  const view = render(<StockVibeOpportunityHistoryRecords onError={onError} />);
  return { ...view, onError };
}
async function openRecord() {
  fireEvent.click(await screen.findByRole("button", { name: /多因子精选/ }));
  return await screen.findByRole("dialog", { name: "选股方法回测详情" });
}
function expectReadOnly() {
  expect(screen.queryByRole("button", { name: /开始回测|继续观察|高级设置|完成设置/ })).not.toBeInTheDocument();
  expect(api.transport).not.toHaveBeenCalled();
}
beforeEach(() => {
  localStorage.clear(); Object.values(api).forEach((mock) => mock.mockReset());
  api.catalog.mockResolvedValue({ items: [record()], total: 1, limit: 20, offset: 0 }); api.batch.mockResolvedValue(output());
  api.operation.mockImplementation(async (id: string) => ({ native: { operation: "opportunity_history", operation_id: id, status: "completed", tool_result: output() } }));
});

describe("saved historical results remain read-only", () => {
  it("has no launcher export and reads old details from the backend with empty browser storage", async () => {
    expect(historyComponents).not.toHaveProperty("StockVibeOpportunityHistory");
    records(); const dialog = await openRecord(); await within(dialog).findByText("当日入选股票");
    expect(api.catalog).toHaveBeenCalledWith(20, 0); expect(api.operation).toHaveBeenCalledWith("history-1");
    expect(within(dialog).getByLabelText("本次回测条件")).toHaveTextContent("按5日目标选股，观察5个交易日");
    expect(within(dialog).getAllByText("+8%")[0]).toHaveClass("stock-vibe-opportunity-up");
    fireEvent.click(within(dialog).getByRole("button", { name: "怎么算的" })); const explanation = await screen.findByRole("dialog", { name: "这次回测怎么算的" });
    expect(within(explanation).getByText(/从2025-10-13开盘，看到2025-10-17收盘/)).toBeVisible();
    expect(within(explanation).getByText("100")).toBeVisible(); expect(within(explanation).getByText("108")).toBeVisible();
    expectReadOnly();
  });

  it("keeps the frozen pending list and missing average without offering a continuation", async () => {
    const pending = output({ status: "incomplete", candidates: [{ ...output().candidates[0], status: "pending", end_price: null, return: null, market_excess: null }], window: { start_date: "2025-10-13", end_date: null, available_trading_days: 2 }, summary: { ...output().summary, observed: 0, average_return: null, excess_market: null, excess_industry: null } });
    api.operation.mockResolvedValue({ native: { operation: "opportunity_history", operation_id: "history-1", status: "completed", tool_result: pending } });
    records(); const dialog = await openRecord(); await within(dialog).findByText("当日入选股票");
    expect(within(dialog).getAllByRole("status")[0]).toHaveTextContent("待观察"); expect(within(dialog).getByText("选后平均涨跌").parentElement).toHaveTextContent("—"); expectReadOnly();
  });

  it("preserves the saved price performance and historical industry gaps", async () => {
    const partial = output({ status: "incomplete", candidates: [{ ...output().candidates[0], industry: { status: "unavailable", return: null, excess: null, reason: "缺少该股票在选股日的行业归属。" } }], summary: { ...output().summary, industry_return: null, excess_industry: null }, limitations: ["缺少历史行业资料。"] });
    api.operation.mockResolvedValue({ native: { operation: "opportunity_history", operation_id: "history-1", status: "completed", tool_result: partial } });
    records(); const dialog = await openRecord(); await within(dialog).findByText("当日入选股票");
    expect(within(dialog).getAllByRole("status")[0]).toHaveTextContent("价格观察完成 · 对照资料缺失");
    fireEvent.click(within(dialog).getByRole("button", { name: "查看缺项" })); expect(await screen.findByText("缺少该股票在选股日的行业归属。")).toBeVisible(); expectReadOnly();
  });

  it("reads old interval artifacts and loads a saved batch only when opened", async () => {
    api.catalog.mockResolvedValue({ items: [record({ operation: "opportunity_history_range", input: rangeOutput().request })], total: 1, limit: 20, offset: 0 });
    api.operation.mockResolvedValue({ native: { operation: "opportunity_history_range", operation_id: "history-1", status: "completed", tool_result: rangeOutput() } });
    records(); const dialog = await openRecord(); await within(dialog).findByLabelText("区间回测结果"); expect(api.batch).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "怎么算的" })); const explanation = await screen.findByRole("dialog", { name: "区间回测怎么算的" });
    expect(within(explanation).getByText(/每隔5个市场交易日.*每批观察窗口不重叠/)).toBeVisible(); fireEvent.click(within(explanation).getByRole("button", { name: "关闭信息" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "2025-10-10" })); const batch = await screen.findByRole("dialog", { name: "历史批次详情" }); await within(batch).findByText("当日入选股票");
    expect(api.batch).toHaveBeenCalledWith("history-1", "batch-1"); expectReadOnly();
  });

  it("keeps saved daily coverage, period and offset results readable without recomputing", async () => {
    const result = standardOutput();
    api.catalog.mockResolvedValue({ items: [record({ operation: "opportunity_history_range", input: result.request })], total: 1, limit: 20, offset: 0 });
    api.operation.mockResolvedValue({ native: { operation: "opportunity_history_range", operation_id: "history-1", status: "completed", tool_result: result } });
    records(); const dialog = await openRecord(); expect(await within(dialog).findByLabelText("实际完成覆盖")).toHaveTextContent("2024-01-02 至 2025-10-10");
    expect(within(dialog).getByRole("table", { name: "分段历史表现" })).toHaveTextContent("2024年");
    fireEvent.click(within(dialog).getByRole("button", { name: "范围：当前成分的历史检验" })); const scope = await screen.findByRole("dialog", { name: "这次检验的股票范围" }); expect(within(scope).getByText(/可能遗漏当时在范围内、后来已退出的股票/)).toBeVisible(); fireEvent.click(within(scope).getByRole("button", { name: "关闭信息" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "不同起点会影响结果吗" })); const groups = await screen.findByRole("dialog", { name: "不同起点下的表现" }); expect(within(groups).getByRole("table", { name: "不同起点分组表现" })).toHaveTextContent("延后1个交易日"); expectReadOnly();
  });

  it("paginates the authoritative server catalog", async () => {
    api.catalog.mockImplementation(async (_limit, offset) => ({ items: [record({ operation_id: `history-${offset}` })], total: 21, limit: 20, offset }));
    records(); fireEvent.click(await screen.findByRole("button", { name: "下一页" })); await waitFor(() => expect(api.catalog).toHaveBeenCalledWith(20, 20)); expectReadOnly();
  });

  it("reconciles the existing unknown request using GET and opens its saved operation", async () => {
    const id = "a".repeat(32); localStorage.setItem(STORAGE, JSON.stringify({ id, title: "旧方法" })); api.request.mockResolvedValue(receipt(id));
    records(); const dialog = await screen.findByRole("dialog", { name: "选股方法回测详情" }); await within(dialog).findByText("当日入选股票");
    expect(api.request).toHaveBeenCalledWith(id); expect(api.operation).toHaveBeenCalledWith("history-1"); expect(localStorage.getItem(STORAGE)).toBeNull(); expectReadOnly();
  });

  it("recovers a legacy unknown request without changing the legacy row that already has an operation", async () => {
    const id = "c".repeat(32), saved = { id: "d".repeat(32), pending: "d".repeat(32), operationId: "saved-operation", title: "已保存" };
    localStorage.setItem("mona.stock-vibe.opportunity-history.v1", JSON.stringify([saved, { id, pending: id, title: "旧未确认提交" }])); api.request.mockResolvedValue(receipt(id));
    records(); await screen.findByRole("dialog", { name: "选股方法回测详情" }); await screen.findByText("当日入选股票");
    expect(api.request).toHaveBeenCalledWith(id); expect(JSON.parse(localStorage.getItem("mona.stock-vibe.opportunity-history.v1")!)).toEqual([saved]); expectReadOnly();
  });

  it("keeps an unresolved request identifier after a read failure without resubmitting", async () => {
    const pending = { id: "a".repeat(32), title: "旧方法" }; localStorage.setItem(STORAGE, JSON.stringify(pending)); api.request.mockRejectedValue(new Error("network"));
    const view = records(); await waitFor(() => expect(view.onError).toHaveBeenCalledOnce()); expect(view.onError).toHaveBeenCalledWith(expect.stringContaining("原请求已保留，没有重新提交"));
    expect(JSON.parse(localStorage.getItem(STORAGE)!)).toEqual(pending); expectReadOnly();
  });

  it("clears a rejected old request without suggesting or issuing another submission", async () => {
    const id = "a".repeat(32); localStorage.setItem(STORAGE, JSON.stringify({ id, title: "旧方法" }));
    api.request.mockResolvedValue({ request_id: id, method: "POST", path: "/mona/operations", status: "rejected", receipt: null, source: null, error_category: "not_dispatched" });
    const view = records(); await waitFor(() => expect(view.onError).toHaveBeenCalledWith("上次回测请求未被接受，没有重新提交。")); expect(localStorage.getItem(STORAGE)).toBeNull(); expectReadOnly();
  });

  it.each(["failed", "interrupted"])("keeps the saved partial result of a %s operation", async (status) => {
    api.operation.mockResolvedValue({ native: { operation: "opportunity_history", operation_id: "history-1", status, tool_result: output() } });
    records(); const dialog = await openRecord(); await within(dialog).findByText("当日入选股票"); expect(within(dialog).getByText(/本次未完整结束，已有结果保留/)).toBeVisible(); expectReadOnly();
  });

  it.each(["another-operation", "opportunity_screen"])("rejects a mismatched saved operation identity %s", async (wrong) => {
    api.operation.mockResolvedValue({ native: { operation: wrong === "opportunity_screen" ? wrong : "opportunity_history", operation_id: wrong === "another-operation" ? wrong : "history-1", status: "completed", tool_result: output() } });
    const view = records(); await openRecord(); await waitFor(() => expect(view.onError).toHaveBeenCalledOnce()); expect(screen.queryByText("当日入选股票")).not.toBeInTheDocument(); expectReadOnly();
  });

  it("rejects saved detail whose observation settings do not match the catalog", async () => {
    api.operation.mockResolvedValue({ native: { operation: "opportunity_history", operation_id: "history-1", status: "completed", tool_result: output({ horizon: 20 }) } });
    const view = records(); await openRecord(); await waitFor(() => expect(view.onError).toHaveBeenCalledOnce()); expect(screen.queryByText("当日入选股票")).not.toBeInTheDocument(); expectReadOnly();
  });

  it("reads existing persisted progress without dispatching or cancelling", async () => {
    api.operation.mockResolvedValue({ native: { operation: "opportunity_history_range", operation_id: "history-1", status: "running", tool_result: null, references: { progress: { stage: "history_batches", completed: 12, total: 700 } } } });
    records(); const dialog = await openRecord(); expect(await within(dialog).findByText(/已检验 12 \/ 700 个交易日/)).toHaveTextContent("可关闭此浮窗，稍后在历史记录查看"); expectReadOnly();
  });
});
