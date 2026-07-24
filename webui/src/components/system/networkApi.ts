import { invoke } from "@tauri-apps/api/core";

export interface DnsPreset {
  id: string;
  label: string;
  primaryV4?: string | null;
  secondaryV4?: string | null;
  primaryV6?: string | null;
  secondaryV6?: string | null;
}

export interface DnsAdapterStatus {
  alias: string;
  servers: string[];
}

export interface DnsStatusResult {
  adapters: DnsAdapterStatus[];
  activeServers: string[];
  activePresetId: string | null;
  presets: DnsPreset[];
}

export interface DnsApplyResult {
  appliedAdapters: string[];
  detail: string;
}

export interface DnsFlushResult {
  success: boolean;
  detail: string;
}

export interface HostsEntry {
  ip: string;
  domains: string[];
  blocked: boolean;
  monaManaged: boolean;
  raw: string;
}

export interface HostsListResult {
  entries: HostsEntry[];
  backupFiles: string[];
}

export interface HostsPair {
  ip: string;
  domain: string;
}

export interface HostsEditRequest {
  add?: HostsPair[];
  remove?: string[];
  block?: string[];
  unblock?: string[];
  includeWww?: boolean;
}

export interface HostsEditResult {
  added: number;
  removed: number;
  blocked: number;
  unblocked: number;
  backupPath?: string | null;
  detail: string;
}

export function getDnsStatus() {
  return invoke<DnsStatusResult>("system_get_dns_status");
}

export function setDns(presetId: string | null, customV4?: string[] | null) {
  return invoke<DnsApplyResult>("system_set_dns", { presetId, customV4: customV4 ?? null });
}

export function resetDns() {
  return invoke<DnsApplyResult>("system_reset_dns");
}

export function flushDns() {
  return invoke<DnsFlushResult>("system_flush_dns");
}

export function listHostsEntries() {
  return invoke<HostsListResult>("system_list_hosts_entries");
}

export function editHosts(request: HostsEditRequest) {
  return invoke<HostsEditResult>("system_edit_hosts", { request });
}

export function restoreHostsBackup(backupPath: string) {
  return invoke<HostsEditResult>("system_restore_hosts_backup", { backupPath });
}
