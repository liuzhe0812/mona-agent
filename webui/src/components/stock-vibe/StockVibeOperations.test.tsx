import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  downloadArtifact: vi.fn(),
  getOperation: vi.fn(),
  getPortfolio: vi.fn(),
  getPortfolioStatus: vi.fn(),
  getRequest: vi.fn(),
  getShadowProfile: vi.fn(),
  listOperations: vi.fn(),
  listShadowProfiles: vi.fn(),
  listUploads: vi.fn(),
  startOperation: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("@/lib/stock-vibe-api", () => ({
  downloadStockVibeArtifact: api.downloadArtifact,
  getStockVibeOperation: api.getOperation,
  getStockVibePortfolio: api.getPortfolio,
  getStockVibePortfolioStatus: api.getPortfolioStatus,
  getStockVibeRequest: api.getRequest,
  getStockVibeShadowProfile: api.getShadowProfile,
  listStockVibeOperations: api.listOperations,
  listStockVibeShadowProfiles: api.listShadowProfiles,
  listStockVibeUploads: api.listUploads,
  startStockVibeOperation: api.startOperation,
  uploadStockVibeFile: api.uploadFile,
  StockVibeApiError: class StockVibeApiError extends Error {},
}));

import { StockVibeOperations } from "./StockVibeOperations";

const UPLOAD_ID = "c".repeat(32);
const SOURCE = {
  data_root_sha256: "a".repeat(64),
  instance_id: "b".repeat(32),
  snapshot_id: `sha256:${"d".repeat(64)}`,
  patches: [],
};

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(api)) mock.mockReset();
  api.getPortfolio.mockResolvedValue({ native: { status: "empty", snapshot: null }, source: null });
  api.getPortfolioStatus.mockResolvedValue({ native: { status: "idle" }, source: null });
  api.getShadowProfile.mockImplementation(async (shadowId: string) => ({
    native: { shadow_id: shadowId, source_market: "china_a", rules: [] },
    source: null,
  }));
  api.listShadowProfiles.mockResolvedValue({
    native: { profiles: [{ shadow_id: "shadow_2bb71d74", source_market: "china_a" }] },
    source: null,
  });
  api.listUploads.mockResolvedValue({
    uploads: [{
      upload_id: UPLOAD_ID,
      request_id: "f".repeat(32),
      filename: "old-trades.csv",
      size_bytes: 1024,
      payload_sha256: "1".repeat(64),
      receipt_sha256: "2".repeat(64),
      source: SOURCE,
      uploaded_at: "2026-10-16T00:00:00Z",
    }],
  });
  api.listOperations.mockResolvedValue({ native: { operations: [] }, source: null });
  api.startOperation.mockResolvedValue({
    request_id: "3".repeat(32),
    method: "POST",
    path: "/mona/operations",
    payload_sha256: "4".repeat(64),
    status: "completed",
    error_category: null,
    source: SOURCE,
    source_sha256: "5".repeat(64),
    receipt: { status_code: 200, body: { operation_id: "operation_1" } },
    receipt_sha256: "6".repeat(64),
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
  });
  api.getOperation.mockResolvedValue({
    native: { operation_id: "operation_1", operation: "run_shadow_backtest", status: "queued" },
    source: SOURCE,
  });
});


const result = (pnl = 123) => ({ total_records: 2, date_range: "2026-01-02 至 2026-01-06", format_detected: "eastmoney", profile: { total_roundtrips: 1, total_pnl: pnl, win_rate: 1 },
  review: { coverage: { parsed_records: 2, buy_records: 1, sell_records: 1, currencies: ["CNY"] }, preview: { rows: [] }, unmatched: { total_lots: 0 } } });
const journal = (id = "journal_1", pnl = 123, date = "2026-10-16T02:00:00Z") => ({ operation_id: id, operation: "analyze_trade_journal", status: "completed", created_at: date, references: { upload_id: UPLOAD_ID }, tool_result: result(pnl) });
const receipt = (id: string, body: Record<string, unknown> | null) => ({ request_id: id, status: body ? "completed" : "unknown", receipt: body ? { status_code: 200, body } : null, receipt_sha256: body ? "6".repeat(64) : null });
async function chooseFile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "选择已上传成交文件" }));
  await user.click(await screen.findByRole("menuitem", { name: /old-trades/ }));
}
async function advanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "交易方法实验" }));
  return screen.getByRole("dialog", { name: "交易方法实验" });
}

