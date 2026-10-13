import { getGatewayHttpBase } from "@/lib/api";
import { httpFetch } from "@/lib/tauri";
import { nativeProvidersChanged } from "@/lib/native-provider-state";
import type { SettingsPayload } from "@/lib/types";

export type ExecutorId = "mona" | "codex" | "claude" | "codebuddy";
export type DevelopmentPermissionMode = "ask" | "auto" | "full_access";
export type RunStatus = "queued" | "preparing" | "running" | "waiting_user" | "waiting_children" | "interrupting" | "interrupted" | "succeeded" | "failed" | "unknown" | "recovering" | "closed_unknown";
export interface DevProject { id: string; rootPath: string; displayName: string; lastOpenedAt: string; pinned?: boolean; removed?: boolean; revision?: number }
export interface DevRun { id: string; requestId?: string; sessionId: string; executor: ExecutorId; status: RunStatus; revision: number; errorCode?: string; createdAt: string; startedAt?: string | null; finishedAt?: string | null; requestMessageId?: string; resultMessageId?: string | null }
export interface DevSession {
  id: string; projectId: string; title: string; executor: ExecutorId; model: string | null;
  modelProvider?: string | null; modelReasoningEffort?: string | null;
  readonly: boolean; parentSessionId: string | null; pinned: boolean; archived: boolean;
  permissionMode?: DevelopmentPermissionMode;
  forkSource?: DevSessionForkSource;
  revision: number; updatedAt: string; latestRun?: DevRun | null;
}
export interface DevSessionForkSource {
  sourceSessionId: string; sourceMessageId: string; sourceTitle: string; requestId: string; messageCount: number;
}
export interface ToolCall { id: string; function: { name: string; arguments: string } }
export interface DevMessage {
  media?: { kind: "image" | "audio" | "video" | "file"; url: string; name?: string }[];
  sourceKind?: string; childSessionId?: string;
  id: string; role: string; content: string; truncated: boolean; runId?: string;
  name?: string; toolCallId?: string | null; toolCalls: ToolCall[]; queued: boolean; timestamp?: string; authorId?: ExecutorId;
}
export interface DevInput { id: string; messageId: string; runId: string; state: string; revision: number; intent?: "steering" | "follow_up";
  source?: (DevelopmentSendAttachments & { content: string }) | null; }
export interface DevEvent { id: string; sequence: number; type: string; runId: string | null; timestamp?: string; payload: Record<string, unknown> }
export interface DevDecision { id: string; sessionId: string; runId: string; kind: "permission" | "question";
  parentSessionId?: string; taskTitle?: string;
  details: { command?: string; cwd?: string; reason?: string; toolName?: string; similarCommandPrefix?: string[];
    questions?: { id: string; question: string; options: { label: string }[] }[] } }
export interface DevReviewSource { path: string; version: string }
export interface DevReviewSourceState {
  collaborationId: string; parentSessionId: string; state: "unchanged" | "changed" | "unavailable";
  path: string | null; baselineVersion: string | null; currentVersion: string | null; checkedAt: string; reason: string;
}
export interface DevCollaboration { id: string; parentSessionId: string; childSessionId: string; requestId: string; progress?: string | null;
  title?: string; createdAt?: string; parentRunId?: string | null; required?: boolean; resultReceivedByRunId?: string | null;
  executor: ExecutorId; goal: string; expectedOutput: string; readonly: boolean; state: string;
  returnMessageId: string | null; sourceDiffSha: string | null; latestRun: DevRun | null;
  reviewSource?: DevReviewSource | null;
  followUp?: { requestId: string; run: DevRun | null; input: DevInput | null } | null; }
export type NativeExecutorId = Exclude<ExecutorId, "mona">;
export interface ExecutorSettings {
  revision: string;
  values: Record<string, string | null>;
  credentialPresent: Record<string, boolean>;
  enabledEngines?: NativeExecutorId[];
}
export interface NativeProbe { state: string; reason: string; version?: string | null; sdkVersion?: string | null;
  executable?: string | null; source?: string | null; stage?: string; errorCode?: string | null; nextAction?: string;
  authentication?: string; authMode?: "unknown" | "chatgpt" | "api_key"; protocolVerified?: boolean; isolationVerified?: boolean; models?: string[];
  modelCatalogState?: "unknown" | "ready" | "empty" | "unavailable"; modelDetails?: DevModel[]; defaultModel?: string | null }
