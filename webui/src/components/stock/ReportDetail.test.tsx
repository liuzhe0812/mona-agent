import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StockReportDetail, StockReportV4Document, StockReportV6Document } from "@/lib/stock-api";
import { ReportDetail } from "./ReportDetail";

vi.mock("@/components/MarkdownText", () => ({
  MarkdownText: ({ children }: { children: string }) => (
    <div data-testid="markdown">{children}</div>
  ),
}));

const V4_REPORT = {
  schema_version: 4,
  report_id: "report-v4",
  kind: "deep_research",
  workflow_run_id: "run-v4",
  instrument: { symbol: "600519", exchange: "XSHG", name: "贵州茅台", instrument_type: "equity" },
  as_of: "2026-08-18T15:00:00+08:00",
  research_cutoff_at: "2026-08-18T15:00:00+08:00",
  market_as_of: "2026-08-18T15:00:00+08:00",
  summary: "V4 摘要",
  horizon_views: {},
  cycle_states: {},
  market_regime_summary: { status: "missing", summary: "", points: [], missing_fields: [], source_ids: [] },
  industry_policy_summary: { status: "missing", summary: "", points: [], missing_fields: [], source_ids: [] },
  scenario_sets: {},
  cross_horizon_conflict: { status: "insufficient_data", explanation: "未提供", source_ids: [] },
  evidence_coverage: {},
  outcome_tracking_id: "outcome-v4",
  analyst_views: {},
  debate: {},
  risks: [],
  catalysts: [],
  open_questions: [],
  source_ids: [],
  sources: [],
  versions: {},
  disclaimer: "仅供研究参考",
} as unknown as StockReportV4Document;

const V6_REPORT = {
  schemaVersion: 6,
  resultStatus: "completed",
  reportId: "report-v6",
  runId: "run-v6",
  kind: "deep_research",
  instrument: { instrumentId: "XSHE:002407", symbol: "002407", exchange: "XSHE", name: "多氟多", instrumentType: "equity" },
  decisionMode: "research_only",
  researchStatus: "ready",
  tradeStatus: "unavailable",
  summary: "短线等待确认，中长线继续观察。",
  researchCutoffAt: "2026-08-21T15:00:00+08:00",
  marketAsOf: "2026-08-21T15:00:00+08:00",
  generatedAt: "2026-08-21T15:05:00+08:00",
  currentPrice: 34.57,
  sourceCount: 4,
  horizonDecisions: {
    shortTerm: { direction: "negative", action: "avoid", thesis: "短线趋势偏弱", keyReasons: ["趋势偏弱"], keyRisks: ["继续下跌"], researchStatus: "ready", tradeStatus: "unavailable", materializedPlan: null },
    mediumTerm: { direction: "neutral", action: "wait", thesis: "中线等待行业确认", keyReasons: ["行业待确认"], keyRisks: ["需求不及预期"], researchStatus: "ready", tradeStatus: "unavailable", materializedPlan: null },
    longTerm: { direction: "neutral", action: "wait", thesis: "长线等待估值确认", keyReasons: ["估值待确认"], keyRisks: ["盈利波动"], researchStatus: "ready", tradeStatus: "unavailable", materializedPlan: null },
  },
  valuation: { status: "ready", assessment: { view: "合理", pe: { view: "合理", percentile: 0.5 }, pb: { view: "合理", percentile: 0.4 } } },
  marketSentiment: { status: "available", direction: "偏空", decisionImpact: "仅作为市场环境参考" },
  publicOpinion: { status: "available", direction: "分歧", coverageAccountCount: 30 },
  quantValidation: {
    strategyId: "quality_growth",
    asOf: "2026-08-21T15:00:00+08:00",
    factorAlgorithmVersion: "screening-factor-v1",
    rankAlgorithmVersion: "percentile-rank-v1",
    validationStatus: "uncalibrated",
    quantSignal: "neutral",
    horizons: {
      shortTerm: { status: "uncalibrated", signal: "neutral", factorObservations: [{ field: "momentum20", rawValue: 4.2, percentileOrRank: 0.8, direction: "desc", scope: "market", sampleCount: 100, missingCount: 0, asOf: "2026-08-21T15:00:00+08:00", methodVersion: "percentile-rank-v1", validationStatus: "uncalibrated", sourceCount: 1 }], targetWindowSessions: 10 },
      mediumTerm: { status: "uncalibrated", signal: "neutral", factorObservations: [], targetWindowSessions: 60 },
      longTerm: { status: "uncalibrated", signal: "neutral", factorObservations: [], targetWindowSessions: 120 },
    },
  },
} as unknown as StockReportV6Document;

