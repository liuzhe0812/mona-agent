import { invoke } from "@tauri-apps/api/core";

import { getGatewayHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";

import type { SystemTab } from "./mockData";
import type {
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
    invoke<SoftwareCheckResult>("system_check_updates").then((result) => {
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
