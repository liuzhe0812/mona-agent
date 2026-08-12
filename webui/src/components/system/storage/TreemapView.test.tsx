import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TreemapView, estimateTextWidth, truncateToWidth } from "./TreemapView";
import type { DirectorySize } from "../useSystemData";

vi.mock("../SystemUi", () => ({
  PanelCard: ({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {action}
      {children}
    </section>
  ),
}));

const directories: DirectorySize[] = [
  { path: "C:\\Users\\Mona\\Documents", sizeGb: 12, fileCount: 100, children: [{ path: "C:\\Users\\Mona\\Documents\\sub", sizeGb: 5, fileCount: 10 }] },
  { path: "C:\\Users\\Mona\\Pictures", sizeGb: 6, fileCount: 50 },
];

function renderTreemap(currentTotalGb?: number, onDrillDown = vi.fn()) {
  render(
    <TreemapView
      directories={directories}
      currentTotalGb={currentTotalGb}
      breadcrumb={[{ path: "C:\\Users\\Mona", name: "Mona" }]}
      loading={false}
      error={null}
      onDrillDown={onDrillDown}
      onNavigate={() => {}}
    />,
  );
  return onDrillDown;
}

describe("TreemapView", () => {
  it("estimates CJK characters wider than latin ones", () => {
    // 中文按 1.0em、拉丁按 0.55em 估算
    expect(estimateTextWidth("文档", 12)).toBeCloseTo(24);
    expect(estimateTextWidth("ab", 12)).toBeCloseTo(13.2);
  });

  it("truncates by measured width instead of character count", () => {
    // 8 个拉丁字符(52.8px) 应完整保留；3 个中文(36px) 超过 30px 才截断
    expect(truncateToWidth("abcdefgh", 60, 12)).toBe("abcdefgh");
    expect(truncateToWidth("用户文档夹", 30, 12)).toBe("用…");
  });

  it("appends a non-clickable other tile so the tiles sum matches the parent total", () => {
    const onDrillDown = renderTreemap(30);

    const otherLabel = screen.getByText("其他（未展开）");
    // 30 - (12 + 6) = 12 GB 未展开空间（与 Documents 的 12 GB 并列，共两处）
    expect(screen.getAllByText("12.0 GB").length).toBe(2);

    fireEvent.click(otherLabel);
    expect(onDrillDown).not.toHaveBeenCalled();
  });

  it("omits the other tile when the children already cover the parent total", () => {
    renderTreemap(18);

    expect(screen.queryByText("其他（未展开）")).toBeNull();
  });

  it("uses the theme background token for tile strokes", () => {
    const { container } = render(
      <TreemapView
        directories={directories}
        currentTotalGb={18}
        breadcrumb={[]}
        loading={false}
        error={null}
        onDrillDown={() => {}}
        onNavigate={() => {}}
      />,
    );

    const strokes = Array.from(container.querySelectorAll("rect")).map((rect) => rect.getAttribute("stroke"));
    expect(strokes.length).toBeGreaterThan(0);
    expect(new Set(strokes)).toEqual(new Set(["hsl(var(--background))"]));
  });
});
