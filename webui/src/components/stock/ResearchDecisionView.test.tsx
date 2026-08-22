import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StockReportV4Document } from "@/lib/stock-api";
import { evidenceTextLabel, thesisLabel } from "./labels";
import { ResearchDecisionView } from "./ResearchDecisionView";

const fetchStockOutcomes = vi.fn(() => new Promise<never>(() => undefined));
const refreshStockOutcomes = vi.fn();

vi.mock("@/lib/stock-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stock-api")>();
  return {
    ...actual,
    fetchStockOutcomes: (...args: unknown[]) => fetchStockOutcomes(...args),
    refreshStockOutcomes: (...args: unknown[]) => refreshStockOutcomes(...args),
  };
});

const point = (claim: string) => ({ claim, claim_type: "inference" as const, source_ids: ["source-1"] });
const condition = (text: string, kind: "manual" | "trigger" = "manual") => ({ kind, text, source_ids: ["source-1"] });
const dimension = (summary: string) => ({
  status: "available" as const,
  summary,
  points: [point(`${summary}事实`)],
  missing_fields: [],
  source_ids: ["source-1"],
});

function makeHorizon(stance: "positive" | "negative" | "insufficient_data", status: "available" | "insufficient_data") {
  return {
    stance,
    status,
    dimension_keys: ["market_environment", "industry", "policy"],
    thesis: `${stance} 命题`,
    drivers: [point("驱动因素")],
    priced_in: "partially_priced_in" as const,
    priced_in_basis: point("市场已部分计价依据", "inference"),
    benchmark: { name: "沪深 300", instrument_id: "000300.XSHG", relative_view: "outperform" as const, basis: "相对行业盈利与估值", source_ids: ["source-1"] },
    action: "conditional_participation" as const,
    participation_conditions: [condition("参与条件")],
    confirmation_conditions: [condition("确认条件", "trigger")],
    watch_conditions: [condition("观察条件")],
    invalidation_conditions: [condition("失效条件")],
    time_stop: "10 个交易日",
    tradeability_risks: [point("流动性风险")],
    blind_spots: [point("数据盲点")],
    evidence_strength: "medium" as const,
    data_status: "degraded" as const,
    missing_fields: status === "insufficient_data" ? ["政策文本"] : [],
    source_ids: ["source-1"],
  };
}

