import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { AgentLogo } from "@/components/AgentLogo";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { ThreadHeader } from "@/components/thread/ThreadHeader";
import { StreamErrorNotice } from "@/components/thread/StreamErrorNotice";
import { ThreadViewport } from "@/components/thread/ThreadViewport";
import { NewChatDashboard } from "@/components/thread/NewChatDashboard";
import { SplitPane } from "@/components/deliver/SplitPane";
import { FilePreviewPanel } from "@/components/deliver/FilePreviewPanel";
import { useFilePreviewStore } from "@/components/deliver/filePreviewStore";
import { useMonaStream, type SendImage, type SendOptions } from "@/hooks/useMonaStream";
import { usePendingQueue } from "@/hooks/usePendingQueue";
import { useSessionHistory } from "@/hooks/useSessions";
import { fetchSettings, fetchZenFreeModels, listSlashCommands, updateSettings } from "@/lib/api";
import type { ChatSummary, DeliveredFile, SlashCommand, UIMessage } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/workspace-store";
import { normalizeLegacyLongTaskMessages } from "@/lib/thread-display-compat";
import { scrubSubagentUiMessages } from "@/lib/subagent-channel-display";
import { useClient } from "@/providers/ClientProvider";
import { useKbStore } from "@/stores/kb-store";
import { retrieveKbContext, buildKbSystemPrompt } from "@/lib/kb-rag";
import { setKbToken } from "@/lib/kb-api";
import { useScheduleStore } from "@/components/schedule/scheduleStore";
import { useEmailStore } from "@/components/email/store/emailStore";
import { deriveTitle } from "@/lib/format";

