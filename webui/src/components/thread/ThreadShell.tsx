import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react";

import { AgentAvatar, resolveAgentDisplayName } from "@/components/room/AgentAvatar";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RoomContextPanel } from "@/components/room/RoomContextPanel";
import { useAgents } from "@/components/room/useAgents";
import {
  ThreadComposer,
  type ComposerAttachment,
  type ComposerModelOption,
} from "@/components/thread/ThreadComposer";
import { ThreadHeader } from "@/components/thread/ThreadHeader";
import { StreamErrorNotice } from "@/components/thread/StreamErrorNotice";
import { ThreadViewport } from "@/components/thread/ThreadViewport";
import { NewChatDashboard } from "@/components/thread/NewChatDashboard";
import { readFileAsDataUrl } from "@/components/doc/office/useDocDrop";
import { DiscussionDialog } from "@/components/discussion/DiscussionDialog";
import { stripConversationCanvasBlocks } from "@/components/canvas/conversation-canvas";
import { useConversationCanvases } from "@/components/canvas/useConversationCanvases";
import { SplitPane } from "@/components/deliver/SplitPane";
import { FilePreviewPanel } from "@/components/deliver/FilePreviewPanel";
import { WorkspacePanel, flattenFilesForDisplay } from "@/components/deliver/WorkspacePanel";
import { ArtifactSidebar, OVERVIEW_TAB_ID, type ArtifactPreviewTab, type ArtifactSidebarTab, type OfficeSidebarTab, type SidebarNewTabKind, type ToolSidebarTab } from "@/components/deliver/ArtifactSidebar";
import {
  OverviewPanel,
  DeliverablesRangeFilter,
  filterDeliverablesByRange,
  type DeliverablesRange,
} from "@/components/deliver/OverviewPanel";
import { SidebarBrowserPanel, type SidebarBrowserController } from "@/components/deliver/SidebarBrowserPanel";
import { useFilePreviewStore, type PreviewScope, isArtifactTombstoned, normalizeArtifactPath } from "@/components/deliver/filePreviewStore";
import { useMonaStream, type SendImage, type SendOptions } from "@/hooks/useMonaStream";
import { usePendingQueue } from "@/hooks/usePendingQueue";
import { useSessionHistory } from "@/hooks/useSessions";
import { useArtifacts } from "@/hooks/useArtifacts";
import { fetchSettings, listSlashCommands, renameArtifact, updateSettings } from "@/lib/api";
import type { ChatSummary, DeliveredFile, DiscussionLaunchOptions, MessageQuote, RoomAgentInfo, SettingsPayload, SlashCommand, UIFileEdit, UIMessage, WorkflowRun } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { normalizeLegacyLongTaskMessages } from "@/lib/thread-display-compat";
import { scrubSubagentUiMessages } from "@/lib/subagent-channel-display";
import { getManagedModelPrices, isTauri, type ManagedModelPrice } from "@/lib/tauri";
import { useClient } from "@/providers/ClientProvider";
import { useScheduleStore } from "@/components/schedule/scheduleStore";
import { deriveTitle } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OfficeSessionState } from "@/components/office/types";
import { closeOfficeSession, createOfficeSession } from "@/lib/office-client";

const ConversationCanvasPanel = lazy(() =>
  import("@/components/canvas/ConversationCanvasPanel").then((module) => ({
    default: module.ConversationCanvasPanel,
  })),
);
const SidebarTerminalPanel = lazy(() =>
  import("@/components/deliver/SidebarLocalTerminal").then((module) => ({
    default: module.SidebarLocalTerminal,
  })),
);
const OfficeEditorHost = lazy(() =>
  import("@/components/office/OfficeEditorHost").then((module) => ({
    default: module.OfficeEditorHost,
  })),
);

const SIDEBAR_WORKSPACE_TAB_ID = "tool:workspace";
const SIDEBAR_BROWSER_TAB_ID = "tool:browser";
const SIDEBAR_TERMINAL_TAB_ID = "tool:terminal";

function isOfficeSessionState(value: unknown): value is OfficeSessionState {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<OfficeSessionState>;
  return (
    typeof session.sessionId === "string"
    && typeof session.displayName === "string"
    && (session.type === "docs" || session.type === "sheets" || session.type === "slides")
    && !!session.version
    && typeof session.version.editorEpoch === "string"
    && typeof session.version.modelRevision === "number"
  );
}

const OFFICE_SESSION_STORAGE_PREFIX = "mona.office.sessions.v1:";

function persistedOfficeSessions(ownerSessionKey: string): OfficeSessionState[] {
  const raw = localStorage.getItem(`${OFFICE_SESSION_STORAGE_PREFIX}${ownerSessionKey}`);
  if (!raw) return [];
  try {
    const sessions = JSON.parse(raw) as unknown;
    return Array.isArray(sessions) ? sessions.filter(isOfficeSessionState) : [];
  } catch {
    return [];
  }
}

function rememberOfficeSession(ownerSessionKey: string, session: OfficeSessionState): void {
  const sessions = persistedOfficeSessions(ownerSessionKey)
    .filter((item) => item.sessionId !== session.sessionId);
  localStorage.setItem(
    `${OFFICE_SESSION_STORAGE_PREFIX}${ownerSessionKey}`,
    JSON.stringify([...sessions, session]),
  );
}

function forgetOfficeSession(ownerSessionKey: string, sessionId: string): void {
  const sessions = persistedOfficeSessions(ownerSessionKey)
    .filter((item) => item.sessionId !== sessionId);
  const key = `${OFFICE_SESSION_STORAGE_PREFIX}${ownerSessionKey}`;
  if (sessions.length > 0) localStorage.setItem(key, JSON.stringify(sessions));
  else localStorage.removeItem(key);
}

function disposeSidebarTerminalSession(sessionId: string) {
  void Promise.all([
    import("@/components/terminal/ipc"),
    import("@/components/terminal/store/terminalStore"),
  ]).then(([ipc, store]) => {
    store.useTerminalStore.getState().terminalRegistry.clearBuffer(sessionId);
    return ipc.shellKill(sessionId);
  }).catch(() => undefined);
}

function projectWebuiThreadMessages(messages: UIMessage[]): UIMessage[] {
  return scrubSubagentUiMessages(normalizeLegacyLongTaskMessages(messages)).map((message) => (
    message.role === "assistant" && message.content
      ? { ...message, content: stripConversationCanvasBlocks(message.content) }
      : message
  ));
}

function isLanguageModel(
  model: NonNullable<SettingsPayload["chat_providers"]>[number]["models"][number],
): boolean {
  if (!model.type) return true;
  return ["chat", "language", "text", "llm"].includes(model.type.toLowerCase());
}

function isDefaultMediaModel(
  settings: SettingsPayload,
  provider: NonNullable<SettingsPayload["chat_providers"]>[number],
  model: NonNullable<SettingsPayload["chat_providers"]>[number]["models"][number],
): boolean {
  return (
    (settings.image_generation?.provider === provider.name && settings.image_generation.model === model.id)
    || (settings.video_generation?.provider === provider.name && settings.video_generation.model === model.id)
  );
}

export function buildComposerProviderOptions(
  settings: SettingsPayload,
  managedPrices: ManagedModelPrice[] = [],
): ComposerModelOption[] {
  const managedPriceByModel = new Map(managedPrices.map((price) => [price.model, price]));
  return (settings.chat_providers ?? [])
    .filter((provider) => provider.configured)
    .slice()
    .sort((a, b) =>
      Number(b.name === settings.agent.provider) - Number(a.name === settings.agent.provider)
      || Number(Boolean(a.is_builtin)) - Number(Boolean(b.is_builtin)),
    )
    .flatMap((provider) => provider.models
      .filter((model) => (
        model.enabled
        && isLanguageModel(model)
        && !isDefaultMediaModel(settings, provider, model)
      ))
      .map((model) => {
        const managedPrice = provider.is_builtin ? managedPriceByModel.get(model.id) : undefined;
        return {
          provider: provider.name,
          providerLabel: provider.label,
          model: model.id,
          label: model.name,
          active: provider.name === settings.agent.provider && model.id === settings.agent.model,
          isBuiltin: provider.is_builtin,
          description: model.description,
          contextWindow: model.context_window,
          recommended: model.recommended,
          tags: model.tags,
          priceTier: model.price_tier,
          reasoningEfforts: model.reasoning_efforts,
          reasoningEffort:
            provider.name === settings.agent.provider && model.id === settings.agent.model
              ? settings.agent.reasoning_effort ?? model.default_reasoning_effort
              : model.default_reasoning_effort,
           inputAmountPerMillion: managedPrice?.input_amount_per_million ?? model.input_amount_per_million,
           cachedInputAmountPerMillion: managedPrice?.cached_input_amount_per_million ?? model.cached_input_amount_per_million,
           outputAmountPerMillion: managedPrice?.output_amount_per_million ?? model.output_amount_per_million,
           promotionLabel: managedPrice?.promotion_label ?? model.promotion_label,
           promotionName: managedPrice?.promotion_name ?? model.promotion_name,
           discountPercent: managedPrice?.discount_percent ?? model.discount_percent,
           originalInputAmountPerMillion:
             managedPrice?.original_input_amount_per_million ?? model.original_input_amount_per_million,
           originalCachedInputAmountPerMillion:
             managedPrice?.original_cached_input_amount_per_million ?? model.original_cached_input_amount_per_million,
           originalOutputAmountPerMillion:
             managedPrice?.original_output_amount_per_million ?? model.original_output_amount_per_million,
         };
      }));
}

function artifactIdentity(file: DeliveredFile): string {
  // Scans use relative paths while live deliveries can use absolute paths.
  return normalizeArtifactPath(
    file.absolute_path ||
    file.artifact_ref?.relative_path ||
    file.path ||
    file.name
  );
}

function isScorePreviewArtifact(file: DeliveredFile): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".abc") || name.endsWith(".atex");
}

function scorePreviewArtifactFromEdit(edit: UIFileEdit): DeliveredFile | null {
  const path = edit.path.trim() || edit.absolute_path?.trim() || "";
  const name = normalizeArtifactPath(path).split("/").pop() || "";
  const lowerName = name.toLowerCase();
  if (!lowerName.endsWith(".abc") && !lowerName.endsWith(".atex")) return null;
  const size = edit.artifact_ref?.size ?? 0;
  return {
    path,
    absolute_path: edit.absolute_path?.trim() || path,
    name,
    size,
    size_human: size > 0 ? `${size} B` : "",
    mime: edit.artifact_ref?.mime || (lowerName.endsWith(".abc") ? "text/vnd.abc" : "text/plain"),
    artifact_ref: edit.artifact_ref,
  };
}

function artifactTabId(file: DeliveredFile): string {
  return `file:${artifactIdentity(file)}`;
}

/** Build the user-visible output root without changing valid dotted Agent IDs. */
export function buildSharedOutputDir(
  workspacePath: string,
  directAgentId?: string | null,
): string | null {
  const ws = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!ws) return null;
  const rawAgentId = directAgentId?.trim() || "mona";
  const agentId = rawAgentId.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return `${ws}/agent-workspaces/${agentId}/output`;
}

function preserveDeliveredFiles(oldMessages: UIMessage[], newMessages: UIMessage[]): UIMessage[] {
  const deliveredByAssistantIdx = new Map<number, DeliveredFile[]>();
  let assistantIdx = 0;
  for (const m of oldMessages) {
    if (m.role === "assistant" && m.kind !== "trace") {
      if (m.deliveredFiles?.length) {
        deliveredByAssistantIdx.set(assistantIdx, m.deliveredFiles);
      }
      assistantIdx++;
    }
  }
  if (deliveredByAssistantIdx.size === 0) return newMessages;
  const result = [...newMessages];
  let newAssistantIdx = 0;
  for (let i = 0; i < result.length; i++) {
    if (result[i].role === "assistant" && result[i].kind !== "trace") {
      const files = deliveredByAssistantIdx.get(newAssistantIdx);
      if (files) {
        result[i] = { ...result[i], deliveredFiles: files };
      }
      newAssistantIdx++;
    }
  }
  return result;
}

