import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  StockHorizonCondition,
  StockReportV4Document,
  StockSummarySection,
  StockViewPoint,
} from "@/lib/stock-api";
import { ResearchEvidenceDetail } from "./ResearchEvidenceDetail";

const fetchStockMaterialPage = vi.fn();

vi.mock("@/lib/stock-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stock-api")>()),
  fetchStockMaterialPage: (...args: unknown[]) => fetchStockMaterialPage(...args),
}));

const point = (claim: string, claimType: StockViewPoint["claim_type"] = "fact"): StockViewPoint => ({
  claim,
  claim_type: claimType,
  basis: claimType === "inference" ? "基于公开数据" : null,
  evidence: "报告中的原始证据",
  source_ids: ["src-1"],
});

const condition: StockHorizonCondition = {
  kind: "trigger",
  text: "收盘站上观察指标",
  observed_metric_ref: "quote.close",
  operator: "gte",
  threshold_metric_ref: "indicators.swing.support",
  source_ids: ["src-1"],
};

const view = {
  stance: "positive" as const,
  status: "available" as const,
  dimension_keys: ["market_environment", "industry", "policy"],
  thesis: "结构化周期结论",
  drivers: [point("驱动事实")],
  priced_in: "unknown" as const,
  benchmark: { name: "沪深300", relative_view: "unknown" as const },
  action: "observe" as const,
  participation_conditions: [condition],
  confirmation_conditions: [],
  watch_conditions: [],
  invalidation_conditions: [],
  time_stop: "持续观察",
  tradeability_risks: [point("流动性风险", "inference")],
  blind_spots: [],
  evidence_strength: "medium" as const,
  data_status: "complete" as const,
  missing_fields: [],
  source_ids: ["src-1"],
};

const cycle = {
  status: "available" as const,
  stage: "扩张",
  leading_indicators: [point("领先指标")],
  confirmation_indicators: [point("确认指标", "inference")],
  turning_conditions: [condition],
  observation_window: "下季度",
  evidence_strength: "medium" as const,
  missing_fields: [],
  source_ids: ["src-1"],
};

