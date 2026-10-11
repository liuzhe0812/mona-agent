import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { GitActionKind } from "./git-actions-api";

export interface GitActionDraft { kind: GitActionKind; paths: string[]; message: string; remote: string; branch: string }
export const EMPTY_GIT_DRAFT: GitActionDraft = { kind: "commit", paths: [], message: "", remote: "", branch: "" };
export const useGitActionDrafts = create<{
  drafts: Record<string, GitActionDraft>;
  update: (session: string, change: Partial<GitActionDraft>) => void;
}>()(persist((set) => ({
  drafts: {},
  update: (session, change) => set((state) => ({ drafts: { ...state.drafts, [session]: { ...EMPTY_GIT_DRAFT, ...state.drafts[session], ...change } } })),
}), { name: "mona.development.git-drafts.v1", storage: createJSONStorage(() => localStorage) }));
