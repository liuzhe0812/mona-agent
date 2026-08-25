import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SystemView } from "./SystemView";
import type { SystemEvidence, SystemEvidenceStage } from "./systemAgentApi";
import type { StorageScanResult } from "./useSystemData";

const storageScanMock = vi.hoisted(() => vi.fn<() => Promise<StorageScanResult>>(() => Promise.resolve({
  disks: [],
  directories: [],
  cleanupItems: [],
  fileTypes: [],
  totalScannedGb: 0,
})));

const startupIssueMock = vi.hoisted(() => ({ isNew: false }));
const overviewFailureMock = vi.hoisted(() => ({ message: "" }));
const configurationApplyMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ itemId: "privacy_advertising_id", success: true, detail: "操作已完成", requiresRestart: false })));

const systemAgentMock = vi.hoisted(() => ({
  collect: vi.fn<(storage: StorageScanResult | null, onProgress?: (stage: SystemEvidenceStage) => void) => Promise<SystemEvidence>>(() => Promise.resolve({} as SystemEvidence)),
  plan: vi.fn(() => Promise.resolve({
    summary: "已发现 1 项可更新软件",
    findings: ["Google Chrome 有可用安全更新"],
    actions: [{
      id: "update-chrome",
      type: "software_update",
      targetIds: ["Google.Chrome.EXE"],
      targetNames: ["Google Chrome"],
      title: "更新 Google Chrome",
      reason: "存在可用安全更新",
      risk: "medium",
      evidenceTab: "software",
    }],
  })),
  execute: vi.fn(() => Promise.resolve({
    actionId: "update-chrome",
    success: true,
    verified: true,
    detail: "Google Chrome 更新完成",
  })),
}));

vi.mock("./systemAgentApi", () => ({
  collectSystemEvidence: systemAgentMock.collect,
  requestSystemPlan: systemAgentMock.plan,
  executeSystemAction: systemAgentMock.execute,
}));

vi.mock("./SystemAgentChat", () => ({
  SystemAgentChat: ({ task }: { task: { error: string; target: string } | null }) => (
    <div data-testid="system-agent-handoff">
      <p>{task?.error}</p>
      <p>{task?.target}</p>
    </div>
  ),
}));