const REPORT: StockReportV4Document = {
  schema_version: 4,
  report_id: "report-v4",
  kind: "deep_research",
  workflow_run_id: "run-v4",
  instrument: { symbol: "600519", exchange: "XSHG", name: "贵州茅台", instrument_type: "equity" },
  as_of: "2026-08-18T15:00:00+08:00",
  research_cutoff_at: "2026-08-18T15:01:00+08:00",
  market_as_of: "2026-08-18T15:00:00+08:00",
  summary: "独立周期研究摘要",
  event_calendar: {
    status: "degraded",
    events: [
      { title: "业绩说明会", event_date: "2026-09-01", status: "published", source_ids: ["src-1"] },
      { title: "无日期公告", event_date: null, status: "published", source_ids: [] },
    ],
    missing_fields: ["event_date"],
    source_ids: ["src-1"],
  },
  horizon_views: { short_term: view, medium_term: view, long_term: view },
  cycle_states: { policy: cycle, industry: cycle, earnings: cycle, valuation: cycle },
  market_regime_summary: {
    status: "available",
    summary: "市场环境摘要",
    points: [point("市场事实")],
    missing_fields: [],
    source_ids: ["src-1"],
  },
  industry_policy_summary: {
    status: "degraded",
    summary: "行业政策摘要",
    points: [point("行业事实")],
    missing_fields: ["政策文件"],
    source_ids: ["src-1"],
  },
  scenario_sets: {
    short_term: {
      optimistic: { summary: "乐观", conditions: [], outcome_direction: "positive", risks: [], source_ids: [] },
      base: { summary: "基准", conditions: [], outcome_direction: "neutral", risks: [], source_ids: [] },
      pessimistic: { summary: "悲观", conditions: [], outcome_direction: "negative", risks: [], source_ids: [] },
    },
    medium_term: {
      optimistic: { summary: "乐观", conditions: [], outcome_direction: "positive", risks: [], source_ids: [] },
      base: { summary: "基准", conditions: [], outcome_direction: "neutral", risks: [], source_ids: [] },
      pessimistic: { summary: "悲观", conditions: [], outcome_direction: "negative", risks: [], source_ids: [] },
    },
    long_term: {
      optimistic: { summary: "乐观", conditions: [], outcome_direction: "positive", risks: [], source_ids: [] },
      base: { summary: "基准", conditions: [], outcome_direction: "neutral", risks: [], source_ids: [] },
      pessimistic: { summary: "悲观", conditions: [], outcome_direction: "negative", risks: [], source_ids: [] },
    },
  },
  cross_horizon_conflict: {
    status: "mixed",
    explanation: "短线与长线证据方向不一致",
    source_ids: ["src-1"],
  },
  evidence_coverage: {
    short_term: { status: "available" },
    medium_term: { status: "degraded", missing_fields: ["事件"] },
    long_term: { status: "available" },
  },
  outcome_tracking_id: "outcome-v4",
  analyst_views: {
    fundamental: "artifact://stock/run-v4/fundamental.json",
    technical: "artifact://stock/run-v4/technical.json",
    news: "artifact://stock/run-v4/news.json",
  },
  debate: {
    bull: "artifact://stock/run-v4/bull.json",
    bear: "artifact://stock/run-v4/bear.json",
  },
  debate_resolution: {
    short_term: {
      status: "available",
      issue: "短线多空争议",
      bull_case: [point("短线多方依据")],
      bear_case: [point("短线空方依据", "inference")],
      verdict: [point("短线主席裁决", "inference")],
      change_conditions: [condition],
      missing_fields: [],
      source_ids: ["src-1"],
    },
    medium_term: {
      status: "degraded",
      issue: "中线多空争议",
      bull_case: [],
      bear_case: [],
      verdict: [],
      change_conditions: [],
      missing_fields: ["盈利预期"],
      source_ids: [],
    },
    long_term: {
      status: "missing",
      issue: "长线多空争议",
      bull_case: [],
      bear_case: [],
      verdict: [],
      change_conditions: [],
      missing_fields: ["行业生命周期"],
      source_ids: [],
    },
  },
  risks: [point("结构化风险", "inference")],
  catalysts: [point("结构化催化")],
  open_questions: [point("结构化待验证问题", "hypothesis")],
  source_ids: ["src-1"],
  sources: [
    {
      id: "src-1",
      provider: "eastmoney",
      url: "https://example.test/source",
      published_at: "2026-08-18T10:00:00+08:00",
      period_end: "2026-06-30",
      fetched_at: "2026-08-18T10:01:00+08:00",
      content_hash: "sha256:test",
      fields: ["close"],
    },
  ],
  versions: { evidence: "2" },
  disclaimer: "仅供研究参考",
};

function reportWithValuation(section: StockSummarySection): StockReportV4Document {
  return {
    ...REPORT,
    dimension_views: {
      valuation: section,
    } as unknown as NonNullable<StockReportV4Document["dimension_views"]>,
  };
}

