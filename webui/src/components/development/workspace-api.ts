import { developmentRequest, type DevCollaboration, type DevProject, type DevReviewSource, type DevSession, type ExecutorId } from "@/lib/development-api";

export interface SubagentPreset {
  id: string; name: string; description?: string; instructions: string; executor: ExecutorId;
  model: string | null; provider: string | null; effort: string | null;
  readonly: boolean; enabled: boolean; inheritModel?: boolean;
}
export interface SubagentSettings { revision: number; presets: SubagentPreset[] }
const id = encodeURIComponent;
export interface ProjectInfo { repository: string | null; repositoryState: "ready" | "local" | "unavailable"; reason: string }
export const projectApi = {
  info: (project: string) => developmentRequest<ProjectInfo>(`/projects/${id(project)}/info`),
  update: (project: DevProject, changes: Partial<Pick<DevProject, "displayName" | "pinned" | "removed">>) =>
    developmentRequest<DevProject>(`/projects/${id(project.id)}`, "PATCH", { revision: project.revision ?? 0, ...changes }),
  archiveChats: (project: string, sessions: DevSession[]) => developmentRequest<DevSession[]>(`/projects/${id(project)}/archive-chats`, "POST", {
    revisions: Object.fromEntries(sessions.map((session) => [session.id, session.revision])),
  }),
};
export const subagentApi = {
  list: (project: string) => developmentRequest<SubagentSettings>(`/projects/${id(project)}/subagents`),
  save: (project: string, value: SubagentSettings) => developmentRequest<SubagentSettings>(`/projects/${id(project)}/subagents`, "PUT", value),
  run: (session: string, preset: string, requestId: string, goal: string, expectedOutput = "", expectedReadonly?: boolean, reviewSource?: DevReviewSource) =>
    developmentRequest<DevCollaboration>(`/sessions/${id(session)}/subagents/${id(preset)}/run`, "POST", { requestId, goal, expectedOutput, ...(expectedReadonly === undefined ? {} : { expectedReadonly }), ...(reviewSource ? { reviewSource } : {}) }),
};
