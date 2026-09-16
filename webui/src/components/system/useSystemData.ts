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
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
  uninstallKind: string;
  canUninstall: boolean;
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
  id: string;
  path: string;
  sizeBytes: number;
  category: string;
  requiresConfirmation: boolean;
  kind: string;
  confidence: "high" | "medium";
  recommended: boolean;
  canDelete: boolean;
  reason: string;
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

export interface SoftwareResidualDeleteFailure {
  id: string;
  message: string;
}

export interface SoftwareResidualDeleteResult {
  deletedIds: string[];
  freedBytes: number;
  failures: SoftwareResidualDeleteFailure[];
}

export interface StoreApp {
  id: string;
  name: string;
  version: string;
  source: string;
}

export function useAppStore() {
  const [results, setResults] = useState<StoreApp[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set());
  const [installProgress, setInstallProgress] = useState<Record<string, string>>({});
  const [installError, setInstallError] = useState<string | null>(null);

  const search = async (query: string) => {
    const keyword = query.trim();
    if (!keyword) {
      setResults([]);
      setSearchError(null);
      return;
    }
    setSearching(true);
    try {
      setResults(await invoke<StoreApp[]>("system_search_apps", { query: keyword }));
      setSearchError(null);
    } catch (error) {
      setResults([]);
      setSearchError(String(error));
    } finally {
      setSearching(false);
    }
  };

  const install = async (app: StoreApp) => {
    setInstallingIds((current) => new Set(current).add(app.id));
    setInstallError(null);
    setInstallProgress((current) => ({ ...current, [app.id]: "正在准备安装" }));
    try {
      const result = await invoke<SoftwareActionResult>("system_install_app", {
        id: app.id,
        name: app.name,
      });
      if (!result.success) setInstallError(result.message || "安装失败");
      return result;
    } catch (error) {
      setInstallError(String(error));
      return null;
    } finally {
      setInstallingIds((current) => {
        const next = new Set(current);
        next.delete(app.id);
        return next;
      });
    }
  };

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;
    listen<UpgradeProgressEvent>("software-install-progress", (event) => {
      if (!active) return;
      const { id, line } = event.payload;
      setInstallProgress((current) => ({ ...current, [id]: line }));
    }).then((fn) => { unlisten = fn; });
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, []);

  return { results, searching, searchError, installingIds, installProgress, installError, search, install };
}

