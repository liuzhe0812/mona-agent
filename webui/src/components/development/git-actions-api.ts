import { developmentRequest } from "@/lib/development-api";

export type GitActionKind = "stage" | "commit" | "push" | "create_branch" | "switch_branch" | "commit_and_push" | "commit_and_switch";
export type GitActionStatus = "prepared" | "running" | "succeeded" | "failed" | "unknown" | "acknowledged";
export interface GitAction {
  id: string; sessionId: string; projectId: string; kind: GitActionKind;
  paths: string[]; message: string; branch: string; expectedHead: string | null;
  remote: string; targetBranch: string; destination: string;
  status: GitActionStatus; phase: string; reason: string; commit: string | null;
  exitCode: number | null; createdAt: string; finishedAt?: string;
  steps: { phase: string; status: string; startedAt: string }[];
  errorCode?: string; affectedPaths?: string[]; includeUnstaged?: boolean;
}
export interface GitActionContext {
  head: string | null; branch: string; writable: boolean;
  files: { path: string; status: string }[];
  remotes: string[]; defaultRemote: string; defaultBranch?: string;
}
export interface GitBranchContext {
  branch: string;
  head: string | null;
  branches: string[];
  pendingAction: GitAction | null;
}
export interface GitActionRequest {
  requestId: string; kind: GitActionKind; paths: string[]; message: string; remote: string; branch: string;
  includeUnstaged?: boolean; contextToken?: string;
}
export interface GitCommitPreview extends GitActionContext {
  identity: { name: string; email: string }; trackingBranch: string | null; ahead: number; behind: number;
  canPush: boolean; stagedCount: number; unstagedCount: number; additions: number; deletions: number;
  contextToken: string; includeUnstaged: boolean;
  files: { path: string; status: string; additions: number; deletions: number; staged: boolean; unstaged: boolean }[];
}
export interface GitGraphCommit { hash: string; parents: string[]; refs: { name: string; kind: "branch" | "tag" | "remote" | "head" }[]; subject: string; authorName: string | null; authoredAtMs: number | null }
export interface GitCommitDetail { commit: GitGraphCommit; body: string; files: { path: string; status: string; additions: number; deletions: number }[]; diff: string }
const base = (session: string) => `/sessions/${encodeURIComponent(session)}/git-actions`;
export const gitActionsApi = {
  context: (session: string, refresh = false) => developmentRequest<GitActionContext>(`${base(session)}/context${refresh ? "?refresh=true" : ""}`),
  branches: (session: string) => developmentRequest<GitBranchContext>(`${base(session)}/branches`),
  preview: (session: string, includeUnstaged = true) => developmentRequest<GitCommitPreview>(`${base(session)}/preview?includeUnstaged=${includeUnstaged}`),
  generateMessage: (session: string, includeUnstaged: boolean, contextToken: string) => developmentRequest<{ message: string }>(`${base(session)}/generate-message`, "POST", { includeUnstaged, contextToken }),
  graph: (session: string, skip = 0) => developmentRequest<{ commits: GitGraphCommit[]; hasMore: boolean }>(`${base(session)}/graph?skip=${skip}`),
  commitDetail: (session: string, hash: string, path?: string) => developmentRequest<GitCommitDetail>(`${base(session)}/commits/${encodeURIComponent(hash)}${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  recent: (session: string) => developmentRequest<GitAction[]>(base(session)),
  prepare: (session: string, request: GitActionRequest) => developmentRequest<GitAction>(`${base(session)}/prepare`, "POST", request),
  get: (session: string, operation: string) => developmentRequest<GitAction>(`${base(session)}/${encodeURIComponent(operation)}`),
  execute: (session: string, operation: string) => developmentRequest<GitAction>(`${base(session)}/${encodeURIComponent(operation)}/execute`, "POST", { confirmed: true }),
  acknowledge: (session: string, operation: string) => developmentRequest<GitAction>(`${base(session)}/${encodeURIComponent(operation)}/acknowledge`, "POST", { confirmed: true }),
};