const REPORT: StockReportV4Document = {
  schema_version: 4,
  report_id: "report-4",
  kind: "deep_research",
  workflow_run_id: "run-4",
  instrument: { symbol: "002709", exchange: "XSHE", name: "天赐材料" },
  as_of: "2026-08-19T15:00:00+08:00",
  research_cutoff_at: "2026-08-19T14:00:00+08:00",
  market_as_of: "2026-08-19T14:00:00+08:00",
  summary: "不生成总观点",
  dimension_views: {
    market_environment: dimension("市场环境"),
    industry: dimension("行业信息"),
    policy: dimension("政策信息"),
    cycle: dimension("周期判断"),
    company_quality: dimension("公司质量"),
    valuation: dimension("估值"),
    capital_positioning: dimension("资金与筹码"),
    event_risk: dimension("事件与风险"),
  },
  horizon_views: {
    short_term: makeHorizon("insufficient_data", "insufficient_data"),
    medium_term: makeHorizon("positive", "available"),
    long_term: makeHorizon("negative", "available"),
  },
  cycle_states: Object.fromEntries(["policy", "industry", "earnings", "valuation"].map((key) => [key, {
    status: "degraded",
    stage: "观察期",
    leading_indicators: [],
    confirmation_indicators: [],
    turning_conditions: [],
    observation_window: "本季度",
    evidence_strength: "low",
    missing_fields: [],
    source_ids: [],
  }])) as unknown as StockReportV4Document["cycle_states"],
  market_regime_summary: { status: "degraded", summary: "震荡市", points: [], missing_fields: [], source_ids: [] },
  industry_policy_summary: { status: "missing", summary: "未提供", points: [], missing_fields: ["行业政策"], source_ids: [] },
  scenario_sets: {
    short_term: { optimistic: { summary: "短线乐观", conditions: [], outcome_direction: "上行", risks: [], source_ids: [] }, base: { summary: "短线基准", conditions: [], outcome_direction: "震荡", risks: [], source_ids: [] }, pessimistic: { summary: "短线悲观", conditions: [], outcome_direction: "下行", risks: [], source_ids: [] } },
    medium_term: { optimistic: { summary: "中线乐观", conditions: [], outcome_direction: "上行", risks: [], source_ids: [] }, base: { summary: "中线基准", conditions: [], outcome_direction: "震荡", risks: [], source_ids: [] }, pessimistic: { summary: "中线悲观", conditions: [], outcome_direction: "下行", risks: [], source_ids: [] } },
    long_term: { optimistic: { summary: "长线乐观", conditions: [], outcome_direction: "上行", risks: [], source_ids: [] }, base: { summary: "长线基准", conditions: [], outcome_direction: "震荡", risks: [], source_ids: [] }, pessimistic: { summary: "长线悲观", conditions: [], outcome_direction: "下行", risks: [], source_ids: [] } },
  },
  cross_horizon_conflict: { status: "mixed", explanation: "周期观点相反", source_ids: [] },
  evidence_coverage: { short_term: { status: "insufficient_data" }, medium_term: { status: "degraded" }, long_term: { status: "degraded" } },
  outcome_tracking_id: "outcome-4",
  analyst_views: {},
  debate: {},
  debate_resolution: Object.fromEntries(["short_term", "medium_term", "long_term"].map((key) => [key, {
    status: "available",
    issue: `${key} 多空争议问题`,
    bull_case: [point(`${key} 多方依据`)],
    bear_case: [point(`${key} 空方依据`)],
    verdict: [point(`${key} 主席裁决`)],
    change_conditions: [condition(`${key} 改变判断条件`)],
    missing_fields: [],
    source_ids: ["source-1"],
  }])) as unknown as StockReportV4Document["debate_resolution"],
  risks: [],
  catalysts: [],
  open_questions: [],
  source_ids: ["source-1"],
  sources: [],
  versions: {},
  disclaimer: "仅供研究",
};

const withDimensionProjections = (
  marketBreadth: Record<string, unknown>,
  publicActivity: Record<string, unknown>,
) => ({
  ...REPORT,
  dimension_views: {
    ...REPORT.dimension_views,
    market_environment: {
      ...REPORT.dimension_views?.market_environment,
      market_breadth: marketBreadth,
    },
    capital_positioning: {
      ...REPORT.dimension_views?.capital_positioning,
      public_activity: publicActivity,
    },
  },
}) as unknown as StockReportV4Document;

