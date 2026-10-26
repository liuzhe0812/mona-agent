import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ defaults: vi.fn(), inputs: vi.fn(), start: vi.fn(), run: vi.fn(), config: vi.fn(), request: vi.fn(), operation: vi.fn(), history: vi.fn(), strategyHistory: vi.fn() }));
vi.mock("@/lib/stock-vibe-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-api")>(), getStockVibeRequest: api.request, getStockVibeOperation: api.operation, listStockVibeOperations: api.history }));
vi.mock("@/lib/stock-vibe-backtest-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-backtest-api")>(), getStockVibeBacktestDefaults: api.defaults, getStockVibeBacktestInputs: api.inputs, startStockVibeBacktest: api.start, getStockVibeBacktestRun: api.run, getStockVibeBacktestConfig: api.config, listStockVibeBacktestStrategyHistory: api.strategyHistory }));
vi.mock("./StockVibeNativeTools", () => ({
  StockVibeNativeReports: ({ onOpenRun }: { onOpenRun: (runId: string) => void }) => <button onClick={() => onOpenRun("output-run")}>查看原生报告目录中的运行</button>,
  StockVibeNativeCompare: ({ initialLeftRunId }: { initialLeftRunId?: string }) => <p>原生报告比较 {initialLeftRunId}</p>,
}));
vi.mock("./native/components/charts/EquityChart", () => ({ EquityChart: ({ data }: { data: Array<{ equity: unknown }> }) => <p>原生资金曲线 {String(data[0]?.equity)}</p> }));
import { StockVibeBacktest } from "./StockVibeBacktest";

