import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ConnectionConfig,
  AuthConfig,
  FileInfo,
  BatchUploadRequest,
  ExpandedFileEntry,
  BatchTransferProgress,
  ProjectInfo,
  FileCheckResult,
  FileContentResult,
  WriteResult,
  IdeExecResult,
  RemoteSystemInfo,
  RemoteProcessList,
  RemotePortsData,
} from "./types/terminal";

function isTauri(): boolean {
  return !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

let terminalOutputReady: Promise<void> | undefined;

export type { ConnectionConfig, AuthConfig, FileInfo };

export async function sftpBatchUpload(
  request: BatchUploadRequest,
): Promise<string> {
  return invoke<string>("sftp_batch_upload", { request });
}

export async function expandUploadPaths(
  files: string[],
): Promise<ExpandedFileEntry[]> {
  return invoke<ExpandedFileEntry[]>("expand_upload_paths_command", { files });
}

export async function sftpBatchCancel(batchId: string): Promise<void> {
  return invoke("sftp_batch_cancel", { batchId });
}

export async function sftpBatchPause(batchId: string): Promise<void> {
  return invoke("sftp_batch_pause", { batchId });
}

export async function sftpBatchResume(batchId: string): Promise<void> {
  return invoke("sftp_batch_resume", { batchId });
}

export interface BatchTransferProgressEvent extends BatchTransferProgress {}

export function onBatchTransferProgress(
  handler: (event: BatchTransferProgressEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return Promise.resolve(() => {});
  }
  return listen<BatchTransferProgressEvent>("sftp:batch_progress", (e) => {
    handler(e.payload);
  });
}

export async function sshConnect(config: ConnectionConfig): Promise<string> {
  return invoke<string>("ssh_connect", { config });
}

export async function sshConnectWithId(
  sessionId: string,
  config: ConnectionConfig,
  cols?: number,
  rows?: number,
): Promise<string> {
  return invoke<string>("ssh_connect_with_id", { sessionId, config, cols: cols || 80, rows: rows || 24 });
}

export async function sshSendInput(sessionId: string, data: string): Promise<void> {
  return invoke("ssh_write", { sessionId, data });
}

export async function sshDisconnect(sessionId: string): Promise<void> {
  return invoke("ssh_disconnect", { sessionId });
}

export async function sshOpenSftp(sessionId: string): Promise<string> {
  return invoke<string>("ssh_open_sftp", { sessionId });
}

export async function getFileTypeIcon(
  extension: string,
  isDirectory: boolean,
): Promise<string | null> {
  return invoke<string | null>("get_file_type_icon", { extension, isDirectory });
}

export interface LocalFileInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  modified: string | null;
}

export async function localListDir(path: string): Promise<LocalFileInfo[]> {
  return invoke<LocalFileInfo[]>("local_list_dir", { path });
}

export async function localDesktopDir(): Promise<string> {
  return invoke<string>("local_desktop_dir");
}

export async function sshReconnect(
  sessionId: string,
  config: ConnectionConfig,
): Promise<string> {
  return invoke<string>("ssh_reconnect", { sessionId, config });
}

export async function sshWrite(sessionId: string, data: string): Promise<void> {
  return invoke("ssh_write", { sessionId, data });
}

export async function sshResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("ssh_resize", { sessionId, cols, rows });
}

export async function shellSpawn(cols: number, rows: number, cwd?: string): Promise<string> {
  await terminalOutputReady;
  return invoke<string>("shell_spawn", { cols, rows, cwd: cwd || null });
}

export async function shellWrite(sessionId: string, data: string): Promise<void> {
  return invoke("shell_write", { sessionId, data });
}

export async function shellResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("shell_resize", { sessionId, cols, rows });
}

export async function shellKill(sessionId: string): Promise<void> {
  return invoke("shell_kill", { sessionId });
}

export async function sftpList(sessionId: string, path: string): Promise<FileInfo[]> {
  return invoke<FileInfo[]>("sftp_list", { sessionId, path });
}

export async function ideOpenProject(
  sessionId: string,
  path: string,
): Promise<ProjectInfo> {
  return invoke("ide_open_project", { sessionId, path });
}

export async function ideCheckFile(
  sessionId: string,
  path: string,
): Promise<FileCheckResult> {
  return invoke("ide_check_file", { sessionId, path });
}

export async function ideReadFile(
  sessionId: string,
  path: string,
): Promise<FileContentResult> {
  return invoke("ide_read_file", { sessionId, path });
}

export async function ideWriteFile(
  sessionId: string,
  path: string,
  content: string,
  expectMtime: number,
  expectSize: number,
): Promise<WriteResult> {
  return invoke("ide_write_file", {
    sessionId,
    path,
    content,
    expectMtime,
    expectSize,
  });
}

