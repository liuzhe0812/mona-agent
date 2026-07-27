export type Protocol = "ssh" | "sftp" | "ftp" | "local" | "vnc";

export type AuthConfig =
  | { type: "password"; password: string }
  | { type: "key"; keyPath: string; passphrase?: string }
  | { type: "agent" };

export interface ConnectionConfig {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  auth: AuthConfig;
}

export type SessionStatus = "disconnected" | "connecting" | "connected" | "error";

export type SessionType = "local" | "ssh" | "sftp" | "ftp" | "batch" | "desktop" | "vnc";

export interface Session {
  id: string;
  configId: string;
  type: SessionType;
  status: SessionStatus;
  title: string;
  /** VNC: WebSocket URL for noVNC to connect to */
  vncWsUrl?: string;
  /** VNC: one-time token for WS authentication */
  vncWsToken?: string;
  /** VNC: password for VNC server authentication */
  vncPassword?: string;
}

export interface FileInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  permissions: number | null;
  mtime: number | null;
  owner: string | null;
  group: string | null;
}

export type BatchTransferStatus =
  | "connecting"
  | "transferring"
  | "completed"
  | "error"
  | "cancelled";

export interface BatchTransferProgress {
  batchId: string;
  sessionId: string;
  host: string;
  status: BatchTransferStatus;
  currentFile: string | null;
  filesCompleted: number;
  filesTotal: number;
  bytesTransferred: number;
  bytesTotal: number;
  error: string | null;
  speed: number | null;
  etaSeconds: number | null;
}

export interface BatchSessionInfo {
  sessionId: string;
  host: string;
  port: number;
  username: string;
}

export interface BatchUploadRequest {
  sessions: BatchSessionInfo[];
  files: string[];
  targetDirectory: string;
  maxConcurrent?: number;
}

export interface ExpandedFileEntry {
  localPath: string;
  relPrefix: string;
  displayName: string;
}

export interface ProjectInfo {
  rootPath: string;
  name: string;
}

export type FileCheckResult =
  | { type: "editable"; size: number; mtime: number }
  | { type: "too_large"; size: number; limit: number }
  | { type: "binary" }
  | { type: "not_editable"; reason: string };

export interface FileContentResult {
  content: string;
  mtime: number;
  size: number;
}

export interface WriteResult {
  mtime: number;
  size: number;
}

export interface IdeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface BatchConnectConfig {
  startIp: string;
  count: number;
  username: string;
  password: string;
  port: number;
}

export interface RemoteCpuInfo {
  load: number;
  load1: number;
  load5: number;
  load15: number;
  speed: number;
  cores: number;
  brand: string;
  loadUser: number;
  loadSystem: number;
}

export interface RemoteMemoryInfo {
  used: number;
  total: number;
  usedPercent: number;
  free: number;
  buffcache: number;
}

export interface RemoteDiskInfo {
  fs: string;
  used: number;
  size: number;
  usePercent: number;
  busyPercent: number;
  rIoSec: number;
  wIoSec: number;
  diskType: string;
}

export interface RemoteNetworkInfo {
  iface: string;
  rxSec: number;
  txSec: number;
}

export interface RemoteProcessInfo {
  pid: number;
  name: string;
  user: string;
  cpuPercent: number;
  memPercent: number;
  memRss: number;
  state: string;
}

export interface RemoteProcessList {
  processes: RemoteProcessInfo[];
  timestamp: number;
}

export interface RemoteProcessCount {
  all: number;
  running: number;
}

export interface RemoteSystemInfo {
  cpu: RemoteCpuInfo;
  memory: RemoteMemoryInfo;
  disk: RemoteDiskInfo[];
  network: RemoteNetworkInfo[];
  processes: RemoteProcessCount;
}

export interface RemotePortInfo {
  protocol: string;
  localAddr: string;
  localPort: number;
  state: string;
  pid: number | null;
  processName: string | null;
  processUser: string | null;
}

export interface RemotePortsData {
  ports: RemotePortInfo[];
  timestamp: number;
}
