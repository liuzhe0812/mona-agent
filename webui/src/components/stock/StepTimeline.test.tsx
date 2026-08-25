import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StockReportV4Document, StockReportV6Document } from "@/lib/stock-api";
import type { ArtifactRef, WorkflowRun } from "@/lib/types";

const fetchFilePreviewBlob = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    fetchFilePreviewBlob: (...args: unknown[]) => fetchFilePreviewBlob(...args),
  };
});

import { StepTimeline } from "./StepTimeline";

const artifact: ArtifactRef = {
  id: "artifact_1",
  owner_kind: "product",
  owner_id: "run_1",
  relative_path: "technical.json",
  created_by_agent_id: "agent_1",
  product: "stock",
  created_at: "2026-08-18T09:30:00Z",
};

function makeRun(artifacts: Array<string | ArtifactRef>): WorkflowRun {
  return {
    schemaVersion: 1,
    id: "run_1",
    roomId: "room_stock",
    workflowId: "workflow_stock",
    workflowRevision: 1,
    workflow: {
      schemaVersion: 1,
      id: "workflow_stock",
      roomId: "room_stock",
      revision: 1,
      status: "active",
      goal: "stock research",
      trigger: { type: "manual" },
      steps: [],
      createdAt: "2026-08-18T09:00:00Z",
      createdBy: "test",
    },
    status: "succeeded",
    triggerType: "manual",
    startedBy: "test",
    startedAt: "2026-08-18T09:30:00Z",
    steps: {
      technical: { status: "succeeded", output: { artifacts } },
    },
  };
}

function makeRunWithStatuses(statuses: Record<string, "succeeded" | "failed" | "cancelled" | "running">): WorkflowRun {
  const run = makeRun([]);
  run.steps = Object.fromEntries(
    Object.entries(statuses).map(([stepId, status]) => [stepId, { status }]),
  );
  run.status = Object.values(statuses).some((status) => status === "running") ? "running" : "succeeded";
  return run;
}

const V4_REPORT = {
  schema_version: 4,
  report_id: "report-v4",
  workflow_run_id: "run_1",
  summary: "V4 主审摘要",
} as unknown as StockReportV4Document;

const V4_REPORT_WITH_STRUCTURED_CLAIMS = {
  ...V4_REPORT,
  risks: [{ claim: "短线波动风险", claim_type: "inference", source_ids: ["source-1"] }],
  catalysts: [{ claim: "下一期财报验证", claim_type: "fact", source_ids: ["source-1"] }],
  open_questions: [{ claim: "经营现金流能否持续改善", claim_type: "hypothesis", source_ids: ["source-1"] }],
} as unknown as StockReportV4Document;

const V6_REPORT = {
  schemaVersion: 6,
  resultStatus: "completed",
  reportId: "report-v6",
  runId: "run-1",
  kind: "deep_research",
  instrument: { instrumentId: "XSHE:002709", symbol: "002709", exchange: "XSHE", name: "天赐材料", instrumentType: "equity" },
  decisionMode: "research_only",
  researchStatus: "ready",
  tradeStatus: "unavailable",
  summary: "V6研究摘要",
  researchCutoffAt: "2026-08-21T15:00:00+08:00",
  marketAsOf: "2026-08-21T15:00:00+08:00",
  generatedAt: "2026-08-21T15:05:00+08:00",
  horizonDecisions: {
    shortTerm: { direction: "positive", action: "wait", thesis: "短线等待确认", keyReasons: ["量价改善"], keyRisks: ["突破失败"], researchStatus: "ready", tradeStatus: "unavailable", materializedPlan: null },
    mediumTerm: { direction: "neutral", action: "wait", thesis: "中线等待确认", keyReasons: ["行业修复"], keyRisks: ["需求变化"], researchStatus: "ready", tradeStatus: "unavailable", materializedPlan: null },
    longTerm: { direction: "negative", action: "avoid", thesis: "长线暂不参与", keyReasons: ["估值待确认"], keyRisks: ["竞争加剧"], researchStatus: "ready", tradeStatus: "unavailable", materializedPlan: null },
  },
} as StockReportV6Document;

beforeEach(() => {
  vi.clearAllMocks();
  fetchFilePreviewBlob.mockResolvedValue({
    blob: new Blob([JSON.stringify({ summary: "技术面观点" })], {
      type: "application/json",
    }),
    mime: "application/json",
  });
});

