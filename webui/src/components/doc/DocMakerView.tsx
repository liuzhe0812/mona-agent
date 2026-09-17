import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FolderOpen,
  Home,
  ListX,
  Loader2,
  Search,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { AgentLogo } from "@/components/AgentLogo";
import { createConversationCanvasNote } from "@/components/canvas/conversation-canvas";
import { DeleteConfirm } from "@/components/DeleteConfirm";
import { DocChatPanel } from "@/components/doc/DocChatPanel";
import { RightSidebarToggleIcon } from "@/components/notes/RightSidebarToggleIcon";
import { OfficeEditorHost } from "@/components/office/OfficeEditorHost";
import type { OfficeDocumentType, OfficeSessionState } from "@/components/office/types";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  deleteVideoProject,
  fetchVideoProjects,
  saveVideoChatId,
  type VideoProject,
} from "@/lib/api";
import {
  createOfficeSession,
  deleteOfficeSession,
  getOfficeSession,
  importOfficeSession,
} from "@/lib/office-client";
import {
  isTauri,
  revealItemInDir,
  saveWorkspaceCanvas,
  type WorkspaceCanvasDocument,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { useClient } from "@/providers/ClientProvider";
import type { EmbeddedVideoProject } from "@/components/doc/video/VideoMakerView";

const VideoMakerView = lazy(() =>
  import("@/components/doc/video/VideoMakerView").then((module) => ({ default: module.VideoMakerView })),
);

const CanvasFileView = lazy(() =>
  import("@/components/canvas/CanvasFileView").then((module) => ({ default: module.CanvasFileView })),
);

const START_TAB_ID = "start";
const WORKSPACE_STORAGE_KEY = "mona.ai-docs.workspace.v1";
const RECENT_OFFICE_STORAGE_KEY = "mona.ai-docs.recent-office.v1";
const FAVORITES_STORAGE_KEY = "mona.ai-docs.favorites.v1";
const ACTIVE_TAB_STORAGE_KEY = "mona.ai-docs.active-tab.v1";
const APP_PICKER_SPRITE = "/brand/sidebar-app-picker-icons.png";
const VIDEO_DOCUMENT_ICON = "/brand/document-video-icon.png";

type DocumentIconKind = "word" | "excel" | "ppt" | "video" | "mindmap" | "flowchart";

const DOCUMENT_ICON_POSITIONS: Record<Exclude<DocumentIconKind, "video">, string> = {
  flowchart: "-114px -12px",
  mindmap: "-5px -50px",
  ppt: "-41px -50px",
  word: "-77px -50px",
  excel: "-114px -50px",
};

function DocumentTypeIcon({ kind, size = 32 }: { kind: DocumentIconKind; size?: number }) {
  if (kind === "video") {
    return (
      <img
        src={VIDEO_DOCUMENT_ICON}
        data-document-icon="video"
        alt=""
        aria-hidden
        draggable={false}
        className="shrink-0 object-cover"
        style={{
          width: size,
          height: size,
          clipPath: "inset(5% round 22%)",
        }}
      />
    );
  }
  const scale = size / 32;
  const [x, y] = DOCUMENT_ICON_POSITIONS[kind]
    .split(" ")
    .map((value) => Number.parseFloat(value) * scale);
  return (
    <span
      aria-hidden
      data-document-icon={kind}
      className="shrink-0 rounded-md bg-no-repeat"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${APP_PICKER_SPRITE})`,
        backgroundPosition: `${x}px ${y}px`,
        backgroundSize: `${150 * scale}px ${100 * scale}px`,
      }}
    />
  );
}

interface RecentOfficeDocument {
  key: string;
  sessionId: string;
  ownerSessionKey: string;
  chatId: string;
  title: string;
  officeType: OfficeDocumentType;
  updatedAt: number;
  sourcePath?: string | null;
  savedPath?: string | null;
}

interface OfficeWorkspaceTab {
  id: string;
  kind: "office";
  title: string;
  chatId: string;
  ownerSessionKey: string;
  officeType: OfficeDocumentType;
  session: OfficeSessionState;
  createdAt: number;
  sourcePath?: string | null;
}

interface VideoWorkspaceTab {
  id: string;
  kind: "video-workflow";
  title: string;
  chatId: string;
  project: EmbeddedVideoProject | null;
  createdAt: number;
}

interface CanvasWorkspaceTab {
  id: string;
  kind: "canvas";
  title: string;
  chatId: string;
  canvasKind: "flowchart" | "mindmap";
  filePath: string;
  createdAt: number;
}

type WorkspaceTab = OfficeWorkspaceTab | VideoWorkspaceTab | CanvasWorkspaceTab;
type PersistedWorkspaceTab = Omit<OfficeWorkspaceTab, "session"> & { sessionId: string } | VideoWorkspaceTab | CanvasWorkspaceTab;

interface HistoryItem {
  key: string;
  kind: "office" | "video";
  title: string;
  createdAt: number;
  detail: string;
  office?: RecentOfficeDocument;
  video?: VideoProject;
}

const OFFICE_META: Record<OfficeDocumentType, { label: string; extension: string }> = {
  docs: { label: "Word 文档", extension: "docx" },
  sheets: { label: "Excel 工作簿", extension: "xlsx" },
  slides: { label: "PPT 演示文稿", extension: "pptx" },
};

function readStoredArray<T>(key: string): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

function readStoredString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function persistWorkspaceTabs(tabs: WorkspaceTab[]): void {
  const value: PersistedWorkspaceTab[] = tabs.map((tab) => {
    if (tab.kind !== "office") return tab;
    const { session, ...rest } = tab;
    return { ...rest, sessionId: session.sessionId };
  });
  localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(value));
}

function tabIcon(tab: WorkspaceTab): DocumentIconKind {
  if (tab.kind === "video-workflow") return "video";
  if (tab.kind === "canvas") return tab.canvasKind;
  if (tab.officeType === "sheets") return "excel";
  if (tab.officeType === "slides") return "ppt";
  return "word";
}

function historyIcon(item: HistoryItem): DocumentIconKind {
  if (item.kind === "video") return "video";
  if (item.office?.officeType === "sheets") return "excel";
  if (item.office?.officeType === "slides") return "ppt";
  return "word";
}

function formatTime(epoch: number): string {
  const date = new Date(epoch > 1e12 ? epoch : epoch * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function nextDocumentTitle(type: OfficeDocumentType, tabs: WorkspaceTab[]): string {
  const base = type === "docs" ? "新建文档" : type === "sheets" ? "新建工作簿" : "新建演示文稿";
  const count = tabs.filter((tab) => tab.title === base || tab.title.startsWith(`${base} `)).length;
  return count === 0 ? base : `${base} ${count + 1}`;
}

/** Spell out exactly what 「删除」 removes before the user confirms. An imported
 *  document's source file lives outside Mona's storage and is never deleted. */
function deleteHistoryDescription(item: HistoryItem): string {
  if (item.video) {
    return `将删除视频项目「${item.title}」及其全部文件（分镜、场景与渲染产物）。此操作不可撤销。`;
  }
  const sourcePath = item.office?.sourcePath;
  if (sourcePath) {
    return `将删除「${item.title}」在 Mona 中的编辑记录与工作文件。原文件 ${sourcePath} 不会被删除。此操作不可撤销。`;
  }
  return `将删除文档「${item.title}」及其工作文件。此操作不可撤销。`;
}

export function DocMakerView() {
  const { client, token } = useClient();
  const workspacePath = useWorkspaceStore((state) => state.workspacePath);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState(() => readStoredString(ACTIVE_TAB_STORAGE_KEY, START_TAB_ID));
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [streamingByTab, setStreamingByTab] = useState<Record<string, boolean>>({});
  const [recentOffice, setRecentOffice] = useState<RecentOfficeDocument[]>(() => readStoredArray<RecentOfficeDocument>(RECENT_OFFICE_STORAGE_KEY));
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(readStoredArray<string>(FAVORITES_STORAGE_KEY)));
  const [historyMode, setHistoryMode] = useState<"recent" | "favorites">("recent");
  const [query, setQuery] = useState("");
  const [videoProjects, setVideoProjects] = useState<VideoProject[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [officeToolbarContainer, setOfficeToolbarContainer] = useState<HTMLDivElement | null>(null);
  const [pendingDelete, setPendingDelete] = useState<HistoryItem | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const canvasWorkspaceRoot = workspacePath.trim()
    ? `${workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")}/agent-workspaces/mona/output`
    : null;

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await fetchVideoProjects(token);
      setVideoProjects(result.projects ?? []);
      setHistoryError(null);
    } catch {
      setHistoryError("历史项目暂时无法加载，请稍后重试。");
    } finally {
      setHistoryLoading(false);
    }
  }, [token]);

  useEffect(() => { void refreshHistory(); }, [refreshHistory]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const persisted = readStoredArray<PersistedWorkspaceTab>(WORKSPACE_STORAGE_KEY);
      const restored: WorkspaceTab[] = [];
      for (const tab of persisted) {
        if (tab.kind === "video-workflow" || tab.kind === "canvas") {
          restored.push(tab);
          continue;
        }
        if (tab.kind === "office") {
          try {
            const session = await getOfficeSession(tab.sessionId, tab.ownerSessionKey);
            restored.push({ ...tab, session });
          } catch {
            // Closed or expired sessions disappear from the open tab strip.
          }
        }
      }
      if (cancelled) return;
      setTabs(restored);
      setActiveTabId((current) => current === START_TAB_ID || restored.some((tab) => tab.id === current) ? current : START_TAB_ID);
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      persistWorkspaceTabs(tabs);
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTabId);
    } catch {
      // The current workspace remains usable when persistence is unavailable.
    }
  }, [activeTabId, hydrated, tabs]);

  useEffect(() => {
    try {
      localStorage.setItem(RECENT_OFFICE_STORAGE_KEY, JSON.stringify(recentOffice));
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...favorites]));
    } catch {
      // The current workspace remains usable when persistence is unavailable.
    }
  }, [favorites, recentOffice]);

  const addTab = useCallback((tab: WorkspaceTab) => {
    setTabs((current) => {
      const existing = current.findIndex((item) => item.id === tab.id);
      if (existing < 0) return [...current, tab];
      const next = [...current];
      next[existing] = tab;
      return next;
    });
    setActiveTabId(tab.id);
  }, []);

  const updateTab = useCallback((tabId: string, update: (tab: WorkspaceTab) => WorkspaceTab) => {
    setTabs((current) => current.map((tab) => tab.id === tabId ? update(tab) : tab));
  }, []);

  const rememberOffice = useCallback((tab: OfficeWorkspaceTab) => {
    const recent: RecentOfficeDocument = {
      key: `office:${tab.session.sessionId}`,
      sessionId: tab.session.sessionId,
      ownerSessionKey: tab.ownerSessionKey,
      chatId: tab.chatId,
      title: tab.title,
      officeType: tab.officeType,
      updatedAt: Date.now(),
      sourcePath: tab.sourcePath ?? null,
      savedPath: tab.session.workingPath ?? null,
    };
    setRecentOffice((current) => [recent, ...current.filter((item) => item.key !== recent.key)].slice(0, 50));
  }, []);

  const createChat = useCallback((agentKind?: "video") => client.newChat(5_000, false, null, agentKind ?? null), [client]);

  const createOfficeDocument = useCallback(async (officeType: OfficeDocumentType) => {
    if (creating) return;
    setCreating(true);
    setActionError(null);
    try {
      const chatId = await createChat();
      const ownerSessionKey = `websocket:${chatId}`;
      const title = nextDocumentTitle(officeType, tabs);
      const session = await createOfficeSession({ ownerSessionKey, type: officeType, displayName: title });
      const tab: OfficeWorkspaceTab = {
        id: `office:${session.sessionId}`,
        kind: "office",
        title,
        chatId,
        ownerSessionKey,
        officeType,
        session,
        createdAt: Date.now(),
        sourcePath: null,
      };
      addTab(tab);
      rememberOffice(tab);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "文档创建失败。");
    } finally {
      setCreating(false);
    }
  }, [addTab, createChat, creating, rememberOffice, tabs]);

  const importOfficeFile = useCallback(async (filename: string, file: ArrayBuffer, sourceIdentity: string, sourcePath: string | null = null) => {
    if (creating) return;
    const extension = filename.split(".").pop()?.toLowerCase();
    const officeType: OfficeDocumentType | null = extension === "docx" ? "docs" : extension === "xlsx" ? "sheets" : extension === "pptx" ? "slides" : null;
    if (!officeType) {
      setActionError("请选择 .docx、.xlsx 或 .pptx 文件。");
      return;
    }
    setCreating(true);
    setActionError(null);
    try {
      const chatId = await createChat();
      const ownerSessionKey = `websocket:${chatId}`;
      const session = await importOfficeSession({ filename, sourceIdentity, ownerSessionKey }, file);
      const tab: OfficeWorkspaceTab = {
        id: `office:${session.sessionId}`,
        kind: "office",
        title: filename,
        chatId,
        ownerSessionKey,
        officeType,
        session,
        createdAt: Date.now(),
        sourcePath,
      };
      addTab(tab);
      rememberOffice(tab);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "文件打开失败。");
    } finally {
      setCreating(false);
    }
  }, [addTab, createChat, creating, rememberOffice]);

  const handleOpenFile = useCallback(async () => {
    if (!isTauri()) {
      fileInputRef.current?.click();
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ multiple: false, filters: [{ name: "Office 文档", extensions: ["docx", "xlsx", "pptx"] }] });
    if (typeof selected !== "string") return;
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const content = await readFile(selected);
    const filename = selected.split(/[\\/]/).pop() ?? "文档";
    await importOfficeFile(filename, content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength), `local:${selected}`, selected);
  }, [importOfficeFile]);

  const createVideoTab = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setActionError(null);
    try {
      const chatId = await createChat("video");
      addTab({ id: `video:new:${crypto.randomUUID()}`, kind: "video-workflow", title: "新建视频", chatId, project: null, createdAt: Date.now() });
      setRightSidebarOpen(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "视频项目创建失败。");
    } finally {
      setCreating(false);
    }
  }, [addTab, createChat, creating]);

  const createCanvasTab = useCallback(async (kind: "flowchart" | "mindmap") => {
    if (creating) return;
    setCreating(true);
    setActionError(null);
    try {
      if (!canvasWorkspaceRoot) throw new Error("当前工作区尚未就绪");
      const chatId = await createChat();
      const title = kind === "flowchart" ? "未命名流程图" : "未命名思维导图";
      const note = createConversationCanvasNote(kind, title, chatId);
      const canvas: WorkspaceCanvasDocument = {
        version: 1,
        id: note.id,
        kind,
        title,
        originChatId: chatId,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        contentMarkdown: note.contentMarkdown,
      };
      const saved = await saveWorkspaceCanvas(canvasWorkspaceRoot, canvas);
      addTab({
        id: `canvas:${note.id}`,
        kind: "canvas",
        title,
        chatId,
        canvasKind: kind,
        filePath: saved.path,
        createdAt: Date.now(),
      });
      setRightSidebarOpen(true);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "画布创建失败。");
    } finally {
      setCreating(false);
    }
  }, [addTab, canvasWorkspaceRoot, createChat, creating]);

  const openHistoryItem = useCallback(async (item: HistoryItem) => {
    setActionError(null);
    try {
      if (item.office) {
        const session = await getOfficeSession(item.office.sessionId, item.office.ownerSessionKey);
        addTab({
          id: `office:${session.sessionId}`, kind: "office", title: item.office.title, chatId: item.office.chatId,
          ownerSessionKey: item.office.ownerSessionKey, officeType: item.office.officeType, session,
          createdAt: item.office.updatedAt,
          sourcePath: item.office.sourcePath ?? null,
        });
        return;
      }
      if (item.video) {
        const chatId = item.video.chatId ?? await createChat("video");
        if (!item.video.chatId) await saveVideoChatId(token, item.video.name, chatId);
        addTab({
          id: `video:${item.video.name}`, kind: "video-workflow", title: item.video.name, chatId,
          project: { name: item.video.name, phase: item.video.phase, chatId }, createdAt: item.video.createdAt,
        });
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "项目打开失败。");
    }
  }, [addTab, createChat, token]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== tabId));
    if (activeTabId === tabId) setActiveTabId(START_TAB_ID);
  }, [activeTabId]);

  const handleOfficeClosed = useCallback((tabId: string, sessionId: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== tabId));
    setRecentOffice((current) => current.filter((item) => item.sessionId !== sessionId));
    setFavorites((current) => {
      const next = new Set(current);
      next.delete(`office:${sessionId}`);
      return next;
    });
    if (activeTabId === tabId) setActiveTabId(START_TAB_ID);
  }, [activeTabId]);

  const toggleFavorite = useCallback((itemKey: string) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(itemKey)) next.delete(itemKey);
      else next.add(itemKey);
      return next;
    });
  }, []);

  const removeRecentOfficeItem = useCallback((office: RecentOfficeDocument) => {
    setRecentOffice((current) => current.filter((item) => item.key !== office.key));
    setFavorites((current) => {
      const next = new Set(current);
      next.delete(office.key);
      return next;
    });
  }, []);

  const closeHistoryItemTabs = useCallback((item: HistoryItem) => {
    const targetsTab = (tab: WorkspaceTab) => {
      if (item.office) return tab.kind === "office" && tab.session.sessionId === item.office.sessionId;
      if (item.video) return tab.kind === "video-workflow" && tab.project?.name === item.video.name;
      return false;
    };
    const remaining = tabs.filter((tab) => !targetsTab(tab));
    setTabs(remaining);
    if (!remaining.some((tab) => tab.id === activeTabId)) setActiveTabId(START_TAB_ID);
  }, [activeTabId, tabs]);

  const confirmDeleteHistoryItem = useCallback(async () => {
    const item = pendingDelete;
    if (!item || deletingKey) return;
    setActionError(null);
    setDeletingKey(item.key);
    try {
      if (item.office) {
        await deleteOfficeSession(item.office.sessionId, item.office.ownerSessionKey);
        removeRecentOfficeItem(item.office);
      } else if (item.video) {
        await deleteVideoProject(token, item.video.name);
        setVideoProjects((current) => current.filter((project) => project.name !== item.video!.name));
        setFavorites((current) => {
          const next = new Set(current);
          next.delete(item.key);
          return next;
        });
      }
      closeHistoryItemTabs(item);
      setPendingDelete(null);
    } catch (error) {
      setActionError(`删除失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setDeletingKey(null);
    }
  }, [closeHistoryItemTabs, deletingKey, pendingDelete, removeRecentOfficeItem, token]);

  const openHistoryDirectory = useCallback(async (item: HistoryItem) => {
    setActionError(null);
    if (!isTauri()) {
      setActionError("当前环境不支持打开文件目录。");
      return;
    }
    try {
      if (item.office) {
        let filePath = item.office.sourcePath ?? item.office.savedPath ?? null;
        if (!filePath) {
          const session = await getOfficeSession(item.office.sessionId, item.office.ownerSessionKey);
          filePath = session.workingPath ?? null;
          if (filePath) {
            setRecentOffice((current) => current.map((office) => (
              office.key === item.office!.key ? { ...office, savedPath: filePath } : office
            )));
          }
        }
        if (!filePath) {
          setActionError("该文档当前没有可定位的已保存文件。");
          return;
        }
        await revealItemInDir(filePath);
        return;
      }
      if (item.video) {
        if (!workspacePath) throw new Error("尚未选择工作区");
        if (!item.video.hasVideo) {
          setActionError("该视频尚未生成最终文件。");
          return;
        }
        await revealItemInDir(`${workspacePath}/video_projects/${item.video.name}/renders/output.mp4`);
      }
    } catch (error) {
      setActionError(`无法打开文件目录：${error instanceof Error ? error.message : "目录不存在或已被移动"}`);
    }
  }, [workspacePath]);

  const sendForTab = useCallback((tab: WorkspaceTab, content: string, displayContent?: string) => {
    if (tab.kind === "office") {
      client.sendMessage(tab.chatId, content, undefined, {
        officeSessionId: tab.session.sessionId, officeDocumentType: tab.officeType, officeDisplayName: tab.title, displayContent,
      });
      return;
    }
    if (tab.kind === "canvas") {
      client.sendMessage(tab.chatId, content, undefined, { displayContent });
      return;
    }
    client.sendMessage(tab.chatId, content, undefined, { agentKind: "video", displayContent });
  }, [client]);

  const historyItems = useMemo<HistoryItem[]>(() => {
    const officeItems: HistoryItem[] = recentOffice.map((office) => ({ key: office.key, kind: "office", title: office.title, createdAt: office.updatedAt, detail: OFFICE_META[office.officeType].label, office }));
    const videoItems: HistoryItem[] = videoProjects.map((video) => ({ key: `video:${video.name}`, kind: "video", title: video.name, createdAt: video.createdAt, detail: video.phase === "done" ? "视频 · 已完成" : "视频 · 制作中", video }));
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return [...officeItems, ...videoItems]
      .filter((item) => historyMode === "recent" || favorites.has(item.key))
      .filter((item) => !normalizedQuery || item.title.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => right.createdAt - left.createdAt);
  }, [favorites, historyMode, query, recentOffice, videoProjects]);

  const renderStartPage = () => (
    <div
      className="relative h-full overflow-y-auto bg-background"
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) void file.arrayBuffer().then((buffer) => importOfficeFile(file.name, buffer, `drop:${file.name}:${file.size}:${file.lastModified}`));
      }}
    >
      <div className="mx-auto w-full max-w-6xl px-8 py-8">
        <div className="mb-7 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-title-lg font-semibold text-foreground">文档</h1>
            <p className="mt-1 text-body text-muted-foreground">创建、继续编辑，或让 MONA AI 和你一起完成内容。</p>
          </div>
          <Button variant="outline" className="gap-2" onClick={() => void handleOpenFile()} disabled={creating}><Upload className="h-4 w-4" />打开文件</Button>
        </div>

        <section aria-labelledby="new-document-heading">
          <h2 id="new-document-heading" className="mb-3 text-title-sm font-semibold">新建</h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
            <NewDocumentButton icon={<DocumentTypeIcon kind="word" />} title="Word" onClick={() => void createOfficeDocument("docs")} disabled={creating} />
            <NewDocumentButton icon={<DocumentTypeIcon kind="excel" />} title="Excel" onClick={() => void createOfficeDocument("sheets")} disabled={creating} />
            <NewDocumentButton icon={<DocumentTypeIcon kind="ppt" />} title="PPT" onClick={() => void createOfficeDocument("slides")} disabled={creating} />
            <NewDocumentButton icon={<DocumentTypeIcon kind="video" />} title="视频" onClick={() => void createVideoTab()} disabled={creating} />
            <NewDocumentButton icon={<DocumentTypeIcon kind="mindmap" />} title="思维导图" onClick={() => void createCanvasTab("mindmap")} disabled={creating} />
            <NewDocumentButton icon={<DocumentTypeIcon kind="flowchart" />} title="流程图" onClick={() => void createCanvasTab("flowchart")} disabled={creating} />
          </div>
        </section>

        <section className="mt-9" aria-labelledby="document-history-heading">
          <div className="mb-3 flex items-center justify-between gap-4">
            <Tabs value={historyMode} onValueChange={(value) => setHistoryMode(value as "recent" | "favorites")}>
              <TabsList className="h-8"><TabsTrigger value="recent" className="h-7 px-3 text-caption">最近</TabsTrigger><TabsTrigger value="favorites" className="h-7 px-3 text-caption">收藏</TabsTrigger></TabsList>
            </Tabs>
            <div className="relative w-64"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文档和项目" className="h-8 pl-8 text-caption" /></div>
          </div>
          <h2 id="document-history-heading" className="sr-only">文档历史</h2>
          <div className="border-y border-border/70">
            {historyItems.map((item) => {
              const icon = historyIcon(item);
              const favorite = favorites.has(item.key);
              return (
                <ContextMenu key={item.key}>
                  <ContextMenuTrigger asChild>
                    <div data-testid={`document-history-row-${item.key}`} className="group flex h-14 items-center gap-3 border-b border-border/55 px-3 last:border-b-0 hover:bg-muted/40">
                      <Button type="button" variant="ghost" className="h-full min-w-0 flex-1 justify-start gap-3 rounded-none px-0 text-left hover:bg-transparent" onClick={() => void openHistoryItem(item)}>
                        <DocumentTypeIcon kind={icon} size={18} />
                        <span className="min-w-0 flex-1"><span className="block truncate text-ui font-medium">{item.title}</span><span className="mt-0.5 block truncate text-caption text-muted-foreground">{item.detail}</span></span>
                        <span className="w-16 shrink-0 text-right text-caption text-muted-foreground">{formatTime(item.createdAt)}</span>
                      </Button>
                      <Button
                        type="button" variant="ghost" size="icon" aria-label={favorite ? `取消收藏 ${item.title}` : `收藏 ${item.title}`}
                        className={cn("h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100", favorite && "text-foreground opacity-100")}
                        onClick={() => toggleFavorite(item.key)}
                      ><Star className={cn("h-3.5 w-3.5", favorite && "fill-current")} /></Button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="w-44">
                    <ContextMenuItem onSelect={() => void openHistoryItem(item)}>
                      <FolderOpen className="h-3.5 w-3.5" />
                      打开
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => toggleFavorite(item.key)}>
                      <Star className={cn("h-3.5 w-3.5", favorite && "fill-current")} />
                      {favorite ? "取消收藏" : "收藏"}
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void openHistoryDirectory(item)}>
                      <FolderOpen className="h-3.5 w-3.5" />
                      打开文件目录
                    </ContextMenuItem>
                    {item.office ? (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => removeRecentOfficeItem(item.office!)}>
                          <ListX className="h-3.5 w-3.5" />
                          从最近记录中移除
                        </ContextMenuItem>
                      </>
                    ) : null}
                    <ContextMenuSeparator />
                    <ContextMenuItem
                      className="text-destructive focus:text-destructive"
                      data-testid={`document-history-delete-${item.key}`}
                      onSelect={() => setPendingDelete(item)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      删除
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
            {!historyLoading && historyItems.length === 0 ? <div className="flex h-28 items-center justify-center text-caption text-muted-foreground">{historyMode === "favorites" ? "收藏的文档会显示在这里" : query ? "没有匹配的文档" : "新建或打开文档后会显示在这里"}</div> : null}
            {historyLoading ? <div className="flex h-20 items-center justify-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在加载历史…</div> : null}
          </div>
          {historyError ? <div className="mt-3 text-caption text-destructive">{historyError}</div> : null}
        </section>
      </div>
      {dragging ? <div className="pointer-events-none absolute inset-4 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/90"><div className="flex items-center gap-2 text-ui font-medium"><Upload className="h-5 w-5" />松开以打开 Office 文档</div></div> : null}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 bg-background" data-testid="document-workspace">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-8 shrink-0 items-center border-b border-border/70 bg-background pl-2 pr-11">
          <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist" aria-label="打开的文档">
            <Button type="button" variant="ghost" role="tab" aria-selected={activeTabId === START_TAB_ID} className={cn("relative h-8 shrink-0 gap-1.5 rounded-none px-2.5 text-caption text-muted-foreground hover:bg-transparent hover:text-foreground", activeTabId === START_TAB_ID && "font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-px after:bg-foreground")} onClick={() => setActiveTabId(START_TAB_ID)}><Home className="h-3.5 w-3.5" />开始</Button>
            {tabs.map((tab) => {
              const icon = tabIcon(tab);
              const active = activeTabId === tab.id;
              return (
                <div key={tab.id} className={cn("relative flex h-8 min-w-32 max-w-56 shrink-0 items-center border-l border-border/55 pl-2.5 pr-1 text-caption text-muted-foreground", active && "bg-muted/35 font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-px after:bg-foreground")}>
                  <Button type="button" variant="ghost" role="tab" aria-selected={active} className="h-full min-w-0 flex-1 justify-start gap-1.5 rounded-none px-0 hover:bg-transparent" onClick={() => setActiveTabId(tab.id)}><DocumentTypeIcon kind={icon} size={16} /><span className="truncate" title={tab.title}>{tab.title}</span></Button>
                  <Button type="button" variant="ghost" size="icon" className="h-5 w-5 shrink-0" aria-label={`关闭 ${tab.title}`} onClick={() => closeTab(tab.id)}><X className="h-3 w-3" /></Button>
                </div>
              );
            })}
          </div>
          <div ref={setOfficeToolbarContainer} className="flex shrink-0 items-center" data-testid="document-office-controls" />
        </div>

        <main className="relative isolate min-w-0 flex-1 overflow-hidden">
          <div className={cn("absolute inset-0", activeTabId !== START_TAB_ID && "invisible pointer-events-none")}>{renderStartPage()}</div>
          {tabs.map((tab) => (
            <div key={tab.id} className={cn("absolute inset-0 flex min-h-0 flex-col bg-background", activeTabId !== tab.id && "invisible pointer-events-none")}>
              {tab.kind === "office" ? (
                <div className="absolute inset-0 flex min-h-0 flex-col">
                  <div className="min-h-0 flex-1"><OfficeEditorHost key={tab.session.sessionId} initialSession={tab.session} ownerSessionKey={tab.ownerSessionKey} generating={Boolean(streamingByTab[tab.id])} onClosed={(sessionId) => handleOfficeClosed(tab.id, sessionId)} onAiRequest={(prompt, displayText) => { setRightSidebarOpen(true); sendForTab(tab, prompt, displayText); }} toolbarContainer={activeTabId === tab.id ? officeToolbarContainer : null} /></div>
                </div>
              ) : tab.kind === "canvas" ? (
                <Suspense fallback={<LoadingLabel label="正在打开画布…" />}><CanvasFileView filePath={tab.filePath} /></Suspense>
              ) : (
                <Suspense fallback={<LoadingLabel label="正在打开视频工作流…" />}><VideoMakerView embedded hostChatId={tab.chatId} hostIsStreaming={Boolean(streamingByTab[tab.id])} initialProject={tab.project} onProjectChange={(project) => updateTab(tab.id, (current) => current.kind === "video-workflow" ? { ...current, title: project?.name ?? current.title, project } : current)} onSendVideoTurn={(content, displayContent) => sendForTab(tab, content, displayContent)} /></Suspense>
              )}
            </div>
          ))}
        </main>
      </div>

      {rightSidebarOpen ? (
        <aside aria-label="MONA AI 文档助手" className="flex h-full w-80 shrink-0 flex-col border-l border-border/70 bg-background">
          <div className="flex h-8 shrink-0 items-center border-b border-border/70 px-3 pr-11"><div className="flex min-w-0 items-center gap-2"><AgentLogo state={activeTab && streamingByTab[activeTab.id] ? "working" : "idle"} className="h-5 w-5 shrink-0" title="Mona" /><div className="text-ui font-semibold">MONA AI</div></div></div>
          <div className="min-h-0 flex-1">
            {activeTab ? <DocChatPanel key={activeTab.chatId} chatId={activeTab.chatId} onSend={(content) => sendForTab(activeTab, content)} onStreamingChange={(streaming) => setStreamingByTab((current) => ({ ...current, [activeTab.id]: streaming }))} placeholder={activeTab.kind === "video-workflow" ? "和 MONA AI 一起调整当前视频…" : activeTab.kind === "canvas" ? "让 MONA AI 协助完善当前画布…" : "让 MONA AI 阅读或修改当前文档…"} /> : <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-caption text-muted-foreground"><AgentLogo state="idle" className="h-8 w-8" title="Mona" /><span>打开一个文档后，MONA AI 会在这里协助你。</span></div>}
          </div>
        </aside>
      ) : null}

      <TooltipProvider delayDuration={150}><Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="absolute right-2 top-0.5 z-10 h-7 w-7" aria-label={rightSidebarOpen ? "收起 MONA AI" : "打开 MONA AI"} onClick={() => setRightSidebarOpen((open) => !open)}><RightSidebarToggleIcon open={rightSidebarOpen} className="h-4 w-4" /></Button></TooltipTrigger><TooltipContent side="bottom">{rightSidebarOpen ? "收起 MONA AI" : "打开 MONA AI"}</TooltipContent></Tooltip></TooltipProvider>

      <Input ref={fileInputRef} type="file" className="hidden" accept=".docx,.xlsx,.pptx" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.arrayBuffer().then((buffer) => importOfficeFile(file.name, buffer, `browser:${file.name}:${file.size}:${file.lastModified}`)); event.target.value = ""; }} />
      <DeleteConfirm
        open={pendingDelete !== null}
        title={pendingDelete?.title ?? ""}
        titleText={pendingDelete ? `删除「${pendingDelete.title}」？` : undefined}
        descriptionText={pendingDelete ? deleteHistoryDescription(pendingDelete) : undefined}
        confirmText="删除"
        onCancel={() => { if (!deletingKey) setPendingDelete(null); }}
        onConfirm={() => void confirmDeleteHistoryItem()}
      />
      {actionError ? <div className="absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/30 bg-background px-3 py-2 text-caption text-destructive shadow-md" role="alert"><span>{actionError}</span><Button variant="ghost" size="sm" className="h-6 px-2 text-caption" onClick={() => setActionError(null)}>关闭</Button></div> : null}
    </div>
  );
}

function NewDocumentButton({ icon, title, onClick, disabled }: { icon: ReactNode; title: string; onClick: () => void; disabled: boolean }) {
  return (
    <Button type="button" variant="outline" className="group h-20 min-w-0 justify-start gap-3 overflow-hidden rounded-xl bg-card p-3 text-left hover:border-foreground/20 hover:bg-muted/45 disabled:opacity-60" onClick={onClick} disabled={disabled}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 truncate text-ui font-semibold">{title}</span>
    </Button>
  );
}

function LoadingLabel({ label }: { label: string }) {
  return <div className="flex h-full items-center justify-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{label}</div>;
}
