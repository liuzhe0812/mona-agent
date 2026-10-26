import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { StockVibeAnalysisRecord, StockVibeResearchTask } from "@/lib/stock-vibe-api";

const api = vi.hoisted(() => ({ history: vi.fn(), attempt: vi.fn() }));
vi.mock("@/lib/stock-vibe-api", () => ({
  getStockVibeAnalysisHistory: api.history,
  getStockVibeAttempt: api.attempt,
}));

import { StockVibeAnalysisHistory } from "./StockVibeAnalysisHistory";

type Query = {
  q: string;
  task: StockVibeResearchTask | "all";
  state: "all" | "completed" | "active" | "unfinished";
  offset: number;
  limit: number;
};

function record(overrides: Partial<StockVibeAnalysisRecord> = {}): StockVibeAnalysisRecord {
  return {
    session_id: "session-1",
    attempt_id: "attempt-1",
    title: "历史分析标题",
    task: "comprehensive",
    mode: "swing",
    status: "completed",
    created_at: "2026-10-18T08:00:00Z",
    completed_at: "2026-10-18T08:10:00Z",
    ...overrides,
  };
}

function page(symbol: string, offset: number, total = 1, items = [record()]) {
  return { native: { symbol, offset, limit: 10, total, items } };
}

function Harness({
  symbol = "600519.SH",
  initialOpen = false,
  onContinue = vi.fn(),
}: {
  symbol?: string;
  initialOpen?: boolean;
  onContinue?: (item: StockVibeAnalysisRecord) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  return <>
    <button onClick={() => setOpen(true)}>打开分析记录</button>
    <StockVibeAnalysisHistory key={symbol} symbol={symbol} name="示例股票" open={open} onOpenChange={setOpen} onContinue={onContinue} />
  </>;
}

async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole("button", { name: label }));
  await user.click(screen.getByRole("menuitem", { name: option }));
}

async function settleInitialSearchTimer() {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 275)); });
}

beforeEach(() => {
  api.history.mockReset().mockImplementation(async (symbol: string, query: Query) => page(symbol, query.offset));
  api.attempt.mockReset();
});

afterEach(() => vi.useRealTimers());

it("does not query while closed and opens the current stock's first ten records", async () => {
  const user = userEvent.setup();
  render(<Harness />);

  expect(api.history).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "打开分析记录" }));
  expect(await screen.findByText("历史分析标题")).toBeVisible();
  expect(api.history).toHaveBeenCalledTimes(1);
  expect(api.history).toHaveBeenLastCalledWith("600519.SH", {
    q: "", task: "all", state: "all", offset: 0, limit: 10,
  });
});

it("requests the next server page and resets pagination when type or status changes", async () => {
  api.history.mockImplementation(async (symbol: string, query: Query) => {
    const task = query.task === "all" ? "comprehensive" : query.task;
    const status = query.state === "completed" ? "completed" : "running";
    const title = `${query.task}/${query.state}/${query.offset}`;
    return page(symbol, query.offset, 101, [record({ title, task, status, attempt_id: status === "completed" ? "attempt-filtered" : null })]);
  });
  const user = userEvent.setup();
  render(<Harness initialOpen />);
  expect(await screen.findByText("all/all/0")).toBeVisible();
  await settleInitialSearchTimer();

  await user.click(screen.getByRole("button", { name: "下一页分析记录" }));
  expect(await screen.findByText("all/all/10")).toBeVisible();
  expect(api.history).toHaveBeenLastCalledWith("600519.SH", {
    q: "", task: "all", state: "all", offset: 10, limit: 10,
  });

  await choose(user, "分析类型", "走势分析");
  expect(await screen.findByText("technical/all/0")).toBeVisible();
  expect(api.history).toHaveBeenLastCalledWith("600519.SH", {
    q: "", task: "technical", state: "all", offset: 0, limit: 10,
  });

  await user.click(screen.getByRole("button", { name: "下一页分析记录" }));
  expect(await screen.findByText("technical/all/10")).toBeVisible();
  await choose(user, "分析状态", "进行中");
  expect(await screen.findByText("technical/active/0")).toBeVisible();
  expect(api.history).toHaveBeenLastCalledWith("600519.SH", {
    q: "", task: "technical", state: "active", offset: 0, limit: 10,
  });
});

