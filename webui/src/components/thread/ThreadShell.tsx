import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Users } from "lucide-react";

import { AgentLogo } from "@/components/AgentLogo";
import { AgentAvatar } from "@/components/room/AgentAvatar";
import { RoomContextPanel } from "@/components/room/RoomContextPanel";
import { useAgents } from "@/components/room/useAgents";
import { ThreadComposer, type ComposerAttachment, type ComposerModelOption } from "@/components/thread/ThreadComposer";
import { ThreadHeader } from "@/components/thread/ThreadHeader";
import { StreamErrorNotice } from "@/components/thread/StreamErrorNotice";
import { ThreadViewport } from "@/components/thread/ThreadViewport";
import { NewChatDashboard } from "@/components/thread/NewChatDashboard";
import { readFileAsDataUrl } from "@/components/doc/office/useDocDrop";
import { SplitPane } from "@/components/deliver/SplitPane";
import { FilePreviewPanel } from "@/components/deliver/FilePreviewPanel";
import { WorkspacePanel, flattenFilesForDisplay } from "@/components/deliver/WorkspacePanel";
import { useFilePreviewStore, type PreviewScope, isArtifactTombstoned, normalizeArtifactPath } from "@/components/deliver/filePreviewStore";
import { useMonaStream, type SendImage, type SendOptions } from "@/hooks/useMonaStream";
import { usePendingQueue } from "@/hooks/usePendingQueue";
import { useSessionHistory } from "@/hooks/useSessions";
import { useArtifacts } from "@/hooks/useArtifacts";
import { fetchSettings, fetchZenFreeModels, listSlashCommands, updateSettings } from "@/lib/api";
import type { ChatSummary, DeliveredFile, RoomAgentInfo, SettingsPayload, SlashCommand, ToolProgressEvent, UIMessage, WorkflowRun } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { normalizeLegacyLongTaskMessages } from "@/lib/thread-display-compat";
import { scrubSubagentUiMessages } from "@/lib/subagent-channel-display";
import { useClient } from "@/providers/ClientProvider";
import { useScheduleStore } from "@/components/schedule/scheduleStore";
import { useEmailStore } from "@/components/email/store/emailStore";
import { deriveTitle } from "@/lib/format";
import { cn } from "@/lib/utils";

function projectWebuiThreadMessages(messages: UIMessage[]): UIMessage[] {
  return scrubSubagentUiMessages(normalizeLegacyLongTaskMessages(messages));
}

export function buildComposerProviderOptions(settings: SettingsPayload): ComposerModelOption[] {
  return (settings.chat_providers ?? [])
    .filter((provider) => provider.configured)
    .slice()
    .sort((a, b) =>
      Number(b.name === settings.agent.provider) - Number(a.name === settings.agent.provider)
      || Number(Boolean(a.is_builtin)) - Number(Boolean(b.is_builtin)),
    )
    .flatMap((provider) => provider.models
      .filter((model) => model.enabled)
      .map((model) => ({
        provider: provider.name,
        providerLabel: provider.label,
        model: model.id,
        label: provider.is_builtin ? model.name.replace(/-free$/, "") : model.name,
        free: Boolean(provider.is_builtin),
        active: provider.name === settings.agent.provider && model.id === settings.agent.model,
      })));
}

const WORKSPACE_DELIVERABLE_EXTS = new Set([
  // Web / docs
  ".html", ".htm", ".md", ".pdf",
  // Office
  ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt",
  // Images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
  // Data
  ".json", ".yaml", ".yml", ".toml", ".csv",
]);

function isWorkspaceDeliverable(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return false;
  return WORKSPACE_DELIVERABLE_EXTS.has(fileName.slice(dot).toLowerCase());
}

