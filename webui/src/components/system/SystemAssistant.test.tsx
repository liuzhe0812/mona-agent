import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SystemAssistant } from "./SystemAssistant";
import type { StorageAnalysisEvidence, SystemEvidence } from "./systemAgentApi";

const systemAgentMock = vi.hoisted(() => ({
  collect: vi.fn(() => Promise.resolve({} as SystemEvidence)),
  plan: vi.fn(() => Promise.resolve({ summary: "方案", findings: [], actions: [] })),
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
  storageAnalyze: vi.fn((_goal: string, _evidence: unknown) => Promise.resolve({
    scanId: "scan-storage",
    summary: "主要占用来自当前目录。",
    findings: [{
      id: "storage-finding-1",
      title: "审查长期未修改文件",
      detail: "修改时间只能作为审查线索。",
      confidence: "medium",
      risk: "review",
      evidenceIds: ["file-old"],
      action: "review_files",
      targetIds: ["file-old"],
      relatedSizeGb: 3,
    }],
    cautions: ["个人文件需要确认"],
  })),
  execute: vi.fn(),
}));

vi.mock("./systemAgentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemAgentApi")>()),
  collectSystemEvidence: systemAgentMock.collect,
  requestSystemPlan: systemAgentMock.plan,
  requestSystemDiagnosis: systemAgentMock.diagnose,
  requestStorageAnalysis: systemAgentMock.storageAnalyze,
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
  start: vi.fn(),
  cancel: vi.fn(),
  clean: vi.fn(),
  trashFiles: vi.fn(),
  selectedDrive: "C:",
  selectDrive: vi.fn(),
});

describe("SystemAssistant", () => {
  beforeEach(() => {
    systemAgentMock.collect.mockClear();
    systemAgentMock.plan.mockClear();
    systemAgentMock.diagnose.mockClear();
    systemAgentMock.storageAnalyze.mockClear();
    systemAgentMock.execute.mockClear();
  });

  it("keeps the wide right rail constrained so its content can scroll", () => {
    render(
      <SystemAssistant
        tab="software"
        storage={storageStub()}
        software={null}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Mona 系统管家" }).className).toContain("min-h-0");
  });

  it("shows the inspection empty state when no issue is found", async () => {
    render(
      <SystemAssistant
        tab="software"
        storage={storageStub()}
        software={null}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    expect(await screen.findByText("系统状态良好，暂无需要处理的事项。")).toBeTruthy();
  });

  it("opens the embedded Agent for a handoff and keeps the planner available", async () => {
    render(
      <SystemAssistant
        tab="software"
        storage={storageStub()}
        software={null}
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
    expect(await screen.findByText("系统状态良好，暂无需要处理的事项。")).toBeTruthy();
  });

  it("routes diagnostic questions to the diagnosis API and renders hypothesis cards", async () => {
    render(
      <SystemAssistant
        tab="startup"
        storage={storageStub()}
        software={null}
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
    );
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
    expect(screen.getByText("新增启动项拖慢开机")).toBeTruthy();
    expect(screen.getByText("高置信")).toBeTruthy();
    expect(screen.getByText(/诊断仅供参考/)).toBeTruthy();
    // 假设卡不提供执行能力
    expect(screen.queryByRole("button", { name: "确认并执行" })).toBeNull();
  });

  it("keeps execution goals on the planner API", async () => {
    render(
      <SystemAssistant
        tab="storage"
        storage={storageStub()}
        software={null}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={null}
      />,
    );

    fireEvent.change(screen.getByLabelText("描述系统维护目标"), { target: { value: "清理磁盘空间" } });
    fireEvent.click(screen.getByRole("button", { name: "生成维护方案" }));

    expect(await screen.findByText("方案")).toBeTruthy();
    expect(systemAgentMock.plan).toHaveBeenCalledWith("清理磁盘空间", expect.anything());
    expect(systemAgentMock.diagnose).not.toHaveBeenCalled();
  });

  it("routes analysis requests with the diagnose channel to the read-only diagnosis API", async () => {
    // 大文件评估的 goal 不含诊断关键词，必须依赖 channel 强制走 diagnose（只读通道）
    render(
      <SystemAssistant
        tab="storage"
        storage={storageStub()}
        software={null}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={{ goal: "请逐一评估这些大文件是否可以安全删除", nonce: 1, channel: "diagnose" }}
      />,
    );

    expect(await screen.findByText("诊断结论")).toBeTruthy();
    expect(systemAgentMock.diagnose).toHaveBeenCalledWith(
      "请逐一评估这些大文件是否可以安全删除",
      expect.objectContaining({ checks: expect.any(Array) }),
    );
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
    // 假设卡不提供执行能力
    expect(screen.queryByRole("button", { name: "确认并执行" })).toBeNull();
  });

  it("keeps analysis requests without a channel on the planner routing rules", async () => {
    render(
      <SystemAssistant
        tab="storage"
        storage={storageStub()}
        software={null}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        analysisRequest={{ goal: "清理磁盘空间", nonce: 2 }}
      />,
    );

    expect(await screen.findByText("方案")).toBeTruthy();
    expect(systemAgentMock.plan).toHaveBeenCalledWith("清理磁盘空间", expect.anything());
    expect(systemAgentMock.diagnose).not.toHaveBeenCalled();
  });

  it("uses path-free scope evidence for dedicated storage analysis", async () => {
    const storage = storageStub({
      scanId: "scan-storage",
      disks: [],
      directories: [{
        id: "dir-project",
        path: "C:\\Users\\Mona\\SecretProject",
        sizeGb: 12,
        fileCount: 20,
        directSizeGb: 2,
      }],
      cleanupItems: [],
      fileTypes: [],
      totalScannedGb: 12,
      topFiles: [{
        id: "file-old",
        path: "C:\\Users\\Mona\\SecretProject\\backup.zip",
        parentDirName: "SecretProject",
        extension: "zip",
        sizeGb: 3,
        modifiedBucket: "old",
      }],
    });
    render(
      <SystemAssistant
        tab="storage"
        storage={storage}
        software={null}
        onNavigate={vi.fn()}
        collapsed={false}
        handoffTask={null}
        onHandoffTaskHandled={vi.fn()}
        onCollapse={vi.fn()}
        storageSelection={storage.result?.directories[0] ?? null}
        analysisRequest={{ goal: "分析当前范围", nonce: 3, channel: "storage" }}
      />,
    );

    expect(await screen.findByText("存储分析")).toBeTruthy();
    const evidence = systemAgentMock.storageAnalyze.mock.calls[0][1] as StorageAnalysisEvidence;
    expect(JSON.stringify(evidence)).not.toContain("C:\\\\Users");
    expect(JSON.stringify(evidence)).not.toContain("SecretProject");
    expect(evidence.scope.id).toBe("dir-project");
    expect(screen.getByText("审查长期未修改文件")).toBeTruthy();
  });
});
