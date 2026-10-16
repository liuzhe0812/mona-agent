import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

import { useStorageScan, type CleanupItem, type StorageCleanupResult, type StorageScanResult } from "./useSystemData";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const scanResult = (disk: string, cleanupItems: CleanupItem[] = []): StorageScanResult => ({
  scanId: `scan-${disk}`,
  disks: [
    { driveLetter: "C:\\", usagePercent: 50, usedGb: 50, totalGb: 100, availableGb: 50, isRemovable: false },
    { driveLetter: "D:\\", usagePercent: 30, usedGb: 60, totalGb: 200, availableGb: 140, isRemovable: false },
  ],
  directories: [{ id: `dir-${disk}`, path: `${disk}\\Data`, sizeGb: 8, fileCount: 4, directSizeGb: 8 }],
  cleanupItems,
  fileTypes: [],
  totalScannedGb: 8,
  scanSummary: { totalFiles: 4, totalDirs: 1, scanDurationSecs: 0.5, scannedDisk: disk },
});

describe("useStorageScan 多盘扫描", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("clears the previous drive's result immediately when changing drives", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => Promise.resolve(command === "scan_storage" ? scanResult("C:") : null));
    const { result } = renderHook(() => useStorageScan());
    await act(async () => { await result.current.start(); });
    expect(result.current.result?.scanSummary?.scannedDisk).toBe("C:");

    act(() => result.current.selectDrive("D:"));
    expect(result.current.selectedDrive).toBe("D:");
    expect(result.current.result).toBeNull();
    expect(result.current.lastScanAt).toBeNull();
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    expect(result.current.status).toBe("idle");
  });

  it("uses an explicitly requested drive instead of the currently selected drive cache", async () => {
    vi.mocked(invoke).mockImplementation((command: string) =>
      Promise.resolve(command === "scan_storage" ? scanResult("C:") : null),
    );
    const { result } = renderHook(() => useStorageScan());

    await act(async () => { await result.current.start("C:"); });
    expect(result.current.result?.scanSummary?.scannedDisk).toBe("C:");

    vi.mocked(invoke).mockImplementation((command: string, args?: Record<string, unknown>) =>
      Promise.resolve(command === "scan_storage" ? scanResult(String(args?.drive)) : null),
    );
    await act(async () => { await result.current.start("D:"); });

    expect(result.current.selectedDrive).toBe("D:");
    expect(result.current.result?.scanSummary?.scannedDisk).toBe("D:");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("scan_storage", { drive: "D:" });
  });

  it("keeps a pending cleanup tied to its drive and updates that drive from verification", async () => {
    const tempItem: CleanupItem = {
      id: "temp",
      name: "临时文件",
      sizeGb: 1,
      path: "C:\\Temp",
      cleanable: true,
      recommended: true,
      reason: "缓存",
    };
    let resolveCleanup!: (value: StorageCleanupResult) => void;
    vi.mocked(invoke).mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "scan_storage") {
        const drive = String(args?.drive);
        return Promise.resolve(scanResult(drive, drive === "C:" ? [tempItem] : []));
      }
      if (command === "clean_storage") return new Promise((resolve) => { resolveCleanup = resolve; });
      return Promise.resolve(null);
    });
    const { result } = renderHook(() => useStorageScan());

    await act(async () => { await result.current.start("C:"); });
    let pendingCleanup!: Promise<StorageCleanupResult>;
    act(() => { pendingCleanup = result.current.clean(["temp"]); });
    expect(result.current.cleaningIds.has("temp")).toBe(true);
    await expect(result.current.clean(["temp"])).rejects.toThrow("该项目正在清理");

    act(() => result.current.selectDrive("D:"));
    await act(async () => { await result.current.start("D:"); });
    expect(result.current.result?.scanSummary?.scannedDisk).toBe("D:");

    await act(async () => {
      resolveCleanup({
        freedGb: 0.5,
        cleanedIds: ["temp"],
        failures: [],
        verification: [{ id: "temp", path: "C:\\Temp", beforeBytes: 1_073_741_824, afterBytes: 536_870_912 }],
      });
      await pendingCleanup;
    });
    expect(result.current.result?.scanSummary?.scannedDisk).toBe("D:");
    expect(result.current.cleaningIds.has("temp")).toBe(false);

    act(() => result.current.selectDrive("C:"));
    await waitFor(() => expect(result.current.result?.scanSummary?.scannedDisk).toBe("C:"));
    expect(result.current.result?.cleanupItems[0].sizeGb).toBeCloseTo(0.5);
  });

  it("allows different cleanup items to run in parallel while rejecting a duplicate ID", async () => {
    const items = [
      { id: "temp", name: "临时文件", sizeGb: 1, path: "C:\\Temp", cleanable: true, recommended: true, reason: "缓存" },
      { id: "browser", name: "浏览器缓存", sizeGb: 0.5, path: "C:\\BrowserCache", cleanable: true, recommended: true, reason: "缓存" },
    ];
    const resolveCleanup = new Map<string, (value: StorageCleanupResult) => void>();
    vi.mocked(invoke).mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "scan_storage") return Promise.resolve(scanResult(String(args?.drive), items));
      if (command === "clean_storage") {
        const id = (args?.ids as string[])[0];
        return new Promise((resolve) => { resolveCleanup.set(id, resolve); });
      }
      return Promise.resolve(null);
    });
    const { result } = renderHook(() => useStorageScan());
    await act(async () => { await result.current.start("C:"); });

    let tempCleanup!: Promise<StorageCleanupResult>;
    let browserCleanup!: Promise<StorageCleanupResult>;
    act(() => {
      tempCleanup = result.current.clean(["temp"]);
      browserCleanup = result.current.clean(["browser"]);
    });
    expect(result.current.cleaningIds).toEqual(new Set(["temp", "browser"]));
    expect(result.current.cleaning).toBe(true);
    await expect(result.current.clean(["temp"])).rejects.toThrow("该项目正在清理");

    await act(async () => {
      resolveCleanup.get("temp")!({ freedGb: 1, cleanedIds: ["temp"], failures: [] });
      await tempCleanup;
    });
    expect(result.current.cleaningIds).toEqual(new Set(["browser"]));
    expect(result.current.cleaning).toBe(true);

    await act(async () => {
      resolveCleanup.get("browser")!({ freedGb: 0.5, cleanedIds: ["browser"], failures: [] });
      await browserCleanup;
    });
    expect(result.current.cleaningIds.size).toBe(0);
    expect(result.current.cleaning).toBe(false);
  });

  it("keeps an updated C cache when a delayed IndexedDB read returns an older snapshot", async () => {
    type FakeRequest = {
      result: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
    };
    const tempItem: CleanupItem = {
      id: "temp",
      name: "临时文件",
      sizeGb: 1,
      path: "C:\\Temp",
      cleanable: true,
      recommended: true,
      reason: "缓存",
    };
    const originalResult = scanResult("C:", [tempItem]);
    const persisted = new Map<string, unknown>([["latest:C:", { version: 5, result: originalResult, lastScanAt: 123 }]]);
    const reads: Array<{ key: string; request: FakeRequest }> = [];
    const database = {
      objectStoreNames: { contains: () => true },
      transaction: (_store: string, mode: IDBTransactionMode) => {
        const tx: { oncomplete: (() => void) | null; onerror: (() => void) | null } = { oncomplete: null, onerror: null };
        return {
          objectStore: () => ({
            get: (key: string) => {
              const request: FakeRequest = { result: persisted.get(key), onsuccess: null, onerror: null };
              reads.push({ key, request });
              return request;
            },
            put: (value: unknown, key: string) => {
              if (mode === "readwrite") persisted.set(key, value);
              queueMicrotask(() => tx.oncomplete?.());
            },
          }),
          get oncomplete() { return tx.oncomplete; },
          set oncomplete(value) { tx.oncomplete = value; },
          get onerror() { return tx.onerror; },
          set onerror(value) { tx.onerror = value; },
        } as unknown as IDBTransaction;
      },
    } as unknown as IDBDatabase;
    const fakeIndexedDB = {
      open: vi.fn(() => {
        const request = { result: database, onsuccess: null, onerror: null, onupgradeneeded: null };
        queueMicrotask(() => request.onsuccess?.());
        return request as unknown as IDBOpenDBRequest;
      }),
    } as unknown as IDBFactory;
    vi.stubGlobal("indexedDB", fakeIndexedDB);

    let resolveCleanup!: (value: StorageCleanupResult) => void;
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "clean_storage") return new Promise((resolve) => { resolveCleanup = resolve; });
      return Promise.resolve(null);
    });
    const { result } = renderHook(() => useStorageScan());

    await waitFor(() => expect(reads.filter((read) => read.key === "latest:C:")).toHaveLength(1));
    await act(async () => {
      reads[0].request.onsuccess?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.result?.scanId).toBe(originalResult.scanId));
    expect(result.current.result?.cleanupItems[0].sizeGb).toBe(1);

    let pendingCleanup!: Promise<StorageCleanupResult>;
    act(() => { pendingCleanup = result.current.clean(["temp"]); });
    act(() => result.current.selectDrive("D:"));
    await waitFor(() => expect(reads.some((read) => read.key === "latest:D:")).toBe(true));
    const dRead = reads.find((read) => read.key === "latest:D:")!;
    await act(async () => {
      dRead.request.onsuccess?.();
      await Promise.resolve();
    });

    act(() => result.current.selectDrive("C:"));
    await waitFor(() => expect(reads.filter((read) => read.key === "latest:C:")).toHaveLength(2));
    const delayedCRead = reads.filter((read) => read.key === "latest:C:")[1];
    expect(delayedCRead.request.result).toMatchObject({ result: { scanId: originalResult.scanId } });

    await act(async () => {
      resolveCleanup({
        freedGb: 0.5,
        cleanedIds: ["temp"],
        failures: [],
        verification: [{ id: "temp", path: "C:\\Temp", beforeBytes: 1_073_741_824, afterBytes: 536_870_912 }],
      });
      await pendingCleanup;
    });
    expect(result.current.result?.cleanupItems[0].sizeGb).toBeCloseTo(0.5);

    await act(async () => {
      delayedCRead.request.onsuccess?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.result?.cleanupItems[0].sizeGb).toBeCloseTo(0.5));
  });
});
