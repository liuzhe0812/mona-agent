import { create } from "zustand";
import {
  ideCheckFile,
  ideOpenProject,
  ideReadFile,
  ideWriteFile,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpTouch,
  sftpUpload,
  sftpUploadFile,
  sftpStat,
  sftpCancelTransfer,
  onTransferProgress,
  sshOpenSftp,
  sftpDownloadFile,
  sftpDownloadDir,
} from "../terminal/ipc";
import type { TransferProgressEvent } from "../terminal/ipc";
import { detectLanguage } from "@/lib/codemirror/languageLoader";

export interface IdeTab {
  id: string;
  path: string;
  name: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  isLoading: boolean;
  language: string | null;
  serverMtime: number;
  serverSize: number;
}

export interface ConflictState {
  tabId: string;
  remoteMtime: number;
  remoteSize: number;
}

export type TransferStatus = "waiting" | "transferring" | "completed" | "error" | "cancelled";

export interface TransferFileInfo {
  name: string;
  localPath: string;
  remotePath: string;
  size: number;
  status: "pending" | "transferring" | "completed" | "error";
}

export interface IdeTransferTask {
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

export interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileTreeNode[];
  isLoading?: boolean;
}

interface IdeState {
  sessionId: string | null;
  sftpSessionId: string | null;
  rootPath: string | null;
  tree: FileTreeNode[];
  expandedPaths: Set<string>;
  selectedPaths: Set<string>;
  tabs: IdeTab[];
  activeTabId: string | null;
  ideVisible: boolean;
  showHiddenFiles: boolean;
  conflictState: ConflictState | null;
  transferTask: IdeTransferTask | null;
  leftFileTreeVisible: boolean;
  leftSystemMonitorVisible: boolean;