describe("account review workflow", () => {
  it("starts with review, shows native history, and preserves unrelated durable tasks", async () => {
    const previous = { writes: [{ requestId: "8".repeat(32), kind: "operation", label: "旧策略独立验证", status: "unknown", createdAt: "2026-10-16T00:00:00Z", operationInput: { operation: "strategy_oos_validation", run_id: "old_run" } }], uploads: [] };
    localStorage.setItem("mona.stock-vibe.operations.v1", JSON.stringify(previous));
    api.listOperations.mockResolvedValue({ native: { operations: [journal(), { operation_id: "other", operation: "opportunity_history", status: "running" }] } });
    render(<StockVibeOperations enabled />);
    await screen.findByRole("button", { name: /old-trades.*2026-10-16/ });
    expect(screen.getByRole("tab", { name: "成交复盘" })).toHaveAttribute("data-state", "active");
    expect(screen.queryByRole("button", { name: "扫描条件信号" })).not.toBeInTheDocument();
    expect(screen.queryByText("旧策略独立验证")).not.toBeInTheDocument();
    expect(api.getRequest).not.toHaveBeenCalled();
    expect(api.startOperation).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem("mona.stock-vibe.operations.v1") ?? "{}")).toEqual(previous);
  });
  it("confirms the parsed file without reanalysis and asks about the precise review", async () => {
    const user = userEvent.setup(); const onReviewQuestion = vi.fn();
    api.startOperation.mockImplementation(async (id: string) => receipt(id, { operation_id: "journal_1" }));
    api.getOperation.mockResolvedValue({ native: journal() });
    render(<StockVibeOperations enabled onReviewQuestion={onReviewQuestion} />);
    await chooseFile(user); await user.click(screen.getByRole("button", { name: "读取并核对" }));
    await screen.findByRole("heading", { name: "核对识别结果" });
    expect(api.startOperation.mock.calls[0][1]).toEqual({ operation: "analyze_trade_journal", upload_id: UPLOAD_ID });
    expect(screen.queryByText("这份成交的交易表现")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认并查看复盘" }));
    await user.click(await screen.findByRole("button", { name: "解释这份复盘" }));
    expect(onReviewQuestion).toHaveBeenCalledWith({ operationId: "journal_1", filename: "old-trades.csv", question: expect.any(String) });
    expect(api.startOperation).toHaveBeenCalledTimes(1); expect(api.uploadFile).not.toHaveBeenCalled();
  });
  it("imports once on a double click and reads with separate durable request ids", async () => {
    const user = userEvent.setup();
    api.uploadFile.mockImplementation(async (id: string) => receipt(id, { file_path: `uploads/${UPLOAD_ID}.csv` }));
    api.startOperation.mockImplementation(async (id: string) => receipt(id, { operation_id: "journal_1" }));
    api.getOperation.mockResolvedValue({ native: journal() });
    render(<StockVibeOperations enabled />);
    await user.upload(screen.getByLabelText("选择成交文件"), new File(["data"], "trades.csv", { type: "text/csv" }));
    fireEvent.click(screen.getByRole("button", { name: "导入并核对" })); fireEvent.click(screen.getByRole("button", { name: /导入并核对|正在读取/ })); await screen.findByRole("heading", { name: "核对识别结果" });
    expect(api.uploadFile).toHaveBeenCalledTimes(1); expect(api.startOperation).toHaveBeenCalledTimes(1);
    expect(api.uploadFile.mock.calls[0][0]).not.toBe(api.startOperation.mock.calls[0][0]);
    const writes = JSON.parse(localStorage.getItem("mona.stock-vibe.operations.v1") ?? "{}").writes;
    expect(writes.map((write: { requestId: string }) => write.requestId)).toEqual(expect.arrayContaining([api.uploadFile.mock.calls[0][0], api.startOperation.mock.calls[0][0]]));
  });
  it("never analyzes or replays while upload confirmation is unknown", async () => {
    const user = userEvent.setup(); api.uploadFile.mockImplementation(async (id: string) => receipt(id, null)); api.getRequest.mockImplementation(async (id: string) => receipt(id, null));
    render(<StockVibeOperations enabled />);
    await user.upload(screen.getByLabelText("选择成交文件"), new File(["data"], "trades.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: "导入并核对" })); await screen.findByText(/结果尚未确认/);
    expect(api.startOperation).not.toHaveBeenCalled(); expect(api.uploadFile).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "导入并核对" })).toBeDisabled();
  });
  it("loads the chosen historical operation instead of another result from the same file", async () => {
    const user = userEvent.setup();
    api.listOperations.mockResolvedValue({ native: { operations: [{ ...journal("old", 123, "2026-10-15T02:00:00Z"), tool_result: undefined }, journal("new", 999)] } });
    api.getOperation.mockImplementation(async (id: string) => ({ native: journal(id, id === "old" ? 123 : 999) }));
    render(<StockVibeOperations enabled />);
    await user.click(await screen.findByRole("button", { name: /old-trades.*2026-10-15/ })); const report = await screen.findByLabelText("成交文件统计");
    expect(within(report).getByText("CNY 123")).toBeInTheDocument(); expect(within(report).queryByText("CNY 999")).not.toBeInTheDocument();
    expect(api.getOperation).toHaveBeenCalledWith("old"); expect(api.startOperation).not.toHaveBeenCalled();
  });
  it("keeps holdings secondary and offers importing without claiming zero assets", async () => {
    const user = userEvent.setup(); render(<StockVibeOperations enabled />); await user.click(screen.getByRole("tab", { name: "持仓" }));
    await screen.findByText("还没有持仓数据"); expect(screen.getByText(/暂未接通普通东方财富交易账号/)).toBeInTheDocument();
    expect(screen.queryByText("0.00")).not.toBeInTheDocument(); await user.click(screen.getByRole("button", { name: "去导入成交" }));
    expect(screen.getByRole("button", { name: "导入并核对" })).toBeInTheDocument();
  });
  it("shows readable holdings and leaves unpriced or absent values unavailable", async () => {
    const user = userEvent.setup(); api.getPortfolio.mockResolvedValue({ native: { status: "ok", snapshot: { created_at: "2026-10-16T00:00:00Z", complete: false, display_currency: "CNY", totals: { display: 1000 }, positions: [{ symbol: "002460.SZ", quantity: 100, priced: false, market_value_usd: 0 }], note: "账户原始字段仅在浮窗阅读" } } });
    const { container } = render(<StockVibeOperations enabled />); await user.click(screen.getByRole("tab", { name: "持仓" })); await screen.findByText("002460.SZ");
    expect(screen.getAllByText("未估值")).toHaveLength(2); expect(screen.queryByText(/账户原始字段仅在浮窗阅读/)).not.toBeInTheDocument(); expect(container.querySelector("details")).toBeNull();
    await user.click(screen.getByRole("button", { name: "查看原生快照字段" })); expect(within(screen.getByRole("dialog", { name: "查看原生快照字段" })).getByText(/账户原始字段仅在浮窗阅读/)).toBeInTheDocument();
  });
});

