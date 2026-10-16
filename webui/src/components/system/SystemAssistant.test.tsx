import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SystemAssistant } from "./SystemAssistant";
import type { SystemAgentPlan, SystemEvidence } from "./systemAgentApi";

const systemAgentMock = vi.hoisted(() => ({
  collect: vi.fn(() => Promise.resolve({} as SystemEvidence)),
  plan: vi.fn<(goal: string, evidence: SystemEvidence, signal?: AbortSignal) => Promise<SystemAgentPlan>>(() => Promise.resolve({ summary: "方案", findings: [], actions: [] })),
  diagnose: vi.fn(() => Promise.resolve({
    summary: "开机变慢与新增启动项相关",
    hypotheses: [{
      title: "新增启动项拖慢开机",
      confidence: "high",
      evidenceIds: ["pending_reboot"],
      explanation: "最近新增启动项延长了引导耗时。",
      nextStep: "审查并禁用不需要的启动项。",
    }],
    cautions: ["诊断仅供参考"],
  })),
  execute: vi.fn(),
}));

vi.mock("./systemAgentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemAgentApi")>()),
  collectSystemEvidence: systemAgentMock.collect,
  requestSystemPlan: systemAgentMock.plan,
  requestSystemDiagnosis: systemAgentMock.diagnose,
  executeSystemAction: systemAgentMock.execute,
}));

