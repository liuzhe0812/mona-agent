import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OperationNote } from "@/components/notes/notes-data";
import { nowTimestamp } from "@/components/notes/notes-data";
import type { UIMessage } from "@/lib/types";
import {
  isTauri,
  listWorkspaceCanvases,
  migrateLegacyCanvases,
  readWorkspaceCanvas,
  saveWorkspaceCanvas,
  type SavedWorkspaceCanvas,
  type WorkspaceCanvasDocument,
} from "@/lib/tauri";
import {
  applyConversationCanvasResponse,
  buildConversationCanvasPrompt,
  conversationCanvasBaseHash,
  createConversationCanvasNote,
  detectConversationCanvasIntent,
  type ConversationCanvasRequest,
} from "./conversation-canvas";

export type CanvasGenerationStatus = "idle" | "creating" | "updating" | "error";
export type CanvasSaveStatus = "idle" | "saving" | "saved" | "error";

export interface ConversationCanvasTab {
  id: string;
  note: OperationNote;
  workspacePath?: string;
  generationStatus: CanvasGenerationStatus;
  saveStatus: CanvasSaveStatus;
  notice?: string;
  error?: string;
  qualityWarnings?: string[];
}

interface RoutedCanvasMessage {
  content: string;
  displayContent?: string;
  canvasId?: string;
  canvasPath?: string;
  canvasPathReady?: Promise<string | undefined>;
}

interface UseConversationCanvasesOptions {
  chatId: string | null;
  messages: UIMessage[];
  isStreaming: boolean;
  workspaceRoot: string | null;
  migrateLegacy?: boolean;
  onOpenCanvas?: (canvasId: string, creating: boolean) => void;
}

const AUTOSAVE_DELAY_MS = 450;