describe("StepTimeline artifact references", () => {
  it("uses the V6 user-facing role-evidence drill-down label", () => {
    render(<StepTimeline run={makeRun([])} token="" report={V6_REPORT} variant="overview" />);
    expect(screen.getByTestId("research-process-details")).toHaveTextContent("查看各研究角色依据");
    expect(screen.queryByText(/Agent|Artifact|source_ids|research_only/)).not.toBeInTheDocument();
  });

  it("maps internal role tokens and source fields in visible artifact text", async () => {
    fetchFilePreviewBlob.mockResolvedValueOnce({
      blob: new Blob([JSON.stringify({
        summary: "technical 已完成，source_ids: source-1",
        points: [{ claim: "fundamental 结论", evidence: "news source_ids: source-2" }],
      })], { type: "application/json" }),
      mime: "application/json",
    });

    const { container } = render(<StepTimeline run={makeRun([artifact])} token="token_1" variant="overview" />);
    await waitFor(() => expect(container).toHaveTextContent("技术分析 已完成，证据来源"));
    expect(container).toHaveTextContent("基本面分析 结论");
    expect(container).toHaveTextContent("资讯分析 证据来源");
    expect(container).not.toHaveTextContent("technical");
    expect(container).not.toHaveTextContent("source_ids");
  });

  it("uses user-facing wording in the visible progress state", () => {
    const { container } = render(<StepTimeline run={null} token="" variant="overview" preparing />);
    expect(container).toHaveTextContent("正在准备研究资料并创建投研任务");
    expect(container).toHaveTextContent("已结束0/6");
    expect(container).not.toHaveTextContent("六位研究助手");
    expect(container).not.toHaveTextContent("证据包");
    expect(container).not.toHaveTextContent("六 Agent");
    expect(container).not.toHaveTextContent(/Agent|queued|running|waiting_approval|succeeded|failed|cancelled|skipped/);
  });

  it("describes multiple running analyses without exposing the assistant architecture", () => {
    const run = makeRun([]);
    run.status = "running";
    run.steps = {
      technical: { status: "running" },
      fundamental: { status: "running" },
    };
    const { container } = render(<StepTimeline run={run} token="" variant="overview" />);
    expect(container).toHaveTextContent("多项分析正在并行进行");
    expect(screen.queryByTestId("research-process-details")).not.toBeInTheDocument();
    expect(screen.getByTestId("research-process-sections")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/研究助手|证据包|六 Agent/);
  });

  it("keeps the completed process available but visually secondary", () => {
    const run = makeRun([]);
    const { container } = render(<StepTimeline run={run} token="" variant="overview" />);
    const process = screen.getByTestId("research-process");
    const details = screen.getByTestId("research-process-details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("查看研究过程（已结束1/6）");
    expect(screen.getByTestId("research-step-technical")).not.toHaveClass("border", "rounded-md");
    expect(container).toHaveTextContent("最终研判");
    expect(process).toHaveClass("text-muted-foreground");
  });

  it("counts failed steps separately from completed steps", () => {
    const run = makeRunWithStatuses({
      technical: "succeeded",
      fundamental: "succeeded",
      news: "succeeded",
      bull: "succeeded",
      bear: "succeeded",
      referee: "failed",
    });
    run.status = "failed";
    const { container } = render(<StepTimeline run={run} token="" report={V4_REPORT} variant="overview" />);

    expect(container).toHaveTextContent("成功5 · 失败1");
    expect(container).not.toHaveTextContent("已完成6/6");
    expect(screen.getByTestId("research-process-progress")).toBeInTheDocument();
    expect(screen.getByTestId("research-process-details")).toHaveTextContent("查看各分析角色结论（成功5 · 失败1）");
  });

  it("counts cancelled steps as unsuccessful and never as completed", () => {
    const run = makeRunWithStatuses({
      technical: "succeeded",
      fundamental: "succeeded",
      news: "succeeded",
      bull: "succeeded",
      bear: "cancelled",
      referee: "cancelled",
    });
    run.status = "cancelled";
    const { container } = render(<StepTimeline run={run} token="" variant="overview" />);

    expect(container).toHaveTextContent("成功4 · 失败2");
    expect(container).not.toHaveTextContent("已完成6/6");
    expect(screen.getByTestId("research-process-details")).toHaveTextContent("查看研究过程（成功4 · 失败2）");
  });

  it("shows completed six of six only when every step succeeds", () => {
    const run = makeRunWithStatuses({
      technical: "succeeded",
      fundamental: "succeeded",
      news: "succeeded",
      bull: "succeeded",
      bear: "succeeded",
      referee: "succeeded",
    });
    const { container } = render(<StepTimeline run={run} token="" variant="overview" />);

    expect(container).toHaveTextContent("已完成6/6");
    expect(screen.getByTestId("research-process-details")).toHaveTextContent("查看研究过程（已完成6/6）");
  });

  it("uses ended count while the run is still active", () => {
    const run = makeRunWithStatuses({
      technical: "succeeded",
      fundamental: "succeeded",
      news: "running",
    });
    const { container } = render(<StepTimeline run={run} token="" variant="overview" />);

    expect(container).toHaveTextContent("已结束2/6");
    expect(container).not.toHaveTextContent("已完成2/6");
  });

  it("reads structured run artifacts with room scope and artifact ownership", async () => {
    render(<StepTimeline run={makeRun([artifact])} token="token_1" />);

    await waitFor(() => expect(fetchFilePreviewBlob).toHaveBeenCalledTimes(1));
    expect(fetchFilePreviewBlob).toHaveBeenCalledWith("token_1", {
      scope: "room",
      path: "technical.json",
      room: "room_stock",
      artifactId: "artifact_1",
    });
  });

  it("keeps each role's analysis body closed until its role is opened", async () => {
    const run = makeRun([artifact]);
    run.status = "running";
    run.steps = { technical: { status: "running", output: { artifacts: [artifact] } } };
    render(<StepTimeline run={run} token="token_1" stepActivities={{}} />);

    await waitFor(() => expect(fetchFilePreviewBlob).toHaveBeenCalledTimes(1));
    const details = screen.getByTestId("research-step-details-technical") as HTMLDetailsElement;
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("技术分析师")).toBeInTheDocument();
    expect(screen.getAllByText("正在核对价格与趋势").length).toBeGreaterThan(0);
    expect(screen.getByText("技术面观点").closest("details")).toBe(details);

    fireEvent.click(within(details).getByText("技术分析师"));
    // happy-dom does not emulate the browser's native details toggle.
    details.open = true;

    expect(details).toHaveAttribute("open");
    expect(screen.getByText("技术面观点")).toBeInTheDocument();
  });

  it("keeps completed V4 role conclusions behind one closed group and independent role details", () => {
    render(<StepTimeline run={makeRun([])} token="" report={V4_REPORT} variant="overview" />);

    const processDetails = screen.getByTestId("research-process-details") as HTMLDetailsElement;
    expect(processDetails).not.toHaveAttribute("open");
    expect(screen.queryByTestId("research-process-progress")).not.toBeInTheDocument();
    expect(screen.getByText("查看各分析角色结论（已结束2/6）")).toBeInTheDocument();
    for (const stepId of ["technical", "fundamental", "news", "bull", "bear", "referee"]) {
      expect(screen.getByTestId(`research-step-details-${stepId}`)).not.toHaveAttribute("open");
    }
    expect(screen.getByText("V4 主审摘要").closest("details")).toBe(screen.getByTestId("research-step-details-referee"));

    fireEvent.click(screen.getByText("查看各分析角色结论（已结束2/6）"));

    expect(processDetails).toHaveAttribute("open");
    expect(screen.queryByTestId("research-process-progress")).not.toBeInTheDocument();
    const refereeDetails = screen.getByTestId("research-step-details-referee") as HTMLDetailsElement;
    expect(refereeDetails).not.toHaveAttribute("open");
    expect(screen.getByText("V4 主审摘要").closest("details")).toBe(refereeDetails);
    fireEvent.click(within(refereeDetails).getByText("主审"));
    refereeDetails.open = true;
    expect(screen.getByText("V4 主审摘要")).toBeInTheDocument();
  });

  it("renders structured V4 referee claims as Chinese text without object coercion", () => {
    const { container } = render(
      <StepTimeline run={makeRun([])} token="" report={V4_REPORT_WITH_STRUCTURED_CLAIMS} variant="overview" />,
    );

    const refereeDetails = screen.getByTestId("research-step-details-referee") as HTMLDetailsElement;
    expect(refereeDetails).not.toHaveAttribute("open");
    expect(container.textContent).not.toContain("[object Object]");

    fireEvent.click(within(refereeDetails).getByText("主审"));
    // happy-dom does not emulate the browser's native details toggle.
    refereeDetails.open = true;

    expect(screen.getByText("风险：短线波动风险")).toBeInTheDocument();
    expect(screen.getByText("催化：下一期财报验证")).toBeInTheDocument();
    expect(screen.getByText("待核验：经营现金流能否持续改善")).toBeInTheDocument();
    expect(container.textContent).not.toContain("[object Object]");
  });

  it("does not expose tool names in the role progress view", () => {
    const run = makeRun([]);
    run.status = "running";
    run.steps = { technical: { status: "running" } };
    render(
      <StepTimeline
        run={run}
        token=""
        stepActivities={{
          "run_1:technical": [{ phase: "start", call_id: "call-1", name: "stock_evidence_read" }],
        }}
      />,
    );

    expect(screen.queryByText("读取本次投研证据")).not.toBeInTheDocument();
    expect(screen.getAllByText("正在核对价格与趋势").length).toBeGreaterThan(0);
  });

  it("keeps legacy string artifact paths on shared scope", async () => {
    render(<StepTimeline run={makeRun(["artifact://legacy/technical.json"])} token="token_1" />);

    await waitFor(() => expect(fetchFilePreviewBlob).toHaveBeenCalledTimes(1));
    expect(fetchFilePreviewBlob).toHaveBeenCalledWith("token_1", {
      scope: "shared",
      path: "legacy/technical.json",
    });
  });
});
