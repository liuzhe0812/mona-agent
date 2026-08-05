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
  /** Artifact paths present when the panel inventory was first observed.
   *  This is the "not new" baseline; ``null`` until the first non-empty
   *  inventory arrives. Lives in the store because the panel unmounts
   *  while a preview is open. */
  artifactBaseline: Set<string> | null;
  /** Artifact paths already previewed; clears the new-file marker. */
  viewedArtifactPaths: Set<string>;
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
  /** Record the first non-empty artifact inventory as the new-marker
   *  baseline. Later arrivals are compared against it. */
  observeArtifactInventory: (keys: string[]) => void;
}

export const useFilePreviewStore = create<FilePreviewState>((set, get) => ({
  file: null,
  scope: "shared",
  sessionKey: null,
  splitRatio: 0.72,
  workspaceCollapsed: false,
  fullscreen: false,
  artifactBaseline: null,
  viewedArtifactPaths: new Set<string>(),
  open: (file, scope = "shared", sessionKey = null) =>
    set((s) => {
      const key = file.absolute_path || file.path || file.name;
      const viewedArtifactPaths = new Set(s.viewedArtifactPaths);
      viewedArtifactPaths.add(key);
      return { file, scope, sessionKey, fullscreen: false, viewedArtifactPaths };
    }),
  close: () => set({ file: null, fullscreen: false }),
  setSplitRatio: (splitRatio) => set({ splitRatio }),
  setWorkspaceCollapsed: (workspaceCollapsed) => set({ workspaceCollapsed }),
  toggleWorkspaceCollapsed: () =>
    set((s) => ({ workspaceCollapsed: !s.workspaceCollapsed })),
  setFullscreen: (fullscreen) => set({ fullscreen }),
  toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),
  observeArtifactInventory: (keys) => {
    if (get().artifactBaseline !== null || keys.length === 0) return;
    set({ artifactBaseline: new Set(keys) });
  },
}));
