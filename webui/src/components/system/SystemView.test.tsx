import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SystemView } from "./SystemView";
import type { SystemEvidence, SystemEvidenceStage } from "./systemAgentApi";
import type { SoftwareActionResult, SoftwareCheckResult, StorageCleanupResult, StorageScanResult } from "./useSystemData";

const storageScanMock = vi.hoisted(() => vi.fn<() => Promise<StorageScanResult>>(() => Promise.resolve({
  scanId: "scan-empty",
  disks: [],
  directories: [],
  cleanupItems: [],
  fileTypes: [],
  totalScannedGb: 0,
})));

const startupIssueMock = vi.hoisted(() => ({ isNew: false, reviewFailure: false }));
const overviewDriveMock = vi.hoisted(() => ({ value: "C 盘" }));
const overviewDisksMock = vi.hoisted(() => ({ value: null as null | Array<{ driveLetter: string; usagePercent: number; usedGb: number; totalGb: number; availableGb: number }> }));
const bootDeltaMock = vi.hoisted(() => ({ value: null as number | null }));
const overviewFailureMock = vi.hoisted(() => ({ message: "" }));
const configurationApplyMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ itemId: "privacy_advertising_id", success: true, detail: "操作已完成", requiresRestart: false })));
const uninstallResultMock = vi.hoisted(() => vi.fn());
const residualDeleteMock = vi.hoisted(() => vi.fn());
const nativeUpgradeMock = vi.hoisted(() => vi.fn());
const cleanupMock = vi.hoisted(() => vi.fn());
const softwareCheckControl = vi.hoisted(() => ({ results: [] as unknown[], failNext: false }));

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
  storageAnalyze: vi.fn(() => Promise.resolve({
    scanId: "scan-complete",
    summary: "主要空间来自当前目录。",
    findings: [],
    cautions: [],
  })),
}));

