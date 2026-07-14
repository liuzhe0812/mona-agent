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

export interface SystemEvidence {
  overview: Pick<SystemOverview, "cpu" | "memory" | "disks" | "network" | "topProcesses">;
  software: Pick<SoftwareCheckResult, "updates" | "wingetAvailable" | "failedCount">;
  startup: Pick<StartupListResult, "items" | "total" | "enabledCount" | "disabledCount">;
  storage: { cleanupItems: Array<Pick<StorageScanResult["cleanupItems"][number], "id" | "name" | "sizeGb" | "cleanable" | "recommended" | "reason">> };
  maintenance: MaintenanceHistory;
}

export interface SystemActionResult {
  actionId: string;
  success: boolean;
  verified: boolean;
  detail: string;
}

export async function collectSystemEvidence(storage: StorageScanResult | null): Promise<SystemEvidence> {
  const [overview, software, startup, maintenance] = await Promise.all([
    invoke<SystemOverview>("system_get_overview"),
    invoke<SoftwareCheckResult>("system_check_updates"),
    invoke<StartupListResult>("system_list_startup_items"),
    invoke<MaintenanceHistory>("system_get_maintenance_history"),
  ]);

  return {
    overview: { ...overview, topProcesses: overview.topProcesses.slice(0, 5) },
    software: { updates: software.updates.slice(0, 40), wingetAvailable: software.wingetAvailable, failedCount: software.failedCount },
    startup: {
      ...startup,
      items: startup.items.slice(0, 80).map(({ id, name, publisher, source, scope, command, targetPath, added, enabled, signed, firstSeenAt }) => ({ id, name, publisher, source, scope, command, targetPath, added, enabled, signed, firstSeenAt })),
    },
    storage: {
      cleanupItems: storage?.cleanupItems
        .filter((item) => item.cleanable)
        .slice(0, 20)
        .map(({ id, name, sizeGb, cleanable, recommended, reason }) => ({ id, name, sizeGb, cleanable, recommended, reason })) ?? [],
    },
    maintenance: { events: maintenance.events.slice(0, 20) },
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
  const payload = await response.json() as SystemAgentPlan & { error?: string };
  if (!response.ok) throw new Error(payload.error || "系统方案生成失败");
  return payload;
}

export async function executeSystemAction(action: SystemAgentAction): Promise<SystemActionResult> {
  if (action.type === "storage_clean") {
    const result = await invoke<StorageCleanupResult>("clean_storage", { ids: action.targetIds });
    const success = result.failures.length === 0;
    return {
      actionId: action.id,
      success,
      verified: success,
      detail: success ? `实际释放 ${result.freedGb.toFixed(2)} GB` : `实际释放 ${result.freedGb.toFixed(2)} GB；${result.failures.join("；")}`,
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
