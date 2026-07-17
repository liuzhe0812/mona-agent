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

export interface SystemEvidence {
  overview: Pick<SystemOverview, "cpu" | "memory" | "disks" | "network" | "topProcesses">;
  software: Pick<SoftwareCheckResult, "updates" | "wingetAvailable" | "failedCount">;
  startup: Omit<StartupListResult, "items"> & { items: StartupEvidenceItem[] };
  storage: { cleanupItems: Array<Pick<StorageScanResult["cleanupItems"][number], "id" | "name" | "sizeGb" | "cleanable" | "recommended" | "reason">> };
  maintenance: MaintenanceHistory;
}

export type SystemEvidenceStage = "overview" | "storage" | "software" | "startup" | "maintenance";

export interface SystemActionResult {
  actionId: string;
  success: boolean;
  verified: boolean;
  detail: string;
}

export type DiagnosticSymptom = "general" | "performance" | "boot" | "power" | "network" | "device" | "update";
export type DiagnosticStage = "pending_reboot" | "component_health" | "driver_issues" | "power_events" | "network_configuration" | "recovery_status";

export interface DiagnosticCheck {
  id: DiagnosticStage;
  status: "clear" | "attention" | "collected" | "unavailable";
  summary: string;
  detail: string;
}

export interface SystemDiagnosticEvidence {
  symptom: DiagnosticSymptom;
  checks: DiagnosticCheck[];
}

export interface SystemDiagnosticHypothesis {
  title: string;
  confidence: "low" | "medium" | "high";
  evidenceIds: DiagnosticStage[];
  explanation: string;
  nextStep: string;
}

export interface SystemDiagnosticReport {
  summary: string;
  hypotheses: SystemDiagnosticHypothesis[];
  cautions: string[];
}

const diagnosticCommands: Record<DiagnosticStage, string> = {
  pending_reboot: "system_check_pending_reboot",
  component_health: "system_check_component_health",
  driver_issues: "system_check_driver_issues",
  power_events: "system_check_power_events",
  network_configuration: "system_check_network_configuration",
  recovery_status: "system_check_recovery_status",
};

const diagnosticStagesBySymptom: Record<DiagnosticSymptom, DiagnosticStage[]> = {
  general: ["pending_reboot", "component_health", "driver_issues", "power_events", "network_configuration", "recovery_status"],
  performance: ["pending_reboot", "component_health", "driver_issues"],
  boot: ["pending_reboot", "component_health", "driver_issues"],
  power: ["power_events", "pending_reboot", "recovery_status"],
  network: ["network_configuration", "pending_reboot", "component_health"],
  device: ["driver_issues", "component_health", "pending_reboot"],
  update: ["pending_reboot", "component_health", "recovery_status"],
};

export function diagnosticStages(symptom: DiagnosticSymptom): DiagnosticStage[] {
  return diagnosticStagesBySymptom[symptom];
}

export async function collectSystemDiagnosticEvidence(
  symptom: DiagnosticSymptom,
  onProgress?: (stage: DiagnosticStage, state: "running" | "completed") => void,
): Promise<SystemDiagnosticEvidence> {
  const checks = await Promise.all(diagnosticStages(symptom).map(async (stage) => {
    onProgress?.(stage, "running");
    try {
      return await invoke<DiagnosticCheck>(diagnosticCommands[stage]);
    } catch (error) {
      return { id: stage, status: "unavailable", summary: "本机检查未完成", detail: String(error) } satisfies DiagnosticCheck;
    } finally {
      onProgress?.(stage, "completed");
    }
  }));
  return { symptom, checks };
}

export async function requestSystemDiagnosis(
  symptom: string,
  evidence: SystemDiagnosticEvidence,
): Promise<SystemDiagnosticReport> {
  const base = await getGatewayHttpBase();
  if (!base) throw new Error("Mona 服务未就绪，请稍后重试");
  const response = await httpFetch(`${base}/api/system/diagnose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symptom, evidence }),
  });
  const payload = await response.json() as Partial<SystemDiagnosticReport> & { error?: string };
  if (!response.ok) throw new Error(payload.error || "故障诊断生成失败");
  return {
    summary: typeof payload.summary === "string" ? payload.summary : "Mona 未返回可用结论",
    hypotheses: Array.isArray(payload.hypotheses) ? payload.hypotheses.filter((hypothesis): hypothesis is SystemDiagnosticHypothesis => Boolean(hypothesis) && typeof hypothesis.title === "string" && typeof hypothesis.explanation === "string" && typeof hypothesis.nextStep === "string" && ["low", "medium", "high"].includes(hypothesis.confidence) && Array.isArray(hypothesis.evidenceIds)).slice(0, 3) : [],
    cautions: Array.isArray(payload.cautions) ? payload.cautions.filter((caution): caution is string => typeof caution === "string").slice(0, 3) : [],
  };
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