vi.mock("./systemAgentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemAgentApi")>()),
  collectSystemEvidence: systemAgentMock.collect,
  requestSystemPlan: systemAgentMock.plan,
  requestStorageAnalysis: systemAgentMock.storageAnalyze,
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

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  isTauri: () => false,
  invokeWithTimeout: <T,>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string, args?: Record<string, unknown>) => {
    if (command === "system_get_overview" && overviewFailureMock.message) {
      return Promise.reject(new Error(overviewFailureMock.message));
    }
    if (command === "system_get_history") return Promise.resolve([]);
    if (command === "system_check_updates") {
      if (softwareCheckControl.failNext) {
        softwareCheckControl.failNext = false;
        return Promise.reject(new Error("软件列表刷新失败"));
      }
      if (softwareCheckControl.results.length > 0) return Promise.resolve(softwareCheckControl.results.shift());
      return Promise.resolve({
        updates: [
          { id: "Google.Chrome.EXE", name: "Google Chrome", publisher: "Google LLC", currentVersion: "138.0", nextVersion: "139.0", status: "可更新" },
          { id: "Microsoft.VisualStudioCode", name: "Visual Studio Code", publisher: "", currentVersion: "1.100", nextVersion: "1.101", status: "运行中" },
        ],
        installed: [
          { id: "notepad", name: "Notepad++", publisher: "Notepad++ Team", version: "8.7", installDate: null, softwareType: "system", estimatedSizeBytes: 104857600, installLocation: "C:\\Program Files\\Notepad++", uninstallKind: "desktop", canUninstall: true },
          { id: "unknown", name: "Unknown Tool", publisher: "", version: "1.0", installDate: null, softwareType: "user", estimatedSizeBytes: null, installLocation: "", uninstallKind: "unavailable", canUninstall: false },
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
    }
    if (command === "system_search_apps") return Promise.resolve(args?.query === "xmind" ? [
      { id: "Xmind.Xmind", name: "Xmind", version: "26.01", source: "winget" },
      { id: "Xmind.Xmind.8", name: "XMind 8", version: "3.7", source: "winget" },
      { id: "CorvusMindware.Portty", name: "Portty", version: "1.0", source: "winget" },
    ] : [
      { id: "Tencent.WeChat", name: "WeChat", version: "3.9.12", source: "winget" },
    ]);
    if (command === "system_install_app") return Promise.resolve({ success: true, message: "安装完成", exitCode: 0, residuals: [] });
    if (command === "system_upgrade_software") return nativeUpgradeMock();
    if (command === "clean_storage") return cleanupMock();
    if (command === "system_uninstall_software") return uninstallResultMock();
    if (command === "system_delete_software_residuals") return residualDeleteMock();
    if (command === "system_reveal_in_explorer") return Promise.resolve();
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
    if (command === "system_get_boot_history") return Promise.resolve({ points: [], lastDurationMs: null, lastDeltaMs: bootDeltaMock.value });
    if (command === "system_acknowledge_startup_items") {
      if (startupIssueMock.reviewFailure) return Promise.reject(new Error("本机记录无法更新"));
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
      disks: overviewDisksMock.value ?? [{ driveLetter: overviewDriveMock.value, usagePercent: 81, usedGb: 86.5, totalGb: 106.1, availableGb: 19.6 }],
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

function makeSoftwareCheck(overrides: Partial<SoftwareCheckResult> = {}): SoftwareCheckResult {
  return {
    updates: [],
    installed: [],
    installedCount: 0,
    knownSizeBytes: 0,
    knownSizeCount: 0,
    failedCount: 0,
    failures: [],
    wingetAvailable: true,
    wingetVersion: "v1",
    lastCheck: 1715472000,
    ...overrides,
  };
}

function getStartStorageScanButton() {
  return screen.findByRole("button", { name: /开始扫描/ });
}

describe("SystemView", () => {
  beforeEach(() => {
    startupIssueMock.isNew = false;
    startupIssueMock.reviewFailure = false;
    overviewDriveMock.value = "C 盘";
    overviewDisksMock.value = null;
    bootDeltaMock.value = null;
    vi.clearAllMocks();
    softwareCheckControl.results = [];
    softwareCheckControl.failNext = false;
    overviewFailureMock.message = "";
    configurationApplyMock.mockReset();
    configurationApplyMock.mockResolvedValue({ itemId: "privacy_advertising_id", success: true, detail: "操作已完成", requiresRestart: false });
    uninstallResultMock.mockReset();
    uninstallResultMock.mockResolvedValue({
      success: true,
      message: "卸载完成",
      exitCode: 0,
      residuals: [{ id: "notepad-roaming", path: "C:\\Users\\Mona\\AppData\\Roaming\\Notepad++", sizeBytes: 2048, category: "应用数据", requiresConfirmation: true, kind: "directory", confidence: "high", recommended: true, canDelete: true, reason: "卸载后留下的应用数据目录" }],
    });
    residualDeleteMock.mockReset();
    residualDeleteMock.mockResolvedValue({ deletedIds: ["notepad-roaming"], freedBytes: 2048, failures: [] });
    nativeUpgradeMock.mockReset();
    nativeUpgradeMock.mockResolvedValue({ success: true, message: "更新完成", exitCode: 0, residuals: [] });
    cleanupMock.mockReset();
    cleanupMock.mockResolvedValue({ freedGb: 0.5, cleanedIds: ["temp"], failures: [], verification: [{ id: "temp", path: "C:\\Temp", beforeBytes: 1_610_612_736, afterBytes: 1_073_741_824 }] });
    localStorage.removeItem("system.storageScan");
    localStorage.removeItem("system.assistantCollapsed");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ icons: [] }),
    })));
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
    expect(screen.queryByRole("heading", { name: "巡检问题" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "系统健康检查" })).toHaveLength(1);
    const health = screen.getByRole("heading", { name: "系统健康检查" }).closest("section")!;
    const trends = screen.getByRole("heading", { name: "性能趋势" }).closest("section")!;
    const processes = screen.getByRole("heading", { name: "资源占用较高的程序" }).closest("section")!;
    expect(trends.compareDocumentPosition(health) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(health.compareDocumentPosition(processes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/来源：Windows 更新/)).toBeNull();
    expect((await screen.findAllByText("待重启状态")).length).toBe(1);
    expect(screen.getAllByText("检测到待重启状态").length).toBeGreaterThan(0);
    expect(screen.getAllByText("需关注").length).toBeGreaterThan(0);
    expect(screen.getAllByText("正常").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /待重启状态/ }));
    expect(screen.getByText(/来源：Windows 更新/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "待重启状态" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "待重启状态" }));
    expect(screen.queryByText(/来源：Windows 更新/)).toBeNull();

    expect(screen.getByRole("button", { name: /重新检查/ })).toBeTruthy();
  });

  it("omits privileged and informational diagnostics on load and recheck", async () => {
    const omittedChecks = [
      ["system_check_component_health", "组件存储健康"],
      ["system_check_power_events", "电源唤醒事件"],
      ["system_check_recovery_status", "恢复与磁盘保护"],
      ["system_check_network_configuration", "网络代理配置"],
    ];
    render(<SystemView />);
    const recheck = await screen.findByRole("button", { name: "重新检查" });
    await waitFor(() => expect(recheck).toBeEnabled());
    const health = screen.getByRole("list", { name: "系统健康检查" });
    expect(within(health).getByRole("button", { name: "待重启状态" })).toBeTruthy();
    expect(within(health).getByRole("button", { name: "设备驱动异常" })).toBeTruthy();
    for (const [command, label] of omittedChecks) {
      expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(command);
      expect(within(health).queryByText(label)).toBeNull();
    }

    vi.mocked(invoke).mockClear();
    fireEvent.click(recheck);
    await waitFor(() => expect(recheck).toBeEnabled());
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_check_pending_reboot");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_check_driver_issues");
    for (const [command, label] of omittedChecks) {
      expect(vi.mocked(invoke)).not.toHaveBeenCalledWith(command);
      expect(within(health).queryByText(label)).toBeNull();
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("toggles the Mona assistant entirely through the header Mona button", () => {
    localStorage.removeItem("system.assistantCollapsed");
    render(<SystemView />);

    const toggleButton = screen.getByRole("button", { name: "收起 Mona 系统管家" });
    expect(toggleButton.querySelector("svg")).toBeTruthy();
    expect(toggleButton.textContent).toBe("");
    expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggleButton);

    const assistant = document.querySelector('aside[aria-label="Mona 系统管家"]')!;
    expect(assistant.getAttribute("aria-hidden")).toBe("true");
    const expandButton = screen.getByRole("button", { name: "展开 Mona 系统管家" });
    expect(expandButton.querySelector('img[src="/brand/mona_app_icon.png"]')).toBeTruthy();
    expect(screen.queryByRole("separator", { name: "调整系统管家宽度" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开 Mona 系统管家" }));
    expect(document.querySelector('aside[aria-label="Mona 系统管家"]')?.getAttribute("aria-hidden")).toBe("false");
    expect(screen.getByRole("button", { name: "收起 Mona 系统管家" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "调整系统管家宽度" })).toBeInTheDocument();

    localStorage.removeItem("system.assistantCollapsed");
  });

  it("switches between all five system panels", () => {
    render(<SystemView />);

    expect(screen.getByRole("heading", { name: "电脑状态概览" })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "系统模块导航" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "存储空间" }));
    expect(screen.getByText(/选择磁盘并开始扫描/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "软件管理" }));
    expect(screen.getByRole("heading", { name: "国内常用" })).toBeTruthy();

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
    const heading = screen.getByRole("heading", { name: "Mona", exact: true });
    expect(heading.closest("header")?.parentElement?.tagName).toBe("ASIDE");
    expect(screen.getByRole("tablist", { name: "系统模块导航" }).closest('[data-panel]')).toHaveAttribute("id", "system-main");
    expect(heading.closest('[data-panel]')).toHaveAttribute("id", "system-assistant");
    expect(heading.closest("header")).toContainElement(screen.getByRole("button", { name: "收起 Mona 系统管家" }));
    const list = await screen.findByRole("list", { name: "系统健康检查" });
    expect(list.closest('[data-panel]')).toHaveAttribute("id", "system-main");
    expect(within(list).getByRole("button", { name: "待重启状态", exact: true })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Mona 系统管家" })).queryByText("巡检发现")).toBeNull();
    expect(screen.getByTestId("inspection-card-software")).toBeTruthy();
    expect(screen.getByTestId("inspection-card-software").closest("ul")).toBe(list);
    expect(within(list).queryByRole("button", { name: "软件更新", exact: true })).toBeNull();
    const update = screen.getByRole("button", { name: "全部更新" });
    expect(update).toHaveClass("bg-background", "border-input", "h-8");
    expect(update).not.toHaveClass("mona-interaction-button", "w-28");
    expect(screen.queryByRole("button", { name: "生成更新方案" })).toBeNull();
    expect(screen.queryByRole("button", { name: "释放 C 盘可清理空间" })).toBeNull();
    expect(screen.getByRole("separator", { name: "调整系统管家宽度" })).toBeInTheDocument();
  });

  it("executes all updates directly from the health row without opening Mona or requesting a plan", async () => {
    render(<SystemView />);
    const list = await screen.findByRole("list", { name: "系统健康检查" });
    fireEvent.click(screen.getByRole("button", { name: "收起 Mona 系统管家" }));
    fireEvent.click(await within(list).findByRole("button", { name: "全部更新" }));

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_upgrade_software", { id: "Google.Chrome.EXE", name: "Google Chrome" }));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_upgrade_software", { id: "Microsoft.VisualStudioCode", name: "Visual Studio Code" });
    expect(await screen.findByText("2 项更新完成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开 Mona 系统管家" })).toBeInTheDocument();
    expect(systemAgentMock.collect).not.toHaveBeenCalled();
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
    expect(systemAgentMock.execute).not.toHaveBeenCalled();
  });

  it("confirms the direct cleanup scope and keeps the measured remaining space", async () => {
    storageScanMock.mockResolvedValueOnce({
      scanId: "direct-cleanup",
      disks: [], directories: [], fileTypes: [], totalScannedGb: 2,
      cleanupItems: [
        { id: "temp", name: "临时文件", sizeGb: 1.5, path: "C:\\Temp", cleanable: true, recommended: true, reason: "缓存" },
        { id: "optional", name: "需自行审查", sizeGb: 2, path: "C:\\Optional", cleanable: true, recommended: false, reason: "需审查" },
        { id: "windows_old", name: "旧系统", sizeGb: 8, path: "C:\\Windows.old", cleanable: false, recommended: false, reason: "交由系统" },
      ],
    });
    render(<SystemView initialTab="storage" />);
    fireEvent.click(await getStartStorageScanButton());
    await screen.findByText("临时文件");
    fireEvent.click(screen.getByRole("tab", { name: "概览" }));
    const row = await screen.findByTestId("inspection-card-storage");
    fireEvent.click(within(row).getByRole("button", { name: "清理", exact: true }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("临时文件")).toBeInTheDocument();
    expect(within(dialog).queryByText("需自行审查")).toBeNull();
    expect(within(dialog).queryByText("旧系统")).toBeNull();
    expect(cleanupMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("clean_storage", { ids: ["temp"] }));
    expect(await screen.findByText("清理完成，实际释放 0.5 GB")).toBeInTheDocument();
    expect(within(row).getByText("1.0 GB")).toBeInTheDocument();
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("closes the overview cleanup dialog while cleaning and keeps its busy action across tabs", async () => {
    let resolveCleanup!: (result: StorageCleanupResult) => void;
    cleanupMock.mockReturnValueOnce(new Promise<StorageCleanupResult>((resolve) => { resolveCleanup = resolve; }));
    storageScanMock.mockResolvedValueOnce({
      scanId: "pending-direct-cleanup",
      disks: [], directories: [], fileTypes: [], totalScannedGb: 2,
      cleanupItems: [{ id: "temp", name: "临时文件", sizeGb: 1.5, path: "C:\\Temp", cleanable: true, recommended: true, reason: "缓存" }],
    });
    render(<SystemView initialTab="storage" />);
    fireEvent.click(await getStartStorageScanButton());
    await screen.findByText("临时文件");
    fireEvent.click(screen.getByRole("tab", { name: "概览" }));

    const row = await screen.findByTestId("inspection-card-storage");
    fireEvent.click(within(row).getByRole("button", { name: "清理", exact: true }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("clean_storage", { ids: ["temp"] }));

    expect(screen.queryByRole("alertdialog")).toBeNull();
    const busyButton = within(row).getByRole("button", { name: "正在清理" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    expect(busyButton.querySelector("svg.animate-spin")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "启动项" }));
    expect(await screen.findByRole("columnheader", { name: "发布者" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "概览" }));
    const returnedRow = await screen.findByTestId("inspection-card-storage");
    const returnedBusyButton = within(returnedRow).getByRole("button", { name: "正在清理" });
    expect(returnedBusyButton).toBeDisabled();
    expect(returnedBusyButton).toHaveAttribute("aria-busy", "true");
    expect(returnedBusyButton.querySelector("svg.animate-spin")).toBeTruthy();

    await act(async () => {
      resolveCleanup({
        freedGb: 0.5,
        cleanedIds: ["temp"],
        failures: [],
        verification: [{ id: "temp", path: "C:\\Temp", beforeBytes: 1_610_612_736, afterBytes: 1_073_741_824 }],
      });
    });
    expect(await screen.findByText("清理完成，实际释放 0.5 GB")).toBeInTheDocument();
    expect(within(returnedRow).getByText("1.0 GB")).toBeInTheDocument();
  });

  it("confirms one cleanup item and keeps row progress independent in the background", async () => {
    let resolveCleanup!: (result: StorageCleanupResult) => void;
    overviewDisksMock.value = [{ driveLetter: "C:\\", usagePercent: 81, usedGb: 86.5, totalGb: 106.1, availableGb: 19.6 }];
    cleanupMock.mockReturnValueOnce(new Promise<StorageCleanupResult>((resolve) => { resolveCleanup = resolve; }));
    storageScanMock.mockResolvedValueOnce({
      scanId: "pending-panel-cleanup",
      disks: [], directories: [], fileTypes: [], totalScannedGb: 2,
      cleanupItems: [
        { id: "temp", name: "临时文件", sizeGb: 1.5, path: "C:\\Temp", cleanable: true, recommended: true, reason: "缓存" },
        { id: "edge_cache", name: "Edge 缓存", sizeGb: 0.8, path: "C:\\EdgeCache", cleanable: true, recommended: false, reason: "浏览器缓存" },
      ],
    });
    render(<SystemView initialTab="storage" />);
    fireEvent.click(await getStartStorageScanButton());
    await screen.findByText("临时文件");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "预览清单" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清理临时文件" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/将直接删除临时文件，预计释放 1.5 GB/)).toBeInTheDocument();
    expect(cleanupMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("clean_storage", { ids: ["temp"] }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const row = screen.getByRole("button", { name: "正在清理临时文件" });
    const otherRow = screen.getByRole("button", { name: "清理Edge 缓存" });
    const busyButton = row;
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    expect(busyButton.querySelector("svg.animate-spin")).toBeTruthy();
    expect(otherRow).toBeEnabled();
    expect(screen.getByText("清理在后台进行，可继续操作其他内容。")).toBeInTheDocument();

    await act(async () => {
      resolveCleanup({
        freedGb: 0.5,
        cleanedIds: ["temp"],
        failures: [],
        verification: [{ id: "temp", path: "C:\\Temp", beforeBytes: 1_610_612_736, afterBytes: 1_073_741_824 }],
      });
    });
    expect(await screen.findByText("C: 临时文件清理完成，实际释放 0.5 GB")).toBeInTheDocument();
  });

  it.each(["failed", "unknown"])("shows an incomplete native update with a link to verify its result: %s", async (status) => {
    if (status === "failed") nativeUpgradeMock.mockResolvedValueOnce({ success: false, message: "更新失败", exitCode: 1, residuals: [] });
    else nativeUpgradeMock.mockRejectedValueOnce(new Error("更新结果未返回"));
    render(<SystemView />);
    fireEvent.click(await screen.findByRole("button", { name: "全部更新" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("部分软件更新未完成")).toBeInTheDocument();
    expect(within(dialog).getByText(status === "failed" ? /1 项完成，1 项失败/ : /1 项完成，1 项结果待确认/)).toBeInTheDocument();
    expect(screen.queryByText("2 项更新完成")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "查看更新" }));
    expect(await screen.findByRole("button", { name: "更新 Google Chrome" })).toBeInTheDocument();
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
  });

  it("keeps uncleaned space visible and shows an actionable cleanup failure", async () => {
    storageScanMock.mockResolvedValueOnce({
      scanId: "cleanup-failure",
      disks: [], directories: [], fileTypes: [], totalScannedGb: 2,
      cleanupItems: [{ id: "temp", name: "临时文件", sizeGb: 1.5, path: "C:\\Temp", cleanable: true, recommended: true, reason: "缓存" }],
    });
    cleanupMock.mockResolvedValueOnce({ freedGb: 0, cleanedIds: [], failures: ["清理项无法读取"], verification: [] });
    render(<SystemView initialTab="storage" />);
    fireEvent.click(await getStartStorageScanButton());
    await screen.findByText("临时文件");
    fireEvent.click(screen.getByRole("tab", { name: "概览" }));
    const row = await screen.findByTestId("inspection-card-storage");
    fireEvent.click(within(row).getByRole("button", { name: "清理", exact: true }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "确认清理" }));
    const error = await screen.findByRole("heading", { name: "清理未完成" });
    expect(within(row).getByText("1.5 GB")).toBeInTheDocument();
    expect(within(error.closest('[role="alertdialog"]')!).getByRole("button", { name: "查看清理项" })).toBeInTheDocument();
    expect(screen.queryByText(/清理完成，实际释放/)).toBeNull();
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
  });

  it("resizes the assistant by dragging and restores its width and draft after reopening", async () => {
    const initialStyleSheets = [...document.adoptedStyleSheets];
    let measured = false;
    const panelWidth = (element: HTMLElement) => {
      if (!measured) return element.id === "system-main" ? 840 : 360;
      const percentage = parseFloat(element.style.flexGrow);
      return (Number.isFinite(percentage) ? percentage : element.id === "system-main" ? 70 : 30) * 12;
    };
    const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")!.get!;
    const originalLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft")!.get!;
    const widthMock = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-panel") ? panelWidth(this) : originalWidth.call(this);
    });
    const leftMock = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      const mainWidth = document.getElementById("system-main")?.offsetWidth ?? 840;
      if (this.id === "system-main") return 0;
      if (this.hasAttribute("data-separator")) return mainWidth;
      if (this.id === "system-assistant") return mainWidth + 1;
      return originalLeft.call(this);
    });
    const boundsMock = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const mainWidth = document.getElementById("system-main")?.offsetWidth ?? 840;
      if (this.id === "system-layout") return new DOMRect(0, 0, 1201, 600);
      if (this.hasAttribute("data-separator")) return new DOMRect(mainWidth, 0, 1, 600);
      if (this.id === "system-main") return new DOMRect(0, 0, this.offsetWidth, 600);
      if (this.id === "system-assistant") return new DOMRect(mainWidth + 1, 0, this.offsetWidth, 600);
      return new DOMRect();
    });
    try {
      render(<SystemView />);
      await screen.findByRole("list", { name: "系统健康检查" });
      measured = true;
      const assistant = screen.getByTestId("system-assistant");
      const input = screen.getByLabelText("描述系统维护目标");
      fireEvent.change(input, { target: { value: "保留我的问题" } });
      expect(assistant.offsetWidth).toBeCloseTo(360);

      const separator = screen.getByRole("separator", { name: "调整系统管家宽度" });
      const collapse = screen.getByRole("button", { name: "收起 Mona 系统管家" });
      // happy-dom lacks the browser's nullable ARIA attribute reflection.
      Object.defineProperty(separator, "ariaDisabled", { configurable: true, get: () => separator.getAttribute("aria-disabled") });
      const start = separator.getBoundingClientRect().left;
      fireEvent.pointerDown(separator, { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: start, clientY: 100 });
      fireEvent.pointerMove(document, { pointerId: 1, pointerType: "mouse", buttons: 1, clientX: start - 120, clientY: 100 });
      fireEvent.pointerUp(document, { pointerId: 1, pointerType: "mouse", buttons: 0, clientX: start - 120, clientY: 100 });
      expect(assistant.offsetWidth).toBeCloseTo(480);

      separator.focus();
      fireEvent.keyDown(separator, { key: "ArrowLeft" });
      expect(assistant.offsetWidth).toBeCloseTo(540);
      fireEvent.keyDown(separator, { key: "ArrowLeft" });
      fireEvent.keyDown(separator, { key: "ArrowLeft" });
      expect(assistant.offsetWidth).toBeCloseTo(600);

      fireEvent.click(collapse);
      expect(assistant.offsetWidth).toBe(0);
      fireEvent.click(document.querySelector('button[aria-label="展开 Mona 系统管家"]')!);
      expect(assistant.offsetWidth).toBeCloseTo(600);
      expect(screen.getByLabelText("描述系统维护目标")).toBe(input);
      expect(input).toHaveValue("保留我的问题");
    } finally {
      boundsMock.mockRestore();
      leftMock.mockRestore();
      widthMock.mockRestore();
      document.adoptedStyleSheets = initialStyleSheets;
    }
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

      expect(await screen.findByRole("heading", { name: "系统健康检查" })).toBeTruthy();
      const row = screen.getByTestId("inspection-card-scan-storage");
      expect(within(row).getByText("C 盘空间紧张")).toBeTruthy();
      expect(within(row).getAllByRole("button")).toHaveLength(1);
      expect(within(row).getByRole("button", { name: "查看并扫描" })).not.toHaveAttribute("aria-expanded");
      expect(storageScanMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "查看并扫描" }));
      expect(await screen.findByRole("tablist", { name: "存储文件操作" })).toBeTruthy();

  } finally {
      localStorage.removeItem("system.storageScan");
    }
  });

  it("does not treat the initial startup inventory as newly added", async () => {
    render(<SystemView />);

    await screen.findByRole("heading", { name: "系统健康检查" });
    expect(screen.queryByText("启动项有新增", { exact: true })).toBeNull();
  });

  it("scans the drive named in the health warning instead of the previously selected drive", async () => {
    overviewDriveMock.value = "D:\\";
    render(<SystemView />);
    expect(await screen.findByText("D:\\空间紧张", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看并扫描" }));

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("scan_storage", { drive: "D:" }));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("scan_storage", { drive: "C:" });
  });

  it("shows a failed review confirmation and retains the pending startup review", async () => {
    startupIssueMock.isNew = true;
    startupIssueMock.reviewFailure = true;
    render(<SystemView initialTab="startup" />);
    fireEvent.click(await screen.findByRole("button", { name: "标记已审查" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("无法确认审查状态")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "重新读取" })).toBeInTheDocument();
    expect(startupIssueMock.isNew).toBe(true);
  });

  it("only marks startup items reviewed after the user explicitly confirms review", async () => {
    startupIssueMock.isNew = true;
    render(<SystemView />);

    expect(await screen.findByText("启动项有新增", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "审查启动项" }));
    expect(await screen.findByRole("heading", { name: "启动应用" })).toBeTruthy();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("system_acknowledge_startup_items", {});
    fireEvent.click(await screen.findByRole("button", { name: "标记已审查" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_acknowledge_startup_items", {}));

    fireEvent.click(screen.getByRole("tab", { name: "概览" }));
    await waitFor(() => expect(screen.queryByText("启动项有新增", { exact: true })).toBeNull());
  });

  it("refreshes the lightweight health sources without starting a full disk scan", async () => {
    render(<SystemView />);
    const recheck = await screen.findByRole("button", { name: "重新检查" });
    await waitFor(() => expect(recheck).toBeEnabled());
    vi.mocked(invoke).mockClear();
    storageScanMock.mockClear();
    fireEvent.click(recheck);

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_check_updates"));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_check_pending_reboot");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_list_startup_items");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_get_boot_history");
    expect(storageScanMock).not.toHaveBeenCalled();
    await waitFor(() => expect(recheck).toBeEnabled());
  });

  it("does not warn about insignificant boot-time fluctuations", async () => {
    bootDeltaMock.value = 100;
    render(<SystemView />);
    await screen.findByRole("heading", { name: "系统健康检查" });
    expect(screen.queryByText("启动耗时增加", { exact: true })).toBeNull();
  });

  it("offers the startup trend for a slower boot without clearing startup review flags", async () => {
    bootDeltaMock.value = 5_000;
    render(<SystemView />);
    fireEvent.click(await screen.findByRole("button", { name: "查看启动趋势" }));
    expect(await screen.findByRole("heading", { name: "启动耗时趋势（最近 7 次启动）" })).toBeInTheDocument();
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("system_acknowledge_startup_items", {});
  });

  it("prevents duplicate native updates across the overview and software list", async () => {
    let finishUpgrade!: () => void;
    nativeUpgradeMock.mockReturnValueOnce(new Promise((resolve) => {
      finishUpgrade = () => resolve({ success: true, message: "完成", exitCode: 0, residuals: [] });
    }));
    render(<SystemView />);
    const update = await screen.findByRole("button", { name: "全部更新" });
    fireEvent.click(update);
    await waitFor(() => expect(nativeUpgradeMock).toHaveBeenCalledTimes(1));
    expect(update).toBeDisabled();
    fireEvent.click(update);
    expect(nativeUpgradeMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: /^软件管理/ }));
    fireEvent.click(screen.getByRole("tab", { name: "我的软件" }));
    expect(await screen.findByRole("button", { name: "正在更新 Google Chrome" })).toBeDisabled();
    await act(async () => finishUpgrade());
    await waitFor(() => expect(nativeUpgradeMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("2 项更新完成")).toBeInTheDocument();
    expect(systemAgentMock.plan).not.toHaveBeenCalled();
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
    const sortButton = screen.getByRole("button", { name: "按 CPU 排序" });
    const table = sortButton.closest("table")!;
    fireEvent.click(sortButton);

    expect(within(table).getAllByRole("row").slice(1).map((row) => (row as HTMLTableRowElement).cells[0].textContent)).toEqual([
      "Slack.exe",
      "Code.exe",
      "Chrome.exe",
    ]);
  });

  it("uses verified software data and invokes the installer for selected updates", async () => {
    render(<SystemView initialTab="software" />);

    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    expect(await screen.findByRole("heading", { name: "我的软件" })).toBeTruthy();
    expect(screen.queryByText(/428 MB/)).toBeNull();
    expect(screen.queryByText(/19\.6 GB/)).toBeNull();
    expect(screen.queryByText(/已知占用/)).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Google Chrome" }));
    fireEvent.click(screen.getByRole("button", { name: "更新所选" }));

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "system_upgrade_software",
      { id: "Google.Chrome.EXE", name: "Google Chrome" },
    ));
    expect(await screen.findByText("1 项更新完成")).toBeTruthy();
  });

  it("combines installed software and updates under my software", async () => {
    render(<SystemView initialTab="software" />);

    expect(await screen.findByRole("tab", { name: "我的软件" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "软件更新" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "已安装软件" })).toBeNull();
    expect(screen.getByRole("tab", { name: "卸载记录" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "国内常用" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "软件" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "我的软件" }));
    expect(await screen.findByRole("columnheader", { name: "软件" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "可更新 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "更新 Google Chrome" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "卸载 Notepad++" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "卸载记录" }));
    expect(await screen.findByText("卸载 Notepad++")).toBeTruthy();
    expect(screen.getByText("安装服务 卸载完成")).toBeTruthy();
  });

  it("searches the app catalog and installs an exact result", async () => {
    render(<SystemView initialTab="software" />);

    expect(await screen.findByRole("heading", { name: "国内常用" })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "微信 图标" })[0].getAttribute("src")).toContain("api.iconify.design");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索全部应用" }), {
      target: { value: "微信" },
    });

    expect(await screen.findByText("WeChat")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "获取 WeChat" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "system_install_app",
      { id: "Tencent.WeChat", name: "WeChat" },
    ));
  });

  it("keeps curated apps in their functional categories", async () => {
    render(<SystemView initialTab="software" />);

    fireEvent.click(await screen.findByRole("button", { name: "社交通讯" }));
    expect(screen.getByRole("heading", { name: "社交通讯" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /微信 聊天/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /QQ 聊天/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Visual Studio Code 轻量/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "开发工具" }));
    expect(screen.getByRole("heading", { name: "开发工具" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Visual Studio Code 轻量/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Git 分布式/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /微信 聊天/ })).toBeNull();
  });

  it("resolves and caches an icon for catalog search results", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ icons: String(input).includes("Portty") ? [] : ["arcticons:xmind"] }),
    })));
    render(<SystemView initialTab="software" />);

    fireEvent.change(await screen.findByRole("textbox", { name: "搜索全部应用" }), {
      target: { value: "xmind" },
    });

    expect(await screen.findByText("XMind 8")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("img", { name: "XMind 8 图标" }).getAttribute("src"))
      .toContain("api.iconify.design/arcticons/xmind.svg"));
    expect(localStorage.getItem("system.appStoreIconCache.v1")).toContain("xmind.xmind.8");
  });

  it("requires confirmation before uninstalling and shows only detected residual candidates", async () => {
    render(<SystemView initialTab="software" />);

    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    fireEvent.click(await screen.findByRole("button", { name: "卸载 Notepad++" }));
    fireEvent.click(screen.getByRole("button", { name: "确认卸载 Notepad++" }));

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "system_uninstall_software",
      { id: "notepad", name: "Notepad++", installLocation: "C:\\Program Files\\Notepad++" },
    ));
    expect(await screen.findByText("C:\\Users\\Mona\\AppData\\Roaming\\Notepad++")).toBeTruthy();
    expect(screen.getByText("疑似残留，删除前需确认")).toBeTruthy();
  });

  it("shows uninstall progress ahead of an old failure for a name-matched update and handles pending without retry", async () => {
    const installed = { id: "installed.notepad", name: "Notepad++", publisher: "Notepad++ Team", version: "8.7", installDate: null, softwareType: "system", estimatedSizeBytes: 104857600, installLocation: "C:\\Program Files\\Notepad++", uninstallKind: "desktop", canUninstall: true };
    const update = { id: "update.notepad", name: "Notepad++", publisher: "Notepad++ Team", currentVersion: "8.7", nextVersion: "8.8", status: "可更新" };
    const oldFailure = { packageId: installed.id, name: installed.name, action: "uninstall", ts: 1715472000, message: "上次卸载未完成" };
    const inventory = makeSoftwareCheck({ updates: [update], installed: [installed], installedCount: 1, failures: [oldFailure], failedCount: 1 });
    const refreshedInventory = makeSoftwareCheck({ updates: [update], installed: [], installedCount: 0, failures: [oldFailure], failedCount: 1 });
    softwareCheckControl.results.push(inventory, refreshedInventory);
    let resolveUninstall!: (result: SoftwareActionResult) => void;
    uninstallResultMock.mockReturnValueOnce(new Promise<SoftwareActionResult>((resolve) => { resolveUninstall = resolve; }));
    render(<SystemView initialTab="software" />);

    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    expect(await screen.findByText("Notepad++ · 卸载失败")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "卸载 Notepad++" }));
    fireEvent.click(screen.getByRole("button", { name: "确认卸载 Notepad++" }));
    expect(screen.queryByRole("button", { name: "确认卸载 Notepad++" })).toBeNull();
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_uninstall_software", {
      id: installed.id,
      name: installed.name,
      installLocation: installed.installLocation,
    }));
    expect(screen.getByText("正在卸载", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Notepad++ · 卸载失败")).toBeNull();
    const updateButton = screen.getByRole("button", { name: "更新 Notepad++" });
    expect(updateButton).toBeDisabled();
    expect(updateButton.querySelector("svg.animate-spin")).toBeNull();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "system_uninstall_software")).toHaveLength(1);

    await act(async () => {
      resolveUninstall({ success: false, pending: true, message: "卸载登记尚未确认", exitCode: null, residuals: [] });
    });
    expect(await screen.findByText("卸载结果待确认")).toBeInTheDocument();
    expect(screen.queryByTestId("system-task-failure")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(within(screen.getByText("卸载结果待确认").closest('[role="alert"]')!).getByRole("button", { name: "重新扫描" })).toBeEnabled();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "system_uninstall_software")).toHaveLength(1);
  });

  it("treats a disconnected uninstall IPC as pending and performs only a read-only refresh", async () => {
    uninstallResultMock.mockRejectedValueOnce(new Error("IPC disconnected"));
    render(<SystemView initialTab="software" />);
    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    fireEvent.click(await screen.findByRole("button", { name: "卸载 Notepad++" }));
    fireEvent.click(screen.getByRole("button", { name: "确认卸载 Notepad++" }));

    expect(await screen.findByText("卸载结果待确认")).toBeInTheDocument();
    const pendingNotice = screen.getByText("卸载结果待确认").closest('[role="alert"]')!;
    const diagnosticDetails = within(pendingNotice).getByText("查看详情").closest("details")!;
    expect(diagnosticDetails).not.toHaveAttribute("open");
    fireEvent.click(within(pendingNotice).getByText("查看详情"));
    expect(diagnosticDetails).toHaveAttribute("open");
    expect(within(pendingNotice).getByText("Error: IPC disconnected")).toBeInTheDocument();
    expect(screen.queryByText("卸载 Notepad++ 失败")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "system_uninstall_software")).toHaveLength(1);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "system_check_updates")).toHaveLength(2);
  });

  it("keeps a confirmed uninstall successful when the follow-up inventory refresh fails", async () => {
    uninstallResultMock.mockResolvedValueOnce({ success: true, message: "卸载完成", exitCode: 0, residuals: [] });
    render(<SystemView initialTab="software" />);
    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    fireEvent.click(await screen.findByRole("button", { name: "卸载 Notepad++" }));
    softwareCheckControl.failNext = true;
    fireEvent.click(screen.getByRole("button", { name: "确认卸载 Notepad++" }));

    expect(await screen.findByText("已确认卸载完成，未发现高置信度残留候选。")).toBeInTheDocument();
    expect(screen.getByText("软件信息读取失败：Error: 软件列表刷新失败")).toBeInTheDocument();
    expect(screen.queryByText("卸载 Notepad++ 失败")).toBeNull();
  });

  it.each([1641, 3010])("keeps MSI exit code %s successful and tells the user to restart", async (exitCode) => {
    uninstallResultMock.mockResolvedValueOnce({ success: true, message: "安装程序已完成卸载操作", exitCode, residuals: [] });
    render(<SystemView initialTab="software" />);
    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    fireEvent.click(await screen.findByRole("button", { name: "卸载 Notepad++" }));
    fireEvent.click(screen.getByRole("button", { name: "确认卸载 Notepad++" }));

    expect(await screen.findByText("卸载已完成，需要重启")).toBeInTheDocument();
    expect(screen.getByText(/重启电脑后即可完成卸载/)).toBeInTheDocument();
    expect(screen.queryByText("已确认卸载完成，未发现高置信度残留候选。")).toBeNull();
    expect(screen.queryByText("卸载 Notepad++ 失败")).toBeNull();
  });

  it("opens a residual location and deletes selected candidates after confirmation", async () => {
    const path = "C:\\Users\\Mona\\AppData\\Roaming\\Notepad++";
    render(<SystemView initialTab="software" />);

    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    fireEvent.click(await screen.findByRole("button", { name: "卸载 Notepad++" }));
    fireEvent.click(screen.getByRole("button", { name: "确认卸载 Notepad++" }));
    expect(await screen.findByText(path)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `打开 ${path}` }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("system_reveal_in_explorer", { path }));

    expect(screen.getByRole("checkbox", { name: `选择残留 ${path}` })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "删除所选残留（1 项）" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText("将删除选中的 1 项残留，共 2 KB。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "确认删除残留" }));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "system_delete_software_residuals",
      { ids: ["notepad-roaming"], confirmed: true },
    ));
    expect(await screen.findByText("已删除 1 项，释放 2 KB。")).toBeTruthy();
    expect(screen.queryByText(path)).toBeNull();
  });

  it("keeps failed residual candidates visible after a partial cleanup", async () => {
    const firstPath = "C:\\Users\\Mona\\AppData\\Roaming\\Notepad++";
    const secondPath = "C:\\Users\\Mona\\AppData\\Local\\Notepad++";
    uninstallResultMock.mockResolvedValueOnce({
      success: true,
      message: "卸载完成",
      exitCode: 0,
      residuals: [
        { id: "notepad-roaming", path: firstPath, sizeBytes: 2048, category: "应用数据", requiresConfirmation: true, kind: "directory", confidence: "high", recommended: true, canDelete: true, reason: "卸载后留下的应用数据目录" },
        { id: "notepad-local", path: secondPath, sizeBytes: 4096, category: "缓存", requiresConfirmation: true, kind: "directory", confidence: "medium", recommended: false, canDelete: true, reason: "可能是应用缓存，删除前请确认" },
        { id: "notepad-registry", path: "HKCU\\Software\\Notepad++", sizeBytes: 0, category: "注册表", requiresConfirmation: true, kind: "registry", confidence: "medium", recommended: false, canDelete: false, reason: "仅检测到可能关联的注册表项" },
      ],
    });
    residualDeleteMock.mockResolvedValueOnce({
      deletedIds: ["notepad-roaming"],
      freedBytes: 2048,
      failures: [{ id: "notepad-local", message: "文件正在使用" }],
    });
    render(<SystemView initialTab="software" />);

    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    fireEvent.click(await screen.findByRole("button", { name: "卸载 Notepad++" }));
    fireEvent.click(screen.getByRole("button", { name: "确认卸载 Notepad++" }));
    expect(await screen.findByText(secondPath)).toBeTruthy();
    expect(screen.getByText("建议清理")).toBeTruthy();
    expect(screen.getByText("需要确认")).toBeTruthy();
    expect(screen.getByText("仅检测")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "选择建议项" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: `选择残留 ${firstPath}` })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: `选择残留 ${secondPath}` })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: "选择残留 HKCU\\Software\\Notepad++" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "打开 HKCU\\Software\\Notepad++" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: `选择残留 ${secondPath}` }));
    fireEvent.click(screen.getByRole("button", { name: "删除所选残留（2 项）" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认删除残留" }));

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "system_delete_software_residuals",
      { ids: ["notepad-roaming", "notepad-local"], confirmed: true },
    ));
    expect(screen.queryByText(firstPath)).toBeNull();
    expect(await screen.findByText(secondPath)).toBeTruthy();
    expect(screen.getByText("部分残留未能删除")).toBeTruthy();
    expect(screen.getByText("文件正在使用")).toBeTruthy();
  });

  it("disables uninstall for software without a registered uninstall command", async () => {
    render(<SystemView initialTab="software" />);

    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    const uninstallButton = screen.getByRole("button", { name: "卸载 Unknown Tool" });

    expect(uninstallButton).toBeDisabled();
    expect(uninstallButton).toHaveAttribute("aria-disabled", "true");
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

  it("shows live per-drive cards before a deep scan", async () => {
    overviewDisksMock.value = [
      { driveLetter: "C:\\", usagePercent: 81, usedGb: 86.5, totalGb: 106.1, availableGb: 19.6 },
      { driveLetter: "D:\\", usagePercent: 42, usedGb: 84, totalGb: 200, availableGb: 116 },
    ];
    const scanCallsBeforeRender = storageScanMock.mock.calls.length;
    render(<SystemView initialTab="storage" />);

    const diskGroup = await screen.findByRole("group", { name: "磁盘" });
    expect(await within(diskGroup).findByRole("button", { name: "查看 C: 磁盘" })).toBeTruthy();
    expect(within(diskGroup).getByRole("button", { name: "查看 D: 磁盘" })).toBeTruthy();
    expect(within(diskGroup).getByText("81%")).toBeTruthy();
    expect(within(diskGroup).getByText("42%")).toBeTruthy();
    expect(within(diskGroup).getByText("可用 19.6 GB / 共 106.1 GB")).toBeTruthy();
    expect(within(diskGroup).getByText("可用 116.0 GB / 共 200.0 GB")).toBeTruthy();
    expect(within(diskGroup).getByRole("button", { name: "开始扫描" })).toBeTruthy();
    expect(within(diskGroup).getByRole("button", { name: "D: 开始扫描" })).toBeTruthy();
    const storageMain = screen.getByRole("main");
    expect(within(storageMain).queryByRole("combobox")).toBeNull();
    expect(within(storageMain).queryByText("总容量", { exact: true })).toBeNull();
    expect(within(storageMain).queryByText("已使用", { exact: true })).toBeNull();
    expect(within(storageMain).queryByText("可安全释放", { exact: true })).toBeNull();
    expect(within(storageMain).queryByRole("heading", { name: "Mona 发现" })).toBeNull();
    expect(within(storageMain).queryByRole("button", { name: "分析当前范围" })).toBeNull();
    expect(storageScanMock).toHaveBeenCalledTimes(scanCallsBeforeRender);
  });

  it("shows the storage actions before scanning without duplicate analysis panels", async () => {
    render(<SystemView initialTab="storage" />);

    expect(await screen.findByRole("button", { name: /查看 C/ })).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "存储文件操作" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "清理空间" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "大文件" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /重点路径占用|空间分布|目录占用|安全清理/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Mona 发现" })).toBeNull();
    expect(screen.queryByRole("button", { name: "分析当前范围" })).toBeNull();
    expect(screen.queryByText("待分析")).toBeNull();
  });

  it("opens Mona and analyzes only the explicitly clicked large file with one click", async () => {
    localStorage.setItem("system.assistantCollapsed", "true");
    storageScanMock.mockResolvedValueOnce({
      scanId: "scan-complete", disks: [], directories: [], cleanupItems: [], fileTypes: [], totalScannedGb: 10,
      topFiles: [
        { id: "file-db", path: "C:\\Users\\PrivateUser\\.codex\\thread_history.sqlite", parentDirName: ".codex", extension: "sqlite", sizeGb: 4.1, modifiedBucket: "recent" },
        { id: "file-bin", path: "C:\\Data\\model.bin", parentDirName: "Data", extension: "bin", sizeGb: 1.2, modifiedBucket: "old" },
      ],
    });
    let finish!: (result: { scanId: string; summary: string; findings: []; cautions: [] }) => void;
    systemAgentMock.storageAnalyze.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<SystemView initialTab="storage" />);
    fireEvent.click(await getStartStorageScanButton());
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "大文件" }), { button: 0, ctrlKey: false });
    const analyze = await screen.findByRole("button", { name: "分析 thread_history.sqlite" });
    expect(systemAgentMock.storageAnalyze).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "展开 Mona 系统管家" })).toBeInTheDocument();
    fireEvent.click(analyze);
    await waitFor(() => expect(systemAgentMock.storageAnalyze).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem("system.assistantCollapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "收起 Mona 系统管家" })).toBeInTheDocument();
    expect(analyze).toBeDisabled();
    expect(screen.getByRole("button", { name: "分析 model.bin" })).toBeEnabled();
    const evidence = systemAgentMock.storageAnalyze.mock.calls[0][1];
    expect(evidence.selectedFile).toMatchObject({ id: "file-db", name: "thread_history.sqlite", location: "~/.codex" });
    expect(evidence.largeFiles).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toMatch(/PrivateUser|C:|model.bin|"path"/);
    await act(async () => finish({ scanId: "scan-complete", summary: "这是会话历史数据库，建议保留。", findings: [], cautions: [] }));
    expect(await screen.findByText("这是会话历史数据库，建议保留。")).toBeInTheDocument();
    expect(analyze).toBeEnabled();
    expect(systemAgentMock.storageAnalyze).toHaveBeenCalledTimes(1);
  });

  it.each(["directory list", "treemap"])("starts scoped conversation analysis directly from the %s context menu", async (entry) => {
    localStorage.setItem("system.assistantCollapsed", "true");
    storageScanMock.mockResolvedValueOnce({
      scanId: "scan-complete", disks: [], cleanupItems: [], fileTypes: [], totalScannedGb: 8,
      directories: [{ id: "dir-data", path: "C:\\Data", sizeGb: 8, fileCount: 4, directSizeGb: 8 }],
    });
    render(<SystemView initialTab="storage" />);
    fireEvent.click(await getStartStorageScanButton());
    const table = await screen.findByRole("treegrid", { name: "目录占用" });
    if (entry === "directory list") {
      fireEvent.contextMenu(within(table).getByRole("row", { name: /Data/ }), { clientX: 200, clientY: 200 });
    } else {
      fireEvent.contextMenu(screen.getByRole("button", { name: "Data，8.0 GB" }), { clientX: 500, clientY: 200 });
    }
    expect(systemAgentMock.storageAnalyze).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole(entry === "directory list" ? "button" : "menuitem", { name: "占用分析" }));
    await waitFor(() => expect(systemAgentMock.storageAnalyze).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem("system.assistantCollapsed")).toBe("false");
    expect(screen.getByRole("button", { name: "收起 Mona 系统管家" })).toBeInTheDocument();
    expect(systemAgentMock.storageAnalyze.mock.calls[0][1]).toMatchObject({ scope: { id: "dir-data", sizeGb: 8 }, selectedDirectory: { id: "dir-data", name: "Data" } });
    expect(systemAgentMock.storageAnalyze.mock.calls[0][0]).toContain("可执行的清理步骤");
    expect(await screen.findByText("主要空间来自当前目录。")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retains an active storage scan and its result across tab switches", async () => {
    let resolveScan!: (value: StorageScanResult) => void;
    overviewDisksMock.value = [{ driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50 }];
    storageScanMock.mockReturnValueOnce(new Promise((resolve) => { resolveScan = resolve; }));
    render(<SystemView initialTab="storage" />);

    fireEvent.click(await getStartStorageScanButton());
    expect(screen.getAllByText(/正在扫描磁盘/).length).toBeGreaterThan(0);

    fireEvent.click(await screen.findByRole("tab", { name: /软件管理/ }));
    fireEvent.click(await screen.findByRole("tab", { name: /存储空间/ }));
    expect(screen.getAllByText(/正在扫描磁盘/).length).toBeGreaterThan(0);

    fireEvent.click(await screen.findByRole("tab", { name: /软件管理/ }));
    await act(async () => resolveScan({
      scanId: "scan-complete",
      disks: [{ driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50 }],
      directories: [{ id: "dir-mona", path: "C:\\Users\\Mona", sizeGb: 20, fileCount: 10, directSizeGb: 20 }],
      cleanupItems: [{ id: "temp", name: "系统临时文件", sizeGb: 1.5, path: "C:\\Temp", cleanable: true, recommended: true, reason: "可安全清理" }],
      fileTypes: [{ category: "应用", sizeGb: 12 }],
      totalScannedGb: 20,
    }));
    fireEvent.click(await screen.findByRole("tab", { name: /存储空间/ }));
    expect(await screen.findByText("系统临时文件")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "存储文件操作" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "清理系统临时文件" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Mona 发现" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /空间分布|目录占用/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "分析当前范围" })).toBeNull();
    expect(screen.queryByRole("button", { name: "生成清理方案" })).toBeNull();
    expect(screen.queryByText(/已扫描区域|约占本盘已用空间/)).toBeNull();
    expect(screen.queryByText(/单击选择.*双击或按 Enter/)).toBeNull();
    expect(screen.queryByRole("button", { name: "在资源管理器中打开所选目录" })).toBeNull();
  });

  it("cancels an active scan without failure and preserves its result and rescan action", async () => {
    let resolveScan!: (value: StorageScanResult) => void;
    overviewDisksMock.value = [{ driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50 }];
    storageScanMock.mockReturnValueOnce(new Promise((resolve) => { resolveScan = resolve; }));
    render(<SystemView initialTab="storage" />);

    fireEvent.click(await getStartStorageScanButton());
    expect(screen.getAllByText(/正在扫描磁盘/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "取消扫描" }));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("cancel_storage_scan");

    await act(async () => resolveScan({
      scanId: "scan-cancelled",
      disks: [{ driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50 }],
      directories: [{ id: "dir-users", path: "C:\\Users", sizeGb: 8, fileCount: 4, directSizeGb: 8 }],
      cleanupItems: [],
      fileTypes: [{ category: "应用", sizeGb: 5 }],
      totalScannedGb: 8,
      scanSummary: { totalFiles: 4, totalDirs: 2, scanDurationSecs: 1.2, scannedDisk: "C:", cancelled: true },
    }));

    // 取消后保留已完成的扫描数据，清除正在扫描状态而不增加失败或覆盖提示。
    expect((await screen.findAllByText("Users")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("8.0 GB")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/正在扫描磁盘/)).toBeNull();
    expect(screen.queryByText(/扫描已取消|部分结果|已扫描区域|约占本盘已用空间/)).toBeNull();
    expect(screen.queryByText(/扫描失败|扫描未完成/)).toBeNull();
    expect(screen.queryByRole("button", { name: "取消扫描" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新扫描" })).toBeTruthy();
  });

  it("shows per-item cleanup actions without bulk selection or a preview list", async () => {
    let resolveScan!: (value: StorageScanResult) => void;
    storageScanMock.mockReturnValueOnce(new Promise((resolve) => { resolveScan = resolve; }));
    render(<SystemView initialTab="storage" />);

    fireEvent.click(await getStartStorageScanButton());
    await act(async () => resolveScan({
      scanId: "scan-cleanup",
      disks: [{ driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50 }],
      directories: [{ id: "dir-users", path: "C:\\Users", sizeGb: 8, fileCount: 4, directSizeGb: 8 }],
      cleanupItems: [
        { id: "temp", name: "系统临时文件", sizeGb: 1.5, path: "C:\\Windows\\Temp", cleanable: true, recommended: true, reason: "应用未占用的临时文件可安全清理" },
        { id: "windows_old", name: "Windows.old（旧系统文件）", sizeGb: 12, path: "C:\\Windows.old", cleanable: false, recommended: false, reason: "建议通过系统「存储感知」清理：设置 → 系统 → 存储 → 临时文件" },
      ],
      fileTypes: [],
      totalScannedGb: 8,
    }));

    expect(await screen.findByText("系统临时文件")).toBeTruthy();
    expect(screen.queryByText("Windows.old（旧系统文件）")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "预览清单" })).toBeNull();
    expect(screen.getByRole("button", { name: "清理系统临时文件" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "安全清理" })).toBeNull();
  });

  it("removes a handed-off software failure from the current task list", async () => {
    render(<SystemView initialTab="software" />);

    fireEvent.click(await screen.findByRole("tab", { name: "我的软件" }));
    expect(await screen.findByText(/安装器返回 1603/)).toBeTruthy();
    expect(screen.getByTestId("system-task-failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "交给 Mona" }));
    expect(screen.queryByTestId("system-task-failure")).toBeNull();
    expect((await screen.findByTestId("system-agent-handoff")).textContent).toContain("安装器返回 1603");
    expect(screen.getByRole("columnheader", { name: "软件" })).toBeTruthy();
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
    expect(systemAgentMock.plan).toHaveBeenCalledWith("释放 C 盘可清理空间", {}, expect.any(AbortSignal));
    expect(screen.getByText("更新 Google Chrome")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "启动项" }));
    expect(screen.getByText("更新 Google Chrome")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看软件管理依据" }));
    expect(screen.getByRole("heading", { name: "我的软件" })).toBeTruthy();
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
