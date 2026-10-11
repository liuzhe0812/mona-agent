import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DevCollaboration, DevSession, RunStatus } from "@/lib/development-api";
import { DevelopmentCollaboration } from "./DevelopmentCollaboration";
import { DevelopmentSubagentTasks } from "./DevelopmentSubagentTasks";

const api = vi.hoisted(() => ({ collaborations: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/development-api", async (original) => ({ ...(await original<typeof import("@/lib/development-api")>()), developmentApi: api }));
const session: DevSession = { id: "parent", projectId: "project", title: "开发任务", executor: "mona", model: null,
  readonly: false, parentSessionId: null, pinned: false, archived: false, revision: 0, updatedAt: "" };
function task(id: string, status: RunStatus, date: string): DevCollaboration {
  return { id, parentSessionId: session.id, childSessionId: `child_${id}`, requestId: `request_${id}`, title: id, createdAt: date,
    executor: "mona", goal: `goal_${id}`, expectedOutput: "", readonly: false, state: "submitted", returnMessageId: null, sourceDiffSha: null,
    latestRun: { id: `run_${id}`, sessionId: `child_${id}`, executor: "mona", status, revision: 1, createdAt: date, finishedAt: status === "running" ? null : date } };
}
beforeEach(() => { vi.resetAllMocks(); api.collaborations.mockResolvedValue([]); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("shows recent completed tasks and a configuration icon without a manual dispatch entry", async () => {
  api.collaborations.mockResolvedValue([
    task("old", "succeeded", "2026-09-01"), task("new", "succeeded", "2026-10-01"), task("active", "running", "2026-10-01"), task("failed", "failed", "2026-10-01"),
  ]);
  const configure = vi.fn(), open = vi.fn();
  render(<DevelopmentCollaboration session={session} visible onConfigure={configure} onOpenTasks={open} />);
  expect(await screen.findByText("1 个运行中")).toBeVisible();
  expect(screen.getByText("2 完成 · 1 未完成")).toBeVisible();
  const summary = screen.getByRole("button", { name: "查看子智能体任务" });
  expect(within(summary).getAllByRole("img").map((item) => item.getAttribute("aria-label"))).toEqual(["active"]);
  const config = screen.getByRole("button", { name: "子智能体配置" });
  expect(config.textContent).toBe(""); fireEvent.click(config); expect(configure).toHaveBeenCalledOnce();
  fireEvent.click(summary); expect(open).toHaveBeenCalledOnce();
  expect(screen.queryByText(/调用|派发任务/)).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull();
  expect(api.send).not.toHaveBeenCalled();
});

it("groups real tasks, sorts completed tasks newest first and opens the selected task", async () => {
  api.collaborations.mockResolvedValue([task("old", "succeeded", "2026-09-01"), task("failed", "failed", "2026-10-01"), task("new", "succeeded", "2026-10-01"), task("pending", "unknown", "2026-10-01")]);
  const select = vi.fn();
  render(<DevelopmentSubagentTasks session={session} visible onSelect={select} />);
  const completed = await screen.findByRole("region", { name: "完成的子任务" });
  expect(within(completed).getAllByRole("button").map((item) => item.getAttribute("aria-label"))).toEqual(["new", "old"]);
  expect(within(screen.getByRole("region", { name: "未完成的子任务" })).getByRole("button", { name: "failed" })).toBeVisible();
  expect(within(screen.getByRole("region", { name: "已开启的子任务" })).getByRole("button", { name: "pending" })).toBeVisible();
  expect(screen.queryByText("状态待核对")).toBeNull();
  fireEvent.click(within(completed).getByRole("button", { name: "new" }));
  expect(select).toHaveBeenCalledWith("child_new"); expect(api.send).not.toHaveBeenCalled();
});

it("keeps task rows to names and times, then expands the remaining completed tasks", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-10-08T00:00:00Z");
  vi.setSystemTime(now);
  const active = task("active", "running", "2026-10-07T23:45:00Z");
  active.latestRun!.startedAt = "2026-10-07T23:52:23Z";
  active.progress = "正在核对子智能体列表";
  const completed = Array.from({ length: 13 }, (_, index) => task(`done_${index}`, "succeeded", new Date(now - 7 * 86400000 - index * 3600000).toISOString()));
  api.collaborations.mockResolvedValue([active, ...completed]);
  const select = vi.fn();
  await act(async () => { render(<DevelopmentSubagentTasks session={session} visible onSelect={select} />); });
  const activeRow = screen.getByRole("button", { name: "active", exact: true });
  expect(within(activeRow).queryByText("正在核对子智能体列表")).toBeNull();
  expect(within(activeRow).getByText("7m 37s")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(within(activeRow).getByText("7m 38s")).toBeVisible();
  expect(within(screen.getByRole("button", { name: "done_0", exact: true })).getByText("1 周前")).toBeVisible();
  expect(screen.queryByRole("button", { name: "done_12", exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "再显示 3 个" }));
  fireEvent.click(screen.getByRole("button", { name: "done_12", exact: true }));
  expect(select).toHaveBeenCalledWith("child_done_12");
  expect(screen.queryByRole("button", { name: /再显示/ })).toBeNull();
  expect(api.send).not.toHaveBeenCalled();
});

it("shows recently completed avatars when there are no active tasks", async () => {
  api.collaborations.mockResolvedValue([task("old", "succeeded", "2026-09-01"), task("new", "succeeded", "2026-10-01")]);
  render(<DevelopmentCollaboration session={session} visible onConfigure={vi.fn()} onOpenTasks={vi.fn()} />);
  await screen.findByText("2 完成");
  const summary = screen.getByRole("button", { name: "查看子智能体任务" });
  expect(within(summary).getAllByRole("img").map((item) => item.getAttribute("aria-label"))).toEqual(["new", "old"]);
});

it("ignores a late list response from the previous parent task", async () => {
  let resolve!: (value: DevCollaboration[]) => void;
  api.collaborations.mockReturnValueOnce(new Promise<DevCollaboration[]>((done) => { resolve = done; })).mockResolvedValue([]);
  const view = render(<DevelopmentSubagentTasks session={session} visible onSelect={vi.fn()} />);
  view.rerender(<DevelopmentSubagentTasks session={{ ...session, id: "other" }} visible onSelect={vi.fn()} />);
  await screen.findByText("暂无已完成任务");
  await act(async () => resolve([task("old_parent", "succeeded", "2026-10-01")]));
  expect(screen.queryByRole("button", { name: "old_parent" })).toBeNull();
});

it("reports failed reads in a dialog without claiming that no tasks exist", async () => {
  api.collaborations.mockRejectedValue(new Error("service failure"));
  render(<DevelopmentSubagentTasks session={session} visible onSelect={vi.fn()} />);
  expect(await screen.findByRole("dialog", { name: "子任务读取失败" })).toHaveTextContent("无法读取子任务");
  expect(screen.queryByText("暂无已完成任务")).toBeNull();
});
