import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ConnectionConfig, AuthConfig, FileInfo, BatchUploadRequest, BatchTransferProgress } from "./types/terminal";

function isTauri(): boolean {
  return !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

export type { ConnectionConfig, AuthConfig, FileInfo };

export async function sftpBatchUpload(
  request: BatchUploadRequest,
): Promise<string> {
  return invoke<string>("sftp_batch_upload", { request });
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

export async function getFileIcon(path: string): Promise<string> {
  return invoke<string>("get_file_icon", { path });
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

export async function localHomeDir(): Promise<string> {
  return invoke<string>("local_home_dir");
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

export async function shellSpawn(cols: number, rows: number): Promise<string> {
  return invoke<string>("shell_spawn", { cols, rows });
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

export async function shellGetBuffer(sessionId: string): Promise<string> {
  return invoke<string>("shell_get_buffer", { sessionId });
}

export async function sftpList(sessionId: string, path: string): Promise<FileInfo[]> {
  return invoke<FileInfo[]>("sftp_list", { sessionId, path });
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
): Promise<void> {
  return invoke("sftp_upload", { sessionId, remotePath, data });
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
): Promise<void> {
  return invoke("sftp_download_dir", { sessionId, remotePath, localPath });
}

export async function sftpUploadDir(
  sessionId: string,
  localPath: string,
  remotePath: string,
): Promise<void> {
  return invoke("sftp_upload_dir", { sessionId, localPath, remotePath });
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

export async function sshRemoveHostKey(host: string, port: number): Promise<void> {
  return invoke("ssh_remove_host_key", { host, port });
}

export async function sshPortForward(
  sessionId: string,
  forwardType: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<number> {
  return invoke<number>("ssh_port_forward", {
    sessionId,
    forwardType,
    localPort,
    remoteHost,
    remotePort,
  });
}

export interface SftpTransferProgressEvent {
  sessionId: string;
  path: string;
  direction: "upload" | "download";
  bytesTransferred: number;
  totalBytes: number | null;
}

export type UnlistenFn = () => void;

export function onSftpTransferProgress(
  handler: (event: SftpTransferProgressEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return Promise.resolve(() => {});
  }
  return listen<SftpTransferProgressEvent>("sftp-transfer-progress", (e) => {
    handler(e.payload);
  });
}

export interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

export function onTerminalOutput(
  handler: (event: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return Promise.resolve(() => {});
  }
  return listen<TerminalOutputEvent>("terminal-output", (e) =>
    handler(e.payload),
  );
}

export interface SessionInfo {
  id: string;
  configId: string;
  sessionType: string;
  status: string;
  createdAt: string;
}

export async function terminalListSessions(): Promise<SessionInfo[]> {
  return invoke<SessionInfo[]>("terminal_list_sessions");
}

export async function terminalGetOutput(sessionId: string): Promise<string> {
  return invoke<string>("terminal_get_output", { sessionId });
}

export async function terminalExecCommand(
  sessionId: string,
  command: string,
): Promise<void> {
  return invoke("terminal_exec_command", { sessionId, command });
}

export interface PendingCommand {
  requestId: string;
  sessionId: string;
  command: string;
  source: string;
}

export async function terminalRequestExec(
  sessionId: string,
  command: string,
  source: string,
): Promise<string> {
  return invoke<string>("terminal_request_exec", { sessionId, command, source });
}

export async function terminalRespondExec(
  requestId: string,
  approved: boolean,
  reason?: string,
): Promise<void> {
  return invoke("terminal_respond_exec", { requestId, approved, reason });
}

export async function terminalListPendingExec(): Promise<PendingCommand[]> {
  return invoke<PendingCommand[]>("terminal_list_pending_exec");
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
