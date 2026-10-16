import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StoragePanel } from "./StoragePanel";
import type { SystemAgentHandoffTask } from "./systemAgentHandoff";
import type { CleanupItem, StorageCleanupResult, StorageScanResult, useStorageScan } from "./useSystemData";

const overviewMock = vi.hoisted(() => ({
  value: null as { disks: Array<{ driveLetter: string; usagePercent: number; usedGb: number; totalGb: number; availableGb: number }> } | null,
  error: null as string | null,
}));

vi.mock("./useSystemData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useSystemData")>()),
  useSystemOverview: () => ({ data: overviewMock.value, error: overviewMock.error }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

const disks = [
  { driveLetter: "C:\\", usagePercent: 83, usedGb: 330.1, totalGb: 400, availableGb: 69.9 },
  { driveLetter: "D:\\", usagePercent: 95, usedGb: 525.5, totalGb: 551.5, availableGb: 26 },
];

function scanResult(drive: string, cleanupItems: CleanupItem[] = []): StorageScanResult {
  return {
    scanId: `scan-${drive}`,
    disks: disks.map((disk) => ({ ...disk, isRemovable: false })),
    directories: [],
    cleanupItems,
    fileTypes: [],
    totalScannedGb: 0,
    scanSummary: { scannedDisk: drive, totalFiles: 0, totalDirs: 0, scanDurationSecs: 0 },
  };
}

function cleanupItem(id: string, name: string): CleanupItem {
  return { id, name, sizeGb: 1, path: `C:\\${id}`, cleanable: true, recommended: true, reason: "缓存" };
}

interface HarnessProps {
  initialResult?: StorageScanResult | null;
  startScan: (drive: string) => Promise<StorageScanResult | null>;
  clean: (ids: string[]) => Promise<StorageCleanupResult>;
}

function StoragePanelHarness({ initialResult = null, startScan, clean }: HarnessProps) {
  const [selectedDrive, setSelectedDrive] = useState("C:");
  const [result, setResult] = useState<StorageScanResult | null>(initialResult);
  const [status, setStatus] = useState<"idle" | "scanning" | "done" | "error">(initialResult ? "done" : "idle");
  const [cleaningIds, setCleaningIds] = useState<Set<string>>(() => new Set());

  const scan = {
    status,
    result,
    lastScanAt: null,
    progress: null,
    error: null,
    cleaning: cleaningIds.size > 0,
    cleaningIds,
    selectedDrive,
    selectDrive: (drive: string) => {
      setSelectedDrive(drive);
      setResult(null);
      setStatus("idle");
    },
    start: async (drive = selectedDrive) => {
      setSelectedDrive(drive);
      setStatus("scanning");
      const next = await startScan(drive);
      if (next) setResult(next);
      setStatus(next ? "done" : "error");
      return next;
    },
    cancel: vi.fn(() => Promise.resolve()),
    clean: async (ids: string[]) => {
      setCleaningIds((current) => new Set([...current, ...ids]));
      try { return await clean(ids); }
      finally { setCleaningIds((current) => new Set([...current].filter((id) => !ids.includes(id)))); }
    },
    trashFiles: vi.fn(() => Promise.resolve({ trashed: [], failures: [], freedGb: 0 })),
  } as unknown as ReturnType<typeof useStorageScan>;

  return <StoragePanel scan={scan} onHandoff={vi.fn<(task: SystemAgentHandoffTask) => void>()} />;
}

describe("StoragePanel", () => {
  it("rebuilds the real directory ancestry when jumping between branches", () => {
    overviewMock.value = { disks };
    const result = scanResult("C:");
    result.directories = [
      { id: "users", path: "C:\\Users", sizeGb: 8, fileCount: 1, directSizeGb: 0, children: [{ id: "user-child", path: "C:\\Users\\Mona", sizeGb: 8, fileCount: 1, directSizeGb: 8 }] },
      { id: "windows", path: "C:\\Windows", sizeGb: 4, fileCount: 1, directSizeGb: 0, children: [{ id: "windows-child", path: "C:\\Windows\\Logs", sizeGb: 4, fileCount: 1, directSizeGb: 4 }] },
    ];
    render(<StoragePanelHarness initialResult={result} startScan={vi.fn()} clean={vi.fn()} />);
    const treeGrid = screen.getByRole("treegrid", { name: "目录占用" });
    fireEvent.doubleClick(within(treeGrid).getByText("Users"));
    expect(screen.getByTitle("C:\\Users")).toBeInTheDocument();
    fireEvent.doubleClick(within(treeGrid).getByText("Windows"));
    expect(screen.getByTitle("C:\\Windows")).toBeInTheDocument();
    expect(screen.queryByTitle("C:\\Users")).toBeNull();
  });

  beforeEach(() => {
    overviewMock.value = { disks };
    overviewMock.error = null;
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("shows multiple disks, switches selection, opens a disk, and scans the requested drive", async () => {
    const startScan = vi.fn(async (drive: string) => scanResult(drive));
    render(<StoragePanelHarness startScan={startScan} clean={vi.fn()} />);

    expect(screen.getByText("83%")).toBeInTheDocument();
    expect(screen.getByText("可用 69.9 GB / 共 400.0 GB")).toBeInTheDocument();
    expect(screen.getByText("95%")).toBeInTheDocument();
    expect(screen.getByText("可用 26.0 GB / 共 551.5 GB")).toBeInTheDocument();
    expect(screen.queryByText(/可安全释放|Mona 发现|文件类型（扫描区域）|重点路径占用|空间占用/)).toBeNull();
    expect(screen.queryByText("总容量")).toBeNull();
    expect(screen.queryByText("已使用")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看 D: 磁盘" }));
    expect(screen.getByRole("button", { name: "查看 D: 磁盘" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "查看 C: 磁盘" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "打开 D: 磁盘" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("system_open_in_explorer", { path: "D:\\" }));

    fireEvent.click(screen.getByRole("button", { name: "开始扫描" }));
    await waitFor(() => expect(startScan).toHaveBeenCalledWith("D:"));
    expect(await screen.findByText("选择磁盘并开始扫描，查看目录占用和可清理内容。")).toBeInTheDocument();
  });

  it("closes cleanup confirmation immediately, marks only the active row, and keeps other actions available", async () => {
    let resolveCleanup!: (result: StorageCleanupResult) => void;
    const clean = vi.fn(() => new Promise<StorageCleanupResult>((resolve) => { resolveCleanup = resolve; }));
    const result = scanResult("C:", [
      cleanupItem("temp", "临时文件"),
      cleanupItem("browser", "浏览器缓存"),
      cleanupItem("trash", "回收站"),
    ]);
    render(<StoragePanelHarness initialResult={result} startScan={vi.fn()} clean={clean} />);

    fireEvent.click(screen.getByRole("button", { name: "清理临时文件" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "确认清理" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));

    await waitFor(() => expect(clean).toHaveBeenCalledWith(["temp"]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const busyButton = screen.getByRole("button", { name: "正在清理临时文件" });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute("aria-busy", "true");
    expect(busyButton.querySelector("svg.animate-spin")).toBeTruthy();

    const otherAction = screen.getByRole("button", { name: "清理浏览器缓存" });
    expect(otherAction).toBeEnabled();
    fireEvent.click(otherAction);
    const otherDialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(otherDialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "清理回收站" }));
    const recycleDialog = await screen.findByRole("alertdialog");
    expect(recycleDialog).toHaveTextContent("清空后无法从回收站恢复");
    fireEvent.click(within(recycleDialog).getByRole("button", { name: "取消" }));
    expect(invoke).not.toHaveBeenCalledWith("system_open_in_explorer", { path: "shell:RecycleBinFolder" });
    expect(clean).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "查看 D: 磁盘" }));
    expect(screen.getByRole("button", { name: "查看 D: 磁盘" })).toHaveAttribute("aria-pressed", "true");

    await act(async () => {
      resolveCleanup({ freedGb: 0.5, cleanedIds: ["temp"], failures: [] });
    });
  });

  it("cleans the recycle bin only after explicit confirmation", async () => {
    const clean = vi.fn(async () => ({ freedGb: 1, cleanedIds: ["trash"], failures: [] }));
    render(<StoragePanelHarness initialResult={scanResult("C:", [cleanupItem("trash", "回收站")])} startScan={vi.fn()} clean={clean} />);
    const action = screen.getByRole("button", { name: "清理回收站" });
    expect(action).toHaveAttribute("title", "清理回收站");
    expect(action.textContent).toBe("");
    expect(screen.queryByRole("button", { name: "查看回收站内容" })).toBeNull();
    fireEvent.click(action);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("将永久删除回收站中的文件");
    expect(clean).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确认清理" }));
    await waitFor(() => expect(clean).toHaveBeenCalledWith(["trash"]));
    expect(clean).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/回收站清理完成/)).toBeInTheDocument();
  });
});