it("debounces title search for 250ms and returns to the first page", async () => {
  api.history.mockImplementation(async (symbol: string, query: Query) => page(symbol, query.offset, 105, [record({ title: query.q || "未筛选标题" })]));
  const user = userEvent.setup();
  render(<Harness initialOpen />);
  expect(await screen.findByText("未筛选标题")).toBeVisible();
  await settleInitialSearchTimer();
  await user.click(screen.getByRole("button", { name: "下一页分析记录" }));
  expect(await screen.findByText("未筛选标题")).toBeVisible();
  expect(api.history).toHaveBeenCalledTimes(2);
  expect(api.history).toHaveBeenLastCalledWith("600519.SH", {
    q: "", task: "all", state: "all", offset: 10, limit: 10,
  });
  vi.useFakeTimers();
  fireEvent.change(screen.getByRole("textbox", { name: "搜索分析标题" }), { target: { value: "财报" } });
  expect(api.history).toHaveBeenCalledTimes(2);

  act(() => vi.advanceTimersByTime(249));
  expect(api.history).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(api.history).toHaveBeenCalledTimes(3);
  expect(api.history).toHaveBeenLastCalledWith("600519.SH", {
    q: "财报", task: "all", state: "all", offset: 0, limit: 10,
  });
  expect(screen.getByText("1 / 11")).toBeVisible();
});

it("opens a completed record through the shared details entry with its original ids and period", async () => {
  const completed = record({ session_id: "saved-session", attempt_id: "saved-attempt", title: "已保存的走势分析", task: "technical", mode: "medium" });
  api.history.mockResolvedValue(page("600519.SH", 0, 1, [completed]));
  const onContinue = vi.fn();
  const user = userEvent.setup();
  render(<Harness initialOpen onContinue={onContinue} />);
  expect(await screen.findByText("已保存的走势分析")).toBeVisible();
  expect(onContinue).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "查看报告" }));
  expect(onContinue).toHaveBeenCalledOnce();
  expect(onContinue).toHaveBeenCalledWith(completed);
  expect(api.attempt).not.toHaveBeenCalled();
});

it("continues an unfinished record from its original session without loading a completed report", async () => {
  const running = record({ session_id: "running-session", attempt_id: "running-attempt", status: "running", completed_at: null });
  api.history.mockResolvedValue(page("600519.SH", 0, 1, [running]));
  const onContinue = vi.fn();
  const user = userEvent.setup();
  render(<Harness initialOpen onContinue={onContinue} />);

  await user.click(await screen.findByRole("button", { name: "查看进度" }));
  expect(onContinue).toHaveBeenCalledWith(running);
  expect(api.attempt).not.toHaveBeenCalled();
});

it("retries a failed query after switching stocks without showing the previous stock's report", async () => {
  const oldRecord = record({ session_id: "old-session", attempt_id: "old-attempt", title: "旧股票报告" });
  api.history
    .mockResolvedValueOnce(page("600519.SH", 0, 1, [oldRecord]))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(page("000001.SZ", 0, 1, [record({ title: "当前股票报告", session_id: "current-session", attempt_id: "current-attempt" })]));
  api.attempt.mockResolvedValue({
    native: { session_id: "old-session", attempt_id: "old-attempt", status: "completed", summary: "旧股票报告正文", error: null, created_at: oldRecord.created_at, completed_at: oldRecord.completed_at },
  });
  const user = userEvent.setup();
  const view = render(<Harness initialOpen />);
  expect(await screen.findByText("旧股票报告")).toBeVisible();

  view.rerender(<Harness symbol="000001.SZ" initialOpen />);
  expect(await screen.findByText("暂时无法读取分析记录。")).toBeVisible();
  expect(screen.queryByText("旧股票报告")).not.toBeInTheDocument();
  expect(screen.queryByText("旧股票报告正文")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "重新读取" }));
  expect(await screen.findByText("当前股票报告")).toBeVisible();
  expect(screen.queryByText("旧股票报告")).not.toBeInTheDocument();
  expect(api.history).toHaveBeenLastCalledWith("000001.SZ", {
    q: "", task: "all", state: "all", offset: 0, limit: 10,
  });
});