  openProject: (sessionId: string, path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeTab: (tabId: string) => boolean;
  saveFile: (tabId: string) => Promise<void>;
  setTabContent: (tabId: string, content: string) => void;
  setActiveTab: (tabId: string) => void;
  togglePath: (path: string) => void;
  loadChildren: (path: string) => Promise<void>;
  refreshDir: (path: string) => Promise<void>;
  createFile: (dirPath: string, name: string) => Promise<void>;
  createFolder: (dirPath: string, name: string) => Promise<void>;
  deleteNode: (path: string, isDir: boolean) => Promise<void>;
  renameNode: (oldPath: string, newPath: string) => Promise<void>;
  navigateTo: (path: string) => Promise<void>;
  uploadFiles: (files: { name: string; path: string; size: number; rawFile?: File }[], targetDir: string) => Promise<void>;
  downloadFiles: (items: { path: string; name: string; isDir: boolean }[], localDir: string) => Promise<void>;
  cancelTransfer: () => void;
  clearTransfer: () => void;
  setSelectedPaths: (paths: Set<string>) => void;
  toggleSelectedPath: (path: string, ctrlKey: boolean) => void;
  clearSelection: () => void;
  hideIdePanel: () => void;
  showIdePanel: () => void;
  setShowHiddenFiles: (show: boolean) => void;
  resolveConflict: (tabId: string, action: "overwrite" | "discard") => Promise<void>;
  toggleLeftFileTree: () => void;
  toggleLeftSystemMonitor: () => void;
  setLeftFileTreeVisible: (visible: boolean) => void;
  setLeftSystemMonitorVisible: (visible: boolean) => void;
}

function fileNameFromPath(path: string): string {
  return path.split("/").pop() || path;
}

function sortNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function updateTreeChildren(
  tree: FileTreeNode[],
  path: string,
  children: FileTreeNode[],
): FileTreeNode[] {
  return tree.map((node) => {
    if (node.path === path) {
      return { ...node, children };
    }
    if (node.children) {
      return { ...node, children: updateTreeChildren(node.children, path, children) };
    }
    return node;
  });
}

function removeNodeFromTree(tree: FileTreeNode[], targetPath: string): FileTreeNode[] {
  return tree
    .filter((n) => n.path !== targetPath)
    .map((node) => {
      if (node.children) {
        return { ...node, children: removeNodeFromTree(node.children, targetPath) };
      }
      return node;
    });
}

function renameNodeInTree(
  tree: FileTreeNode[],
  oldPath: string,
  newPath: string,
  newName: string,
): FileTreeNode[] {
  return tree.map((node) => {
    if (node.path === oldPath) {
      return { ...node, path: newPath, name: newName };
    }
    if (node.children) {
      return {
        ...node,
        children: renameNodeInTree(node.children, oldPath, newPath, newName),
      };
    }
    return node;
  });
}

function findParentPath(tree: FileTreeNode[], targetPath: string): string | null {
  for (const node of tree) {
    if (node.children) {
      for (const child of node.children) {
        if (child.path === targetPath) return node.path;
      }
      const found = findParentPath(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

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

export const useIdeStore = create<IdeState>((set, get) => ({
  sessionId: null,
  sftpSessionId: null,
  rootPath: null,
  tree: [],
  expandedPaths: new Set(),
  selectedPaths: new Set(),
  tabs: [],
  activeTabId: null,
  ideVisible: false,
  showHiddenFiles: false,
  conflictState: null,
  transferTask: null,
  leftFileTreeVisible: true,
  leftSystemMonitorVisible: false,

  openProject: async (sessionId, path) => {
    console.log("[IDE] openProject called", sessionId, path);
    // Open SFTP subsystem on the SSH session for file operations
    const sftpSessionId = await sshOpenSftp(sessionId);
    const info = await ideOpenProject(sessionId, path);
    console.log("[IDE] ideOpenProject returned", info);
    set({
      sessionId,
      sftpSessionId,
      rootPath: info.rootPath,
      tree: [{ name: info.name, path: info.rootPath, isDir: true, isLoading: false }],
      expandedPaths: new Set([info.rootPath]),
    });
    await get().loadChildren(info.rootPath);
  },

  openFile: async (path) => {
    const { sessionId, tabs } = get();
    if (!sessionId) throw new Error("No active session");

    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      set({ activeTabId: existing.id, ideVisible: true });
      return;
    }

    const check = await ideCheckFile(sessionId, path);
    if (check.type !== "editable") {
      if (check.type === "too_large") {
        throw new Error(`File too large (${check.size} bytes, limit ${check.limit})`);
      }
      if (check.type === "binary") {
        console.info("Skipping binary file:", path);
        return;
      }
      throw new Error(`Cannot edit: ${check.reason}`);
    }

    const fileName = fileNameFromPath(path);
    const tabId = crypto.randomUUID();
    const newTab: IdeTab = {
      id: tabId,
      path,
      name: fileName,
      content: "",
      originalContent: "",
      isDirty: false,
      isLoading: true,
      language: detectLanguage(fileName),
      serverMtime: check.mtime,
      serverSize: check.size,
    };
    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
      ideVisible: true,
    }));

    try {
      const result = await ideReadFile(sessionId, path);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                content: result.content,
                originalContent: result.content,
                isLoading: false,
                serverMtime: result.mtime,
                serverSize: result.size,
              }
            : t
        ),
      }));
    } catch (err) {
      set((state) => ({
        tabs: state.tabs.filter((t) => t.id !== tabId),
        activeTabId: state.activeTabId === tabId ? null : state.activeTabId,
      }));
      throw err;
    }
  },

  closeTab: (tabId) => {
    let closed = false;
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (tab?.isDirty) {
        return state;
      }
      const newTabs = state.tabs.filter((t) => t.id !== tabId);
      const newActive =
        state.activeTabId === tabId
          ? newTabs[newTabs.length - 1]?.id ?? null
          : state.activeTabId;
      closed = true;
      return {
        tabs: newTabs,
        activeTabId: newActive,
        ideVisible: newTabs.length > 0,
      };
    });
    return closed;
  },

  saveFile: async (tabId) => {
    const { sessionId, tabs } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!sessionId || !tab) throw new Error("Invalid save state");

    try {
      const result = await ideWriteFile(
        sessionId,
        tab.path,
        tab.content,
        tab.serverMtime,
        tab.serverSize,
      );
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                originalContent: t.content,
                isDirty: false,
                serverMtime: result.mtime,
                serverSize: result.size,
              }
            : t
        ),
        conflictState: null,
      }));
    } catch (err) {
      const msg = String(err);
      if (msg.includes("File modified externally")) {
        const latest = await ideCheckFile(sessionId, tab.path);
        if (latest.type === "editable") {
          set({
            conflictState: {
              tabId,
              remoteMtime: latest.mtime,
              remoteSize: latest.size,
            },
          });
        }
      }
      throw err;
    }
  },

  setTabContent: (tabId, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? { ...t, content, isDirty: t.originalContent !== content }
          : t
      ),
    }));
  },

  setActiveTab: (tabId) => set({ activeTabId: tabId }),

  hideIdePanel: () => set({ ideVisible: false }),
  showIdePanel: () => set({ ideVisible: true }),

  setShowHiddenFiles: (show) => {
    set({ showHiddenFiles: show });
    const { expandedPaths, loadChildren } = get();
    expandedPaths.forEach((path) => loadChildren(path));
  },

  resolveConflict: async (tabId, action) => {
    const { sessionId, tabs } = get();
    const tab = tabs.find((t) => t.id === tabId);
    if (!sessionId || !tab) return;

    if (action === "discard") {
      const result = await ideReadFile(sessionId, tab.path);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                content: result.content,
                originalContent: result.content,
                isDirty: false,
                serverMtime: result.mtime,
                serverSize: result.size,
              }
            : t
        ),
        conflictState: null,
      }));
    } else {
      const result = await ideWriteFile(
        sessionId,
        tab.path,
        tab.content,
        0,
        0,
      );
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                originalContent: t.content,
                isDirty: false,
                serverMtime: result.mtime,
                serverSize: result.size,
              }
            : t
        ),
        conflictState: null,
      }));
    }
  },

  togglePath: (path) => {
    const { expandedPaths } = get();
    if (!expandedPaths.has(path)) {
      set((state) => ({
        expandedPaths: new Set([...state.expandedPaths, path]),
      }));
      get().loadChildren(path);
    } else {
      set((state) => {
        const next = new Set(state.expandedPaths);
        next.delete(path);
        return { expandedPaths: next };
      });
    }
  },

  loadChildren: async (path) => {
    const { sftpSessionId, showHiddenFiles } = get();
    if (!sftpSessionId) return;

    set((state) => ({
      tree: updateTreeChildren(state.tree, path, [
        { name: "...", path: `${path}/__loading__`, isDir: false, isLoading: true },
      ]),
    }));

    try {
      const files = await sftpList(sftpSessionId, path);
      const nodes = sortNodes(
        files
          .filter((f) => {
            const visible = showHiddenFiles || !f.name.startsWith(".");
            return visible;
          })
          .map((f) => ({
            name: f.name,
            path: f.path,
            isDir: f.isDir,
            isLoading: false,
          })),
      );
      const newTree = updateTreeChildren(get().tree, path, nodes);
      set({ tree: newTree });
    } catch (err) {
      set((state) => ({
        tree: updateTreeChildren(state.tree, path, []),
      }));
    }
  },

  refreshDir: async (path) => {
    await get().loadChildren(path);
  },

  createFile: async (dirPath, name) => {
    const { sftpSessionId } = get();
    if (!sftpSessionId) return;
    const filePath = `${dirPath}/${name}`;
    await sftpTouch(sftpSessionId, filePath);
    await get().loadChildren(dirPath);
  },

  createFolder: async (dirPath, name) => {
    const { sftpSessionId } = get();
    if (!sftpSessionId) return;
    const folderPath = `${dirPath}/${name}`;
    await sftpMkdir(sftpSessionId, folderPath);
    await get().loadChildren(dirPath);
  },

  deleteNode: async (path, isDir) => {
    const { sftpSessionId } = get();
    if (!sftpSessionId) return;
    await sftpRemove(sftpSessionId, path, isDir);
    const parentPath = findParentPath(get().tree, path);
    set((state) => ({ tree: removeNodeFromTree(state.tree, path) }));
    // Also close any open tabs for this path
    set((state) => {
      const newTabs = state.tabs.filter((t) => !t.path.startsWith(path));
      const newActive =
        state.activeTabId && newTabs.find((t) => t.id === state.activeTabId)
          ? state.activeTabId
          : newTabs[newTabs.length - 1]?.id ?? null;
      return {
        tabs: newTabs,
        activeTabId: newActive,
        ideVisible: newTabs.length > 0,
      };
    });
    if (parentPath) {
      await get().loadChildren(parentPath);
    }
  },

  renameNode: async (oldPath, newPath) => {
    const { sftpSessionId } = get();
    if (!sftpSessionId) return;
    await sftpRename(sftpSessionId, oldPath, newPath);
    const newName = fileNameFromPath(newPath);
    set((state) => ({
      tree: renameNodeInTree(state.tree, oldPath, newPath, newName),
      tabs: state.tabs.map((t) =>
        t.path === oldPath
          ? { ...t, path: newPath, name: newName }
          : t
      ),
    }));
  },

  navigateTo: async (path) => {
    const { sftpSessionId } = get();
    if (!sftpSessionId) return;
    // Ensure the path exists and is a directory
    const stat = await sftpStat(sftpSessionId, path);
    if (!stat.isDir) {
      // If it's a file, just open it
      await get().openFile(path);
      return;
    }
    // Change root to the target directory
    const dirName = path.split("/").pop() || path;
    set({
      rootPath: path,
      tree: [{ name: dirName, path, isDir: true, isLoading: false }],
      expandedPaths: new Set([path]),
      selectedPaths: new Set(),
    });
    await get().loadChildren(path);
  },

  uploadFiles: async (files, targetDir) => {
    const { sftpSessionId } = get();
    if (!sftpSessionId) {
      return;
    }

    const taskId = `ide-upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const fileInfos: TransferFileInfo[] = files.map((f) => ({
      name: f.name,
      localPath: f.path,
      remotePath: targetDir === "/" ? `/${f.name}` : `${targetDir}/${f.name}`,
      size: f.size,
      status: "pending" as const,
    }));

    const task: IdeTransferTask = {
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
    set({ transferTask: task });

    for (let i = 0; i < files.length; i++) {
      const currentTask = get().transferTask;
      if (!currentTask || currentTask.status === "cancelled") break;

      const file = files[i];
      const remotePath = targetDir === "/" ? `/${file.name}` : `${targetDir}/${file.name}`;
      const fileTaskId = `${taskId}-${i}`;

      set((state) => ({
        transferTask: state.transferTask
          ? {
              ...state.transferTask,
              status: "transferring",
              currentFile: file.name,
              currentFileIndex: i,
              files: state.transferTask.files.map((f, idx) =>
                idx === i ? { ...f, status: "transferring" as const } : f,
              ),
            }
          : state.transferTask,
      }));

      // Listen for progress events
      const cleanup = { fn: null as (() => void) | null };
      const progressPromise = onTransferProgress(sftpSessionId, fileTaskId, (event: TransferProgressEvent) => {
        set((state) => {
          if (!state.transferTask || state.transferTask.id !== taskId || state.transferTask.status === "cancelled") return state;
          return {
            transferTask: {
              ...state.transferTask,
              progress: event.percentage,
              speed: formatSpeed(event.speed),
              bytesTransferred: event.bytesTransferred,
              totalBytes: event.totalBytes,
            },
          };
        });
      }).then((fn) => {
        cleanup.fn = fn;
      });

      try {
        if (file.rawFile) {
          // Browser File object - read as ArrayBuffer and upload bytes
          const buf = await file.rawFile.arrayBuffer();
          await sftpUpload(sftpSessionId, remotePath, Array.from(new Uint8Array(buf)), fileTaskId);
        } else if (file.path && (file.path.includes(":") || file.path.startsWith("/"))) {
          // Local path from Tauri file drop - use sftpUploadFile for direct path upload
          await sftpUploadFile(sftpSessionId, file.path, remotePath, fileTaskId);
        } else {
          await sftpUploadFile(sftpSessionId, file.path, remotePath, fileTaskId);
        }

        set((state) => ({
          transferTask: state.transferTask
            ? {
                ...state.transferTask,
                files: state.transferTask.files.map((f, idx) =>
                  idx === i ? { ...f, status: "completed" as const } : f,
                ),
                progress: Math.round(((i + 1) / files.length) * 100),
              }
            : state.transferTask,
        }));
      } catch (err: unknown) {
        const errStr = String(err);
        if (errStr.includes("cancel") || errStr.includes("Cancel")) {
          set((state) => ({
            transferTask: state.transferTask ? { ...state.transferTask, status: "cancelled" } : state.transferTask,
          }));
          break;
        }
        set((state) => ({
          transferTask: state.transferTask
            ? {
                ...state.transferTask,
                files: state.transferTask.files.map((f, idx) =>
                  idx === i ? { ...f, status: "error" as const } : f,
                ),
                error: errStr,
              }
            : state.transferTask,
        }));
      } finally {
        await progressPromise;
        cleanup.fn?.();
      }
    }

    // Finalize task status
    set((state) => {
      if (!state.transferTask || state.transferTask.id !== taskId) return state;
      if (state.transferTask.status === "cancelled") return state;
      const hasError = state.transferTask.files.some((f) => f.status === "error");
      if (hasError) {
        return { transferTask: { ...state.transferTask, status: "error", speed: "-" } };
      }
      return { transferTask: { ...state.transferTask, status: "completed", progress: 100, speed: "-" } };
    });

    await get().loadChildren(targetDir);

    // Auto-show hidden files if any uploaded file starts with "."
    const hasHiddenUpload = files.some((f) => f.name.startsWith("."));
    if (hasHiddenUpload && !get().showHiddenFiles) {
      get().setShowHiddenFiles(true);
    }
  },

  cancelTransfer: () => {
    const { transferTask } = get();
    if (!transferTask) return;
    if (transferTask.status === "completed" || transferTask.status === "error" || transferTask.status === "cancelled") return;
    set((state) => ({
      transferTask: state.transferTask ? { ...state.transferTask, status: "cancelled" } : null,
    }));
    // Cancel all file-level tasks
    for (let i = 0; i < transferTask.totalFiles; i++) {
      sftpCancelTransfer(`${transferTask.id}-${i}`).catch(() => {});
    }
  },

  clearTransfer: () => {
    set({ transferTask: null });
  },

  downloadFiles: async (items, localDir) => {
    const { sftpSessionId } = get();
    if (!sftpSessionId) return;

    const taskId = `ide-download-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const fileInfos: TransferFileInfo[] = items.map((item) => ({
      name: item.name,
      localPath: `${localDir}/${item.name}`,
      remotePath: item.path,
      size: 0,
      status: "pending" as const,
    }));

    const task: IdeTransferTask = {
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
    set({ transferTask: task });

    for (let i = 0; i < items.length; i++) {
      const currentTask = get().transferTask;
      if (!currentTask || currentTask.status === "cancelled") break;

      const item = items[i];
      const fileTaskId = `${taskId}-${i}`;

      set((state) => ({
        transferTask: state.transferTask
          ? {
              ...state.transferTask,
              status: "transferring",
              currentFile: item.name,
              currentFileIndex: i,
              files: state.transferTask.files.map((f, idx) =>
                idx === i ? { ...f, status: "transferring" as const } : f,
              ),
            }
          : state.transferTask,
      }));

      const cleanup = { fn: null as (() => void) | null };
      const progressPromise = onTransferProgress(sftpSessionId, fileTaskId, (event: TransferProgressEvent) => {
        set((state) => {
          if (!state.transferTask || state.transferTask.id !== taskId || state.transferTask.status === "cancelled") return state;
          return {
            transferTask: {
              ...state.transferTask,
              progress: event.percentage,
              speed: formatSpeed(event.speed),
              bytesTransferred: event.bytesTransferred,
              totalBytes: event.totalBytes,
            },
          };
        });
      }).then((fn) => {
        cleanup.fn = fn;
      });

      try {
        if (item.isDir) {
          await sftpDownloadDir(sftpSessionId, item.path, `${localDir}/${item.name}`, fileTaskId);
        } else {
          await sftpDownloadFile(sftpSessionId, item.path, `${localDir}/${item.name}`, fileTaskId);
        }

        set((state) => ({
          transferTask: state.transferTask
            ? {
                ...state.transferTask,
                files: state.transferTask.files.map((f, idx) =>
                  idx === i ? { ...f, status: "completed" as const } : f,
                ),
                progress: Math.round(((i + 1) / items.length) * 100),
              }
            : state.transferTask,
        }));
      } catch (err: unknown) {
        const errStr = String(err);
        if (errStr.includes("cancel") || errStr.includes("Cancel")) {
          set((state) => ({
            transferTask: state.transferTask ? { ...state.transferTask, status: "cancelled" } : state.transferTask,
          }));
          break;
        }
        set((state) => ({
          transferTask: state.transferTask
            ? {
                ...state.transferTask,
                files: state.transferTask.files.map((f, idx) =>
                  idx === i ? { ...f, status: "error" as const } : f,
                ),
                error: errStr,
              }
            : state.transferTask,
        }));
      } finally {
        await progressPromise;
        cleanup.fn?.();
      }
    }

    set((state) => {
      if (!state.transferTask || state.transferTask.id !== taskId) return state;
      if (state.transferTask.status === "cancelled") return state;
      const hasError = state.transferTask.files.some((f) => f.status === "error");
      if (hasError) {
        return { transferTask: { ...state.transferTask, status: "error", speed: "-" } };
      }
      return { transferTask: { ...state.transferTask, status: "completed", progress: 100, speed: "-" } };
    });
  },

  setSelectedPaths: (paths) => {
    set({ selectedPaths: paths });
  },

  toggleSelectedPath: (path, ctrlKey) => {
    set((state) => {
      const newSet = new Set(state.selectedPaths);
      if (ctrlKey) {
        if (newSet.has(path)) {
          newSet.delete(path);
        } else {
          newSet.add(path);
        }
      } else {
        newSet.clear();
        newSet.add(path);
      }
      return { selectedPaths: newSet };
    });
  },

  clearSelection: () => {
    set({ selectedPaths: new Set() });
  },

  toggleLeftFileTree: () => {
    set((state) => ({ leftFileTreeVisible: !state.leftFileTreeVisible }));
  },
  toggleLeftSystemMonitor: () => {
    set((state) => ({ leftSystemMonitorVisible: !state.leftSystemMonitorVisible }));
  },
  setLeftFileTreeVisible: (visible) => {
    set({ leftFileTreeVisible: visible });
  },
  setLeftSystemMonitorVisible: (visible) => {
    set({ leftSystemMonitorVisible: visible });
  },
}));
