import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExpertPanel } from "./ExpertPanel";

function run(status: "running" | "succeeded" | "failed" = "running") {
  return {
    schemaVersion: 1,
    id: "run-expert",
    roomId: "stock_research",
    workflowId: "stock-deep-research",
    workflowRevision: 1,
    workflow: { schemaVersion: 1, id: "stock-deep-research", roomId: "stock_research", revision: 1, status: "active", goal: "六位专家" },
    status,
    triggerType: "manual",
    startedBy: "user",
    startedAt: "2026-08-25T07:00:00Z",
    steps: { technical: { status: status === "running" ? "running" : "succeeded" }, fundamental: { status: "succeeded" }, news: { status: "succeeded" }, bull: { status: "succeeded" }, bear: { status: "succeeded" }, referee: { status: "succeeded" } },
    inputs: { symbols: ["XSHE:000001"] },
  } as never;
}

describe("ExpertPanel", () => {
  it("shows six roles collapsed and expands only structured evidence", () => {
    render(<ExpertPanel run={run("succeeded")} report={{ kind: "deep_research", schema_version: 4, analyst_views: { technical: "技术结论\n不应铺开原始材料" }, debate_resolution: { disagreement: "估值分歧" } } as never} onStart={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("expert-role-list")).toHaveTextContent("技术分析师");
    expect(screen.getByTestId("expert-role-list")).toHaveTextContent("基本面分析师");
    expect(screen.getByTestId("expert-role-list")).toHaveTextContent("行业资讯分析师");
    expect(screen.getByTestId("expert-role-list")).toHaveTextContent("多头研究员");
    expect(screen.getByTestId("expert-role-list")).toHaveTextContent("空头研究员");
    expect(screen.getByTestId("expert-role-list")).toHaveTextContent("主审");
    expect(screen.queryByTestId("expert-role-technical-evidence")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("expert-role-technical").querySelector("button")!);
    expect(screen.getByTestId("expert-role-technical-evidence")).toBeInTheDocument();
    expect(screen.getByTestId("expert-referee-summary")).toHaveTextContent("估值分歧");
    expect(screen.queryByText(/不应铺开原始材料/)).not.toBeInTheDocument();
  });

  it("does not start the deep workflow before the explicit action", () => {
    const onStart = vi.fn();
    render(<ExpertPanel run={null} report={null} onStart={onStart} onCancel={vi.fn()} />);
    expect(onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "启动专家团论证" }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