vi.mock("@/lib/tauri", () => ({
  invokeWithTimeout: <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "system_get_overview" && overviewFailureMock.message) {
      return Promise.reject(new Error(overviewFailureMock.message));
    }
    if (command === "system_get_history") return Promise.resolve([]);
    if (command === "system_check_updates") return Promise.resolve({
      updates: [
        { id: "Google.Chrome.EXE", name: "Google Chrome", publisher: "Google LLC", currentVersion: "138.0", nextVersion: "139.0", status: "可更新" },
        { id: "Microsoft.VisualStudioCode", name: "Visual Studio Code", publisher: "", currentVersion: "1.100", nextVersion: "1.101", status: "运行中" },
      ],
      installed: [
        { id: "notepad", name: "Notepad++", publisher: "Notepad++ Team", version: "8.7", installDate: null, softwareType: "system", estimatedSizeBytes: 104857600, installLocation: "C:\\Program Files\\Notepad++" },
        { id: "unknown", name: "Unknown Tool", publisher: "", version: "1.0", installDate: null, softwareType: "user", estimatedSizeBytes: null, installLocation: "" },
      ],
      installedCount: 2,
      knownSizeBytes: 104857600,
      knownSizeCount: 1,
      failedCount: 1,
      failures: [{ packageId: "Broken.Tool", name: "Broken Tool", action: "upgrade", ts: 1715472000, message: "安装器返回 1603" }],
      wingetAvailable: true,
      wingetVersion: "v1.29.280",
      lastCheck: 1715472000,
    });
    if (command === "system_upgrade_software") return Promise.resolve({ success: true, message: "更新完成", exitCode: 0, residuals: [] });
    if (command === "system_uninstall_software") return Promise.resolve({
      success: true,
      message: "卸载完成",
      exitCode: 0,
      residuals: [{ path: "C:\\Users\\Mona\\AppData\\Roaming\\Notepad++", sizeBytes: 2048, category: "应用数据", requiresConfirmation: true }],
    });
    if (command === "system_list_startup_items") return Promise.resolve({
      items: [
        { id: "wechat", name: "WeChat", publisher: "Tencent", source: "注册表", scope: "user", command: "C:\\WeChat\\WeChat.exe", targetPath: "C:\\WeChat\\WeChat.exe", added: "2024/05/12", enabled: true, signed: true, firstSeenAt: Math.floor(Date.now() / 1000), isNew: startupIssueMock.isNew },
        { id: "onedrive", name: "OneDrive", publisher: "Microsoft", source: "注册表", scope: "user", command: "C:\\OneDrive\\OneDrive.exe", targetPath: "C:\\OneDrive\\OneDrive.exe", added: "2024/01/15", enabled: true, signed: true, firstSeenAt: Math.floor(Date.now() / 1000), isNew: startupIssueMock.isNew },
        { id: "teams", name: "Microsoft Teams Machine-Wide Installer With A Very Long Startup Name", publisher: "Microsoft", source: "注册表", scope: "user", command: "C:\\Teams\\Teams.exe", targetPath: "C:\\Teams\\Teams.exe", added: "2024/02/20", enabled: false, signed: true, firstSeenAt: 1708358400, isNew: false },
        { id: "task:\\Updater|UpdateHelper", name: "UpdateHelper", publisher: "Example", source: "计划任务", scope: "machine", command: "C:\\Updater\\update.exe", targetPath: "C:\\Updater\\update.exe", added: null, enabled: true, signed: false, firstSeenAt: 1715472000, isNew: false },
      ],
      total: 4,
      enabledCount: 3,
      disabledCount: 1,
    });
    if (command === "system_toggle_startup_item") return Promise.resolve();
    if (command === "system_batch_toggle_startup_items") return Promise.resolve(1);
    if (command === "system_get_boot_history") return Promise.resolve({ points: [], lastDurationMs: null, lastDeltaMs: null });
    if (command === "system_acknowledge_startup_items") {
      startupIssueMock.isNew = false;
      return Promise.resolve();
    }
    if (command === "system_get_startup_changes") return Promise.resolve([]);
    if (command === "system_get_maintenance_history") return Promise.resolve({
      events: [
        { id: "software-7", ts: 1715472000, category: "更新", title: "更新 Visual Studio Code", source: "用户操作", status: "成功", detail: "WinGet 更新完成", bytesChanged: 0, reversible: false, relatedId: null, restoreEnabled: null },
        { id: "software-8", ts: 1715472060, category: "卸载", title: "卸载 Notepad++", source: "用户操作", status: "成功", detail: "WinGet 卸载完成", bytesChanged: 0, reversible: false, relatedId: null, restoreEnabled: null },
      ],
    });
    if (command === "system_get_configuration_audit") return Promise.resolve({
      items: [{
        id: "privacy_advertising_id",
        category: "隐私与遥测",
        title: "跨应用广告标识",
        description: "允许应用基于广告 ID 提供个性化广告。",
        currentValue: "允许个性化广告",
        recommendedValue: "关闭个性化广告",
        status: "available",
        risk: "low",
        impact: "减少跨应用广告跟踪",
        reversible: true,
        requiresRestart: false,
        requiresAdministrator: false,
        canApply: true,
        canRestore: false,
        note: "只修改当前 Windows 用户的广告标识开关。",
      }],
    });
    if (command === "system_apply_configuration_item") return configurationApplyMock();
    if (command === "system_list_performance_items") return Promise.resolve([]);
    if (command === "system_list_context_menu_items") return Promise.resolve([]);
    if (command === "system_get_defender_status") return Promise.resolve({
      realtimeEnabled: true,
      isManagedByPolicy: false,
      canControl: true,
      thirdPartyAv: [],
      detail: "实时保护已启用",
    });
    if (command === "system_list_blocked_processes") return Promise.resolve([]);
    if (command === "system_get_dns_status") return Promise.resolve({
      adapters: [],
      activeServers: [],
      activePresetId: null,
      presets: [],
    });
    if (command === "system_list_hosts_entries") return Promise.resolve({
      entries: [],
      backupFiles: [],
    });
    if (command === "system_list_windows_apps") return Promise.resolve({
      items: [
        { id: "Clipchamp.Clipchamp", appIds: ["Clipchamp.Clipchamp"], name: "Clipchamp", description: "Microsoft 视频编辑器", recommendation: "safe", removalMethod: "Appx", installed: true, selectedByDefault: true },
        { id: "Microsoft.WindowsStore", appIds: ["Microsoft.WindowsStore"], name: "Microsoft Store", description: "Windows 应用商店", recommendation: "unsafe", removalMethod: "Appx", installed: true, selectedByDefault: false },
      ],
      total: 141,
      installedCount: 2,
      sourceVersion: "1.0",
    });
    if (command === "system_remove_windows_app") return Promise.resolve({ success: true, message: "卸载完成", exitCode: 0, residuals: [] });
    if (command === "system_check_pending_reboot") return Promise.resolve({
      id: "pending_reboot",
      status: "attention",
      summary: "检测到待重启状态",
      detail: "来源：Windows 更新。保存工作并重启后再复查相关问题。",
    });
    if (command.startsWith("system_check_")) return Promise.resolve({
      id: command.replace("system_check_", ""),
      status: "clear",
      summary: "未检测到异常",
      detail: "检查完成，未发现问题。",
    });
    if (command === "scan_storage") return storageScanMock();
    return Promise.resolve({
      cpu: { usagePercent: 18, frequencyGhz: 2.1, coreCount: 8 },
      memory: { usagePercent: 62, usedGb: 9.9, totalGb: 15.8 },
      disks: [{ driveLetter: "C 盘", usagePercent: 81, usedGb: 86.5, totalGb: 106.1, availableGb: 19.6 }],
      network: { totalMbps: 2.4, uploadMbps: 1.2, downloadMbps: 1.2 },
      topProcesses: [
        { pid: 2, name: "Chrome.exe", cpuPercent: 11.2, memoryMb: 800, diskReadBytesPerSec: 1_200_000, diskWriteBytesPerSec: 300_000 },
        { pid: 1, name: "Code.exe", cpuPercent: 4.1, memoryMb: 329, diskReadBytesPerSec: 600_000, diskWriteBytesPerSec: 200_000 },
        { pid: 3, name: "Slack.exe", cpuPercent: 2.3, memoryMb: 600, diskReadBytesPerSec: 200_000, diskWriteBytesPerSec: 100_000 },
      ],
      sampleCount: 1,
    });
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

describe("SystemView", () => {
  beforeEach(() => {
    startupIssueMock.isNew = false;
    overviewFailureMock.message = "";
    configurationApplyMock.mockReset();
    configurationApplyMock.mockResolvedValue({ itemId: "privacy_advertising_id", success: true, detail: "操作已完成", requiresRestart: false });
    localStorage.removeItem("system.storageScan");
    localStorage.removeItem("system.assistantCollapsed");
  });

  it("shows the overview recovery state when native data cannot be read", async () => {
    overviewFailureMock.message = "系统概览读取失败";
    render(<SystemView />);

    expect(await screen.findByText("暂时无法读取系统状态")).toBeTruthy();
    expect(screen.getByText("系统概览读取失败")).toBeTruthy();
  });

  it("shows system health checks on the overview with expandable details", async () => {
    render(<SystemView />);

    expect(await screen.findByRole("heading", { name: "系统健康检查" })).toBeTruthy();
    expect((await screen.findAllByText("待重启状态")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("检测到待重启状态").length).toBeGreaterThan(0);
    expect(screen.getAllByText("需关注").length).toBeGreaterThan(0);
    expect(screen.getAllByText("正常").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /待重启状态/ }));
    expect(screen.getByText(/来源：Windows 更新/)).toBeTruthy();

    expect(screen.getByRole("button", { name: /重新检查/ })).toBeTruthy();
  });

  it("toggles the Mona assistant entirely through the header Mona button", () => {
    localStorage.removeItem("system.assistantCollapsed");
    render(<SystemView />);

    const toggleButton = screen.getByRole("button", { name: "收起 Mona 系统管家" });
    fireEvent.click(toggleButton);

    const assistant = document.querySelector('aside[aria-label="Mona 系统管家"]')!;
    expect(assistant.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "展开 Mona 系统管家" })).toBeTruthy();
    expect(screen.getByTestId("system-layout").className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(screen.getByTestId("system-layout").className).not.toContain("grid-cols-[minmax(0,1fr)_360px]");

    fireEvent.click(screen.getByRole("button", { name: "展开 Mona 系统管家" }));
    expect(document.querySelector('aside[aria-label="Mona 系统管家"]')?.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByRole("button", { name: "收起 Mona 系统管家" })).toBeTruthy();
    expect(screen.getByTestId("system-layout").className).toContain("grid-cols-[minmax(0,1fr)_360px]");

    localStorage.removeItem("system.assistantCollapsed");
  });

  it("switches between all five system panels", () => {
    render(<SystemView />);

    expect(screen.getByRole("heading", { name: "电脑状态概览" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "系统模块导航" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "存储空间" }));
    expect(screen.getByText(/尚未扫描/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "软件管理" }));
    expect(screen.getByRole("heading", { name: "可用更新" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "启动项" }));
    expect(screen.getByRole("heading", { name: "启动应用" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "系统优化" }));
    expect(screen.getByRole("heading", { name: "系统优化" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "维护记录" }));
    expect(screen.getByRole("heading", { name: "维护时间线" })).toBeTruthy();
  });

  it("renders the overview controls beside one system-level Agent workspace", async () => {
    render(<SystemView />);

    expect(await screen.findByRole("button", { name: "10 分钟" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mona 系统管家" })).toBeTruthy();
    expect(await screen.findByText("巡检发现")).toBeTruthy();
    expect(screen.getByTestId("inspection-card-software")).toBeTruthy();
    expect(screen.getByRole("button", { name: "一键更新" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "释放 C 盘可清理空间" })).toBeNull();
    expect(screen.getByTestId("system-layout").className).toContain(
      "grid-cols-[minmax(0,1fr)_360px]",
    );
    expect(screen.getByTestId("system-layout").className).not.toContain(
      "grid-cols-[minmax(0,1fr)]",
    );
  });

  it("consolidates persistent configuration under system optimization", async () => {
    render(<SystemView initialTab="optimization" />);

    expect(await screen.findByRole("heading", { name: "系统优化" })).toBeTruthy();
    const systemTab = within(screen.getByRole("tablist", { name: "系统模块导航" })).getByRole("tab", { name: "系统优化" });
    expect(systemTab).toHaveClass("text-foreground");
    expect(systemTab.querySelector("span")?.className).toContain("bg-[hsl(var(--brand-red))]");
    expect(screen.getByRole("button", { name: "隐私与建议内容" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Windows 更新" })).toBeTruthy();
    const activeCategory = within(screen.getByRole("navigation", { name: "Windows 设置分类" })).getByRole("button", { name: "全部设置" });
    expect(activeCategory).toHaveClass("text-foreground");
    expect(activeCategory.className).toContain("before:bg-[hsl(var(--brand-red))]");
    expect(activeCategory).not.toHaveClass("bg-info-soft");
    expect(screen.getByRole("switch", { name: "应用跨应用广告标识" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("tab", { name: "网络" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "高级优化" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "系统工具" })).toBeNull();
    expect(screen.queryByRole("button", { name: /AI 故障诊断/ })).toBeNull();
    expect(screen.queryByText("文件锁查询")).toBeNull();
    expect(screen.queryByText("系统完整性修复")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "网络与解析" }));
    expect(await screen.findByText("DNS 服务器")).toBeTruthy();
    expect(screen.getByText("HOSTS 编辑器")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "安全与防护" }));
    expect(await screen.findByText("Windows Defender 控制")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "应用与进程" }));
    expect(await screen.findByText("进程黑名单")).toBeTruthy();
  });

  it("surfaces actionable issues and opens their existing workflows", async () => {
    localStorage.removeItem("system.storageScan");
    try {
      render(<SystemView />);

      expect(await screen.findByRole("heading", { name: "现在值得处理" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "C 盘空间紧张" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "查看并扫描" }));
      expect(await screen.findByRole("heading", { name: "重点路径占用" })).toBeTruthy();

  } finally {
      localStorage.removeItem("system.storageScan");
    }
  });

  it("does not treat the initial startup inventory as newly added", async () => {
    render(<SystemView />);

    await screen.findByRole("heading", { name: "现在值得处理" });
    expect(screen.queryByRole("heading", { name: "启动项有新增" })).toBeNull();
  });

  it("acknowledges reviewed startup items before returning to the overview", async () => {
    startupIssueMock.isNew = true;
    render(<SystemView />);

    expect(await screen.findByRole("heading", { name: "启动项有新增" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "审查启动项" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_acknowledge_startup_items", {}));
    expect(await screen.findByRole("heading", { name: "启动应用" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "概览" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "启动项有新增" })).toBeNull());
  });

  it("shows real process disk read and write rates without a network placeholder", async () => {
    render(<SystemView />);

    expect(await screen.findByRole("columnheader", { name: "磁盘读取" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "磁盘写入" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "网络" })).toBeNull();
    expect(screen.getByText("1.2 MB/s")).toBeTruthy();
    expect(screen.getByText("300 KB/s")).toBeTruthy();
  });

  it("toggles the process table from descending to ascending by the selected column", async () => {
    render(<SystemView />);

    await screen.findByRole("columnheader", { name: "CPU" });
    fireEvent.click(screen.getByRole("button", { name: "按 CPU 排序" }));

    expect(screen.getAllByRole("row").slice(1).map((row) => (row as HTMLTableRowElement).cells[0].textContent)).toEqual([
      "Slack.exe",
      "Code.exe",
      "Chrome.exe",
    ]);
  });

  it("uses verified software data and invokes WinGet for selected updates", async () => {
    render(<SystemView initialTab="software" />);

    expect(await screen.findByText("来自 WinGet 实时检查")).toBeTruthy();
    expect(screen.queryByText(/428 MB/)).toBeNull();
    expect(screen.queryByText(/19\.6 GB/)).toBeNull();
    expect(screen.getByText("已知占用 100 MB · 覆盖 1/2")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Google Chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "更新所选" }));

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "system_upgrade_software",
      { id: "Google.Chrome.EXE", name: "Google Chrome" },
    ));
    expect(await screen.findByText("1 项更新完成")).toBeTruthy();
  });

  it("separates software updates, installed software, and uninstall history into tabs", async () => {
    render(<SystemView initialTab="software" />);

    expect(await screen.findByRole("tab", { name: "软件更新" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "已安装软件" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "卸载记录" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "可用更新" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "已安装软件" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "已安装软件" }));
    expect(await screen.findByRole("columnheader", { name: "已安装软件" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "卸载记录" }));
    expect(await screen.findByText("卸载 Notepad++")).toBeTruthy();
    expect(screen.getByText("WinGet 卸载完成")).toBeTruthy();
  });

  it("requires confirmation before uninstalling and shows only detected residual candidates", async () => {
    render(<SystemView initialTab="software" />);

    fireEvent.click(await screen.findByRole("tab", { name: "已安装软件" }));
    fireEvent.click(await screen.findByRole("button", { name: "卸载 Notepad++" }));
    fireEvent.click(screen.getByRole("button", { name: "确认卸载 Notepad++" }));

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "system_uninstall_software",
      { id: null, name: "Notepad++", installLocation: "C:\\Program Files\\Notepad++" },
    ));
    expect(await screen.findByText("C:\\Users\\Mona\\AppData\\Roaming\\Notepad++")).toBeTruthy();
    expect(screen.getByText("疑似残留，删除前需确认")).toBeTruthy();
  });

  it("toggles a startup item without touching other rows", async () => {
    render(<SystemView initialTab="startup" />);

    const wechatSwitch = await screen.findByRole("switch", { name: "切换 WeChat 启动状态" });
    fireEvent.click(wechatSwitch);

    expect(await screen.findByText("WeChat 已禁用，可随时恢复")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "切换 OneDrive 启动状态" }).getAttribute("aria-checked")).toBe("true");
  });

  it("hands a failed startup toggle to Mona in the right sidebar", async () => {
    render(<SystemView initialTab="startup" />);

    const wechatSwitch = await screen.findByRole("switch", { name: "切换 WeChat 启动状态" });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("access denied"));
    fireEvent.click(wechatSwitch);

    expect(await screen.findByTestId("system-task-failure")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "交给 Mona" }));
    expect(screen.queryByTestId("system-task-failure")).toBeNull();
    expect((await screen.findByTestId("system-agent-handoff")).textContent).toContain("access denied");
  });

  it("keeps startup columns fixed and exposes truncated names through a tooltip", async () => {
    render(<SystemView initialTab="startup" />);

    const table = (await screen.findByRole("columnheader", { name: "名称" })).closest("table");
    const fullName = "Microsoft Teams Machine-Wide Installer With A Very Long Startup Name";
    const name = screen.getByTitle(fullName);

    expect(table?.className).toContain("table-fixed");
    expect(table?.querySelectorAll("col")).toHaveLength(7);
    expect(name.className).toContain("truncate");
  });

  it("shows live storage capacity before a deep scan", async () => {
    const scanCallsBeforeRender = storageScanMock.mock.calls.length;
    render(<SystemView initialTab="storage" />);

    expect(await screen.findByText("106.1 GB")).toBeTruthy();
    expect(screen.getByText("86.5 GB")).toBeTruthy();
    expect(screen.getByText("19.6 GB")).toBeTruthy();
    // 指标卡口径为系统盘（无扫描数据时回退 C:），不再是全盘聚合
    expect(screen.getAllByText("系统盘 C:").length).toBeGreaterThan(0);
    expect(storageScanMock).toHaveBeenCalledTimes(scanCallsBeforeRender);
  });

  it("keeps the complete storage prototype structure visible before scanning", async () => {
    render(<SystemView initialTab="storage" />);

    expect(await screen.findByRole("heading", { name: "重点路径占用" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /空间分布/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "安全清理" })).toBeTruthy();
    expect(screen.getByText("待分析")).toBeTruthy();
  });

  it("retains an active storage scan and its result across tab switches", async () => {
    let resolveScan!: (value: StorageScanResult) => void;
    storageScanMock.mockReturnValueOnce(new Promise((resolve) => { resolveScan = resolve; }));
    render(<SystemView initialTab="storage" />);

    fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getAllByText("正在扫描磁盘...").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "软件管理" }));
    fireEvent.click(screen.getByRole("tab", { name: "存储空间" }));
    expect(screen.getAllByText("正在扫描磁盘...").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "软件管理" }));
    await act(async () => resolveScan({
      disks: [{ driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50 }],
      directories: [{ path: "C:\\Users\\Mona", sizeGb: 20, fileCount: 10 }],
      cleanupItems: [{ id: "temp", name: "系统临时文件", sizeGb: 1.5, path: "C:\\Temp", cleanable: true, recommended: true, reason: "可安全清理" }],
      fileTypes: [{ category: "应用", sizeGb: 12 }],
      totalScannedGb: 20,
    }));
    fireEvent.click(screen.getByRole("tab", { name: "存储空间" }));
    // WizTree 布局：CleanupPanel 中的清理项 + FileTypePanel 中的类型
    expect((await screen.findAllByText("1.5 GB")).length).toBeGreaterThan(0);
    expect(screen.getByText("应用")).toBeTruthy();
    // 扫描覆盖率说明：totalScannedGb(20) / 系统盘已用(50) = 40%
    expect((await screen.findAllByText(/约占 C: 已用的 40%/)).length).toBeGreaterThan(0);
  });

  it("cancels an active storage scan and keeps the partial result marked as cancelled", async () => {
    let resolveScan!: (value: StorageScanResult) => void;
    storageScanMock.mockReturnValueOnce(new Promise((resolve) => { resolveScan = resolve; }));
    render(<SystemView initialTab="storage" />);

    fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getAllByText("正在扫描磁盘...").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "取消扫描" }));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("cancel_storage_scan");

    await act(async () => resolveScan({
      disks: [{ driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50 }],
      directories: [{ path: "C:\\Users", sizeGb: 8, fileCount: 4 }],
      cleanupItems: [],
      fileTypes: [{ category: "应用", sizeGb: 5 }],
      totalScannedGb: 8,
      scanSummary: { totalFiles: 4, totalDirs: 2, scanDurationSecs: 1.2, scannedDisk: "C:", cancelled: true },
    }));

    // 取消后状态回落到 done，状态栏标记部分结果而非失败
    expect((await screen.findAllByText(/扫描已取消 · 部分结果/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "取消扫描" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新扫描" })).toBeTruthy();
  });

  it("shows a real cleanup preview list and warns that cache cleanup bypasses the recycle bin", async () => {
    let resolveScan!: (value: StorageScanResult) => void;
    storageScanMock.mockReturnValueOnce(new Promise((resolve) => { resolveScan = resolve; }));
    render(<SystemView initialTab="storage" />);

    fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
    await act(async () => resolveScan({
      disks: [{ driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50 }],
      directories: [{ path: "C:\\Users", sizeGb: 8, fileCount: 4 }],
      cleanupItems: [
        { id: "temp", name: "系统临时文件", sizeGb: 1.5, path: "C:\\Windows\\Temp", cleanable: true, recommended: true, reason: "应用未占用的临时文件可安全清理" },
        { id: "windows_old", name: "Windows.old（旧系统文件）", sizeGb: 12, path: "C:\\Windows.old", cleanable: false, recommended: false, reason: "建议通过系统「存储感知」清理：设置 → 系统 → 存储 → 临时文件" },
      ],
      fileTypes: [],
      totalScannedGb: 8,
    }));

    // Windows.old 仅提示，不提供 Mona 内删除（reason 经 title 提示暴露）
    expect(await screen.findByText("Windows.old（旧系统文件）")).toBeTruthy();
    expect(screen.getByText("交由 Windows")).toBeTruthy();
    expect(screen.getByTitle(/建议通过系统「存储感知」清理/)).toBeTruthy();

    // 勾选可清理项（挂载时 items 为空，初始选中集不含扫描后到达的项）
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 系统临时文件" }));

    // 预览清单为真清单（项目名 + 路径 + 大小 + reason），不再是 notice 拼文本
    // Radix DropdownMenu 在 jsdom 中通过键盘事件打开（pointerdown 依赖 PointerEvent）
    fireEvent.keyDown(screen.getByRole("button", { name: "预览清单" }), { key: "Enter" });
    expect(await screen.findByText("C:\\Windows\\Temp")).toBeTruthy();
    expect(screen.getByText("应用未占用的临时文件可安全清理")).toBeTruthy();

    // 确认弹窗文案明示直接删除语义（与产物区回收站语义区分）
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "安全清理" }));
    expect(await screen.findByText(/这些文件将被直接删除，不经过回收站/)).toBeTruthy();
  });

  it("removes a handed-off software failure from the current task list", async () => {
    render(<SystemView initialTab="software" />);

    expect(await screen.findByText(/安装器返回 1603/)).toBeTruthy();
    expect(screen.getByTestId("system-task-failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "交给 Mona" }));
    expect(screen.queryByTestId("system-task-failure")).toBeNull();
    expect((await screen.findByTestId("system-agent-handoff")).textContent).toContain("安装器返回 1603");
    fireEvent.click(screen.getByRole("tab", { name: "已安装软件" }));
    expect(screen.getByRole("columnheader", { name: "已安装软件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "卸载 Notepad++" })).toBeTruthy();
  });

  it("sorts startup rows from the table header without selection checkboxes", async () => {
    render(<SystemView initialTab="startup" />);

    expect(await screen.findByText("UpdateHelper")).toBeTruthy();
    expect(screen.getByText("计划任务")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "按名称排序" }));

    const rows = screen.getAllByRole("row").slice(1);
    expect((rows[0] as HTMLTableRowElement).cells[0].textContent).toContain("Microsoft Teams");
  });

  it("offers the complete Windows settings navigation and compact filters", async () => {
    render(<SystemView initialTab="optimization" />);

    expect(await screen.findByRole("button", { name: "隐私与建议内容" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "任务栏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "文件资源管理器" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "可选 Windows 功能" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "性能与响应" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "网络与解析" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "安全与防护" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "应用与进程" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "搜索 Windows 设置" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "风险筛选" })).toBeNull();
  });

  it("shows configuration failures inside the active confirmation dialog", async () => {
    configurationApplyMock.mockRejectedValueOnce(new Error("拒绝访问"));
    render(<SystemView initialTab="optimization" />);

    fireEvent.click(await screen.findByRole("switch", { name: "应用跨应用广告标识" }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认应用" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("拒绝访问");
  });

  it("integrates the complete Windows preinstalled app catalog into software management", async () => {
    render(<SystemView initialTab="software" />);

    fireEvent.click(screen.getByRole("tab", { name: "Windows 预装应用" }));
    expect(await screen.findByText("Clipchamp")).toBeTruthy();
    expect(screen.getByText("Microsoft Store")).toBeTruthy();
    expect(screen.getByText("完整目录 141 项")).toBeTruthy();
    expect(screen.getByRole("button", { name: "预装应用风险筛选" })).toBeTruthy();
  });

  it("renders maintenance history returned by the backend instead of mock events", async () => {
    render(<SystemView initialTab="maintenance" />);

    expect((await screen.findAllByText("更新 Visual Studio Code")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("WinGet 更新完成").length).toBeGreaterThan(0);
    expect(screen.queryByText("安全清理系统临时文件，释放 6.8 GB")).toBeNull();
  });

  it("keeps a real Agent plan across tabs and opens its evidence source", async () => {
    render(<SystemView initialTab="software" />);

    const goalInput = await screen.findByLabelText("描述系统维护目标");
    fireEvent.change(goalInput, { target: { value: "释放 C 盘可清理空间" } });
    fireEvent.keyDown(goalInput, { key: "Enter" });
    expect(screen.getByText("正在整理系统证据")).toBeTruthy();

    expect(await screen.findByText("已发现 1 项可更新软件")).toBeTruthy();
    expect(systemAgentMock.collect).toHaveBeenCalled();
    expect(systemAgentMock.plan).toHaveBeenCalledWith("释放 C 盘可清理空间", {});
    expect(screen.getByText("更新 Google Chrome")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "启动项" }));
    expect(screen.getByText("更新 Google Chrome")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看软件管理依据" }));
    expect(screen.getByRole("heading", { name: "可用更新" })).toBeTruthy();
  });

  it("executes only the selected real Agent actions and reports verification", async () => {
    render(<SystemView initialTab="software" />);

    const goalInput = await screen.findByLabelText("描述系统维护目标");
    fireEvent.change(goalInput, { target: { value: "释放 C 盘可清理空间" } });
    fireEvent.keyDown(goalInput, { key: "Enter" });
    await screen.findByText("更新 Google Chrome");
    fireEvent.click(screen.getByRole("button", { name: "确认并执行" }));

    expect(await screen.findByText("验证完成")).toBeTruthy();
    expect(systemAgentMock.execute).toHaveBeenCalledWith(expect.objectContaining({ id: "update-chrome" }));
    expect(screen.getByText("Google Chrome 更新完成")).toBeTruthy();
  });
});
