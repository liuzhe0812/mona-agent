import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { FilePane } from "./FilePane";
import type { UnifiedFileItem } from "./FilePane";
import {
  sftpList,
  sftpMkdir,
  sftpStat,
  sftpRemove,
  sftpRename,
  sftpCanonicalize,
  sftpUpload,
  sftpUploadFile,
  sftpDownloadFile,
  sftpCancelTransfer,
  sftpUploadDir,
  sftpDownloadDir,
  sftpTouch,
  onTransferProgress,
  localListDir,
  localDesktopDir,
} from "../ipc";
import type { FileInfo } from "../types/terminal";
import type { LocalFileInfo } from "../ipc";
import { PropertiesDialog } from "./PropertiesDialog";
import { PermissionsDialog } from "./PermissionsDialog";
import { TransferPanel } from "./TransferPanel";
import { useTerminalStore } from "../store/terminalStore";
import type { TransferTask, TransferFileInfo } from "./types";

interface Props {
  sessionId: string;
  active?: boolean;
  connected?: boolean;
}

interface ClipboardEntry {
  side: "local" | "remote";
  files: UnifiedFileItem[];
  mode: "copy" | "cut";
}

interface TransferControl {
  id: string;
  cancelled: boolean;
  currentFileId: string | null;
  cancelPromise: Promise<void> | null;
}

function localToUnified(f: LocalFileInfo): UnifiedFileItem {
  return {
    name: f.name,
    path: f.path,
    isDir: f.isDir,
    size: f.size,
    modified: f.modified,
    permissions: null,
  };
}

function remoteToUnified(f: FileInfo): UnifiedFileItem {
  return {
    name: f.name,
    path: f.path,
    isDir: f.isDir,
    size: f.size,
    modified: f.mtime ? new Date(f.mtime * 1000).toLocaleString() : null,
    permissions: f.permissions
      ? (() => {
          const p = f.permissions;
          const rwx = (n: number) =>
            (n & 4 ? "r" : "-") + (n & 2 ? "w" : "-") + (n & 1 ? "x" : "-");
          return rwx((p >> 6) & 7) + rwx((p >> 3) & 7) + rwx(p & 7);
        })()
      : null,
  };
}

