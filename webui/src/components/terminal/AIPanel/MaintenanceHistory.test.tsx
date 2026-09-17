import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MaintenanceHistory } from "./MaintenanceHistory";
import type { MaintenanceTask, MaintenanceTaskDetail } from "../ipc";

const listTasks = vi.hoisted(() => vi.fn());
const getTask = vi.hoisted(() => vi.fn());
const deleteTask = vi.hoisted(() => vi.fn());
const clearTasks = vi.hoisted(() => vi.fn());

vi.mock("../ipc", () => ({
  terminalMaintenanceList: listTasks,
  terminalMaintenanceGet: getTask,
  terminalMaintenanceDelete: deleteTask,
  terminalMaintenanceClear: clearTasks,
}));

// Select（Button + DropdownMenu 组合）的轻量测试替身：渲染为原生 <select>，
// 保留 aria-label 与选项值，筛选逻辑仍由被测组件自身的 onValueChange 驱动。
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    options,
    "aria-label": ariaLabel,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    options: { value: string; label: string }[];
    "aria-label"?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onValueChange?.(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

// Radix ContextMenu 的轻量测试替身：菜单项直接内联渲染，
// 删除确认行为（AlertDialog、API 门控、错误重试）与被测组件自身逻辑保持不变。
vi.mock("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" role="menuitem" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

function makeTask(overrides: Partial<MaintenanceTask>): MaintenanceTask {
  return {
    id: "task-x",
    sessionId: "sess-1",
    configId: "cfg-1",
    targetLabel: "deploy@10.0.0.1:22",
    goal: "修复 nginx 502",
    execMode: "auto",
    status: "succeeded",
    resolution: "",
    diagnosis: "",
    summary: "",
    error: "",
    createdAt: 1_760_000_000_000,
    startedAt: 1_760_000_001_000,
    finishedAt: 1_760_000_061_000,
    ...overrides,
  };
}

const TASKS: MaintenanceTask[] = [
  makeTask({ id: "t1", goal: "修复 nginx 502", status: "succeeded", resolution: "completed_changes" }),
  makeTask({
    id: "t2",
    goal: "清理磁盘",
    status: "failed",
    resolution: "partial",
    configId: "cfg-2",
    targetLabel: "ops@10.0.0.2:22",
    error: "空间不足",
  }),
  makeTask({ id: "t3", goal: "升级内核", status: "cancelled" }),
];

function makeDetail(task: MaintenanceTask): MaintenanceTaskDetail {
  return {
    task,
    steps: [
      {
        id: "s1",
        taskId: task.id,
        ordinal: 1,
        title: "检查 nginx 状态",
        kind: "inspect",
        status: "succeeded",
        commandHash: "h1",
        exitCode: 0,
        durationMs: 500,
        approvedAt: null,
        startedAt: 1,
        finishedAt: 2,
      },
      {
        id: "s2",
        taskId: task.id,
        ordinal: 2,
        title: "验证 80 端口",
        kind: "verify",
        status: "succeeded",
        commandHash: "h2",
        exitCode: 0,
        durationMs: 300,
        approvedAt: null,
        startedAt: 3,
        finishedAt: 4,
      },
    ],
  };
}

describe("MaintenanceHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listTasks.mockResolvedValue(TASKS);
    clearTasks.mockResolvedValue(3);
    getTask.mockImplementation((id: string) =>
      Promise.resolve(makeDetail(TASKS.find((t) => t.id === id)!)),
    );
  });

  it("lists records with server, result and duration", async () => {
    render(<MaintenanceHistory />);

    expect(await screen.findByText("修复 nginx 502")).toBeTruthy();
    expect(screen.getByText("清理磁盘")).toBeTruthy();
    expect(screen.getAllByText("deploy@10.0.0.1:22").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1m0s").length).toBeGreaterThan(0);
  });

  it("shows resolution labels instead of generic status for finished tasks", async () => {
    render(<MaintenanceHistory />);

    expect(await screen.findByText("修复 nginx 502")).toBeTruthy();
    // t1: succeeded + completed_changes → "完成变更"
    expect(screen.getByText("完成变更")).toBeTruthy();
    // t2: failed + partial → "部分完成"
    expect(screen.getByText("部分完成")).toBeTruthy();
    // t3: cancelled, no resolution → "已取消" (also appears in filter dropdown)
    expect(screen.getAllByText("已取消").length).toBeGreaterThan(0);
  });

  it("filters records by status", async () => {
    render(<MaintenanceHistory />);
    await screen.findByText("修复 nginx 502");

    fireEvent.change(screen.getByLabelText("按结果筛选"), { target: { value: "failed" } });

    expect(screen.queryByText("修复 nginx 502")).toBeNull();
    expect(screen.getByText("清理磁盘")).toBeTruthy();
    expect(screen.queryByText("升级内核")).toBeNull();
  });

  it("filters records by server", async () => {
    render(<MaintenanceHistory />);
    await screen.findByText("修复 nginx 502");

    fireEvent.change(screen.getByLabelText("按服务器筛选"), { target: { value: "cfg-2" } });

    expect(screen.queryByText("修复 nginx 502")).toBeNull();
    expect(screen.getByText("清理磁盘")).toBeTruthy();
  });

  it("opens the detail view with steps and returns to the list", async () => {
    render(<MaintenanceHistory />);
    fireEvent.click(await screen.findByText("修复 nginx 502"));

    await waitFor(() => expect(getTask).toHaveBeenCalledWith("t1"));
    expect(await screen.findByText("维护目标")).toBeTruthy();
    expect(screen.getByText("执行步骤")).toBeTruthy();
    expect(screen.getByText("最终复检")).toBeTruthy();
    expect(screen.getAllByText("验证 80 端口").length).toBe(2);

    fireEvent.click(screen.getByText("返回列表"));
    expect(await screen.findByText("清理磁盘")).toBeTruthy();
  });

  it("deletes a record via context menu after confirmation", async () => {
    deleteTask.mockResolvedValue(undefined);
    render(<MaintenanceHistory />);
    await screen.findByText("修复 nginx 502");

    // 右键菜单项只打开确认框，不直接调用删除 API
    fireEvent.click(screen.getAllByRole("menuitem", { name: /删除记录/ })[0]);
    await screen.findByText("删除这条维护记录？");
    expect(deleteTask).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByText("修复 nginx 502")).toBeNull());
    expect(deleteTask).toHaveBeenCalledTimes(1);
    expect(deleteTask).toHaveBeenCalledWith("t1");
    // 其他记录不受影响
    expect(screen.getByText("清理磁盘")).toBeTruthy();
  });

  it("keeps the record and shows the error when deletion fails", async () => {
    deleteTask.mockRejectedValueOnce(new Error("任务仍在进行中，请先取消或等待结束"));
    render(<MaintenanceHistory />);
    await screen.findByText("修复 nginx 502");

    fireEvent.click(screen.getAllByRole("menuitem", { name: /删除记录/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));

    await screen.findByText(/删除失败：.*任务仍在进行中/);
    expect(screen.getByText("修复 nginx 502")).toBeTruthy();

    // 取消后确认框关闭，列表保持原样
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("删除这条维护记录？")).toBeNull());
    expect(screen.getByText("修复 nginx 502")).toBeTruthy();
  });

  it("clears every finished record from the context menu after confirmation", async () => {
    render(<MaintenanceHistory />);
    await screen.findByText("修复 nginx 502");

    // 右键菜单项只打开确认框，不直接调用清除 API
    fireEvent.click(screen.getAllByRole("menuitem", { name: /清除全部/ })[0]);
    await screen.findByText("清除全部维护记录？");
    expect(clearTasks).not.toHaveBeenCalled();
    // 确认框说明清除范围，并给出真实条数
    expect(screen.getByText(/全部 3 条已结束的维护记录/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "清除全部" }));

    await waitFor(() => expect(screen.queryByText("修复 nginx 502")).toBeNull());
    expect(clearTasks).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("清理磁盘")).toBeNull();
    expect(screen.queryByText("升级内核")).toBeNull();
    expect(screen.getByText("暂无维护记录")).toBeTruthy();
  });

  it("keeps running tasks listed after clearing and disables the entry when none finished", async () => {
    const running = makeTask({ id: "t4", goal: "部署新版本", status: "running" });
    listTasks.mockResolvedValue([...TASKS, running]);
    render(<MaintenanceHistory />);
    await screen.findByText("部署新版本");

    fireEvent.click(screen.getAllByRole("menuitem", { name: /清除全部/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "清除全部" }));

    // 进行中的任务不被清除
    await waitFor(() => expect(screen.queryByText("修复 nginx 502")).toBeNull());
    expect(screen.getByText("部署新版本")).toBeTruthy();
    // 只剩进行中的任务时入口失效
    expect(screen.getAllByRole("menuitem", { name: /清除全部/ })[0]).toBeDisabled();
  });

  it("keeps the list and shows the error when clearing fails", async () => {
    clearTasks.mockRejectedValueOnce(new Error("database is locked"));
    render(<MaintenanceHistory />);
    await screen.findByText("修复 nginx 502");

    fireEvent.click(screen.getAllByRole("menuitem", { name: /清除全部/ })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "清除全部" }));

    await screen.findByText(/清除失败：.*database is locked/);
    expect(screen.getByText("修复 nginx 502")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByText("清除全部维护记录？")).toBeNull());
    expect(screen.getByText("修复 nginx 502")).toBeTruthy();
  });
});
