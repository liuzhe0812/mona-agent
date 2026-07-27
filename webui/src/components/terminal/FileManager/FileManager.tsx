import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FilePane } from "./FilePane";
import type { UnifiedFileItem } from "./FilePane";
import {
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpCanonicalize,
  sftpDownload,
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
import type { TransferTask, TransferFileInfo } from "./types";

interface Props {
  sessionId: string;
}

interface ClipboardEntry {
  side: "local" | "remote";
  files: UnifiedFileItem[];
  mode: "copy" | "cut";
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

export function FileManager({ sessionId }: Props) {
  const [localPath, setLocalPath] = useState("");
  const [localFiles, setLocalFiles] = useState<UnifiedFileItem[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localShowHidden, setLocalShowHidden] = useState(false);
  const [localSelectedPaths, setLocalSelectedPaths] = useState<Set<string>>(new Set());

  const [remotePath, setRemotePath] = useState("/");
  const [remoteFiles, setRemoteFiles] = useState<UnifiedFileItem[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteShowHidden, setRemoteShowHidden] = useState(false);
  const [remoteSelectedPaths, setRemoteSelectedPaths] = useState<Set<string>>(new Set());

  const [clipboard, setClipboard] = useState<ClipboardEntry | null>(null);
  const activeSideRef = useRef<"local" | "remote">("local");
  const [leftWidth, setLeftWidth] = useState(50);
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
  const taskIdRef = useRef<string | null>(null);

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
    setLocalLoading(true);
    try {
      const entries = await localListDir(path);
      setLocalFiles(entries.map(localToUnified));
      setLocalPath(path);
    } catch {
      setLocalFiles([]);
    } finally {
      setLocalLoading(false);
    }
  }, []);

  const loadRemoteDir = useCallback(
    async (path: string) => {
      setRemoteLoading(true);
      try {
        const entries = await sftpList(sessionId, path);
        setRemoteFiles(entries.map(remoteToUnified));
        setRemotePath(path);
      } catch {
        setRemoteFiles([]);
      } finally {
        setRemoteLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    localDesktopDir()
      .then((desktop) => loadLocalDir(desktop))
      .catch(() => loadLocalDir("C:\\"));
  }, [loadLocalDir]);

  useEffect(() => {
    if (sessionId) {
      sftpCanonicalize(sessionId, ".")
        .then((home) => loadRemoteDir(home))
        .catch(() => loadRemoteDir("/"));
    }
  }, [sessionId, loadRemoteDir]);

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

  const handleUploadByPicker = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        title: "选择要上传的文件",
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const filePath of paths) {
        const fp = typeof filePath === "string" ? filePath : String(filePath);
        const fileName = fp.split(/[/\\]/).pop() ?? "upload";
        const remoteFilePath =
          remotePath === "/" ? `/${fileName}` : `${remotePath}/${fileName}`;
        try {
          const { readFile } = await import("@tauri-apps/plugin-fs");
          const data = await readFile(fp as `${string}/${string}`);
          await sftpUpload(sessionId, remoteFilePath, Array.from(data));
        } catch {}
      }
      loadRemoteDir(remotePath);
    } catch {}
  }, [sessionId, remotePath, loadRemoteDir]);

  const handleDownloadFile = useCallback(
    async (file: UnifiedFileItem) => {
      if (file.isDir) return;
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const savePath = await save({
          defaultPath: file.name,
          title: "保存文件",
        });
        if (!savePath) return;
        const data = await sftpDownload(sessionId, file.path);
        const { writeFile } = await import("@tauri-apps/plugin-fs");
        await writeFile(savePath as `${string}/${string}`, new Uint8Array(data));
      } catch {}
    },
    [sessionId],
  );

  const handleDropToRemote = useCallback(
    async (files: UnifiedFileItem[], fromSide: "local" | "remote" | "system") => {
      if (fromSide === "remote" || taskIdRef.current) return;

      const taskId = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      taskIdRef.current = taskId;

      const fileInfos: TransferFileInfo[] = files.map((f) => ({
        name: f.name,
        localPath: f.path,
        remotePath: remotePath === "/" ? `/${f.name}` : `${remotePath}/${f.name}`,
        size: f.size ?? 0,
        status: "pending" as const,
      }));

      const task: TransferTask = {
        id: taskId,
        type: "upload",
        status: "waiting",
        currentFile: fileInfos[0]?.name ?? "",
        currentFileIndex: 0,
        totalFiles: fileInfos.length,
        progress: 0,
        speed: "-",
        bytesTransferred: 0,
        totalBytes: 0,
        files: fileInfos,
      };
      setTransferTask(task);

      for (let i = 0; i < files.length; i++) {
        if (taskIdRef.current !== taskId) break;

        const file = files[i];
        const remoteFilePath = remotePath === "/" ? `/${file.name}` : `${remotePath}/${file.name}`;
        const fileTaskId = `${taskId}-${i}`;

        setTransferTask((prev) =>
          prev
            ? {
                ...prev,
                status: "transferring",
                currentFile: file.name,
                currentFileIndex: i,
                files: prev.files.map((f, idx) =>
                  idx === i ? { ...f, status: "transferring" as const } : f,
                ),
              }
            : prev,
        );

        const cleanup = { fn: null as (() => void) | null };
        const progressPromise = onTransferProgress(sessionId, fileTaskId, (event) => {
          setTransferTask((prev) => {
            if (!prev || prev.id !== taskId || prev.status === "cancelled") return prev;
            return {
              ...prev,
              progress: event.percentage,
              speed: formatSpeed(event.speed),
              bytesTransferred: event.bytesTransferred,
              totalBytes: event.totalBytes,
            };
          });
        }).then((fn) => {
          cleanup.fn = fn;
        });

        try {
          if (file.isDir) {
            await sftpUploadDir(sessionId, file.path, remoteFilePath, fileTaskId);
          } else if (fromSide === "system" && file._rawFile) {
            if (file.name.includes("/")) {
              const dirPart = file.name.substring(0, file.name.lastIndexOf("/"));
              const segments = dirPart.split("/").filter(Boolean);
              let acc = remotePath === "/" ? "" : remotePath;
              for (const seg of segments) {
                acc = acc ? `${acc}/${seg}` : `/${seg}`;
                try {
                  await sftpMkdir(sessionId, acc);
                } catch {}
              }
            }
            const buf = await file._rawFile.arrayBuffer();
            await sftpUpload(sessionId, remoteFilePath, Array.from(new Uint8Array(buf)), fileTaskId);
          } else {
            await sftpUploadFile(sessionId, file.path, remoteFilePath, fileTaskId);
          }

          setTransferTask((prev) =>
            prev
              ? {
                  ...prev,
                  files: prev.files.map((f, idx) =>
                    idx === i ? { ...f, status: "completed" as const } : f,
                  ),
                  progress: Math.round(((i + 1) / files.length) * 100),
                }
              : prev,
          );
        } catch (err: unknown) {
          const errStr = String(err);
          if (errStr.includes("cancel") || errStr.includes("Cancel")) {
            setTransferTask((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
            break;
          }
          setTransferTask((prev) =>
            prev
              ? {
                  ...prev,
                  files: prev.files.map((f, idx) =>
                    idx === i ? { ...f, status: "error" as const } : f,
                  ),
                  error: errStr,
                }
              : prev,
          );
        } finally {
          await progressPromise;
          cleanup.fn?.();
        }
      }

      setTransferTask((prev) => {
        if (!prev || prev.id !== taskId) return prev;
        if (prev.status === "cancelled") return prev;
        const hasError = prev.files.some((f) => f.status === "error");
        if (hasError) {
          return { ...prev, status: "error", speed: "-" };
        }
        return { ...prev, status: "completed", progress: 100, speed: "-" };
      });

      taskIdRef.current = null;
      loadRemoteDir(remotePath);
    },
    [sessionId, remotePath, loadRemoteDir],
  );

  const sanitizeFileName = (name: string): string => {
    const invalidChars = /[<>:"|?*\x00-\x1F]/g;
    let result = name.replace(invalidChars, "_");
    result = result.replace(/[\s.]+$/, "");
    return result || "_";
  };

  const handleDropToLocal = useCallback(
    async (files: UnifiedFileItem[], fromSide: "local" | "remote" | "system") => {
      if (fromSide === "local" || fromSide === "system" || taskIdRef.current) return;

      const taskId = `download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      taskIdRef.current = taskId;

      const fileInfos: TransferFileInfo[] = files.map((f) => {
        const sep = localPath.includes("\\") ? "\\" : "/";
        const safeName = sanitizeFileName(f.name);
        return {
          name: f.name,
          localPath: `${localPath}${sep}${safeName}`,
          remotePath: f.path,
          size: f.size ?? 0,
          status: "pending" as const,
        };
      });

      const task: TransferTask = {
        id: taskId,
        type: "download",
        status: "waiting",
        currentFile: fileInfos[0]?.name ?? "",
        currentFileIndex: 0,
        totalFiles: fileInfos.length,
        progress: 0,
        speed: "-",
        bytesTransferred: 0,
        totalBytes: 0,
        files: fileInfos,
      };
      setTransferTask(task);

      for (let i = 0; i < files.length; i++) {
        if (taskIdRef.current !== taskId) break;

        const file = files[i];
        const sep = localPath.includes("\\") ? "\\" : "/";
        const localFilePath = `${localPath}${sep}${sanitizeFileName(file.name)}`;
        const fileTaskId = `${taskId}-${i}`;

        setTransferTask((prev) =>
          prev
            ? {
                ...prev,
                status: "transferring",
                currentFile: file.name,
                currentFileIndex: i,
                files: prev.files.map((f, idx) =>
                  idx === i ? { ...f, status: "transferring" as const } : f,
                ),
              }
            : prev,
        );

        const cleanup = { fn: null as (() => void) | null };
        const progressPromise = onTransferProgress(sessionId, fileTaskId, (event) => {
          setTransferTask((prev) => {
            if (!prev || prev.id !== taskId || prev.status === "cancelled") return prev;
            return {
              ...prev,
              progress: event.percentage,
              speed: formatSpeed(event.speed),
              bytesTransferred: event.bytesTransferred,
              totalBytes: event.totalBytes,
            };
          });
        }).then((fn) => {
          cleanup.fn = fn;
        });

        try {
          if (file.isDir) {
            await sftpDownloadDir(sessionId, file.path, localFilePath, fileTaskId);
          } else {
            await sftpDownloadFile(sessionId, file.path, localFilePath, fileTaskId);
          }

          setTransferTask((prev) =>
            prev
              ? {
                  ...prev,
                  files: prev.files.map((f, idx) =>
                    idx === i ? { ...f, status: "completed" as const } : f,
                  ),
                  progress: Math.round(((i + 1) / files.length) * 100),
                }
              : prev,
          );
        } catch (err: unknown) {
          const errStr = String(err);
          if (errStr.includes("cancel") || errStr.includes("Cancel")) {
            setTransferTask((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
            break;
          }
          setTransferTask((prev) =>
            prev
              ? {
                  ...prev,
                  files: prev.files.map((f, idx) =>
                    idx === i ? { ...f, status: "error" as const } : f,
                  ),
                  error: errStr,
                }
              : prev,
          );
        } finally {
          await progressPromise;
          cleanup.fn?.();
        }
      }

      setTransferTask((prev) => {
        if (!prev || prev.id !== taskId) return prev;
        if (prev.status === "cancelled") return prev;
        const hasError = prev.files.some((f) => f.status === "error");
        if (hasError) {
          return { ...prev, status: "error", speed: "-" };
        }
        return { ...prev, status: "completed", progress: 100, speed: "-" };
      });

      taskIdRef.current = null;
      loadLocalDir(localPath);
    },
    [sessionId, localPath, loadLocalDir],
  );

  const handleCancelTransfer = useCallback(async () => {
    if (taskIdRef.current) {
      try {
        await sftpCancelTransfer(taskIdRef.current);
      } catch {}
      setTransferTask((prev) => (prev ? { ...prev, status: "cancelled" } : prev));
      taskIdRef.current = null;
    }
  }, []);

  const handleClearTransfer = useCallback(() => {
    setTransferTask(null);
    taskIdRef.current = null;
  }, []);

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

      for (const file of clipboard.files) {
        try {
          if (isCrossSide) {
            if (clipboard.side === "local" && targetSide === "remote") {
              if (!file.isDir) {
                const { readFile } = await import("@tauri-apps/plugin-fs");
                const data = await readFile(file.path as `${string}/${string}`);
                const remoteFilePath =
                  remotePath === "/" ? `/${file.name}` : `${remotePath}/${file.name}`;
                await sftpUpload(sessionId, remoteFilePath, Array.from(data));
              }
            } else {
              if (!file.isDir) {
                const sep = localPath.includes("\\") ? "\\" : "/";
                const localFilePath = `${localPath}${sep}${file.name}`;
                const data = await sftpDownload(sessionId, file.path);
                const { writeFile } = await import("@tauri-apps/plugin-fs");
                await writeFile(localFilePath as `${string}/${string}`, new Uint8Array(data));
              }
            }
          } else {
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
          }
        } catch {}
      }

      if (clipboard.mode === "cut") {
        setClipboard(null);
      }

      if (targetSide === "local") loadLocalDir(localPath);
      else loadRemoteDir(remotePath);
    },
    [clipboard, sessionId, localPath, remotePath, loadLocalDir, loadRemoteDir],
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
  }, [localSelectedPaths, remoteSelectedPaths, localFiles, remoteFiles, handleCopy, handleCut, handlePaste]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 min-h-0" ref={containerRef}>
        <div style={{ width: `${leftWidth}%` }} className="min-w-0 border-r">
          <FilePane
            label="本地"
            currentPath={localPath}
            files={localFiles}
            loading={localLoading}
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
            isTransferring={transferTask?.status === "transferring" || transferTask?.status === "waiting"}
          />
        </div>
        <div
          className="w-1 cursor-col-resize bg-border hover:bg-primary/40 active:bg-primary/60 shrink-0 transition-colors"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = leftWidth;
            const containerWidth = containerRef.current?.clientWidth ?? 800;
            const handleMove = (ev: MouseEvent) => {
              const delta = ev.clientX - startX;
              const pct = startWidth + (delta / containerWidth) * 100;
              setLeftWidth(Math.max(20, Math.min(80, pct)));
            };
            const handleUp = () => {
              document.removeEventListener("mousemove", handleMove);
              document.removeEventListener("mouseup", handleUp);
            };
            document.addEventListener("mousemove", handleMove);
            document.addEventListener("mouseup", handleUp);
          }}
        />
        <div className="flex-1 min-w-0">
          <FilePane
            label="远程"
            currentPath={remotePath}
            files={remoteFiles}
            loading={remoteLoading}
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
            isTransferring={transferTask?.status === "transferring" || transferTask?.status === "waiting"}
          />
        </div>
      </div>

      <TransferPanel
        task={transferTask}
        onCancel={handleCancelTransfer}
        onClear={handleClearTransfer}
      />

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