export function FileManager({ sessionId, active = true, connected = true }: Props) {
  const [localPath, setLocalPath] = useState("");
  const [localFiles, setLocalFiles] = useState<UnifiedFileItem[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const localRequest = useRef(0);
  const localInitialized = useRef(false);
  const localPathRef = useRef<string | null>(null);
  const [localShowHidden, setLocalShowHidden] = useState(false);
  const [localSelectedPaths, setLocalSelectedPaths] = useState<Set<string>>(new Set());

  const [remotePath, setRemotePath] = useState("/");
  const [remoteFiles, setRemoteFiles] = useState<UnifiedFileItem[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const remoteRequest = useRef(0);
  const remoteInitialized = useRef(false);
  const remotePathRef = useRef<string | null>(null);
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  const [remoteShowHidden, setRemoteShowHidden] = useState(false);
  const [remoteSelectedPaths, setRemoteSelectedPaths] = useState<Set<string>>(new Set());

  const [clipboard, setClipboard] = useState<ClipboardEntry | null>(null);
  const activeSideRef = useRef<"local" | "remote">("local");
  const containerRef = useRef<HTMLDivElement>(null);

  const [mkdirDialogOpen, setMkdirDialogOpen] = useState(false);
  const [mkdirTarget, setMkdirTarget] = useState<"local" | "remote">("remote");
  const [newFolderName, setNewFolderName] = useState("");

  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
  const [newFileTarget, setNewFileTarget] = useState<"local" | "remote">("remote");
  const [newFileName, setNewFileName] = useState("");

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<UnifiedFileItem | null>(null);
  const [renameSide, setRenameSide] = useState<"local" | "remote">("remote");
  const [renameValue, setRenameValue] = useState("");

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<UnifiedFileItem | null>(null);
  const [deleteSide, setDeleteSide] = useState<"local" | "remote">("remote");

  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [propertiesTarget, setPropertiesTarget] = useState<UnifiedFileItem | null>(null);
  const [propertiesSide, setPropertiesSide] = useState<"local" | "remote">("remote");

  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [permissionsTarget, setPermissionsTarget] = useState<UnifiedFileItem | null>(null);

  const [transferTask, setTransferTask] = useState<TransferTask | null>(null);
  const transferPanelVisible = useTerminalStore((state) => state.sessions.find((session) => session.id === sessionId)?.transferPanelVisible ?? false);
  const setTransferPanelVisible = useCallback((visible: boolean) => {
    useTerminalStore.getState().updateSession(sessionId, { transferPanelVisible: visible });
  }, [sessionId]);
  const [cancelling, setCancelling] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const transferRef = useRef<TransferControl | null>(null);

  useEffect(() => () => {
    if (transferRef.current) transferRef.current.cancelled = true;
  }, []);

  function formatSpeed(bytesPerSec: number): string {
    if (bytesPerSec === 0) return "-";
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let value = bytesPerSec;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(1)} ${units[unitIndex]}`;
  }

  const loadLocalDir = useCallback(async (path: string) => {
    const request = ++localRequest.current;
    setLocalLoading(true);
    setLocalError(null);
    try {
      const entries = await localListDir(path);
      if (request !== localRequest.current) return;
      setLocalFiles(entries.map(localToUnified));
      setLocalPath(path);
      localPathRef.current = path;
    } catch (error) {
      if (request === localRequest.current) setLocalError("读取本地目录失败：" + String(error));
    } finally {
      if (request === localRequest.current) setLocalLoading(false);
    }
  }, []);

  const loadRemoteDir = useCallback(
    async (path: string) => {
      if (!connectedRef.current) return;
      const request = ++remoteRequest.current;
      setRemoteLoading(true);
      setRemoteError(null);
      try {
        const entries = await sftpList(sessionId, path);
        if (request !== remoteRequest.current || !connectedRef.current) return;
        setRemoteFiles(entries.map(remoteToUnified));
        setRemotePath(path);
        remotePathRef.current = path;
      } catch (error) {
        if (request === remoteRequest.current) setRemoteError("读取远程目录失败：" + String(error));
      } finally {
        if (request === remoteRequest.current) setRemoteLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!active || localInitialized.current) return;
    localInitialized.current = true;
    localDesktopDir()
      .then((desktop) => loadLocalDir(desktop))
      .catch((error) => setLocalError("读取本地目录失败：" + String(error)));
  }, [active, loadLocalDir]);

  useEffect(() => {
    if (!connected) {
      remoteInitialized.current = false;
      remoteRequest.current++;
      setRemoteLoading(false);
      return;
    }
    if (!active || !sessionId || remoteInitialized.current) return;
    remoteInitialized.current = true;
    if (remotePathRef.current) {
      void loadRemoteDir(remotePathRef.current);
    } else {
      const request = ++remoteRequest.current;
      sftpCanonicalize(sessionId, ".")
        .then((home) => { if (request === remoteRequest.current) void loadRemoteDir(home); })
        .catch((error) => { if (request === remoteRequest.current) setRemoteError("读取远程目录失败：" + String(error)); });
    }
  }, [sessionId, connected, active, loadRemoteDir]);

  const handleLocalNavigate = useCallback(
    (path: string) => {
      loadLocalDir(path);
    },
    [loadLocalDir],
  );

  const handleRemoteNavigate = useCallback(
    (path: string) => {
      loadRemoteDir(path);
    },
    [loadRemoteDir],
  );

  const handleLocalOpen = useCallback(
    (file: UnifiedFileItem) => {
      if (file.isDir) {
        loadLocalDir(file.path);
      }
    },
    [loadLocalDir],
  );

  const handleRemoteOpen = useCallback(
    (file: UnifiedFileItem) => {
      if (file.isDir) {
        loadRemoteDir(file.path);
      }
    },
    [loadRemoteDir],
  );

  const handleCreateFolder = useCallback((side: "local" | "remote") => {
    setMkdirTarget(side);
    setNewFolderName("");
    setMkdirDialogOpen(true);
  }, []);

  const handleMkdirConfirm = useCallback(async () => {
    if (!newFolderName.trim()) return;
    if (mkdirTarget === "remote") {
      const path =
        remotePath === "/"
          ? `/${newFolderName.trim()}`
          : `${remotePath}/${newFolderName.trim()}`;
      try {
        await sftpMkdir(sessionId, path);
        setMkdirDialogOpen(false);
        loadRemoteDir(remotePath);
      } catch {}
    } else {
      const sep = localPath.includes("\\") ? "\\" : "/";
      const path = `${localPath}${sep}${newFolderName.trim()}`;
      try {
        await import("@tauri-apps/plugin-fs").then(({ mkdir }) =>
          mkdir(path as `${string}/${string}`, { recursive: true }),
        );
        setMkdirDialogOpen(false);
        loadLocalDir(localPath);
      } catch {}
    }
  }, [sessionId, remotePath, localPath, newFolderName, mkdirTarget, loadRemoteDir, loadLocalDir]);

  const handleCreateFile = useCallback((side: "local" | "remote") => {
    setNewFileTarget(side);
    setNewFileName("");
    setNewFileDialogOpen(true);
  }, []);

  const handleNewFileConfirm = useCallback(async () => {
    if (!newFileName.trim()) return;
    if (newFileTarget === "remote") {
      const path =
        remotePath === "/"
          ? `/${newFileName.trim()}`
          : `${remotePath}/${newFileName.trim()}`;
      try {
        await sftpTouch(sessionId, path);
        setNewFileDialogOpen(false);
        loadRemoteDir(remotePath);
      } catch {}
    } else {
      const sep = localPath.includes("\\") ? "\\" : "/";
      const path = `${localPath}${sep}${newFileName.trim()}`;
      try {
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        await writeFile(path as `${string}/${string}`, new Uint8Array(0));
        setNewFileDialogOpen(false);
        loadLocalDir(localPath);
      } catch {}
    }
  }, [sessionId, remotePath, localPath, newFileName, newFileTarget, loadRemoteDir, loadLocalDir]);

  const handleDelete = useCallback((file: UnifiedFileItem, side: "local" | "remote") => {
    setDeleteTarget(file);
    setDeleteSide(side);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    if (deleteSide === "remote") {
      try {
        await sftpRemove(sessionId, deleteTarget.path, deleteTarget.isDir);
        setDeleteDialogOpen(false);
        setDeleteTarget(null);
        loadRemoteDir(remotePath);
      } catch {}
    } else {
      try {
        const { remove } = await import("@tauri-apps/plugin-fs");
        await remove(deleteTarget.path as `${string}/${string}`, {
          recursive: deleteTarget.isDir,
        });
        setDeleteDialogOpen(false);
        setDeleteTarget(null);
        loadLocalDir(localPath);
      } catch {}
    }
  }, [sessionId, deleteTarget, deleteSide, remotePath, localPath, loadRemoteDir, loadLocalDir]);

  const handleRename = useCallback((file: UnifiedFileItem, side: "local" | "remote") => {
    setRenameTarget(file);
    setRenameSide(side);
    setRenameValue(file.name);
    setRenameDialogOpen(true);
  }, []);

  const handleRenameConfirm = useCallback(async () => {
    if (!renameTarget || !renameValue.trim()) return;
    if (renameSide === "remote") {
      const parent = renameTarget.path.substring(
        0,
        renameTarget.path.lastIndexOf("/"),
      );
      const newPath = parent
        ? `${parent}/${renameValue.trim()}`
        : `/${renameValue.trim()}`;
      try {
        await sftpRename(sessionId, renameTarget.path, newPath);
        setRenameDialogOpen(false);
        setRenameTarget(null);
        loadRemoteDir(remotePath);
      } catch {}
    } else {
      const sep = renameTarget.path.includes("\\") ? "\\" : "/";
      const parts = renameTarget.path.split(sep);
      parts[parts.length - 1] = renameValue.trim();
      const newPath = parts.join(sep);
      try {
        const { rename } = await import("@tauri-apps/plugin-fs");
        await rename(
          renameTarget.path as `${string}/${string}`,
          newPath as `${string}/${string}`,
        );
        setRenameDialogOpen(false);
        setRenameTarget(null);
        loadLocalDir(localPath);
      } catch {}
    }
  }, [sessionId, renameTarget, renameValue, renameSide, remotePath, localPath, loadRemoteDir, loadLocalDir]);

  const runTransfer = useCallback(
    async (
      type: "upload" | "download",
      files: UnifiedFileItem[],
      fromSide: "local" | "remote" | "system",
      destination?: string,
    ): Promise<boolean> => {
      if (files.length === 0 || transferRef.current) return false;
      if (type === "upload" && !remotePathRef.current) {
        setOperationError("远程目录尚未加载，请稍后重试。");
        return false;
      }
      if (type === "download" && !destination && !localPathRef.current) {
        setOperationError("本地目录尚未加载，请稍后重试。");
        return false;
      }

      const taskId = `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const control: TransferControl = { id: taskId, cancelled: false, currentFileId: null, cancelPromise: null };
      transferRef.current = control;
      setCancelling(false);

      const fileInfos: TransferFileInfo[] = files.map((file) => {
        const safeName = file.name.replace(/[<>:"|?*\\/\x00-\x1F]/g, "_").replace(/[\s.]+$/, "") || "_";
        const sep = localPath.includes("\\") ? "\\" : "/";
        return {
          name: file.name,
          localPath: type === "download" ? (destination ?? `${localPath}${sep}${safeName}`) : file.path,
          remotePath: type === "upload"
            ? (remotePath === "/" ? `/${file.name}` : `${remotePath}/${file.name}`)
            : file.path,
          size: file.size ?? 0,
          status: "pending" as const,
        };
      });
      if (type === "upload" && new Set(fileInfos.map((file) => file.remotePath)).size !== fileInfos.length) {
        transferRef.current = null;
        setOperationError("部分文件或文件夹的远程目标相同，请分别上传或先重命名。");
        return false;
      }
      if (type === "download" && new Set(fileInfos.map((file) => file.localPath.toLowerCase())).size !== fileInfos.length) {
        transferRef.current = null;
        setOperationError("部分文件名在本地会重复，请分别下载并选择不同的名称。");
        return false;
      }
      setTransferPanelVisible(true);
      setTransferTask({
        id: taskId,
        type,
        status: "waiting",
        currentFile: fileInfos[0]?.name ?? "",
        currentFileIndex: 0,
        totalFiles: fileInfos.length,
        progress: 0,
        speed: "-",
        bytesTransferred: 0,
        totalBytes: 0,
        files: fileInfos,
      });

      let completed = 0;
      let failed = false;
      for (let i = 0; i < files.length; i++) {
        if (control.cancelled) break;
        const file = files[i];
        const info = fileInfos[i];
        const fileTaskId = `${taskId}-${i}`;
        setTransferTask((prev) => prev?.id === taskId ? {
          ...prev,
          status: "transferring",
          currentFile: file.name,
          currentFileIndex: i,
          progress: 0,
          speed: "-",
          bytesTransferred: 0,
          totalBytes: 0,
          files: prev.files.map((f, idx) => idx === i ? { ...f, status: "transferring" } : f),
        } : prev);

        let unlisten: (() => void) | undefined;
        try {
          unlisten = await onTransferProgress(sessionId, fileTaskId, (event) => {
            setTransferTask((prev) => {
              if (!prev || prev.id !== taskId || control.cancelled || control.currentFileId !== fileTaskId) return prev;
              return {
                ...prev,
                progress: event.percentage,
                speed: formatSpeed(event.speed),
                bytesTransferred: event.bytesTransferred,
                totalBytes: event.totalBytes,
              };
            });
          });
          if (control.cancelled) break;

          if (type === "upload" && fromSide === "system" && file.isDir && !file.path) {
            try {
              await sftpMkdir(sessionId, info.remotePath);
            } catch (error) {
              const existing = await sftpStat(sessionId, info.remotePath);
              if (!existing.isDir) throw error;
            }
          } else if (type === "upload" && fromSide === "system" && file._rawFile) {
            const buf = await file._rawFile.arrayBuffer();
            if (control.cancelled) break;
            control.currentFileId = fileTaskId;
            await sftpUpload(sessionId, info.remotePath, Array.from(new Uint8Array(buf)), fileTaskId);
          } else {
            control.currentFileId = fileTaskId;
            if (type === "upload") {
              if (file.isDir) await sftpUploadDir(sessionId, file.path, info.remotePath, fileTaskId);
              else await sftpUploadFile(sessionId, file.path, info.remotePath, fileTaskId);
            } else {
              if (file.isDir) await sftpDownloadDir(sessionId, file.path, info.localPath, fileTaskId);
              else await sftpDownloadFile(sessionId, file.path, info.localPath, fileTaskId);
            }
          }
          completed++;
          setTransferTask((prev) => prev?.id === taskId ? {
            ...prev,
            files: prev.files.map((f, idx) => idx === i ? { ...f, status: "completed" } : f),
            progress: 100,
          } : prev);
        } catch (error: unknown) {
          if (control.cancelled && (!control.currentFileId || String(error).toLowerCase().includes("cancel"))) break;
          failed = true;
          setTransferTask((prev) => prev?.id === taskId ? {
            ...prev,
            files: prev.files.map((f, idx) => idx === i ? { ...f, status: "error" } : f),
          } : prev);
        } finally {
          control.currentFileId = null;
          unlisten?.();
        }
      }

      if (control.cancelPromise) await control.cancelPromise;
      const success = !control.cancelled && !failed && completed === files.length;
      setTransferTask((prev) => prev?.id === taskId ? {
        ...prev,
        status: success ? "completed" : failed ? "error" : "cancelled",
        progress: success ? 100 : prev.progress,
        speed: "-",
      } : prev);
      if (failed) {
        setOperationError(`${type === "upload" ? "上传" : "下载"}失败，部分内容可能已传输。请检查连接和目标路径后重试。`);
      }
      if (transferRef.current === control) transferRef.current = null;
      setCancelling(false);
      if (type === "upload" && remotePathRef.current === remotePath) void loadRemoteDir(remotePath);
      else if (type === "download" && localPathRef.current === localPath) void loadLocalDir(localPath);
      return success;
    },
    [sessionId, localPath, remotePath, loadLocalDir, loadRemoteDir, setTransferPanelVisible],
  );

  const handleDropToRemote = useCallback((files: UnifiedFileItem[], fromSide: "local" | "remote" | "system") => {
    if (fromSide !== "remote") void runTransfer("upload", files, fromSide);
  }, [runTransfer]);

  const handleDropToLocal = useCallback((files: UnifiedFileItem[], fromSide: "local" | "remote" | "system") => {
    if (fromSide === "remote") void runTransfer("download", files, fromSide);
  }, [runTransfer]);

  const handleUploadByPicker = useCallback(async () => {
    if (transferRef.current) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true, title: "选择要上传的文件" });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const files: UnifiedFileItem[] = paths.map((path) => ({
        name: String(path).split(/[/\\]/).pop() ?? "upload",
        path: String(path),
        isDir: false,
        size: null,
        modified: null,
        permissions: null,
      }));
      await runTransfer("upload", files, "local");
    } catch {
      setOperationError("选择上传文件失败，请重试。");
    }
  }, [runTransfer]);

  const handleDownloadFile = useCallback(async (file: UnifiedFileItem) => {
    if (file.isDir || transferRef.current) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const savePath = await save({ defaultPath: file.name, title: "保存文件" });
      if (savePath) await runTransfer("download", [file], "remote", String(savePath));
    } catch {
      setOperationError("选择保存位置失败，请重试。");
    }
  }, [runTransfer]);

  const handleCancelTransfer = useCallback(() => {
    const control = transferRef.current;
    if (!control || control.cancelPromise) return;
    control.cancelled = true;
    setCancelling(true);
    if (!control.currentFileId) return;
    const request = sftpCancelTransfer(control.currentFileId).catch(() => {
      if (transferRef.current === control) {
        setCancelling(false);
        setOperationError("取消传输失败，请等待当前文件处理结束后核对结果，也可以重试取消。");
      }
    });
    control.cancelPromise = request;
    void request.finally(() => {
      if (control.cancelPromise === request) control.cancelPromise = null;
    });
  }, []);

  const handleClearTransfer = useCallback(() => {
    if (!transferRef.current) {
      setTransferTask(null);
      setTransferPanelVisible(false);
    }
  }, [setTransferPanelVisible]);

  const handleCopy = useCallback(
    (side: "local" | "remote", files: UnifiedFileItem[]) => {
      if (files.length === 0) return;
      setClipboard({ side, files, mode: "copy" });
    },
    [],
  );

  const handleCut = useCallback(
    (side: "local" | "remote", files: UnifiedFileItem[]) => {
      if (files.length === 0) return;
      setClipboard({ side, files, mode: "cut" });
    },
    [],
  );

  const handlePaste = useCallback(
    async (targetSide: "local" | "remote") => {
      if (!clipboard) return;
      const isCrossSide = clipboard.side !== targetSide;

      if (isCrossSide) {
        const uploaded = clipboard.side === "local";
        const success = await runTransfer(uploaded ? "upload" : "download", clipboard.files, clipboard.side);
        if (!success || clipboard.mode !== "cut") return;

        for (let i = 0; i < clipboard.files.length; i++) {
          const file = clipboard.files[i];
          try {
            if (uploaded) {
              const { remove } = await import("@tauri-apps/plugin-fs");
              await remove(file.path as `${string}/${string}`, { recursive: file.isDir });
            } else {
              await sftpRemove(sessionId, file.path, file.isDir);
            }
          } catch {
            setClipboard((current) => current === clipboard ? { ...clipboard, files: clipboard.files.slice(i) } : current);
            setOperationError("传输完成，但删除源文件失败。请先检查源文件，再决定如何处理。");
            if (uploaded) void loadLocalDir(localPath);
            else void loadRemoteDir(remotePath);
            return;
          }
        }
        setClipboard((current) => current === clipboard ? null : current);
        if (uploaded) void loadLocalDir(localPath);
        else void loadRemoteDir(remotePath);
        return;
      }

      for (const file of clipboard.files) {
        try {
          if (targetSide === "remote") {
            if (clipboard.mode === "cut") {
              const newPath =
                remotePath === "/" ? `/${file.name}` : `${remotePath}/${file.name}`;
              await sftpRename(sessionId, file.path, newPath);
            }
          } else {
            const sep = localPath.includes("\\") ? "\\" : "/";
            const dest = `${localPath}${sep}${file.name}`;
            if (clipboard.mode === "copy") {
              const { copyFile } = await import("@tauri-apps/plugin-fs");
              await copyFile(file.path as `${string}/${string}`, dest as `${string}/${string}`);
            } else {
              const { rename } = await import("@tauri-apps/plugin-fs");
              await rename(file.path as `${string}/${string}`, dest as `${string}/${string}`);
            }
          }
        } catch {}
      }

      if (clipboard.mode === "cut") {
        setClipboard(null);
      }

      if (targetSide === "local") loadLocalDir(localPath);
      else loadRemoteDir(remotePath);
    },
    [clipboard, sessionId, localPath, remotePath, loadLocalDir, loadRemoteDir, runTransfer],
  );

  const handleProperties = useCallback(
    (file: UnifiedFileItem, side: "local" | "remote") => {
      setPropertiesTarget(file);
      setPropertiesSide(side);
      setPropertiesOpen(true);
    },
    [],
  );

  const handleOpenPermissions = useCallback((file: UnifiedFileItem) => {
    setPermissionsTarget(file);
    setPermissionsOpen(true);
  }, []);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("application/x-sftp-files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("application/x-sftp-files")) {
        e.preventDefault();
      }
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target;
      if (!active || !connected || !(target instanceof HTMLElement) || !containerRef.current?.contains(target)
        || target.closest("input, textarea, [contenteditable=true]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        const side = activeSideRef.current;
        const selectedPaths = side === "local" ? localSelectedPaths : remoteSelectedPaths;
        const allFiles = side === "local" ? localFiles : remoteFiles;
        const selected = allFiles.filter((f) => selectedPaths.has(f.path));
        if (selected.length > 0) handleCopy(side, selected);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "x") {
        const side = activeSideRef.current;
        const selectedPaths = side === "local" ? localSelectedPaths : remoteSelectedPaths;
        const allFiles = side === "local" ? localFiles : remoteFiles;
        const selected = allFiles.filter((f) => selectedPaths.has(f.path));
        if (selected.length > 0) handleCut(side, selected);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "v") {
        handlePaste(activeSideRef.current);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [active, connected, localSelectedPaths, remoteSelectedPaths, localFiles, remoteFiles, handleCopy, handleCut, handlePaste]);

  return (
    <div className="flex h-full flex-col" inert={!active || !connected} aria-hidden={!active}>
      <ResizablePanelGroup direction="horizontal" elementRef={containerRef} className="min-h-0 flex-1"
        id={`sftp-panes-${sessionId}`} aria-label="本地与远程文件">
        <ResizablePanel id={`sftp-local-${sessionId}`} defaultSize="50%" minSize="20%" className="min-h-0 min-w-0 overflow-hidden">
          <FilePane
            label="本地"
            currentPath={localPath}
            files={localFiles}
            loading={localLoading}
            error={localError}
            onNavigate={handleLocalNavigate}
            onOpen={handleLocalOpen}
            onDelete={(file) => handleDelete(file, "local")}
            onRename={(file) => handleRename(file, "local")}
            onCreateFolder={() => handleCreateFolder("local")}
            onCreateFile={() => handleCreateFile("local")}
            onRefresh={() => loadLocalDir(localPath)}
            onUploadByPicker={undefined}
            onCopy={(files) => handleCopy("local", files)}
            onCut={(files) => handleCut("local", files)}
            onPaste={() => handlePaste("local")}
            onProperties={(file) => handleProperties(file, "local")}
            showHiddenFiles={localShowHidden}
            onToggleHiddenFiles={() => setLocalShowHidden((v) => !v)}
            clipboardHasItems={clipboard !== null}
            side="local"
            onSelectionChange={setLocalSelectedPaths}
            onFocus={() => { activeSideRef.current = "local"; }}
            onDropFiles={handleDropToLocal}
            onDropError={() => setOperationError("读取拖入的文件夹失败，请检查文件是否可访问后重试。")}
            isTransferring={transferTask?.status === "transferring" || transferTask?.status === "waiting"}
          />
        </ResizablePanel>
        <ResizableHandle aria-label="调整本地与远程文件区域宽度" className="z-20" />
        <ResizablePanel id={`sftp-remote-${sessionId}`} defaultSize="50%" minSize="20%" className="min-h-0 min-w-0 overflow-hidden">
          <FilePane
            label="远程"
            currentPath={remotePath}
            files={remoteFiles}
            loading={remoteLoading}
            error={remoteError}
            onNavigate={handleRemoteNavigate}
            onOpen={handleRemoteOpen}
            onDelete={(file) => handleDelete(file, "remote")}
            onRename={(file) => handleRename(file, "remote")}
            onCreateFolder={() => handleCreateFolder("remote")}
            onCreateFile={() => handleCreateFile("remote")}
            onRefresh={() => loadRemoteDir(remotePath)}
            onUploadByPicker={handleUploadByPicker}
            onDownload={handleDownloadFile}
            onCopy={(files) => handleCopy("remote", files)}
            onCut={(files) => handleCut("remote", files)}
            onPaste={() => handlePaste("remote")}
            onProperties={(file) => handleProperties(file, "remote")}
            showHiddenFiles={remoteShowHidden}
            onToggleHiddenFiles={() => setRemoteShowHidden((v) => !v)}
            clipboardHasItems={clipboard !== null}
            side="remote"
            onSelectionChange={setRemoteSelectedPaths}
            onFocus={() => { activeSideRef.current = "remote"; }}
            onDropFiles={handleDropToRemote}
            onDropError={() => setOperationError("读取拖入的文件夹失败，请检查文件是否可访问后重试。")}
            isTransferring={transferTask?.status === "transferring" || transferTask?.status === "waiting"}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

      {transferPanelVisible && <TransferPanel
        task={transferTask}
        showEmpty
        cancelling={cancelling}
        onCancel={handleCancelTransfer}
        onClear={handleClearTransfer}
        onCollapse={() => setTransferPanelVisible(false)}
      />}

      <Dialog open={operationError !== null} onOpenChange={(open) => { if (!open) setOperationError(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>操作未完成</DialogTitle>
            <DialogDescription>{operationError}</DialogDescription>
          </DialogHeader>
          <DialogFooter><Button onClick={() => setOperationError(null)}>知道了</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mkdirDialogOpen} onOpenChange={setMkdirDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="文件夹名称"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleMkdirConfirm();
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMkdirDialogOpen(false)}
            >
              取消
            </Button>
            <Button onClick={handleMkdirConfirm} disabled={!newFolderName.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newFileDialogOpen} onOpenChange={setNewFileDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建文件</DialogTitle>
          </DialogHeader>
          <Input
            placeholder="文件名称"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleNewFileConfirm();
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewFileDialogOpen(false)}
            >
              取消
            </Button>
            <Button onClick={handleNewFileConfirm} disabled={!newFileName.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRenameConfirm();
            }}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameDialogOpen(false)}
            >
              取消
            </Button>
            <Button onClick={handleRenameConfirm} disabled={!renameValue.trim()}>
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定要删除「{deleteTarget?.name}」吗？
            {deleteTarget?.isDir ? " 该文件夹及其所有内容将被删除。" : ""}
          </p>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              取消
            </Button>
            <Button variant="destructive" onClick={handleDeleteConfirm}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PropertiesDialog
        open={propertiesOpen}
        onOpenChange={setPropertiesOpen}
        file={propertiesTarget}
        side={propertiesSide}
        sessionId={sessionId}
        onOpenPermissions={(file) => {
          setPropertiesOpen(false);
          handleOpenPermissions(file);
        }}
      />

      <PermissionsDialog
        open={permissionsOpen}
        onOpenChange={setPermissionsOpen}
        file={permissionsTarget}
        sessionId={sessionId}
        onRefresh={() => loadRemoteDir(remotePath)}
      />
    </div>
  );
}