const STORAGE = "mona.stock-vibe.native-backtest-pending.v1";
const base = { source: "tushare", codes: ["600519.SH", "000001.SZ"], start_date: "2016-10-20", end_date: "2026-10-20", interval: "1D", initial_cash: 1000000, commission_rate: .0003, commission_min: 5, stamp_tax: .0005, transfer_fee: .00001, slippage: .001, position_adjustment: "hold", rebalance_mask: null, rebalance_tolerance: 0, warmup_bars: null, evaluation_start_date: null, optimizer: null, optimizer_params: {}, validation: null };
function defaults() { return { defaults: base, options: { sources: ["tushare", "tencent", "local"], intervals: ["1D", "1m"], position_adjustment: ["hold", "rebalance"], optimizers: [null, "risk_parity", "turnover_aware"] }, templates: [{ id: "vibe_multifactor_example", name: "Vibe 原生多因子示例", description: "原生示例", parameters: [{ name: "top_n", value: 3, editable: true }, { name: "momentum_window", value: 20, editable: true }] }], optimizer_parameters: { risk_parity: { lookback: 60 }, turnover_aware: { lookback: 60, risk_aversion: 1, turnover_penalty: 0, max_per_name: null, groups: null, max_per_group: null } }, validation_parameters: { monte_carlo: { n_simulations: 1000, seed: 42 }, bootstrap: { n_bootstrap: 1000, confidence: .95, seed: 42 }, walk_forward: { n_windows: 5 } } }; }
function operation(status = "completed") { return { operation_id: "bt-1", operation: "backtest", status, payload: { template_id: "vibe_multifactor_example", settings: base }, references: { run_id: "output-run", input_run_id: "input-run", effective_config: base } }; }
function strategyOperation(strategyId: string, strategyVersion: string, scope?: { kind: string; [key: string]: unknown }) {
  return {
    ...operation(),
    payload: { strategy_id: strategyId, strategy_version: strategyVersion, settings: base, ...(scope ? { scope } : {}) },
    references: { ...operation().references, ...(scope ? { scope: { ...scope, as_of: "2026-10-21", membership_basis: "current_snapshot" } } : {}) },
  };
}
function receipt(id: string) { return { request_id: id, method: "POST", path: "/mona/operations", status: "completed", receipt: { status_code: 201, body: { operation_id: "bt-1" } }, receipt_sha256: "b".repeat(64) }; }
beforeEach(() => {
  localStorage.clear(); Object.values(api).forEach((mock) => mock.mockReset());
  api.defaults.mockResolvedValue(defaults()); api.inputs.mockResolvedValue([]);
  api.config.mockResolvedValue(base);
  api.start.mockImplementation(async (id: string) => receipt(id)); api.request.mockResolvedValue({ status: "unknown" });
  api.operation.mockResolvedValue({ native: operation() }); api.history.mockResolvedValue({ native: { operations: [operation(), { ...operation(), operation: "opportunity_screen", operation_id: "selection" }] } });
  api.strategyHistory.mockResolvedValue({ items: [], total: 0, limit: 20, offset: 0 });
  api.run.mockResolvedValue({ run_id: "output-run", metrics: { total_return: .12, max_drawdown: -.08, annual_return: .1, trade_count: 2, sharpe: .6, win_rate: .5 }, equity_curve: [{ time: "2020-01-01", equity: "100", drawdown: "0" }, { time: "2021-01-01", equity: "112", drawdown: "0" }], artifacts_trades_csv: [{ timestamp: "2020-01-02", code: "600519.SH", side: "buy", qty: "100", price: "100", pnl: "0", reason: "signal" }, { timestamp: "2020-02-02", code: "600519.SH", side: "sell", qty: "100", price: "112", pnl: "1190", reason: "signal" }] });
});
async function settings() { await screen.findByRole("tab", { name: "回测设置" }); }
describe("productized native strategy backtest", () => {
  it("loads actual Vibe defaults including Tushare and leaves optional values unspecified", async () => {
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} />); await settings();
    expect(screen.getByLabelText("开始日期")).toHaveValue("2016-10-20");
    expect(screen.getByLabelText("初始资金")).toHaveValue(1000000);
    expect(screen.getByRole("button", { name: "行情来源" })).toHaveTextContent("Tushare");
    expect(screen.getByLabelText("股票范围")).toHaveValue("600519, 000001");
    expect(screen.getByLabelText("持股数量")).toHaveValue(3);
    fireEvent.click(screen.getByRole("tab", { name: "数据与检验" }));
    expect(screen.getByLabelText("指标预热根数")).toHaveValue(null);
    expect(screen.getByRole("checkbox", { name: "随机模拟检验" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "开始回测" })).toBeEnabled();
  });
  it("submits edited native configuration and real constructor parameters, then opens the output report", async () => {
    const onError = vi.fn(); render(<StockVibeBacktest symbols={[]} onError={onError} />); await settings();
    fireEvent.change(screen.getByLabelText("初始资金"), { target: { value: "500000" } });
    fireEvent.change(screen.getByLabelText("持股数量"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("tab", { name: "费用与仓位" }));
    expect(screen.getByLabelText("佣金比例")).toHaveValue(.0003);
    fireEvent.change(screen.getByLabelText("佣金比例"), { target: { value: "0.0002" } });
    fireEvent.click(screen.getByRole("button", { name: "开始回测" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.start.mock.calls[0][1]).toEqual({ template_id: "vibe_multifactor_example", settings: { ...base, initial_cash: 500000, commission_rate: .0002 }, strategy_parameters: { top_n: 5, momentum_window: 20 } });
    await screen.findByText("12%"); expect(api.run).toHaveBeenCalledWith("output-run");
    expect(await screen.findByText("原生资金曲线 100")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "交易记录" })); expect(await screen.findByRole("button", { name: "卖出" })).toBeInTheDocument(); expect(screen.getByText("2020-02-02")).toBeInTheDocument(); expect(screen.getAllByText("+1190.00").length).toBeGreaterThan(0);
    expect(onError).not.toHaveBeenCalled(); expect(localStorage.getItem(STORAGE)).toBeNull();
  });
  it("does not dispatch invalid dates or invalid strategy parameters", async () => {
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} />); await settings();
    fireEvent.change(screen.getByLabelText("结束日期"), { target: { value: "2010-01-01" } });
    fireEvent.change(screen.getByLabelText("持股数量"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "开始回测" }));
    expect(await screen.findByText("结束日期不能早于开始日期。")).toBeInTheDocument();
    expect(screen.getByText("请输入大于零的整数。")).toBeInTheDocument(); expect(api.start).not.toHaveBeenCalled();
  });
  it("opens an exact linked report and compares it without an unrelated pending job replacing it", async () => {
    localStorage.setItem(STORAGE, JSON.stringify({ requestId: "c".repeat(32), operationId: "bt-1" }));
    api.run.mockImplementation(async (id: string) => ({ run_id: id, metrics: { total_return: .07 } }));
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} initialRunId="linked-native-run" />);
    expect(await screen.findByText("7%")).toBeInTheDocument();
    await waitFor(() => expect(api.operation).toHaveBeenCalledWith("bt-1"));
    expect(api.run).toHaveBeenCalledTimes(1);
    expect(api.run).toHaveBeenCalledWith("linked-native-run");
    expect(api.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "报告比较" }));
    expect(await screen.findByText("原生报告比较 linked-native-run")).toBeInTheDocument();
  });
  it("uses the historical run's stored codes instead of the currently selected scope", async () => {
    const selectedStrategy = { strategy_id: "builtin:multi-factor", version: "a".repeat(64), name: "多因子排名", scope: { kind: "all_a" as const }, scope_label: "全A股" };
    api.run.mockResolvedValue({ run_id: "historical-run", config: { ...base, codes: ["600519.SH", "000001.SZ"] }, metrics: { total_return: .05 } });
    api.config.mockResolvedValue({ ...base, codes: ["600519.SH", "000001.SZ"] });
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} initialRunId="historical-run" selectedStrategy={selectedStrategy} />);
    expect(await screen.findByText("历史记录范围（2只）")).toBeInTheDocument();
    expect(screen.queryByText("本次范围：全A股")).not.toBeInTheDocument();
  });
  it("labels historical scope as unrecorded when the report has no saved codes or scope", async () => {
    api.run.mockResolvedValue({ run_id: "historical-run", metrics: { total_return: .05 } });
    api.config.mockResolvedValue({ ...base, codes: [] });
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} initialRunId="historical-run" />);
    expect(await screen.findByText("历史范围未记录")).toBeInTheDocument();
  });
  it("keeps the most recently selected report when an earlier report request finishes later", async () => {
    const strategyId = "builtin:multi-factor", version = "a".repeat(64);
    const selectedStrategy = { strategy_id: strategyId, version, name: "多因子排名", scope: { kind: "all_a" as const }, scope_label: "全A股" };
    const rowA = { ...strategyOperation(strategyId, version, { kind: "industry", industry_code: "801010", industry_name: "旧行业" }), operation_id: "op-run-a", created_at: "2026-10-20", references: { ...strategyOperation(strategyId, version).references, run_id: "run-a", scope: { kind: "industry", industry_code: "801010", industry_name: "旧行业", as_of: "2026-10-20", membership_basis: "current_snapshot" } } };
    const rowB = { ...strategyOperation(strategyId, version, { kind: "all_a" }), operation_id: "op-run-b", created_at: "2026-10-21", references: { ...strategyOperation(strategyId, version).references, run_id: "run-b", scope: { kind: "all_a", as_of: "2026-10-21", membership_basis: "current_snapshot" } } };
    api.strategyHistory.mockResolvedValue({ items: [rowA, rowB], total: 2, limit: 20, offset: 0 });
    let resolveRunA!: (value: { run_id: string; metrics: { total_return: number } }) => void;
    api.run.mockImplementation((runId: string) => runId === "run-a"
      ? new Promise((resolve) => { resolveRunA = resolve; })
      : Promise.resolve({ run_id: runId, metrics: { total_return: .22 } }));
    const selectedSymbols = [];
    render(<StockVibeBacktest symbols={selectedSymbols} onError={vi.fn()} selectedStrategy={selectedStrategy} initialView="history" />);
    const firstRow = (await screen.findByText(/2026-10-20/)).parentElement!;
    fireEvent.click(within(firstRow).getByRole("button", { name: "查看" }));
    await waitFor(() => expect(api.run).toHaveBeenCalledWith("run-a"));
    fireEvent.click(screen.getByRole("tab", { name: "历史记录" }));
    const secondRow = await screen.findByText(/2026-10-21/);
    fireEvent.click(within(secondRow.parentElement!).getByRole("button", { name: "查看" }));
    await screen.findByText("22%");
    expect(screen.getByText(/本次范围：全A股/)).toBeInTheDocument();
    await act(async () => { resolveRunA({ run_id: "run-a", metrics: { total_return: .11 } }); });
    await waitFor(() => expect(api.run).toHaveBeenCalledWith("run-a"));
    expect(screen.getByText("22%")).toBeInTheDocument();
    expect(screen.queryByText("11%")).not.toBeInTheDocument();
    expect(screen.getByText(/本次范围：全A股/)).toBeInTheDocument();
  });
  it("keeps date and fee drafts when the selected scope changes and submits the latest scope", async () => {
    const strategyId = "builtin:multi-factor", version = "a".repeat(64);
    const first = { strategy_id: strategyId, version, name: "多因子排名", scope: { kind: "all_a" as const }, scope_label: "全A股", effective_config: { ...base, codes: [] } };
    const second = { ...first, scope: { kind: "industry" as const, industry_code: "801010" }, scope_label: "行业 · 电子" };
    api.operation.mockResolvedValue({ native: strategyOperation(strategyId, version, second.scope) });
    const view = render(<StockVibeBacktest symbols={[]} onError={vi.fn()} selectedStrategy={first} />); await settings();
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2020-01-01" } });
    fireEvent.click(screen.getByRole("tab", { name: "费用与仓位" }));
    fireEvent.change(screen.getByLabelText("佣金比例"), { target: { value: "0.0002" } });
    view.rerender(<StockVibeBacktest symbols={[]} onError={vi.fn()} selectedStrategy={second} />);
    expect(screen.getByLabelText("佣金比例")).toHaveValue(.0002);
    fireEvent.click(screen.getByRole("tab", { name: "基本设置" }));
    expect(screen.getByLabelText("开始日期")).toHaveValue("2020-01-01");
    expect(screen.getByText("行业 · 电子")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始回测" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.start.mock.calls[0][1]).toMatchObject({ strategy_id: strategyId, strategy_version: version, scope: second.scope });
    expect(api.start.mock.calls[0][1].settings).toMatchObject({ start_date: "2020-01-01", commission_rate: .0002 });
    expect(api.start.mock.calls[0][1].settings).not.toHaveProperty("codes");
  });
  it("preserves date and fee edits across scope changes and submits the new scope", async () => {
    const selectedStrategy = { strategy_id: "builtin:multi-factor", version: "a".repeat(64), name: "多因子排名", scope: { kind: "all_a" as const }, scope_label: "全A股", effective_config: { ...base, codes: [] } };
    api.operation.mockResolvedValue({ native: strategyOperation(selectedStrategy.strategy_id, selectedStrategy.version, selectedStrategy.scope) });
    const view = render(<StockVibeBacktest symbols={[]} onError={vi.fn()} selectedStrategy={selectedStrategy} />); await settings();
    fireEvent.change(screen.getByLabelText("开始日期"), { target: { value: "2020-01-01" } });
    fireEvent.click(screen.getByRole("tab", { name: "费用与仓位" }));
    fireEvent.change(screen.getByLabelText("佣金比例"), { target: { value: "0.0002" } });
    const industry = { ...selectedStrategy, scope: { kind: "industry" as const, industry_code: "801010" }, scope_label: "行业 · 电子" };
    api.operation.mockResolvedValue({ native: strategyOperation(industry.strategy_id, industry.version, industry.scope) });
    view.rerender(<StockVibeBacktest symbols={[]} onError={vi.fn()} selectedStrategy={industry} />);
    expect(screen.getByLabelText("佣金比例")).toHaveValue(.0002);
    fireEvent.click(screen.getByRole("tab", { name: "基本设置" }));
    expect(screen.getByLabelText("开始日期")).toHaveValue("2020-01-01");
    expect(screen.getByText("行业 · 电子")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始回测" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.start.mock.calls[0][1]).toMatchObject({ strategy_id: industry.strategy_id, strategy_version: industry.version, scope: industry.scope });
    expect(api.start.mock.calls[0][1].settings).toMatchObject({ start_date: "2020-01-01", commission_rate: .0002 });
    expect(api.start.mock.calls[0][1].settings).not.toHaveProperty("codes");
  });
  it("keeps an unknown submission for GET reconciliation and never retries POST on reopen", async () => {
    api.start.mockRejectedValue(new Error("lost response"));
    const first = render(<StockVibeBacktest symbols={[]} onError={vi.fn()} />); await settings();
    fireEvent.click(screen.getByRole("button", { name: "开始回测" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    const saved = JSON.parse(localStorage.getItem(STORAGE)!); expect(saved.requestId).toBe(api.start.mock.calls[0][0]);
    first.unmount(); render(<StockVibeBacktest symbols={[]} onError={vi.fn()} />); await settings();
    await waitFor(() => expect(api.request).toHaveBeenCalledWith(saved.requestId));
    expect(api.start).toHaveBeenCalledOnce(); expect(screen.getByRole("button", { name: /正在核对或执行回测/ })).toBeDisabled();
  });
  it("shows only native strategy backtests in history and reads the saved report with empty browser storage", async () => {
    api.history.mockResolvedValue({ native: { operations: [{ ...operation(), references: { run_id: "output-run", effective_config: { ...base, benchmark: "000300.SH" } } }] } });
    api.run.mockResolvedValue({ run_id: "output-run", metrics: { total_return: .12, max_drawdown: .08, annual_return: .1, benchmark_return: .03, excess_return: .09, trade_count: 2, sharpe: .6, win_rate: .5 }, run_card: { warnings: ["declared benchmark could not be resolved; equal-weight basket used"] } });
    api.config.mockResolvedValue({ ...base, benchmark: "000300.SH" });
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} initialView="history" />);
    fireEvent.click(await screen.findByRole("button", { name: "查看原生报告目录中的运行" }));
    await screen.findByText("12%"); expect(api.run).toHaveBeenCalledWith("output-run"); expect(api.start).not.toHaveBeenCalled();
    expect(screen.getByText("8%").className).not.toMatch(/--stock-up|--stock-down/);
    expect(screen.getByText("50%").className).not.toMatch(/--stock-up|--stock-down/);
    expect(screen.getByText("基准收益")).toBeInTheDocument(); expect(screen.getByText("3%")).toHaveClass("text-[hsl(var(--stock-up))]");
    expect(screen.getByText("超额收益")).toBeInTheDocument(); expect(screen.getByText("9%")).toHaveClass("text-[hsl(var(--stock-up))]");
    expect(screen.getByText("本次使用回测股票的等权篮子对照，未使用所设指数。")).toBeInTheDocument();
    expect(screen.queryByText(/declared benchmark could not/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "实际设置与检验" })); expect(screen.getByText("tushare")).toBeInTheDocument();
  });
  it("edits group rows with inline validation and converts displayed percent to the native mapping payload", async () => {
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} />); await settings();
    fireEvent.click(screen.getByRole("tab", { name: "费用与仓位" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "仓位分配方法" }), { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "考虑换手成本" }));
    expect(screen.getByLabelText("单股权重上限")).toHaveValue(null);
    expect(screen.queryByLabelText("股票分组 第1行 股票代码")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加股票分组" }));
    fireEvent.change(screen.getByLabelText("股票分组 第1行 股票代码"), { target: { value: "bad-code" } });
    fireEvent.change(screen.getByLabelText("股票分组 第1行 分组名称"), { target: { value: "消费" } });
    expect(screen.getByText("股票代码应为六位数字。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("股票分组 第1行 股票代码"), { target: { value: "600519" } });
    fireEvent.click(screen.getByRole("button", { name: "添加股票分组" }));
    fireEvent.change(screen.getByLabelText("股票分组 第2行 股票代码"), { target: { value: "600519" } });
    fireEvent.change(screen.getByLabelText("股票分组 第2行 分组名称"), { target: { value: "消费" } });
    expect(screen.getByText("股票代码重复，请合并为一行。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始回测" })); expect(api.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除股票分组第2行" }));
    fireEvent.click(screen.getByRole("button", { name: "添加分组上限" }));
    fireEvent.change(screen.getByLabelText("分组权重上限 第1行 分组名称"), { target: { value: "消费" } });
    fireEvent.change(screen.getByLabelText("分组权重上限 第1行 最高权重百分比"), { target: { value: "120" } });
    expect(screen.getByText("最高权重应大于 0%，且不超过 100%。")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("分组权重上限 第1行 最高权重百分比"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("tab", { name: "数据与检验" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "重采样检验" }));
    expect(screen.getByLabelText("重采样检验 随机种子")).toHaveValue(42);
    fireEvent.change(screen.getByLabelText("重采样检验 随机种子"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "开始回测" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.start.mock.calls[0][1].settings.optimizer_params).toEqual({ lookback: 60, risk_aversion: 1, turnover_penalty: 0, max_per_name: null, groups: { "600519": "消费" }, max_per_group: { "消费": .3 } });
    expect(api.start.mock.calls[0][1].settings.validation).toEqual({ bootstrap: { n_bootstrap: 1000, confidence: .95, seed: 12 } });
  });
  it("uses existing strategy configuration and does not expose constructor edits for arbitrary code", async () => {
    api.inputs.mockResolvedValue([{ run_id: "saved-strategy", title: "已有低波动策略", config: { ...base, initial_cash: 230000, source: "local" }, strategy_parameters: { top_n: 7 } }]);
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} />); await settings();
    fireEvent.keyDown(screen.getByRole("button", { name: "回测策略" }), { key: "ArrowDown" }); fireEvent.click(await screen.findByRole("menuitem", { name: /已有低波动策略/ }));
    expect(screen.getByLabelText("初始资金")).toHaveValue(230000); expect(screen.getByRole("button", { name: "行情来源" })).toHaveTextContent("本地行情");
    expect(screen.queryByLabelText("持股数量")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始回测" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce()); expect(api.start.mock.calls[0][1]).toEqual({ run_id: "saved-strategy", settings: { ...base, initial_cash: 230000, source: "local" } });
  });
  it("backtests the selected library strategy version without showing a second strategy selector", async () => {
    const selectedSymbols = ["600519", "000001"];
    const selectedStrategy = { strategy_id: "builtin:multi-factor", version: "a".repeat(64), name: "多因子排名", source: "builtin", parameters: [{ name: "top_n", value: 3, editable: true }], effective_config: { ...base, codes: [] } };
    api.operation.mockResolvedValue({ native: strategyOperation(selectedStrategy.strategy_id, selectedStrategy.version) });
    render(<StockVibeBacktest symbols={selectedSymbols} onError={vi.fn()} selectedStrategy={selectedStrategy} />); await settings();
    expect(api.inputs).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("回测策略")).not.toBeInTheDocument();
    expect(screen.getByText("回测策略：多因子排名")).toBeInTheDocument();
    expect(screen.getByLabelText("股票范围")).toHaveValue("600519, 000001");
    fireEvent.change(screen.getByLabelText("股票范围"), { target: { value: "300750" } });
    fireEvent.click(screen.getByRole("button", { name: "恢复原始设置" }));
    expect(screen.getByLabelText("股票范围")).toHaveValue("600519, 000001");
    fireEvent.change(screen.getByLabelText("持股数量"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "开始回测" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    expect(api.start.mock.calls[0][1]).toEqual({ strategy_id: selectedStrategy.strategy_id, strategy_version: selectedStrategy.version, strategy_parameters: { top_n: 5 }, settings: { ...base, codes: selectedSymbols } });
    await screen.findByText("12%"); expect(localStorage.getItem(`${STORAGE}.${encodeURIComponent(selectedStrategy.strategy_id)}.${selectedStrategy.version}`)).toBeNull();
  });
  it.each([
    { scope: { kind: "all_a" as const }, label: "全A股" },
    { scope: { kind: "industry" as const, industry_code: "801010" }, label: "电子行业" },
    { scope: { kind: "watchlist" as const, codes: ["600519.SH", "000001.SZ"] }, label: "自选股" },
  ])("submits $label scope without stale settings.codes", async ({ scope, label }) => {
    const selectedStrategy = { strategy_id: "builtin:multi-factor", version: "a".repeat(64), name: "多因子排名", scope, scope_label: label, effective_config: { ...base, codes: ["000001.SZ"] } };
    api.operation.mockResolvedValue({ native: strategyOperation(selectedStrategy.strategy_id, selectedStrategy.version) });
    render(<StockVibeBacktest symbols={["300750"]} onError={vi.fn()} selectedStrategy={selectedStrategy} />); await settings();
    expect(screen.getByText("股票范围")).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByLabelText("股票范围")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "使用当前名单" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始回测" }));
    await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
    const { codes: _oldCodes, ...expectedSettings } = base;
    expect(api.start.mock.calls[0][1]).toEqual({ strategy_id: selectedStrategy.strategy_id, strategy_version: selectedStrategy.version, scope, strategy_parameters: { top_n: 3, momentum_window: 20 }, settings: expectedSettings });
    expect(api.inputs).not.toHaveBeenCalled();
  });
  it("does not dispatch a scoped backtest when the selected watchlist is empty", async () => {
    const selectedStrategy = { strategy_id: "builtin:multi-factor", version: "a".repeat(64), name: "多因子排名", can_backtest: false, unavailable_reason: "请先到投资工作台添加自选股票。", scope: { kind: "watchlist" as const, codes: [] }, scope_label: "自选股（0只）" };
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} selectedStrategy={selectedStrategy} />); await settings();
    expect(screen.queryByText("请先到投资工作台添加自选股票。")).not.toBeInTheDocument();
    expect(screen.queryByText("请先选择有效的股票范围。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始回测" })).toBeDisabled();
    expect(api.start).not.toHaveBeenCalled();
  });
  it("keeps an unknown pending request when its operation belongs to a different strategy version", async () => {
    const selectedStrategy = { strategy_id: "builtin:multi-factor", version: "a".repeat(64), name: "多因子排名" };
    const pendingKey = `${STORAGE}.${encodeURIComponent(selectedStrategy.strategy_id)}.${selectedStrategy.version}`;
    localStorage.setItem(pendingKey, JSON.stringify({ requestId: "f".repeat(32), operationId: "bt-1" }));
    api.operation.mockResolvedValue({ native: strategyOperation(selectedStrategy.strategy_id, "b".repeat(64)) });
    const onError = vi.fn();
    render(<StockVibeBacktest symbols={[]} onError={onError} selectedStrategy={selectedStrategy} />); await settings();
    await waitFor(() => expect(onError).toHaveBeenCalledWith("暂时无法读取回测状态，原请求已保留，系统会继续核对。"));
    expect(localStorage.getItem(pendingKey)).toContain("bt-1");
    expect(screen.queryByText("12%")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /正在核对或执行回测/ })).toBeDisabled();
  });
  it("does not reuse an unknown request from a different strategy context", async () => {
    const first = { strategy_id: "builtin:multi-factor", version: "a".repeat(64), name: "多因子排名" };
    const second = { strategy_id: "builtin:technical-basic", version: "b".repeat(64), name: "技术指标综合" };
    localStorage.setItem(`${STORAGE}.${encodeURIComponent(first.strategy_id)}.${first.version}`, JSON.stringify({ requestId: "e".repeat(32) }));
    const view = render(<StockVibeBacktest symbols={[]} onError={vi.fn()} selectedStrategy={first} />); await settings();
    expect(screen.getByRole("button", { name: /正在核对或执行回测/ })).toBeDisabled();
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    const firstContextReads = api.request.mock.calls.length;
    view.rerender(<StockVibeBacktest symbols={[]} onError={vi.fn()} selectedStrategy={second} />); await settings();
    expect(screen.getByRole("button", { name: "开始回测" })).toBeEnabled();
    expect(api.request).toHaveBeenCalledWith("e".repeat(32));
    expect(api.request).toHaveBeenCalledTimes(firstContextReads);
    expect(api.start).not.toHaveBeenCalled();
  });
  it("shows history for the selected strategy with paging", async () => {
    const selectedStrategy = { strategy_id: "builtin:multi-factor", version: "a".repeat(64), name: "多因子排名" };
    api.strategyHistory.mockResolvedValue({ items: [strategyOperation(selectedStrategy.strategy_id, selectedStrategy.version)], total: 21, limit: 20, offset: 0 });
    render(<StockVibeBacktest symbols={[]} onError={vi.fn()} selectedStrategy={selectedStrategy} initialView="history" />);
    expect(await screen.findByRole("heading", { name: "多因子排名 · 回测记录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(api.strategyHistory).toHaveBeenLastCalledWith(selectedStrategy.strategy_id, 20, 20));
    expect(screen.queryByRole("button", { name: "查看原生报告目录中的运行" })).not.toBeInTheDocument();
  });
  it("rejects history rows returned for another strategy", async () => {
    const selectedStrategy = { strategy_id: "builtin:multi-factor", version: "a".repeat(64), name: "多因子排名" };
    api.strategyHistory.mockResolvedValue({ items: [strategyOperation("builtin:technical-basic", selectedStrategy.version)], total: 1, limit: 20, offset: 0 });
    const onError = vi.fn();
    render(<StockVibeBacktest symbols={[]} onError={onError} selectedStrategy={selectedStrategy} initialView="history" />);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("回测记录读取失败，请重新打开历史记录。"));
    expect(screen.queryByRole("button", { name: "查看" })).not.toBeInTheDocument();
  });
});