export function useSoftwareManagement() {
  const [data, setData] = useState<SoftwareCheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workingIds, setWorkingIds] = useState<Set<string>>(new Set());
  const [lastAction, setLastAction] = useState("");
  const [lastUninstall, setLastUninstall] = useState<SoftwareActionResult | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, string[]>>({});

  const hasDataRef = useRef(false);
  // 已有数据时后台刷新替换，避免整列表进入 loading 闪烁
  const refresh = async () => {
    if (!hasDataRef.current) setLoading(true);
    try {
      const result = await invoke<SoftwareCheckResult>("system_check_updates");
      hasDataRef.current = true;
      setData(result);
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
        id: software.id,
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

  const deleteResiduals = async (ids: string[]) => {
    if (ids.length === 0) {
      return { deletedIds: [], freedBytes: 0, failures: [] } satisfies SoftwareResidualDeleteResult;
    }
    return invoke<SoftwareResidualDeleteResult>("system_delete_software_residuals", {
      ids,
      confirmed: true,
    });
  };

  const revealInExplorer = async (path: string) => {
    await invoke("system_reveal_in_explorer", { path });
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

  return { data, loading, error, workingIds, lastAction, lastUninstall, progressMap, refresh, upgrade, uninstall, deleteResiduals, revealInExplorer };
}

// ===== 存储空间扫描 =====

export interface StorageDiskInfo {
  driveLetter: string;
  usagePercent: number;
  usedGb: number;
  totalGb: number;
  availableGb: number;
  /** 可移动盘（U 盘等），仅 scan_storage 返回的 disks 带该字段；磁盘选择器据此过滤 */
  isRemovable?: boolean;
}

export interface DirectorySize {
  id: string;
  path: string;
  sizeGb: number;
  fileCount: number;
  directSizeGb: number;
  insight?: DirectoryInsightSummary;
  /** 嵌套子目录（后端递归扫描时填充，前端下钻直接从内存切片） */
  children?: DirectorySize[];
}

export interface StorageSizeBucket {
  bucket: string;
  count: number;
  sizeGb: number;
}

export interface DirectoryInsightSummary {
  artifactKind: string | null;
  fileTypes: FileTypeSize[];
  modifiedBuckets: StorageSizeBucket[];
  topExtensions: FileExtensionBucket[];
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
  id: string;
  extension: string;
  parentDirName: string;
  sizeGb: number;
  modifiedBucket: string;
  /** 完整文件路径（用于右键菜单） */
  path: string;
}

export interface ScanSummary {
  totalFiles: number;
  totalDirs: number;
  scanDurationSecs: number;
  scannedDisk: string;
  /** 扫描被用户取消（结果为部分数据） */
  cancelled?: boolean;
}

export interface FileExtensionBucket {
  extension: string;
  count: number;
  sizeGb: number;
}

export interface StorageScanResult {
  scanId: string;
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

export interface StorageTrashFailure {
  path: string;
  error: string;
}

export interface StorageTrashResult {
  trashed: Array<{ path: string; sizeGb: number }>;
  failures: StorageTrashFailure[];
  freedGb: number;
}

export interface ScanProgress {
  currentPath: string;
  scannedDirs: number;
  elapsedSecs: number;
}

export type ScanStatus = "idle" | "scanning" | "done" | "error";

// 缓存版本：StorageScanResult 结构变化时递增，旧缓存自动失效
// v3 → v4: 缓存 key 增加盘符维度（latest:C / latest:D），disks 增加 isRemovable
const STORAGE_CACHE_VERSION = 5;
const STORAGE_DB_NAME = "mona-system";
const STORAGE_DB_STORE = "storage-scan";
const storageCacheKey = (drive: string) => `latest:${drive}`;

interface StorageCache {
  version: number;
  result: StorageScanResult;
  lastScanAt: number;
}

// IndexedDB 异步操作封装
function openStorageDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(STORAGE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORAGE_DB_STORE)) {
          db.createObjectStore(STORAGE_DB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function loadStorageCache(drive: string): Promise<StorageCache | null> {
  try {
    const db = await openStorageDb();
    if (!db) return null;
    return await new Promise<StorageCache | null>((resolve) => {
      const tx = db.transaction(STORAGE_DB_STORE, "readonly");
      const req = tx.objectStore(STORAGE_DB_STORE).get(storageCacheKey(drive));
      req.onsuccess = () => {
        const parsed = req.result as StorageCache | undefined;
        if (!parsed || parsed.version !== STORAGE_CACHE_VERSION || !parsed.result) {
          resolve(null);
          return;
        }
        resolve(parsed);
      };
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function saveStorageCache(drive: string, cache: Omit<StorageCache, "version">): Promise<void> {
  try {
    const db = await openStorageDb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORAGE_DB_STORE, "readwrite");
      tx.objectStore(STORAGE_DB_STORE).put({ ...cache, version: STORAGE_CACHE_VERSION }, storageCacheKey(drive));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // 静默放弃，不影响功能
  }
}

export function useStorageScan() {
  const [status, setStatus] = useState<ScanStatus>("idle");
  const [result, setResult] = useState<StorageScanResult | null>(null);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [selectedDrive, setSelectedDrive] = useState<string>("C:");

  // 扫描会话标记：start() 递增，晚到的缓存加载结果不得覆盖更新的扫描结果
  const scanSessionRef = useRef(0);

  // 启动与切盘时从 IndexedDB 异步恢复所选盘的扫描结果；无缓存回到未扫描态
  useEffect(() => {
    let active = true;
    const session = scanSessionRef.current;
    (async () => {
      const cached = await loadStorageCache(selectedDrive);
      if (!active || session !== scanSessionRef.current) return;
      if (cached) {
        setResult(cached.result);
        setLastScanAt(cached.lastScanAt);
        setStatus("done");
      } else {
        setResult(null);
        setLastScanAt(null);
        setStatus("idle");
      }
    })();
    return () => { active = false; };
  }, [selectedDrive]);

  const start = async () => {
    scanSessionRef.current += 1;
    // 保留上次扫描结果显示，扫描完成后才覆盖
    setStatus("scanning");
    setProgress(null);
    setError(null);
    try {
      const res = await invoke<StorageScanResult>("scan_storage", { drive: selectedDrive });
      const now = Date.now();
      setResult(res);
      setLastScanAt(now);
      setStatus("done");
      setProgress(null);
      void saveStorageCache(selectedDrive, { result: res, lastScanAt: now });
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
        void saveStorageCache(selectedDrive, { result: next, lastScanAt: lastScanAt ?? Date.now() });
        return next;
      });
      return cleanup;
    } finally {
      setCleaning(false);
    }
  };

  /** 大文件移至回收站（系统回收站可恢复）；成功后从 topFiles 移除并同步缓存 */
  const trashFiles = async (paths: string[]) => {
    const trash = await invoke<StorageTrashResult>("system_trash_storage_files", { paths });
    if (trash.trashed.length > 0) {
      const trashedPaths = new Set(trash.trashed.map((item) => item.path));
      setResult((current) => {
        if (!current) return current;
        const next: StorageScanResult = {
          ...current,
          topFiles: (current.topFiles ?? []).filter((file) => !trashedPaths.has(file.path)),
        };
        void saveStorageCache(selectedDrive, { result: next, lastScanAt: lastScanAt ?? Date.now() });
        return next;
      });
    }
    return trash;
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

  const cancel = async () => {
    await invoke("cancel_storage_scan");
  };

  return { status, result, lastScanAt, progress, error, cleaning, start, cancel, clean, trashFiles, selectedDrive, selectDrive: setSelectedDrive };
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

  const hasDataRef = useRef(false);
  // 已有数据时后台刷新替换，避免整列表进入 loading 闪烁
  const refresh = async () => {
    if (!hasDataRef.current) setLoading(true);
    setError(null);
    try {
      const result = await invoke<StartupListResult>("system_list_startup_items");
      hasDataRef.current = true;
      setData(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // 乐观更新：本地先改 enabled 与计数，失败时回滚
  const applyLocalToggle = (ids: string[], enabled: boolean) => {
    setData((current) => {
      if (!current) return current;
      let delta = 0;
      const items = current.items.map((item) => {
        if (!ids.includes(item.id) || item.enabled === enabled) return item;
        delta += 1;
        return { ...item, enabled };
      });
      return {
        ...current,
        items,
        enabledCount: enabled ? current.enabledCount + delta : current.enabledCount - delta,
        disabledCount: enabled ? current.disabledCount - delta : current.disabledCount + delta,
      };
    });
  };

  const toggle = async (id: string, enabled: boolean) => {
    setToggling(true);
    setError(null);
    applyLocalToggle([id], enabled);
    try {
      await invoke("system_toggle_startup_item", { id, enabled });
      await refresh();
      return null;
    } catch (e) {
      applyLocalToggle([id], !enabled);
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
    applyLocalToggle(ids, enabled);
    try {
      await invoke<number>("system_batch_toggle_startup_items", { ids, enabled });
      await refresh();
    } catch (e) {
      applyLocalToggle(ids, !enabled);
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

// ===== 系统健康检查（诊断命令） =====

export interface DiagnosticCheck {
  id: string;
  status: "clear" | "attention" | "collected" | "unavailable";
  summary: string;
  detail: string;
}

export interface DiagnosticDefinition {
  command: string;
  label: string;
}

export const DIAGNOSTIC_CHECKS: DiagnosticDefinition[] = [
  { command: "system_check_pending_reboot", label: "待重启状态" },
  { command: "system_check_component_health", label: "组件存储健康" },
  { command: "system_check_driver_issues", label: "设备驱动异常" },
  { command: "system_check_power_events", label: "电源唤醒事件" },
  { command: "system_check_network_configuration", label: "网络代理配置" },
  { command: "system_check_recovery_status", label: "恢复与磁盘保护" },
];

export function useSystemDiagnostics() {
  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [loading, setLoading] = useState(true);

  const run = async () => {
    setLoading(true);
    try {
      const results = await Promise.all(
        DIAGNOSTIC_CHECKS.map(async ({ command }) => {
          try {
            return await invoke<DiagnosticCheck>(command);
          } catch (e) {
            // 单命令失败降级为 unavailable，不影响其他检查项
            return {
              id: command,
              status: "unavailable",
              summary: "检查不可用",
              detail: extractErrorMessage(e),
            } satisfies DiagnosticCheck;
          }
        }),
      );
      setChecks(results);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { checks, loading, recheck: run };
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