/** Merge a live ``workflow_run_updated`` snapshot into the message list: the
 *  run card stays at the position where the run first appeared and re-renders
 *  in place, like a pinned status message in a group chat. */
function upsertWorkflowRunMessage(
  messages: UIMessage[],
  run: WorkflowRun,
): UIMessage[] {
  const index = messages.findIndex(
    (m) => m.kind === "workflowRun" && m.workflowRunId === run.id,
  );
  if (index >= 0) {
    const next = [...messages];
    next[index] = { ...next[index], payload: run };
    return next;
  }
  return [
    ...messages,
    {
      id: `workflow-run-${run.id}`,
      role: "assistant",
      kind: "workflowRun",
      content: "",
      workflowRunId: run.id,
      payload: run,
      createdAt: Date.now(),
    },
  ];
}

function latestRoomRun(
  messages: UIMessage[],
  kind: "discussion" | "workflowRun",
): WorkflowRun | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.kind !== kind) continue;
    const run = message.payload as Partial<WorkflowRun> | null;
    if (
      run
      && typeof run.id === "string"
      && typeof run.status === "string"
      && run.workflow
      && Array.isArray(run.workflow.steps)
      && run.steps
      && typeof run.steps === "object"
    ) {
      return run as WorkflowRun;
    }
  }
  return null;
}

interface ThreadShellProps {
  session: ChatSummary | null;
  title: string;
  onToggleSidebar: () => void;
  onCollapseSessionList?: () => void;
  sessionListOpen?: boolean;
  onGoHome?: () => void;
  onOpenSSH?: () => void;
  onOpenDb?: () => void;
  onCreateNote?: () => void;
  recentSessions?: ChatSummary[];
  onSelectSession?: (key: string) => void;
  onCreateChat?: (workspace?: string | null) => Promise<string | null>;
  onBranchChat?: (sourceChatId: string, assistantOrdinal: number, sourceTaskId?: string) => Promise<string | null>;
  /** Direct Agent selected before a chat exists; persisted on first send. */
  pendingDirectAgentId?: string | null;
  /** Display name carried from the summon panel while the agent list refreshes. */
  pendingDirectAgentName?: string | null;
  onCreateDirectChat?: (agentId: string, workspace?: string | null) => Promise<string | null>;
  onTurnEnd?: () => void;
  queuedPrompt?: QueuedPrompt | null;
  onQueuedPromptConsumed?: (id: string) => void;
  showHeader?: boolean;
  onModelNameChange?: (modelName: string | null) => void;
  onOpenSettings?: (section?: string) => void;
  onOpenExpertLibrary?: () => void;
  sidebarBrowser?: SidebarBrowserController;
  onEnsureSidebarBrowser?: () => void;
  browserHostVisible?: boolean;
  onSidebarBrowserVisibilityChange?: (visible: boolean) => void;
  onRightWorkspaceMaximizedChange?: (maximized: boolean) => void;
}

function toModelBadgeLabel(modelName: string | null): string | null {
  if (!modelName) return null;
  const trimmed = modelName.trim();
  if (!trimmed) return null;
  return trimmed;
}

interface PendingFirstMessage {
  content: string;
  images?: SendImage[];
  options?: SendOptions;
}

interface QueuedPrompt {
  id: string;
  content: string;
  origin?: "profile_advice";
  profileAdviceId?: string;
}

interface AttachedDocument {
  name: string;
  path: string;
  size?: number;
}