describe("review failures stay actionable", () => {
  it.each(["not_dispatched", "native_rejected"])("explains a rejected upload (%s) without starting analysis or retrying", async (kind) => {
    const user = userEvent.setup();
    api.uploadFile.mockImplementation(async (id: string) => ({ ...receipt(id, null), status: "rejected", error_category: kind === "not_dispatched" ? kind : null,
      source: kind === "not_dispatched" ? null : SOURCE, receipt: kind === "not_dispatched" ? null : { status_code: 422, body: {} }, receipt_sha256: kind === "not_dispatched" ? null : "6".repeat(64) }));
    render(<StockVibeOperations enabled />);
    await user.upload(screen.getByLabelText("选择成交文件"), new File(["data"], "trades.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: "导入并核对" }));
    const alert = await screen.findByRole("alertdialog");
    expect(within(alert).getByText(kind === "not_dispatched" ? /成交文件没有上传/ : /成交文件上传未成功/)).toBeInTheDocument();
    expect(api.uploadFile).toHaveBeenCalledTimes(1); expect(api.startOperation).not.toHaveBeenCalled();
    await user.click(within(alert).getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("button", { name: "导入并核对" })).toBeEnabled();
  });
  it("explains rejected parsing without inventing a review result", async () => {
    const user = userEvent.setup();
    api.startOperation.mockImplementation(async (id: string) => ({ ...receipt(id, {}), status: "rejected", receipt: { status_code: 422, body: {} } }));
    render(<StockVibeOperations enabled />); await chooseFile(user); await user.click(screen.getByRole("button", { name: "读取并核对" }));
    const alert = await screen.findByRole("alertdialog");
    expect(within(alert).getByText(/未生成新的复盘/)).toBeInTheDocument();
    expect(screen.queryByLabelText("成交文件统计")).not.toBeInTheDocument(); expect(api.startOperation).toHaveBeenCalledTimes(1);
  });
  it.each(["rejected", "pending"])("allows file selection and review while unrelated reads are %s", async (state) => {
    const user = userEvent.setup();
    api.getPortfolio.mockRejectedValue(new Error("portfolio unavailable"));
    api.listShadowProfiles.mockImplementation(() => state === "rejected" ? Promise.reject(new Error("shadow unavailable")) : new Promise(() => {}));
    api.startOperation.mockImplementation(async (id: string) => receipt(id, { operation_id: "journal_1" }));
    api.getOperation.mockResolvedValue({ native: journal() });
    render(<StockVibeOperations enabled />); await chooseFile(user);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "读取并核对" })); await screen.findByRole("heading", { name: "核对识别结果" });
    expect(screen.getByRole("heading", { name: "old-trades.csv" })).toBeInTheDocument();
    expect(api.startOperation.mock.calls[0][1]).toEqual({ operation: "analyze_trade_journal", upload_id: UPLOAD_ID });
  });
});

