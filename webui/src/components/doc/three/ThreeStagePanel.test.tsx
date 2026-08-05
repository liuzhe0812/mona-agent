import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThreeStagePanel } from "./ThreeStagePanel";
import type { ThreeStage } from "./threeState";

const STAGES: ThreeStage[] = [
  { id: "blockout", status: "passed" },
  { id: "structural-pass", status: "running" },
  { id: "form-refinement", status: "pending" },
];

describe("ThreeStagePanel", () => {
  it("renders stage names and statuses", () => {
    render(<ThreeStagePanel stages={STAGES} blockedReason="" lastReview={null} />);
    expect(screen.getByText("粗模")).toBeTruthy();
    expect(screen.getByText("结构")).toBeTruthy();
    expect(screen.getByText("已通过")).toBeTruthy();
    expect(screen.getByText("进行中")).toBeTruthy();
    expect(screen.getByText("待处理")).toBeTruthy();
  });

  it("shows the blocked reason when the pipeline is blocked", () => {
    render(
      <ThreeStagePanel
        stages={[{ id: "blockout", status: "blocked" }]}
        blockedReason="缺少特写参考图"
        lastReview={null}
      />,
    );
    expect(screen.getByText("已阻塞")).toBeTruthy();
    expect(screen.getByText(/缺少特写参考图/)).toBeTruthy();
  });

  it("shows the latest review conclusion", () => {
    render(
      <ThreeStagePanel
        stages={STAGES}
        blockedReason=""
        lastReview={{ passId: "blockout", action: "refine-spec", summary: "左右比例失调" }}
      />,
    );
    expect(screen.getByText(/左右比例失调/)).toBeTruthy();
  });

  it("falls back to the raw pass id when no label exists", () => {
    render(
      <ThreeStagePanel
        stages={[{ id: "custom-pass", status: "pending" }]}
        blockedReason=""
        lastReview={null}
      />,
    );
    expect(screen.getByText("custom-pass")).toBeTruthy();
  });
});