export function ThreadShell({
  session,
  title,
  onToggleSidebar,
  onCollapseSessionList,
  sessionListOpen = true,
  onOpenSSH,
  onOpenDb,
  onCreateNote,
  recentSessions = [],
  onSelectSession,
  onCreateChat,
  onBranchChat,
  pendingDirectAgentId = null,
  pendingDirectAgentName = null,
  onCreateDirectChat,
  onTurnEnd,
  queuedPrompt,
  onQueuedPromptConsumed,
  showHeader = true,
  onModelNameChange,
  onOpenSettings,
  onOpenExpertLibrary,
  sidebarBrowser,
  onEnsureSidebarBrowser,
  browserHostVisible = true,
  onSidebarBrowserVisibilityChange,
  onRightWorkspaceMaximizedChange,
}: ThreadShellProps) {
  const { t, i18n } = useTranslation();
  const chatId = session?.chatId ?? null;
  const canvasRouteMessageRef = useRef<(content: string) => {
    content: string;
    displayContent?: string;
    canvasId?: string;
    canvasPath?: string;
    canvasPathReady?: Promise<string | undefined>;
  }>((content) => ({ content }));
  const activeOfficeContextRef = useRef<Pick<
    SendOptions,
    "officeSessionId" | "officeDocumentType" | "officeDisplayName"
  > | null>(null);
  const historyKey = session?.key ?? null;
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(
    session?.workspace ?? null,
  );
  useEffect(() => {
    setSelectedWorkspace(session?.workspace ?? null);
  }, [session?.key]);
  const {
    messages: historical,
    loading,
    error: historyError,
    missing: historyMissing,
    hasPendingToolCalls,
    refresh: refreshHistory,
    version: historyVersion,
  } = useSessionHistory(historyKey);
  const { client, modelName, token } = useClient();
  const conversation = session?.conversation ?? null;
  const [booting, setBooting] = useState(false);
  const [attachedDocuments, setAttachedDocuments] = useState<AttachedDocument[]>([]);
  const [documentsUploading, setDocumentsUploading] = useState(false);
  const [documentUploadError, setDocumentUploadError] = useState<string | null>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [providerOptions, setProviderOptions] = useState<ComposerModelOption[]>([]);
  const managedModelPricesRef = useRef<ManagedModelPrice[]>([]);
  // Whether the active model preset accepts image input. ``supports_vision``
  // is tri-state server-side; only an explicit ``false`` disables upload.
  const [imageInputEnabled, setImageInputEnabled] = useState(true);
  /** Context window of the active model preset. Drives the composer usage
   * pill; falls back to the model catalogue value when unset. */
  const [contextWindowTokens, setContextWindowTokens] = useState<number | null>(null);
  const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0);
  const [focusMessage, setFocusMessage] = useState<{ id: string; requestId: number } | null>(null);
  const [quote, setQuote] = useState<MessageQuote | null>(null);
  const [branchCandidate, setBranchCandidate] = useState<{
    assistantOrdinal: number;
    taskId?: string;
  } | null>(null);
  const [branching, setBranching] = useState(false);
  const pendingFirstRef = useRef<PendingFirstMessage | null>(null);
  const pendingFirstWorkspaceRouteChatRef = useRef<string | null>(null);
  const consumedQueuedPromptRef = useRef<string | null>(null);
  const messageCacheRef = useRef<Map<string, UIMessage[]>>(new Map());
  /** Last chatId we associated with the in-memory thread (for cache-on-switch). */
  const prevChatIdForCacheRef = useRef<string | null>(null);
  /** Skip one message-cache write right after chatId changes (messages may not match yet). */
  const skipLayoutCacheRef = useRef(false);
  const appliedHistoryVersionRef = useRef<Map<string, number>>(new Map());
  const pendingCanonicalHydrateRef = useRef<Set<string>>(new Set());
  const sessionKeyByChatIdRef = useRef<Map<string, string>>(new Map());

  const initial = useMemo(() => {
    if (!chatId) return historical;
    return messageCacheRef.current.get(chatId) ?? historical;
  }, [chatId, historical]);

  // Refresh signal bumped on every turn_end and on chat switch; consumed
  // by ``useArtifacts`` so the shared-output scan re-runs and converges
  // with the in-flight ``deliver_file`` / ``file_edit`` events.
  const [artifactsRefreshSignal, setArtifactsRefreshSignal] = useState(0);
  const handleTurnEnd = useCallback(() => {
    setArtifactsRefreshSignal((value) => value + 1);
    onTurnEnd?.();
  }, [onTurnEnd]);
  const {
    messages,
    isStreaming,
    isAwaitingModelResponse,
    isCompacting,
    stopping,
    runStartedAt,
    goalState,
    taskPlan,
    currentTaskId,
    send,
    inject,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMonaStream(chatId, initial, hasPendingToolCalls, handleTurnEnd);

  const pendingQueue = usePendingQueue();
  const computerUseActive = useMemo(() => {
    if (!isStreaming) return false;
    const runStartedAtMs = runStartedAt === null ? null : runStartedAt * 1000;
    return messages.some((message) => {
      const belongsToCurrentRun = currentTaskId && message.taskId
        ? message.taskId === currentTaskId
        : runStartedAtMs !== null && message.createdAt >= runStartedAtMs;
      return belongsToCurrentRun
        && message.toolEvents?.some((event) => event.name === "computer_act");
    });
  }, [currentTaskId, isStreaming, messages, runStartedAt]);

  useEffect(() => {
    setAttachedDocuments([]);
    setDocumentUploadError(null);
    setDocumentsUploading(false);
    setQuote(null);
    setBranchCandidate(null);
  }, [chatId]);
  useEffect(() => setFocusMessage(null), [historyKey]);

  useEffect(() => client.onDocUploadResult((result) => {
    if (result.chatId !== chatId) return;
    setDocumentsUploading(false);
    if (!result.ok) {
      setDocumentUploadError(result.error ?? "文件上传失败");
      return;
    }
    setAttachedDocuments((current) => [
      ...current,
      ...(result.files ?? []).map((file) => ({
        name: file.name,
        path: file.path,
        size: file.size,
      })),
    ]);
    setDocumentUploadError(null);
  }), [chatId, client]);

  const addDocuments = useCallback(async (files: ComposerAttachment[]) => {
    if (!chatId || files.length === 0) return;
    setDocumentsUploading(true);
    setDocumentUploadError(null);
    try {
      client.sendDocUpload(chatId, await Promise.all(files.map(async (file) => {
        if ("localPath" in file) return { name: file.name, local_path: file.localPath };
        const localPath = (file as File & { path?: unknown }).path;
        if (typeof localPath === "string" && /^(?:[A-Za-z]:[\\/]|\/)/.test(localPath)) {
          return { name: file.name, local_path: localPath };
        }
        return { name: file.name, data_url: await readFileAsDataUrl(file) };
      })));
    } catch (error) {
      setDocumentsUploading(false);
      setDocumentUploadError(error instanceof Error ? error.message : "文件读取失败");
    }
  }, [chatId, client]);

  const activeModelOptions = useMemo(() => providerOptions, [providerOptions]);

  // Composer context pill: latest provider-reported turn usage vs the active
  // model's context window.
  const composerContextUsage = useMemo(() => {
    const total = contextWindowTokens
      ?? activeModelOptions.find((option) => option.active)?.contextWindow
      ?? null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const usage = messages[i]?.tokenUsage;
      if (usage?.promptTokens) {
        // ``contextTokens`` is the last LLM call's prompt size (true window
        // occupancy); cumulative promptTokens would overstate tool-heavy turns.
        // Zero (or absent) means the backend did not report it; fall back.
        const contextTokens = usage.contextTokens;
        const used = contextTokens && contextTokens > 0
          ? contextTokens
          : usage.promptTokens + usage.completionTokens;
        return { used, total };
      }
    }
    return null;
  }, [messages, activeModelOptions, contextWindowTokens]);

  useEffect(() => {
    if (chatId && historyKey) sessionKeyByChatIdRef.current.set(chatId, historyKey);
  }, [chatId, historyKey]);

  const displayMessages = useMemo(() => projectWebuiThreadMessages(messages), [messages]);
  const latestDiscussionRun = useMemo(
    () => latestRoomRun(displayMessages, "discussion"),
    [displayMessages],
  );
  const latestWorkflowRun = useMemo(
    () => latestRoomRun(displayMessages, "workflowRun"),
    [displayMessages],
  );
  // Delivered files surface in the workspace panel (session section, with
  // preview/delete affordances). Rendering them again as inline cards in
  // the transcript would duplicate every row, so the transcript view
  // strips them; ``displayMessages`` keeps them for ``messageFiles``.
  const transcriptMessages = useMemo(
    () =>
      displayMessages.map((m) =>
        m.deliveredFiles?.length ? { ...m, deliveredFiles: undefined } : m,
      ),
    [displayMessages],
  );
  const jumpToMessage = useCallback((id: string) => {
    setFocusMessage((current) => ({ id, requestId: (current?.requestId ?? 0) + 1 }));
  }, []);

  const establishedSession = Boolean(
    session?.title?.trim() || session?.preview?.trim() || session?.previewAt,
  );
  const historyUnavailable = historyError || (historyMissing && establishedSession);
  const showHeroComposer = messages.length === 0 && !loading && !historyUnavailable;
  const scheduleItems = useScheduleStore((s) => s.items);
  const loadScheduleItems = useScheduleStore((s) => s.loadItems);
  const recentSession = useMemo(() => {
    return [...recentSessions]
      .sort((a, b) => Date.parse(b.updatedAt ?? b.createdAt ?? "") - Date.parse(a.updatedAt ?? a.createdAt ?? ""))
      .find((candidate) => (candidate.title?.trim() || deriveTitle(candidate.preview, "")).trim())
      ?? null;
  }, [recentSessions]);

  useEffect(() => {
    if (showHeroComposer) void loadScheduleItems();
  }, [loadScheduleItems, showHeroComposer]);

  useEffect(() => {
    if (!chatId || loading) return;
    const cached = messageCacheRef.current.get(chatId);
    const appliedVersion = appliedHistoryVersionRef.current.get(chatId) ?? 0;
    const hasPendingCanonicalHydrate = pendingCanonicalHydrateRef.current.has(chatId);
    const hasNewCanonicalHistory = hasPendingCanonicalHydrate && historyVersion > appliedVersion;
    // When the user switches away and back, keep the local in-memory thread
    // state (including not-yet-persisted messages) instead of replacing it with
    // whatever the history endpoint currently knows about. Once a fresh
    // canonical replay arrives (e.g. after ``session_updated`` refresh), prefer it
    // so rendering converges to the same shape as a manual refresh.
    setMessages((prev) => {
      if (hasNewCanonicalHistory && historical.length > 0) {
        pendingCanonicalHydrateRef.current.delete(chatId);
        appliedHistoryVersionRef.current.set(chatId, historyVersion);
        const normalized = projectWebuiThreadMessages(historical);
        const preserved = preserveDeliveredFiles(prev, normalized);
        messageCacheRef.current.set(chatId, preserved);
        return preserved;
      }
      if (cached && cached.length > 0) {
        return preserveDeliveredFiles(prev, projectWebuiThreadMessages(cached));
      }
      if (historical.length === 0 && prev.length > 0) return projectWebuiThreadMessages(prev);
      appliedHistoryVersionRef.current.set(chatId, historyVersion);
      const next = projectWebuiThreadMessages(historical);
      const preserved = preserveDeliveredFiles(prev, next);
      if (historical.length > 0) messageCacheRef.current.set(chatId, preserved);
      return preserved;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, chatId, historical, historyVersion]);

  useEffect(() => {
    if (!chatId) return;
    return client.onSessionUpdate((updatedChatId, scope) => {
      if (scope === "metadata") return;
      pendingCanonicalHydrateRef.current.add(updatedChatId);
      appliedHistoryVersionRef.current.delete(updatedChatId);
      if (updatedChatId !== chatId) return;
      refreshHistory();
    });
  }, [chatId, client, refreshHistory]);

  useEffect(() => {
    if (!chatId || loading) return;
    setScrollToBottomSignal((value) => value + 1);
  }, [chatId, loading, historical]);

  useEffect(() => {
    if (chatId) return;
    setMessages(projectWebuiThreadMessages(historical));
  }, [chatId, historical, setMessages]);

  useLayoutEffect(() => {
    if (chatId) {
      const prev = prevChatIdForCacheRef.current;
      if (prev && prev !== chatId) {
        messageCacheRef.current.set(prev, projectWebuiThreadMessages(messages));
        skipLayoutCacheRef.current = true;
      }
      prevChatIdForCacheRef.current = chatId;
    } else {
      if (prevChatIdForCacheRef.current) {
        messageCacheRef.current.set(
          prevChatIdForCacheRef.current,
          projectWebuiThreadMessages(messages),
        );
        skipLayoutCacheRef.current = true;
      }
      prevChatIdForCacheRef.current = null;
    }
  }, [chatId, messages]);

  // Persist thread to in-memory cache after paint so ``useMonaStream``'s chat switch
  // ``useEffect`` reset has flushed; ``skipLayoutCacheRef`` drops the first run that still
  // sees the *previous* chat's ``messages`` (avoids stale rows leaking across sessions).
  useEffect(() => {
    if (!chatId) {
      return;
    }
    if (skipLayoutCacheRef.current) {
      skipLayoutCacheRef.current = false;
      return;
    }
    if (loading) {
      return;
    }
    messageCacheRef.current.set(chatId, projectWebuiThreadMessages(messages));
  }, [chatId, loading, messages]);

  useEffect(() => {
    if (!chatId) return;
    const pending = pendingFirstRef.current;
    if (!pending) return;
    pendingFirstRef.current = null;
    pendingFirstWorkspaceRouteChatRef.current = chatId;
    setScrollToBottomSignal((value) => value + 1);
    let cancelled = false;
    void (async () => {
      const routed = session?.conversation?.type === "room"
        ? { content: pending.content }
        : canvasRouteMessageRef.current(pending.content);
      const canvasPath = routed.canvasPath
        ?? (routed.canvasPathReady ? await routed.canvasPathReady : undefined);
      if (cancelled) return;
      const options = pending.options || routed.displayContent || routed.canvasId || canvasPath
        ? {
            ...pending.options,
            displayContent: pending.options?.displayContent ?? routed.displayContent,
            canvasId: routed.canvasId ?? pending.options?.canvasId,
            canvasPath: canvasPath ?? pending.options?.canvasPath,
          }
        : undefined;
      send(routed.content, pending.images, options);
      setBooting(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, send, session?.conversation?.type]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const commands = await listSlashCommands(token);
        if (!cancelled) setSlashCommands(commands);
      } catch {
        if (!cancelled) setSlashCommands([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const setWorkspacePath = useWorkspaceStore((s) => s.setWorkspacePath);

  useEffect(() => {
    let cancelled = false;
    let managedPriceTimer: number | undefined;
    const refreshManagedPrices = async () => {
      try {
        const { prices } = await getManagedModelPrices();
        if (cancelled) return;
        managedModelPricesRef.current = prices;
        const priceByModel = new Map(prices.map((price) => [price.model, price]));
        setProviderOptions((current) => current.map((option) => {
          const price = option.isBuiltin ? priceByModel.get(option.model) : undefined;
          return price ? {
            ...option,
            inputAmountPerMillion: price.input_amount_per_million,
            cachedInputAmountPerMillion: price.cached_input_amount_per_million,
            outputAmountPerMillion: price.output_amount_per_million,
            promotionLabel: price.promotion_label,
            promotionName: price.promotion_name,
            discountPercent: price.discount_percent,
            originalInputAmountPerMillion: price.original_input_amount_per_million,
            originalCachedInputAmountPerMillion: price.original_cached_input_amount_per_million,
            originalOutputAmountPerMillion: price.original_output_amount_per_million,
          } : option;
        }));
      } catch {
        // Pricing is optional and must not block the model selector.
      }
    };
    (async () => {
      try {
        const settings = await fetchSettings(token);
        if (!cancelled) {
          const options = buildComposerProviderOptions(settings);
          setProviderOptions(options);
          const activePreset = settings.model_presets.find((p) => p.active);
          setImageInputEnabled(activePreset?.capabilities?.supports_vision !== false);
          setContextWindowTokens(
            activePreset?.context_window_tokens ?? settings.agent?.context_window_tokens ?? null,
          );
          if (settings.runtime?.workspace_path) {
            setWorkspacePath(settings.runtime.workspace_path);
          }
        }
        if (isTauri()) {
          await refreshManagedPrices();
          if (!cancelled) {
            managedPriceTimer = window.setInterval(() => {
              void refreshManagedPrices();
            }, 30_000);
          }
        }
      } catch {
        if (!cancelled) setProviderOptions([]);
      }
    })();
    return () => {
      cancelled = true;
      if (managedPriceTimer !== undefined) window.clearInterval(managedPriceTimer);
    };
  }, [token, setWorkspacePath]);

  const handleModelSwitch = useCallback(
    async (provider: string, model: string, reasoningEffort?: string | null) => {
      try {
        const payload = await updateSettings(token, {
          provider,
          model: model || undefined,
          providerModel: model || undefined,
          reasoningEffort,
        });
        const newModel = payload.agent.model || null;
        onModelNameChange?.(newModel);
        const activePreset = payload.model_presets?.find(
          (p: { active: boolean; context_window_tokens?: number | null }) => p.active,
        );
        setImageInputEnabled(activePreset?.capabilities?.supports_vision !== false);
        setContextWindowTokens(
          activePreset?.context_window_tokens ?? payload.agent?.context_window_tokens ?? null,
        );
        if (payload.chat_providers) {
          const options = buildComposerProviderOptions(payload, managedModelPricesRef.current);
          setProviderOptions(options);
        }
      } catch (error) {
        console.error("Failed to switch chat model:", error);
      }
    },
    [token, onModelNameChange],
  );

  // Multi-agent: room members offered by the composer ``@`` picker. The
  // registry provides display names; unknown ids degrade to the raw id.
  const agentsById = useAgents(token);
  const customMonaAvatar = agentsById.get("mona")?.avatarUrl || null;
  const directAgentId = conversation?.type === "direct"
    ? conversation.directAgentId?.trim() || null
    : pendingDirectAgentId?.trim() || null;
  const isPartnerNewChat = showHeroComposer && !!directAgentId && directAgentId !== "mona";
  const partnerAgent = directAgentId ? agentsById.get(directAgentId) : undefined;
  const missingInstalledPartner = Boolean(
    session
    && conversation?.type === "direct"
    && directAgentId
    && directAgentId !== "mona"
    && !partnerAgent,
  );
  const partnerAgentName = partnerAgent?.displayName
    ?? pendingDirectAgentName
    ?? (directAgentId ? resolveAgentDisplayName(agentsById, directAgentId) : null)
    ?? "Mona";
  const mentionableAgents = useMemo<RoomAgentInfo[]>(() => {
    const conv = session?.conversation;
    if (!conv || conv.type !== "room") return [];
    return conv.agentIds.map((id) => {
      const summary = agentsById.get(id);
      return {
        id,
        displayName: summary?.displayName ?? id,
      };
    });
  }, [session?.conversation, agentsById]);

  const handleWelcomeSend = useCallback(
    async (content: string, images?: SendImage[], options?: SendOptions) => {
      if (booting) return;
      setBooting(true);
      pendingFirstRef.current = { content, images, options };
      const newId = directAgentId && directAgentId !== "mona"
        ? await onCreateDirectChat?.(directAgentId, selectedWorkspace)
        : await onCreateChat?.(selectedWorkspace);
      if (!newId) {
        pendingFirstRef.current = null;
        setBooting(false);
      }
      // Clear the transient workspace selection after creating the chat.
      setSelectedWorkspace(null);
    },
    [booting, directAgentId, onCreateChat, onCreateDirectChat, selectedWorkspace],
  );

  const handleThreadSend = useCallback(
    async (content: string, _images?: SendImage[], _options?: SendOptions) => {
      if (isStreaming) {
        const officeContext = activeOfficeContextRef.current;
        pendingQueue.enqueue(
          content,
          _images,
          officeContext ? { ...(_options ?? {}), ...officeContext } : _options,
        );
        return;
      }
      setScrollToBottomSignal((value) => value + 1);
      const routed = conversation?.type === "room"
        ? { content }
        : canvasRouteMessageRef.current(content);
      const routedCanvasPath = routed.canvasPath
        ?? (routed.canvasPathReady ? await routed.canvasPathReady : undefined);
      const docPaths = attachedDocuments.map((document) => document.path);
      const baseDisplayContent = _options?.displayContent ?? routed.displayContent;
      const options = docPaths.length > 0
        ? {
            ..._options,
            docPaths,
            documentNames: attachedDocuments.map((document) => document.name),
            canvasId: routed.canvasId ?? _options?.canvasId,
            canvasPath: routedCanvasPath ?? _options?.canvasPath,
            displayContent: baseDisplayContent ?? content,
          }
        : baseDisplayContent
          ? { ..._options, displayContent: baseDisplayContent, canvasId: routed.canvasId ?? _options?.canvasId, canvasPath: routedCanvasPath ?? _options?.canvasPath }
          : routed.canvasId || routedCanvasPath
            ? { ..._options, canvasId: routed.canvasId, canvasPath: routedCanvasPath }
            : _options;
      const officeContext = activeOfficeContextRef.current;
      send(
        routed.content,
        _images,
        officeContext ? { ...(options ?? {}), ...officeContext } : options,
      );
      setAttachedDocuments([]);
    },
    [attachedDocuments, conversation?.type, isStreaming, pendingQueue, send],
  );

  const handleQuote = useCallback((message: UIMessage, author: string) => {
    const content = (message.role === "user" ? message.displayContent ?? message.content : message.content).trim();
    if (!content) return;
    setQuote({ author, content });
  }, []);

  const handleBranchMessage = useCallback((message: UIMessage) => {
    let assistantOrdinal = 0;
    for (const candidate of transcriptMessages) {
      if (
        candidate.role === "assistant"
        && candidate.kind !== "trace"
        && candidate.kind !== "workflowRun"
        && candidate.kind !== "discussion"
        && candidate.content.trim()
      ) {
        assistantOrdinal += 1;
      }
      if (candidate.id === message.id) break;
    }
    if (assistantOrdinal <= 0) return;
    setBranchCandidate({ assistantOrdinal, taskId: message.taskId });
  }, [transcriptMessages]);

  const confirmBranchMessage = useCallback(async () => {
    if (!chatId || !branchCandidate || !onBranchChat || branching) return;
    setBranching(true);
    try {
      const created = await onBranchChat(
        chatId,
        branchCandidate.assistantOrdinal,
        branchCandidate.taskId,
      );
      if (created) setBranchCandidate(null);
    } finally {
      setBranching(false);
    }
  }, [branchCandidate, branching, chatId, onBranchChat]);

  const handleOfficeAiRequest = useCallback((prompt: string, displayText?: string) => {
    void handleThreadSend(prompt, undefined, { displayContent: displayText ?? prompt });
  }, [handleThreadSend]);

  const handleDiscussionStart = useCallback(
    (topic: string, discussion: DiscussionLaunchOptions) => {
      const participantNames = discussion.participantIds.map(
        (id) => agentsById.get(id)?.displayName ?? id,
      );
      void handleThreadSend(topic, undefined, {
        displayContent: t("room.discussion.userMessage", {
          topic,
          mode: t(`room.discussion.${discussion.mode}`),
          rounds: discussion.maxRounds,
          participants: participantNames.join("、"),
        }),
        targetAgentIds: discussion.participantIds,
        discussion,
      });
    },
    [agentsById, handleThreadSend, t],
  );

  const handlePendingAppend = useCallback(
    (id: string) => {
      const msg = pendingQueue.messages.find((m) => m.id === id);
      if (!msg) return;
      inject(msg.content, msg.images, msg.options);
      pendingQueue.remove(id);
    },
    [inject, pendingQueue],
  );

  useEffect(() => {
    if (!queuedPrompt || !chatId || booting || isStreaming) return;
    if (consumedQueuedPromptRef.current === queuedPrompt.id) return;

    consumedQueuedPromptRef.current = queuedPrompt.id;
    setScrollToBottomSignal((value) => value + 1);
    let cancelled = false;
    void (async () => {
      const routed = conversation?.type === "room"
        ? { content: queuedPrompt.content }
        : canvasRouteMessageRef.current(queuedPrompt.content);
      const canvasPath = routed.canvasPath
        ?? (routed.canvasPathReady ? await routed.canvasPathReady : undefined);
      if (cancelled) return;
      const officeContext = activeOfficeContextRef.current;
      const options = routed.displayContent || routed.canvasId || canvasPath || queuedPrompt.origin
        ? {
            displayContent: routed.displayContent,
            canvasId: routed.canvasId,
            canvasPath,
            origin: queuedPrompt.origin,
            profileAdviceId: queuedPrompt.profileAdviceId,
          }
        : undefined;
      send(
        routed.content,
        undefined,
        officeContext ? { ...(options ?? {}), ...officeContext } : options,
      );
      onQueuedPromptConsumed?.(queuedPrompt.id);
    })();
    return () => {
      cancelled = true;
    };
  }, [booting, chatId, conversation?.type, isStreaming, onQueuedPromptConsumed, queuedPrompt, send]);

  const composerPlaceholder = showHeroComposer
    ? "有什么事情，交给Mona吧"
    : t("thread.composer.placeholderThread");

  const openingPlaceholder = booting
    ? t("thread.composer.placeholderOpening")
    : composerPlaceholder;

  const monaHeroBrand = showHeroComposer && !isPartnerNewChat ? (
    <div
      data-testid="mona-hero-brand"
      className="ml-[10px] flex shrink-0 items-center gap-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95"
    >
      <div
        data-testid="mona-human-portrait"
        className="mona-home-avatar relative h-[3.25rem] w-[3.25rem] shrink-0 overflow-hidden rounded-full border border-foreground/10 bg-muted/55 shadow-surface"
      >
        <img
          src={customMonaAvatar ?? "/brand/mona_human_solid.png"}
          alt="Mona"
          data-testid="mona-human-portrait-image"
          className={customMonaAvatar
            ? "pointer-events-none h-full w-full select-none object-cover"
            : "mona-home-avatar-image pointer-events-none absolute left-1/2 top-[-0.15rem] h-[5.75rem] w-auto max-w-none select-none"}
          draggable={false}
        />
      </div>
      <span className="mona-home-wordmark" aria-label="MONA" data-text="MONA">MONA</span>
    </div>
  ) : null;

  const composer = (
    <div
      data-testid={showHeroComposer ? "mona-hero-composer" : "mona-composer"}
      className={cn(
        "relative",
        showHeroComposer && "[&_button[type=submit]]:border-action [&_button[type=submit]]:bg-action [&_button[type=submit]]:text-action-foreground [&_button[type=submit]]:hover:bg-action-hover [&_button[type=submit]]:focus-visible:ring-2 [&_button[type=submit]]:focus-visible:ring-action/40",
      )}
    >
      {streamError ? (
        <StreamErrorNotice
          error={streamError}
          onDismiss={dismissStreamError}
        />
      ) : null}
      {session ? (
        <ThreadComposer
          onSend={handleThreadSend}
          disabled={!chatId || Boolean(historyUnavailable)}
          isStreaming={isStreaming}
          computerUseActive={computerUseActive}
          isAwaitingModelResponse={isAwaitingModelResponse}
          isCompacting={isCompacting}
          stopping={stopping}
          placeholder={composerPlaceholder}
          modelLabel={toModelBadgeLabel(modelName)}
          modelOptions={activeModelOptions}
          onModelSwitch={handleModelSwitch}
          contextUsage={composerContextUsage}
          imageInputEnabled={imageInputEnabled}
          variant={showHeroComposer ? "hero" : "thread"}
          heroBrand={monaHeroBrand}
          showHeroPromptChips={!isPartnerNewChat}
          slashCommands={slashCommands}
          onStop={stop}
          runStartedAt={runStartedAt}
          goalState={goalState}
          leadingActions={(
            <>
              {session.conversation?.type === "room" ? (
                <DiscussionDialog
                  members={mentionableAgents}
                  disabled={isStreaming}
                  onStart={handleDiscussionStart}
                />
              ) : null}
            </>
          )}
          pendingMessages={pendingQueue.messages}
          onPendingAppend={handlePendingAppend}
          onPendingRemove={pendingQueue.remove}
          onPendingEdit={pendingQueue.update}
          isPendingFull={pendingQueue.messages.length >= 3}
          mentionableAgents={mentionableAgents}
          onOpenSettings={onOpenSettings}
          documents={attachedDocuments}
          documentsUploading={documentsUploading}
          documentUploadError={documentUploadError}
          onAddDocuments={addDocuments}
          onRemoveDocument={(path) => setAttachedDocuments((current) => current.filter((document) => document.path !== path))}
          quote={quote}
          onClearQuote={() => setQuote(null)}
        />
      ) : (
        <ThreadComposer
          onSend={handleWelcomeSend}
          disabled={booting}
          isStreaming={isStreaming}
          computerUseActive={computerUseActive}
          isAwaitingModelResponse={isAwaitingModelResponse}
          isCompacting={isCompacting}
          placeholder={openingPlaceholder}
          modelLabel={toModelBadgeLabel(modelName)}
          modelOptions={activeModelOptions}
          onModelSwitch={handleModelSwitch}
          imageInputEnabled={imageInputEnabled}
          variant="hero"
          heroBrand={monaHeroBrand}
          slashCommands={slashCommands}
          onStop={stop}
          runStartedAt={runStartedAt}
          goalState={goalState}
          pendingMessages={pendingQueue.messages}
          onPendingAppend={handlePendingAppend}
          onPendingRemove={pendingQueue.remove}
          onPendingEdit={pendingQueue.update}
          isPendingFull={pendingQueue.messages.length >= 3}
          workspace={selectedWorkspace}
          onWorkspaceChange={setSelectedWorkspace}
          showHeroPromptChips={!isPartnerNewChat}
          onOpenSettings={onOpenSettings}
        />
      )}
    </div>
  );

  const [clockNow, setClockNow] = useState(() => new Date());
  useEffect(() => {
    if (session) return;
    const id = setInterval(() => setClockNow(new Date()), 20_000);
    return () => clearInterval(id);
  }, [session]);

  const hour = clockNow.getHours();
  const daypartKey = hour < 5 ? "night" : hour < 12 ? "morning" : hour < 18 ? "afternoon" : hour < 23 ? "evening" : "night";
  const clockLine = new Intl.DateTimeFormat(i18n.language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(clockNow);
  const dateLine = new Intl.DateTimeFormat(i18n.language, {
    month: "long",
    day: "numeric",
  }).format(clockNow);
  const weekdayLine = new Intl.DateTimeFormat(i18n.language, {
    weekday: "long",
  }).format(clockNow);

  // Rooms land directly on the conversation page (IM group-chat parity):
  // no Mona home dashboard, just the room identity and a composer hint.
  const isRoomEmptyState = conversation?.type === "room";

  const emptyState = loading ? (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {t("thread.loadingConversation")}
    </div>
  ) : historyUnavailable ? (
    <div role="alert" className="flex w-full flex-col items-center justify-center py-16 text-center">
      <div className="text-ui font-medium text-foreground">
        {t("thread.historyLoadFailed")}
      </div>
      <p className="mt-2 max-w-[28rem] text-sm leading-relaxed text-muted-foreground">
        {t("thread.historyLoadFailedHint")}
      </p>
      <Button className="mt-5" variant="outline" onClick={refreshHistory}>
        {t("thread.retryHistory")}
      </Button>
    </div>
  ) : isRoomEmptyState ? (
    <div className="flex w-full flex-col items-center justify-center py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
        <Users className="h-6 w-6 text-muted-foreground" />
      </div>
      <div className="mt-4 text-[15px] font-medium text-foreground">
        {conversation.title?.trim() || t("room.panel.title")}
      </div>
      <p className="mt-1.5 max-w-[26rem] text-[13px] leading-relaxed text-muted-foreground">
        {t("room.emptyHint")}
      </p>
    </div>
  ) : isPartnerNewChat ? (
    <div data-testid="partner-agent-welcome" className="flex w-full flex-col items-center justify-center py-16 text-center">
      <AgentAvatar
        agentId={directAgentId!}
        displayName={partnerAgentName}
        avatarUrl={partnerAgent?.avatarUrl}
        className="h-16 w-16"
      />
      <h1 className="mt-5 text-title font-medium tracking-tight text-foreground">{partnerAgentName}</h1>
      <p className="mt-2 max-w-[28rem] text-[14px] leading-relaxed text-muted-foreground">
        你好，我是{partnerAgentName}，有什么可以帮你？
      </p>
    </div>
  ) : (
    <div
      data-testid="mona-welcome-shell"
      className="mona-welcome-shell relative w-full px-5 md:px-9"
    >
      <div className="mona-welcome-grid relative z-10 grid w-full grid-cols-1 gap-y-8 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="mona-welcome-primary flex min-h-[30rem] motion-safe:animate-in fill-mode-backwards fade-in-0 slide-in-from-bottom-3 flex-col items-start justify-center text-left duration-arrival md:pr-14">
          <div className="text-clock font-extralight leading-none tracking-tight tabular-nums text-foreground">
            {clockLine}
          </div>
          <p className="mt-3 text-ui tracking-wider text-muted-foreground">
            {dateLine} · {weekdayLine}
          </p>
          <h1 className="mt-9 text-title font-medium tracking-tight text-foreground">
            {t(`thread.empty.daypart.${daypartKey}`)}
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
            {t("thread.empty.greeting")}
          </p>
        </div>
        <NewChatDashboard
          scheduleItems={scheduleItems}
          recentSession={recentSession}
          disabled={booting || isStreaming}
          onContinue={onSelectSession}
          onConnectHost={onOpenSSH}
          onConnectDatabase={onOpenDb}
          onCreateNote={onCreateNote}
        />
      </div>
    </div>
  );

  const previewFile = useFilePreviewStore((s) => s.file);
  const closePreview = useFilePreviewStore((s) => s.close);
  const splitRatio = useFilePreviewStore((s) => s.splitRatio);
  const setSplitRatio = useFilePreviewStore((s) => s.setSplitRatio);
  const workspaceCollapsed = useFilePreviewStore((s) => s.workspaceCollapsed);
  const setWorkspaceCollapsed = useFilePreviewStore(
    (s) => s.setWorkspaceCollapsed,
  );
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const terminalWorkingDirectory = session?.workspace?.trim() || workspacePath.trim() || undefined;

  // Rooms are a separate projection: they never fall back to an Agent's
  // workspace. Project sessions keep their bound root; ordinary Agent
  // sessions use the active Agent's durable output directory.
  const isRoomSession = conversation?.type === "room";
  const isProjectSession = !isRoomSession && !!session?.workspace;
  const canvasWorkspaceRoot = session?.workspace?.trim()
    || buildSharedOutputDir(workspacePath, conversation?.directAgentId);
  const sessionKey = session?.key ?? null;
  const isHome = !session;
  const workspaceScope: PreviewScope = isRoomSession
    ? "room"
    : isProjectSession
      ? "project"
      : "shared";
  const [previewTabs, setPreviewTabs] = useState<ArtifactPreviewTab[]>([]);
  const deliveredScorePreviewRef = useRef<{
    historyKey: string | null;
    seenDeliveries: Set<string>;
    seenEdits: Set<string>;
  }>({
    historyKey: null,
    seenDeliveries: new Set(),
    seenEdits: new Set(),
  });
  const [toolTabs, setToolTabs] = useState<ToolSidebarTab[]>([]);
  const [officeSessions, setOfficeSessions] = useState<Record<string, OfficeSessionState>>({});
  const toolTabsRef = useRef(toolTabs);
  const terminalTabRequestsRef = useRef<Set<string>>(new Set());
  toolTabsRef.current = toolTabs;
  const [rightTabOrder, setRightTabOrder] = useState<string[]>([]);
  const [activeRightTabId, setActiveRightTabId] = useState(OVERVIEW_TAB_ID);
  const [rightMaximized, setRightMaximized] = useState(false);
  const [officeToolbarContainer, setOfficeToolbarContainer] = useState<HTMLDivElement | null>(null);
  const activeOfficeSession = activeRightTabId.startsWith("office:")
    ? officeSessions[activeRightTabId.slice("office:".length)]
    : undefined;
  activeOfficeContextRef.current = activeOfficeSession
    ? {
        officeSessionId: activeOfficeSession.sessionId,
        officeDocumentType: activeOfficeSession.type,
        officeDisplayName: activeOfficeSession.displayName,
      }
    : null;
  const handleOpenConversationCanvas = useCallback((canvasId: string) => {
    if (isRoomSession) return;
    closePreview();
    setRightTabOrder((current) => current.includes(canvasId) ? current : [...current, canvasId]);
    setActiveRightTabId(canvasId);
    setWorkspaceCollapsed(false);
    setSplitRatio(0.5);
  }, [closePreview, isRoomSession, setSplitRatio, setWorkspaceCollapsed]);
  const conversationCanvases = useConversationCanvases({
    chatId: isRoomSession ? null : chatId,
    messages,
    isStreaming,
    workspaceRoot: canvasWorkspaceRoot,
    migrateLegacy: !isProjectSession && (!conversation?.directAgentId || conversation.directAgentId === "mona"),
    onOpenCanvas: handleOpenConversationCanvas,
  });
  const conversationCanvasTabsRef = useRef(conversationCanvases.tabs);
  conversationCanvasTabsRef.current = conversationCanvases.tabs;
  useEffect(() => {
    if (!isTauri() || isRoomSession) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const stopListening = await listen<{ canvasId?: string; path?: string }>(
        "canvas-agent-activate-sidebar",
        async ({ payload }) => {
          const canvas = conversationCanvasTabsRef.current.find(
            (tab) => tab.note.id === payload?.canvasId,
          );
          if (!canvas) {
            if (payload?.path) {
              try {
                await conversationCanvases.openWorkspaceCanvas(payload.path);
              } catch {
                return;
              }
            }
            return;
          }
          setRightTabOrder((current) => current.includes(canvas.id) ? current : [...current, canvas.id]);
          setActiveRightTabId(canvas.id);
          conversationCanvases.selectCanvas(canvas.id);
          closePreview();
          setWorkspaceCollapsed(false);
          setSplitRatio(0.5);
        },
      );
      if (disposed) {
        stopListening();
        return;
      }
      unlisten = stopListening;
    })().catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [closePreview, conversationCanvases.openWorkspaceCanvas, conversationCanvases.selectCanvas, isRoomSession, setSplitRatio, setWorkspaceCollapsed]);
  const openOfficeEditor = useCallback((nextSession: OfficeSessionState, previewTabId?: string) => {
    const tabId = `office:${nextSession.sessionId}`;
    if (sessionKey) rememberOfficeSession(sessionKey, nextSession);
    setOfficeSessions((current) => ({ ...current, [nextSession.sessionId]: nextSession }));
    if (previewTabId) setPreviewTabs((current) => current.filter((tab) => tab.id !== previewTabId));
    setRightTabOrder((current) => {
      const next = current.filter((id) => id !== previewTabId);
      return next.includes(tabId) ? next : [...next, tabId];
    });
    setActiveRightTabId(tabId);
    conversationCanvases.selectCanvas(null);
    closePreview();
    setWorkspaceCollapsed(false);
    setSplitRatio(0.5);
  }, [closePreview, conversationCanvases.selectCanvas, sessionKey, setSplitRatio, setWorkspaceCollapsed]);

  useEffect(() => {
    if (!chatId || isRoomSession) return;
    return client.onChat(chatId, (event) => {
      if (event.event !== "message" || event.agent_ui?.kind !== "office_session") return;
      const data = event.agent_ui.data as Record<string, unknown> | undefined;
      if (isOfficeSessionState(data?.session)) openOfficeEditor(data.session);
    });
  }, [chatId, client, isRoomSession, openOfficeEditor]);

  canvasRouteMessageRef.current = isRoomSession
    ? (content) => ({ content })
    : conversationCanvases.routeMessage;
  const startSidebarTerminal = useCallback((tabId: string) => {
    terminalTabRequestsRef.current.add(tabId);
    setToolTabs((current) => current.map((tab) => (
      tab.id === tabId
        ? { ...tab, terminalSessionId: undefined, terminalStatus: "opening", terminalError: undefined }
        : tab
    )));
    void import("@/components/terminal/ipc")
      .then((ipc) => ipc.shellSpawn(80, 24, terminalWorkingDirectory))
      .then((sessionId) => {
        if (!terminalTabRequestsRef.current.has(tabId)) {
          disposeSidebarTerminalSession(sessionId);
          return;
        }
        setToolTabs((current) => current.map((tab) => {
          if (tab.id !== tabId) return tab;
          return { ...tab, terminalSessionId: sessionId, terminalStatus: "ready", terminalError: undefined };
        }));
      })
      .catch((error) => {
        setToolTabs((current) => current.map((tab) => (
          tab.id === tabId
            ? { ...tab, terminalStatus: "error", terminalError: error instanceof Error ? error.message : String(error) }
            : tab
        )));
      });
  }, [terminalWorkingDirectory]);

  useEffect(() => {
    if (isRoomSession || !conversationCanvases.activeCanvasId) return;
    setActiveRightTabId(conversationCanvases.activeCanvasId);
    closePreview();
  }, [closePreview, conversationCanvases.activeCanvasId, isRoomSession]);

  useEffect(() => {
    const preserveFirstMessageWorkspace = pendingFirstWorkspaceRouteChatRef.current === chatId;
    pendingFirstWorkspaceRouteChatRef.current = null;
    for (const tab of toolTabsRef.current) {
      if (tab.terminalSessionId) disposeSidebarTerminalSession(tab.terminalSessionId);
    }
    terminalTabRequestsRef.current.clear();
    if (!preserveFirstMessageWorkspace) {
      setPreviewTabs([]);
      setToolTabs([]);
      setOfficeSessions({});
      setRightTabOrder([]);
      setActiveRightTabId(OVERVIEW_TAB_ID);
      setRightMaximized(false);
    }
  }, [historyKey]);

  useEffect(() => {
    if (!sessionKey || isRoomSession) return;
    const sessions = persistedOfficeSessions(sessionKey);
    if (sessions.length === 0) return;
    const tabIds = sessions.map((item) => `office:${item.sessionId}`);
    setOfficeSessions(Object.fromEntries(sessions.map((item) => [item.sessionId, item])));
    setRightTabOrder((current) => [...current.filter((id) => !id.startsWith("office:")), ...tabIds]);
    setActiveRightTabId(tabIds[tabIds.length - 1]);
    setWorkspaceCollapsed(false);
  }, [historyKey, isRoomSession, sessionKey, setWorkspaceCollapsed]);

  useLayoutEffect(() => {
    onRightWorkspaceMaximizedChange?.(rightMaximized);
  }, [onRightWorkspaceMaximizedChange, rightMaximized]);

  useEffect(() => () => {
    onRightWorkspaceMaximizedChange?.(false);
  }, [onRightWorkspaceMaximizedChange]);

  useEffect(() => () => {
    terminalTabRequestsRef.current.clear();
    for (const tab of toolTabsRef.current) {
      if (tab.terminalSessionId) disposeSidebarTerminalSession(tab.terminalSessionId);
    }
  }, []);

  useLayoutEffect(() => {
    if (!previewFile || isRoomSession) return;
    const previewState = useFilePreviewStore.getState();
    if (previewState.scope !== workspaceScope || previewState.sessionKey !== sessionKey) return;
    const id = artifactTabId(previewFile);
    setPreviewTabs((current) => {
      const existing = current.findIndex((tab) => tab.id === id);
      if (existing < 0) return [...current, { id, file: previewFile }];
      const next = [...current];
      next[existing] = { id, file: previewFile };
      return next;
    });
    setRightTabOrder((current) => current.includes(id) ? current : [...current, id]);
    conversationCanvases.selectCanvas(null);
    setActiveRightTabId(id);
    setSplitRatio(0.5);
  }, [conversationCanvases.selectCanvas, isRoomSession, previewFile, sessionKey, setSplitRatio, workspaceScope]);

  useEffect(() => {
    if (
      isRoomSession
      || previewFile
      || activeRightTabId === OVERVIEW_TAB_ID
      || activeRightTabId.startsWith("canvas:")
      || activeRightTabId.startsWith("tool:")
      || activeRightTabId.startsWith("office:")
    ) return;
    setActiveRightTabId(OVERVIEW_TAB_ID);
  }, [activeRightTabId, isRoomSession, previewFile]);

  useEffect(() => {
    if (!rightMaximized) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRightMaximized(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [rightMaximized]);

  useEffect(() => {
    if (workspaceCollapsed) setRightMaximized(false);
  }, [workspaceCollapsed]);

  // Preview state is global so the split pane can survive a list/preview
  // round-trip. It must nevertheless be scoped to the active conversation;
  // otherwise switching sessions while a file is open can preview the prior
  // Agent's file under the new session's owner.
  useEffect(() => {
    const state = useFilePreviewStore.getState();
    if (!state.file) return;
    const ownerMatches = conversation?.type === "room"
      ? state.scope === "room" && state.roomId === chatId
      : state.scope === workspaceScope && state.sessionKey === sessionKey;
    if (!ownerMatches) state.close();
  }, [chatId, conversation?.type, historyKey, sessionKey, workspaceScope]);

  // Authoritative on-disk scan: shared sessions scan the active Agent output;
  // project sessions scan the bound project directory (all files — project
  // sessions have no "artifact" concept, the directory IS the list).
  const artifacts = useArtifacts(
    !isHome ? token : null,
    `${historyKey ?? "home"}-${currentTaskId ?? "current"}-${artifactsRefreshSignal}`,
    {
      scope: workspaceScope,
      sessionKey: isRoomSession ? null : sessionKey,
      room: isRoomSession ? chatId : null,
      taskId: isRoomSession || isProjectSession ? null : currentTaskId,
      sourceKey: chatId,
    },
  );

  // Rescan when the server pushes ``artifacts_changed`` — the shared output
  // directory changed on disk (possibly from another channel), so the panel
  // tracks reality without a manual refresh click.
  const { refresh: refreshArtifacts } = artifacts;
  useEffect(() => {
    if (isProjectSession || isRoomSession || isHome) return;
    return client.onArtifactsChanged(() => refreshArtifacts());
  }, [client, isProjectSession, isRoomSession, isHome, refreshArtifacts]);
  useEffect(() => {
    const refresh = () => refreshArtifacts();
    window.addEventListener("mona:workspace-canvas-changed", refresh);
    return () => window.removeEventListener("mona:workspace-canvas-changed", refresh);
  }, [refreshArtifacts]);

  // Aggregate explicit session deliveries from live messages. Process files
  // from write/edit/patch belong to the task projection returned by the
  // artifact API and must never be promoted here implicitly.
  const messageFiles = useMemo(() => {
    const out: DeliveredFile[] = [];
    const seen = new Set<string>();
    const push = (file: DeliveredFile) => {
      const key = artifactIdentity(file);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(file);
    };
    for (const m of displayMessages) {
      if (m.deliveredFiles?.length) {
        for (const f of m.deliveredFiles) push(f);
      }
    }
    return out;
  }, [displayMessages]);

  // Paths trashed via the workspace panel. Message events (deliver_file /
  // file_edit) are immutable history: without tombstones a trashed file would
  // resurrect in the session section on every remount. The tombstones live in
  // the module-level preview store so they survive panel/shell remounts, and
  // the authoritative scan can still revive a path the agent re-created.
  const deletedArtifactPaths = useFilePreviewStore((s) => s.deletedArtifactPaths);
  const markArtifactDeleted = useFilePreviewStore((s) => s.markArtifactDeleted);
  const resetArtifactInventory = useFilePreviewStore((s) => s.resetArtifactInventory);
  const artifactOwnerKey = isRoomSession
    ? `room:${chatId ?? ""}`
    : isProjectSession
      ? `project:${sessionKey ?? ""}`
      : `agent:${conversation?.directAgentId?.trim().toLowerCase() || "mona"}:session:${sessionKey ?? ""}`;
  useEffect(() => {
    // New-file markers belong to the active owner. Deletion tombstones stay
    // global so an immutable session delivery cannot resurrect after a list
    // remount, while each Agent/session starts with a fresh inventory view.
    resetArtifactInventory();
  }, [artifactOwnerKey, resetArtifactInventory]);
  const scanKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const f of [...artifacts.files, ...artifacts.taskFiles, ...artifacts.sessionFiles]) {
      keys.add(normalizeArtifactPath(artifactIdentity(f)));
    }
    return keys;
  }, [artifacts.files, artifacts.taskFiles, artifacts.sessionFiles]);
  const visibleMessageFiles = useMemo(() => {
    if (isRoomSession) return [];
    if (deletedArtifactPaths.size === 0) return messageFiles;
    return messageFiles.filter((f) => {
      const keys = [artifactIdentity(f), f.absolute_path, f.path].filter(
        (value): value is string => !!value,
      );
      if (!keys.some((key) => isArtifactTombstoned(key, deletedArtifactPaths))) {
        return true;
      }
      // Scan-authoritative revival: the latest scan sees the file again, so
      // it exists on disk and must not stay hidden by the tombstone.
      return keys.some((key) => scanKeys.has(normalizeArtifactPath(key)));
    });
  }, [isRoomSession, messageFiles, deletedArtifactPaths, scanKeys]);

  // Only live file activity may take focus. Replayed history remains visible in
  // the workspace, while duplicate delivery frames must not reopen a file the
  // user already closed. A new edit call may intentionally reopen the same path.
  useEffect(() => {
    if (!chatId || !historyKey || isRoomSession) return;
    return client.onChat(chatId, (event) => {
      const tracker = deliveredScorePreviewRef.current;
      if (tracker.historyKey !== historyKey) {
        tracker.historyKey = historyKey;
        tracker.seenDeliveries = new Set();
        tracker.seenEdits = new Set();
      }
      let newScore: DeliveredFile | undefined;
      if (event.event === "file_edit") {
        const completed = event.edits
          .filter((edit) => edit.status === "done" && edit.phase !== "error")
          .map((edit) => ({ edit, file: scorePreviewArtifactFromEdit(edit) }))
          .filter((item): item is { edit: UIFileEdit; file: DeliveredFile } => !!item.file);
        const unseen = [...completed].reverse().find(({ edit, file }) => (
          !tracker.seenEdits.has(`${edit.call_id}:${artifactIdentity(file)}`)
        ));
        completed.forEach(({ edit, file }) => {
          tracker.seenEdits.add(`${edit.call_id}:${artifactIdentity(file)}`);
          tracker.seenDeliveries.add(artifactIdentity(file));
        });
        newScore = unseen?.file;
      } else if (event.event === "deliver_files") {
        const scores = event.files.filter(isScorePreviewArtifact);
        newScore = [...scores].reverse().find(
          (file) => !tracker.seenDeliveries.has(artifactIdentity(file)),
        );
        scores.forEach((file) => tracker.seenDeliveries.add(artifactIdentity(file)));
      }
      if (!newScore) return;
      useFilePreviewStore.getState().open(newScore, workspaceScope, sessionKey);
      setWorkspaceCollapsed(false);
      setSplitRatio(0.5);
    });
  }, [chatId, client, historyKey, isRoomSession, sessionKey, setSplitRatio, setWorkspaceCollapsed, workspaceScope]);

  const visibleTaskFiles = useMemo(() => {
    if (isRoomSession || isProjectSession) return [];
    if (deletedArtifactPaths.size === 0) return artifacts.taskFiles;
    return artifacts.taskFiles.filter((file) => {
      const keys = [artifactIdentity(file), file.absolute_path, file.path].filter(
        (value): value is string => !!value,
      );
      if (!keys.some((key) => isArtifactTombstoned(key, deletedArtifactPaths))) {
        return true;
      }
      return keys.some((key) => scanKeys.has(normalizeArtifactPath(key)));
    });
  }, [isRoomSession, isProjectSession, artifacts.taskFiles, deletedArtifactPaths, scanKeys]);

  // The directory inventory includes delivered and process files too.
  // Their session/task attribution belongs only to the overview projections.
  const workspaceFiles = artifacts.files;

  // Session references remain visible even after the file also appears in the
  // workspace scan. Merge scan metadata into the reference row when possible.
  const sessionFilesForPanel = useMemo(() => {
    if (isRoomSession || isProjectSession) return undefined;
    const byPath = new Map(
      artifacts.files.map((f) => [artifactIdentity(f), f]),
    );
    const out: DeliveredFile[] = [];
    const seen = new Set<string>();
    for (const f of [...artifacts.sessionFiles, ...visibleMessageFiles]) {
      const key = artifactIdentity(f);
      if (seen.has(key)) continue;
      seen.add(key);
      const scanned = byPath.get(key);
      out.push(scanned ? { ...scanned, artifact_ref: f.artifact_ref ?? scanned.artifact_ref } : f);
    }
    return out;
  }, [isRoomSession, isProjectSession, artifacts.files, artifacts.sessionFiles, visibleMessageFiles]);

  const taskFilesForPanel = useMemo(() => {
    if (isRoomSession || isProjectSession) return undefined;
    const sessionPaths = new Set(
      (sessionFilesForPanel ?? []).map((file) =>
        normalizeArtifactPath(artifactIdentity(file)),
      ),
    );
    const out: DeliveredFile[] = [];
    const seen = new Set<string>();
    for (const file of visibleTaskFiles) {
      const key = normalizeArtifactPath(artifactIdentity(file));
      if (sessionPaths.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
    return out;
  }, [isRoomSession, isProjectSession, sessionFilesForPanel, visibleTaskFiles]);

  // 交付物默认只看今天交付/更新的文件，可切换到全部。
  const [deliverablesRange, setDeliverablesRange] = useState<DeliverablesRange>("today");
  useEffect(() => setDeliverablesRange("today"), [historyKey]);
  const deliverablesFilesForPanel = useMemo(
    () => filterDeliverablesByRange(sessionFilesForPanel ?? [], deliverablesRange),
    [sessionFilesForPanel, deliverablesRange],
  );

  const hasFiles = workspaceFiles.length > 0;

  // Preview prev/next cycles in the same visual order the workspace panel
  // displays: flat session section first, then the sorted artifact tree.
  const previewNavFiles = useMemo(
    () =>
      flattenFilesForDisplay(
        workspaceFiles,
        isRoomSession || isProjectSession ? [] : sessionFilesForPanel ?? [],
        isRoomSession || isProjectSession ? [] : taskFilesForPanel ?? [],
      ),
    [isRoomSession, isProjectSession, workspaceFiles, sessionFilesForPanel, taskFilesForPanel],
  );
  const sidebarTabs = useMemo<ArtifactSidebarTab[]>(() => {
    const officeTabs: OfficeSidebarTab[] = Object.values(officeSessions).map((officeSession) => ({
      id: `office:${officeSession.sessionId}`,
      kind: "office",
      title: officeSession.displayName,
      sessionId: officeSession.sessionId,
      officeType: officeSession.type,
    }));
    const available: ArtifactSidebarTab[] = [
      ...conversationCanvases.tabs.map((canvas) => ({
      id: canvas.id,
      kind: "canvas" as const,
      title: canvas.note.title,
      canvasKind: canvas.note.type === "flowchart" ? "flowchart" as const : "mindmap" as const,
      })),
      ...toolTabs,
      ...officeTabs,
      ...previewTabs,
    ];
    const byId = new Map(available.map((tab) => [tab.id, tab]));
    return [
      ...rightTabOrder.map((id) => byId.get(id)).filter((tab): tab is ArtifactSidebarTab => !!tab),
      ...available.filter((tab) => !rightTabOrder.includes(tab.id)),
    ];
  }, [conversationCanvases.tabs, officeSessions, previewTabs, rightTabOrder, toolTabs]);
  const handleSelectOverview = useCallback(() => {
    setActiveRightTabId(OVERVIEW_TAB_ID);
    conversationCanvases.selectCanvas(null);
    closePreview();
  }, [closePreview, conversationCanvases.selectCanvas]);
  const handleSelectRightTab = useCallback((tab: ArtifactSidebarTab) => {
    setActiveRightTabId(tab.id);
    if (tab.kind === "canvas") {
      closePreview();
      conversationCanvases.selectCanvas(tab.id);
      return;
    }
    if (tab.kind === "tool") {
      closePreview();
      conversationCanvases.selectCanvas(null);
      if (tab.toolKind === "browser") onEnsureSidebarBrowser?.();
      return;
    }
    if (tab.kind === "office") {
      closePreview();
      conversationCanvases.selectCanvas(null);
      return;
    }
    conversationCanvases.selectCanvas(null);
    useFilePreviewStore.getState().open(
      tab.file,
      workspaceScope,
      sessionKey,
      isRoomSession ? chatId : null,
    );
  }, [chatId, closePreview, conversationCanvases.selectCanvas, isRoomSession, onEnsureSidebarBrowser, sessionKey, workspaceScope]);
  const handleCloseRightTab = useCallback((id: string) => {
    if (id.startsWith("canvas:")) {
      conversationCanvases.closeCanvas(id);
      setRightTabOrder((current) => current.filter((tabId) => tabId !== id));
      if (activeRightTabId === id) setActiveRightTabId(OVERVIEW_TAB_ID);
      return;
    }
    if (id.startsWith("tool:")) {
      const target = toolTabs.find((tab) => tab.id === id);
      terminalTabRequestsRef.current.delete(id);
      if (target?.terminalSessionId) disposeSidebarTerminalSession(target.terminalSessionId);
      setToolTabs((current) => current.filter((tab) => tab.id !== id));
      setRightTabOrder((current) => current.filter((tabId) => tabId !== id));
      if (activeRightTabId === id) setActiveRightTabId(OVERVIEW_TAB_ID);
      return;
    }
    if (id.startsWith("office:")) {
      const officeSessionId = id.slice("office:".length);
      const removeTab = () => {
        if (sessionKey) forgetOfficeSession(sessionKey, officeSessionId);
        setOfficeSessions((current) => {
          const next = { ...current };
          delete next[officeSessionId];
          return next;
        });
        setRightTabOrder((current) => current.filter((tabId) => tabId !== id));
        if (activeRightTabId === id) setActiveRightTabId(OVERVIEW_TAB_ID);
      };
      if (sessionKey) {
        void closeOfficeSession(officeSessionId, sessionKey).then(removeTab).catch(() => undefined);
      } else {
        removeTab();
      }
      return;
    }
    setPreviewTabs((current) => current.filter((tab) => tab.id !== id));
    setRightTabOrder((current) => current.filter((tabId) => tabId !== id));
    if (activeRightTabId === id) {
      setActiveRightTabId(OVERVIEW_TAB_ID);
      closePreview();
    }
  }, [activeRightTabId, closePreview, conversationCanvases.closeCanvas, sessionKey, toolTabs]);
  const handleCreateRightTab = useCallback(async (kind: SidebarNewTabKind) => {
    if (kind === "flowchart" || kind === "mindmap") {
      conversationCanvases.createBlankCanvas(kind);
      return;
    }
    if (kind === "ppt" || kind === "word" || kind === "excel") {
      if (!sessionKey) throw new Error("当前会话无法创建 Office 文档");
      const officeType = kind === "ppt" ? "slides" : kind === "word" ? "docs" : "sheets";
      const displayName = kind === "ppt" ? "新建 PPT" : kind === "word" ? "新建 Word" : "新建 Excel";
      const officeSession = await createOfficeSession({
        ownerSessionKey: sessionKey,
        type: officeType,
        displayName,
      });
      openOfficeEditor(officeSession);
      return;
    }
    const tab: ToolSidebarTab = kind === "workspace"
      ? { id: SIDEBAR_WORKSPACE_TAB_ID, kind: "tool", title: "工作区", toolKind: "workspace" }
      : kind === "browser"
        ? { id: SIDEBAR_BROWSER_TAB_ID, kind: "tool", title: "浏览器", toolKind: "browser" }
        : { id: SIDEBAR_TERMINAL_TAB_ID, kind: "tool", title: "终端", toolKind: "terminal", terminalStatus: "opening" };
    const existing = toolTabs.find((item) => item.id === tab.id);
    setToolTabs((current) => existing ? current : [...current, tab]);
    setRightTabOrder((current) => current.includes(tab.id) ? current : [...current, tab.id]);
    setActiveRightTabId(tab.id);
    conversationCanvases.selectCanvas(null);
    closePreview();
    setWorkspaceCollapsed(false);
    if (kind === "browser") onEnsureSidebarBrowser?.();
    if (kind === "terminal" && (!existing || existing.terminalStatus === "error")) {
      startSidebarTerminal(tab.id);
    }
  }, [closePreview, conversationCanvases, onEnsureSidebarBrowser, openOfficeEditor, sessionKey, setWorkspaceCollapsed, startSidebarTerminal, toolTabs]);
  // Right panel shows the file list by default, or the in-pane preview
  // when a file is selected. Sessions with zero artifact activity hide the
  // panel by default but keep the collapsed edge button as an
  // always-reachable entry; expanding it reveals the panel's empty state.
  // A session whose transcript references artifacts (even if all were
  // trashed afterwards) keeps the panel reachable on its empty state.
  const [emptyPanelExpanded, setEmptyPanelExpanded] = useState(false);
  useEffect(() => setEmptyPanelExpanded(false), [historyKey]);
  const hasPreviewTarget =
    hasFiles ||
    (sessionFilesForPanel?.length ?? 0) > 0 ||
    (taskFilesForPanel?.length ?? 0) > 0 ||
    previewTabs.length > 0 ||
    conversationCanvases.tabs.length > 0 ||
    toolTabs.length > 0 ||
    Object.keys(officeSessions).length > 0 ||
    !!previewFile ||
    messageFiles.length > 0;
  const rightVisible =
    !isHome && !workspaceCollapsed && (hasPreviewTarget || emptyPanelExpanded);
  const sidebarBrowserVisible =
    browserHostVisible
    && !isRoomSession
    && rightVisible
    && activeRightTabId === SIDEBAR_BROWSER_TAB_ID;
  useEffect(() => {
    onSidebarBrowserVisibilityChange?.(sidebarBrowserVisible);
  }, [onSidebarBrowserVisibilityChange, sidebarBrowserVisible]);
  useEffect(() => () => onSidebarBrowserVisibilityChange?.(false), [onSidebarBrowserVisibilityChange]);

  // Multi-agent phase 2d: rooms get a context panel (goal / members /
  // workflow summary) sharing the right-hand pane with the workspace panel.
  // It opens by default when a room is entered so the collaboration state
  // stays discoverable; closing it falls back to the workspace panel rules.
  const [roomPanelOpen, setRoomPanelOpen] = useState(false);
  useEffect(() => {
    setRoomPanelOpen(conversation?.type === "room");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyKey, conversation?.type]);
  const showRoomPanel = !!isRoomSession && roomPanelOpen && !previewFile;

  // 标题行常驻切换：仅在有产物或正在预览时显示；房间会话由房间面板按钮替代。

  // Workflow runs surface inside the room conversation (IM group-chat
  // parity): each broadcast snapshot updates the run card in place, while
  // step results arrive as ordinary agent messages via the stream handler.
  useEffect(() => {
    if (!chatId || !isRoomSession) return;
    return client.onWorkflowRunUpdated((updatedChatId, run) => {
      if (updatedChatId !== chatId || !run) return;
      setMessages((prev) => upsertWorkflowRunMessage(prev, run));
    });
  }, [chatId, isRoomSession, client, setMessages]);

  // Absolute path of the active Agent output directory, used by the
  // workspace panel's "open output directory" affordances.
  const sharedOutputDir = useMemo(
    () => buildSharedOutputDir(workspacePath, conversation?.directAgentId),
    [conversation?.directAgentId, workspacePath],
  );

  // Delete a shared-output artifact from disk and trigger a scan refresh so
  // the workspace panel re-reads the directory and drops the row.
  const handleDeleteArtifact = useCallback(
    async (file: DeliveredFile) => {
      const target = file.absolute_path?.trim();
      if (!target || !(/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(target))) {
        throw new Error("无法删除没有绝对路径的产物");
      }
      // 删除一律进系统回收站（可恢复）；失败时抛给 WorkspacePanel 在确认
      // 弹窗中展示原因，绝不静默回退为永久删除。
      const { moveToTrash } = await import("@/lib/tauri");
      await moveToTrash(target);
      // 消息事件不可变，显式记录已删除路径让本次会话列表立即移除。
      markArtifactDeleted(target);
      const normalizedTarget = normalizeArtifactPath(target).replace(/\/+$/, "");
      setPreviewTabs((current) => current.filter((tab) => {
        const tabPath = normalizeArtifactPath(tab.file.absolute_path);
        return tabPath !== normalizedTarget && !tabPath.startsWith(`${normalizedTarget}/`);
      }));
      artifacts.refresh();
    },
    [artifacts, markArtifactDeleted],
  );

  const handleRenameArtifact = useCallback(
    async (file: DeliveredFile, newName: string) => {
      if (isRoomSession || !sessionKey) {
        throw new Error("当前文件不支持重命名");
      }
      const path = file.artifact_ref?.relative_path || file.path;
      if (!path || /^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(path)) {
        throw new Error("无法重命名没有相对路径的文件");
      }
      const target = file.absolute_path?.trim() || "";
      await renameArtifact(token, {
        scope: isProjectSession ? "project" : "shared",
        sessionKey,
        path,
        newName,
      });
      if (target) {
        markArtifactDeleted(target);
        const normalizedTarget = normalizeArtifactPath(target).replace(/\/+$/, "");
        setPreviewTabs((current) => current.filter((tab) => {
          const tabPath = normalizeArtifactPath(tab.file.absolute_path);
          return tabPath !== normalizedTarget && !tabPath.startsWith(`${normalizedTarget}/`);
        }));
        const previewPath = previewFile?.absolute_path || "";
        if (
          previewPath === target
          || previewPath.startsWith(`${target.replace(/[\\/]+$/, "")}/`)
          || previewPath.startsWith(`${target.replace(/[\\/]+$/, "")}\\`)
        ) {
          closePreview();
        }
      }
      artifacts.refresh();
    },
    [artifacts, closePreview, isProjectSession, isRoomSession, markArtifactDeleted, previewFile, sessionKey, token],
  );

  const collapseSessionListForNarrowPane = useCallback(() => {
    if (sessionListOpen) onCollapseSessionList?.();
  }, [onCollapseSessionList, sessionListOpen]);

  return (
    <>
      <SplitPane
      left={
        <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {showHeader ? (
            <ThreadHeader
              title={title}
              onToggleSidebar={onToggleSidebar}
              sidebarOpen={sessionListOpen}
              minimal={!session && !loading}
              conversation={conversation}
              onToggleRoomPanel={
                isRoomSession ? () => setRoomPanelOpen((open) => !open) : undefined
              }
              workspaceOpen={isRoomSession ? showRoomPanel || !!previewFile : rightVisible}
              onToggleWorkspace={
                isRoomSession
                  ? () => setRoomPanelOpen((open) => !open)
                  : () => {
                      if (rightVisible) {
                        setRightMaximized(false);
                        setWorkspaceCollapsed(true);
                      } else {
                        if (hasPreviewTarget) {
                          setWorkspaceCollapsed(false);
                        } else {
                          setEmptyPanelExpanded(true);
                          setWorkspaceCollapsed(false);
                        }
                      }
                    }
              }
              workspaceHasContent={isRoomSession ? true : !isHome}
              messages={transcriptMessages}
              onJumpToMessage={jumpToMessage}
            />
          ) : null}
          {missingInstalledPartner ? (
            <div className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/8 px-4 py-2 text-sm">
              <span className="text-amber-800 dark:text-amber-200">
                {t("experts.historyNeedsInstall")}
              </span>
              <Button variant="outline" size="sm" onClick={onOpenExpertLibrary}>
                {t("experts.reinstall")}
              </Button>
            </div>
          ) : null}
          <ThreadViewport
            messages={transcriptMessages}
            isStreaming={isStreaming}
            isGroupChat={isRoomSession}
            emptyState={emptyState}
            composer={composer}
            scrollToBottomSignal={scrollToBottomSignal}
            focusMessage={focusMessage}
            conversationKey={historyKey}
            showScrollToBottomButton={!!session}
            onQuote={handleQuote}
            onBranch={onBranchChat ? handleBranchMessage : undefined}
          />
        </section>
      }
      right={
        isRoomSession && previewFile ? (
          <FilePreviewPanel files={previewNavFiles} />
        ) : showRoomPanel && conversation && chatId ? (
          <RoomContextPanel
            chatId={chatId}
            conversation={conversation}
            discussionRun={latestDiscussionRun}
            workflowRun={latestWorkflowRun}
          />
        ) : isRoomSession ? null : (
          <ArtifactSidebar
            tabs={sidebarTabs}
            activeTabId={activeRightTabId}
            maximized={rightMaximized}
            onSelectOverview={handleSelectOverview}
            onSelectTab={handleSelectRightTab}
            onCloseTab={handleCloseRightTab}
            onCreateTab={handleCreateRightTab}
            toolbarSlotRef={setOfficeToolbarContainer}
            onToggleMaximized={() => setRightMaximized((value) => !value)}
            onCollapse={() => {
              setRightMaximized(false);
              setWorkspaceCollapsed(true);
            }}
          >
            <div className={cn("h-full", activeRightTabId !== OVERVIEW_TAB_ID && "hidden")}>
              <OverviewPanel
                messages={displayMessages}
                taskPlan={taskPlan}
                deliverablesAction={
                  <DeliverablesRangeFilter
                    value={deliverablesRange}
                    onChange={setDeliverablesRange}
                  />
                }
                deliverables={
                  <WorkspacePanel
                    files={[]}
                    sessionFiles={deliverablesFilesForPanel}
                    scope={workspaceScope}
                    sessionKey={sessionKey}
                    ownerKey={`${artifactOwnerKey}:deliverables`}
                    error={artifacts.error}
                    onRefresh={artifacts.refresh}
                    onDelete={handleDeleteArtifact}
                    onRename={handleRenameArtifact}
                    outputDir={
                      isProjectSession ? session?.workspace ?? null : sharedOutputDir
                    }
                    embedded
                    listOnly="session"
                  />
                }
                processArtifacts={
                  <WorkspacePanel
                    files={[]}
                    taskFiles={taskFilesForPanel}
                    scope={workspaceScope}
                    sessionKey={sessionKey}
                    ownerKey={`${artifactOwnerKey}:process`}
                    error={artifacts.error}
                    onRefresh={artifacts.refresh}
                    onDelete={handleDeleteArtifact}
                    onRename={handleRenameArtifact}
                    outputDir={isProjectSession ? session?.workspace ?? null : sharedOutputDir}
                    embedded
                    listOnly="task"
                  />
                }
              />
            </div>
            {toolTabs.some((tab) => tab.id === SIDEBAR_WORKSPACE_TAB_ID) ? (
              <div className={cn("flex h-full flex-col", activeRightTabId !== SIDEBAR_WORKSPACE_TAB_ID && "hidden")}>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <WorkspacePanel
                    files={workspaceFiles}
                    scope={workspaceScope}
                    sessionKey={sessionKey}
                    ownerKey={`${artifactOwnerKey}:workspace`}
                    error={artifacts.error}
                    loading={artifacts.loading}
                    truncated={artifacts.truncated}
                    onRefresh={artifacts.refresh}
                    onDelete={handleDeleteArtifact}
                    onRename={handleRenameArtifact}
                    outputDir={isProjectSession ? session?.workspace ?? null : sharedOutputDir}
                    embedded
                    listOnly="workspace"
                  />
                </div>
              </div>
            ) : null}
            {toolTabs.some((tab) => tab.id === SIDEBAR_BROWSER_TAB_ID) && activeRightTabId === SIDEBAR_BROWSER_TAB_ID ? (
              <div className="h-full">
                <SidebarBrowserPanel
                  session={session}
                  visible={sidebarBrowserVisible}
                  layoutVersion={`${rightMaximized}:${splitRatio}`}
                  controller={sidebarBrowser}
                />
              </div>
            ) : null}
            {toolTabs.some((tab) => tab.id === SIDEBAR_TERMINAL_TAB_ID) ? (
              <div className={cn("h-full bg-background", activeRightTabId !== SIDEBAR_TERMINAL_TAB_ID && "hidden")}>
                <Suspense fallback={<div className="h-full animate-pulse bg-muted/30" />}>
                  <SidebarTerminalPanel
                    sessionId={toolTabs.find((tab) => tab.id === SIDEBAR_TERMINAL_TAB_ID)?.terminalSessionId}
                    status={toolTabs.find((tab) => tab.id === SIDEBAR_TERMINAL_TAB_ID)?.terminalStatus}
                    error={toolTabs.find((tab) => tab.id === SIDEBAR_TERMINAL_TAB_ID)?.terminalError}
                    onRetry={() => startSidebarTerminal(SIDEBAR_TERMINAL_TAB_ID)}
                  />
                </Suspense>
              </div>
            ) : null}
            {sessionKey ? Object.values(officeSessions).map((officeSession) => {
              const tabId = `office:${officeSession.sessionId}`;
              return (
                <div key={officeSession.sessionId} className={cn("h-full", activeRightTabId !== tabId && "hidden")}>
                  <Suspense fallback={<div className="h-full animate-pulse bg-muted/30" />}>
                    <OfficeEditorHost
                      initialSession={officeSession}
                      ownerSessionKey={sessionKey}
                      generating={isStreaming}
                      stopping={stopping}
                      onAiRequest={handleOfficeAiRequest}
                      toolbarContainer={activeRightTabId === tabId ? officeToolbarContainer : null}
                      onClosed={(closedSessionId) => {
                        forgetOfficeSession(sessionKey, closedSessionId);
                        setOfficeSessions((current) => {
                          const next = { ...current };
                          delete next[closedSessionId];
                          return next;
                        });
                        setRightTabOrder((current) => current.filter((item) => item !== `office:${closedSessionId}`));
                        setActiveRightTabId((current) => current === `office:${closedSessionId}` ? OVERVIEW_TAB_ID : current);
                      }}
                      exportDirectory={isProjectSession ? session?.workspace ?? sharedOutputDir : sharedOutputDir}
                      onExported={() => void artifacts.refresh()}
                    />
                  </Suspense>
                </div>
              );
            }) : null}
            {conversationCanvases.tabs.map((canvas) => (
              <div
                key={canvas.id}
                className={cn("h-full", activeRightTabId !== canvas.id && "hidden")}
              >
                <Suspense fallback={<div className="h-full animate-pulse bg-muted/30" />}>
                  <ConversationCanvasPanel
                    canvas={canvas}
                    onContentChange={conversationCanvases.updateCanvasContent}
                  />
                </Suspense>
              </div>
            ))}
            {previewTabs.map((tab) => (
              <div
                key={tab.id}
                data-preview-tab-id={tab.id}
                className={cn("flex h-full min-h-0 flex-col", activeRightTabId !== tab.id && "hidden")}
              >
                <FilePreviewPanel
                  files={previewNavFiles}
                  embedded
                  previewFile={tab.file}
                  previewScope={workspaceScope}
                  previewSessionKey={sessionKey}
                  onOfficeOpened={(nextSession) => openOfficeEditor(nextSession, tab.id)}
                  onOfficeExported={() => void artifacts.refresh()}
                  officeExportDirectory={isProjectSession ? session?.workspace ?? sharedOutputDir : sharedOutputDir}
                />
              </div>
            ))}
          </ArtifactSidebar>
        )
      }
      ratio={splitRatio}
      onRatioChange={setSplitRatio}
      rightVisible={isRoomSession ? showRoomPanel || !!previewFile : rightVisible || showRoomPanel}
      rightMaximized={!isRoomSession && rightMaximized}
      keepRightMounted={!isRoomSession && (conversationCanvases.tabs.length > 0 || Object.keys(officeSessions).length > 0)}
      onLeftPaneNarrow={collapseSessionListForNarrowPane}
      />
      <AlertDialog
        open={branchCandidate !== null}
        onOpenChange={(open) => {
          if (!open && !branching) setBranchCandidate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("message.branchDialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("message.branchDialogDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-2 gap-2 sm:justify-center sm:space-x-0">
            <Button
              disabled={branching}
              onClick={() => void confirmBranchMessage()}
              className="rounded-full px-8"
            >
              {branching ? t("message.branchingTask") : t("message.confirmBranchTask")}
            </Button>
            <AlertDialogCancel disabled={branching} className="rounded-full px-8">
              {t("common.cancel", { defaultValue: "取消" })}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