export interface NativeLoginStatus { loginId: string | null; state: "idle" | "starting" | "waiting" | "cancelling" | "succeeded" | "cancelled" | "failed" | "unknown"; authUrl: string; reason: string }
export interface MessageSlice { messageId: string; content: string; sha256: string; offset: number; nextOffset: number | null; totalCharacters: number }
export interface DevNativeBinding { id: string; turnHistory: boolean; steering?: boolean; hostSubagents?: boolean; replacesBindingId: string | null; replacementReason: "history_missing" | "user_requested" | "collaboration_updated" | null }
export interface DevPlan { runId: string; explanation?: string; issue?: string; plan: { step: string; status: "pending" | "in_progress" | "completed" }[] }
export interface DevBrowserBinding { id: string; tabId: string; origin: string }
export interface DevSnapshot {
  watchVersion?: string; moreEvents?: boolean;
  session: DevSession; messages: DevMessage[]; before: number | null; messageCount: number;
  runs: DevRun[]; events: DevEvent[]; eventCursor: number; pendingInputs: DevInput[];
  live: { runId: string; content: string } | null;
  pendingDecisions?: DevDecision[];
  nativeBinding?: DevNativeBinding | null;
  plan?: DevPlan | null;
  browserBinding?: DevBrowserBinding | null;
}
export interface DevModel { id: string; label: string; provider?: string; providerLabel?: string; model?: string; preset?: boolean;
  engine?: "mona" | "codex" | "claude";
  isBuiltin?: boolean; description?: string | null; contextWindow?: number | null; reasoningEfforts?: string[]; reasoningEffort?: string | null }
export interface NativeAccountUsage {
  revision: number;
  accountKey?: string | null;
  connected: boolean; email: string | null; planType: string | null;
  limits: { limitId?: string | null; limitName?: string | null;
    primary?: { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null } | null;
    secondary?: { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null } | null }[];
  credits: { balance: string | null; hasCredits: boolean; unlimited: boolean } | null;
  rateLimitReachedType?: string | null;
  availableResets: number | null; resetCreditsExpireAt?: number | null; fetchedAt: number | null; error: string | null;
}
export interface DevExecutor { id: ExecutorId; name: string; available: boolean; reason: string; nextAction?: string;
  enabled?: boolean; programAvailable?: boolean;
  detection?: string; executable?: string; probe?: NativeProbe; models: DevModel[] }
export function isCodeBuddyConnected(executor?: DevExecutor): boolean {
  const probe = executor?.probe;
  return !!executor && (executor.programAvailable ?? executor.available)
    && probe?.protocolVerified === true && probe.authentication === "ready"
    && probe.modelCatalogState === "ready";
}
export interface EngineInstallJob {
  id: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  stage: string;
  downloadedBytes: number;
  totalBytes: number;
  error?: string | null;
}
export interface EngineResource {
  executor: NativeExecutorId;
  source: string;
  executable: string | null;
  systemAvailable: boolean;
  systemExecutable?: string | null;
  systemVersion?: string | null;
  systemReason?: string;
  installed: boolean;
  managedInstalled: boolean;
  managedExecutable?: string | null;
  managedVersion?: string | null;
  canDelete?: boolean;
  canPrepare: boolean;
  canUpdate: boolean;
  repairRequired: boolean;
  explicitPath: boolean;
  packRef: string | null;
  version: string | null;
  installedVersion: string | null;
  downloadBytes: number;
  reason: string;
  catalogError?: string | null;
  job: EngineInstallJob | null;
}
export interface EngineResources { components: EngineResource[]; catalogAvailable: boolean }
export interface DirectoryEntry { name: string; path: string; kind: "directory" | "file" | "link" }
export interface FileDocument { path: string; content: string; sha256: string; bom: boolean;
  fileActivity?: { available: boolean; tasks: { sessionId: string; title: string }[]; checkedAt: string | null; partial: boolean }; }
export interface GitSummary { available: boolean; reasonCode?: "git_unavailable" | "not_repository"; reason?: string; branch?: string; count?: number;
  trackingBranch?: string | null; ahead?: number; behind?: number; canPush?: boolean;
  additions?: number; deletions?: number; binaryFiles?: number; untrackedFiles?: number; statsScope?: string;
  files: { path: string; status: string; previousPath?: string }[] }
