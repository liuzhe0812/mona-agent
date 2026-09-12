import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AIPanel } from "./AIPanel";
import { useTerminalStore } from "../store/terminalStore";
import type { MaintenanceTaskDetail } from "../ipc";

const getActive = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../ipc", () => ({
  terminalMaintenanceGetActive: getActive,
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onTerminalSessionStatus: vi.fn().mockResolvedValue(() => {}),
  onTerminalMaintenanceUpdated: vi.fn().mockResolvedValue(() => {}),
  terminalSaveConnections: vi.fn(),
  terminalLoadConnections: vi.fn().mockResolvedValue([]),
}));

vi.mock("./AIChat", () => ({
  AIChat: () => <div data-testid="ai-chat" />,
}));

vi.mock("./MaintenanceHistory", () => ({
  MaintenanceHistory: () => <div data-testid="maintenance-history" />,
}));

function makeActiveDetail(): MaintenanceTaskDetail {
  return {
    task: {
      id: "task-1",
      sessionId: "sess-1",
      configId: "cfg-1",
      targetLabel: "deploy@10.0.0.1:22",
      goal: "修复 nginx 502",
      execMode: "auto",
      status: "running",
      resolution: "",
      diagnosis: "",
      summary: "",
      error: "",
      createdAt: 1_760_000_000_000,
      startedAt: 1_760_000_001_000,
      finishedAt: null,
    },
    steps: [
      {
        id: "s1",
        taskId: "task-1",
        ordinal: 1,
        title: "检查 nginx 状态",
        kind: "inspect",
        status: "running",
        commandHash: "h1",
        exitCode: null,
        durationMs: null,
        approvedAt: null,
        startedAt: 1,
        finishedAt: null,
      },
    ],
  };
}

describe("AIPanel", () => {
  beforeEach(() => {
    getActive.mockResolvedValue(null);
    useTerminalStore.setState({ activeMaintenanceTasks: {} });
  });

  it("renders the two tabs and no quick action entries", () => {
    render(<AIPanel sessionId="sess-1" />);

    expect(screen.getByText("当前任务")).toBeTruthy();
    expect(screen.getByText("维护记录")).toBeTruthy();
    for (const label of ["健康巡检", "故障诊断", "性能分析", "日志分析", "部署验证", "安全巡检"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("shows the task card only when the session has an active task", async () => {
    const first = await act(async () => render(<AIPanel sessionId="sess-1" />));
    expect(screen.queryByText("修复 nginx 502")).toBeNull();
    first.unmount();

    const detail = makeActiveDetail();
    // The panel refreshes the active task on mount; resolve the same object
    // so the store sees no change and the card stays.
    getActive.mockResolvedValue(detail);
    act(() => {
      useTerminalStore.setState({
        activeMaintenanceTasks: { "sess-1": detail },
      });
    });
    await act(async () => render(<AIPanel sessionId="sess-1" />));
    expect(screen.getByText("修复 nginx 502")).toBeTruthy();
  });

  it("switches to the history tab", () => {
    render(<AIPanel sessionId="sess-1" />);
    expect(screen.getByTestId("ai-chat")).toBeTruthy();

    fireEvent.click(screen.getByText("维护记录"));
    expect(screen.getByTestId("maintenance-history")).toBeTruthy();
    expect(screen.queryByTestId("ai-chat")).toBeNull();
  });
});
