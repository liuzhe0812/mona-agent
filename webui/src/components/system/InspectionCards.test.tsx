import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { InspectionCards } from "./InspectionCards";
import type { InspectionCard } from "./inspectionModel";

function card(overrides: Partial<InspectionCard> = {}): InspectionCard {
  return {
    id: "storage",
    tone: "info",
    priority: 80,
    title: "可清理空间",
    detail: "2 类缓存/临时文件可安全清理",
    metric: "3.0 GB",
    goal: "释放磁盘可清理空间",
    actionLabel: "一键清理",
    tab: "storage",
    ...overrides,
  };
}

describe("InspectionCards", () => {
  it("renders skeleton placeholders while pending with no cards", () => {
    render(<InspectionCards cards={[]} pending onAction={vi.fn()} />);

    expect(screen.getByLabelText("巡检数据加载中")).toBeTruthy();
  });

  it("renders the healthy empty state when nothing needs attention", () => {
    render(<InspectionCards cards={[]} pending={false} onAction={vi.fn()} />);

    expect(screen.getByText("系统状态良好，暂无需要处理的事项。")).toBeTruthy();
  });

  it("renders cards with metrics and fires onAction with the card", () => {
    const onAction = vi.fn();
    render(<InspectionCards cards={[card()]} pending={false} onAction={onAction} />);

    expect(screen.getByText("巡检发现")).toBeTruthy();
    expect(screen.getByText("可清理空间")).toBeTruthy();
    expect(screen.getByText("3.0 GB")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "一键清理" }));
    expect(onAction).toHaveBeenCalledWith(card());
  });

  it("falls back to the view label for cards without an action goal", () => {
    render(
      <InspectionCards
        cards={[card({ id: "maintenance", goal: null, actionLabel: null, title: "最近维护", metric: "今天" })]}
        pending={false}
        onAction={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "查看" })).toBeTruthy();
  });

  it("disables actions while a plan is running", () => {
    render(<InspectionCards cards={[card()]} pending={false} onAction={vi.fn()} disabled />);

    expect(screen.getByRole("button", { name: "一键清理" })).toHaveProperty("disabled", true);
  });
});
