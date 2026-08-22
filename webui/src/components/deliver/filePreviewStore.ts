import { create } from "zustand";
import type { DeliveredFile } from "@/lib/types";

export type PreviewScope = "shared" | "project" | "room";

/** Normalize an artifact path for tombstone matching: forward slashes only,
 *  so Windows/POSIX separator mixes still compare equal. */
export function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** True when ``key`` is covered by a deletion tombstone — exact match for
 *  trashed files, prefix match for anything inside a trashed directory. */
export function isArtifactTombstoned(
  key: string,
  tombstones: Set<string>,
): boolean {
  const k = normalizeArtifactPath(key);
  for (const t of tombstones) {
    if (k === t || k.startsWith(`${t}/`)) return true;
  }
  return false;
}

interface FilePreviewState {
  file: DeliveredFile | null;
  /** Preview scope: ``shared`` resolves under the active Agent output;
   *  ``project`` resolves under the session's bound workspace;
   *  ``room`` resolves through the room's explicit artifact reference. */
  scope: PreviewScope;
  /** Websocket session key that identifies the owning Agent/project view. */
  sessionKey: string | null;
  /** Required when ``scope === "room"``: the room id. */
  roomId: string | null;
  splitRatio: number;
  /** Whether the workspace (right) panel is collapsed by the user. */
  workspaceCollapsed: boolean;
  /** Whether the in-pane preview is expanded to application-fullscreen. */
  fullscreen: boolean;
  /** Directory expansion state, isolated by Agent/project/room owner. */
  treeCollapsedByOwner: Record<string, string[]>;
  /** Directory paths already initialized with the collapsed-by-default rule. */
  treeExpansionInitializedByOwner: Record<string, string[]>;
  /** Artifact paths present when the panel inventory was first observed.
   *  This is the "not new" baseline; ``null`` until the first non-empty
   *  inventory arrives. Lives in the store because the panel unmounts
   *  while a preview is open. */
  artifactBaseline: Set<string> | null;
  /** Artifact paths already previewed; clears the new-file marker. */
  viewedArtifactPaths: Set<string>;
  /** Normalized absolute paths (or directory prefixes) moved to the system
   *  recycle bin. Message events are immutable history, so without this the
   *  session section would resurrect trashed files on every remount. A file
   *  visible in the latest authoritative scan is NOT hidden (re-created). */
  deletedArtifactPaths: Set<string>;
  open: (
    file: DeliveredFile,
    scope?: PreviewScope,
    sessionKey?: string | null,
    roomId?: string | null,
  ) => void;
  close: () => void;
  setSplitRatio: (ratio: number) => void;
  setWorkspaceCollapsed: (collapsed: boolean) => void;
  toggleWorkspaceCollapsed: () => void;
  toggleTreeDirectory: (ownerKey: string, path: string) => void;
  initializeTreeDirectories: (ownerKey: string, paths: string[]) => void;
  setFullscreen: (fullscreen: boolean) => void;
  toggleFullscreen: () => void;
  /** Record the first non-empty artifact inventory as the new-marker
   *  baseline. Later arrivals are compared against it. */
  observeArtifactInventory: (keys: string[]) => void;
  /** Reset transient new-file markers when the owner context changes. */
  resetArtifactInventory: () => void;
  /** Merge keys into the new-marker baseline — called when the panel
   *  unmounts because anything it displayed has been seen. */
  markArtifactsViewed: (keys: string[]) => void;
  /** Tombstone a trashed file or directory (normalized inside). */
  markArtifactDeleted: (path: string) => void;
}

export const useFilePreviewStore = create<FilePreviewState>((set, get) => ({
  file: null,
  scope: "shared",
  sessionKey: null,
  roomId: null,
  splitRatio: 0.72,
  workspaceCollapsed: false,
  fullscreen: false,
  treeCollapsedByOwner: {},
  treeExpansionInitializedByOwner: {},
  artifactBaseline: null,
  viewedArtifactPaths: new Set<string>(),
  deletedArtifactPaths: new Set<string>(),
  open: (file, scope = "shared", sessionKey = null, roomId = null) =>
    set((s) => {
      const key = file.absolute_path || file.path || file.name;
      const viewedArtifactPaths = new Set(s.viewedArtifactPaths);
      viewedArtifactPaths.add(key);
      return { file, scope, sessionKey, roomId, fullscreen: false, viewedArtifactPaths };
    }),
  // Owner context belongs to the preview, not to the panel that happens to
  // be mounted. Clearing it on close prevents a later shared/project preview
  // from accidentally inheriting an old session or room query parameter.
  close: () =>
    set({
      file: null,
      scope: "shared",
      sessionKey: null,
      roomId: null,
      fullscreen: false,
    }),
  setSplitRatio: (splitRatio) => set({ splitRatio }),
  setWorkspaceCollapsed: (workspaceCollapsed) => set({ workspaceCollapsed }),
  toggleWorkspaceCollapsed: () =>
    set((s) => ({ workspaceCollapsed: !s.workspaceCollapsed })),
  toggleTreeDirectory: (ownerKey, path) =>
    set((s) => {
      const current = new Set(s.treeCollapsedByOwner[ownerKey] ?? []);
      if (current.has(path)) current.delete(path);
      else current.add(path);
      return {
        treeCollapsedByOwner: {
          ...s.treeCollapsedByOwner,
          [ownerKey]: [...current],
        },
      };
    }),
  initializeTreeDirectories: (ownerKey, paths) =>
    set((s) => {
      if (paths.length === 0) return s;
      const initialized = new Set(s.treeExpansionInitializedByOwner[ownerKey] ?? []);
      const collapsed = new Set(s.treeCollapsedByOwner[ownerKey] ?? []);
      let changed = false;
      for (const path of paths) {
        if (initialized.has(path)) continue;
        initialized.add(path);
        collapsed.add(path);
        changed = true;
      }
      if (!changed) return s;
      return {
        treeCollapsedByOwner: {
          ...s.treeCollapsedByOwner,
          [ownerKey]: [...collapsed],
        },
        treeExpansionInitializedByOwner: {
          ...s.treeExpansionInitializedByOwner,
          [ownerKey]: [...initialized],
        },
      };
    }),
  setFullscreen: (fullscreen) => set({ fullscreen }),
  toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),
  observeArtifactInventory: (keys) => {
    if (get().artifactBaseline !== null || keys.length === 0) return;
    set({ artifactBaseline: new Set(keys) });
  },
  resetArtifactInventory: () =>
    set({ artifactBaseline: null, viewedArtifactPaths: new Set<string>() }),
  markArtifactsViewed: (keys) => {
    if (keys.length === 0) return;
    const next = new Set(get().artifactBaseline ?? []);
    for (const k of keys) next.add(k);
    set({ artifactBaseline: next });
  },
  markArtifactDeleted: (path) =>
    set((s) => {
      const next = new Set(s.deletedArtifactPaths);
      next.add(normalizeArtifactPath(path));
      return { deletedArtifactPaths: next };
    }),
}));
