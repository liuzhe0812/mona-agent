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

export interface FileLockHolder {
  pid: number;
  name: string;
  path?: string | null;
}

export interface FileLockResult {
  holders: FileLockHolder[];
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

export function findFileLocks(filePath: string) {
  return invoke<FileLockResult>("system_find_file_locks", { filePath });
}

export function terminateLockHolder(pid: number) {
  return invoke<string>("system_terminate_lock_holder", { pid });
}

// ===== P5 注册表修复 =====
export interface RepairItem {
  id: string;
  label: string;
  description: string;
  isBroken: boolean;
  risk: string;
  requiresAdministrator: boolean;
  canRepair: boolean;
  currentDetail: string;
}

export interface RepairResult {
  itemId: string;
  success: boolean;
  detail: string;
  requiresRestart: boolean;
}

export function checkSystemIntegrity() {
  return invoke<RepairItem[]>("system_check_system_integrity");
}

export function repairItem(itemId: string) {
  return invoke<RepairResult>("system_repair_item", { itemId });
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
