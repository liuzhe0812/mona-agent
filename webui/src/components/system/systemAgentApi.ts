import { invoke } from "@tauri-apps/api/core";

import { getGatewayHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";

import type { SystemTab } from "./systemTabs";
import type {
  DiagnosticCheck,
  DirectorySize,
  MaintenanceHistory,
  SoftwareActionResult,
  SoftwareCheckResult,
  StartupListResult,
  StorageCleanupResult,
  StorageScanResult,
  SystemOverview,
} from "./useSystemData";

export type SystemAgentActionType = "storage_clean" | "software_update" | "startup_disable";

export interface SystemAgentAction {
  id: string;
  type: SystemAgentActionType;
  targetIds: string[];
  targetNames: string[];
  title: string;
  reason: string;
  risk: "low" | "medium";
  evidenceTab: SystemTab;
}

export interface SystemAgentPlan {
  summary: string;
  findings: string[];
  actions: SystemAgentAction[];
}

type StartupEvidenceItem = Omit<StartupListResult["items"][number], "command" | "targetPath">;

export interface StorageEvidence {
  cleanupItems: Array<Pick<StorageScanResult["cleanupItems"][number], "id" | "name" | "sizeGb" | "cleanable" | "recommended" | "reason">>;
  scanSummary?: StorageScanResult["scanSummary"];
  topFileBuckets?: Array<{ extension: string; count: number; sizeGb: number }>;
  fileTypes?: StorageScanResult["fileTypes"];
  totalScannedGb?: number;
}

export interface SystemEvidence {
  overview: Pick<SystemOverview, "cpu" | "memory" | "disks" | "network" | "topProcesses">;
  software: Pick<SoftwareCheckResult, "updates" | "wingetAvailable" | "failedCount">;
  startup: Omit<StartupListResult, "items"> & { items: StartupEvidenceItem[] };
  storage: StorageEvidence;
  maintenance: MaintenanceHistory;
  /** 诊断请求附加的健康检查快照，供后端校验 hypotheses 的 evidenceIds */
  checks?: DiagnosticCheck[];
}

export type SystemEvidenceStage = "overview" | "storage" | "software" | "startup" | "maintenance";

export interface SystemActionResult {
  actionId: string;
  success: boolean;
  verified: boolean;
  detail: string;
}

function isSystemAgentActionType(value: unknown): value is SystemAgentActionType {
  return value === "storage_clean" || value === "software_update" || value === "startup_disable";
}

// winget 全量检查为秒级耗时，证据采集对结果做 60s 模块级缓存；
// 执行动作后的复检绕过缓存（见 executeSystemAction）
const SOFTWARE_EVIDENCE_TTL_MS = 60_000;
let softwareEvidenceCache: { at: number; value: SoftwareCheckResult } | null = null;

async function loadSoftwareCheck(): Promise<SoftwareCheckResult> {
  if (softwareEvidenceCache && Date.now() - softwareEvidenceCache.at < SOFTWARE_EVIDENCE_TTL_MS) {
    return softwareEvidenceCache.value;
  }
  const value = await invoke<SoftwareCheckResult>("system_check_updates");
  softwareEvidenceCache = { at: Date.now(), value };
  return value;
}

export async function collectSystemEvidence(
  storage: StorageScanResult | null,
  onProgress?: (stage: SystemEvidenceStage) => void,
): Promise<SystemEvidence> {
  const [overview, software, startup, maintenance] = await Promise.all([
    invoke<SystemOverview>("system_get_overview").then((result) => {
      onProgress?.("overview");
      onProgress?.("storage");
      return result;
    }),
    loadSoftwareCheck().then((result) => {
      onProgress?.("software");
      return result;
    }),
    invoke<StartupListResult>("system_list_startup_items").then((result) => {
      onProgress?.("startup");
      return result;
    }),
    invoke<MaintenanceHistory>("system_get_maintenance_history").then((result) => {
      onProgress?.("maintenance");
      return result;
    }),
  ]);

  return {
    overview: { ...overview, topProcesses: overview.topProcesses.slice(0, 5) },
    software: { updates: software.updates.slice(0, 40), wingetAvailable: software.wingetAvailable, failedCount: software.failedCount },
    startup: {
      ...startup,
      items: startup.items.slice(0, 80).map(({ id, name, publisher, source, scope, added, enabled, signed, firstSeenAt, isNew }) => ({ id, name, publisher, source, scope, added, enabled, signed, firstSeenAt, isNew })),
    },
    storage: buildStorageEvidence(storage),
    maintenance: { events: maintenance.events.slice(0, 20) },
  };
}

/** 从扫描结果构造脱敏的存储证据（不含完整路径和文件名，仅含统计与扩展名桶） */
export function buildStorageEvidence(storage: StorageScanResult | null): StorageEvidence {
  if (!storage) {
    return { cleanupItems: [] };
  }
  return {
    cleanupItems: storage.cleanupItems
      .filter((item) => item.cleanable)
      .slice(0, 20)
      .map(({ id, name, sizeGb, cleanable, recommended, reason }) => ({ id, name, sizeGb, cleanable, recommended, reason })),
    scanSummary: storage.scanSummary,
    topFileBuckets: storage.extensionBuckets?.slice(0, 20),
    fileTypes: storage.fileTypes,
    totalScannedGb: storage.totalScannedGb,
  };
}

function shortStorageName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function storagePathContains(parent: string, candidate: string): boolean {
  const normalizedParent = parent.replaceAll("/", "\\").replace(/\\+$/, "").toLocaleLowerCase();
  const normalizedCandidate = candidate.replaceAll("/", "\\").toLocaleLowerCase();
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}\\`);
}

function directoryAnalysisEvidence(directory: DirectorySize): StorageAnalysisDirectoryEvidence {
  return {
    id: directory.id,
    sizeGb: directory.sizeGb,
    fileCount: directory.fileCount,
    directSizeGb: directory.directSizeGb,
    artifactKind: directory.insight?.artifactKind ?? null,
    fileTypes: directory.insight?.fileTypes ?? [],
    modifiedBuckets: directory.insight?.modifiedBuckets ?? [],
    topExtensions: directory.insight?.topExtensions ?? [],
  };
}

/** Build one compact, path-free scope for the dedicated storage analysis endpoint. */
export function buildStorageAnalysisContext(
  storage: StorageScanResult,
  selectedDirectory: DirectorySize | null,
): StorageAnalysisContext {
  const rootId = `storage-root-${storage.scanId}`;
  const scope = selectedDirectory
    ? directoryAnalysisEvidence(selectedDirectory)
    : {
        id: rootId,
        sizeGb: storage.totalScannedGb,
        fileCount: storage.scanSummary?.totalFiles ?? 0,
        directSizeGb: 0,
        artifactKind: null,
        fileTypes: storage.fileTypes,
        modifiedBuckets: [],
        topExtensions: storage.extensionBuckets?.slice(0, 8) ?? [],
      };
  const children = (selectedDirectory?.children ?? storage.directories)
    .slice(0, 20)
    .map(directoryAnalysisEvidence);
  const scopedFiles = (storage.topFiles ?? [])
    .filter((file) => !selectedDirectory || storagePathContains(selectedDirectory.path, file.path))
    .slice(0, 20)
    .map(({ id, extension, sizeGb, modifiedBucket }) => ({ id, extension, sizeGb, modifiedBucket }));
  const cleanupItems = selectedDirectory
    ? []
    : storage.cleanupItems
        .filter((item) => item.cleanable)
        .slice(0, 20)
        .map(({ id, name, sizeGb, cleanable, reason }) => ({ id, name, sizeGb, cleanable, reason }));

  const labels: Record<string, string> = {
    [scope.id]: selectedDirectory ? shortStorageName(selectedDirectory.path) : "当前磁盘",
  };
  for (const directory of selectedDirectory?.children ?? storage.directories) {
    labels[directory.id] = shortStorageName(directory.path);
  }
  for (const file of storage.topFiles ?? []) {
    labels[file.id] = `${file.parentDirName} / ${file.extension === "(none)" ? "文件" : `.${file.extension}`}`;
  }
  for (const item of storage.cleanupItems) {
    labels[item.id] = item.name;
  }

  return {
    evidence: {
      scanId: storage.scanId,
      scope,
      children,
      largeFiles: scopedFiles,
      cleanupItems,
    },
    labels,
    scopeName: labels[scope.id],
  };
}

function isStorageFindingAction(value: unknown): value is StorageFindingAction {
  return value === "plan_cleanup" || value === "review_files" || value === "inspect_directory" || value === "none";
}

export async function requestStorageAnalysis(
  goal: string,
  evidence: StorageAnalysisEvidence,
): Promise<StorageAssessment> {
  const base = await getGatewayHttpBase();
  if (!base) throw new Error("Mona 服务未就绪，请稍后重试");
  const response = await httpFetch(`${base}/api/system/storage/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal, evidence }),
  });
  const payload = await response.json() as Partial<StorageAssessment> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "存储分析失败");
  const knownIds = new Set([
    evidence.scope.id,
    ...evidence.children.map((item) => item.id),
    ...evidence.largeFiles.map((item) => item.id),
    ...evidence.cleanupItems.map((item) => item.id),
  ]);
  return {
    scanId: typeof payload.scanId === "string" ? payload.scanId : evidence.scanId,
    summary: typeof payload.summary === "string" ? payload.summary : "Mona 未返回可用的存储结论",
    findings: Array.isArray(payload.findings)
      ? payload.findings.filter((finding): finding is StorageFinding =>
          Boolean(finding)
          && typeof finding.id === "string"
          && typeof finding.title === "string"
          && typeof finding.detail === "string"
          && Array.isArray(finding.evidenceIds)
          && finding.evidenceIds.some((id) => knownIds.has(id))
          && isStorageFindingAction(finding.action))
      : [],
    cautions: Array.isArray(payload.cautions)
      ? payload.cautions.filter((item): item is string => typeof item === "string").slice(0, 3)
      : [],
  };
}