describe("ResearchEvidenceDetail", () => {
  beforeEach(() => {
    fetchStockMaterialPage.mockReset();
  });

  it("renders the structured partitions, claim provenance and source timestamps", () => {
    render(<ResearchEvidenceDetail report={REPORT} />);

    expect(screen.getByTestId("research-evidence-detail")).toBeInTheDocument();
    expect(screen.getByText("投研依据")).toBeInTheDocument();
    expect(screen.queryByText("结构化投研证据")).not.toBeInTheDocument();
    expect(screen.getByText("八项分析维度")).toBeInTheDocument();
    expect(screen.getByTestId("research-dimension-market_environment")).toBeInTheDocument();
    expect(screen.getByTestId("research-dimension-company_quality")).toBeInTheDocument();
    expect(screen.getByTestId("research-dimension-event_risk")).toBeInTheDocument();
    expect(screen.getByTestId("research-dimension-valuation")).toHaveTextContent("估值数据缺失");
    expect(screen.getByTestId("research-dimension-valuation")).not.toHaveTextContent("市场风格与筹码周期阶段");
    expect(screen.getByTestId("research-event-calendar")).toHaveTextContent("业绩说明会");
    expect(screen.getByTestId("research-event-calendar")).toHaveTextContent("无日期公告");
    expect(screen.getByTestId("research-event-calendar")).toHaveTextContent("不可用于未来事件判断");
    expect(screen.getByText("四周期")).toBeInTheDocument();
    expect(screen.getByText("宏观与流动性周期")).toBeInTheDocument();
    expect(screen.getByText("行业供需与产品价格周期")).toBeInTheDocument();
    expect(screen.getByText("公司盈利与现金流周期")).toBeInTheDocument();
    expect(screen.getByText("市场风格与筹码周期")).toBeInTheDocument();
    expect(screen.getByText("分析产物引用")).toBeInTheDocument();
    expect(screen.getByText("结构化风险")).toBeInTheDocument();
    expect(screen.getByText("结构化催化")).toBeInTheDocument();
    expect(screen.getByText("结构化待验证问题")).toBeInTheDocument();
    expect(screen.getByTestId("research-debate-short_term")).toHaveTextContent("短线多空争议");
    expect(screen.getByTestId("research-debate-short_term")).toHaveTextContent("最终研判");
    expect(screen.getByTestId("research-debate-medium_term")).toHaveTextContent("缺少信息：盈利预期");
    expect(screen.getByTestId("research-debate-long_term")).toHaveTextContent("缺少信息：行业生命周期");
    expect(screen.getAllByText("依据：基于公开数据").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/证据来源：1 条/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/研究截止：2026年8月18日 15:01/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/行情截至：2026年8月18日 15:00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/来源公开时间：2026年8月18日 10:00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/数据统计期末：2026年6月30日/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/采集时间：2026年8月18日 10:01/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "打开来源" })[0]).toHaveAttribute(
      "href",
      "https://example.test/source",
    );
    expect(screen.getByText(/artifact:\/\/stock\/run-v4\/bull\.json/)).toBeInTheDocument();
  });

  it("keeps missing fields explicit and refuses unsafe source URLs", () => {
    const report: StockReportV4Document = {
      ...REPORT,
      risks: [],
      catalysts: [],
      open_questions: [],
      sources: [{ ...REPORT.sources[0], url: "javascript:alert(1)" }],
      market_regime_summary: {
        ...REPORT.market_regime_summary,
        status: "missing",
        points: [],
        summary: "",
        missing_fields: ["market_regime"],
      },
    };
    render(<ResearchEvidenceDetail report={report} />);

    expect(screen.getAllByText("未提供").length).toBeGreaterThan(0);
    expect(screen.getByText("事件与风险：本报告未提供该维度")).toBeInTheDocument();
    expect(screen.getAllByText("来源链接不可安全打开").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "打开来源" })).not.toBeInTheDocument();
  });

  it("preserves unparseable timestamps and missing timestamps", () => {
    const report: StockReportV4Document = {
      ...REPORT,
      research_cutoff_at: "时间格式无法识别",
      market_as_of: null,
      sources: [{
        ...REPORT.sources[0],
        published_at: "时间格式无法识别",
        period_end: null,
        fetched_at: "",
      }],
    };
    render(<ResearchEvidenceDetail report={report} />);

    expect(screen.getByText("研究截止：时间格式无法识别")).toBeInTheDocument();
    expect(screen.getByText("行情截至：未提供")).toBeInTheDocument();
    expect(screen.getAllByText(/来源公开时间：时间格式无法识别/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/数据统计期末：未提供/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/采集时间：未提供/).length).toBeGreaterThan(0);
  });

  it("keeps internal evidence fields out of the primary copy", () => {
    const report: StockReportV4Document = {
      ...REPORT,
      event_calendar: {
        ...REPORT.event_calendar,
        events: [{
          title: null,
          summary: null,
          event_type: "periodic_report",
          status: "published",
          event_date: null,
          source_ids: ["src-1"],
        }],
      },
    };

    render(<ResearchEvidenceDetail report={report} />);

    const detail = screen.getByTestId("research-evidence-detail");
    expect(detail).toHaveTextContent("证据来源：1 条");
    expect(detail).toHaveTextContent("技术追溯信息");
    expect(detail).toHaveTextContent("收盘价");
    expect(detail).toHaveTextContent("比较方式：大于或等于");
    expect(detail).not.toHaveTextContent("运算：");
    expect(detail).toHaveTextContent("大于或等于");
    expect(detail).toHaveTextContent("支撑位");
    expect(detail).toHaveTextContent("定期报告");
    expect(detail).toHaveTextContent("已发布");
    expect(detail).toHaveTextContent("证据可信度：中等");
    expect(detail).not.toHaveTextContent("source_ids：");
    expect(detail).not.toHaveTextContent("provider：");
    expect(detail).not.toHaveTextContent("quote.close");
    expect(detail).not.toHaveTextContent("indicators.swing.support");
    expect(detail).not.toHaveTextContent("gte");
    expect(detail).not.toHaveTextContent("periodic_report");
    expect(detail).not.toHaveTextContent("degraded");
    expect(detail).not.toHaveTextContent("medium");
  });

  it("shows complete PE/PB values and peer comparison in Chinese", () => {
    const report = reportWithValuation({
      status: "available",
      summary: "估值数据完整",
      points: [],
      missing_fields: [],
      source_ids: ["src-1"],
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
        comparison_basis: "目标 PE/PB 与研究截止前同一行业快照的正值样本比较",
        comparison_as_of: "2026-08-18T15:00:00+08:00",
        peer_comparison_status: "complete",
        missing_reasons: [],
      },
    });
    render(<ResearchEvidenceDetail report={report} />);

    const valuation = screen.getByTestId("research-valuation-analysis");
    expect(valuation).toHaveTextContent("市盈率（PE）");
    expect(valuation).toHaveTextContent("市净率（PB）");
    expect(valuation).toHaveTextContent("当前值：26.37");
    expect(valuation).toHaveTextContent("同行样本：8 家");
    expect(valuation).toHaveTextContent("同行中位数：20.00");
    expect(valuation).toHaveTextContent("同行分位：87.5%");
    expect(valuation).toHaveTextContent("数值越高表示相对同行估值越高");
    expect(valuation).toHaveTextContent("同行业当前行情快照比较");
    expect(valuation).toHaveTextContent("数据时点：2026年8月18日 15:00");
    expect(valuation).not.toHaveTextContent("current_pe");
    expect(valuation).not.toHaveTextContent("peer_count");
    expect(valuation).not.toHaveTextContent("same-industry-current-snapshot-percentile-v1");
  });

  it("keeps current values visible when peer comparison is incomplete", () => {
    const report = reportWithValuation({
      status: "degraded",
      summary: "当前估值快照",
      points: [],
      missing_fields: ["peer_valuation"],
      source_ids: ["src-1"],
      valuation_metrics: {
        current_pe: 26.37,
        current_pb: 4.09,
        pe_peer_count: 0,
        pb_peer_count: 0,
        pe_median: null,
        pb_median: null,
        pe_percentile: null,
        pb_percentile: null,
        comparison_method: "same-industry-current-snapshot-percentile-v1",
        comparison_as_of: "2026-08-18T15:00:00+08:00",
        peer_comparison_status: "insufficient_data",
        missing_reasons: ["市盈率（PE）同行比较数据不足，不能判断相对高低"],
      },
    });
    render(<ResearchEvidenceDetail report={report} />);

    const valuation = screen.getByTestId("research-valuation-analysis");
    expect(valuation).toHaveTextContent("当前值：26.37");
    expect(valuation).toHaveTextContent("当前值：4.09");
    expect(valuation).toHaveTextContent("同行比较数据不足，不能判断相对高低");
    expect(valuation).not.toHaveTextContent("中性");
  });

  it("explains which valuation data is missing when no values are available", () => {
    const report = reportWithValuation({
      status: "missing",
      summary: "估值数据缺失",
      points: [],
      missing_fields: ["current_pe", "current_pb", "peer_valuation"],
      source_ids: [],
    });
    render(<ResearchEvidenceDetail report={report} />);

    const valuation = screen.getByTestId("research-valuation-analysis");
    expect(valuation).toHaveTextContent("估值数据缺失");
    expect(valuation).toHaveTextContent("市盈率（PE）当前值");
    expect(valuation).toHaveTextContent("市净率（PB）当前值");
    expect(valuation).toHaveTextContent("同行估值比较");
    expect(valuation).not.toHaveTextContent("current_pe");
    expect(valuation).not.toHaveTextContent("peer_valuation");
  });

  it("opens a local financial-report page without exposing internal identifiers", async () => {
    fetchStockMaterialPage.mockResolvedValue({
      material_name: "贵州茅台半年报.pdf",
      page: 2,
      page_count: 12,
      text: "营业收入 100 亿元。",
    });
    const report: StockReportV4Document = {
      ...REPORT,
      sources: [{
        id: "material-source-internal",
        provider: "贵州茅台股份有限公司",
        url: "materials://material-report-internal",
        published_at: "2026-08-20T18:00:00+08:00",
        period_end: "2026-06-30",
        fetched_at: "2026-08-21T09:00:00+08:00",
        content_hash: "sha256:internal",
        fields: ["page_text", "page"],
        material_id: "material-report-internal",
        material_name: "贵州茅台半年报.pdf",
        page: 2,
        location_label: "用户上传财报，第 2 页",
        source_role: "user_confirmed_financial_report",
      }],
    };
    render(<ResearchEvidenceDetail report={report} />);

    const source = screen.getByTestId("research-material-source");
    expect(source).toHaveTextContent("财报名称：贵州茅台半年报.pdf");
    expect(source).toHaveTextContent("报告期：2026年6月30日");
    expect(source).toHaveTextContent("首次公开时间：2026年8月20日 18:00");
    expect(source).toHaveTextContent("页码：第 2 页");
    expect(source).toHaveTextContent("查看财报第 2 页");
    expect(source).not.toHaveTextContent("material-report-internal");
    expect(source).not.toHaveTextContent("material-source-internal");
    expect(source).not.toHaveTextContent("user_confirmed_financial_report");

    fireEvent.click(screen.getByRole("button", { name: "查看财报第 2 页" }));
    await waitFor(() => expect(fetchStockMaterialPage).toHaveBeenCalledWith("material-report-internal", 2));
    expect(await screen.findByTestId("research-material-page-preview")).toHaveTextContent("营业收入 100 亿元。");
  });

  it("keeps local financial-report metadata and shows a Chinese retry error when page reading fails", async () => {
    fetchStockMaterialPage.mockRejectedValue(new Error("upstream unavailable"));
    const report: StockReportV4Document = {
      ...REPORT,
      sources: [{
        ...REPORT.sources[0],
        id: "material-source-internal",
        url: "materials://material-report-internal",
        material_id: "material-report-internal",
        material_name: "贵州茅台半年报.pdf",
        page: 3,
        period_end: "2026-06-30",
        published_at: "2026-08-20T18:00:00+08:00",
        location_label: "用户上传财报，第 3 页",
        source_role: "user_confirmed_financial_report",
      }],
    };
    render(<ResearchEvidenceDetail report={report} />);
    fireEvent.click(screen.getByRole("button", { name: "查看财报第 3 页" }));
    expect(await screen.findByText("财报原文读取失败，请稍后重试")).toBeInTheDocument();
    expect(screen.getByTestId("research-material-source")).toHaveTextContent("报告期：2026年6月30日");
    expect(screen.getByTestId("research-material-source")).not.toHaveTextContent("material-report-internal");
  });
});
