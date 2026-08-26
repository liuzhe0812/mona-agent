import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { StockReportV4Document, StockReportV5Document, StockReportV6Document } from "@/lib/stock-api";
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

function v5Report(expiredShort = false): StockReportV5Document {
  const decision = (direction: "positive" | "neutral" | "negative", action: "conditional_participation" | "wait" | "hold" | "reduce", isExpired: boolean, suffix: string): StockReportV5Document["horizonDecisions"]["shortTerm"] => ({
    direction,
    action,
    thesis: `${suffix}交易计划由确定性模型计算`,
    notHoldingAction: action === "conditional_participation" ? "participate" : "wait",
    holdingAction: action === "hold" ? "hold" : "reduce",
    tradingPlan: {
      referenceBuyLow: 36.8,
      referenceBuyHigh: 37.2,
      pullbackBuyLow: 35.8,
      pullbackBuyHigh: 36.2,
      stopLoss: 35.2,
      firstTakeProfit: 39.8,
      firstReduceFraction: 0.33,
      secondTakeProfit: 41.2,
      secondReduceFraction: 0.33,
      riskRewardFirst: 3.5,
      riskRewardSecond: 5.5,
      currency: "元" as const,
    },
    positionPlan: {
      riskBudgetPct: 1,
      initialPositionPct: 10,
      maxPositionPct: 20,
      stopDistancePct: 4,
    },
    validUntil: "2026-09-01T15:00:00+08:00",
    reviewTrigger: "跌破止损参考后重新评估",
    keyReasons: ["趋势保持完整"],
    keyRisks: ["行业需求变化"],
    evidenceStrength: "strong" as const,
    marketAsOf: "2026-08-21T15:00:00+08:00",
    generatedAt: "2026-08-21T15:05:00+08:00",
    isExpired,
  });
  return {
    schemaVersion: 5,
    resultStatus: "completed",
    reportId: "report-v5",
    runId: "run-v5",
    kind: "deep_research",
    instrument: { instrumentId: "XSHE:000001", symbol: "000001", exchange: "XSHE", name: "平安银行", instrumentType: "equity" },
    summary: "三周期交易计划",
    researchCutoffAt: "2026-08-21T15:00:00+08:00",
    marketAsOf: "2026-08-21T15:00:00+08:00",
    generatedAt: "2026-08-21T15:05:00+08:00",
    isExpired: false,
    hasExpiredHorizon: expiredShort,
    horizonDecisions: {
      shortTerm: decision("positive", "conditional_participation", expiredShort, "短线"),
      mediumTerm: decision("neutral", "wait", false, "中线"),
      longTerm: decision("negative", "reduce", false, "长线"),
    },
  };
}