export async function ideExecCommand(
  sessionId: string,
  command: string,
  cwd?: string,
): Promise<IdeExecResult> {
  return invoke("ide_exec_command", { sessionId, command, cwd });
}

export async function ideRemoteGetSystemInfo(
  sessionId: string,
): Promise<RemoteSystemInfo> {
  return invoke<RemoteSystemInfo>("ide_remote_get_system_info", { sessionId });
}

export async function ideRemoteGetProcesses(
  sessionId: string,
): Promise<RemoteProcessList> {
  return invoke<RemoteProcessList>("ide_remote_get_processes", { sessionId });
}

export async function ideRemoteGetPorts(
  sessionId: string,
): Promise<RemotePortsData> {
  return invoke<RemotePortsData>("ide_remote_get_ports", { sessionId });
}

export async function ideRemoteKillProcess(
  sessionId: string,
  pid: number,
): Promise<void> {
  return invoke("ide_remote_kill_process", { sessionId, pid });
}

export async function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke("sftp_mkdir", { sessionId, path });
}

export async function sftpRemove(
  sessionId: string,
  path: string,
  isDir: boolean,
): Promise<void> {
  return invoke("sftp_remove", { sessionId, path, isDir });
}

export async function sftpRename(
  sessionId: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  return invoke("sftp_rename", { sessionId, oldPath, newPath });
}

export async function sftpPaste(
  sessionId: string,
  srcPaths: string[],
  targetDir: string,
  action: "copy" | "cut",
): Promise<void> {
  return invoke("sftp_paste", { sessionId, srcPaths, targetDir, action });
}

export async function sftpStat(sessionId: string, path: string): Promise<FileInfo> {
  return invoke<FileInfo>("sftp_stat", { sessionId, path });
}

export async function sftpCanonicalize(
  sessionId: string,
  path: string,
): Promise<string> {
  return invoke<string>("sftp_canonicalize", { sessionId, path });
}

export async function sftpDownload(
  sessionId: string,
  remotePath: string,
): Promise<number[]> {
  return invoke<number[]>("sftp_download", { sessionId, remotePath });
}

export async function sftpUpload(
  sessionId: string,
  remotePath: string,
  data: number[],
  taskId?: string,
): Promise<void> {
  return invoke("sftp_upload", { sessionId, remotePath, data, taskId: taskId ?? null });
}

export async function sftpTouch(sessionId: string, path: string): Promise<void> {
  return invoke("sftp_touch", { sessionId, path });
}

export async function sftpChmod(
  sessionId: string,
  path: string,
  mode: number,
): Promise<void> {
  return invoke("sftp_chmod", { sessionId, path, mode });
}

export interface FileStatDetail {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  permissions: number;
  modeString: string;
  owner: string;
  group: string;
  mtime: string | null;
  atime: string | null;
}

export async function sftpStatDetail(
  sessionId: string,
  path: string,
): Promise<FileStatDetail> {
  return invoke<FileStatDetail>("sftp_stat_detail", { sessionId, path });
}

export async function sftpDownloadDir(
  sessionId: string,
  remotePath: string,
  localPath: string,
  taskId?: string,
): Promise<void> {
  return invoke("sftp_download_dir", { sessionId, remotePath, localPath, taskId });
}

export async function sftpUploadDir(
  sessionId: string,
  localPath: string,
  remotePath: string,
  taskId?: string,
): Promise<void> {
  return invoke("sftp_upload_dir", { sessionId, localPath, remotePath, taskId });
}

export interface TransferProgressEvent {
  taskId: string;
  sessionId: string;
  type: "upload" | "download";
  path: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speed: number;
}

export async function sftpUploadFile(
  sessionId: string,
  localPath: string,
  remotePath: string,
  taskId: string,
): Promise<void> {
  return invoke("sftp_upload_file", { sessionId, localPath, remotePath, taskId });
}

export async function sftpDownloadFile(
  sessionId: string,
  remotePath: string,
  localPath: string,
  taskId: string,
): Promise<void> {
  return invoke("sftp_download_file", { sessionId, remotePath, localPath, taskId });
}

export async function sftpCancelTransfer(taskId: string): Promise<void> {
  return invoke("sftp_cancel_transfer", { taskId });
}

export function onTransferProgress(
  sessionId: string,
  taskId: string,
  handler: (event: TransferProgressEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return Promise.resolve(() => {});
  }
  return listen<TransferProgressEvent>(
    `sftp:transfer:${sessionId}:${taskId}`,
    (e) => handler(e.payload),
  );
}

export async function terminalSaveConnections(
  connections: ConnectionConfig[],
): Promise<void> {
  return invoke("terminal_save_connections", { connections });
}

