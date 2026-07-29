import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invokeWithTimeout } from "@/lib/tauri";

export interface CpuInfo {
  usagePercent: number;
  frequencyGhz: number;
  coreCount: number;
}

export interface MemoryInfo {
  usagePercent: number;
  usedGb: number;
  totalGb: number;
}

export interface DiskInfo {
  driveLetter: string;
  usagePercent: number;
  usedGb: number;
  totalGb: number;
  availableGb: number;
}

export interface NetworkInfo {
  totalMbps: number;
  uploadMbps: number;
  downloadMbps: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMb: number;
  diskReadBytesPerSec: number;
  diskWriteBytesPerSec: number;
}

export interface SystemOverview {
  cpu: CpuInfo;
  memory: MemoryInfo;
  disks: DiskInfo[];
  network: NetworkInfo;
  topProcesses: ProcessInfo[];
  sampleCount: number;
}

export interface SamplePoint {
  ts: number;
  cpuUsage: number;
  memUsage: number;
  netTotalMbps: number;
}

const POLL_INTERVAL = 2000;
const HISTORY_REFRESH = 30000;

export function useSystemOverview() {
  const [data, setData] = useState<SystemOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const result = await invokeWithTimeout<SystemOverview>("system_get_overview", {}, 5_000);
        if (active) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) timer = setTimeout(tick, POLL_INTERVAL);
      }
    };
    tick();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  return { data, error };
}

