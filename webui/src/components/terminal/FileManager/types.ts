export type TransferStatus = "waiting" | "transferring" | "completed" | "error" | "cancelled";

export interface TransferFileInfo {
  name: string;
  localPath: string;
  remotePath: string;
  size: number;
  status: "pending" | "transferring" | "completed" | "error";
}

export interface TransferTask {
  id: string;
  type: "upload" | "download";
  status: TransferStatus;
  currentFile: string;
  currentFileIndex: number;
  totalFiles: number;
  progress: number;
  speed: string;
  bytesTransferred: number;
  totalBytes: number;
  error?: string;
  files: TransferFileInfo[];
}
