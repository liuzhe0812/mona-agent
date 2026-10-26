import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import globalI18n from "i18next";
const api = vi.hoisted(() => ({ alphas: vi.fn(), defaults: vi.fn(), readiness: vi.fn(), alpha: vi.fn(), runs: vi.fn(), run: vi.fn(), bench: vi.fn(), operation: vi.fn(), options: [] as any[] }));
vi.mock("./native/lib/api", async (original) => ({ ...await original<typeof import("./native/lib/api")>(), api: { listAlphas: api.alphas, getAlphaDefaults: api.defaults, getAlphaReadiness: api.readiness, getAlpha: api.alpha, listRuns: api.runs, getRun: api.run, createAlphaBench: api.bench } }));
vi.mock("@/lib/stock-vibe-api", async (original) => ({ ...await original<typeof import("@/lib/stock-vibe-api")>(), getStockVibeOperation: api.operation }));
vi.mock("./native/lib/echarts", () => ({ CHART_GROUP: "native-test", connectCharts: vi.fn(), echarts: { init: () => ({ group: "", setOption: (option: unknown) => api.options.push(option), resize: vi.fn(), dispose: vi.fn() }) } }));
import { StockVibeNativeCompare, StockVibeNativeFactors, StockVibeNativeReports, FactorResearchPanel } from "./StockVibeNativeTools";
import nativeI18n from "./native/i18n";
import type { FactorReportPayload } from "./native/lib/api";
import singleWire from "./native/fixtures/alpha-bench-single-wire.json";
beforeEach(() => {
  sessionStorage.clear(); localStorage.clear(); api.options.length = 0; for (const value of Object.values(api)) if (typeof value === "function") value.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  for (const [name, value] of Object.entries({ "--stock-up": "4 76% 55%", "--stock-down": "150 80% 30%", "--info": "210 75% 45%", "--warning": "40 90% 45%", "--background": "0 0% 100%", "--foreground": "0 0% 10%", "--muted-foreground": "0 0% 40%", "--border": "0 0% 85%", "--brand-ink": "0 0% 10%", "--brand-paper": "60 16% 94%" })) document.documentElement.style.setProperty(name, value);
  api.alphas.mockResolvedValue({ status: "ok", alphas: [{ id: "alpha101_001", zoo: "alpha101", theme: ["momentum"], universe: ["equity_cn"] }], total: 1, returned: 1, truncated: false });
  api.defaults.mockResolvedValue({ bench: { request_schema: { properties: { top: { default: 20, minimum: 1, maximum: 500 }, zoo: {}, universe: {}, period: {} } } }, compare: { request_schema: { properties: { sort: { default: "ir" } } } }, registry: { total: 1, zoo_counts: { alpha101: 1 } } });
  api.readiness.mockResolvedValue({ universes: { csi300: { ready: false, reason: "tushare_token_missing" } }, zoo_counts: { alpha101: 1 } });
  api.alpha.mockResolvedValue({ status: "ok", alpha: { id: "alpha101_001", zoo: "alpha101", meta: { universe: ["equity_cn"], formula_latex: "original_factor_formula" } }, source_code: "def compute(panel):\n    return panel.close" });
  api.runs.mockResolvedValue([{ run_id: "left", status: "success", prompt: "原策略甲", created_at: "2026-10-01", total_return: .10, sharpe: .8 }, { run_id: "right", status: "success", prompt: "原策略乙", created_at: "2026-10-02", total_return: .25, sharpe: 1.2 }]);
  api.run.mockImplementation(async (id: string) => ({ run_id: id, metrics: id === "left" ? { total_return: .10, annual_return: .12 } : { total_return: .25, annual_return: .30 }, equity_curve: id === "left" ? [{ time: "2020-01-01", equity: 1000 }, { time: "2020-01-02", equity: 1100 }] : [{ time: "2020-01-01", equity: 2000 }, { time: "2020-01-02", equity: 2500 }] }));
});
describe("original native front-end migration", () => {
  it("browses and opens the original source in a floating panel while keeping routing, i18n and defaults local", async () => {
    const alphaId = singleWire.request.alpha_id;
    api.alphas.mockResolvedValue({ status: "ok", alphas: [{ id: alphaId, zoo: singleWire.request.zoo, theme: ["momentum"], universe: ["equity_cn"] }], total: 1, returned: 1, truncated: false });
    api.alpha.mockResolvedValue({ status: "ok", alpha: { id: alphaId, zoo: singleWire.request.zoo, meta: { universe: ["equity_cn"], formula_latex: "original_factor_formula" } }, source_code: "def compute(panel):\n    return panel.close" });
    api.bench.mockImplementation(async (request: { request_id: string }) => ({ request_id: request.request_id, method: "POST", path: "/mona/operations", status: "completed", receipt_sha256: "b".repeat(64), receipt: { status_code: 201, body: { operation_id: singleWire.operation_id } } }));
    api.operation.mockResolvedValue({ native: { operation_id: singleWire.operation_id, operation: "alpha_bench", status: "completed", tool_result: singleWire.result } });
    const language = globalI18n.language, url = location.href; render(<StockVibeNativeFactors onError={vi.fn()} />);
    fireEvent.click(await screen.findByRole("link", { name: alphaId })); await screen.findByText("original_factor_formula");
    expect(nativeI18n).not.toBe(globalI18n); expect(globalI18n.language).toBe(language); expect(location.href).toBe(url);
    expect(document.querySelector("details, summary")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看源码（2 行）" })); expect(await screen.findByRole("dialog", { name: "源代码" })).toHaveTextContent("def compute(panel)");
    fireEvent.click(screen.getByRole("button", { name: "关闭信息" })); fireEvent.click(screen.getByRole("button", { name: "评测此因子" }));
    await waitFor(() => expect(screen.getByLabelText("报告保留的因子数")).toHaveValue(20));
    expect(screen.getByLabelText(nativeI18n.t("alphaZoo.period"))).toHaveValue(""); expect(screen.getByLabelText("因子库")).toHaveValue(singleWire.request.zoo);
    expect(screen.getByRole("button", { name: "开始评测" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(nativeI18n.t("alphaZoo.period")), { target: { value: singleWire.request.period } }); fireEvent.click(screen.getByRole("button", { name: "开始评测" }));
    const lowerRanked = (await screen.findByRole("heading", { name: "本次较低排名示例" })).parentElement!.parentElement!;
    expect(within(lowerRanked).getByText(alphaId)).toBeInTheDocument();
    expect(within(lowerRanked).getByText(nativeI18n.t("alphaZoo.alive"))).toBeInTheDocument();
    expect(within(lowerRanked).queryByText(nativeI18n.t("alphaZoo.dead"))).not.toBeInTheDocument();
  });
  it("keeps the original comparison alias and normalization logic with explicit native run identities", async () => {
    render(<StockVibeNativeCompare onError={vi.fn()} initialLeftRunId="left" initialRightRunId="right" />);
    await screen.findByText("+15.00%"); expect(api.run).toHaveBeenCalledWith("left"); expect(api.run).toHaveBeenCalledWith("right");
    const annual = screen.getByText(nativeI18n.t("compare.annualizedReturn")).closest("tr")!;
    expect(within(annual).getByText("12.00%")).toBeInTheDocument(); expect(within(annual).getByText("30.00%")).toBeInTheDocument();
    await waitFor(() => expect(api.options.some((option) => JSON.stringify(option.series?.map((series: any) => series.data)) === JSON.stringify([[100, 110], [100, 125]]))).toBe(true));
  });
  it("renders original factor statistics and correlation data without replacing them with stock selection scores", () => {
    const factor = { name: "momentum_20d", path: "artifacts/factor_momentum_20d", ic_series: [{ date: "2024-01-02", ic: .031 }, { date: "2024-01-03", ic: -.018 }], ic_stats: { ic_mean: .0521, ic_std: .0287, ir: .8734, ic_positive_ratio: .625, ic_count: 128 }, group_equity: [], n_groups: 3, long_short_spread: .021, group_final_equity: {} };
    const report: FactorReportPayload = { exists: true, factors: [factor, { ...factor, name: "value_pe" }], ic_correlation: { labels: ["momentum_20d", "value_pe"], matrix: [[1, .42], [.42, 1]] } };
    render(<FactorResearchPanel report={report} />); expect(screen.getByText("IC 统计")).toBeInTheDocument(); expect(screen.getByText("0.0521")).toBeInTheDocument(); expect(screen.getByText("62.50%")).toBeInTheDocument(); expect(screen.getByText("+2.10%")).toBeInTheDocument();
    expect(api.options.some((option) => option.series?.[0]?.type === "heatmap" && option.series[0].data.some((row: any) => JSON.stringify(row.value) === "[1,0,0.42]"))).toBe(true);
  });
  it("keeps the original report creation-date filter and opens the exact native run through the host callback", async () => {
    const onOpenRun = vi.fn(); render(<StockVibeNativeReports onError={vi.fn()} onOpenRun={onOpenRun} />);
    await screen.findByText("原策略甲"); expect(api.runs).toHaveBeenCalledWith(100);
    expect(screen.getByText(/当前读取的报告（最多 100 条）/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(nativeI18n.t("reports.startDate")), { target: { value: "2026-10-02" } });
    expect(screen.queryByText("原策略甲")).not.toBeInTheDocument();
    const row = screen.getByText("原策略乙").closest("article")!;
    fireEvent.click(within(row).getByRole("link", { name: nativeI18n.t("reports.fullReport") }));
    await waitFor(() => expect(onOpenRun).toHaveBeenCalledWith("right")); expect(onOpenRun).toHaveBeenCalledOnce();
  });
});
