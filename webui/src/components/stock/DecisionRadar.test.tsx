import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { StockReportV4Document } from "@/lib/stock-api";
import { DecisionRadar } from "./DecisionRadar";

function point(claim: string) {
  return { claim, claim_type: "inference", source_ids: ["source-1"] };
}

function condition(text: string) {
  return { kind: "manual", text, source_ids: ["source-1"] };
}

function horizon(stance: "positive" | "neutral" | "negative" | "insufficient_data", action: string) {
  return {
    stance,
    status: stance === "insufficient_data" ? "insufficient_data" : "available",
    dimension_keys: ["market_environment"],
    thesis: "周期判断",
    drivers: [point("盈利与估值共同影响当前判断")],
    priced_in: "unknown",
    benchmark: { name: "行业指数", relative_view: "inline", source_ids: [] },
    action,
    participation_conditions: [condition("收盘价站上5日均线"), condition("成交量连续两日高于均值"), condition("第三条参与条件不应显示")],
    confirmation_conditions: [condition("下一报告期经营现金流改善")],
    watch_conditions: [condition("观察行业需求变化")],
    invalidation_conditions: [condition("跌破20日支撑位"), condition("盈利趋势转弱"), condition("第三条退出条件不应显示")],
    time_stop: "10个交易日内未出现量价配合，重新评估",
    tradeability_risks: [],
    blind_spots: [],
    evidence_strength: "medium",
    data_status: "complete",
    missing_fields: [],
    source_ids: ["source-1"],
  };
}

const REPORT = {
  schema_version: 4,
  report_id: "report-v4",
  kind: "deep_research",
  workflow_run_id: "run-v4",
  instrument: { symbol: "000001", exchange: "XSHE", name: "平安银行", instrument_type: "equity" },
  as_of: "2026-08-21T15:00:00+08:00",
  research_cutoff_at: new Date().toISOString(),
  market_as_of: new Date().toISOString(),
  summary: "三周期独立结论",
  horizon_views: {
    short_term: horizon("positive", "conditional_participation"),
    medium_term: horizon("neutral", "wait_for_confirmation"),
    long_term: horizon("insufficient_data", "observe"),
  },
  cycle_states: {},
  market_regime_summary: { status: "available", summary: "市场环境稳定", points: [], missing_fields: [], source_ids: [] },
  industry_policy_summary: { status: "available", summary: "行业与政策待跟踪", points: [], missing_fields: [], source_ids: [] },
  scenario_sets: { short_term: {}, medium_term: {}, long_term: {} },
  cross_horizon_conflict: { status: "mixed", explanation: "短线与中长期判断不同", source_ids: [] },
  evidence_coverage: {},
  outcome_tracking_id: "outcome-v4",
  analyst_views: {},
  debate: {},
  risks: [point("宏观信用周期变化")],
  catalysts: [point("盈利改善")],
  open_questions: [point("现金流是否持续改善")],
  source_ids: ["source-1"],
  sources: [],
  versions: {},
  disclaimer: "仅供研究",
} as unknown as StockReportV4Document;

function renderRadar(overrides: Partial<ComponentProps<typeof DecisionRadar>> = {}) {
  const props: ComponentProps<typeof DecisionRadar> = {
    starting: false,
    runActive: false,
    runFailed: false,
    runSettled: 0,
    report: REPORT,
    reportStance: undefined,
    reportDataQuality: null,
    comparison: "旧字段不应展示",
    horizonComparison: {
      current: null,
      previous: null,
      hasCurrentReport: true,
      hasPreviousReport: false,
    },
    technical: { trend: "技术偏强", support: 9.8, resistance: 10.6 },
    quote: { price: 10.38, changePct: 1.07, updatedAt: new Date().toISOString() },
    latestNews: {
      instrumentId: "XSHE:000001",
      instrumentType: "equity",
      title: "公司最新公告不应显示",
      url: "https://example.test/news",
      publishedAt: new Date().toISOString(),
      summary: "不应出现在决策输出",
      source: { provider: "test", fetchedAt: new Date().toISOString() },
    },
    fundamentalsPeriod: "2026Q2",
    sourceCount: 1,
    onStartRun: vi.fn(),
    onCancelRun: vi.fn(),
    cancellingRun: false,
    onNavigate: vi.fn(),
    ...overrides,
  };
  return render(<DecisionRadar {...props} />);
}

describe("DecisionRadar", () => {
  it("shows only the empty conclusion and start action without a report", () => {
    renderRadar({ report: null });

    expect(screen.getByText("尚无投研结论")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动深度投研" })).toBeInTheDocument();
    expect(screen.queryByText("公司最新公告不应显示")).not.toBeInTheDocument();
    expect(screen.queryByText(/已完成.*\/6/)).not.toBeInTheDocument();
    expect(screen.queryByText(/行情变化|未来催化|报告后变化/)).not.toBeInTheDocument();
  });

  it("defaults to the medium-term decision and switches three horizons", () => {
    renderRadar();

    expect(screen.getByRole("tab", { name: "中线" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("decision-radar-cycle-output")).toHaveTextContent("中性");
    expect(screen.getByTestId("decision-radar-cycle-output")).toHaveTextContent("等待确认");

    fireEvent.click(screen.getByRole("tab", { name: "短线" }));
    const output = screen.getByTestId("decision-radar-cycle-output");
    expect(output).toHaveTextContent("看涨");
    expect(output).toHaveTextContent("满足条件再参与");
    expect(output).not.toHaveTextContent("第三条参与条件不应显示");
    expect(output).not.toHaveTextContent("第三条退出条件不应显示");

    fireEvent.click(screen.getByRole("tab", { name: "长线" }));
    expect(screen.getByTestId("decision-radar-cycle-output")).toHaveTextContent("数据不足");
    expect(screen.getByTestId("decision-radar-cycle-output")).toHaveTextContent("继续观察");
  });

  it("keeps decision conditions readable without inventing numeric thresholds", () => {
    renderRadar();
    fireEvent.click(screen.getByRole("tab", { name: "短线" }));
    const output = screen.getByTestId("decision-radar-cycle-output");
    expect(output).toHaveTextContent("收盘价站上5日均线");
    expect(output).toHaveTextContent("成交量连续两日高于均值");
    expect(output).toHaveTextContent("跌破20日支撑位");
    expect(output).toHaveTextContent("盈利趋势转弱");
    expect(output).toHaveTextContent("10个交易日内未出现量价配合");
    expect(output).not.toHaveTextContent("9.8");
    expect(output).not.toHaveTextContent("10.6");
  });

  it("shows one concise expiry reminder and no process or material sections", () => {
    const staleReport = {
      ...REPORT,
      research_cutoff_at: "2020-01-01T09:00:00+08:00",
      market_as_of: "2020-01-01T09:00:00+08:00",
    } as StockReportV4Document;
    renderRadar({ report: staleReport });

    expect(screen.getByTestId("decision-radar-freshness")).toHaveTextContent("报告已超过时效窗口，建议重新投研");
    expect(screen.getAllByTestId("decision-radar-freshness")).toHaveLength(1);
    expect(screen.queryByText(/研究截止|行情截至|公司最新公告不应显示|已完成.*\/6|三周期变化|报告后变化/)).not.toBeInTheDocument();
  });

  it("disables cancellation while the request is pending", () => {
    renderRadar({ runActive: true, cancellingRun: true });

    const cancel = screen.getByRole("button", { name: "取消中" });
    expect(cancel).toBeDisabled();
    expect(screen.queryByText(/已完成.*\/6/)).not.toBeInTheDocument();
  });
});
