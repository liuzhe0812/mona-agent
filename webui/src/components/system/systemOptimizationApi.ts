import { invoke } from "@tauri-apps/api/core";

export type ConfigurationStatus = "configured" | "available" | "attention" | "unavailable" | "unknown";
export type ConfigurationRisk = "low" | "medium" | "high";

export interface ConfigurationAuditItem {
  id: string;
  category: string;
  title: string;
  description: string;
  currentValue: string;
  recommendedValue: string;
  status: ConfigurationStatus;
  risk: ConfigurationRisk;
  impact: string;
  reversible: boolean;
  requiresRestart: boolean;
  requiresAdministrator: boolean;
  canApply: boolean;
  canRestore: boolean;
  note: string;
  groupId?: string | null;
  minVersion?: number | null;
  maxVersion?: number | null;
  operationKind?: "registry" | "optionalFeature" | "action" | "legacy";
  sourceTitle?: string;
  disableWhenApplied?: boolean;
}

export interface ConfigurationCategory {
  id: string;
  label: string;
  count: number;
}

export interface ConfigurationGroupValue {
  label: string;
  featureIds: string[];
}

export interface ConfigurationGroup {
  id: string;
  category: string;
  label: string;
  description: string;
  values: ConfigurationGroupValue[];
  activeFeatureId: string | null;
}

export interface ConfigurationAudit {
  items: ConfigurationAuditItem[];
  categories: ConfigurationCategory[];
  groups: ConfigurationGroup[];
  windowsBuild: number;
  sourceVersion: string;
  sourceCommit: string;
}

export interface ConfigurationActionResult {
  itemId: string;
  success: boolean;
  detail: string;
  requiresRestart: boolean;
}

export async function getConfigurationAudit(): Promise<ConfigurationAudit> {
  const audit = await invoke<ConfigurationAudit>("system_get_configuration_audit");
  return {
    items: Array.isArray(audit.items) ? audit.items : [],
    categories: Array.isArray(audit.categories) ? audit.categories : [],
    groups: Array.isArray(audit.groups) ? audit.groups : [],
    windowsBuild: Number(audit.windowsBuild) || 0,
    sourceVersion: audit.sourceVersion || "",
    sourceCommit: audit.sourceCommit || "",
  };
}

export function applyConfigurationItem(itemId: string, mode: "recommended" | "restore") {
  return invoke<ConfigurationActionResult>("system_apply_configuration_item", { itemId, mode });
}
