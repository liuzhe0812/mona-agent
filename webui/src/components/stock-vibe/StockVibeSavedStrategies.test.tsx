import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ strategy: vi.fn() }));
vi.mock("@/lib/stock-vibe-native-research-api", () => ({ getStockVibeNativeStrategy: api.strategy }));
import { StockVibeSavedStrategies, type StockVibeSavedStrategiesProps } from "./StockVibeSavedStrategies";

const saved = { strategy_id: "sdm:art_saved", name: "原保存名·均线方法", description: "短均线上穿长均线时建立持仓。", universe: "沪深300", has_evidence: false };
function detail(id = saved.strategy_id) { return { strategy_id: id, description: { signal_definition: "使用复权日线计算5日和20日均线。", entry_rules: ["5日均线上穿20日均线"], exit_rules: ["5日均线下穿20日均线"], position_sizing: "两只股票等权", universe: "沪深300" }, rows: [], linked_run: { run_id: "run-original-1" } }; }
function props(overrides: Partial<StockVibeSavedStrategiesProps> = {}): StockVibeSavedStrategiesProps { return { strategies: [saved], total: 1, offset: 0, onPageChange: vi.fn(), onError: vi.fn(), onReuseStrategy: vi.fn(), onOpenBacktestRun: vi.fn(), ...overrides }; }
beforeEach(() => { api.strategy.mockReset(); api.strategy.mockResolvedValue(detail()); });

describe("saved method records", () => {
  it("shows recorded purpose and scope, and does not turn absent evidence into a failed or missing backtest", async () => {
    const p = props(); render(<StockVibeSavedStrategies {...p} />);
    const list = screen.getByLabelText("我的方法列表");
    expect(list).toHaveTextContent(saved.description); expect(list).toHaveTextContent("适用范围：沪深300");
    expect(list).toHaveTextContent("暂未查到历史评估记录"); expect(list).not.toHaveTextContent("未回测");
    expect(list.querySelector("input, textarea, [contenteditable='true']")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /原保存名·均线方法/ }));
    const modal = await screen.findByRole("dialog", { name: saved.name });
    await within(modal).findByText("使用复权日线计算5日和20日均线。");
    for (const text of ["5日均线上穿20日均线", "5日均线下穿20日均线", "两只股票等权"]) expect(within(modal).getByText(text)).toBeInTheDocument();
    expect(within(modal).getByText(/这不代表从未回测/)).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole("button", { name: "查看已有回测" }));
    expect(p.onOpenBacktestRun).toHaveBeenCalledWith("run-original-1"); expect(api.strategy).toHaveBeenCalledWith("sdm:art_saved");
  });

  it("continues research with the exact saved source instead of treating the record as a ready strategy", async () => {
    const p = props(); render(<StockVibeSavedStrategies {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /原保存名·均线方法/ }));
    fireEvent.click(await screen.findByRole("button", { name: "基于此方法继续研究" }));
    expect(p.onReuseStrategy).toHaveBeenCalledWith("sdm:art_saved");
    expect(screen.queryByRole("button", { name: "立即选股" })).not.toBeInTheDocument();
  });

  it("does not derive rules from the saved name and only offers a backtest when the native link exists", async () => {
    api.strategy.mockResolvedValue({ strategy_id: saved.strategy_id, description: {}, rows: [] });
    render(<StockVibeSavedStrategies {...props({ strategies: [{ ...saved, name: "低波2只3日", description: undefined, universe: undefined }] })} />);
    expect(screen.getByText("未记录选股依据，可打开查看已保存内容。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /低波2只3日/ }));
    const modal = await screen.findByRole("dialog", { name: "低波2只3日" });
    await waitFor(() => expect(within(modal).getAllByText("原记录未保存")).toHaveLength(5));
    expect(within(modal).queryByText("每3天调仓")).not.toBeInTheDocument();
    expect(within(modal).queryByRole("button", { name: "查看已有回测" })).not.toBeInTheDocument();
  });

  it("renders native evidence rows with red gains and green losses without labelling them passed", async () => {
    api.strategy.mockResolvedValue({ ...detail(), rows: [{ regime: "bull_market", return_in_regime: 0.12, benchmark_in_regime: -0.02, excess_in_regime: 0.14, max_drawdown_in_regime: -0.05, decay_status: "aging" }] });
    render(<StockVibeSavedStrategies {...props({ strategies: [{ ...saved, has_evidence: true }] })} />);
    expect(screen.getByLabelText("我的方法列表")).toHaveTextContent("有历史评估记录");
    fireEvent.click(screen.getByRole("button", { name: /原保存名·均线方法/ }));
    expect(await screen.findByText("12%")).toHaveClass("stock-vibe-opportunity-up");
    expect(screen.getByText("-2%")).toHaveClass("stock-vibe-opportunity-down");
    expect(screen.getByText("记录较早")).toBeInTheDocument(); expect(screen.queryByText("验证通过")).not.toBeInTheDocument();
  });

  it("ignores a late response from another record and reports a detail read failure", async () => {
    let resolveFirst: (value: Record<string, unknown>) => void = () => {};
    api.strategy.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockRejectedValueOnce(new Error("read failed"));
    const p = props({ strategies: [saved, { ...saved, strategy_id: "sdm:art_second", name: "第二份方法" }] });
    render(<StockVibeSavedStrategies {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /原保存名·均线方法/ })); await waitFor(() => expect(api.strategy).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "关闭方法详情" }));
    fireEvent.click(screen.getByRole("button", { name: /第二份方法/ }));
    await screen.findByText("这份方法记录暂时无法读取。");
    await act(async () => resolveFirst(detail()));
    const modal = screen.getByRole("dialog", { name: "第二份方法" });
    expect(within(modal).queryByText("使用复权日线计算5日和20日均线。")).not.toBeInTheDocument();
    expect(within(modal).queryByRole("button", { name: "查看已有回测" })).not.toBeInTheDocument();
    expect(p.onError).toHaveBeenCalledOnce();
  });

  it("uses native twenty-item offsets for paging", () => {
    const p = props({ total: 43, offset: 20 }); render(<StockVibeSavedStrategies {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "上一页" })); expect(p.onPageChange).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByRole("button", { name: "下一页" })); expect(p.onPageChange).toHaveBeenLastCalledWith(40);
  });
});
