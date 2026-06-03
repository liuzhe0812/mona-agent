import { create } from "zustand";

interface WorkspaceState {
  workspacePath: string;
  setWorkspacePath: (path: string) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  workspacePath: "",
  setWorkspacePath: (workspacePath) => set({ workspacePath }),
}));

export function resolveToAbsolutePath(path: string, workspacePath: string): string {
  if (!path) return path;
  const normalized = path.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//i.test(normalized) || normalized.startsWith("/")) return path;
  if (!workspacePath) return path;
  const ws = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${ws}/${normalized}`;
}