export async function requestSystemPlan(goal: string, evidence: SystemEvidence): Promise<SystemAgentPlan> {
  const base = await getGatewayHttpBase();
  if (!base) throw new Error("Mona 服务未就绪，请稍后重试");
  const response = await httpFetch(`${base}/api/system/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal, evidence }),
  });
  const payload = await response.json() as Partial<SystemAgentPlan> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "系统方案生成失败");
  return {
    summary: typeof payload.summary === "string" ? payload.summary : "Mona 未返回可用结论",
    findings: Array.isArray(payload.findings) ? payload.findings.filter((finding): finding is string => typeof finding === "string").slice(0, 5) : [],
    actions: Array.isArray(payload.actions)
      ? payload.actions.filter((action): action is SystemAgentAction => Boolean(action) && isSystemAgentActionType(action.type))
      : [],
  };
}

export interface SystemDiagnosisHypothesis {
  title: string;
  confidence: "low" | "medium" | "high";
  evidenceIds: string[];
  explanation: string;
  nextStep: string;
}

export interface StorageAnalysisDirectoryEvidence {
  id: string;
  sizeGb: number;
  fileCount: number;
  directSizeGb: number;
  artifactKind: string | null;
  fileTypes: StorageScanResult["fileTypes"];
  modifiedBuckets: NonNullable<DirectorySize["insight"]>["modifiedBuckets"];
  topExtensions: NonNullable<DirectorySize["insight"]>["topExtensions"];
}

export interface StorageAnalysisEvidence {
  scanId: string;
  scope: StorageAnalysisDirectoryEvidence;
  children: StorageAnalysisDirectoryEvidence[];
  largeFiles: Array<Pick<NonNullable<StorageScanResult["topFiles"]>[number], "id" | "extension" | "sizeGb" | "modifiedBucket">>;
  cleanupItems: Array<Pick<StorageScanResult["cleanupItems"][number], "id" | "name" | "sizeGb" | "cleanable" | "reason">>;
}

export type StorageFindingAction = "plan_cleanup" | "review_files" | "inspect_directory" | "none";

export interface StorageFinding {
  id: string;
  title: string;
  detail: string;
  confidence: "low" | "medium" | "high";
  risk: "low" | "review" | "keep";
  evidenceIds: string[];
  action: StorageFindingAction;
  targetIds: string[];
  relatedSizeGb: number;
}

export interface StorageAssessment {
  scanId: string;
  summary: string;
  findings: StorageFinding[];
  cautions: string[];
}

export interface StorageAnalysisContext {
  evidence: StorageAnalysisEvidence;
  labels: Record<string, string>;
  scopeName: string;
}

export interface SystemDiagnosisResult {
  summary: string;
  hypotheses: SystemDiagnosisHypothesis[];
  cautions: string[];
}

export async function requestSystemDiagnosis(
  symptom: string,
  evidence: SystemEvidence,
): Promise<SystemDiagnosisResult> {
  const base = await getGatewayHttpBase();
  if (!base) throw new Error("Mona 服务未就绪，请稍后重试");
  const response = await httpFetch(`${base}/api/system/diagnose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symptom, evidence }),
  });
  const payload = await response.json() as Partial<SystemDiagnosisResult> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "系统诊断生成失败");
  return {
    summary: typeof payload.summary === "string" ? payload.summary : "Mona 未返回可用结论",
    hypotheses: Array.isArray(payload.hypotheses)
      ? payload.hypotheses.filter((item): item is SystemDiagnosisHypothesis =>
          Boolean(item) && typeof item.title === "string" && Array.isArray(item.evidenceIds))
      : [],
    cautions: Array.isArray(payload.cautions)
      ? payload.cautions.filter((item): item is string => typeof item === "string").slice(0, 3)
      : [],
  };
}

