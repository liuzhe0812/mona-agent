import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StockVibeInfo } from "./StockVibeInfo";

afterEach(() => {
  act(() => { vi.runOnlyPendingTimers(); });
  vi.useRealTimers();
});

it("opens details in a dismissible floating window and keeps nested information separate", () => {
  vi.useFakeTimers();
  render(<StockVibeInfo title="数据范围" label="查看数据范围"><p>本次实际资料范围</p><StockVibeInfo title="原始来源"><p>来源记录</p></StockVibeInfo></StockVibeInfo>);
  expect(screen.queryByText("本次实际资料范围")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看数据范围" }));
  act(() => { vi.runOnlyPendingTimers(); });
  const parent = screen.getByRole("dialog", { name: "数据范围" });
  expect(within(parent).getByText("本次实际资料范围")).toBeVisible();
  fireEvent.click(within(parent).getByRole("button", { name: "原始来源" }));
  act(() => { vi.runOnlyPendingTimers(); });
  const child = screen.getByRole("dialog", { name: "原始来源" });
  expect(within(child).getByText("来源记录")).toBeVisible();
  fireEvent.click(within(child).getByRole("button", { name: "关闭信息" }));
  act(() => { vi.runOnlyPendingTimers(); });
  expect(screen.getByRole("dialog", { name: "数据范围" })).toBeVisible();
  fireEvent.keyDown(parent, { key: "Escape" });
  act(() => { vi.runOnlyPendingTimers(); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看数据范围" })).toBeVisible();
});
