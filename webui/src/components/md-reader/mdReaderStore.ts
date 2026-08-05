import { create } from "zustand";
import type { EditorMode } from "@/components/common/MarkdownEditor";

export interface MdFileTab {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  originalContent: string;
  mode: EditorMode;
  dirty: boolean;
  loading: boolean;
  error: string | null;
  agentChatId?: string;
}

interface MdReaderState {
  tabs: MdFileTab[];
  activeTabId: string | null;

  openFile: (filePath: string) => Promise<void>;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabContent: (tabId: string, content: string) => void;
  updateTabMode: (tabId: string, mode: EditorMode) => void;
  updateTabAgentChatId: (tabId: string, chatId: string) => void;
  reloadTab: (tabId: string) => Promise<void>;
  saveTab: (tabId: string) => Promise<void>;
  saveActiveTab: () => Promise<void>;
}

async function readMdFile(filePath: string): Promise<string> {
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  return readTextFile(filePath);
}

async function writeMdFile(filePath: string, content: string): Promise<void> {
  const { writeTextFile } = await import("@tauri-apps/plugin-fs");
  await writeTextFile(filePath, content);
}

function fileNameFromPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || "untitled.md";
}

export const useMdReaderStore = create<MdReaderState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openFile: async (filePath: string) => {
    const normalized = filePath.replace(/\\/g, "/");
    const existing = get().tabs.find((t) => t.filePath.replace(/\\/g, "/") === normalized);
    if (existing) {
      set({ activeTabId: existing.id });
      return;
    }

    const tabId = crypto.randomUUID();
    const newTab: MdFileTab = {
      id: tabId,
      filePath,
      fileName: fileNameFromPath(filePath),
      content: "",
      originalContent: "",
      mode: "visual",
      dirty: false,
      loading: true,
      error: null,
    };

    set((state) => ({
      tabs: [...state.tabs, newTab],
      activeTabId: tabId,
    }));

    try {
      const content = await readMdFile(filePath);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, content, originalContent: content, loading: false }
            : t,
        ),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, loading: false, error: message }
            : t,
        ),
      }));
    }
  },

  closeTab: (tabId: string) => {
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === tabId);
      const nextTabs = state.tabs.filter((t) => t.id !== tabId);
      let nextActiveId = state.activeTabId;
      if (state.activeTabId === tabId) {
        nextActiveId = nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? null;
      }
      return { tabs: nextTabs, activeTabId: nextActiveId };
    });
  },

  setActiveTab: (tabId: string) => {
    set({ activeTabId: tabId });
  },

  updateTabContent: (tabId: string, content: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? { ...t, content, dirty: content !== t.originalContent }
          : t,
      ),
    }));
  },

  updateTabMode: (tabId: string, mode: EditorMode) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, mode } : t,
      ),
    }));
  },

  updateTabAgentChatId: (tabId: string, chatId: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId ? { ...t, agentChatId: chatId } : t,
      ),
    }));
  },

  reloadTab: async (tabId: string) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    try {
      const content = await readMdFile(tab.filePath);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, content, originalContent: content, dirty: false }
            : t,
        ),
      }));
    } catch (err) {
      console.error(`Failed to reload ${tab.filePath}:`, err);
    }
  },

  saveTab: async (tabId: string) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab || !tab.dirty) return;
    try {
      await writeMdFile(tab.filePath, tab.content);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? { ...t, originalContent: t.content, dirty: false }
            : t,
        ),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed to save ${tab.filePath}:`, message);
      throw err;
    }
  },

  saveActiveTab: async () => {
    const { activeTabId, saveTab } = get();
    if (activeTabId) {
      await saveTab(activeTabId);
    }
  },
}));