function props(report: StockReportDetail) {
  return {
    activeReport: report,
    onClose: vi.fn(),
    onDeleteReport: vi.fn(),
    onDeepResearch: vi.fn(),
  };
}

describe("ReportDetail", () => {
  it("puts V4 structured evidence before the markdown fallback", () => {
    render(<ReportDetail {...props({ report: V4_REPORT, markdown: "# V4 markdown" })} />);

    expect(screen.getByTestId("research-evidence-detail")).toBeInTheDocument();
    expect(screen.getByText("查看原始格式报告")).toBeInTheDocument();
    expect(screen.queryByText("查看 Markdown 报告")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown")).toHaveTextContent("# V4 markdown");
  });

  it("keeps V3 deep reports and daily digests on the markdown/card fallback", () => {
    const v3 = {
      schema_version: 3,
      kind: "deep_research",
      report_id: "report-v3",
      summary: "V3",
    } as StockReportDetail["report"];
    const { rerender } = render(
      <ReportDetail {...props({ report: v3, markdown: "# V3 markdown" })} />,
    );
    expect(screen.queryByTestId("research-evidence-detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("markdown")).toHaveTextContent("# V3 markdown");

    const digest = {
      schema_version: 3,
      kind: "daily_review",
      report_id: "digest-v3",
      items: [
        {
          instrument: { symbol: "600519", exchange: "XSHG", name: "贵州茅台" },
          stance: "neutral",
          one_liner: "复盘摘要",
          data_quality: "complete",
        },
      ],
    } as StockReportDetail["report"];
    rerender(<ReportDetail {...props({ report: digest, markdown: "# digest" })} />);
    expect(screen.getByText("复盘摘要")).toBeInTheDocument();
    expect(screen.getByTestId("markdown")).toHaveTextContent("# digest");
  });

  it("uses user-facing wording in the delete confirmation", () => {
    render(<ReportDetail {...props({ report: V4_REPORT, markdown: "# V4 markdown" })} />);

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByText(/报告及相关研究记录/)).toBeInTheDocument();
    expect(screen.queryByText(/六位研究助手|证据包|六 Agent|各研究助手/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Agent/)).not.toBeInTheDocument();
  });

  it("renders V6 conclusions from the camelCase contract without Markdown process content", () => {
    const onDeleteReport = vi.fn();
    render(<ReportDetail {...props({ report: V6_REPORT, markdown: "# 内部研究过程\nsource_ids: src-1" })} onDeleteReport={onDeleteReport} />);

    expect(screen.getByTestId("v6-report-summary")).toBeInTheDocument();
    expect(screen.getByTestId("v6-report-summary")).toHaveTextContent("依据来源：4 条");
    expect(screen.getByTestId("research-v6-market-sentiment")).toHaveTextContent("市场情绪：偏空");
    expect(screen.getByTestId("research-v6-public-opinion")).toHaveTextContent("市场舆论风向：分歧 · 覆盖 30 个账号");
    expect(screen.getByTestId("research-v6-conclusion-dimensions")).toHaveTextContent("估值合理");
    expect(screen.getByTestId("research-quant-observation")).toHaveTextContent("20日动量");
    expect(screen.queryByTestId("markdown")).not.toBeInTheDocument();
    expect(screen.queryByText(/source_ids|内部研究过程/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导出" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    expect(onDeleteReport).toHaveBeenCalledWith("report-v6");
  });
});
