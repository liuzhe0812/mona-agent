import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { StockReportDetail, StockReportV4Document } from "@/lib/stock-api";
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
});