describe("ResearchDecisionView", () => {
  it("renders the selection origin as Chinese clues separate from deep-research conclusions", () => {
    const report = {
      ...REPORT,
      selection_origin: {
        schema_version: 1 as const,
        selection_run_id: "run_selection",
        selection_report_id: "selection_report",
        opportunity_report_id: "opportunity_report",
        instrument_id: "XSHG:002709",
        strategy_id: "quality_growth",
        strategy_name: "业绩成长",
        strategy_horizon: "medium_term",
        deterministic_rank: 2,
        selection_reasons: ["operating_cashflow 改善"],
        why_now: "momentum20 与 industry_context 需要核验",
        research_priority: "high" as const,
        focus_questions: ["policy_context 尚未确认"],
        source_count: 3,
        selection_as_of: "2026-08-19T15:00:00+08:00",
        usage_note: "这是选股阶段的先验线索，不是深度投研事实；必须使用本次投研证据重新核验。" as const,
      },
    };
    render(<ResearchDecisionView report={report} />);

    const card = screen.getByTestId("selection-origin-report");
    expect(card).toHaveTextContent("选股线索");
    expect(card).toHaveTextContent("中线（2 周—6 个月）");
    expect(card).toHaveTextContent("经营活动现金流 改善");
    expect(card).toHaveTextContent("20日价格动量 与 行业信息 需要核验");
    expect(card).toHaveTextContent("政策信息 尚未确认");
    expect(card.textContent).not.toMatch(/operating_cashflow|momentum20|industry_context|policy_context|selection_run_id|selection_report_id|opportunity_report|run_selection|high|medium|low/);
  });

  it("keeps the report compatible when selection origin is absent", () => {
    render(<ResearchDecisionView report={REPORT} />);
    expect(screen.queryByTestId("selection-origin-report")).not.toBeInTheDocument();
  });

  it("maps inline status tokens only when followed by a colon", () => {
    expect(thesisLabel("中线证据覆盖degraded: 盈利数据缺失")).toBe("中线证据覆盖部分缺失： 盈利数据缺失");
    expect(thesisLabel("短线insufficient_data：市场证据不足")).toBe("短线数据不足：市场证据不足");
    expect(thesisLabel("ordinary degraded prose")).toBe("ordinary degraded prose");
    expect(evidenceTextLabel("short_term / medium_term / long_term")).toBe("短线 / 中线 / 长线");
    expect(evidenceTextLabel("short_termish medium_term_value long_termly")).toBe("short_termish medium_term_value long_termly");
  });

  it("renders independent horizons, defaults to medium, and switches scenarios", () => {
    render(<ResearchDecisionView report={REPORT} />);

    expect(screen.getByTestId("research-decision-view")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "投研结论" })).toBeInTheDocument();
    expect(screen.getByTestId("horizon-card-short_term")).toHaveTextContent("数据不足");
    expect(screen.getByTestId("horizon-card-medium_term")).toHaveTextContent("看涨");
    expect(screen.getByTestId("horizon-card-long_term")).toHaveTextContent("看跌");
    expect(screen.getByTestId("horizon-card-medium_term").querySelector("button[aria-controls='research-horizon-medium_term-body']")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("scenario-panel")).toHaveTextContent("中线基准");
    expect(screen.getByTestId("horizon-dimensions-medium_term")).toHaveTextContent("本周期依据：市场环境、行业信息、政策信息");
    expect(screen.getByTestId("horizon-card-medium_term")).toHaveTextContent("沪深 300（000300.XSHG）");
    expect(screen.getByTestId("horizon-card-medium_term")).toHaveTextContent("比较依据：相对行业盈利与估值");
    expect(screen.getByTestId("horizon-card-medium_term")).toHaveTextContent("计价依据：推断市场已部分计价依据");
    expect(screen.getByTestId("research-dimension-overview")).toHaveTextContent("公司质量");
    expect(screen.getByTestId("research-dimension-overview")).toHaveTextContent("事件与风险");
    expect(screen.queryByText("市场状态")).not.toBeInTheDocument();
    expect(screen.queryByText("行业与政策")).not.toBeInTheDocument();
    expect(screen.getByTestId("research-cross-horizon-conflict")).toHaveTextContent("周期观点相反");
    expect(screen.getByTestId("research-debate-summary")).toHaveTextContent("短线 多空争议问题");
    expect(screen.getByTestId("research-decision-debate-short_term")).toHaveTextContent("最终研判");
    expect(screen.getByTestId("research-decision-debate-medium_term")).toHaveTextContent("中线 多方依据");
    expect(screen.getByText("查看完整分析报告")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "乐观" }));
    expect(screen.getByTestId("scenario-panel")).toHaveTextContent("中线乐观");
  });

  it("shows trade decisions first, caps conditions, and keeps the full report closed", () => {
    const report = {
      ...REPORT,
      horizon_views: {
        ...REPORT.horizon_views,
        medium_term: {
          ...REPORT.horizon_views.medium_term,
          action: "reduce_exposure" as const,
          participation_conditions: [condition("参与条件一"), condition("参与条件二"), condition("参与条件三"), condition("参与条件四")],
          confirmation_conditions: [],
          invalidation_conditions: [condition("退出条件一"), condition("退出条件二"), condition("退出条件三"), condition("退出条件四")],
        },
        long_term: {
          ...REPORT.horizon_views.long_term,
          action: "observe" as const,
        },
      },
    } as StockReportV4Document;
    render(<ResearchDecisionView report={report} />);

    const fullReport = screen.getByTestId("research-full-analysis");
    expect(fullReport).not.toHaveAttribute("open");
    expect(screen.getByTestId("horizon-summary-short_term")).toHaveTextContent("当前操作：满足条件再参与");
    expect(screen.getByTestId("horizon-summary-medium_term")).toHaveTextContent("当前操作：减仓或回避");
    expect(screen.getByTestId("horizon-summary-medium_term")).toHaveTextContent("核心命题：看涨 命题");
    expect(screen.getByTestId("horizon-summary-long_term")).toHaveTextContent("当前操作：继续观察");
    expect(screen.getByTestId("horizon-card-medium_term").querySelector("button")).not.toHaveTextContent("可用");

    const medium = screen.getByTestId("horizon-card-medium_term");
    const ordered = [
      screen.getByTestId("horizon-action-medium_term"),
      screen.getByTestId("horizon-participation-medium_term"),
      screen.getByTestId("horizon-exit-medium_term"),
      screen.getByTestId("horizon-time-boundary-medium_term"),
      screen.getByTestId("horizon-risks-medium_term"),
      screen.getByTestId("horizon-basis-medium_term"),
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index - 1].compareDocumentPosition(ordered[index]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(screen.getByTestId("horizon-participation-medium_term")).getAllByRole("listitem")).toHaveLength(3);
    expect(within(screen.getByTestId("horizon-exit-medium_term")).getAllByRole("listitem")).toHaveLength(3);
  });

  it("puts user decisions before supporting context and uses separators instead of nested cards", () => {
    render(<ResearchDecisionView report={{ ...REPORT, selection_origin: {
      schema_version: 1,
      selection_run_id: "selection-run",
      selection_report_id: "selection-report",
      opportunity_report_id: null,
      instrument_id: "XSHE:002709",
      strategy_id: "quality_growth",
      strategy_name: "业绩成长",
      strategy_horizon: "medium_term",
      deterministic_rank: 1,
      selection_reasons: [],
      why_now: null,
      research_priority: null,
      focus_questions: [],
      source_count: 0,
      selection_as_of: null,
      usage_note: "这是选股阶段的先验线索，不是深度投研事实；必须使用本次投研证据重新核验。",
    } }} />);

    const view = screen.getByTestId("research-decision-view");
    const conclusions = screen.getByTestId("research-horizon-conclusions");
    const selectionOrigin = screen.getByTestId("selection-origin-report");
    const dimensions = screen.getByTestId("research-dimension-overview");
    expect(conclusions.compareDocumentPosition(selectionOrigin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(selectionOrigin.compareDocumentPosition(dimensions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("horizon-card-medium_term")).toHaveClass("border-b");
    expect(screen.getByTestId("horizon-card-medium_term")).not.toHaveClass("rounded-md", "border");
    expect(dimensions).toHaveClass("border-t");
    expect(dimensions).not.toHaveClass("rounded-md", "border");
    expect(view).toHaveTextContent("当前操作：满足条件再参与");
    expect(view).toHaveTextContent("核心多空分歧与裁决");
    expect(view).toHaveTextContent("查看完整分析报告");
    expect(view).not.toHaveTextContent("先看证据覆盖");
  });

  it("shows complete valuation in the main dimension overview", () => {
    const report = {
      ...REPORT,
      dimension_views: {
        ...REPORT.dimension_views,
        valuation: {
          ...dimension("估值数据完整"),
          valuation_metrics: {
            current_pe: 26.37,
            current_pb: 4.09,
            pe_peer_count: 8,
            pb_peer_count: 8,
            pe_median: 20,
            pb_median: 3,
            pe_percentile: 0.875,
            pb_percentile: 0.75,
            comparison_method: "same-industry-current-snapshot-percentile-v1",
            comparison_as_of: "2026-08-18T15:00:00+08:00",
            peer_comparison_status: "complete",
          },
        },
      },
    } as StockReportV4Document;
    render(<ResearchDecisionView report={report} />);

    const valuation = within(screen.getByTestId("research-dimension-overview")).getByTestId("research-dimension-valuation");
    expect(valuation).toHaveTextContent("估值分析");
    expect(valuation).toHaveTextContent("市盈率（PE）");
    expect(valuation).toHaveTextContent("市净率（PB）");
    expect(valuation).toHaveTextContent("当前值：26.37");
    expect(valuation).toHaveTextContent("同行样本：8 家");
    expect(valuation).toHaveTextContent("同行中位数：20.00");
    expect(valuation).toHaveTextContent("同行分位：87.5%");
    expect(valuation).toHaveTextContent("同行业当前行情快照比较");
    expect(valuation).toHaveTextContent("数据时点：2026年8月18日 15:00");
    expect(valuation).not.toHaveTextContent("current_pe");
    expect(valuation).not.toHaveTextContent("peer_count");
    expect(valuation).not.toHaveTextContent("same-industry-current-snapshot-percentile-v1");
  });

  it("shows explicit valuation gaps in the main dimension overview", () => {
    const report = {
      ...REPORT,
      dimension_views: {
        ...REPORT.dimension_views,
        valuation: {
          status: "missing" as const,
          summary: "估值信息暂缺",
          points: [],
          missing_fields: ["current_pe", "current_pb", "peer_valuation"],
          source_ids: [],
        },
      },
    } as StockReportV4Document;
    render(<ResearchDecisionView report={report} />);

    const valuation = within(screen.getByTestId("research-dimension-overview")).getByTestId("research-dimension-valuation");
    expect(valuation).toHaveTextContent("估值数据缺失");
    expect(valuation).toHaveTextContent("市盈率（PE）当前值");
    expect(valuation).toHaveTextContent("市净率（PB）当前值");
    expect(valuation).toHaveTextContent("同行估值比较");
    expect(valuation).not.toHaveTextContent("current_pe");
    expect(valuation).not.toHaveTextContent("peer_valuation");
    expect(valuation).not.toHaveTextContent("same-industry-current-snapshot-percentile-v1");
  });

  it("shows complete trusted market breadth and public activity in the dimension cards", () => {
    render(<ResearchDecisionView report={withDimensionProjections(
      {
        status: "available",
        member_count: 4,
        available_change_count: 4,
        advancing: 2,
        declining: 1,
        unchanged: 1,
        suspended: 0,
        advance_ratio: 0.5,
        turnover_amount: 123456789,
        observed_at: "2026-08-19T14:00:00+08:00",
        basis: "trusted market snapshot",
        method: "market-breadth-v1",
        coverage: { complete: true, loaded_count: 4, expected_count: 4, coverage: 1 },
        missing_fields: [],
      },
      {
        status: "available",
        turnover: 987654.32,
        turnover_rate: 2.5,
        volume: 567890,
        price_change_pct: 3.45,
        volume_change_pct_5d: -12.5,
        observed_at: "2026-08-19T14:00:00+08:00",
        basis: "trusted quote",
        method: "public-capital-signals-v1",
        disclosure_signals: [
          { event_type: "share_unlock", event_date: "2026-08-20", title: "限售股解禁公告", source_ids: ["source-1"] },
          { event_type: "share_reduction", published_at: "2026-08-18T09:00:00+08:00", title: "股东减持计划", source_ids: ["source-2", "source-3"] },
        ],
        missing_fields: [],
      },
    )} />);

    const view = screen.getByTestId("research-dimension-overview");
    const market = within(view).getByTestId("research-dimension-market_environment");
    const capital = within(view).getByTestId("research-dimension-capital_positioning");
    expect(market).toHaveTextContent("市场宽度参考（不是市场情绪）");
    expect(market).toHaveTextContent("覆盖范围：已加载 4 / 应加载 4（完整）");
    expect(market).toHaveTextContent("上涨 2 · 下跌 1 · 平盘 1 · 停牌 0");
    expect(market).toHaveTextContent("上涨占比：50.0%");
    expect(market).toHaveTextContent("市场快照成交额：123,456,789（按数据源口径）");
    expect(market).toHaveTextContent("数据时点：2026年8月19日 14:00");
    expect(market).toHaveTextContent("仅反映当前行情快照的涨跌分布，不代表市场情绪");
    expect(capital).toHaveTextContent("公开交易活跃度参考（不代表机构资金）");
    expect(capital).toHaveTextContent("个股成交额：987,654.32（按数据源口径）");
    expect(capital).toHaveTextContent("换手率：2.5%");
    expect(capital).toHaveTextContent("成交量：567,890（按数据源口径）");
    expect(capital).toHaveTextContent("涨跌幅：3.45%");
    expect(capital).toHaveTextContent("5日成交量变化：-12.5%");
    expect(capital).toHaveTextContent("数据时点：2026年8月19日 14:00");
    expect(capital).toHaveTextContent("限售股解禁 · 2026年8月20日 · 限售股解禁公告");
    expect(capital).toHaveTextContent("股东减持 · 2026年8月18日 · 股东减持计划");
    expect(capital).toHaveTextContent("不推断机构净买入或主力控盘");
    expect(view).not.toHaveTextContent(/market-breadth-v1|public-capital-signals-v1|complete|partial|unavailable|share_unlock|share_reduction|share_pledge|source_id|market_breadth|public_activity/);
  });

  it("shows concrete missing fields for partial market breadth and public activity", () => {
    render(<ResearchDecisionView report={withDimensionProjections(
      {
        status: "degraded",
        member_count: 4,
        available_change_count: 2,
        advancing: 1,
        declining: 1,
        unchanged: null,
        suspended: null,
        advance_ratio: 0.5,
        turnover_amount: null,
        observed_at: "2026-08-19T14:00:00+08:00",
        coverage: { complete: false, loaded_count: 2, expected_count: 4, coverage: 0.5 },
        missing_fields: ["market_snapshot_complete", "unchanged", "suspended", "turnover_amount"],
      },
      {
        status: "degraded",
        turnover: null,
        turnover_rate: 2.5,
        volume: 100,
        price_change_pct: null,
        volume_change_pct_5d: null,
        observed_at: "2026-08-19T14:00:00+08:00",
        disclosure_signals: [{ event_type: "share_pledge", source_ids: [] }],
        missing_fields: ["turnover", "price_change_pct", "volume_change_pct_5d", "share_pledge", "etf_flow"],
      },
    )} />);

    const view = screen.getByTestId("research-dimension-overview");
    const market = within(view).getByTestId("research-dimension-market_environment");
    const capital = within(view).getByTestId("research-dimension-capital_positioning");
    expect(market).toHaveTextContent("覆盖范围：已加载 2 / 应加载 4（不完整）");
    expect(market).toHaveTextContent("缺失：市场快照完整性、平盘数量、停牌数量、市场快照成交额");
    expect(capital).toHaveTextContent("缺失：个股成交额、涨跌幅、近5日成交量变化、股权质押、交易型开放式指数基金（ETF）资金流");
    expect(capital).toHaveTextContent("股权质押 · 日期待确认 · 标题待确认");
    expect(view).not.toHaveTextContent(/market-breadth-v1|public-capital-signals-v1|complete|partial|unavailable|share_unlock|share_reduction|share_pledge|source_id|market_breadth|public_activity/);
  });

  it("does not infer coverage completeness when only counts are available", () => {
    render(<ResearchDecisionView report={withDimensionProjections(
      {
        status: "degraded",
        member_count: 4,
        available_change_count: 4,
        advancing: 2,
        declining: 1,
        unchanged: 1,
        suspended: 0,
        advance_ratio: 0.5,
        turnover_amount: 123,
        observed_at: "2026-08-19T14:00:00+08:00",
        coverage: { complete: null, loaded_count: 4, expected_count: 4, coverage: 1 },
        missing_fields: [],
      },
      { status: "missing", missing_fields: [] },
    )} />);

    expect(within(screen.getByTestId("research-dimension-overview")).getByTestId("research-dimension-market_environment"))
      .toHaveTextContent("覆盖范围：已加载 4 / 应加载 4（完整性待确认）");
  });

  it("keeps all-missing projection states readable without internal tokens", () => {
    render(<ResearchDecisionView report={withDimensionProjections(
      {
        status: "missing",
        member_count: null,
        available_change_count: null,
        advancing: null,
        declining: null,
        unchanged: null,
        suspended: null,
        advance_ratio: null,
        turnover_amount: null,
        observed_at: null,
        coverage: null,
        missing_fields: ["market_snapshot", "member_count", "advance_ratio"],
      },
      {
        status: "missing",
        turnover: null,
        turnover_rate: null,
        volume: null,
        price_change_pct: null,
        volume_change_pct_5d: null,
        observed_at: null,
        disclosure_signals: [],
        missing_fields: ["turnover", "turnover_rate", "volume", "price_change_pct", "volume_change_pct_5d", "disclosure_signals"],
      },
    )} />);

    const view = screen.getByTestId("research-dimension-overview");
    expect(within(view).getByTestId("research-dimension-market_environment")).toHaveTextContent("暂无可验证的市场宽度数据");
    expect(within(view).getByTestId("research-dimension-capital_positioning")).toHaveTextContent("暂无可验证的公开交易活跃度数据");
    expect(view).not.toHaveTextContent(/market-breadth-v1|public-capital-signals-v1|complete|partial|unavailable|share_unlock|share_reduction|share_pledge|source_id|market_breadth|public_activity/);
  });

  it("marks manual conditions as requiring verification and keeps V3 in compatibility view", () => {
    render(<ResearchDecisionView report={REPORT} />);
    const view = screen.getByTestId("research-decision-view");
    const medium = screen.getByTestId("horizon-card-medium_term");
    expect(within(medium).getAllByText("需人工观察").length).toBeGreaterThan(0);
    expect(within(medium).queryByText("系统可计算")).not.toBeInTheDocument();
    expect(view).not.toHaveTextContent("人工核验");
    expect(screen.queryByText("自动触发", { exact: true })).not.toBeInTheDocument();
    expect(view).not.toHaveTextContent("short_term");
    expect(view).not.toHaveTextContent("medium_term");
    expect(view).not.toHaveTextContent("long_term");

    cleanup();
    render(<ResearchDecisionView report={{ schema_version: 3, kind: "deep_research", research_stance: "neutral", summary: "历史摘要" }} />);
    expect(screen.getByTestId("legacy-research-view")).toHaveTextContent("历史投研结论");
    expect(screen.queryByTestId("horizon-card-short_term")).not.toBeInTheDocument();
  });

  it("keeps full-report condition provenance labels outside the decision summary", () => {
    const report = {
      ...REPORT,
      scenario_sets: {
        ...REPORT.scenario_sets,
        medium_term: {
          ...REPORT.scenario_sets.medium_term,
          base: {
            ...REPORT.scenario_sets.medium_term.base,
            conditions: [condition("完整报告中的系统条件", "trigger")],
          },
        },
      },
    } as StockReportV4Document;
    render(<ResearchDecisionView report={report} />);
    expect(screen.getByTestId("research-full-analysis")).not.toHaveAttribute("open");
    expect(screen.getByText("系统可计算")).toBeInTheDocument();
    expect(screen.getByTestId("horizon-participation-medium_term")).not.toHaveTextContent("系统可计算");
    expect(screen.getByTestId("horizon-exit-medium_term")).not.toHaveTextContent("系统可计算");
  });

  it("keeps schema details readable without exposing raw keys or source ids", () => {
    const report = {
      ...REPORT,
      horizon_views: {
        ...REPORT.horizon_views,
        medium_term: {
          ...REPORT.horizon_views.medium_term,
          thesis: "degraded: 中线命题",
          missing_fields: ["industry_context", "peer_valuation"],
          participation_conditions: [condition("short_term industry_context 和 peer_valuation 完成核验")],
          confirmation_conditions: [condition("medium_term peer_valuation 完成确认", "trigger")],
        },
      },
      cross_horizon_conflict: {
        ...REPORT.cross_horizon_conflict,
        source_ids: ["source-1"],
      },
    } as StockReportV4Document;
    render(<ResearchDecisionView report={report} />);

    const medium = screen.getByTestId("horizon-card-medium_term");
    expect(medium).toHaveTextContent("核心命题：部分缺失： 中线命题");
    expect(medium).not.toHaveTextContent("degraded:");
    expect(medium).toHaveTextContent("缺失数据：行业信息、同行估值");
    expect(medium).not.toHaveTextContent("industry_context");
    expect(medium).not.toHaveTextContent("peer_valuation");
    expect(medium).toHaveTextContent("短线 行业信息 和 同行估值 完成核验");
    expect(medium).toHaveTextContent("中线 同行估值 完成确认");
    expect(medium).toHaveTextContent("依据：1 条证据");
    expect(medium).not.toHaveTextContent("source-1");

    const conflict = screen.getByTestId("research-cross-horizon-conflict");
    expect(conflict).toHaveTextContent("依据：1 条证据");
    expect(conflict).not.toHaveTextContent("source-1");
  });
});