function projectWebuiThreadMessages(messages: UIMessage[]): UIMessage[] {
  return scrubSubagentUiMessages(normalizeLegacyLongTaskMessages(messages));
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
  const { t } = useTranslation();
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
  const kbProjectsRaw = useKbStore((s) => s.projects);
  const loadKbProjects = useKbStore((s) => s.loadProjects);
  useEffect(() => {
    setKbToken(token);
    void loadKbProjects();
  }, [loadKbProjects, token]);
  const kbProjects = useMemo(
    () => kbProjectsRaw.map((p) => ({ id: p.id, name: p.name })),
    [kbProjectsRaw],
  );
  const selectedKbForChat = useKbStore((s) => s.selectedKbForChat);
  const setSelectedKbForChat = useKbStore((s) => s.setSelectedKbForChat);
  const selectedKbProjectName = useKbStore(
    (s) => {
      const p = s.projects.find((p) => p.id === s.selectedKbForChat);
      if (p) return p.name;
      return null;
    },
  );
  const [booting, setBooting] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [imageMode, setImageMode] = useState(false);
  const [videoMode, setVideoMode] = useState(false);
  const [providerOptions, setProviderOptions] = useState<
    Array<{ name: string; label: string; free_default_model?: string | null; model?: string | null }>
  >([]);
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
  const handleTurnEnd = useCallback(() => {
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

  const injectKbContext = useCallback(
    async (content: string): Promise<string> => {
      if (!selectedKbForChat) return content;
      try {
        const ragContext = await retrieveKbContext(selectedKbForChat, content);
        if (ragContext) {
          const systemPrompt = buildKbSystemPrompt(ragContext);
          return `${systemPrompt}\n\n---\n\n${content}`;
        }
      } catch (err) {
        console.warn("[ThreadShell] KB RAG retrieval failed:", err);
      }
      return content;
    },
    [selectedKbForChat],
  );

  const handleWelcomeSend = useCallback(
    async (content: string, images?: SendImage[], options?: SendOptions) => {
      if (booting) return;
      setBooting(true);
      const finalContent = await injectKbContext(content);
      pendingFirstRef.current = { content: finalContent, images, options };
      const newId = await onCreateChat?.(selectedWorkspace);
      if (!newId) {
        pendingFirstRef.current = null;
        setBooting(false);
      }
      // Clear the transient workspace selection after creating the chat.
      setSelectedWorkspace(null);
    },
    [booting, onCreateChat, injectKbContext, selectedWorkspace],
  );

  const handleThreadSend = useCallback(
    async (content: string, _images?: SendImage[], _options?: SendOptions) => {
      if (isStreaming) {
        pendingQueue.enqueue(content);
        return;
      }
      setScrollToBottomSignal((value) => value + 1);
      const finalContent = await injectKbContext(content);
      send(finalContent, _images, _options);
    },
    [isStreaming, pendingQueue, send, injectKbContext],
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
          variant={showHeroComposer ? "hero" : "thread"}
          slashCommands={slashCommands}
          imageMode={imageMode}
          onImageModeChange={setImageMode}
          videoMode={videoMode}
          onVideoModeChange={setVideoMode}
          onStop={stop}
          runStartedAt={runStartedAt}
          goalState={goalState}
          pendingMessages={pendingQueue.messages}
          onPendingAppend={handlePendingAppend}
          onPendingRemove={pendingQueue.remove}
          onPendingEdit={pendingQueue.update}
          isPendingFull={pendingQueue.messages.length >= 3}
          kbProjectId={selectedKbForChat}
          kbProjectName={selectedKbProjectName}
          kbProjects={kbProjects.length > 0 ? kbProjects : undefined}
          onKbSelect={setSelectedKbForChat}
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
          variant="hero"
          slashCommands={slashCommands}
          imageMode={imageMode}
          onImageModeChange={setImageMode}
          videoMode={videoMode}
          onVideoModeChange={setVideoMode}
          runStartedAt={runStartedAt}
          goalState={goalState}
          pendingMessages={pendingQueue.messages}
          onPendingAppend={handlePendingAppend}
          onPendingRemove={pendingQueue.remove}
          onPendingEdit={pendingQueue.update}
          isPendingFull={pendingQueue.messages.length >= 3}
          kbProjectId={selectedKbForChat}
          kbProjectName={selectedKbProjectName}
          kbProjects={kbProjects.length > 0 ? kbProjects : undefined}
          onKbSelect={setSelectedKbForChat}
          workspace={selectedWorkspace}
          onWorkspaceChange={setSelectedWorkspace}
          onOpenSettings={onOpenSettings}
        />
      )}
    </>
  );

  const emptyState = loading ? (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {t("thread.loadingConversation")}
    </div>
  ) : (
    <div className="flex w-full flex-col items-center text-center animate-in fade-in-0 slide-in-from-bottom-2 duration-500">
      <AgentLogo state="welcome" className="mb-4 h-16 w-16 opacity-90" />
      <h1 className="text-balance text-[40px] font-normal leading-tight tracking-[-0.045em] text-foreground sm:text-[48px]">
        {t("thread.empty.greeting")}
      </h1>
      <NewChatDashboard
        scheduleItems={scheduleItems}
        unreadCount={emailUnreadCount}
        recentSession={recentSession}
        disabled={booting || isStreaming}
        onContinue={onSelectSession}
        onConnectHost={onOpenSSH}
        onConnectDatabase={onOpenDb}
        onCreateNote={onCreateNote}
      />
    </div>
  );

  const previewFile = useFilePreviewStore((s) => s.file);
  const splitRatio = useFilePreviewStore((s) => s.splitRatio);
  const setSplitRatio = useFilePreviewStore((s) => s.setSplitRatio);

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
            />
          ) : null}
          <ThreadViewport
            messages={displayMessages}
            isStreaming={isStreaming}
            emptyState={emptyState}
            composer={composer}
            scrollToBottomSignal={scrollToBottomSignal}
            conversationKey={historyKey}
            showScrollToBottomButton={!!session}
          />
        </section>
      }
      right={<FilePreviewPanel />}
      ratio={splitRatio}
      onRatioChange={setSplitRatio}
      rightVisible={!!previewFile}
    />
  );
}