export async function terminalLoadConnections(): Promise<ConnectionConfig[]> {
  return invoke<ConnectionConfig[]>("terminal_load_connections");
}

export async function sshTrustHostKey(host: string, port: number): Promise<void> {
  return invoke("ssh_trust_host_key", { host, port });
}

export type UnlistenFn = () => void;

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

export interface TerminalSessionStatusEvent {
  sessionId: string;
  status: "disconnected" | "error";
}

export function onTerminalOutput(
  handler: (event: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  const registration = isTauri()
    ? listen<TerminalOutputEvent>("terminal-output", (e) => handler(e.payload))
    : Promise.resolve(() => {});
  terminalOutputReady ??= registration.then(() => undefined, () => undefined);
  return registration;
}

export function onTerminalSessionStatus(
  handler: (event: TerminalSessionStatusEvent) => void,
): Promise<UnlistenFn> {
  return isTauri()
    ? listen<TerminalSessionStatusEvent>("terminal-session-status", (event) =>
        handler(event.payload),
      )
    : Promise.resolve(() => {});
}

export async function terminalRespondExec(
  requestId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  return invoke("terminal_respond_exec", { requestId, approved, reason });
}

export interface ExecRequestEvent {
  requestId: string;
  sessionId: string;
  command: string;
  source: string;
}

export interface DesktopFileItem {
  name: string;
  type: "folder" | "file";
  size: string;
  rawSize: number;
  modified: string;
  path: string;
  mode: string;
  owner: string;
  isSymlink: boolean;
}

export interface DesktopFileListResult {
  path: string;
  files: DesktopFileItem[];
}

export interface DesktopCpuInfo {
  brand: string;
  speed: number;
  cores: number;
  physical_cores: number;
  load: number;
  load1: number;
  load5: number;
  load15: number;
  load_user: number;
  load_system: number;
}

export interface DesktopMemoryInfo {
  total: number;
  used: number;
  free: number;
  available: number;
  buffcache: number;
  used_percent: number;
}

export interface DesktopDiskInfo {
  fs: string;
  type: string;
  size: number;
  used: number;
  available: number;
  mount: string;
  use_percent: number;
  r_io_sec: number;
  w_io_sec: number;
  t_io_sec: number;
  busy_percent: number;
}

export interface DesktopDiskIOInfo {
  r_io: number;
  w_io: number;
  t_io: number;
  r_io_sec: number;
  w_io_sec: number;
  t_io_sec: number;
  busy_percent: number;
}

export interface DesktopNetworkInfo {
  iface: string;
  rx_bytes: number;
  tx_bytes: number;
  rx_sec: number;
  tx_sec: number;
}

export interface DesktopProcessInfo {
  all: number;
  running: number;
  list: DesktopProcess[];
}

export interface DesktopSystemInfo {
  cpu: DesktopCpuInfo;
  memory: DesktopMemoryInfo;
  disk: DesktopDiskInfo[];
  disk_io: DesktopDiskIOInfo;
  network: DesktopNetworkInfo[];
  processes: DesktopProcessInfo;
}

export interface DesktopProcess {
  pid: number;
  name: string;
  state: string;
  cpu: number;
  mem: number;
  disk: string;
}

export async function desktopConnect(config: ConnectionConfig): Promise<string> {
  return invoke<string>("desktop_connect", { config });
}

export async function desktopDisconnect(sessionId: string): Promise<void> {
  return invoke("desktop_disconnect", { sessionId });
}

export async function desktopExec(
  sessionId: string,
  command: string,
): Promise<string> {
  return invoke<string>("desktop_exec", { sessionId, command });
}

export async function desktopStartTerminal(
  sessionId: string,
  terminalSessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("desktop_start_terminal", {
    sessionId,
    terminalSessionId,
    cols,
    rows,
  });
}

export async function desktopSendTerminalInput(
  sessionId: string,
  input: string,
): Promise<void> {
  return invoke("desktop_send_terminal_input", { sessionId, input });
}

export async function desktopResizeTerminal(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("desktop_resize_terminal", { sessionId, cols, rows });
}

export async function desktopListFiles(
  sessionId: string,
  path: string,
): Promise<DesktopFileListResult> {
  return invoke<DesktopFileListResult>("desktop_list_files", {
    sessionId,
    path,
  });
}

export async function desktopGetFileContent(
  sessionId: string,
  path: string,
): Promise<string> {
  const result = await invoke<{ content: string }>(
    "desktop_get_file_content",
    { sessionId, path },
  );
  return result.content;
}

export async function desktopSaveFileContent(
  sessionId: string,
  path: string,
  content: string,
): Promise<void> {
  return invoke("desktop_save_file_content", { sessionId, path, content });
}

export async function desktopGetSystemInfo(
  sessionId: string,
): Promise<DesktopSystemInfo> {
  return invoke<DesktopSystemInfo>("desktop_get_system_info", { sessionId });
}

export async function desktopGetProcesses(
  sessionId: string,
): Promise<DesktopProcess[]> {
  return invoke<DesktopProcess[]>("desktop_get_processes", { sessionId });
}

export async function desktopGetDisks(
  sessionId: string,
): Promise<DesktopDiskInfo[]> {
  return invoke<DesktopDiskInfo[]>("desktop_get_disks", { sessionId });
}

export function onTerminalExecRequest(
  handler: (event: ExecRequestEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return Promise.resolve(() => {});
  }
  return listen<ExecRequestEvent>("terminal-exec-request", (e) =>
    handler(e.payload),
  );
}

// ─── VNC ────────────────────────────────────────────────────────────

export interface VncConnectConfig {
  host: string;
  port: number;
  password?: string;
  name?: string;
}

export interface VncSessionInfo {
  id: string;
  wsUrl: string;
  wsToken: string;
  host: string;
  port: number;
}

export async function vncConnect(config: VncConnectConfig): Promise<VncSessionInfo> {
  return invoke<VncSessionInfo>("vnc_connect", { config });
}

export async function vncDisconnect(sessionId: string): Promise<void> {
  return invoke("vnc_disconnect", { sessionId });
}

export async function vncReconnect(sessionId: string): Promise<VncSessionInfo> {
  return invoke<VncSessionInfo>("vnc_reconnect", { sessionId });
}

// ─── Terminal maintenance tasks ─────────────────────────────────────

export type MaintenanceTaskStatus =
  | "planning"
  | "waiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type MaintenanceTaskResolution =
  | ""
  | "completed_changes"
  | "no_changes_needed"
  | "partial"
  | "failed";

export type MaintenanceStepKind = "inspect" | "change" | "verify";

export type MaintenanceStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown"
  | "skipped"
  | "cancelled";

export interface MaintenanceTask {
  id: string;
  sessionId: string;
  configId: string;
  targetLabel: string;
  goal: string;
  execMode: string;
  status: MaintenanceTaskStatus;
  resolution: MaintenanceTaskResolution;
  diagnosis: string;
  summary: string;
  error: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface MaintenanceStep {
  id: string;
  taskId: string;
  ordinal: number;
  title: string;
  kind: MaintenanceStepKind;
  status: MaintenanceStepStatus;
  commandHash: string;
  exitCode: number | null;
  durationMs: number | null;
  approvedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface MaintenanceTaskDetail {
  task: MaintenanceTask;
  steps: MaintenanceStep[];
}

export interface TerminalMaintenanceEvent {
  sessionId: string;
  task: MaintenanceTaskDetail;
}

export async function terminalMaintenanceGetActive(
  sessionId: string,
): Promise<MaintenanceTaskDetail | null> {
  return invoke<MaintenanceTaskDetail | null>("terminal_maintenance_get_active", {
    sessionId,
  });
}

export async function terminalMaintenanceList(
  configId?: string,
  status?: MaintenanceTaskStatus,
  limit = 100,
): Promise<MaintenanceTask[]> {
  return invoke<MaintenanceTask[]>("terminal_maintenance_list", {
    configId: configId ?? null,
    status: status ?? null,
    limit,
  });
}

export async function terminalMaintenanceGet(
  taskId: string,
): Promise<MaintenanceTaskDetail> {
  return invoke<MaintenanceTaskDetail>("terminal_maintenance_get", { taskId });
}

export async function terminalMaintenanceAuthorize(
  taskId: string,
  stepIds: string[],
): Promise<MaintenanceTaskDetail> {
  return invoke<MaintenanceTaskDetail>("terminal_maintenance_authorize", {
    taskId,
    stepIds,
  });
}

export async function terminalMaintenanceCancel(
  taskId: string,
): Promise<MaintenanceTaskDetail> {
  return invoke<MaintenanceTaskDetail>("terminal_maintenance_cancel", { taskId });
}

export async function terminalMaintenanceDelete(taskId: string): Promise<void> {
  return invoke<void>("terminal_maintenance_delete", { taskId });
}

/** Clear every finished record; resolves with how many were removed. */
export async function terminalMaintenanceClear(): Promise<number> {
  return invoke<number>("terminal_maintenance_clear", {});
}

export function onTerminalMaintenanceUpdated(
  handler: (event: TerminalMaintenanceEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return Promise.resolve(() => {});
  }
  return listen<TerminalMaintenanceEvent>("terminal-maintenance-updated", (e) =>
    handler(e.payload),
  );
}