export function useSystemHistory(windowSecs = 600) {
  const [data, setData] = useState<SamplePoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    let active = true;

    const tick = async () => {
      try {
        const result = await invoke<SamplePoint[]>("system_get_history", { windowSecs });
        if (active) {
          setData(result);
          setError(null);
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        if (active) timerRef.current = setTimeout(tick, HISTORY_REFRESH);
      }
    };
    tick();
    return () => {
      active = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [windowSecs]);

  return { data, error };
}

export function formatPercent(v: number): string {
  return `${v.toFixed(0)}%`;
}

export function formatGb(v: number): string {
  return v.toFixed(1);
}

export function formatStorage(gb: number): string {
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${formatGb(gb)} GB`;
}

export function formatMbps(v: number): string {
  if (v < 1) return `${(v * 1000).toFixed(0)} Kbps`;
  return `${v.toFixed(1)} Mbps`;
}

// ===== 软件管理 =====

export interface InstalledSoftware {
  id: string;
  name: string;
  publisher: string;
  version: string;
  installDate: string | null;
  softwareType: string;
  estimatedSizeBytes: number | null;
  installLocation: string;
}

export interface SoftwareUpdate {
  id: string;
  name: string;
  publisher: string;
  currentVersion: string;
  nextVersion: string;
  status: string;
}

export interface ResidualCandidate {
  path: string;
  sizeBytes: number;
  category: string;
  requiresConfirmation: boolean;
}

export interface SoftwareActionResult {
  success: boolean;
  message: string;
  exitCode: number | null;
  residuals: ResidualCandidate[];
}

export interface SoftwareCheckResult {
  updates: SoftwareUpdate[];
  installed: InstalledSoftware[];
  installedCount: number;
  knownSizeBytes: number;
  knownSizeCount: number;
  failedCount: number;
  failures: SoftwareFailure[];
  wingetAvailable: boolean;
  wingetVersion: string;
  lastCheck: number;
}

export interface SoftwareFailure {
  packageId: string;
  name: string;
  action: string;
  ts: number;
  message: string;
}

export interface UpgradeProgressEvent {
  id: string;
  line: string;
  status: string;
}

export function useSoftwareManagement() {
  const [data, setData] = useState<SoftwareCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workingIds, setWorkingIds] = useState<Set<string>>(new Set());
  const [lastAction, setLastAction] = useState("");
  const [lastUninstall, setLastUninstall] = useState<SoftwareActionResult | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, string[]>>({});

  const refresh = async () => {
    setLoading(true);
    try {
      setData(await invoke<SoftwareCheckResult>("system_check_updates"));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const upgrade = async (updates: SoftwareUpdate[]) => {
    if (updates.length === 0) return;
    setWorkingIds(new Set(updates.map((update) => update.id)));
    setLastAction("");
    setProgressMap({});
    let completed = 0;
    let failed = 0;
    for (const update of updates) {
      try {
        const result = await invoke<SoftwareActionResult>("system_upgrade_software", {
          id: update.id,
          name: update.name,
        });
        if (result.success) completed += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    setWorkingIds(new Set());
    setProgressMap({});
    setLastAction(failed === 0 ? `${completed} 项更新完成` : `${completed} 项完成，${failed} 项失败`);
    await refresh();
  };

  const uninstall = async (software: InstalledSoftware) => {
    setWorkingIds(new Set([software.id]));
    setLastUninstall(null);
    try {
      const result = await invoke<SoftwareActionResult>("system_uninstall_software", {
        id: null,
        name: software.name,
        installLocation: software.installLocation || null,
      });
      setLastUninstall(result);
      await refresh();
      return result;
    } catch (e) {
      const result: SoftwareActionResult = {
        success: false,
        message: String(e),
        exitCode: null,
        residuals: [],
      };
      setLastUninstall(result);
      return result;
    } finally {
      setWorkingIds(new Set());
    }
  };

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    listen<UpgradeProgressEvent>("software-upgrade-progress", (event) => {
      if (!active) return;
      const { id, line, status } = event.payload;
      setProgressMap((current) => {
        const existing = current[id] ?? [];
        const next = status === "running" ? [...existing, line].slice(-50) : existing;
        return { ...current, [id]: next };
      });
    }).then((fn) => { unlisten = fn; });
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    refresh();
  }, []);

  return { data, loading, error, workingIds, lastAction, lastUninstall, progressMap, refresh, upgrade, uninstall };
}

// ===== 存储空间扫描 =====

export interface StorageDiskInfo {
  driveLetter: string;
  usagePercent: number;
  usedGb: number;
  totalGb: number;
  availableGb: number;
}

export interface DirectorySize {
  path: string;
  sizeGb: number;
  fileCount: number;
  /** 嵌套子目录（后端递归扫描时填充，前端下钻直接从内存切片） */
  children?: DirectorySize[];
}

export interface CleanupItem {
  id: string;
  name: string;
  sizeGb: number;
  path: string;
  cleanable: boolean;
  recommended: boolean;
  reason: string;
}

export interface FileTypeSize {
  category: string;
  sizeGb: number;
}

export interface TopFileInfo {
  extension: string;
  parentDirName: string;
  sizeGb: number;
  modifiedBucket: string;
}

export interface ScanSummary {
  totalFiles: number;
  totalDirs: number;
  scanDurationSecs: number;
  scannedDisk: string;
}

export interface FileExtensionBucket {
  extension: string;
  count: number;
  sizeGb: number;
}

export interface StorageScanResult {
  disks: StorageDiskInfo[];
  directories: DirectorySize[];
  cleanupItems: CleanupItem[];
  fileTypes: FileTypeSize[];
  totalScannedGb: number;
  topFiles?: TopFileInfo[];
  scanSummary?: ScanSummary;
  extensionBuckets?: FileExtensionBucket[];
  /** 重点路径占用（AppData/ProgramData/家目录/桌面/下载等） */
  hotspots?: DirectorySize[];
}

export interface CleanupVerification {
  id: string;
  path: string;
  beforeBytes: number;
  afterBytes: number;
}

export interface StorageCleanupResult {
  freedGb: number;
  cleanedIds: string[];
  failures: string[];
  verification?: CleanupVerification[];
}

export interface ScanProgress {
  currentPath: string;
  scannedDirs: number;
  elapsedSecs: number;
}

export type ScanStatus = "idle" | "scanning" | "done" | "error";

const STORAGE_CACHE_KEY = "system.storageScan";
// 缓存版本：StorageScanResult 结构或 cleanable 语义变化时递增，旧缓存自动失效
const STORAGE_CACHE_VERSION = 2;

interface StorageCache {
  version: number;
  result: StorageScanResult;
  lastScanAt: number;
}

function loadStorageCache(): StorageCache | null {
  try {
    const raw = localStorage.getItem(STORAGE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StorageCache;
    if (parsed.version !== STORAGE_CACHE_VERSION) return null;
    if (!parsed.result || typeof parsed.lastScanAt !== "number") return null;
    // 检测降级缓存：根目录有 sizeGb 但 children 被剥离，下钻会失效，不使用
    const degraded = parsed.result.directories.some(
      (d) => d.sizeGb > 0.1 && (!d.children || d.children.length === 0),
    );
    if (degraded) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStorageCache(cache: Omit<StorageCache, "version">) {
  try {
    localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify({ ...cache, version: STORAGE_CACHE_VERSION }));
  } catch {
    // 配额不足时降级：只保留顶层目录元数据（不包含 children），下次加载会因降级检测而忽略缓存
    try {
      const trimmed: StorageCache = {
        version: STORAGE_CACHE_VERSION,
        lastScanAt: cache.lastScanAt,
        result: {
          ...cache.result,
          directories: cache.result.directories.map((d) => ({ ...d, children: [] })),
        },
      };
      localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(trimmed));
    } catch {
      // 仍失败则静默放弃，不影响功能
    }
  }
}

export function useStorageScan() {
  const initial = loadStorageCache();
  const [status, setStatus] = useState<ScanStatus>(initial ? "done" : "idle");
  const [result, setResult] = useState<StorageScanResult | null>(initial?.result ?? null);
  const [lastScanAt, setLastScanAt] = useState<number | null>(initial?.lastScanAt ?? null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const start = async () => {
    // 保留上次扫描结果显示，扫描完成后才覆盖
    setStatus("scanning");
    setProgress(null);
    setError(null);
    try {
      const res = await invoke<StorageScanResult>("scan_storage");
      const now = Date.now();
      setResult(res);
      setLastScanAt(now);
      setStatus("done");
      setProgress(null);
      saveStorageCache({ result: res, lastScanAt: now });
      return res;
    } catch (e) {
      setError(String(e));
      setStatus("error");
      return null;
    }
  };

  const clean = async (ids: string[]) => {
    setCleaning(true);
    try {
      const cleanup = await invoke<StorageCleanupResult>("clean_storage", { ids });
      setResult((current) => {
        if (!current) return current;
        // 基于 verification 数组的 afterBytes 更新真实剩余大小，避免虚报为 0
        const afterBytesById = new Map(
          (cleanup.verification ?? []).map((v) => [v.id, v.afterBytes]),
        );
        const next: StorageScanResult = {
          ...current,
          cleanupItems: current.cleanupItems.map((item) => {
            if (!cleanup.cleanedIds.includes(item.id)) return item;
            const afterBytes = afterBytesById.get(item.id);
            const sizeGb = afterBytes !== undefined
              ? afterBytes / 1_073_741_824
              : 0;
            return { ...item, sizeGb };
          }),
        };
        saveStorageCache({ result: next, lastScanAt: lastScanAt ?? Date.now() });
        return next;
      });
      return cleanup;
    } finally {
      setCleaning(false);
    }
  };

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let active = true;
    listen<ScanProgress>("storage-scan-progress", (event) => {
      if (active) setProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, []);

  return { status, result, lastScanAt, progress, error, cleaning, start, clean };
}

// ===== 启动项管理 =====

export interface StartupItem {
  id: string;
  name: string;
  publisher: string;
  source: string;
  scope: string;
  command: string;
  targetPath: string;
  added: string | null;
  enabled: boolean;
  signed: boolean;
  firstSeenAt: number | null;
  isNew: boolean;
}

export interface StartupListResult {
  items: StartupItem[];
  total: number;
  enabledCount: number;
  disabledCount: number;
}

export interface BootDurationPoint {
  ts: number;
  durationMs: number;
}

export interface BootHistoryResult {
  points: BootDurationPoint[];
  lastDurationMs: number | null;
  lastDeltaMs: number | null;
}

export interface StartupChangeRecord {
  ts: number;
  itemId: string;
  itemName: string;
  action: string;
}

function extractErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
  }
  return String(e);
}

export function useStartupItems() {
  const [data, setData] = useState<StartupListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<StartupListResult>("system_list_startup_items");
      setData(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    setToggling(true);
    setError(null);
    try {
      await invoke("system_toggle_startup_item", { id, enabled });
      await refresh();
      return null;
    } catch (e) {
      const message = extractErrorMessage(e);
      setError(message);
      return message;
    } finally {
      setToggling(false);
    }
  };

  const batchToggle = async (ids: string[], enabled: boolean) => {
    setToggling(true);
    setError(null);
    try {
      await invoke<number>("system_batch_toggle_startup_items", { ids, enabled });
      await refresh();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setToggling(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { data, loading, error, toggling, refresh, toggle, batchToggle };
}

export function useBootHistory() {
  const [data, setData] = useState<BootHistoryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await invoke<BootHistoryResult>("system_get_boot_history");
        if (active) setData(result);
      } catch (e) {
        if (active) setError(String(e));
      }
    })();
    return () => { active = false; };
  }, []);

  return { data, error };
}

export function useStartupChanges() {
  const [data, setData] = useState<StartupChangeRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await invoke<StartupChangeRecord[]>("system_get_startup_changes");
        if (active) setData(result);
      } catch (e) {
        if (active) setError(String(e));
      }
    })();
    return () => { active = false; };
  }, []);

  return { data, error };
}

// ===== 维护记录 =====

export interface MaintenanceEvent {
  id: string;
  ts: number;
  category: string;
  title: string;
  source: string;
  status: string;
  detail: string;
  bytesChanged: number;
  reversible: boolean;
  relatedId: string | null;
  restoreEnabled: boolean | null;
}

export interface MaintenanceHistory {
  events: MaintenanceEvent[];
}

export function useMaintenanceHistory() {
  const [data, setData] = useState<MaintenanceHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      setData(await invoke<MaintenanceHistory>("system_get_maintenance_history"));
      setError(null);
    } catch (historyError) {
      setError(String(historyError));
    } finally {
      setLoading(false);
    }
  };

  const restore = async (event: MaintenanceEvent) => {
    if (!event.relatedId) return null;
    setRestoringId(event.id);
    try {
      if (event.category === "系统优化" && event.reversible) {
        await invoke("system_apply_configuration_item", { itemId: event.relatedId, mode: "restore" });
      } else {
        if (event.restoreEnabled === null) return null;
        await invoke("system_toggle_startup_item", { id: event.relatedId, enabled: event.restoreEnabled });
      }
      await refresh();
      return null;
    } catch (restoreError) {
      const message = extractErrorMessage(restoreError);
      setError(message);
      return message;
    } finally {
      setRestoringId(null);
    }
  };

  useEffect(() => { void refresh(); }, []);
  return { data, loading, error, restoringId, refresh, restore };
}
