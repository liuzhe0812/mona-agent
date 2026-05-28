export type Protocol = "ssh" | "sftp" | "ftp" | "local";

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

export type SessionType = "local" | "ssh" | "sftp" | "ftp" | "batch" | "desktop";

export interface Session {
  id: string;
  configId: string;
  type: SessionType;
  status: SessionStatus;
  title: string;
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
  | "Pending"
  | "Connecting"
  | "Transferring"
  | "Completed"
  | "Error"
  | "Cancelled";

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

export interface BatchConnectConfig {
  startIp: string;
  count: number;
  username: string;
  password: string;
  port: number;
}