vi.mock("./SystemAgentChat", () => ({
  SystemAgentChat: ({ task }: { task: { error: string } | null }) => <p>{task?.error}</p>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "system_list_startup_items") {
      return Promise.resolve({ items: [], total: 0, enabledCount: 0, disabledCount: 0 });
    }
    if (command === "system_get_boot_history") {
      return Promise.resolve({ points: [], lastDurationMs: null, lastDeltaMs: null });
    }
    if (command === "system_get_maintenance_history") return Promise.resolve({ events: [] });
    if (command.startsWith("system_check_")) {
      return Promise.resolve({
        id: command.replace("system_check_", ""),
        status: "clear",
        summary: "未检测到异常",
        detail: "检查完成，未发现问题。",
      });
    }
    return Promise.resolve(null);
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const storageStub = (result: ComponentProps<typeof SystemAssistant>["storage"]["result"] = null): ComponentProps<typeof SystemAssistant>["storage"] => ({
  status: "idle",
  result,
  lastScanAt: null,
  progress: null,
  error: null,
  cleaning: false,
  cleaningIds: new Set(),
  start: vi.fn(),
  cancel: vi.fn(),
  clean: vi.fn(),
  trashFiles: vi.fn(),
  selectedDrive: "C:",
  selectDrive: vi.fn(),
});

describe("SystemAssistant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ icons: [], agents: [] }))));
  });

  it("keeps the wide right rail constrained so its content can scroll", async () => {
    render(
      <SystemAssistant
        tab="software"
        storage={storageStub()}
        diagnosticChecks={[]}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Mona 系统管家" }).className).toContain("min-h-0");
    expect(screen.getByRole("heading", { name: "Mona", exact: true })).toBeInTheDocument();
  });

  it("keeps inspection hints out of the AI sidebar", () => {
    render(
      <SystemAssistant
        tab="software"
        storage={storageStub()}
        diagnosticChecks={[]}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    expect(screen.queryByText("巡检发现")).toBeNull();
    expect(screen.queryByText("系统状态良好，暂无需要处理的事项。")).toBeNull();
    expect(screen.getByLabelText("描述系统维护目标")).toBeEnabled();
  });

  it("opens the embedded Agent for a handoff and keeps the planner available", async () => {
    render(
      <SystemAssistant
        tab="software"
        storage={storageStub()}
        diagnosticChecks={[]}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={{ id: "failed-uninstall", title: "卸载 Notepad++", action: "卸载软件", target: "Notepad++", arguments: { id: null, name: "Notepad++" }, error: "WinGet exit code 1603" }}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    expect(await screen.findByText("WinGet exit code 1603")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回维护建议" }));
    expect(screen.queryByText("巡检发现")).toBeNull();
    expect(screen.queryByText("系统状态良好，暂无需要处理的事项。")).toBeNull();
    expect(screen.getByLabelText("描述系统维护目标")).toBeEnabled();
  });

  it("routes diagnostic questions to the diagnosis API and renders hypothesis cards", async () => {
    render(
      <SystemAssistant
        tab="startup"
        storage={storageStub()}
        diagnosticChecks={[]}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    fireEvent.change(screen.getByLabelText("描述系统维护目标"), { target: { value: "为什么开机变慢了" } });
    fireEvent.click(screen.getByRole("button", { name: "生成维护方案" }));

    expect(await screen.findByText("诊断结论")).toBeTruthy();
    expect(systemAgentMock.diagnose).toHaveBeenCalledWith(
      "为什么开机变慢了",
      expect.objectContaining({ checks: expect.any(Array) }),
      expect.any(AbortSignal),
    );
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
    expect(screen.getByText("新增启动项拖慢开机")).toBeTruthy();
    expect(screen.getByText("高置信")).toBeTruthy();
    expect(screen.getByText(/诊断仅供参考/)).toBeTruthy();
    // 假设卡不提供执行能力
    expect(screen.queryByRole("button", { name: "确认并执行" })).toBeNull();
  });

  it("routes explicit diagnosis requests to the read-only diagnosis API", async () => {
    // 显式 channel 必须覆盖默认的诊断关键词判断。
    render(
      <SystemAssistant
        tab="startup"
        storage={storageStub()}
        diagnosticChecks={[]}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={{ goal: "请结合本机证据解释开机慢的原因", nonce: 1, channel: "diagnose" }}
      />,
    );

    expect(await screen.findByText("诊断结论")).toBeTruthy();
    expect(systemAgentMock.diagnose).toHaveBeenCalledWith(
      "请结合本机证据解释开机慢的原因",
      expect.objectContaining({ checks: expect.any(Array) }),
      expect.any(AbortSignal),
    );
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
    // 假设卡不提供执行能力
    expect(screen.queryByRole("button", { name: "确认并执行" })).toBeNull();
  });

  it("shows the storage conversation instead of a scope card or maintenance planner", () => {
    render(
      <SystemAssistant
        tab="storage"
        storage={storageStub()}
        diagnosticChecks={[]}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    expect(screen.getByRole("log", { name: "存储空间对话" })).toBeInTheDocument();
    expect(screen.getByLabelText("存储空间问题")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "生成维护方案" })).toBeNull();
    expect(screen.queryByRole("button", { name: "分析当前范围" })).toBeNull();
    expect(screen.queryByText(/当前范围/)).toBeNull();
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
    expect(systemAgentMock.diagnose).not.toHaveBeenCalled();
  });

  it("stops evidence collection before it can start an AI request", async () => {
    let finishCollection!: (value: SystemEvidence) => void;
    systemAgentMock.collect.mockReturnValueOnce(new Promise((resolve) => { finishCollection = resolve; }));
    render(
      <SystemAssistant
        tab="software"
        storage={storageStub()}
        diagnosticChecks={[]}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={{ goal: "生成维护建议", nonce: 10 }}
      />,
    );

    const stop = await screen.findByRole("button", { name: "停止任务" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(screen.getByRole("status")).toHaveTextContent("已停止");
    expect(screen.getByLabelText("描述系统维护目标")).toBeEnabled();

    await act(async () => finishCollection({} as SystemEvidence));
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
    expect(systemAgentMock.diagnose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "停止任务" })).toBeNull();
  });

  it("aborts a plan request and ignores its late result while a new task is running", async () => {
    let finishOld!: (value: SystemAgentPlan) => void;
    let finishNew!: (value: SystemAgentPlan) => void;
    systemAgentMock.plan.mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }));
    systemAgentMock.plan.mockReturnValueOnce(new Promise((resolve) => { finishNew = resolve; }));
    render(
      <SystemAssistant
        tab="software"
        storage={storageStub()}
        diagnosticChecks={[]}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    const input = screen.getByLabelText("描述系统维护目标");
    fireEvent.change(input, { target: { value: "检查软件更新" } });
    fireEvent.click(screen.getByRole("button", { name: "生成维护方案" }));
    await waitFor(() => expect(systemAgentMock.plan).toHaveBeenCalledTimes(1));
    const oldSignal = systemAgentMock.plan.mock.calls[0][2]!;
    fireEvent.click(screen.getByRole("button", { name: "停止任务" }));
    expect(oldSignal.aborted).toBe(true);

    fireEvent.change(input, { target: { value: "检查启动项\n保留必要项目" } });
    fireEvent.click(screen.getByRole("button", { name: "生成维护方案" }));
    await waitFor(() => expect(systemAgentMock.plan).toHaveBeenCalledTimes(2));
    expect(systemAgentMock.plan).toHaveBeenLastCalledWith("检查启动项\n保留必要项目", expect.anything(), expect.any(AbortSignal));

    await act(async () => finishOld({ summary: "旧任务结果", findings: [], actions: [] }));
    expect(screen.queryByText("旧任务结果")).toBeNull();
    expect(screen.getByRole("button", { name: "停止任务" })).toBeEnabled();
    await act(async () => finishNew({ summary: "新任务结果", findings: [], actions: [] }));
    expect(screen.getByText("新任务结果")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "停止任务" })).toBeNull();
  });

  it("retains an uncertain operation result and prevents replay when execution or recheck rejects", async () => {
    const action = { id: "update-1", type: "software_update" as const, targetIds: ["app-1"], targetNames: ["应用"], title: "更新应用", reason: "有可用更新", risk: "medium" as const, evidenceTab: "software" as const };
    systemAgentMock.plan.mockResolvedValueOnce({ summary: "更新方案", findings: [], actions: [action, { ...action, id: "update-2", title: "更新其他应用" }] });
    systemAgentMock.execute.mockRejectedValueOnce(new Error("复检失败"));
    render(<SystemAssistant tab="software" storage={storageStub()} diagnosticChecks={[]} onNavigate={vi.fn()} collapsed={false} handoffTask={null} onHandoffTaskHandled={vi.fn()} onCollapse={vi.fn()} analysisRequest={{ goal: "更新软件", nonce: 20 }} />);

    fireEvent.click(await screen.findByRole("button", { name: "确认并执行" }));
    expect(await screen.findByText(/未能确认“更新应用”的结果/)).toBeInTheDocument();
    expect(systemAgentMock.execute).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "确认并执行" })).toBeNull();
  });
});
