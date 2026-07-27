import { create } from "zustand";
import type { DeliveredFile } from "@/lib/types";

export type PreviewScope = "shared" | "project";

interface FilePreviewState {
  file: DeliveredFile | null;
  /** Preview scope: ``shared`` resolves under ``<workspace>/output/``;
   *  ``project`` resolves under the session's bound workspace. */
  scope: PreviewScope;
  /** Required when ``scope === "project"``: the websocket session key
   *  whose ``metadata.workspace`` is the preview root. */
  sessionKey: string | null;
  splitRatio: number;
  /** Whether the workspace (right) panel is collapsed by the user. */
  workspaceCollapsed: boolean;
  /** Whether the in-pane preview is expanded to application-fullscreen. */
  fullscreen: boolean;
  open: (
    file: DeliveredFile,
    scope?: PreviewScope,
    sessionKey?: string | null,
  ) => void;
  close: () => void;
  setSplitRatio: (ratio: number) => void;
  setWorkspaceCollapsed: (collapsed: boolean) => void;
  toggleWorkspaceCollapsed: () => void;
  setFullscreen: (fullscreen: boolean) => void;
  toggleFullscreen: () => void;
}

export const useFilePreviewStore = create<FilePreviewState>((set) => ({
  file: null,
  scope: "shared",
  sessionKey: null,
  splitRatio: 0.72,
  workspaceCollapsed: false,
  fullscreen: false,
  open: (file, scope = "shared", sessionKey = null) =>
    set({ file, scope, sessionKey, fullscreen: false }),
  close: () => set({ file: null, fullscreen: false }),
  setSplitRatio: (splitRatio) => set({ splitRatio }),
  setWorkspaceCollapsed: (workspaceCollapsed) => set({ workspaceCollapsed }),
  toggleWorkspaceCollapsed: () =>
    set((s) => ({ workspaceCollapsed: !s.workspaceCollapsed })),
  setFullscreen: (fullscreen) => set({ fullscreen }),
  toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),
}));
