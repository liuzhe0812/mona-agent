import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

import { SystemView } from "./SystemView";
import type { StorageScanResult } from "./useSystemData";

const storageScanMock = vi.hoisted(() => vi.fn<() => Promise<StorageScanResult>>(() => Promise.resolve({
  disks: [],
  directories: [],
  cleanupItems: [],
  fileTypes: [],
  totalScannedGb: 0,
})));

const systemAgentMock = vi.hoisted(() => ({
  collect: vi.fn(() => Promise.resolve({})),
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
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
        { id: "wechat", name: "WeChat", publisher: "Tencent", source: "注册表", scope: "user", command: "C:\\WeChat\\WeChat.exe", targetPath: "C:\\WeChat\\WeChat.exe", added: "2024/05/12", enabled: true, signed: true, firstSeenAt: 1715472000 },
        { id: "onedrive", name: "OneDrive", publisher: "Microsoft", source: "注册表", scope: "user", command: "C:\\OneDrive\\OneDrive.exe", targetPath: "C:\\OneDrive\\OneDrive.exe", added: "2024/01/15", enabled: true, signed: true, firstSeenAt: 1705276800 },
        { id: "teams", name: "Microsoft Teams Machine-Wide Installer With A Very Long Startup Name", publisher: "Microsoft", source: "注册表", scope: "user", command: "C:\\Teams\\Teams.exe", targetPath: "C:\\Teams\\Teams.exe", added: "2024/02/20", enabled: false, signed: true, firstSeenAt: 1708358400 },
        { id: "task:\\Updater|UpdateHelper", name: "UpdateHelper", publisher: "Example", source: "计划任务", scope: "machine", command: "C:\\Updater\\update.exe", targetPath: "C:\\Updater\\update.exe", added: null, enabled: true, signed: false, firstSeenAt: 1715472000 },
      ],
      total: 4,
      enabledCount: 3,
      disabledCount: 1,
    });
    if (command === "system_toggle_startup_item") return Promise.resolve();
    if (command === "system_batch_toggle_startup_items") return Promise.resolve(1);
    if (command === "system_get_boot_history") return Promise.resolve({ points: [], lastDurationMs: null, lastDeltaMs: null });
    if (command === "system_get_startup_changes") return Promise.resolve([]);
    if (command === "system_get_maintenance_history") return Promise.resolve({
      events: [
        { id: "software-7", ts: 1715472000, category: "更新", title: "更新 Visual Studio Code", source: "用户操作", status: "成功", detail: "WinGet 更新完成", bytesChanged: 0, reversible: false, relatedId: null, restoreEnabled: null },
        { id: "software-8", ts: 1715472060, category: "卸载", title: "卸载 Notepad++", source: "用户操作", status: "成功", detail: "WinGet 卸载完成", bytesChanged: 0, reversible: false, relatedId: null, restoreEnabled: null },
      ],
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
  it("switches between all five system panels", () => {
    render(<SystemView />);

    expect(screen.getByRole("heading", { name: "电脑状态概览" })).toBeTruthy();
    const headerIcon = screen.getByRole("heading", { name: "系统" }).closest("header")?.querySelector("img");
    expect(headerIcon).not.toBeNull();
    expect((headerIcon as HTMLImageElement).src).toContain("sidebar-system");

    fireEvent.click(screen.getByRole("tab", { name: "存储空间" }));
    expect(screen.getByText("扫描磁盘空间占用")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "软件管理" }));
    expect(screen.getByRole("heading", { name: "可用更新" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "启动项" }));
    expect(screen.getByRole("heading", { name: "启动应用" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "维护记录" }));
    expect(screen.getByRole("heading", { name: "维护时间线" })).toBeTruthy();
  });

  it("renders the overview controls beside one system-level Agent workspace", async () => {
    render(<SystemView />);

    expect(await screen.findByRole("button", { name: "10 分钟" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Mona 系统管家" })).toBeTruthy();
    expect(screen.getByText("告诉 Mona 你想改善什么")).toBeTruthy();
    expect(screen.getByTestId("system-layout").className).toContain(
      "min-[1440px]:grid-cols-[minmax(0,1fr)_360px]",
    );
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

    expect(screen.getByText("WeChat 已禁用，可随时恢复")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "切换 OneDrive 启动状态" }).getAttribute("aria-checked")).toBe("true");
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
    expect(storageScanMock).toHaveBeenCalledTimes(scanCallsBeforeRender);
  });

  it("keeps the complete storage prototype structure visible before scanning", async () => {
    render(<SystemView initialTab="storage" />);

    expect(await screen.findByRole("heading", { name: "磁盘分区" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /空间分布/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /文件类型/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /占用最大的目录/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "安全清理" })).toBeTruthy();
    expect(screen.getByText("待分析")).toBeTruthy();
  });

  it("retains an active storage scan and its result across tab switches", async () => {
    let resolveScan!: (value: StorageScanResult) => void;
    storageScanMock.mockReturnValueOnce(new Promise((resolve) => { resolveScan = resolve; }));
    render(<SystemView initialTab="storage" />);

    fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
    expect(screen.getByText("正在扫描磁盘...")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "软件管理" }));
    fireEvent.click(screen.getByRole("tab", { name: "存储空间" }));
    expect(screen.getByText("正在扫描磁盘...")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "软件管理" }));
    await act(async () => resolveScan({
      disks: [{ driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50 }],
      directories: [{ path: "C:\\Users\\Mona", sizeGb: 20, fileCount: 10 }],
      cleanupItems: [{ id: "temp", name: "系统临时文件", sizeGb: 1.5, path: "C:\\Temp", cleanable: true, recommended: true, reason: "可安全清理" }],
      fileTypes: [{ category: "应用", sizeGb: 12 }],
      totalScannedGb: 20,
    }));
    fireEvent.click(screen.getByRole("tab", { name: "存储空间" }));
    expect(await screen.findByText("C:\\Users\\Mona")).toBeTruthy();
    expect(screen.getByText("应用")).toBeTruthy();
  });

  it("shows persistent software failure details and an installed software table", async () => {
    render(<SystemView initialTab="software" />);

    expect(await screen.findByText("安装器返回 1603")).toBeTruthy();
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

  it("renders maintenance history returned by the backend instead of mock events", async () => {
    render(<SystemView initialTab="maintenance" />);

    expect((await screen.findAllByText("更新 Visual Studio Code")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("WinGet 更新完成").length).toBeGreaterThan(0);
    expect(screen.queryByText("安全清理系统临时文件，释放 6.8 GB")).toBeNull();
  });

  it("keeps a real Agent plan across tabs and opens its evidence source", async () => {
    render(<SystemView initialTab="software" />);

    fireEvent.click(screen.getByRole("button", { name: "让 Mona 检查" }));
    expect(screen.getByText("正在整理系统证据")).toBeTruthy();

    expect(await screen.findByText("已发现 1 项可更新软件")).toBeTruthy();
    expect(systemAgentMock.collect).toHaveBeenCalled();
    expect(systemAgentMock.plan).toHaveBeenCalledWith("检查电脑状态并生成安全处理方案", {});
    expect(screen.getByText("更新 Google Chrome")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "启动项" }));
    expect(screen.getByText("更新 Google Chrome")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看软件管理依据" }));
    expect(screen.getByRole("heading", { name: "可用更新" })).toBeTruthy();
  });

  it("executes only the selected real Agent actions and reports verification", async () => {
    render(<SystemView initialTab="software" />);

    fireEvent.click(screen.getByRole("button", { name: "让 Mona 检查" }));
    await screen.findByText("更新 Google Chrome");
    fireEvent.click(screen.getByRole("button", { name: "确认并执行" }));

    expect(await screen.findByText("验证完成")).toBeTruthy();
    expect(systemAgentMock.execute).toHaveBeenCalledWith(expect.objectContaining({ id: "update-chrome" }));
    expect(screen.getByText("Google Chrome 更新完成")).toBeTruthy();
  });
});