function artifactIdentity(file: DeliveredFile): string {
  return (
    file.artifact_ref?.relative_path ||
    file.path ||
    file.absolute_path ||
    file.name
  );
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

interface ThreadShellProps {
  session: ChatSummary | null;
  title: string;
  onToggleSidebar: () => void;
  onGoHome?: () => void;
  onOpenSSH?: () => void;
  onOpenDb?: () => void;
  onOpenEmail?: () => void;
  onCreateNote?: () => void;
  recentSessions?: ChatSummary[];
  onSelectSession?: (key: string) => void;
  onCreateChat?: (workspace?: string | null) => Promise<string | null>;
  /** Direct Agent selected before a chat exists; persisted on first send. */
  pendingDirectAgentId?: string | null;
  onCreateDirectChat?: (agentId: string, workspace?: string | null) => Promise<string | null>;
  onTurnEnd?: () => void;
  queuedPrompt?: QueuedPrompt | null;
  onQueuedPromptConsumed?: (id: string) => void;
  hideSidebarToggleOnDesktop?: boolean;
  showHeader?: boolean;
  onModelNameChange?: (modelName: string | null) => void;
  onOpenSettings?: (section?: string) => void;
}

function toModelBadgeLabel(modelName: string | null): string | null {
  if (!modelName) return null;
  const trimmed = modelName.trim();
  if (!trimmed) return null;
  const leaf = trimmed.split("/").pop() ?? trimmed;
  return leaf || trimmed;
}

interface PendingFirstMessage {
  content: string;
  images?: SendImage[];
  options?: SendOptions;
}

interface QueuedPrompt {
  id: string;
  content: string;
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
  onOpenSSH,
  onOpenDb,
  onOpenEmail,
  onCreateNote,
  recentSessions = [],
  onSelectSession,
  onCreateChat,
  pendingDirectAgentId = null,
  onCreateDirectChat,
  onTurnEnd,
  queuedPrompt,
  onQueuedPromptConsumed,
  hideSidebarToggleOnDesktop = false,
  showHeader = true,
  onModelNameChange,
  onOpenSettings,
}: ThreadShellProps) {
  const { t, i18n } = useTranslation();
  const chatId = session?.chatId ?? null;
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
  // Whether the active model preset accepts image input. ``supports_vision``
  // is tri-state server-side; only an explicit ``false`` disables upload.
  const [imageInputEnabled, setImageInputEnabled] = useState(true);
  const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0);
  const [focusMessage, setFocusMessage] = useState<{ id: string; requestId: number } | null>(null);
  const pendingFirstRef = useRef<PendingFirstMessage | null>(null);
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
    runStartedAt,
    goalState,
    send,
    inject,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMonaStream(chatId, initial, hasPendingToolCalls, handleTurnEnd);

  const pendingQueue = usePendingQueue();

  useEffect(() => {
    setAttachedDocuments([]);
    setDocumentUploadError(null);
    setDocumentsUploading(false);
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

  useEffect(() => {
    if (chatId && historyKey) sessionKeyByChatIdRef.current.set(chatId, historyKey);
  }, [chatId, historyKey]);

  const displayMessages = useMemo(() => projectWebuiThreadMessages(messages), [messages]);
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

  const showHeroComposer = messages.length === 0 && !loading;
  const scheduleItems = useScheduleStore((s) => s.items);
  const loadScheduleItems = useScheduleStore((s) => s.loadItems);
  const emailUnreadCount = useEmailStore((s) => s.totalUnreadCount);
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
      if (updatedChatId !== chatId) return;
      if (scope === "metadata") return;
      pendingCanonicalHydrateRef.current.add(chatId);
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
    setScrollToBottomSignal((value) => value + 1);
    send(pending.content, pending.images, pending.options);
    setBooting(false);
  }, [chatId, send]);

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
    (async () => {
      try {
        const settings = await fetchSettings(token);
        if (!cancelled) {
          const options = buildComposerProviderOptions(settings);
          setProviderOptions(options);
          const activePreset = settings.model_presets.find((p) => p.active);
          setImageInputEnabled(activePreset?.capabilities?.supports_vision !== false);
          if (settings.runtime?.workspace_path) {
            setWorkspacePath(settings.runtime.workspace_path);
          }
          try {
            await fetchZenFreeModels(token);
            const refreshed = await fetchSettings(token);
            if (!cancelled) {
              setProviderOptions(buildComposerProviderOptions(refreshed));
              const refreshedPreset = refreshed.model_presets.find((preset) => preset.active);
              setImageInputEnabled(refreshedPreset?.capabilities?.supports_vision !== false);
              onModelNameChange?.(refreshed.agent.model || null);
            }
          } catch (error) {
            console.error("Failed to refresh built-in free models:", error);
          }
        }
      } catch {
        if (!cancelled) setProviderOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, setWorkspacePath, onModelNameChange]);

  const handleModelSwitch = useCallback(
    async (provider: string, model: string) => {
      try {
        const payload = await updateSettings(token, {
          provider,
          model: model || undefined,
          providerModel: model || undefined,
        });
        const newModel = payload.agent.model || null;
        onModelNameChange?.(newModel);
        const activePreset = payload.model_presets?.find(
          (p: { active: boolean }) => p.active,
        );
        setImageInputEnabled(activePreset?.capabilities?.supports_vision !== false);
        if (payload.chat_providers) {
          const options = buildComposerProviderOptions(payload);
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
  const directAgentId = conversation?.type === "direct"
    ? conversation.directAgentId?.trim() || null
    : pendingDirectAgentId?.trim() || null;
  const isPartnerNewChat = showHeroComposer && !!directAgentId && directAgentId !== "mona";
  const partnerAgent = directAgentId ? agentsById.get(directAgentId) : undefined;
  const partnerAgentName = partnerAgent?.displayName ?? directAgentId ?? "Mona";
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
        pendingQueue.enqueue(content);
        return;
      }
      setScrollToBottomSignal((value) => value + 1);
      const docPaths = attachedDocuments.map((document) => document.path);
      send(content, _images, docPaths.length > 0 ? {
        ..._options,
        docPaths,
        displayContent: _options?.displayContent
          ?? `${content}\n\n[已附文件: ${attachedDocuments.map((document) => document.name).join(", ")}]`,
      } : _options);
      setAttachedDocuments([]);
    },
    [attachedDocuments, isStreaming, pendingQueue, send],
  );

  const handlePendingAppend = useCallback(
    (id: string) => {
      const msg = pendingQueue.messages.find((m) => m.id === id);
      if (!msg) return;
      inject(msg.content);
      pendingQueue.remove(id);
    },
    [inject, pendingQueue],
  );

  useEffect(() => {
    if (!queuedPrompt || !chatId || booting || isStreaming) return;
    if (consumedQueuedPromptRef.current === queuedPrompt.id) return;

    consumedQueuedPromptRef.current = queuedPrompt.id;
    setScrollToBottomSignal((value) => value + 1);
    send(queuedPrompt.content);
    onQueuedPromptConsumed?.(queuedPrompt.id);
  }, [booting, chatId, isStreaming, onQueuedPromptConsumed, queuedPrompt, send]);

  const composerPlaceholder = showHeroComposer
    ? "问任何问题、运行终端、查笔记、维护 Windows..."
    : t("thread.composer.placeholderThread");

  const openingPlaceholder = booting
    ? t("thread.composer.placeholderOpening")
    : composerPlaceholder;

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
          disabled={!chatId}
          isStreaming={isStreaming}
          placeholder={composerPlaceholder}
          modelLabel={toModelBadgeLabel(modelName)}
          modelOptions={activeModelOptions}
          onModelSwitch={handleModelSwitch}
          imageInputEnabled={imageInputEnabled}
          variant={showHeroComposer ? "hero" : "thread"}
          showHeroPromptChips={!isPartnerNewChat}
          slashCommands={slashCommands}
          onStop={stop}
          runStartedAt={runStartedAt}
          goalState={goalState}
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
        />
      ) : (
        <ThreadComposer
          onSend={handleWelcomeSend}
          disabled={booting}
          isStreaming={isStreaming}
          placeholder={openingPlaceholder}
          modelLabel={toModelBadgeLabel(modelName)}
          modelOptions={activeModelOptions}
          onModelSwitch={handleModelSwitch}
          imageInputEnabled={imageInputEnabled}
          variant="hero"
          slashCommands={slashCommands}
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

  const mailMessages = useEmailStore((s) => s.messages);
  const unreadMails = useMemo(
    () =>
      mailMessages
        .filter((message) => !message.isRead)
        .slice(0, 2)
        .map((message) => ({
          sender: message.fromName?.trim() || message.fromAddress,
          subject: message.subject,
        })),
    [mailMessages],
  );

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
      className="relative w-full overflow-hidden rounded-xl bg-card/80 px-5 py-6 [clip-path:polygon(0_0,calc(100%_-_12px)_0,100%_12px,100%_100%,0_100%)] md:px-9 md:py-8"
    >
      <div className="relative z-10 mb-8 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            data-testid="mona-brand-marker"
            className="h-0.5 w-6 rounded-full bg-[hsl(var(--brand-red))]"
          />
          <span className="text-micro font-semibold tracking-widest text-foreground/80">
            MONA
          </span>
          <span className="text-micro tracking-widest text-muted-foreground/65">
            WORKSPACE
          </span>
        </div>
      </div>
      <div className="relative z-10 grid w-full grid-cols-1 gap-y-10 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex motion-safe:animate-in fill-mode-backwards fade-in-0 slide-in-from-bottom-3 flex-col items-start text-left duration-arrival md:pr-14">
          <div className="relative motion-safe:animate-in fill-mode-backwards zoom-in-95 duration-arrival">
            <AgentLogo state={isStreaming ? "working" : "welcome"} className="h-16 w-16" />
          </div>
          <div className="mt-7 text-clock font-extralight leading-none tracking-tight tabular-nums text-foreground">
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
          unreadCount={emailUnreadCount}
          unreadMails={unreadMails}
          recentSession={recentSession}
          disabled={booting || isStreaming}
          onContinue={onSelectSession}
          onConnectHost={onOpenSSH}
          onConnectDatabase={onOpenDb}
          onCreateNote={onCreateNote}
          onOpenEmail={onOpenEmail}
        />
      </div>
    </div>
  );

  const previewFile = useFilePreviewStore((s) => s.file);
  const splitRatio = useFilePreviewStore((s) => s.splitRatio);
  const setSplitRatio = useFilePreviewStore((s) => s.setSplitRatio);
  const workspaceCollapsed = useFilePreviewStore((s) => s.workspaceCollapsed);
  const setWorkspaceCollapsed = useFilePreviewStore(
    (s) => s.setWorkspaceCollapsed,
  );
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // Rooms are a separate projection: they never fall back to an Agent's
  // workspace. Project sessions keep their bound root; ordinary Agent
  // sessions use the active Agent's durable output directory.
  const isRoomSession = conversation?.type === "room";
  const isProjectSession = !isRoomSession && !!session?.workspace;
  const sessionKey = session?.key ?? null;
  const isHome = !session;
  const workspaceScope: PreviewScope = isRoomSession
    ? "room"
    : isProjectSession
      ? "project"
      : "shared";

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
    `${historyKey ?? "home"}-${artifactsRefreshSignal}`,
    {
      scope: workspaceScope,
      sessionKey: isRoomSession ? null : sessionKey,
      room: isRoomSession ? chatId : null,
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

  // Aggregate all delivered files produced during the session.
  // Includes both explicit deliver_file calls and files written/edited by AI
  // tools (write_file, apply_patch, etc.) that are previewable deliverables.
  // For non-project sessions these act as live events merged with the
  // authoritative shared-output scan; for project sessions they are the
  // only data source.
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
      if (m.fileEdits?.length) {
        for (const edit of m.fileEdits) {
          if (edit.status !== "done") continue;
          if (!edit.absolute_path && !edit.path) continue;
          const name = (edit.path || edit.absolute_path || "").split(/[\\/]/).pop() || "";
          if (!isWorkspaceDeliverable(name)) continue;
          push({
            path: edit.path,
            absolute_path: edit.absolute_path || edit.path,
            name,
            size: 0,
            size_human: "",
            mime: "",
            artifact_ref: edit.artifact_ref,
          });
        }
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
    for (const f of artifacts.files) {
      keys.add(normalizeArtifactPath(artifactIdentity(f)));
    }
    return keys;
  }, [artifacts.files]);
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

  // Pick the authoritative data source for the workspace panel. The server
  // separates persisted session references from the Agent scan; live message
  // events are only a short-lived supplement until the next refresh.
  const workspaceFiles = useMemo(() => {
    if (isRoomSession) return artifacts.files;
    if (isProjectSession) return artifacts.files;
    const out: DeliveredFile[] = [];
    const seen = new Set<string>();
    const push = (file: DeliveredFile) => {
      const key = artifactIdentity(file);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(file);
    };
    const sessionKeys = new Set(
      [...artifacts.sessionFiles, ...visibleMessageFiles].map((f) =>
        normalizeArtifactPath(
          f.artifact_ref?.relative_path || f.path || f.absolute_path || f.name,
        ),
      ),
    );
    for (const f of artifacts.files) push(f);
    // Older servers may still return session files in ``files``; hide them
    // by identity so the UI never duplicates a delivered row.
    if (sessionKeys.size > 0) {
      const filtered = out.filter(
        (f) =>
          !sessionKeys.has(
            normalizeArtifactPath(
              f.artifact_ref?.relative_path || f.path || f.absolute_path || f.name,
            ),
          ),
      );
      return filtered;
    }
    return out;
  }, [isRoomSession, isProjectSession, artifacts.files, artifacts.sessionFiles, visibleMessageFiles]);

  // Session references remain visible even after the file also appears in the
  // workspace scan. Merge scan metadata into the reference row when possible.
  const sessionFilesForPanel = useMemo(() => {
    if (isRoomSession || isProjectSession) return undefined;
    const byPath = new Map(
      artifacts.files.map((f) => [
        normalizeArtifactPath(
          f.artifact_ref?.relative_path || f.path || f.absolute_path || f.name,
        ),
        f,
      ]),
    );
    const out: DeliveredFile[] = [];
    const seen = new Set<string>();
    for (const f of [...artifacts.sessionFiles, ...visibleMessageFiles]) {
      const key = normalizeArtifactPath(
        f.artifact_ref?.relative_path || f.path || f.absolute_path || f.name,
      );
      if (seen.has(key)) continue;
      seen.add(key);
      const scanned = byPath.get(key);
      out.push(scanned ? { ...scanned, artifact_ref: f.artifact_ref ?? scanned.artifact_ref } : f);
    }
    return out;
  }, [isRoomSession, isProjectSession, artifacts.files, artifacts.sessionFiles, visibleMessageFiles]);

  const hasFiles = workspaceFiles.length > 0;
  // Preview prev/next cycles in the same visual order the workspace panel
  // displays: flat session section first, then the sorted artifact tree.
  const previewNavFiles = useMemo(
    () =>
      flattenFilesForDisplay(
        workspaceFiles,
        isRoomSession || isProjectSession ? [] : sessionFilesForPanel ?? [],
      ),
    [isRoomSession, isProjectSession, workspaceFiles, sessionFilesForPanel],
  );
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
    !!previewFile ||
    messageFiles.length > 0;
  const rightVisible =
    !isHome && !workspaceCollapsed && (hasPreviewTarget || emptyPanelExpanded);

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

  // Live tool activity of step jobs, keyed ``runId:stepId``. Each frame is a
  // full snapshot of the step's accumulator, so the latest one wins; the
  // map resets on session switch so cards never show another room's trail.
  const [stepActivities, setStepActivities] = useState<Record<string, ToolProgressEvent[]>>({});
  useEffect(() => {
    setStepActivities({});
  }, [historyKey]);
  useEffect(() => {
    if (!chatId || !isRoomSession) return;
    return client.onWorkflowStepActivity((updatedChatId, payload) => {
      if (updatedChatId !== chatId) return;
      setStepActivities((prev) => ({
        ...prev,
        [`${payload.runId}:${payload.stepId}`]: payload.toolEvents,
      }));
    });
  }, [chatId, isRoomSession, client]);

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
      artifacts.refresh();
    },
    [artifacts, markArtifactDeleted],
  );

  return (
    <SplitPane
      left={
        <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {showHeader ? (
            <ThreadHeader
              title={title}
              onToggleSidebar={onToggleSidebar}
              hideSidebarToggleOnDesktop={hideSidebarToggleOnDesktop}
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
              workspaceHasContent={isRoomSession ? true : hasPreviewTarget || !!previewFile}
              messages={transcriptMessages}
              onJumpToMessage={jumpToMessage}
            />
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
            stepActivities={stepActivities}
          />
        </section>
      }
      right={
        previewFile ? (
          <FilePreviewPanel files={previewNavFiles} />
        ) : showRoomPanel && conversation && chatId ? (
          <RoomContextPanel
            chatId={chatId}
            conversation={conversation}
          />
        ) : isRoomSession ? null : (
          <WorkspacePanel
            files={workspaceFiles}
            sessionFiles={sessionFilesForPanel}
            scope={workspaceScope}
            sessionKey={sessionKey}
            ownerKey={artifactOwnerKey}
            error={artifacts.error}
            truncated={artifacts.truncated}
            onRefresh={artifacts.refresh}
            onCollapse={() => setWorkspaceCollapsed(true)}
            onDelete={handleDeleteArtifact}
            outputDir={
              isProjectSession ? session?.workspace ?? null : sharedOutputDir
            }
          />
        )
      }
      ratio={splitRatio}
      onRatioChange={setSplitRatio}
      rightVisible={isRoomSession ? showRoomPanel || !!previewFile : rightVisible || showRoomPanel}
    />
  );
}