export interface ProjectResources { rules: { path: string; sha256: string }[]; skills: { name: string; description: string; path: string }[]; issues: string[] }
export interface DevelopmentSendAttachments { docPaths?: string[]; documentNames?: string[] }

export class DevelopmentApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = "DevelopmentApiError"; }
}

const READ_RETRY_DELAYS = [250, 750];

async function request<T>(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    let response: Response | undefined;
    try {
      const base = await getGatewayHttpBase();
      response = await httpFetch(`${base}/api/development${path}`, {
        method, signal, headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const isJson = response.headers.get("content-type")?.includes("application/json");
      const data = isJson ? await response.json() : null;
      if (!response.ok || !isJson) {
        const message = data?.error?.message ?? (response.status === 404
          ? "当前开发服务尚未加载，请正常重启 dev 后重试。"
          : method === "GET" ? "无法读取开发数据，请稍后重试。"
            : "无法连接开发服务，请检查 Mona 运行状态。操作未自动重试。");
        throw new DevelopmentApiError(response.status, data?.error?.code ?? "service_unavailable", message);
      }
      return data as T;
    } catch (cause) {
      const transient = !response || cause instanceof DevelopmentApiError
        && [502, 503, 504].includes(cause.status) && ["service_unavailable", "read_timeout"].includes(cause.code);
      const delay = READ_RETRY_DELAYS[attempt];
      if (method !== "GET" || !transient || delay === undefined || signal?.aborted
        || cause instanceof Error && cause.name === "AbortError") throw cause;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("The operation was aborted.", "AbortError")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, delay);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}
export { request as developmentRequest };
const id = encodeURIComponent;
const nativeSourcePath = (projectId: string | undefined, executor: ExecutorId) => projectId ? `/projects/${id(projectId)}/executors/${executor}` : `/provider-executors/${executor}`;
export const developmentApi = {
  accountUsage: (executor: ExecutorId, signal?: AbortSignal) => request<NativeAccountUsage>(`/provider-executors/${executor}/usage`, "GET", undefined, signal),
  accountUsageChanges: (executor: ExecutorId, after: number, signal?: AbortSignal) => request<{ revision: number; identityChanged: boolean }>(`/provider-executors/${executor}/usage/changes?after=${after}`, "GET", undefined, signal),
  media: async (projectId: string, path: string): Promise<Blob> => {
    const base = await getGatewayHttpBase();
    const response = await httpFetch(`${base}/api/development/projects/${id(projectId)}/media?path=${id(path)}`);
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new DevelopmentApiError(response.status, data?.error?.code ?? "media_unavailable", data?.error?.message ?? "无法读取此媒体文件。");
    }
    return response.blob();
  },
  reviewDiff: (projectId: string, path: string) => request<{ diff: string; sha256: string; attribution: string; source: DevReviewSource }>(`/projects/${id(projectId)}/review-diff?path=${id(path)}`),
  reviewSource: (sessionId: string, collaborationId: string) => request<DevReviewSourceState>(`/sessions/${id(sessionId)}/collaborations/${id(collaborationId)}/source`),
  inspectCollaborationResult: (sessionId: string, collaborationId: string) => request<DevCollaboration>(`/sessions/${id(sessionId)}/collaborations/${id(collaborationId)}/follow-up`),
  continueCollaborationResult: (session: DevSession, collaborationId: string) => request<DevCollaboration>(`/sessions/${id(session.id)}/collaborations/${id(collaborationId)}/follow-up`, "POST", { revision: session.revision, confirmed: true }),
  collaborationRequest: (sessionId: string, requestId: string) => request<DevCollaboration | null>(`/sessions/${id(sessionId)}/collaboration-requests/${id(requestId)}`),
  bindBrowser: (sessionId: string, tabId: string | null, expectedId: string | null) => request<{ binding: DevBrowserBinding | null }>(`/sessions/${id(sessionId)}/browser`, "PUT", { tabId, expectedId }),
  selectModelSource: (session: DevSession, body: { executor: ExecutorId; model: string | null; provider: string | null; effort?: string | null }) => request<DevSession>(`/sessions/${id(session.id)}/model-source`, "PUT", { revision: session.revision, ...body }),
  selectWorkModelSource: (body: { executor: ExecutorId; model: string; provider?: string; effort?: string | null }) => request<SettingsPayload>("/work-model-source", "PUT", body),
  providerExecutors: () => request<{ executors: DevExecutor[] }>("/provider-executors"),
  collaborations: (sessionId: string) => request<DevCollaboration[]>(`/sessions/${id(sessionId)}/collaborations`),
  capabilities: (projectId?: string) => request<{ executors: DevExecutor[] }>(`/capabilities${projectId ? `?projectId=${id(projectId)}` : ""}`),
  executorSettings: () => request<ExecutorSettings>("/executor-settings"),
  engineResources: (executor: NativeExecutorId, refresh = false) => request<EngineResources>(`/engine-resources?executor=${id(executor)}${refresh ? "&refresh=true" : ""}`),
  prepareExecutor: (executor: NativeExecutorId, packRef: string, repair = false) => request<{ installed: boolean; job: EngineInstallJob | null }>(
    `/executors/${id(executor)}/prepare`, "POST", { packRef, ...(repair ? { repair: true } : {}) },
  ),
  deleteManagedExecutor: (executor: NativeExecutorId, version?: string | null) => request<{ deleted: boolean; warning?: string }>(
    `/executors/${id(executor)}/managed-program`, "DELETE", version === undefined ? {} : { version },
  ),
  executorInstall: (executor: NativeExecutorId, jobId: string) => request<EngineInstallJob>(`/executors/${id(executor)}/install/${id(jobId)}`),
  cancelExecutorInstall: (executor: NativeExecutorId, jobId: string) => request<EngineInstallJob>(`/executors/${id(executor)}/install/${id(jobId)}`, "DELETE"),
  updateExecutorSettings: (settings: ExecutorSettings, values: Record<string, string | null>, enabledEngines?: NativeExecutorId[]) => request<ExecutorSettings>("/executor-settings", "PUT", {
    revision: settings.revision, values, ...(enabledEngines === undefined ? {} : { enabledEngines }),
  }),
  refreshNativeProviders: () => nativeProvidersChanged(),
  probe: (projectId: string | undefined, executor: ExecutorId) => request<NativeProbe>(`${nativeSourcePath(projectId, executor)}/probe`, "POST").then((value) => { nativeProvidersChanged(); return value; }),
  login: (projectId: string | undefined, executor: ExecutorId) => request<NativeLoginStatus>(`${nativeSourcePath(projectId, executor)}/login`, "POST"),
  logout: (executor: ExecutorId) => request<{ ok: boolean }>(`/provider-executors/${executor}/logout`, "POST").then((value) => { nativeProvidersChanged(); return value; }),
  loginStatus: (projectId: string | undefined, executor: ExecutorId) => request<NativeLoginStatus>(`${nativeSourcePath(projectId, executor)}/login`),
  cancelLogin: (projectId: string | undefined, executor: ExecutorId, loginId: string) => request<NativeLoginStatus>(`${nativeSourcePath(projectId, executor)}/login/${id(loginId)}`, "DELETE"),
  switchExecutor: (session: DevSession, executor: ExecutorId, model: string | null = null) => request<DevSession>(`/sessions/${id(session.id)}/executor`, "PUT", { revision: session.revision, executor, model }),
  decide: (sessionId: string, decisionId: string, value: string | Record<string, string[]>) => request(`/sessions/${id(sessionId)}/decisions/${id(decisionId)}`, "POST", { value }),
  closeUnknown: (sessionId: string, runId: string, revision: number, bindingId: string) => request<DevRun>(`/sessions/${id(sessionId)}/runs/${id(runId)}/close-unknown`, "POST", { revision, bindingId, confirmed: true }),
  recover: (sessionId: string, runId: string) => request<DevRun>(`/sessions/${id(sessionId)}/runs/${id(runId)}/recover`, "POST"),
  reconnect: (sessionId: string, revision: number, bindingId: string) => request<DevSession>(`/sessions/${id(sessionId)}/reconnect`, "POST", { revision, bindingId }),
  message: (sessionId: string, messageId: string, offset = 0, sha?: string) => request<MessageSlice>(`/sessions/${id(sessionId)}/messages/${id(messageId)}?offset=${offset}${sha ? `&sha256=${id(sha)}` : ""}`),
  projects: () => request<DevProject[]>("/projects"),
  openProject: (path: string) => request<DevProject>("/projects", "POST", { path }),
  sessions: (projectId: string) => request<DevSession[]>(`/projects/${id(projectId)}/sessions`),
  createSession: (projectId: string, options: Partial<Pick<DevSession, "executor" | "title" | "model" | "modelProvider" | "modelReasoningEffort" | "readonly" | "parentSessionId">> = {}) =>
    request<DevSession>(`/projects/${id(projectId)}/sessions`, "POST", options),
  forkSession: (session: DevSession, messageId: string, requestId: string) =>
    request<DevSession>(`/sessions/${id(session.id)}/fork`, "POST", { revision: session.revision, requestId, messageId }),
  updateSession: (session: DevSession, changes: Partial<Pick<DevSession, "title" | "pinned" | "archived">>) =>
    request<DevSession>(`/sessions/${id(session.id)}`, "PATCH", { revision: session.revision, ...changes }),
  deleteSession: (session: DevSession) =>
    request<{ deleted: string[]; warnings?: string[] }>(`/sessions/${id(session.id)}`, "DELETE", { revision: session.revision }),
  model: (session: DevSession, model: string | null) => request<DevSession>(`/sessions/${id(session.id)}/model`, "PUT", { revision: session.revision, model }),
  permissions: (session: DevSession, mode: DevelopmentPermissionMode, confirmed = false) => request<DevSession>(`/sessions/${id(session.id)}/permissions`, "PUT", { revision: session.revision, mode, confirmed }),
  snapshot: (sessionId: string, after = 0, before?: number, watch?: string) => request<DevSnapshot>(`/sessions/${id(sessionId)}/snapshot?after=${after}${before === undefined ? "" : `&before=${before}`}${watch ? `&watch=${id(watch)}` : ""}`),
  send: (sessionId: string, requestId: string, content: string, intent?: "steering" | "follow_up", attachments?: DevelopmentSendAttachments, targetRunId?: string) => request<{ run?: DevRun; input?: DevInput; queued: boolean; reused?: boolean }>(`/sessions/${id(sessionId)}/send`, "POST", {
    requestId, content, ...(intent ? { intent } : {}),
    ...(targetRunId ? { targetRunId } : {}),
    ...(attachments?.docPaths?.length ? { docPaths: attachments.docPaths } : {}),
    ...(attachments?.documentNames?.length ? { documentNames: attachments.documentNames } : {}),
  }),
  interrupt: (sessionId: string, runId: string) => request<DevRun>(`/sessions/${id(sessionId)}/runs/${id(runId)}/interrupt`, "POST"),
  cancelInput: (sessionId: string, inputId: string) => request(`/sessions/${id(sessionId)}/inputs/${id(inputId)}`, "DELETE"),
  directory: (projectId: string, path = "", offset = 0) => request<{ entries: DirectoryEntry[]; nextOffset: number | null; total: number }>(`/projects/${id(projectId)}/directory?path=${id(path)}&offset=${offset}`),
  file: (projectId: string, path: string) => request<FileDocument>(`/projects/${id(projectId)}/file?path=${id(path)}`),
  saveFile: (projectId: string, file: FileDocument, content: string) => request<FileDocument>(`/projects/${id(projectId)}/file`, "PUT", { path: file.path, expectedSha256: file.sha256, content }),
  git: (projectId: string, refresh = false) => request<GitSummary>(`/projects/${id(projectId)}/git${refresh ? "?refresh=true" : ""}`),
  diff: (projectId: string, path = "") => request<{ diff: string; sha256: string; attribution: string }>(`/projects/${id(projectId)}/diff?path=${id(path)}`),
  resources: (projectId: string) => request<ProjectResources>(`/projects/${id(projectId)}/context`),
};
export const isRunActive = (run?: DevRun | null) => !!run && !["succeeded", "failed", "interrupted", "unknown", "recovering", "closed_unknown"].includes(run.status);
export const executorLabels: Record<ExecutorId, string> = { mona: "Mona Coding", codex: "Codex", claude: "Claude Code", codebuddy: "CodeBuddy" };
export const runLabels: Record<RunStatus, string> = {
  queued: "排队中", preparing: "准备中", running: "执行中", waiting_user: "等待确认", waiting_children: "等待子任务", interrupting: "正在中断",
  interrupted: "已中断", succeeded: "本轮结束", failed: "执行失败", unknown: "状态待核对", recovering: "恢复中", closed_unknown: "已结束 · 结果未确认",
};