export async function executeSystemAction(action: SystemAgentAction): Promise<SystemActionResult> {
  if (action.type === "storage_clean") {
    const result = await invoke<StorageCleanupResult>("clean_storage", { ids: action.targetIds });
    const success = result.failures.length === 0;
    // 优先使用 verification 数组的真实测量值，避免 freedGb 虚报（文件被占用时 before/after 差为 0）
    const verifiedFreedBytes = result.verification?.reduce(
      (sum, v) => sum + Math.max(0, v.beforeBytes - v.afterBytes),
      0,
    ) ?? null;
    const freedGb = verifiedFreedBytes !== null
      ? verifiedFreedBytes / 1_073_741_824
      : result.freedGb;
    return {
      actionId: action.id,
      success,
      verified: success,
      detail: success
        ? `实际释放 ${freedGb.toFixed(2)} GB`
        : `实际释放 ${freedGb.toFixed(2)} GB；${result.failures.join("；")}`,
    };
  }

  if (action.type === "software_update") {
    let completed = 0;
    const errors: string[] = [];
    for (const [index, id] of action.targetIds.entries()) {
      try {
        const result = await invoke<SoftwareActionResult>("system_upgrade_software", { id, name: action.targetNames[index] || id });
        if (result.success) completed += 1;
        else errors.push(result.message);
      } catch (error) {
        errors.push(String(error));
      }
    }
    const success = errors.length === 0;
    // 复检必须拿到最新数据，先让证据缓存失效
    softwareEvidenceCache = null;
    const current = await invoke<SoftwareCheckResult>("system_check_updates");
    const verified = action.targetIds.every((id) => !current.updates.some((update) => update.id === id));
    return {
      actionId: action.id,
      success,
      verified,
      detail: success
        ? (verified ? `${completed} 项更新完成，已复检` : `${completed} 项更新完成，但复检仍显示待更新`)
        : `${completed} 项完成；${errors.join("；")}`,
    };
  }

  if (action.type !== "startup_disable") {
    throw new Error("不支持的系统操作");
  }

  for (const id of action.targetIds) {
    await invoke("system_toggle_startup_item", { id, enabled: false });
  }
  const current = await invoke<StartupListResult>("system_list_startup_items");
  const verified = action.targetIds.every((id) => current.items.find((item) => item.id === id)?.enabled === false);
  return {
    actionId: action.id,
    success: verified,
    verified,
    detail: verified ? `${action.targetIds.length} 项启动项已禁用，可在维护记录中恢复` : "启动项状态复检未通过",
  };
}