function v6Report(options: { researchOnly?: boolean; blocked?: boolean; quantCalibrated?: boolean } = {}): StockReportV6Document {
  const researchOnly = options.researchOnly ?? false;
  const blocked = options.blocked ?? false;
  const quantCalibrated = options.quantCalibrated ?? !researchOnly;
  const positivePlan = {
    direction: "positive" as const,
    action: "conditional_participation" as const,
    holdingState: "not_holding" as const,
    currentAction: blocked ? "execution_blocked" as const : "participate" as const,
    planStatus: blocked ? "blocked" as const : "proxy" as const,
    execution: { executionStatus: blocked ? "blocked" : "proxy", executionMode: "research_only" as const },
    buyLow: 36.8,
    buyHigh: 37.2,
    pullbackLow: 35.8,
    pullbackHigh: 36.2,
    stopLoss: 35.2,
    firstTakeProfit: 39.8,
    secondTakeProfit: 41.2,
    initialPositionPct: 10,
    maxPositionPct: 20,
    targetMaxPositionPct: 20,
    additionalPositionPct: 20,
    riskBudgetPct: 1,
    riskProfileConfigured: false,
  };
  const neutralPlan = {
    direction: "neutral" as const,
    action: "wait" as const,
    holdingState: "not_holding" as const,
    currentAction: "wait" as const,
    planStatus: "limited" as const,
    execution: { executionStatus: "limited", executionMode: "research_only" as const },
    confirmationPrice: 38.0,
    invalidationPrice: 35.5,
    exitPrice: 35.5,
    initialPositionPct: 0,
    maxPositionPct: 10,
    targetMaxPositionPct: 10,
    additionalPositionPct: 10,
    riskBudgetPct: 1,
    riskProfileConfigured: false,
  };
  const negativePlan = {
    direction: "negative" as const,
    action: "avoid" as const,
    holdingState: "not_holding" as const,
    currentAction: "avoid" as const,
    planStatus: "proxy" as const,
    execution: { executionStatus: "proxy", executionMode: "research_only" as const },
    reentryConfirmationPrice: 42.0,
    initialPositionPct: 0,
    maxPositionPct: 0,
    targetMaxPositionPct: 0,
    additionalPositionPct: 0,
    riskBudgetPct: 1,
    riskProfileConfigured: false,
  };
  const decision = (direction: "positive" | "neutral" | "negative", action: "conditional_participation" | "wait" | "avoid", plan: Record<string, unknown> | null, suffix: string) => ({
    direction,
    action,
    thesis: `${suffix}结论`,
    keyReasons: ["结构化判断"],
    keyRisks: ["条件变化"],
    researchStatus: "ready" as const,
    tradeStatus: plan && !researchOnly ? "ready" as const : "unavailable" as const,
    materializedPlan: researchOnly ? null : plan,
  });
  return {
    schemaVersion: 6,
    resultStatus: "completed",
    reportId: "report-v6",
    runId: "run-v6",
    kind: "deep_research",
    instrument: { instrumentId: "XSHE:000001", symbol: "000001", exchange: "XSHE", name: "平安银行", instrumentType: "equity" },
    decisionMode: researchOnly ? "research_only" : "reference_plan",
    researchStatus: "ready",
    tradeStatus: researchOnly ? "unavailable" : "ready",
    summary: "V6三周期结论",
    researchCutoffAt: "2026-08-21T15:00:00+08:00",
    marketAsOf: "2026-08-21T15:00:00+08:00",
    generatedAt: "2026-08-21T15:05:00+08:00",
    currentPrice: 37.1,
    horizonDecisions: {
      shortTerm: decision("positive", "conditional_participation", positivePlan, "短线看涨"),
      mediumTerm: decision("neutral", "wait", neutralPlan, "中线中性"),
      longTerm: decision("negative", "avoid", negativePlan, "长线回避"),
    },
    quantPromotion: quantCalibrated ? { status: "calibrated", summary: "量化参考可用" } : { status: "research_only", summary: "量化尚未晋级" },
    valuation: { status: "unavailable", summary: "估值待交叉验证" },
    executionQualification: { status: blocked ? "blocked" : "limited", summary: "执行条件受限" },
  } as StockReportV6Document;
}

