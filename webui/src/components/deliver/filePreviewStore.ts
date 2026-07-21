import { create } from "zustand";
import type { DeliveredFile } from "@/lib/types";

interface FilePreviewState {
  file: DeliveredFile | null;
  splitRatio: number;
  /** Middle:right split ratio within the right half (three-column mode). */
  middleRatio: number;
  /** Whether the workspace (right) panel is collapsed by the user. */
  workspaceCollapsed: boolean;
  open: (file: DeliveredFile) => void;
  close: () => void;
  setSplitRatio: (ratio: number) => void;
  setMiddleRatio: (ratio: number) => void;
  setWorkspaceCollapsed: (collapsed: boolean) => void;
  toggleWorkspaceCollapsed: () => void;
}

export const useFilePreviewStore = create<FilePreviewState>((set) => ({
  file: null,
  splitRatio: 0.45,
  middleRatio: 0.6,
  workspaceCollapsed: false,
  open: (file) => set({ file }),
  close: () => set({ file: null }),
  setSplitRatio: (splitRatio) => set({ splitRatio }),
  setMiddleRatio: (middleRatio) => set({ middleRatio }),
  setWorkspaceCollapsed: (workspaceCollapsed) => set({ workspaceCollapsed }),
  toggleWorkspaceCollapsed: () =>
    set((s) => ({ workspaceCollapsed: !s.workspaceCollapsed })),
}));
