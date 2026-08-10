import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { MaintenanceTaskCard } from "./MaintenanceTaskCard";
import type { MaintenanceTaskDetail } from "../ipc";

const authorize = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const cancel = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../ipc", () => ({
  terminalMaintenanceAuthorize: authorize,
  terminalMaintenanceCancel: cancel,
}));

function makeStep(overrides: Partial<MaintenanceTaskDetail["steps"][number]> = {}): MaintenanceTaskDetail["steps"][number] {
  return {
    id: "s1",
    taskId: "task-1",
    ordinal: 1,
    title: "检查 nginx 状态",
    kind: "inspect",
    status: "succeeded",
    commandHash: "h1",
    exitCode: 0,
    durationMs: 820,
    approvedAt: null,
    startedAt: 1_760_000_001_000,
    finishedAt: 1_760_000_001_820,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<MaintenanceTaskDetail["task"]> = {}, steps?: MaintenanceTaskDetail["steps"]): MaintenanceTaskDetail {
  return {
    task: {
      id: "task-1",
      sessionId: "sess-1",
      configId: "cfg-1",
      targetLabel: "deploy@10.0.0.1:22",
      goal: "修复 nginx 502",
      execMode: "approval",
      status: "running",
      resolution: "",
      diagnosis: "",
      summary: "",
      error: "",
      createdAt: 1_760_000_000_000,
      startedAt: 1_760_000_001_000,
      finishedAt: null,
      ...overrides,
    },
    steps: steps ?? [
      makeStep({ id: "s1", kind: "inspect", status: "succeeded", title: "检查 nginx 状态" }),
      makeStep({ id: "s2", kind: "change", status: "running", title: "重启 nginx", ordinal: 2 }),
      makeStep({ id: "s3", kind: "verify", status: "pending", title: "验证 80 端口", ordinal: 3, commandHash: "", exitCode: null, durationMs: null, startedAt: null, finishedAt: null }),
    ],
  };
}

describe("MaintenanceTaskCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows goal, three stable phase labels, and status badge", () => {
    render(<MaintenanceTaskCard detail={makeDetail()} />);

    expect(screen.getByText("修复 nginx 502")).toBeTruthy();
    expect(screen.getByText("执行中")).toBeTruthy();
    // Three stable phase labels always visible
    expect(screen.getByText("检查现状")).toBeTruthy();
    expect(screen.getByText("执行必要变更")).toBeTruthy();
    expect(screen.getByText("最终验证")).toBeTruthy();
  });

  it("shows per-phase summary text reflecting step outcomes", () => {
    render(<MaintenanceTaskCard detail={makeDetail()} />);

    // Inspect phase: 1/1 succeeded
    expect(screen.getByText("1/1 项通过")).toBeTruthy();
    // Change phase: running
    expect(screen.getByText("正在执行…")).toBeTruthy();
    // Verify phase: pending
    expect(screen.getByText("等待执行")).toBeTruthy();
  });

  it("shows empty phase summary when a phase has no steps", () => {
    const detail = makeDetail(
      { status: "succeeded", resolution: "no_changes_needed", summary: "环境已符合目标" },
      [
        makeStep({ id: "s1", kind: "inspect", status: "succeeded", title: "检查 nginx" }),
        makeStep({ id: "s2", kind: "verify", status: "succeeded", title: "验证 80 端口", ordinal: 2 }),
      ],
    );
    render(<MaintenanceTaskCard detail={detail} />);

    // Change phase has no steps → "无需执行"
    expect(screen.getByText("当前环境已满足要求，无需执行")).toBeTruthy();
    // Resolution label shown instead of status
    expect(screen.getByText("已符合目标，无需变更")).toBeTruthy();
  });

  it("shows resolution label for completed_changes", () => {
    const detail = makeDetail(
      { status: "succeeded", resolution: "completed_changes", summary: "nginx 已恢复" },
      [
        makeStep({ id: "s1", kind: "inspect", status: "succeeded", title: "检查 nginx" }),
        makeStep({ id: "s2", kind: "change", status: "succeeded", title: "重启 nginx", ordinal: 2 }),
        makeStep({ id: "s3", kind: "verify", status: "succeeded", title: "验证端口", ordinal: 3 }),
      ],
    );
    render(<MaintenanceTaskCard detail={detail} />);

    expect(screen.getByText("完成变更")).toBeTruthy();
    expect(screen.getByText("nginx 已恢复")).toBeTruthy();
  });

  it("shows resolution label for partial failure", () => {
    const detail = makeDetail(
      { status: "failed", resolution: "partial", error: "复检未通过" },
      [
        makeStep({ id: "s1", kind: "inspect", status: "succeeded", title: "检查 nginx" }),
        makeStep({ id: "s2", kind: "change", status: "succeeded", title: "重启 nginx", ordinal: 2 }),
        makeStep({ id: "s3", kind: "verify", status: "failed", title: "验证端口", ordinal: 3, exitCode: 1 }),
      ],
    );
    render(<MaintenanceTaskCard detail={detail} />);

    expect(screen.getByText("部分完成")).toBeTruthy();
    expect(screen.getByText("复检未通过")).toBeTruthy();
  });

  it("hides individual step titles by default, reveals them on expand", () => {
    render(<MaintenanceTaskCard detail={makeDetail()} />);

    // Step titles are in the collapsed details section
    expect(screen.queryByText("检查 nginx 状态")).toBeNull();
    expect(screen.queryByText("重启 nginx")).toBeNull();

    // Expand details
    const expandBtn = screen.getByText(/查看执行详情/);
    act(() => {
      fireEvent.click(expandBtn);
    });

    // Now step titles are visible
    expect(screen.getByText("检查 nginx 状态")).toBeTruthy();
    expect(screen.getByText("重启 nginx")).toBeTruthy();
  });

  it("shows accurate success/total counts in the details toggle", () => {
    // 1 succeeded, 1 running, 1 pending → 1/3 成功
    render(<MaintenanceTaskCard detail={makeDetail()} />);
    expect(screen.getByText(/1\/3 成功，共 3 步/)).toBeTruthy();
  });

  it("excludes skipped and cancelled from executable count", () => {
    const detail = makeDetail(
      { status: "succeeded", resolution: "completed_changes" },
      [
        makeStep({ id: "s1", kind: "inspect", status: "succeeded", title: "检查" }),
        makeStep({ id: "s2", kind: "change", status: "skipped", title: "变更A", ordinal: 2 }),
        makeStep({ id: "s3", kind: "change", status: "succeeded", title: "变更B", ordinal: 3 }),
        makeStep({ id: "s4", kind: "verify", status: "succeeded", title: "复检", ordinal: 4 }),
      ],
    );
    render(<MaintenanceTaskCard detail={detail} />);

    // 3 succeeded, 1 skipped excluded from executable → 3/3 成功，共 4 步
    expect(screen.getByText(/3\/3 成功，共 4 步/)).toBeTruthy();
  });

  it("does not mark a phase as failed while steps are still pending", () => {
    // 截图场景：3 失败 + 1 pending，任务仍在执行，阶段应显示进行中而非失败
    const detail = makeDetail(
      { status: "running" },
      [
        makeStep({ id: "s1", kind: "inspect", status: "failed", title: "定位日志", exitCode: 1 }),
        makeStep({ id: "s2", kind: "inspect", status: "pending", title: "查看日志", ordinal: 2, commandHash: "", exitCode: null, durationMs: null, startedAt: null, finishedAt: null }),
        makeStep({ id: "s3", kind: "inspect", status: "failed", title: "读取 error.log", ordinal: 3, exitCode: 1 }),
        makeStep({ id: "s4", kind: "inspect", status: "failed", title: "读取 mona_error.log", ordinal: 4, exitCode: 1 }),
      ],
    );
    render(<MaintenanceTaskCard detail={detail} />);

    // 阶段进行中，不显示"存在失败"的定性结论
    expect(screen.getByText("进行中 · 0/4 通过，3 项失败")).toBeTruthy();
    expect(screen.queryByText(/存在失败/)).toBeNull();
    // 进行中的任务，空阶段显示"待定"而非"无需执行"
    expect(screen.getAllByText("待定，等待 AI 判断是否需要").length).toBe(2);
  });

  it("shows 未执行 for empty phases when the task has failed", () => {
    const detail = makeDetail(
      { status: "failed", resolution: "failed", error: "检查阶段全部失败" },
      [
        makeStep({ id: "s1", kind: "inspect", status: "failed", title: "定位日志", exitCode: 1 }),
      ],
    );
    render(<MaintenanceTaskCard detail={detail} />);

    expect(screen.getAllByText("未执行").length).toBe(2);
  });

  it("shows the plan approval button only while waiting for approval", () => {
    const { unmount } = render(
      <MaintenanceTaskCard detail={makeDetail({ status: "waiting_approval" })} />,
    );
    expect(screen.getByText(/批准变更计划/)).toBeTruthy();
    unmount();

    render(<MaintenanceTaskCard detail={makeDetail({ status: "running", execMode: "auto" })} />);
    expect(screen.queryByText(/批准变更计划/)).toBeNull();
  });

  it("authorizes pending change/verify steps when approving the plan", async () => {
    render(<MaintenanceTaskCard detail={makeDetail({ status: "waiting_approval" })} />);
    fireEvent.click(screen.getByText(/批准变更计划/));

    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    // s3 (verify, pending, no approval) is the only pending non-inspect step
    expect(authorize).toHaveBeenCalledWith("task-1", ["s3"]);
  });

  it("calls the cancel command from the stop button", async () => {
    render(<MaintenanceTaskCard detail={makeDetail()} />);
    fireEvent.click(screen.getByText("停止维护"));

    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel).toHaveBeenCalledWith("task-1");
  });

  it("hides the stop button once finished", () => {
    render(
      <MaintenanceTaskCard
        detail={makeDetail({ status: "succeeded", resolution: "completed_changes", summary: "nginx 已恢复" })}
      />,
    );
    expect(screen.queryByText("停止维护")).toBeNull();
  });

  it("shows the failure reason for failed tasks", () => {
    render(
      <MaintenanceTaskCard
        detail={makeDetail({ status: "failed", resolution: "failed", error: "复检未通过：端口仍不可达" })}
      />,
    );
    expect(screen.getByText("复检未通过：端口仍不可达")).toBeTruthy();
  });
});
