import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StockVibeLibraryStrategyDetail } from "@/lib/stock-vibe-strategy-library-api";
const api = vi.hoisted(() => ({ catalog: vi.fn(), detail: vi.fn(), history: vi.fn(), start: vi.fn(), deleteStrategy: vi.fn(), request: vi.fn(), operation: vi.fn(), defaults: vi.fn(), industries: vi.fn(), backtestMounted: vi.fn(), oldResearch: vi.fn(), oldRecords: vi.fn() }));
const builtinAsset = vi.hoisted(() => ({ items: [] as StockVibeLibraryStrategyDetail[] }));
vi.mock("@/lib/stock-vibe-builtin-catalog.generated.json", () => ({ default: builtinAsset }));
vi.mock("@/lib/stock-vibe-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-api")>(), getStockVibeRequest: api.request, getStockVibeOperation: api.operation, listStockVibeSwarmRuns: api.oldResearch }));
vi.mock("@/lib/stock-vibe-strategy-library-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-strategy-library-api")>(), getStockVibeStrategyLibrary: api.catalog, getStockVibeStrategyIndustries: api.industries, getStockVibeLibraryStrategy: api.detail, getStockVibeStrategyHistory: api.history, startStockVibeStrategyScan: api.start, deleteStockVibeLibraryStrategy: api.deleteStrategy }));
vi.mock("@/lib/stock-vibe-backtest-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-backtest-api")>(), getStockVibeBacktestDefaults: api.defaults }));
vi.mock("@/lib/stock-vibe-opportunity-records-api", () => ({ getStockVibeOpportunityRecords: api.oldRecords }));
vi.mock("./StockVibeBacktest", () => ({ StockVibeBacktest: ({ selectedStrategy, initialRunId }: { selectedStrategy?: { strategy_id: string; version: string; name: string; effective_config?: { codes?: string[] }; scope?: { kind: string; industry_code?: string; codes?: string[] }; scope_label?: string }; initialRunId?: string }) => { useEffect(() => { api.backtestMounted(); }, []); return <div aria-label="同策略回测" data-codes={JSON.stringify(selectedStrategy?.effective_config?.codes)} data-scope={JSON.stringify(selectedStrategy?.scope)} data-scope-label={selectedStrategy?.scope_label}>{selectedStrategy?.name} {selectedStrategy?.strategy_id} {selectedStrategy?.version} {initialRunId}</div>; } }));
import { StockVibeOpportunity, type StockVibeOpportunityProps } from "./StockVibeOpportunity";
const VERSION = "a".repeat(64), PENDING = "mona.stock-vibe.strategy-scan-pending.v1", OPERATION = "b".repeat(32);
const builtin: StockVibeLibraryStrategyDetail = { strategy_id: "builtin:multi-factor", version: VERSION, name: "多因子排名", source: "builtin", example: true, market: "china_a", interval: "1D", description: "原生四因子排名，前3只等权。", can_scan: true, can_backtest: true, unavailable_reason: null, parameters: [{ name: "top_n", value: 3, editable: true }], has_evidence: false, rules: [{ label: "选股规则", value: "使用原生四因子计算排名" }], linked_run: null, effective_config: null };
const custom: StockVibeLibraryStrategyDetail = { ...builtin, strategy_id: "sdm:custom1", name: "我的策略", source: "custom", example: false, effective_config: { source: "local" } };
const scan = () => ({ operation_id: OPERATION, operation: "strategy_scan", status: "completed", payload: { strategy_id: builtin.strategy_id, strategy_version: VERSION }, references: { strategy_id: builtin.strategy_id, strategy_version: VERSION }, tool_result: { status: "ok", kind: "strategy_scan", strategy_id: builtin.strategy_id, strategy_version: VERSION, signals: [{ symbol: "600519.SH", signal: 1, target_weight: .333333333, signal_date: "2026-10-20" }], as_of: "2026-10-20", data_as_of: "2026-10-20", effective_at: null, data_sources: ["local"], missing: [], note: "真实保存的策略输出" } });
const receipt = (id: string) => ({ request_id: id, method: "POST", path: "/mona/operations", status: "completed", receipt_sha256: "c".repeat(64), receipt: { status_code: 201, body: { operation_id: OPERATION } } });
const DELETE_OPERATION = "d".repeat(32), DELETE_PENDING = "mona.stock-vibe.strategy-delete-pending.v1";
const deletion = () => ({ operation_id: DELETE_OPERATION, operation: "strategy_delete", status: "completed", references: { strategy_id: custom.strategy_id, strategy_version: VERSION }, tool_result: { status: "ok", kind: "strategy_delete", deleted: true, strategy_id: custom.strategy_id, strategy_version: VERSION, already_deleted: false } });
function props(overrides: Partial<StockVibeOpportunityProps> = {}): StockVibeOpportunityProps { return { mode: "ultrashort", symbols: ["600519.SH", "000001.SZ"], enabled: true, modelAvailable: false, onAdd: vi.fn(), onMarket: vi.fn(), onResearch: vi.fn(), onOpenModel: vi.fn(), onError: vi.fn(), onCreateStrategy: vi.fn(), onModifyStrategy: vi.fn(), onStrategyMarket: vi.fn(), onStrategyResearch: vi.fn(), ...overrides }; }
beforeEach(() => {
  localStorage.clear(); Object.values(api).forEach((mock) => mock.mockReset());
  builtinAsset.items = [builtin];
  api.catalog.mockResolvedValue({ items: [custom], total: 1, limit: 20, offset: 0 }); api.detail.mockImplementation(async (id: string) => id === custom.strategy_id ? custom : builtin);
  api.history.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
  api.defaults.mockResolvedValue({ defaults: { source: "tushare", start_date: "2020-01-01", end_date: "2020-12-31" }, options: { sources: ["tushare", "local"], intervals: ["1D"] }, templates: [] });
  api.industries.mockResolvedValue({ items: [{ code: "BK0475", name: "银行" }, { code: "BK0477", name: "医疗器械" }], source: "eastmoney", as_of: "2026-10-22", fetched_at: "2026-10-22T01:00:00Z" });
  api.request.mockResolvedValue({ status: "unknown" }); api.start.mockImplementation(async (id: string) => receipt(id)); api.operation.mockResolvedValue({ native: scan() });
  api.deleteStrategy.mockImplementation(async (id: string) => ({ ...receipt(id), receipt: { status_code: 201, body: { operation_id: DELETE_OPERATION } } }));
  api.oldResearch.mockResolvedValue({ native: { runs: [] } }); api.oldRecords.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
});
async function selectStrategy(name: string) { fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name}`) })); await waitFor(() => expect(screen.getByRole("heading", { name, exact: true })).toBeInTheDocument()); }
describe("unified strategy library", () => {
  it("displays fixed strategies and rules immediately while all native reads remain unresolved", () => {
    [api.catalog, api.detail, api.history, api.defaults, api.request, api.operation].forEach((mock) => mock.mockImplementation(() => new Promise(() => {})));
    render(<StockVibeOpportunity {...props()} />);
    expect(screen.getByRole("heading", { name: builtin.name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^多因子排名/ })).toBeInTheDocument();
    expect(screen.queryByText("正在读取策略…")).not.toBeInTheDocument(); expect(screen.queryByText("正在读取策略规则…")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "规则", exact: true }), { button: 0, ctrlKey: false });
    expect(screen.getByText("使用原生四因子计算排名")).toBeInTheDocument();
    expect(api.catalog).toHaveBeenCalledWith({ q: "", source: "custom", market: "china_a", offset: 0, limit: 20 });
    [api.detail, api.history, api.defaults, api.request, api.operation].forEach((mock) => expect(mock).not.toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "全部", exact: true })).toHaveAttribute("aria-pressed", "true");
  });
  it("filters builtins immediately without native metadata, defaults or history reads", async () => {
    builtinAsset.items = [builtin, { ...builtin, strategy_id: "builtin:other", name: "低波动", description: "另一套规则" }];
    render(<StockVibeOpportunity {...props()} />); fireEvent.click(screen.getByRole("button", { name: "内置", exact: true })); api.catalog.mockClear();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索策略" }), { target: { value: "低波动" } });
    expect(screen.getByRole("button", { name: /^低波动/ })).toBeInTheDocument(); expect(screen.queryByRole("button", { name: /^多因子排名/ })).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "规则", exact: true }), { button: 0, ctrlKey: false });
    expect(screen.getByText("使用原生四因子计算排名")).toBeInTheDocument();
    await act(async () => {}); [api.catalog, api.detail, api.defaults, api.history].forEach((mock) => expect(mock).not.toHaveBeenCalled());
  });
  it("appends delayed custom strategies while retaining the fixed selection and rules", async () => {
    let finish!: (value: unknown) => void; api.catalog.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<StockVibeOpportunity {...props()} />); expect(screen.getByRole("heading", { name: builtin.name })).toBeInTheDocument();
    await act(async () => { finish({ items: [custom], total: 1, offset: 0, limit: 20 }); });
    expect(screen.getByRole("button", { name: /^我的策略/ })).toBeInTheDocument(); expect(screen.getByRole("heading", { name: builtin.name })).toBeInTheDocument(); expect(screen.getByText("2 套策略")).toBeInTheDocument(); expect(api.detail).not.toHaveBeenCalled();
  });
  it("keeps fixed rules usable when custom reading fails and retries only custom strategies", async () => {
    api.catalog.mockRejectedValueOnce(new Error("unavailable")); const p = props(); render(<StockVibeOpportunity {...p} />);
    const retry = await screen.findByRole("button", { name: "重新读取自定义策略" }); expect(screen.getByRole("heading", { name: builtin.name })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "规则", exact: true }), { button: 0, ctrlKey: false }); expect(screen.getByText("使用原生四因子计算排名")).toBeInTheDocument();
    fireEvent.click(retry); expect(await screen.findByRole("button", { name: /^我的策略/ })).toBeInTheDocument(); expect(api.catalog).toHaveBeenCalledTimes(2); expect(api.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ source: "custom" })); expect(p.onError).not.toHaveBeenCalled();
  });
  it("fills mixed pages without skipping custom strategies at the builtin boundary", async () => {
    builtinAsset.items = Array.from({ length: 15 }, (_, index) => ({ ...builtin, strategy_id: `builtin:fixed${index}`, name: `固定${index}` }));
    const customs = Array.from({ length: 30 }, (_, index) => ({ ...custom, strategy_id: `sdm:page${index}`, name: `自定义${index}` }));
    api.catalog.mockImplementation(async ({ offset }: { offset: number }) => ({ items: customs.slice(offset, offset + 20), total: 30, offset, limit: 20 }));
    api.detail.mockImplementation(async (id: string) => customs.find((item) => item.strategy_id === id));
    render(<StockVibeOpportunity {...props()} />); await screen.findByText("45 套策略");
    const list = screen.getByRole("complementary", { name: "选择策略" }); expect(list.querySelectorAll(".stock-vibe-strategy-row")).toHaveLength(20);
    expect(within(list).getByRole("button", { name: /^自定义4 / })).toBeInTheDocument(); expect(within(list).queryByRole("button", { name: /^自定义5 / })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" })); await screen.findByRole("button", { name: /^自定义5 / });
    expect(api.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 5, source: "custom" })); expect(list.querySelectorAll(".stock-vibe-strategy-row")).toHaveLength(20); expect(within(list).getByRole("button", { name: /^自定义24 / })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" })); await screen.findByRole("button", { name: /^自定义25 / }); expect(api.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })); expect(list.querySelectorAll(".stock-vibe-strategy-row")).toHaveLength(5);
  });
  it("loads defaults only on demand and cancels scan preparation after switching strategies", async () => {
    let finish!: (value: unknown) => void; api.defaults.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<StockVibeOpportunity {...props()} />); expect(api.defaults).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "开始选股" }));
    expect(api.defaults).toHaveBeenCalledOnce(); expect(api.start).not.toHaveBeenCalled(); expect(localStorage.getItem(PENDING)).toBeNull();
    await selectStrategy(custom.name); await act(async () => { finish({ defaults: { source: "tushare" }, options: { sources: ["tushare"], intervals: ["1D"] }, templates: [] }); });
    expect(api.start).not.toHaveBeenCalled(); expect(localStorage.getItem(PENDING)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "开始选股" })); await waitFor(() => expect(api.start).toHaveBeenCalledOnce()); expect(api.start.mock.calls[0][1]).toMatchObject({ strategy_id: custom.strategy_id, strategy_version: VERSION, settings: { source: "local" } });
  });
  it("focuses a newly generated custom strategy after clearing the current search", async () => {
    const p = props(), view = render(<StockVibeOpportunity {...p} />); fireEvent.change(screen.getByRole("textbox", { name: "搜索策略" }), { target: { value: "不存在" } });
    view.rerender(<StockVibeOpportunity {...p} catalogRevision={1} focusStrategyId={custom.strategy_id} />);
    await screen.findByRole("heading", { name: custom.name }); expect(screen.getByRole("textbox", { name: "搜索策略" })).toHaveValue(""); expect(api.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ source: "custom", q: "", offset: 0, market: "all" })); expect(api.start).not.toHaveBeenCalled();
  });
  it("offers AI modification only for custom strategies and keeps its existing callback", async () => {
    const p = props(); render(<StockVibeOpportunity {...p} />); await screen.findByText(builtin.description);
    expect(screen.queryByRole("button", { name: "用 AI 修改" })).not.toBeInTheDocument();
    await selectStrategy(custom.name); fireEvent.click(screen.getByRole("button", { name: "用 AI 修改" }));
    expect(p.onModifyStrategy).toHaveBeenCalledWith(custom);
  });
  it("rereads a failed strategy detail without refreshing the catalogue or dispatching a scan", async () => {
    localStorage.setItem("mona.stock-vibe.selected-strategy.v1", custom.strategy_id);
    api.detail.mockRejectedValueOnce(new Error("read failed"));
    const p = props(); render(<StockVibeOpportunity {...p} />);
    const retry = await screen.findByRole("button", { name: "重新读取策略" });
    expect(p.onError).toHaveBeenCalledWith(expect.stringContaining("重新读取策略")); expect(api.catalog).toHaveBeenCalledOnce();
    fireEvent.click(retry); await screen.findByRole("heading", { name: custom.name });
    expect(api.detail).toHaveBeenCalledTimes(2); expect(api.catalog).toHaveBeenCalledOnce(); expect(api.start).not.toHaveBeenCalled();
  });
  it("uses one strategy library and one use flow for built-in and custom strategies without model gating", async () => {
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description);
    expect(screen.queryByRole("tab", { name: "AI 选股" })).not.toBeInTheDocument(); expect(screen.queryByRole("tab", { name: "策略研发" })).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "开始选股" })).toBeEnabled();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "回测", exact: true }), { button: 0, ctrlKey: false }); expect(await screen.findByLabelText("同策略回测")).toHaveTextContent(builtin.strategy_id);
    await selectStrategy("我的策略"); fireEvent.mouseDown(screen.getByRole("tab", { name: "回测", exact: true }), { button: 0, ctrlKey: false }); expect(await screen.findByLabelText("同策略回测")).toHaveTextContent(custom.strategy_id); expect(api.start).not.toHaveBeenCalled();
  });
  it("defaults to all A shares and starts the selected version with actual source settings, showing only verified output", async () => {
    const p = props(); render(<StockVibeOpportunity {...p} />); await screen.findByText(builtin.description); fireEvent.click(screen.getByRole("button", { name: "开始选股" })); await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.start.mock.calls[0][1]).toMatchObject({ strategy_id: builtin.strategy_id, strategy_version: VERSION, scope: { kind: "all_a" }, settings: { source: "tushare", interval: "1D" }, strategy_parameters: { top_n: 3 } }); expect(api.start.mock.calls[0][1].settings).not.toHaveProperty("end_date"); expect(api.start.mock.calls[0][1].settings).not.toHaveProperty("codes");
    expect(await screen.findByText("33.33%")).toBeInTheDocument(); expect(screen.getByText("2026-10-20", { exact: true })).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "看行情", exact: true }));
    expect(p.onStrategyMarket).toHaveBeenCalledWith("600519.SH", { strategy_id: builtin.strategy_id, strategy_version: VERSION, operation_id: OPERATION }); expect(p.onOpenModel).not.toHaveBeenCalled(); expect(api.history).toHaveBeenCalledWith({ strategy_id: builtin.strategy_id, operation: "strategy_scan", limit: 20 });
  });
  it("retains a custom strategy's own source instead of silently replacing it with a global default", async () => {
    localStorage.setItem("mona.stock-vibe.selected-strategy.v1", custom.strategy_id);
    api.catalog.mockResolvedValue({ items: [custom], total: 1, limit: 20, offset: 0 }); render(<StockVibeOpportunity {...props()} />); await screen.findByText(custom.description); fireEvent.click(screen.getByRole("button", { name: "开始选股" })); await waitFor(() => expect(api.start).toHaveBeenCalledOnce()); expect(api.start.mock.calls[0][1].settings.source).toBe("local");
  });
  it("defaults to real all-A scope even when the saved strategy has old codes and the watchlist is empty", async () => {
    localStorage.setItem("mona.stock-vibe.selected-strategy.v1", custom.strategy_id);
    const saved = { ...custom, effective_config: { source: "local", codes: ["000333.SZ", "601318.SH"] } };
    api.catalog.mockResolvedValue({ items: [saved], total: 1, limit: 20, offset: 0 }); api.detail.mockResolvedValue(saved);
    render(<StockVibeOpportunity {...props({ symbols: [] })} />); await screen.findByText(custom.description);
    expect(screen.getByRole("button", { name: "股票范围" })).toHaveTextContent("全A股");
    expect(screen.queryByText("请先到投资工作台添加自选股票。")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始选股" })); await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.start.mock.calls[0][1].scope).toEqual({ kind: "all_a" }); expect(api.start.mock.calls[0][1].settings).not.toHaveProperty("codes");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "回测", exact: true }), { button: 0, ctrlKey: false });
    expect(await screen.findByLabelText("同策略回测")).toHaveAttribute("data-scope", JSON.stringify({ kind: "all_a" }));
    expect(screen.getByLabelText("同策略回测")).not.toHaveAttribute("data-codes"); expect(api.industries).not.toHaveBeenCalled();
  });
  it("projects a native full configuration to allowed settings without leaking its old stock pool into all-A scope", async () => {
    localStorage.setItem("mona.stock-vibe.selected-strategy.v1", custom.strategy_id);
    const saved = { ...custom, effective_config: { source: "local", codes: ["000333.SZ"], engine: "daily", prompt: "原生配置说明", fundamental_fields: ["roe"] } };
    api.catalog.mockResolvedValue({ items: [saved], total: 1, limit: 20, offset: 0 }); api.detail.mockResolvedValue(saved);
    render(<StockVibeOpportunity {...props({ symbols: [] })} />); await screen.findByText(custom.description);
    fireEvent.click(screen.getByRole("button", { name: "开始选股" })); await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    const settings = api.start.mock.calls[0][1].settings;
    expect(settings).toMatchObject({ source: "local", interval: "1D" }); expect(settings).not.toHaveProperty("codes"); expect(api.start.mock.calls[0][1].scope).toEqual({ kind: "all_a" });
    expect(settings).not.toHaveProperty("engine"); expect(settings).not.toHaveProperty("prompt"); expect(settings).not.toHaveProperty("fundamental_fields");
  });
  it("overrides the saved stock pool only after explicitly choosing the watchlist, for both scan and backtest", async () => {
    localStorage.setItem("mona.stock-vibe.selected-strategy.v1", custom.strategy_id);
    const saved = { ...custom, effective_config: { source: "local", codes: ["000333.SZ", "601318.SH"] } }, p = props();
    api.catalog.mockResolvedValue({ items: [saved], total: 1, limit: 20, offset: 0 }); api.detail.mockResolvedValue(saved);
    render(<StockVibeOpportunity {...p} />); await screen.findByText(custom.description);
    fireEvent.keyDown(screen.getByRole("button", { name: "股票范围" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "我的自选（2只）" }));
    fireEvent.click(screen.getByRole("button", { name: "开始选股" })); await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.start.mock.calls[0][1].scope).toEqual({ kind: "watchlist", codes: p.symbols }); expect(api.start.mock.calls[0][1].settings).not.toHaveProperty("codes");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "回测", exact: true }), { button: 0, ctrlKey: false });
    expect(await screen.findByLabelText("同策略回测")).toHaveAttribute("data-scope", JSON.stringify({ kind: "watchlist", codes: p.symbols }));
  });
  it("updates the scope on the mounted backtest without rebuilding its instance", async () => {
    const p = props(); render(<StockVibeOpportunity {...p} />); await screen.findByText(builtin.description);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "回测", exact: true }), { button: 0, ctrlKey: false });
    expect(await screen.findByLabelText("同策略回测")).toHaveAttribute("data-scope", JSON.stringify({ kind: "all_a" })); expect(api.backtestMounted).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("button", { name: "股票范围" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: "我的自选（2只）" }));
    await waitFor(() => expect(screen.getByLabelText("同策略回测")).toHaveAttribute("data-scope", JSON.stringify({ kind: "watchlist", codes: p.symbols })));
    expect(api.backtestMounted).toHaveBeenCalledOnce(); expect(api.start).not.toHaveBeenCalled();
  });
  it("loads industries on demand, searches names, and shares the exact selected industry with backtesting", async () => {
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description); expect(api.industries).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "股票范围" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: "行业", exact: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "具体行业" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "搜索行业" }), { target: { value: "银行" } });
    fireEvent.keyDown(screen.getByRole("button", { name: "具体行业" }), { key: "ArrowDown" });
    expect(screen.queryByRole("menuitem", { name: "医疗器械" })).not.toBeInTheDocument(); fireEvent.click(await screen.findByRole("menuitem", { name: "银行", exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "开始选股" })); await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.start.mock.calls[0][1].scope).toEqual({ kind: "industry", industry_code: "BK0475" }); expect(api.start.mock.calls[0][1].settings).not.toHaveProperty("codes");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "回测", exact: true }), { button: 0, ctrlKey: false });
    expect(await screen.findByLabelText("同策略回测")).toHaveAttribute("data-scope", JSON.stringify({ kind: "industry", industry_code: "BK0475" }));
    expect(screen.getByLabelText("同策略回测")).toHaveAttribute("data-scope-label", "行业 · 银行");
    expect(screen.getAllByRole("button", { name: "股票范围" })).toHaveLength(1);
  });
  it("retries a failed industry read explicitly and never starts a scan as part of retrying", async () => {
    let finish!: (value: unknown) => void;
    api.industries.mockRejectedValueOnce(new Error("read failed")).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const p = props(); render(<StockVibeOpportunity {...p} />); await screen.findByText(builtin.description);
    fireEvent.keyDown(screen.getByRole("button", { name: "股票范围" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: "行业", exact: true }));
    const retry = await screen.findByRole("button", { name: "重试加载行业" });
    expect(screen.getByRole("button", { name: "开始选股" })).toBeDisabled(); expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(p.onError).toHaveBeenCalledOnce();
    fireEvent.click(retry); expect(await screen.findByRole("button", { name: "正在读取行业…" })).toBeDisabled(); await waitFor(() => expect(api.industries).toHaveBeenCalledTimes(2));
    finish({ items: [{ code: "BK0475", name: "银行" }], source: "eastmoney", as_of: "2026-10-22", fetched_at: "2026-10-22T01:00:00Z" });
    await waitFor(() => expect(screen.getByRole("button", { name: "具体行业" })).toBeEnabled()); expect(screen.queryByRole("button", { name: "重试加载行业" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "具体行业" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: "银行", exact: true }));
    expect(screen.getByRole("button", { name: "开始选股" })).toBeEnabled(); expect(api.start).not.toHaveBeenCalled(); expect(p.onError).toHaveBeenCalledOnce();
  });
  it("clears a previous industry when searching for another and does not submit the stale choice", async () => {
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description);
    fireEvent.keyDown(screen.getByRole("button", { name: "股票范围" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: "行业", exact: true }));
    await waitFor(() => expect(screen.getByRole("button", { name: "具体行业" })).toBeEnabled()); fireEvent.keyDown(screen.getByRole("button", { name: "具体行业" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: "银行", exact: true }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索行业" }), { target: { value: "医疗" } });
    expect(screen.getByText("请选择具体行业。")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "开始选股" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "开始选股" })); expect(api.start).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索行业" }), { target: { value: "没有这种行业" } });
    expect(screen.getByRole("button", { name: "具体行业" })).toHaveTextContent("没有匹配行业"); expect(screen.getByRole("textbox", { name: "搜索行业" })).toBeEnabled(); expect(screen.queryByRole("button", { name: "重试加载行业" })).not.toBeInTheDocument(); expect(api.industries).toHaveBeenCalledOnce();
  });
  it("shows the receipt's actual scope and partial coverage instead of implying the whole request was evaluated", async () => {
    const snapshot = { kind: "all_a", source: "eastmoney", as_of: "2026-10-22", fetched_at: "2026-10-22T01:00:00Z", count: 3, membership_basis: "current_snapshot", snapshot_sha256: "f".repeat(64) };
    api.operation.mockResolvedValue({ native: { ...scan(), tool_result: { ...scan().tool_result, scope: snapshot, coverage: { requested: 3, loaded: 2, evaluated: 2, missing: 1, complete: false } } } });
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description); fireEvent.click(screen.getByRole("button", { name: "开始选股" }));
    expect(await screen.findByText("本次范围：全A股（3只）")).toBeInTheDocument(); expect(screen.getByText("可计算2 / 请求3只。数据不齐，结果仅覆盖2只。")).toBeInTheDocument();
  });
  it("describes old recorded codes as a historical range without relabelling them as the current all-A selection", async () => {
    const oldScan = { ...scan(), payload: { ...scan().payload, settings: { codes: ["600519.SH", "000001.SZ"] } } };
    api.history.mockResolvedValue({ items: [oldScan], total: 1, limit: 20, offset: 0 }); api.operation.mockResolvedValue({ native: oldScan });
    render(<StockVibeOpportunity {...props()} />); expect(api.history).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "历史记录", exact: true })); fireEvent.click(await screen.findByRole("button", { name: "查看", exact: true }));
    expect(await screen.findByText("本次范围：历史记录范围（2只）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "股票范围" })).toHaveTextContent("全A股"); expect(screen.queryByText("本次范围：全A股（2只）")).not.toBeInTheDocument(); expect(api.start).not.toHaveBeenCalled();
  });
  it("recovers an unconfirmed submission using GET only after remount", async () => {
    api.start.mockRejectedValue(new Error("response lost")); const first = render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description); fireEvent.click(screen.getByRole("button", { name: "开始选股" })); await waitFor(() => expect(api.start).toHaveBeenCalledOnce()); const pending = JSON.parse(localStorage.getItem(PENDING)!); first.unmount();
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description); await waitFor(() => expect(api.request).toHaveBeenCalledWith(pending.requestId)); expect(screen.getByRole("button", { name: "正在核对上次提交" })).toBeDisabled(); expect(api.start).toHaveBeenCalledOnce();
  });
  it("does not display another strategy's output when the selected strategy changes during a scan", async () => {
    let resolve!: (value: unknown) => void; api.operation.mockImplementation(() => new Promise((done) => { resolve = done; })); render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description); fireEvent.click(screen.getByRole("button", { name: "开始选股" })); await waitFor(() => expect(api.operation).toHaveBeenCalled()); await selectStrategy("我的策略"); resolve({ native: scan() }); await waitFor(() => expect(screen.queryByText("33.33%")).not.toBeInTheDocument()); expect(screen.getByRole("main", { name: "策略工作区" })).toHaveTextContent("我的策略");
  });
  it("requires a nonempty real watchlist only when the watchlist scope is explicitly selected", async () => {
    const p = props({ symbols: [], onOpenWorkbench: vi.fn() }); render(<StockVibeOpportunity {...p} />); await screen.findByText(builtin.description); fireEvent.keyDown(screen.getByRole("button", { name: "股票范围" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: "我的自选（0只）" }));
    expect(screen.getByText("请先到投资工作台添加自选股票。")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "开始选股" })).toBeDisabled(); fireEvent.click(screen.getByRole("button", { name: "开始选股" }));
    fireEvent.click(screen.getByRole("button", { name: "添加自选股票" })); expect(p.onOpenWorkbench).toHaveBeenCalledOnce(); expect(api.start).not.toHaveBeenCalled();
  });
  it("clears a date validation message when returning to the latest complete data", async () => {
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description);
    fireEvent.keyDown(screen.getByRole("button", { name: "数据截止" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "指定日期" }));
    fireEvent.click(screen.getByRole("button", { name: "开始选股" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请选择数据截止日期");
    fireEvent.keyDown(screen.getByRole("button", { name: "数据截止" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "最近完整交易日" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(api.start).not.toHaveBeenCalled();
  });
  it("keeps unsupported source entries visible with an explanation and opens AI creation from the same library", async () => {
    const unsupported: StockVibeLibraryStrategyDetail = { ...builtin, strategy_id: "builtin:pair-trading", name: "配对均值回归", market: "multi_asset", can_scan: false, can_backtest: false, unavailable_reason: "当前A股操作不支持多空配对。" }; builtinAsset.items = [unsupported]; api.catalog.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
    const p = props(); render(<StockVibeOpportunity {...p} />); fireEvent.keyDown(screen.getByRole("button", { name: "适用市场" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: "全部市场" })); await screen.findByRole("heading", { name: "配对均值回归" }); expect(screen.getByRole("button", { name: "开始选股" })).toBeDisabled(); expect(screen.getByRole("main", { name: "策略工作区" })).toHaveTextContent("当前A股操作不支持多空配对。"); fireEvent.click(screen.getByRole("button", { name: "用 AI 创建策略" })); expect(p.onCreateStrategy).toHaveBeenCalledOnce(); expect(screen.queryByRole("button", { name: "用 AI 修改" })).not.toBeInTheDocument(); expect(p.onModifyStrategy).not.toHaveBeenCalled();
  });
  it("searches the server catalogue and offers every result page without dispatching work", async () => {
    api.catalog.mockResolvedValue({ items: [custom], total: 21, limit: 20, offset: 0 }); render(<StockVibeOpportunity {...props()} />); await screen.findByText("22 套策略"); fireEvent.click(screen.getByRole("button", { name: "下一页" })); await waitFor(() => expect(api.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ source: "custom", offset: 19, limit: 20 })));
    api.catalog.mockClear(); fireEvent.change(screen.getByRole("textbox", { name: "搜索策略" }), { target: { value: "波动" } });
    expect(screen.getByRole("textbox", { name: "搜索策略" })).toHaveValue("波动"); expect(api.catalog).not.toHaveBeenCalled();
    await waitFor(() => expect(api.catalog).toHaveBeenCalledWith(expect.objectContaining({ q: "波动", offset: 0 }))); expect(api.catalog).toHaveBeenCalledOnce(); expect(api.start).not.toHaveBeenCalled();
  });
  it("waits for typing to pause before reading only the latest search without dispatching scans or AI work", async () => {
    const p = props(); render(<StockVibeOpportunity {...p} />); await screen.findByText(builtin.description); api.catalog.mockClear(); vi.useFakeTimers();
    try {
      const search = screen.getByRole("textbox", { name: "搜索策略" });
      fireEvent.change(search, { target: { value: "动" } }); expect(search).toHaveValue("动");
      await act(async () => { await vi.advanceTimersByTimeAsync(200); }); expect(api.catalog).not.toHaveBeenCalled();
      fireEvent.change(search, { target: { value: "动量" } }); expect(search).toHaveValue("动量");
      await act(async () => { await vi.advanceTimersByTimeAsync(200); }); expect(api.catalog).not.toHaveBeenCalled();
      fireEvent.change(search, { target: { value: "动量策略" } }); expect(search).toHaveValue("动量策略");
      await act(async () => { await vi.advanceTimersByTimeAsync(249); }); expect(api.catalog).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(api.catalog).toHaveBeenCalledOnce(); expect(api.catalog).toHaveBeenCalledWith(expect.objectContaining({ q: "动量策略", offset: 0 }));
      expect(api.start).not.toHaveBeenCalled(); expect(p.onCreateStrategy).not.toHaveBeenCalled(); expect(p.onModifyStrategy).not.toHaveBeenCalled(); expect(p.onResearch).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("preserves old read-only archives through the unified history entry", async () => {
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description); fireEvent.click(screen.getByRole("button", { name: "历史记录", exact: true })); const dialog = screen.getByRole("dialog", { name: "策略历史记录" }); fireEvent.click(within(dialog).getByRole("button", { name: "早期选股档案" })); expect(await screen.findByText("没有此前的选股档案。")).toBeInTheDocument(); expect(api.oldRecords).toHaveBeenCalledWith(20, 0); expect(api.start).not.toHaveBeenCalled();
  });
  it("offers deletion only for custom strategies and requires confirmation of the exact name", async () => {
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description);
    expect(screen.queryByRole("button", { name: "删除策略", exact: true })).not.toBeInTheDocument();
    await selectStrategy(custom.name); fireEvent.click(screen.getByRole("button", { name: "删除策略", exact: true }));
    const dialog = await screen.findByRole("alertdialog", { name: "确认删除“我的策略”？" });
    expect(dialog).toHaveTextContent("已有选股和回测记录会保留");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(api.deleteStrategy).not.toHaveBeenCalled(); expect(screen.getByRole("heading", { name: custom.name })).toBeInTheDocument();
  });
  it("waits for confirmed deletion before removing the strategy and returns from an empty final page", async () => {
    let deleted = false, finish!: (value: unknown) => void;
    builtinAsset.items = Array.from({ length: 20 }, (_, index) => index ? { ...builtin, strategy_id: `builtin:test${index}`, name: `内置策略${index}` } : builtin);
    api.catalog.mockImplementation(async ({ offset }: { offset: number }) => ({ items: deleted ? [] : [custom], total: deleted ? 0 : 1, limit: 20, offset }));
    api.operation.mockImplementation(async (id: string) => id === DELETE_OPERATION ? new Promise((resolve) => { finish = resolve; }) : { native: scan() });
    render(<StockVibeOpportunity {...props()} />); await screen.findByText("21 套策略");
    fireEvent.click(screen.getByRole("button", { name: "下一页" })); await screen.findByRole("heading", { name: custom.name });
    fireEvent.click(screen.getByRole("button", { name: "删除策略", exact: true }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除策略", exact: true }));
    await waitFor(() => expect(api.operation).toHaveBeenCalledWith(DELETE_OPERATION));
    expect(api.deleteStrategy.mock.calls[0][1]).toEqual({ strategy_id: custom.strategy_id, strategy_version: VERSION });
    expect(screen.getByRole("heading", { name: custom.name })).toBeInTheDocument();
    deleted = true; finish({ native: deletion() });
    await screen.findByRole("heading", { name: builtin.name });
    expect(screen.queryByRole("button", { name: /^我的策略/ })).not.toBeInTheDocument();
    expect(api.catalog).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })); expect(localStorage.getItem(DELETE_PENDING)).toBeNull();
  });
  it("recovers an unconfirmed deletion with GET only and prevents another mutation while it is unknown", async () => {
    api.deleteStrategy.mockRejectedValue(new Error("response lost"));
    const first = render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description); await selectStrategy(custom.name);
    fireEvent.click(screen.getByRole("button", { name: "删除策略", exact: true })); fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除策略", exact: true }));
    await waitFor(() => expect(api.deleteStrategy).toHaveBeenCalledOnce());
    const saved = JSON.parse(localStorage.getItem(DELETE_PENDING)!); first.unmount();
    render(<StockVibeOpportunity {...props()} />); await screen.findByRole("heading", { name: custom.name });
    await waitFor(() => expect(api.request).toHaveBeenCalledWith(saved.requestId));
    expect(screen.getByRole("button", { name: "删除策略", exact: true })).toBeDisabled(); expect(screen.getByRole("button", { name: "用 AI 修改" })).toBeDisabled(); expect(screen.getByRole("button", { name: "开始选股" })).toBeDisabled(); expect(api.deleteStrategy).toHaveBeenCalledOnce();
  });
  it("does not treat a terminal response with an unverified deletion result as success", async () => {
    api.operation.mockResolvedValue({ native: { ...deletion(), tool_result: { ...deletion().tool_result, strategy_version: "f".repeat(64) } } });
    const p = props(); render(<StockVibeOpportunity {...p} />); await screen.findByText(builtin.description); await selectStrategy(custom.name);
    fireEvent.click(screen.getByRole("button", { name: "删除策略", exact: true })); fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除策略", exact: true }));
    await waitFor(() => expect(p.onError).toHaveBeenCalledWith(expect.stringContaining("删除结果尚未核实")));
    expect(screen.getByRole("heading", { name: custom.name })).toBeInTheDocument(); expect(localStorage.getItem(DELETE_PENDING)).not.toBeNull(); expect(api.deleteStrategy).toHaveBeenCalledOnce();
  });
  it("opens a deleted strategy's retained scan history in read-only mode", async () => {
    const oldScan = { ...scan(), payload: { strategy_id: custom.strategy_id, strategy_version: VERSION }, references: { strategy_id: custom.strategy_id, strategy_version: VERSION, strategy_name: custom.name }, tool_result: { ...scan().tool_result, strategy_id: custom.strategy_id } };
    api.catalog.mockResolvedValue({ items: [builtin], total: 1, limit: 20, offset: 0 });
    api.detail.mockImplementation(async (id: string) => id === custom.strategy_id ? { ...custom, deleted: true, can_scan: false, can_backtest: false } : builtin);
    api.history.mockImplementation(async ({ operation }: { operation?: string }) => ({ items: operation ? [] : [oldScan], total: operation ? 0 : 1, limit: 20, offset: 0 }));
    api.operation.mockResolvedValue({ native: oldScan });
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description); fireEvent.click(screen.getByRole("button", { name: "历史记录", exact: true }));
    fireEvent.keyDown(screen.getByRole("button", { name: "历史策略范围" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: "全部策略" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看", exact: true }));
    await screen.findByRole("heading", { name: custom.name }); expect(await screen.findByText("33.33%")).toBeInTheDocument();
    expect(screen.getByText("这套策略已删除，已有选股和回测记录仍可查看。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始选股" })).toBeDisabled(); expect(screen.getByRole("button", { name: "用 AI 修改" })).toBeDisabled(); expect(screen.queryByRole("button", { name: "删除策略", exact: true })).not.toBeInTheDocument(); expect(api.start).not.toHaveBeenCalled(); expect(api.deleteStrategy).not.toHaveBeenCalled();
  });
  it("keeps the opened deleted-strategy history selected when a pending catalogue refresh completes", async () => {
    let deleted = false, finishRefresh!: (value: unknown) => void;
    const oldScan = { ...scan(), payload: { strategy_id: custom.strategy_id, strategy_version: VERSION }, references: { strategy_id: custom.strategy_id, strategy_version: VERSION, strategy_name: custom.name }, tool_result: { ...scan().tool_result, strategy_id: custom.strategy_id } };
    api.catalog.mockImplementation(async () => deleted ? new Promise((resolve) => { finishRefresh = resolve; }) : { items: [builtin, custom], total: 2, limit: 20, offset: 0 });
    api.detail.mockImplementation(async (id: string) => id === custom.strategy_id ? { ...custom, deleted, can_scan: !deleted, can_backtest: !deleted } : builtin);
    api.history.mockImplementation(async ({ operation }: { operation?: string }) => ({ items: operation ? [] : [oldScan], total: operation ? 0 : 1, limit: 20, offset: 0 }));
    api.operation.mockImplementation(async (id: string) => { if (id === DELETE_OPERATION) { deleted = true; return { native: deletion() }; } return { native: oldScan }; });
    render(<StockVibeOpportunity {...props()} />); await screen.findByText(builtin.description); await selectStrategy(custom.name);
    fireEvent.click(screen.getByRole("button", { name: "删除策略", exact: true })); fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "删除策略", exact: true }));
    await waitFor(() => expect(finishRefresh).toBeTypeOf("function"));
    fireEvent.click(screen.getByRole("button", { name: "历史记录", exact: true })); fireEvent.click(await screen.findByRole("button", { name: "查看", exact: true }));
    await screen.findByText("这套策略已删除，已有选股和回测记录仍可查看。");
    finishRefresh({ items: [builtin], total: 1, limit: 20, offset: 0 });
    await waitFor(() => expect(screen.getByRole("complementary", { name: "选择策略" }).querySelector("[aria-busy]")).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByRole("heading", { name: custom.name })).toBeInTheDocument(); expect(screen.getByText("历史选股结果")).toBeInTheDocument(); expect(api.deleteStrategy).toHaveBeenCalledOnce();
  });
});
