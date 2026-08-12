import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

import { useStorageScan, type StorageScanResult } from "./useSystemData";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const scanResult = (disk: string): StorageScanResult => ({
  disks: [
    { driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50, isRemovable: false },
    { driveLetter: "D:\\", usagePercent: 30, usedGb: 60, totalGb: 200, availableGb: 140, isRemovable: false },
  ],
  directories: [{ path: `${disk}\\Data`, sizeGb: 8, fileCount: 4 }],
  cleanupItems: [],
  fileTypes: [],
  totalScannedGb: 8,
  scanSummary: { totalFiles: 4, totalDirs: 1, scanDurationSecs: 0.5, scannedDisk: disk },
});

describe("useStorageScan 多盘扫描", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("defaults to the system drive and passes the selected drive to scan_storage", async () => {
    vi.mocked(invoke).mockImplementation((command: string) =>
      Promise.resolve(command === "scan_storage" ? scanResult("D:") : null),
    );
    const { result } = renderHook(() => useStorageScan());
    expect(result.current.selectedDrive).toBe("C:");

    // 切到 D:：无缓存时回到未扫描态
    act(() => result.current.selectDrive("D:"));
    expect(result.current.selectedDrive).toBe("D:");
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.result).toBeNull();

    // 扫描携带所选盘符，结果按盘符落缓存维度
    await act(async () => {
      await result.current.start();
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("scan_storage", { drive: "D:" });
    expect(result.current.status).toBe("done");
    expect(result.current.result?.scanSummary?.scannedDisk).toBe("D:");
  });

  it("keeps the previous result visible while a rescan is in flight", async () => {
    let resolveSecond!: (value: StorageScanResult) => void;
    let calls = 0;
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command !== "scan_storage") return Promise.resolve(null);
      calls += 1;
      if (calls === 1) return Promise.resolve(scanResult("C:"));
      return new Promise((resolve) => {
        resolveSecond = resolve;
      });
    });
    const { result } = renderHook(() => useStorageScan());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.result?.totalScannedGb).toBe(8);

    // 重扫进行中保留旧结果（状态栏不回到空白）
    let pending!: Promise<StorageScanResult | null>;
    act(() => {
      pending = result.current.start();
    });
    expect(result.current.status).toBe("scanning");
    expect(result.current.result?.totalScannedGb).toBe(8);

    await act(async () => {
      resolveSecond(scanResult("C:"));
      await pending;
    });
    expect(result.current.status).toBe("done");
  });
});
