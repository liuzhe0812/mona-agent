import { invoke } from "@tauri-apps/api/core";

// ===== P2 性能微调 =====
export interface PerformanceItem {
  id: string;
  label: string;
  description: string;
  category: string;
  risk: string;
  requiresReboot: boolean;
  requiresAdministrator: boolean;
  canRestore: boolean;
  isApplied: boolean;
  currentDetail: string;
}

export interface PerformanceActionResult {
  itemId: string;
  success: boolean;
  detail: string;
  requiresRestart: boolean;
}

export function listPerformanceItems() {
  return invoke<PerformanceItem[]>("system_list_performance_items");
}

export function applyPerformanceItem(itemId: string, mode: string) {
  return invoke<PerformanceActionResult>("system_apply_performance_item", { itemId, mode });
}

// ===== P3 右键菜单 =====
export interface ContextMenuItem {
  id: string;
  label: string;
  description: string;
  risk: string;
  isApplied: boolean;
}

export interface ContextMenuActionResult {
  itemId: string;
  success: boolean;
  detail: string;
}

export function listContextMenuItems() {
  return invoke<ContextMenuItem[]>("system_list_context_menu_items");
}

export function applyContextMenuItem(itemId: string, mode: string) {
  return invoke<ContextMenuActionResult>("system_apply_context_menu_item", { itemId, mode });
}

// ===== P4 进程控制 =====
export interface BlockedProcess {
  exeName: string;
  addedAt: number;
}

export interface BlockResult {
  exeName: string;
  success: boolean;
  detail: string;
}

export function listBlockedProcesses() {
  return invoke<BlockedProcess[]>("system_list_blocked_processes");
}

export function blockProcess(exeName: string) {
  return invoke<BlockResult>("system_block_process", { exeName });
}

export function unblockProcess(exeName: string) {
  return invoke<BlockResult>("system_unblock_process", { exeName });
}

// ===== P6 Defender =====
export interface DefenderStatus {
  realtimeEnabled: boolean;
  isManagedByPolicy: boolean;
  canControl: boolean;
  thirdPartyAv: string[];
  detail: string;
}

export interface DefenderActionResult {
  success: boolean;
  detail: string;
  requiresRestart: boolean;
}

export function getDefenderStatus() {
  return invoke<DefenderStatus>("system_get_defender_status");
}

export function disableDefender() {
  return invoke<DefenderActionResult>("system_disable_defender");
}

export function enableDefender() {
  return invoke<DefenderActionResult>("system_enable_defender");
}