function renderRadar(overrides: Partial<ComponentProps<typeof DecisionRadar>> = {}) {
  const props: ComponentProps<typeof DecisionRadar> = {
    instrumentId: "XSHE:000001",
    starting: false,
    runActive: false,
    runFailed: false,
    runSettled: 0,
    report: REPORT,
    decisionEvaluation: null,
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
      source: {
        id: "source-news",
        provider: "test",
        url: "https://example.test/news",
        publishedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        contentHash: "hash-news",
        fields: ["title"],
      },
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
  it("summarizes factor validation without exposing calculation internals", () => {
    const decision = {
      direction: "positive",
      action: "conditional_participation",
      factor_score: 0.7,
      market_percentile: 0.8,
      industry_percentile: 0.6,
      validation_status: "descriptive",
      not_holding_action: "conditional_participation",
      holding_action: "hold",
      factor_contributions: { momentum20: 0.1, operating_cashflow: 0.2, custom_internal_factor: 0.3 },
      materialized_plan: { boundaries: [], invalidation: [], max_risk_pct: null },
      position_plan: { reference_position_pct: null, max_position_pct: null, risk_budget_pct: null },
    };
    renderRadar({ report: null, diagnosisMode: true, diagnosisReport: {
      fundamental_research: { status: "available", business_understandable: true },
      decision_radar: { current_decision: decision, basis_rows: [
        { key: "fundamental", label: "基本面", stance: "neutral", stance_label: "中性", summary: "盈利修复，现金流偏弱" },
        { key: "quant", label: "量化验证", stance: "negative", stance_label: "偏空", summary: "估值偏高，短期动量走弱" },
        { key: "sentiment", label: "情绪与预期", stance: "cautious", stance_label: "谨慎", summary: "暂无反转信号，不提高仓位" },
        { key: "risk", label: "风控纪律", stance: "strict", stance_label: "严格", summary: "回避新增，持仓优先降风险" },
      ] },
      horizon_decisions: { short_term: decision, medium_term: decision, long_term: decision },
    } as never });
    const basis = screen.getByTestId("decision-radar-four-step");
    expect(basis).toHaveTextContent("基本面中性盈利修复，现金流偏弱");
    expect(basis).toHaveTextContent("量化验证偏空估值偏高，短期动量走弱");
    expect(basis).toHaveTextContent("情绪与预期谨慎暂无反转信号，不提高仓位");
    expect(basis).toHaveTextContent("风控纪律严格回避新增，持仓优先降风险");
    expect(basis).not.toHaveTextContent("因子贡献");
    expect(basis).not.toHaveTextContent(/momentum20|operating_cashflow|custom_internal_factor/);
  });

  it("shows one current diagnosis with executable risk boundaries and no horizon tabs", () => {
    const decision = {
      direction: "negative",
      action: "avoid",
      factor_score: null,
      validation_status: "unavailable",
      not_holding_action: "avoid",
      holding_action: "reduce",
      factor_contributions: { trend: -1 },
      materialized_plan: {
        reference_entry: 36.23,
        pullback_entry: 35.42,
        stop_loss: 34.05,
        first_take_profit: 38.64,
        second_take_profit: 40.17,
        value_status: "available",
        boundaries: [],
        invalidation: ["跌破止损价后计划失效"],
        max_risk_pct: 1,
      },
      position_plan: { reference_position_pct: 0, max_position_pct: 0, risk_budget_pct: 1 },
    };
    renderRadar({ report: null, diagnosisMode: true, diagnosisReport: {
      fundamental_research: { status: "available", business_understandable: true },
      fundamental_factors: { short_term: { factors: [
        { name: "factor_5", value: 62.5 },
        { name: "factor_6", value: 897.2 },
        { name: "factor_9", value: 0.66 },
      ] } },
      decision_radar: { current_decision: decision },
      horizon_decisions: { short_term: decision, medium_term: decision, long_term: decision },
    } as never });

    expect(screen.queryByRole("tab", { name: "短线" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "中线" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "长线" })).not.toBeInTheDocument();
    expect(screen.getByTestId("decision-radar-ai-diagnosis")).toHaveTextContent("暂不买入 / 减仓");
    expect(screen.getByTestId("decision-radar-four-step")).toHaveTextContent("基本面中性盈利修复，现金流偏弱");
    expect(screen.getByTestId("decision-radar-four-step")).toHaveTextContent("量化验证偏空短期趋势走弱，暂不新增仓位");
    expect(screen.getByTestId("decision-radar-ai-trading-plan")).toHaveTextContent("当前不建议买入");
    expect(screen.getByTestId("decision-radar-ai-trading-plan")).toHaveTextContent("暂不参与");
    expect(screen.getByTestId("decision-radar-ai-trading-plan")).toHaveTextContent("34.05 元");
    expect(screen.getByTestId("decision-radar-ai-trading-plan")).toHaveTextContent("38.64 元");
    expect(screen.getByTestId("decision-radar-ai-trading-plan")).toHaveTextContent("40.17 元");
  });

  it("keeps the period tabs and complete plan while adding the four-step summary", () => {
    renderRadar({ report: v5Report(true) });

    const panel = screen.getByTestId("decision-radar-cycle-output");
    expect(panel).toHaveTextContent("短线看涨");
    expect(panel).toHaveTextContent("价格达到 37.20 元后，等待回踩 35.80–36.20 元参与");
    expect(panel).toHaveTextContent("四层分析");
    expect(panel).toHaveTextContent("参考买入");
    expect(panel).toHaveTextContent("第一止盈39.80 元 · 减仓 1/3");
    expect(panel).toHaveTextContent("第二止盈41.20 元 · 再减仓 1/3");
    expect(panel).toHaveTextContent("参考仓位");
    expect(panel).toHaveTextContent("计划边界");
    expect(panel).not.toHaveTextContent("示例数据");
    expect(panel).not.toHaveTextContent("36.82 元");
    expect(screen.getByRole("tab", { name: "短线" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "中线" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "长线" })).toBeInTheDocument();
  });

  it("uses compact action buttons while keeping accessible labels", () => {
    const onCancelRun = vi.fn();
    renderRadar({ runActive: true, onCancelRun });
    const button = screen.getByRole("button", { name: "取消投研" });
    expect(button).toHaveClass("h-6", "text-caption");
    expect(button.querySelector("svg")).toHaveClass("h-3.5", "w-3.5");
    fireEvent.click(button);
    expect(onCancelRun).toHaveBeenCalledTimes(1);
  });

  it("keeps market materials out of the radar and uses sentiment only in the four-step summary", () => {
    renderRadar({ report: {
      ...v6Report(),
      marketSentiment: { status: "available", direction: "偏空" },
      publicOpinion: { status: "available", direction: "偏多", coverageAccountCount: 30, asOf: "2026-08-21T14:00:00+08:00" },
    } });
    const panel = screen.getByTestId("decision-radar-four-step");
    expect(panel).toHaveTextContent("市场情绪偏空，对新增仓位不利");
    expect(screen.queryByTestId("decision-radar-market-context")).not.toBeInTheDocument();
    expect(screen.queryByText(/市场舆论风向/)).not.toBeInTheDocument();
    expect(panel).not.toHaveTextContent("文章");
    expect(panel).not.toHaveTextContent("source_ids");
  });

  it("does not expose absent opinion coverage as a radar section", () => {
    renderRadar({ report: { ...v6Report(), publicOpinion: { status: "unavailable" } } });
    expect(screen.queryByTestId("decision-radar-market-context")).not.toBeInTheDocument();
    expect(screen.getByTestId("decision-radar-four-step")).not.toHaveTextContent("数据不足");
  });

  it("does not render or request the removed risk-settings panel", () => {
    renderRadar({ report: v6Report() });

    expect(screen.queryByText("风险设置")).not.toBeInTheDocument();
  });

  it("renders the V6 conclusion, four-step summary and complete plan without internal fields", () => {
    renderRadar({ report: v6Report() });

    const panel = screen.getByTestId("decision-radar-v6-panel");
    expect(panel).toHaveTextContent("短线看涨");
    expect(panel).toHaveTextContent("可以分批买入");
    expect(panel).toHaveTextContent("参考买入36.80–37.20 元");
    expect(panel).toHaveTextContent("第一止盈39.80 元");
    expect(panel).toHaveTextContent("第二止盈41.20 元");
    expect(panel).toHaveTextContent("四层分析");
    expect(panel).toHaveTextContent("量化验证");
    expect(panel).not.toHaveTextContent(/decisionMode|reference_plan|executionStatus|source_ids|Agent|LLM/);
    expect(screen.getByRole("tab", { name: "中线" })).toBeInTheDocument();
  });

  it("uses only structured user-facing fields for the four decision rows", () => {
    const report = {
      ...v6Report({ quantCalibrated: false }),
      researchReady: { status: "ready", reason: "内部研究过程不应显示" },
      valuation: {
        status: "unavailable",
        reason: "估值交叉验证未通过",
        assessment: { view: "高估" },
      },
      quantValidation: {
        validationStatus: "uncalibrated",
        quantSignal: "positive",
        horizons: {
          shortTerm: { signal: "neutral", validationStatus: "uncalibrated" },
          mediumTerm: { signal: "positive", validationStatus: "uncalibrated" },
          longTerm: { signal: "negative", validationStatus: "uncalibrated" },
        },
      },
      quantPromotion: { status: "research_only", reason: "内部校准过程" },
      marketSentiment: { status: "available", direction: "暂不判断" },
    } as unknown as StockReportV6Document;

    renderRadar({ report });
    const basis = screen.getByTestId("decision-radar-four-step");
    expect(basis).toHaveTextContent("估值偏高");
    expect(basis).toHaveTextContent("当前估值相对同行偏高；公司经营与行业结论请查看详情");
    expect(basis).toHaveTextContent("短线量化信号中性");
    expect(basis).toHaveTextContent("历史表现仍在验证，本次仅作参考");
    expect(basis).toHaveTextContent("无明确方向");
    expect(basis).toHaveTextContent("市场情绪没有形成一致方向，不改变当前操作");
    expect(basis).not.toHaveTextContent(/估值交叉验证未通过|尚未校准|晋级|样本外|暂不判断/);

    fireEvent.click(screen.getByRole("tab", { name: "中线" }));
    expect(screen.getByTestId("decision-radar-four-step")).toHaveTextContent("中线量化信号偏多");
    fireEvent.click(screen.getByRole("tab", { name: "长线" }));
    expect(screen.getByTestId("decision-radar-four-step")).toHaveTextContent("长线量化信号偏空");
  });

  it("shows research-only and execution-blocked V6 states without inventing plans", () => {
    renderRadar({ report: v6Report({ researchOnly: true }) });
    expect(screen.getByTestId("decision-radar-v6-panel")).toHaveTextContent("当前不建议新开仓，买入条件尚未形成");
    expect(screen.getByTestId("decision-radar-v6-trading-plan")).toHaveTextContent("参考买入尚未形成");
    expect(screen.getByTestId("decision-radar-v6-trading-plan")).toHaveTextContent("回踩参与尚未形成");
    expect(screen.getByTestId("decision-radar-v6-trading-plan")).toHaveTextContent("止损参考尚未形成");
    expect(screen.getByTestId("decision-radar-v6-trading-plan")).toHaveTextContent("第一止盈尚未形成");
    expect(screen.getByTestId("decision-radar-v6-trading-plan")).toHaveTextContent("第二止盈尚未形成");
    expect(screen.getByTestId("decision-radar-v6-boundary")).toHaveTextContent("有效期待重新投研确定");
    expect(screen.getByTestId("decision-radar-v6-boundary")).toHaveTextContent("计划失效交易条件尚未形成");
    expect(screen.getByTestId("decision-radar-v6-panel")).not.toHaveTextContent(/36\.8|37\.2|40\.0/);

    cleanup();
    renderRadar({ report: v6Report({ blocked: true }) });
    const blocked = screen.getByTestId("decision-radar-v6-panel");
    expect(blocked).toHaveTextContent("当前无法执行");
    expect(blocked).toHaveTextContent("当前无法执行，先不新增仓位");
    expect(blocked).toHaveTextContent("当前无法执行，请先重新评估交易条件");
    expect(blocked).toHaveTextContent("参考买入当前无法执行");
    expect(blocked).not.toHaveTextContent("36.80");
  });

  it("keeps an unmaterialized V6 conclusion actionable without relabeling technical levels", () => {
    const report = v6Report({ researchOnly: true });
    report.horizonDecisions.shortTerm = {
      ...report.horizonDecisions.shortTerm,
      direction: "negative",
      action: "reduce",
    };
    (report as StockReportV6Document & { holdingState?: string }).holdingState = "not_holding";
    renderRadar({ report, technical: { trend: "技术偏弱", support: 29.3, resistance: 40.98 } });

    const panel = screen.getByTestId("decision-radar-v6-panel");
    expect(panel).toHaveTextContent("暂不买入 / 减仓");
    expect(panel).toHaveTextContent("先降低仓位，退出价格待重新投研确定");
    expect(panel).toHaveTextContent("首仓0%");
    expect(panel).toHaveTextContent("最大仓位逐步降低仓位");
    expect(panel).toHaveTextContent("历史验证范围有限，当前按规则提供参考");
    expect(panel).not.toHaveTextContent("29.30 元");
    expect(panel).not.toHaveTextContent("40.98 元");
  });

  it("labels an uncalibrated reference plan honestly while keeping real plan fields visible", () => {
    renderRadar({ report: v6Report({ quantCalibrated: false }) });

    const panel = screen.getByTestId("decision-radar-v6-panel");
    expect(panel).toHaveTextContent("历史验证范围有限，当前按规则提供参考");
    expect(panel).toHaveTextContent("参考买入 36.80–37.20 元");
    expect(panel).not.toHaveTextContent("尚未校准");
    expect(panel).not.toHaveTextContent("数据不足");
  });

  it("uses a complete business sentence when a negative exit boundary is absent", () => {
    const report = v6Report();
    report.horizonDecisions.shortTerm = {
      ...report.horizonDecisions.shortTerm,
      direction: "negative",
      action: "avoid",
      materializedPlan: {
        ...report.horizonDecisions.shortTerm.materializedPlan!,
      holdingState: "not_holding",
      exitPrice: null,
      stopLoss: null,
      },
    };
    renderRadar({ report });

    const panel = screen.getByTestId("decision-radar-v6-panel");
    expect(panel).toHaveTextContent("先降低仓位，退出价格待重新投研确定");
    expect(panel).not.toHaveTextContent("退出，参考 未形成");
  });

  it("keeps the reference-position structure for held and not-held V6 reports", () => {
    const report = v6Report();
    report.horizonDecisions.shortTerm.materializedPlan = {
      ...report.horizonDecisions.shortTerm.materializedPlan!,
      holdingState: "holding",
      currentAction: "hold",
      initialPositionPct: 0,
    };
    renderRadar({ report });
    const held = screen.getByTestId("decision-radar-v6-panel");
    expect(held).toHaveTextContent("继续持有，跌破 35.20 元 减仓或退出");
    expect(held).toHaveTextContent("首仓按现有持仓");
    expect(held).toHaveTextContent("最大仓位20.00%");

    cleanup();
    renderRadar({ report: v6Report() });
    const notParticipating = screen.getByTestId("decision-radar-v6-panel");
    expect(notParticipating).toHaveTextContent("参考买入 36.80–37.20 元");
    expect(notParticipating).not.toHaveTextContent("首仓0.00%");
  });

  it("uses a clear market-data state when V6 has no current price", () => {
    const report = v6Report();
    report.currentPrice = null;
    renderRadar({ report, quote: { price: null, changePct: null, updatedAt: null } });
    expect(screen.getByTestId("decision-radar-v6-panel")).toHaveTextContent("行情待更新");
  });

  it("shows only the empty conclusion and start action without a report", () => {
    renderRadar({ report: null });

    expect(screen.getByText(/尚无投研结论/)).toBeInTheDocument();
    expect(screen.getByTestId("decision-radar-empty-state")).toHaveTextContent("尚未生成");
    expect(screen.getByTestId("decision-radar-empty-state")).toHaveTextContent("当前操作：暂不参与");
    expect(screen.getByTestId("decision-radar-empty-state")).toHaveTextContent("投研完成后生成");
    expect(screen.getByTestId("decision-radar-empty-state")).toHaveTextContent("交易计划");
    expect(screen.getByTestId("decision-radar-empty-state")).toHaveTextContent("参考仓位");
    expect(screen.getByTestId("decision-radar-empty-state")).toHaveTextContent("计划边界");
    expect(screen.getByRole("button", { name: "启动深度投研" })).toBeInTheDocument();
    expect(screen.queryByText("公司最新公告不应显示")).not.toBeInTheDocument();
    expect(screen.queryByText(/已完成.*\/6/)).not.toBeInTheDocument();
    expect(screen.queryByText(/行情变化|未来催化|报告后变化/)).not.toBeInTheDocument();
  });

  it("shows a recoverable state after a failed research run without a V5 report", () => {
    renderRadar({ report: null, runFailed: true });

    expect(screen.getByText("本次投研未生成可用交易计划，请重新投研")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新投研" })).toBeInTheDocument();
    expect(screen.getByTestId("decision-radar-empty-state")).toHaveTextContent("生成失败");
    expect(screen.getByTestId("decision-radar-empty-state")).toHaveTextContent("当前操作：暂不参与");
    expect(screen.getByTestId("decision-radar-empty-state")).toHaveTextContent("交易计划");
    expect(screen.getByTestId("decision-radar-empty-state")).not.toHaveTextContent(/示例|score|Agent|source_ids/);
  });

  it("migrates V4 history without rendering the old decision layout", () => {
    renderRadar({ report: REPORT });

    expect(screen.getByTestId("decision-radar-v4-migration")).toHaveTextContent("该历史报告不含交易计划，请重新投研生成");
    expect(screen.getByTestId("decision-radar-v4-migration")).toHaveTextContent("结论状态");
    expect(screen.getByTestId("decision-radar-v4-migration")).toHaveTextContent("需重新投研");
    expect(screen.getByTestId("decision-radar-v4-migration")).toHaveTextContent("当前操作：暂不参与");
    expect(screen.getByTestId("decision-radar-v4-migration")).toHaveTextContent("交易计划");
    expect(screen.getByTestId("decision-radar-v4-migration")).toHaveTextContent("参考仓位");
    expect(screen.getByTestId("decision-radar-v4-migration")).toHaveTextContent("计划边界");
    expect(screen.getByRole("button", { name: "重新投研" })).toBeInTheDocument();
    expect(screen.queryByTestId("decision-radar-cycle-output")).not.toBeInTheDocument();
    expect(screen.queryByTestId("decision-radar-quant-validation")).not.toBeInTheDocument();
    expect(screen.queryByText(/方向|参与或买入条件|退出\/止损条件|止盈条件/)).not.toBeInTheDocument();
  });

  it("disables cancellation while the request is pending", () => {
    renderRadar({ runActive: true, cancellingRun: true });

    const cancel = screen.getByRole("button", { name: "取消中" });
    expect(cancel).toBeDisabled();
    expect(screen.queryByText(/已完成.*\/6/)).not.toBeInTheDocument();
  });
});
