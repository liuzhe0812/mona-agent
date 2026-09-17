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

  it("shows goal, status badge, and done/total progress", () => {
    render(<MaintenanceTaskCard detail={makeDetail()} />);

    expect(screen.getByText("修复 nginx 502")).toBeTruthy();
    expect(screen.getByText("执行中")).toBeTruthy();
    // s1 succeeded → 1 done of 3 steps
    expect(screen.getByText("1/3")).toBeTruthy();
  });

  it("renders every step row with its title and duration", () => {
    render(<MaintenanceTaskCard detail={makeDetail()} />);

    expect(screen.getByText("检查 nginx 状态")).toBeTruthy();
    expect(screen.getByText("重启 nginx")).toBeTruthy();
    expect(screen.getByText("验证 80 端口")).toBeTruthy();
    // s1 and s2 both carry the default 820ms duration
    expect(screen.getAllByText("820ms").length).toBe(2);
  });

  it("tags verify steps with a 复检 badge", () => {
    render(<MaintenanceTaskCard detail={makeDetail()} />);

    expect(screen.getByText("复检")).toBeTruthy();
  });

  it("shows the summary once the task succeeded", () => {
    const detail = makeDetail(
      { status: "succeeded", resolution: "completed_changes", summary: "nginx 已恢复" },
      [
        makeStep({ id: "s1", kind: "inspect", status: "succeeded", title: "检查 nginx" }),
        makeStep({ id: "s2", kind: "change", status: "succeeded", title: "重启 nginx", ordinal: 2 }),
        makeStep({ id: "s3", kind: "verify", status: "succeeded", title: "验证端口", ordinal: 3 }),
      ],
    );
    render(<MaintenanceTaskCard detail={detail} />);

    expect(screen.getByText("成功")).toBeTruthy();
    expect(screen.getByText("nginx 已恢复")).toBeTruthy();
  });

  it("shows exit codes on failed steps", () => {
    const detail = makeDetail(
      { status: "failed", resolution: "partial", error: "复检未通过" },
      [
        makeStep({ id: "s1", kind: "inspect", status: "succeeded", title: "检查 nginx" }),
        makeStep({ id: "s2", kind: "change", status: "succeeded", title: "重启 nginx", ordinal: 2 }),
        makeStep({ id: "s3", kind: "verify", status: "failed", title: "验证端口", ordinal: 3, exitCode: 1 }),
      ],
    );
    render(<MaintenanceTaskCard detail={detail} />);

    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.getByText("复检未通过")).toBeTruthy();
  });

  it("counts skipped steps as done in the progress count", () => {
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

    // succeeded/skipped/failed all count as done → 4/4
    expect(screen.getByText("4/4")).toBeTruthy();
  });

  it("keeps the running badge while failed and pending steps coexist", () => {
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

    expect(screen.getByText("执行中")).toBeTruthy();
    // 3 failed steps are done, 1 pending → 3/4; each failed step shows its exit code
    expect(screen.getByText("3/4")).toBeTruthy();
    expect(screen.getAllByText("exit 1").length).toBe(3);
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

  it("folds the step list away and restores it from the header", () => {
    render(<MaintenanceTaskCard detail={makeDetail()} />);

    const header = screen.getByTitle("折叠运维步骤");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("检查 nginx 状态")).toBeTruthy();

    fireEvent.click(header);

    expect(screen.queryByText("检查 nginx 状态")).toBeNull();
    expect(screen.queryByText("验证 80 端口")).toBeNull();
    // The header keeps status, goal and progress readable while folded.
    expect(screen.getByText("执行中")).toBeTruthy();
    expect(screen.getByText("修复 nginx 502")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();

    fireEvent.click(screen.getByTitle("展开运维步骤"));
    expect(screen.getByText("检查 nginx 状态")).toBeTruthy();
  });

  it("hides the summary, failure reason and stop action while folded", () => {
    const { unmount } = render(
      <MaintenanceTaskCard
        detail={makeDetail(
          { status: "succeeded", resolution: "completed_changes", summary: "nginx 已恢复" },
        )}
      />,
    );
    fireEvent.click(screen.getByTitle("折叠运维步骤"));
    expect(screen.queryByText("nginx 已恢复")).toBeNull();
    unmount();

    render(
      <MaintenanceTaskCard
        detail={makeDetail({ status: "failed", resolution: "failed", error: "复检未通过" })}
      />,
    );
    fireEvent.click(screen.getByTitle("折叠运维步骤"));
    expect(screen.queryByText("复检未通过")).toBeNull();
    expect(screen.queryByText("停止维护")).toBeNull();
  });

  it("keeps the plan approval button reachable while folded", async () => {
    render(<MaintenanceTaskCard detail={makeDetail({ status: "waiting_approval" })} />);
    fireEvent.click(screen.getByTitle("折叠运维步骤"));

    fireEvent.click(screen.getByText(/批准变更计划/));

    await waitFor(() => expect(authorize).toHaveBeenCalledTimes(1));
    expect(authorize).toHaveBeenCalledWith("task-1", ["s3"]);
  });
});