export function useConversationCanvases({
  chatId,
  messages,
  isStreaming,
  workspaceRoot,
  migrateLegacy = false,
  onOpenCanvas,
}: UseConversationCanvasesOptions) {
  const [tabs, setTabs] = useState<ConversationCanvasTab[]>([]);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  const pendingRequestRef = useRef<ConversationCanvasRequest | null>(null);
  const processedMessageIdsRef = useRef<Set<string>>(new Set());
  const saveTimersRef = useRef<Map<string, number>>(new Map());
  tabsRef.current = tabs;

  useEffect(() => {
    pendingRequestRef.current = null;
    processedMessageIdsRef.current = new Set();
    for (const timer of saveTimersRef.current.values()) window.clearTimeout(timer);
    saveTimersRef.current.clear();
    setTabs([]);
    setActiveCanvasId(null);
  }, [chatId]);

  useEffect(() => {
    if (!chatId || !workspaceRoot || !migrateLegacy || !isTauri()) return;
    void migrateLegacyCanvases(workspaceRoot).catch(() => undefined);
  }, [chatId, migrateLegacy, workspaceRoot]);

  useEffect(() => {
    if (!chatId || !workspaceRoot || !isTauri()) return;
    let cancelled = false;
    void listWorkspaceCanvases(workspaceRoot, chatId).then((saved) => {
      if (cancelled || saved.length === 0) return;
      const restored = saved.map(savedCanvasToTab);
      const hadCurrentCanvas = tabsRef.current.length > 0;
      setTabs((current) => mergeCanvasTabs(restored, current));
      if (!hadCurrentCanvas) {
        const active = restored[restored.length - 1];
        setActiveCanvasId(active.id);
        onOpenCanvas?.(active.id, false);
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [chatId, onOpenCanvas, workspaceRoot]);

  const persist = useCallback(async (note: OperationNote) => {
    setTabState(setTabs, note.id, { saveStatus: "saving", error: undefined });
    if (!isTauri()) {
      setTabState(setTabs, note.id, { saveStatus: "saved" });
      return undefined;
    }
    if (!workspaceRoot) {
      const error = new Error("当前工作区尚未就绪");
      setTabState(setTabs, note.id, { saveStatus: "error", error: `自动保存失败：${error.message}` });
      throw error;
    }
    try {
      const saved = await saveWorkspaceCanvas(workspaceRoot, editorNoteToCanvas(note));
      const savedNote = workspaceCanvasToEditorNote(saved.canvas);
      setTabs((current) => current.map((tab) => (
        tab.note.id === note.id
          ? tab.note.contentMarkdown === note.contentMarkdown
            ? { ...tab, note: savedNote, workspacePath: saved.path, saveStatus: "saved", error: undefined }
            : { ...tab, workspacePath: saved.path }
          : tab
      )));
      return saved.path;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTabState(setTabs, note.id, { saveStatus: "error", error: `自动保存失败：${message}` });
      throw error;
    }
  }, [workspaceRoot]);

  const schedulePersist = useCallback((note: OperationNote) => {
    const previous = saveTimersRef.current.get(note.id);
    if (previous !== undefined) window.clearTimeout(previous);
    setTabState(setTabs, note.id, { saveStatus: "saving", error: undefined });
    const timer = window.setTimeout(() => {
      saveTimersRef.current.delete(note.id);
      void persist(note).catch(() => undefined);
    }, AUTOSAVE_DELAY_MS);
    saveTimersRef.current.set(note.id, timer);
  }, [persist]);

  const createBlankCanvas = useCallback((kind: "flowchart" | "mindmap") => {
    if (!chatId) return null;
    const title = kind === "flowchart" ? "未命名流程图" : "未命名思维导图";
    const note = createConversationCanvasNote(kind, title, chatId);
    const tabId = canvasTabId(note.id);
    const tab: ConversationCanvasTab = {
      id: tabId,
      note,
      generationStatus: "idle",
      saveStatus: "saving",
    };
    setTabs((current) => [...current.filter((item) => item.id !== tabId), tab]);
    setActiveCanvasId(tabId);
    onOpenCanvas?.(tabId, true);
    void persist(note).catch(() => undefined);
    return tabId;
  }, [chatId, onOpenCanvas, persist]);

  const routeMessage = useCallback((content: string): RoutedCanvasMessage => {
    if (!chatId) return { content };
    const intent = detectConversationCanvasIntent(content);
    const currentTab = tabsRef.current.find((tab) => tab.id === activeCanvasId);
    let target = intent
      ? createConversationCanvasNote(intent.kind, intent.title, chatId)
      : currentTab?.note;
    if (!target) return { content };

    const creating = Boolean(intent);
    const tabId = canvasTabId(target.id);
    let canvasPathReady: Promise<string | undefined> | undefined;
    if (creating) {
      const tab: ConversationCanvasTab = {
        id: tabId,
        note: target,
        generationStatus: "creating",
        saveStatus: "saving",
        notice: `正在创建${target.title}`,
      };
      setTabs((current) => [...current.filter((item) => item.id !== tabId), tab]);
      setActiveCanvasId(tabId);
      onOpenCanvas?.(tabId, true);
      canvasPathReady = persist(target).catch(() => undefined);
    } else {
      setTabState(setTabs, target.id, {
        generationStatus: "updating",
        notice: "Mona 正在修改当前画布",
        error: undefined,
        qualityWarnings: undefined,
      });
      onOpenCanvas?.(tabId, false);
    }

    const requestBaseHash = conversationCanvasBaseHash(target);
    pendingRequestRef.current = {
      noteId: target.id,
      requestBaseHash,
      creating,
      requestedAt: Date.now(),
    };
    return {
      content: buildConversationCanvasPrompt(target, content),
      displayContent: content,
      canvasId: target.id,
      canvasPath: intent ? undefined : currentTab?.workspacePath,
      canvasPathReady,
    };
  }, [activeCanvasId, chatId, onOpenCanvas, persist]);

  useEffect(() => {
    const pending = pendingRequestRef.current;
    if (!pending || isStreaming) return;
    const response = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "assistant"
          && message.kind !== "trace"
          && !message.isStreaming
          && message.content.trim().length > 0
          && message.createdAt >= pending.requestedAt - 1000
          && !processedMessageIdsRef.current.has(message.id),
      );
    if (!response) return;

    processedMessageIdsRef.current.add(response.id);
    pendingRequestRef.current = null;
    const tab = tabsRef.current.find((item) => item.note.id === pending.noteId);
    if (!tab) return;
    const currentHash = conversationCanvasBaseHash(tab.note);
    const toolApplied = tab.note.type === "flowchart"
      && currentHash.length > 0
      && currentHash !== pending.requestBaseHash
      && !/```mona-flowchart-patch\s/i.test(response.content);
    if (toolApplied) {
      setTabState(setTabs, tab.note.id, {
        generationStatus: "idle",
        notice: "画布已更新",
        error: undefined,
      });
      return;
    }
    const result = applyConversationCanvasResponse(
      tab.note,
      response.content,
      response.id,
      pending.requestBaseHash,
    );
    if (result.status === "no-change") {
      setTabState(setTabs, tab.note.id, pending.creating
        ? {
            generationStatus: "error",
            error: "Mona 没有返回可编辑的画布结构，请重新描述要创建的内容",
            notice: undefined,
          }
        : { generationStatus: "idle", notice: undefined });
      return;
    }
    if (result.status !== "applied") {
      setTabState(setTabs, tab.note.id, {
        generationStatus: "error",
        error: result.message,
        notice: undefined,
      });
      return;
    }

    setTabs((current) => current.map((item) => (
      item.note.id === result.note.id
        ? {
            ...item,
            note: result.note,
            generationStatus: "idle",
            saveStatus: "saving",
            notice: result.notice,
            qualityWarnings: result.qualityWarnings,
            error: undefined,
          }
        : item
    )));
    void persist(result.note).catch(() => undefined);
  }, [isStreaming, messages, persist]);

  const updateCanvasContent = useCallback((
    noteId: string,
    next: { contentMarkdown: string; plainText?: string },
  ) => {
    const current = tabsRef.current.find((tab) => tab.note.id === noteId);
    if (!current || current.note.contentMarkdown === next.contentMarkdown) return;
    const note: OperationNote = {
      ...current.note,
      contentMarkdown: next.contentMarkdown,
      plainText: next.plainText,
      updatedAt: nowTimestamp(),
    };
    setTabs((items) => items.map((tab) => (
      tab.note.id === noteId
        ? { ...tab, note, saveStatus: "saving", error: undefined }
        : tab
    )));
    schedulePersist(note);
  }, [schedulePersist]);

  const selectCanvas = useCallback((id: string | null) => {
    setActiveCanvasId(id);
  }, []);

  const openWorkspaceCanvas = useCallback(async (path: string) => {
    if (!workspaceRoot || !path) return null;
    const saved = await readWorkspaceCanvas(workspaceRoot, path);
    const tab = savedCanvasToTab(saved);
    setTabs((current) => mergeCanvasTabs(current, [tab]));
    setActiveCanvasId(tab.id);
    onOpenCanvas?.(tab.id, false);
    return tab.id;
  }, [onOpenCanvas, workspaceRoot]);

  const closeCanvas = useCallback((id: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      setActiveCanvasId((active) => active === id ? (next[next.length - 1]?.id ?? null) : active);
      return next;
    });
  }, []);

  const activeCanvas = useMemo(
    () => tabs.find((tab) => tab.id === activeCanvasId) ?? null,
    [activeCanvasId, tabs],
  );

  return {
    tabs,
    activeCanvas,
    activeCanvasId,
    createBlankCanvas,
    routeMessage,
    updateCanvasContent,
    openWorkspaceCanvas,
    selectCanvas,
    closeCanvas,
  };
}

function editorNoteToCanvas(note: OperationNote): WorkspaceCanvasDocument {
  return {
    version: 1,
    id: note.id,
    kind: note.type === "mindmap" ? "mindmap" : "flowchart",
    title: note.title,
    originChatId: note.originChatId,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    contentMarkdown: note.contentMarkdown,
  };
}

function workspaceCanvasToEditorNote(canvas: WorkspaceCanvasDocument): OperationNote {
  return {
    id: canvas.id,
    notebookId: "",
    title: canvas.title,
    preview: canvas.kind === "flowchart" ? "流程图" : "思维导图",
    createdAt: canvas.createdAt,
    updatedAt: canvas.updatedAt,
    source: { kind: "agent", label: "工作区画布" },
    contentMarkdown: canvas.contentMarkdown,
    appliedAgentMessageIds: [],
    contextLevel: "full",
    type: canvas.kind,
    originChatId: canvas.originChatId,
  };
}

function savedCanvasToTab(saved: SavedWorkspaceCanvas): ConversationCanvasTab {
  const note = workspaceCanvasToEditorNote(saved.canvas);
  return {
    id: canvasTabId(note.id),
    note,
    workspacePath: saved.path,
    generationStatus: "idle",
    saveStatus: "saved",
  };
}

export function canvasTabId(noteId: string): string {
  return `canvas:${noteId}`;
}

function mergeCanvasTabs(
  restored: ConversationCanvasTab[],
  current: ConversationCanvasTab[],
): ConversationCanvasTab[] {
  const byId = new Map(restored.map((tab) => [tab.id, tab]));
  for (const tab of current) byId.set(tab.id, tab);
  return [...byId.values()];
}

function setTabState(
  setter: React.Dispatch<React.SetStateAction<ConversationCanvasTab[]>>,
  noteId: string,
  patch: Partial<Omit<ConversationCanvasTab, "id" | "note">>,
) {
  setter((current) => current.map((tab) => (
    tab.note.id === noteId ? { ...tab, ...patch } : tab
  )));
}
