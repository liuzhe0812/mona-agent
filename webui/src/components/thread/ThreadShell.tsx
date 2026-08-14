import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelRightOpen } from "lucide-react";

import { AgentLogo } from "@/components/AgentLogo";
import { RoomContextPanel } from "@/components/room/RoomContextPanel";
import { useAgents } from "@/components/room/useAgents";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { ThreadHeader } from "@/components/thread/ThreadHeader";
import { StreamErrorNotice } from "@/components/thread/StreamErrorNotice";
import { ThreadViewport } from "@/components/thread/ThreadViewport";
import { NewChatDashboard } from "@/components/thread/NewChatDashboard";
import { SplitPane } from "@/components/deliver/SplitPane";
import { FilePreviewPanel } from "@/components/deliver/FilePreviewPanel";
import { WorkspacePanel, flattenFilesForDisplay } from "@/components/deliver/WorkspacePanel";
import { useFilePreviewStore, type PreviewScope, isArtifactTombstoned, normalizeArtifactPath } from "@/components/deliver/filePreviewStore";
import { useMonaStream, type SendImage, type SendOptions } from "@/hooks/useMonaStream";
import { usePendingQueue } from "@/hooks/usePendingQueue";
import { useSessionHistory } from "@/hooks/useSessions";
import { useArtifacts } from "@/hooks/useArtifacts";
import { fetchSettings, fetchZenFreeModels, listSlashCommands, updateSettings } from "@/lib/api";
import type { ChatSummary, DeliveredFile, RoomAgentInfo, SlashCommand, UIMessage } from "@/lib/types";
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
  onTurnEnd?: () => void;
  queuedPrompt?: QueuedPrompt | null;
  onQueuedPromptConsumed?: (id: string) => void;
  theme?: "light" | "dark";
  onToggleTheme?: () => void;
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
  onTurnEnd,
  queuedPrompt,
  onQueuedPromptConsumed,
  theme = "light",
  onToggleTheme = () => {},
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
  const [booting, setBooting] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [providerOptions, setProviderOptions] = useState<
    Array<{ name: string; label: string; free_default_model?: string | null; model?: string | null }>
  >([]);
  // Whether the active model preset accepts image input. ``supports_vision``
  // is tri-state server-side; only an explicit ``false`` disables upload.
  const [imageInputEnabled, setImageInputEnabled] = useState(true);
  const [zenFreeModels, setZenFreeModels] = useState<string[]>([]);
  const [scrollToBottomSignal, setScrollToBottomSignal] = useState(0);
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
          const options = settings.providers
            .filter((p) => p.configured)
            .map((p) => ({
              name: p.name,
              label: p.label,
              free_default_model: p.free_default_model,
              model: p.model,
            }));
          setProviderOptions(options);
          const activePreset = settings.model_presets.find((p) => p.active);
          setImageInputEnabled(activePreset?.capabilities?.supports_vision !== false);
          if (settings.runtime?.workspace_path) {
            setWorkspacePath(settings.runtime.workspace_path);
          }
        }
      } catch {
        if (!cancelled) setProviderOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, setWorkspacePath]);

  useEffect(() => {
    if (providerOptions.length === 0 || zenFreeModels.length > 0 || !token) return;
    const hasZen = providerOptions.some((opt) => opt.free_default_model);
    if (!hasZen) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchZenFreeModels(token);
        if (!cancelled) setZenFreeModels(result.models);
      } catch (e) {
        console.error("Failed to fetch Zen free models:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providerOptions, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleModelSwitch = useCallback(
    async (provider: string, model: string) => {
      try {
        const payload = await updateSettings(token, {
          provider,
          model: model || undefined,
        });
        const newModel = payload.agent.model || null;
        onModelNameChange?.(newModel);
        const activePreset = payload.model_presets?.find(
          (p: { active: boolean }) => p.active,
        );
        setImageInputEnabled(activePreset?.capabilities?.supports_vision !== false);
        // Refresh provider options from the updated settings so the dropdown
        // stays in sync (e.g. the previously-active provider now shows its
        // stored model instead of the old active-model fallback).
        if (payload.providers) {
          const options = payload.providers
            .filter((p: { configured: boolean }) => p.configured)
            .map((p: { name: string; label: string; free_default_model?: string | null; model?: string | null }) => ({
              name: p.name,
              label: p.label,
              free_default_model: p.free_default_model,
              model: p.model,
            }));
          setProviderOptions(options);
        }
      } catch {
        // silently ignore switch errors
      }
    },
    [token, onModelNameChange],
  );

  // Multi-agent: room members offered by the composer ``@`` picker. The
  // registry provides display names; unknown ids degrade to the raw id.
  const agentsById = useAgents(token);
  const mentionableAgents = useMemo<RoomAgentInfo[]>(() => {
    const conv = session?.conversation;
    if (!conv || conv.type !== "room") return [];
    return conv.agentIds.map((id) => {
      const summary = agentsById.get(id);
      return {
        id,
        displayName: summary?.displayName ?? id,
        description: summary?.description ?? "",
      };
    });
  }, [session?.conversation, agentsById]);

  const handleWelcomeSend = useCallback(
    async (content: string, images?: SendImage[], options?: SendOptions) => {
      if (booting) return;
      setBooting(true);
      pendingFirstRef.current = { content, images, options };
      const newId = await onCreateChat?.(selectedWorkspace);
      if (!newId) {
        pendingFirstRef.current = null;
        setBooting(false);
      }
      // Clear the transient workspace selection after creating the chat.
      setSelectedWorkspace(null);
    },
    [booting, onCreateChat, selectedWorkspace],
  );

  const handleThreadSend = useCallback(
    async (content: string, _images?: SendImage[], _options?: SendOptions) => {
      if (isStreaming) {
        pendingQueue.enqueue(content);
        return;
      }
      setScrollToBottomSignal((value) => value + 1);
      send(content, _images, _options);
    },
    [isStreaming, pendingQueue, send],
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
    <>
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
          zenFreeModels={zenFreeModels}
          onModelSwitch={handleModelSwitch}
          imageInputEnabled={imageInputEnabled}
          variant={showHeroComposer ? "hero" : "thread"}
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
        />
      ) : (
        <ThreadComposer
          onSend={handleWelcomeSend}
          disabled={booting}
          isStreaming={isStreaming}
          placeholder={openingPlaceholder}
          modelLabel={toModelBadgeLabel(modelName)}
          modelOptions={activeModelOptions}
          zenFreeModels={zenFreeModels}
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
          onOpenSettings={onOpenSettings}
        />
      )}
    </>
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

  const emptyState = loading ? (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {t("thread.loadingConversation")}
    </div>
  ) : (
    <div className="relative w-full">
      <div aria-hidden className="pointer-events-none absolute -top-32 left-1/2 h-[28rem] w-[52rem] -translate-x-1/2">
        <div className="absolute inset-0 bg-[radial-gradient(closest-side_at_50%_36%,hsl(var(--theme)/0.09),transparent_72%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(closest-side_at_30%_58%,rgba(16,185,129,0.07),transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(closest-side_at_71%_60%,rgba(235,164,93,0.09),transparent_70%)]" />
      </div>
      <div className="relative grid w-full grid-cols-1 gap-y-10 md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex animate-in fill-mode-backwards fade-in-0 slide-in-from-bottom-3 flex-col items-start text-left duration-500 md:pr-14">
          <div className="relative animate-in fill-mode-backwards zoom-in-95 duration-700">
            <div aria-hidden className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,hsl(var(--theme)/0.15),transparent)]" />
            <AgentLogo state="welcome" className="relative h-12 w-12" />
          </div>
          <div className="mt-7 text-[54px] font-extralight leading-none tracking-[-0.03em] tabular-nums text-foreground">
            {clockLine}
          </div>
          <p className="mt-3 text-[13px] tracking-[0.08em] text-muted-foreground">
            {dateLine} · {weekdayLine}
          </p>
          <h1 className="mt-9 text-[24px] font-medium tracking-[-0.01em] text-foreground">
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
  const toggleWorkspaceCollapsed = useFilePreviewStore(
    (s) => s.toggleWorkspaceCollapsed,
  );
  const setWorkspaceCollapsed = useFilePreviewStore(
    (s) => s.setWorkspaceCollapsed,
  );
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);

  // Session type: project sessions read the bound ``metadata.workspace`` as
  // their effective workspace; non-project sessions (and the home screen)
  // operate against the shared ``<workspace>/output/`` directory.
  const isProjectSession = !!session?.workspace;
  const sessionKey = session?.key ?? null;
  const isHome = !session;
  const workspaceScope: PreviewScope = isProjectSession ? "project" : "shared";

  // Authoritative on-disk scan: shared sessions scan ``<workspace>/output/``;
  // project sessions scan the bound project directory (all files — project
  // sessions have no "artifact" concept, the directory IS the list).
  const artifacts = useArtifacts(
    !isHome ? token : null,
    `${historyKey ?? "home"}-${artifactsRefreshSignal}`,
    { scope: workspaceScope, sessionKey: isProjectSession ? sessionKey : null },
  );

  // Rescan when the server pushes ``artifacts_changed`` — the shared output
  // directory changed on disk (possibly from another channel), so the panel
  // tracks reality without a manual refresh click.
  const { refresh: refreshArtifacts } = artifacts;
  useEffect(() => {
    if (isProjectSession || isHome) return;
    return client.onArtifactsChanged(() => refreshArtifacts());
  }, [client, isProjectSession, isHome, refreshArtifacts]);

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
      const key = file.absolute_path || file.path || file.name;
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
  const scanKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const f of artifacts.files) {
      keys.add(normalizeArtifactPath(f.absolute_path || f.path || f.name));
    }
    return keys;
  }, [artifacts.files]);
  const visibleMessageFiles = useMemo(() => {
    if (deletedArtifactPaths.size === 0) return messageFiles;
    return messageFiles.filter((f) => {
      const key = f.absolute_path || f.path || f.name;
      if (!isArtifactTombstoned(key, deletedArtifactPaths)) return true;
      // Scan-authoritative revival: the latest scan sees the file again, so
      // it exists on disk and must not stay hidden by the tombstone.
      return scanKeys.has(normalizeArtifactPath(key));
    });
  }, [messageFiles, deletedArtifactPaths, scanKeys]);

  // Pick the authoritative data source for the workspace panel.
  // - Shared: merge scan results with live events (scan wins on dedup so its
  //   richer metadata — size, mtime, mime — is preferred).
  // - Project: the project directory scan IS the list; message events are
  //   not artifacts and never shown.
  const workspaceFiles = useMemo(() => {
    if (isProjectSession) return artifacts.files;
    const out: DeliveredFile[] = [];
    const seen = new Set<string>();
    const push = (file: DeliveredFile) => {
      const key = file.absolute_path || file.path || file.name;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(file);
    };
    // Scan first so its metadata (size, mtime) wins over the sparse
    // file_edit shape when both reference the same absolute path.
    for (const f of artifacts.files) push(f);
    for (const f of visibleMessageFiles) push(f);
    return out;
  }, [isProjectSession, artifacts.files, visibleMessageFiles]);

  // Session section rows: the scan wins on dedup — a file present in the
  // latest scan renders in the tree with its richer metadata (size, mtime),
  // not as a sparse session row.
  const sessionFilesForPanel = useMemo(() => {
    if (isProjectSession) return undefined;
    return visibleMessageFiles.filter(
      (f) =>
        !scanKeys.has(normalizeArtifactPath(f.absolute_path || f.path || f.name)),
    );
  }, [isProjectSession, visibleMessageFiles, scanKeys]);

  const hasFiles = workspaceFiles.length > 0;
  // Preview prev/next cycles in the same visual order the workspace panel
  // displays: flat session section first, then the sorted artifact tree.
  const previewNavFiles = useMemo(
    () =>
      flattenFilesForDisplay(
        artifacts.files,
        isProjectSession ? [] : visibleMessageFiles,
      ),
    [isProjectSession, artifacts.files, visibleMessageFiles],
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
    hasFiles || !!previewFile || messageFiles.length > 0;
  const rightVisible =
    !isHome && !workspaceCollapsed && (hasPreviewTarget || emptyPanelExpanded);

  // Multi-agent phase 2d: rooms get a context panel (goal / members /
  // workflow summary) sharing the right-hand pane with the workspace panel.
  // It opens by default when a room is entered so the collaboration state
  // stays discoverable; closing it falls back to the workspace panel rules.
  const conversation = session?.conversation ?? null;
  const isRoomSession = conversation?.type === "room";
  const [roomPanelOpen, setRoomPanelOpen] = useState(false);
  useEffect(() => {
    setRoomPanelOpen(conversation?.type === "room");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyKey, conversation?.type]);
  const showRoomPanel = !!isRoomSession && roomPanelOpen && !previewFile;
  const showWorkspaceToggle = !isHome && !rightVisible && !showRoomPanel;

  // New-artifact feedback while collapsed: when the deliverable count
  // grows and the panel is hidden, highlight the edge button until the
  // user expands the panel again. Session switches reset the baseline so
  // a different chat's inventory is not mistaken for new deliveries.
  const [edgeHighlight, setEdgeHighlight] = useState(false);
  const prevWorkspaceCountRef = useRef({ key: historyKey, count: 0 });
  useEffect(() => {
    const count = workspaceFiles.length;
    const prev = prevWorkspaceCountRef.current;
    if (prev.key !== historyKey) {
      prevWorkspaceCountRef.current = { key: historyKey, count };
      setEdgeHighlight(false);
      return;
    }
    if (count > prev.count && !rightVisible) setEdgeHighlight(true);
    prevWorkspaceCountRef.current = { key: historyKey, count };
  }, [workspaceFiles.length, rightVisible, historyKey]);
  useEffect(() => {
    if (rightVisible) setEdgeHighlight(false);
  }, [rightVisible]);

  // Absolute path of the shared output directory (``<workspace>/output``),
  // used by the workspace panel's "open output directory" affordances.
  const sharedOutputDir = useMemo(() => {
    const ws = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
    return ws ? `${ws}/output` : null;
  }, [workspacePath]);

  // Delete a shared-output artifact from disk and trigger a scan refresh so
  // the workspace panel re-reads the directory and drops the row.
  const handleDeleteArtifact = useCallback(
    async (file: DeliveredFile) => {
      const target = file.absolute_path || file.path;
      if (!target) return;
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
              theme={theme}
              onToggleTheme={onToggleTheme}
              hideSidebarToggleOnDesktop={hideSidebarToggleOnDesktop}
              minimal={!session && !loading}
              conversation={conversation}
              onToggleRoomPanel={
                isRoomSession ? () => setRoomPanelOpen((open) => !open) : undefined
              }
            />
          ) : null}
          <ThreadViewport
            messages={transcriptMessages}
            isStreaming={isStreaming}
            emptyState={emptyState}
            composer={composer}
            scrollToBottomSignal={scrollToBottomSignal}
            conversationKey={historyKey}
            showScrollToBottomButton={!!session}
          />
          {showWorkspaceToggle ? (
            <button
              type="button"
              onClick={() => {
                if (hasPreviewTarget) {
                  toggleWorkspaceCollapsed();
                } else {
                  setEmptyPanelExpanded(true);
                  setWorkspaceCollapsed(false);
                }
              }}
              title="展开工作区"
              className={cn(
                "absolute right-0 top-1/2 z-10 -translate-y-1/2",
                "flex flex-col items-center gap-1 rounded-l-md",
                "border border-r-0 border-border/60 bg-popover/95 px-1.5 py-2 shadow-md",
                "text-muted-foreground hover:bg-muted hover:text-foreground",
                "transition-colors",
                edgeHighlight && "text-primary",
              )}
            >
              <PanelRightOpen className="h-4 w-4" />
              {workspaceFiles.length > 0 ? (
                <span className="text-[10px] font-medium">{workspaceFiles.length}</span>
              ) : null}
            </button>
          ) : null}
        </section>
      }
      right={
        previewFile ? (
          <FilePreviewPanel files={previewNavFiles} />
        ) : showRoomPanel && conversation && chatId ? (
          <RoomContextPanel
            chatId={chatId}
            conversation={conversation}
            onCollapse={() => setRoomPanelOpen(false)}
          />
        ) : (
          <WorkspacePanel
            files={artifacts.files}
            sessionFiles={sessionFilesForPanel}
            scope={workspaceScope}
            sessionKey={isProjectSession ? sessionKey : null}
            loading={artifacts.loading}
            error={artifacts.error}
            truncated={artifacts.truncated}
            onRefresh={artifacts.refresh}
            onDelete={handleDeleteArtifact}
            outputDir={
              isProjectSession ? session?.workspace ?? null : sharedOutputDir
            }
          />
        )
      }
      ratio={splitRatio}
      onRatioChange={setSplitRatio}
      rightVisible={rightVisible || showRoomPanel}
    />
  );
}