describe("advanced experiments", () => {
  it("binds the profile's actual journal rather than the selected file and caps A-share samples at five", async () => {
    const user = userEvent.setup(); const original = (await api.listUploads()).uploads[0];
    api.listUploads.mockResolvedValue({ uploads: [{ ...original, upload_id: "a".repeat(32), filename: "another.csv" }, original] });
    api.listOperations.mockResolvedValue({ native: { operations: [{ operation_id: "extraction", operation: "extract_shadow_strategy", status: "completed", references: { shadow_id: "shadow_2bb71d74", upload_id: UPLOAD_ID } }] } });
    render(<StockVibeOperations enabled />); const dialog = await advanced(user);
    await user.click(within(dialog).getByRole("button", { name: "实验成交文件" })); await user.click(await screen.findByRole("menuitem", { name: "another.csv" })); await screen.findByText(/规则来自 old-trades.csv/);
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "实验样本数（1–5）" }), { target: { value: "6" } }); expect(within(dialog).getByRole("button", { name: "运行历史模拟" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "实验样本数（1–5）" }), { target: { value: "1" } }); await user.click(within(dialog).getByRole("button", { name: "运行历史模拟" }));
    expect(api.startOperation.mock.calls[0][1]).toEqual(expect.objectContaining({ operation: "run_shadow_backtest", upload_id: UPLOAD_ID, per_market_count: 1, markets: ["china_a"] }));
  });
  it("leaves scan match limits independent from backtest samples", async () => {
    const user = userEvent.setup(); render(<StockVibeOperations enabled />); const dialog = await advanced(user);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "扫描条件信号" })).toBeEnabled());
    fireEvent.change(within(dialog).getByRole("spinbutton", { name: "实验样本数（1–5）" }), { target: { value: "1" } }); await user.click(within(dialog).getByRole("button", { name: "扫描条件信号" }));
    expect(api.startOperation.mock.calls[0][1]).toEqual({ operation: "scan_shadow_signals", shadow_id: "shadow_2bb71d74", source: "auto" });
  });
  it("opens exact saved parameters and reports that simulation despite changed form settings", async () => {
    const user = userEvent.setup(); const operation = { operation_id: "backtest_old", operation: "run_shadow_backtest", status: "completed", created_at: "2026-10-15T02:00:00Z", references: { shadow_id: "shadow_2bb71d74", upload_id: UPLOAD_ID }, payload: { upload_id: UPLOAD_ID, source: "local", markets: ["china_a"], per_market_count: 2, window_start: "2025-06-23", window_end: "2025-07-01" }, tool_result: { combined: { total_return: 0.1 }, window: ["2025-06-23", "2025-07-01"], source: "local" } };
    api.listOperations.mockResolvedValue({ native: { operations: [{ ...operation, tool_result: undefined }] } }); api.getOperation.mockResolvedValue({ native: operation });
    render(<StockVibeOperations enabled />); const dialog = await advanced(user); await user.click(await within(dialog).findByRole("button", { name: /历史模拟.*2026-10-15/ }));
    const report = await screen.findByLabelText("选中的实验结果"); await within(report).findByText("10%");
    fireEvent.change(within(dialog).getByLabelText("实验开始日期（可选）"), { target: { value: "2026-10-01" } }); fireEvent.change(within(dialog).getByRole("spinbutton", { name: "实验样本数（1–5）" }), { target: { value: "5" } });
    expect(within(report).getAllByText(/2025-06-23 至 2025-07-01/).length).toBeGreaterThan(0); await user.click(within(dialog).getByRole("button", { name: "为选中模拟生成报告" }));
    expect(api.startOperation.mock.calls[0][1]).toEqual({ operation: "render_shadow_report", shadow_id: "shadow_2bb71d74", upload_id: UPLOAD_ID, include_today_signals: false, source: "local", markets: ["china_a"], per_market_count: 2, window_start: "2025-06-23", window_end: "2025-07-01" });
  });
});
