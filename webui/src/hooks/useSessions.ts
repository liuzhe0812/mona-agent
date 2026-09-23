import { useCallback, useEffect, useRef, useState } from "react";

import { useClientOptional } from "@/providers/ClientProvider";
import i18n from "@/i18n";
import {
  ApiError,
  deleteSession as apiDeleteSession,
  fetchWebuiThread,
  listSessions,
  updateSessionWorkspace as apiUpdateSessionWorkspace,
} from "@/lib/api";
import { deriveTitle } from "@/lib/format";
import { resolveUIImageUrls, resolveMediaAttachmentUrls } from "@/lib/media";
import type {
  ChatSummary,
  ConversationListStatus,
  UIMessage,
  WebuiThreadPagination,
  WebuiThreadPersistedPayload,
} from "@/lib/types";

const EMPTY_MESSAGES: UIMessage[] = [];

/** Keep startup races recoverable without leaving a request loop running. */
const SESSION_REFRESH_RETRY_DELAYS_MS = [250, 500, 1_000] as const;

function isRetryableSessionListError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function sessionListErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message || `HTTP ${error.status}`;
  if (error instanceof Error && error.message) return error.message;
  return String(error || "Unknown error");
}

/** Client-side fallback for system-managed hidden rooms (stock-module design
 *  §5.1): even if the server ever leaks a ``hidden`` conversation row, the
 *  sidebar must never render it. Applied to every server refresh. */
export function filterVisibleSessions(rows: ChatSummary[]): ChatSummary[] {
  return rows.filter((row) => row.conversation?.hidden !== true);
}

/** Sidebar state: fetches the full session list and exposes create / delete actions. */
export function useSessions(): {
  sessions: ChatSummary[];
  loading: boolean;
  /** True only after an authoritative session-list response has arrived. */
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createChat: (workspace?: string | null) => Promise<string>;
  branchChat: (sourceChatId: string, assistantOrdinal: number, sourceTaskId?: string) => Promise<string>;
  deleteChat: (key: string) => Promise<void>;
  updateWorkspace: (key: string, workspace: string | null) => Promise<void>;
} {
  const { client, token, runtimeStatus, runtimeError } = useClientOptional();
  const [sessions, setSessions] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(token);
  const optimisticKeysRef = useRef<Set<string>>(new Set());
  const refreshingRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryResolveRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const connectionStatusRef = useRef(client?.status ?? "idle");
  tokenRef.current = token;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      retryResolveRef.current?.();
      retryResolveRef.current = null;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!client) {
      setLoading(runtimeStatus === "connecting" || runtimeStatus === "ready");
      if (runtimeStatus === "error" || runtimeStatus === "auth") {
        setError(runtimeError ?? "Runtime unavailable");
      } else {
        setError(null);
      }
      return;
    }
    // IM plan 12.5: bursts of session_updated events coalesce into one
    // in-flight refresh plus at most one trailing refresh, so concurrent
    // requests never overwrite newer data with stale responses.
    if (refreshingRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    refreshingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      do {
        refreshPendingRef.current = false;
        let completed = false;
        for (let attempt = 0; attempt <= SESSION_REFRESH_RETRY_DELAYS_MS.length; attempt += 1) {
          if (attempt > 0) {
            await new Promise<void>((resolve) => {
              retryResolveRef.current = resolve;
              retryTimerRef.current = setTimeout(() => {
                retryTimerRef.current = null;
                retryResolveRef.current = null;
                resolve();
              }, SESSION_REFRESH_RETRY_DELAYS_MS[attempt - 1]);
            });
          }
          if (!mountedRef.current) return;
          try {
            const rows = filterVisibleSessions(await listSessions(tokenRef.current));
            if (!mountedRef.current) return;
            const serverKeys = new Set(rows.map((row) => row.key));
            setSessions((prev) => [
              ...rows,
              ...prev.filter(
                (session) =>
                  optimisticKeysRef.current.has(session.key) &&
                  !serverKeys.has(session.key),
              ),
            ]);
            setLoaded(true);
            for (const key of Array.from(optimisticKeysRef.current)) {
              if (serverKeys.has(key)) optimisticKeysRef.current.delete(key);
            }
            setError(null);
            completed = true;
            break;
          } catch (e) {
            if (
              !isRetryableSessionListError(e) ||
              attempt === SESSION_REFRESH_RETRY_DELAYS_MS.length
            ) {
              if (mountedRef.current) setError(sessionListErrorMessage(e));
              break;
            }
          }
        }
        if (!completed && !mountedRef.current) return;
      } while (refreshPendingRef.current);
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [client, runtimeError, runtimeStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!client) return;
    return client.onSessionUpdate(() => {
      void refresh();
    });
  }, [client, refresh]);

  useEffect(() => {
    if (!client) return;
    connectionStatusRef.current = client.status;
    return client.onStatus((status) => {
      const previous = connectionStatusRef.current;
      connectionStatusRef.current = status;
      if (status === "open" && previous !== "open") {
        void refresh();
      }
    });
  }, [client, refresh]);

  const createChat = useCallback(async (workspace?: string | null): Promise<string> => {
    if (!client) {
      throw new Error("runtime not ready");
    }
    const chatId = await client.newChat(5_000, false, workspace);
    const key = `websocket:${chatId}`;
    optimisticKeysRef.current.add(key);
    // Optimistic insert; a subsequent refresh will replace it with the
    // authoritative row once the server persists the session.
    setSessions((prev) => [
      {
        key,
        channel: "websocket",
        chatId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: "",
        preview: "",
        workspace: workspace ?? null,
      },
      ...prev.filter((s) => s.key !== key),
    ]);
    return chatId;
  }, [client]);

  const branchChat = useCallback(async (
    sourceChatId: string,
    assistantOrdinal: number,
    sourceTaskId?: string,
  ): Promise<string> => {
    if (!client) throw new Error("runtime not ready");
    const chatId = await client.branchChat(sourceChatId, assistantOrdinal, sourceTaskId);
    const source = sessions.find((item) => item.chatId === sourceChatId);
    const key = `websocket:${chatId}`;
    optimisticKeysRef.current.add(key);
    setSessions((prev) => [
      {
        key,
        channel: "websocket",
        chatId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: source?.title ? `${source.title} · 分支` : "",
        preview: source?.preview ?? "",
        workspace: source?.workspace ?? null,
        conversation: source?.conversation,
      },
      ...prev.filter((item) => item.key !== key),
    ]);
    return chatId;
  }, [client, sessions]);

  const deleteChat = useCallback(
    async (key: string) => {
      await apiDeleteSession(tokenRef.current, key);
      optimisticKeysRef.current.delete(key);
      setSessions((prev) => prev.filter((s) => s.key !== key));
    },
    [],
  );

  const updateWorkspace = useCallback(
    async (key: string, workspace: string | null) => {
      await apiUpdateSessionWorkspace(tokenRef.current, key, workspace);
      setSessions((prev) =>
        prev.map((s) =>
          s.key === key ? { ...s, workspace: workspace ?? null } : s,
        ),
      );
    },
    [],
  );

  return { sessions, loading, loaded, error, refresh, createChat, branchChat, deleteChat, updateWorkspace };
}

function normalizeHistoryMessages(
  payload: WebuiThreadPersistedPayload | null,
  fallbackStart = 0,
): UIMessage[] {
  return (payload?.messages ?? []).map((message, index) => ({
    ...message,
    id: message.id ?? `hist-${fallbackStart + index}`,
    createdAt: typeof message.createdAt === "number" ? message.createdAt : Date.now(),
    images: resolveUIImageUrls(message.images),
    media: resolveMediaAttachmentUrls(message.media),
  }));
}

export function mergeHistoryMessages(
  current: UIMessage[],
  incoming: UIMessage[],
): UIMessage[] {
  const merged = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const previous = merged.get(message.id);
    merged.set(
      message.id,
      previous?.isStreaming || previous?.reasoningStreaming
        ? { ...message, ...previous }
        : message,
    );
  }
  const rows = Array.from(merged.values());
  return rows.sort((left, right) => {
    if (left.historyPosition != null && right.historyPosition != null) {
      return left.historyPosition - right.historyPosition;
    }
    if (left.historyPosition != null || right.historyPosition != null) {
      return left.historyPosition != null ? -1 : 1;
    }
    if (left.sourceTranscriptIndex != null && right.sourceTranscriptIndex != null) {
      return left.sourceTranscriptIndex - right.sourceTranscriptIndex;
    }
    if (left.sourceTranscriptIndex != null || right.sourceTranscriptIndex != null) {
      return left.sourceTranscriptIndex != null ? -1 : 1;
    }
    return left.createdAt - right.createdAt;
  });
}

function samePersistedMessage(left: UIMessage, right: UIMessage): boolean {
  if (left.id === right.id) return true;
  if (left.historyPosition != null && right.historyPosition != null) {
    return left.historyPosition === right.historyPosition;
  }
  if (left.role !== right.role || left.kind !== right.kind || left.content !== right.content) {
    return false;
  }
  if (left.taskId && right.taskId) return left.taskId === right.taskId;
  return left.createdAt === right.createdAt;
}

function isActiveLiveMessage(
  message: UIMessage,
  options: { isStreaming?: boolean; currentTaskId?: string | null },
): boolean {
  return message.isStreaming
    || message.reasoningStreaming
    || Boolean(options.isStreaming && options.currentTaskId && message.taskId === options.currentTaskId);
}

function unmatchedLiveTail(
  current: UIMessage[],
  incoming: UIMessage[],
  options: { isStreaming?: boolean; currentTaskId?: string | null },
): UIMessage[] {
  return current.filter((message) =>
    message.historyPosition == null
    && isActiveLiveMessage(message, options)
    && !incoming.some((canonical) => samePersistedMessage(message, canonical)),
  );
}

/** Reconcile a refreshed page from the same revision, preserving loaded prefix rows. */
export function reconcileHistoryMessages(
  current: UIMessage[],
  incoming: UIMessage[],
  options: { isStreaming?: boolean; currentTaskId?: string | null; missing?: boolean } = {},
): UIMessage[] {
  if (!incoming.length) return options.missing ? current.filter((message) => isActiveLiveMessage(message, options)) : current;
  const firstPosition = incoming.find((message) => message.historyPosition != null)?.historyPosition ?? 0;
  const prefix = current.filter(
    (message) => message.historyPosition != null && message.historyPosition < firstPosition,
  );
  const liveTail = unmatchedLiveTail(current, incoming, options);
  return mergeHistoryMessages([], [...prefix, ...incoming, ...liveTail]);
}

/** Replace all canonical rows after a revision change, retaining only active live tail rows. */
export function replaceHistoryRevision(
  current: UIMessage[],
  incoming: UIMessage[],
  options: { isStreaming?: boolean; currentTaskId?: string | null; missing?: boolean } = {},
): UIMessage[] {
  if (!incoming.length) return options.missing ? current.filter((message) => isActiveLiveMessage(message, options)) : [];
  return mergeHistoryMessages([], [...incoming, ...unmatchedLiveTail(current, incoming, options)]);
}

/** Return the server's global branch ordinal, falling back only for live tail rows. */
export function assistantOrdinalForMessage(
  messages: UIMessage[],
  messageId: string,
): number | null {
  let lastOrdinal = 0;
  for (const message of messages) {
    if (
      message.role !== "assistant"
      || message.kind === "trace"
      || message.kind === "workflowRun"
      || message.kind === "discussion"
      || !message.content.trim()
    ) {
      continue;
    }
    lastOrdinal = message.assistantOrdinal ?? lastOrdinal + 1;
    if (message.id === messageId) return lastOrdinal;
  }
  return null;
}

interface SessionHistoryState {
  key: string | null;
  messages: UIMessage[];
  loading: boolean;
  error: string | null;
  missing: boolean;
  hasPendingToolCalls: boolean;
  version: number;
  updateKind: "latest" | "earlier" | "full" | null;
  pagination: WebuiThreadPagination | null;
  loadingEarlier: boolean;
  earlierError: string | null;
  fullHistoryReady: boolean;
  fullHistoryLoading: boolean;
  fullHistoryError: string | null;
}

function emptySessionHistory(key: string | null, loading = false): SessionHistoryState {
  return {
    key,
    messages: [],
    loading,
    error: null,
    missing: false,
    hasPendingToolCalls: false,
    version: 0,
    updateKind: null,
    pagination: null,
    loadingEarlier: false,
    earlierError: null,
    fullHistoryReady: false,
    fullHistoryLoading: false,
    fullHistoryError: null,
  };
}

/** Lazy-load a session's on-disk messages. Pass a page size only for paged UIs. */
export function useSessionHistory(key: string | null, pageSize?: number): {
  messages: UIMessage[];
  loading: boolean;
  error: string | null;
  /** True when the history endpoint reports that no WebUI transcript exists. */
  missing: boolean;
  refresh: () => void;
  version: number;
  revision: string | null;
  updateKind: "latest" | "earlier" | "full" | null;
  /** ``true`` when the replayed transcript ends with a trace row (turn still in flight). */
  hasPendingToolCalls: boolean;
  hasMore: boolean;
  loadingEarlier: boolean;
  earlierError: string | null;
  loadEarlier: () => Promise<boolean>;
  fullHistoryLoading: boolean;
  fullHistoryError: string | null;
  loadAllHistory: () => Promise<UIMessage[]>;
} {
  const { token } = useClientOptional();
  const [refreshSeq, setRefreshSeq] = useState(0);
  const refresh = useCallback(() => {
    setRefreshSeq((value) => value + 1);
  }, []);
  const [state, setState] = useState<SessionHistoryState>(() => emptySessionHistory(null));
  const stateRef = useRef(state);
  stateRef.current = state;
  const keyRef = useRef(key);
  keyRef.current = key;
  const controllersRef = useRef(new Set<AbortController>());
  const loadingEarlierRef = useRef(false);
  const fullHistoryRequestRef = useRef<{
    key: string;
    promise: Promise<UIMessage[]>;
  } | null>(null);

  const trackController = useCallback(() => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    return controller;
  }, []);

  const untrackController = useCallback((controller: AbortController) => {
    controllersRef.current.delete(controller);
  }, []);

  useEffect(() => {
    if (!key) {
      setState(emptySessionHistory(null));
      return;
    }
    let cancelled = false;
    const controller = trackController();
    // Mark the new key as loading immediately so callers never see stale
    // messages from the previous session during the render right after a switch.
    setState((prev) => ({
      ...(prev.key === key ? prev : emptySessionHistory(key)),
      key,
      loading: true,
      error: null,
      missing: false,
      loadingEarlier: false,
      earlierError: null,
      fullHistoryLoading: false,
      fullHistoryError: null,
    }));
    loadingEarlierRef.current = false;
    (async () => {
      try {
        const body = await fetchWebuiThread(
          token,
          key,
          undefined,
          pageSize === undefined
            ? { signal: controller.signal }
            : { limit: pageSize, signal: controller.signal },
        );
        if (cancelled || keyRef.current !== key) return;
        const ui = normalizeHistoryMessages(
          body,
          Math.max(0, (body?.pagination?.total ?? body?.messages.length ?? 0) - (body?.messages.length ?? 0)),
        );
        const pagination = body?.pagination ?? null;
        setState((prev) => {
          const sameKey = prev.key === key;
          const base = sameKey ? prev : emptySessionHistory(key);
          const oldRevision = base.pagination?.revision;
          const newRevision = pagination?.revision;
          const revisionChanged = sameKey && oldRevision !== newRevision
            && (oldRevision != null || newRevision != null);
          const sameRevision = oldRevision != null && oldRevision === newRevision;
          const messages = !sameKey
            ? ui
            : body === null
              ? []
              : revisionChanged
                ? replaceHistoryRevision(base.messages, ui)
                : reconcileHistoryMessages(base.messages, ui);
          const keepFull = sameRevision && base.fullHistoryReady;
          const nextPagination = pagination
            ? {
                ...pagination,
                before: sameRevision && base.pagination ? base.pagination.before : pagination.before,
                hasMore: sameRevision && base.pagination
                  ? base.pagination.hasMore && pagination.hasMore && !keepFull
                  : pagination.hasMore,
              }
            : null;
          return {
            ...base,
            key,
            messages,
            loading: false,
            error: null,
            missing: body === null,
            hasPendingToolCalls: ui.at(-1)?.kind === "trace",
            version: (sameKey ? base.version : 0) + 1,
            updateKind: "latest",
            pagination: nextPagination,
            fullHistoryReady:
              pageSize === undefined || !nextPagination?.hasMore || keepFull,
            loadingEarlier: false,
            earlierError: null,
            fullHistoryLoading: false,
          };
        });
      } catch (e) {
        if (cancelled || keyRef.current !== key || controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 404) {
          setState((prev) => ({
            ...(prev.key === key ? prev : emptySessionHistory(key)),
            key,
            loading: false,
            error: null,
            missing: true,
            hasPendingToolCalls: false,
            version: (prev.key === key ? prev.version : 0) + 1,
            updateKind: "latest",
            pagination: null,
            fullHistoryReady: true,
          }));
        } else {
          setState((prev) => ({
            ...(prev.key === key ? prev : emptySessionHistory(key)),
            key,
            loading: false,
            error: (e as Error).message,
            missing: false,
            hasPendingToolCalls: false,
          }));
        }
      } finally {
        untrackController(controller);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      for (const pending of controllersRef.current) pending.abort();
      controllersRef.current.clear();
      fullHistoryRequestRef.current = null;
    };
  }, [key, pageSize, refreshSeq, token, trackController, untrackController]);

  const loadEarlier = useCallback(async (): Promise<boolean> => {
    if (!key || pageSize === undefined || loadingEarlierRef.current) return false;
    const current = stateRef.current;
    const page = current.key === key ? current.pagination : null;
    if (!page?.hasMore || page.before == null) return false;
    loadingEarlierRef.current = true;
    const controller = trackController();
    setState((prev) => prev.key === key
      ? { ...prev, loadingEarlier: true, earlierError: null }
      : prev);
    const isCurrent = () => keyRef.current === key && !controller.signal.aborted;
    try {
      const body = await fetchWebuiThread(token, key, undefined, {
        limit: pageSize,
        before: page.before,
        revision: page.revision,
        signal: controller.signal,
      });
      if (!isCurrent() || !body) return false;
      if (body.pagination?.revision !== page.revision) {
        throw new ApiError(409, "Session history revision changed");
      }
      const pageMessages = normalizeHistoryMessages(
        body,
        Math.max(0, page.before - body.messages.length),
      );
      const currentMessages = stateRef.current.key === key ? stateRef.current.messages : [];
      const sameRevision = body.pagination?.revision === page.revision;
      const mergedMessages = sameRevision
        ? mergeHistoryMessages(currentMessages, pageMessages)
        : reconcileHistoryMessages(currentMessages, pageMessages);
      const added = mergedMessages.length > currentMessages.length;
      setState((prev) => {
        if (prev.key !== key) return prev;
        const pagination = body.pagination ?? null;
        return {
          ...prev,
          messages: sameRevision
            ? mergeHistoryMessages(prev.messages, pageMessages)
            : reconcileHistoryMessages(prev.messages, pageMessages),
          pagination: pagination
            ? { ...pagination, hasMore: pagination.hasMore && !prev.fullHistoryReady }
            : null,
          hasPendingToolCalls: mergedMessages.at(-1)?.kind === "trace",
          version: prev.version + 1,
          updateKind: "earlier",
          fullHistoryReady: prev.fullHistoryReady || !pagination?.hasMore,
        };
      });
      return added;
    } catch (error) {
      if (!isCurrent()) return false;
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await fetchWebuiThread(token, key, undefined, {
            limit: pageSize,
            signal: controller.signal,
          });
          if (!isCurrent()) return false;
          const latestMessages = normalizeHistoryMessages(
            latest,
            Math.max(0, (latest?.pagination?.total ?? latest?.messages.length ?? 0) - (latest?.messages.length ?? 0)),
          );
          setState((prev) => prev.key === key
            ? {
                ...prev,
                messages: latest === null
                  ? []
                  : replaceHistoryRevision(prev.messages, latestMessages),
                pagination: latest?.pagination ?? null,
                missing: latest === null,
                hasPendingToolCalls: latestMessages.at(-1)?.kind === "trace",
                version: prev.version + 1,
                updateKind: "latest",
                fullHistoryReady: !latest?.pagination?.hasMore,
                earlierError: "会话记录已更新，已刷新最近消息，请重试加载更早内容。",
              }
            : prev);
        } catch (refreshError) {
          if (isCurrent()) {
            setState((prev) => prev.key === key
              ? { ...prev, earlierError: (refreshError as Error).message }
              : prev);
          }
        }
      } else if (isCurrent()) {
        setState((prev) => prev.key === key
          ? { ...prev, earlierError: (error as Error).message }
          : prev);
      }
      return false;
    } finally {
      untrackController(controller);
      if (keyRef.current === key) {
        loadingEarlierRef.current = false;
        setState((prev) => prev.key === key ? { ...prev, loadingEarlier: false } : prev);
      }
    }
  }, [key, pageSize, token, trackController, untrackController]);

  const loadAllHistory = useCallback(async (): Promise<UIMessage[]> => {
    if (!key) return EMPTY_MESSAGES;
    const current = stateRef.current;
    if (current.key === key && current.fullHistoryReady) return current.messages;
    const pending = fullHistoryRequestRef.current;
    if (pending?.key === key) return pending.promise;

    const controller = trackController();
    setState((prev) => prev.key === key
      ? { ...prev, fullHistoryLoading: true, fullHistoryError: null }
      : prev);
    let request!: Promise<UIMessage[]>;
    request = (async () => {
      try {
        const body = await fetchWebuiThread(token, key, undefined, { signal: controller.signal });
        if (keyRef.current !== key || controller.signal.aborted) return EMPTY_MESSAGES;
        const complete = normalizeHistoryMessages(body);
        let result = complete;
        setState((prev) => {
          if (prev.key !== key) return prev;
          const sameRevision = prev.pagination?.revision != null
            && prev.pagination.revision === body?.pagination?.revision;
          result = body === null
            ? []
            : sameRevision
              ? reconcileHistoryMessages(prev.messages, complete)
              : replaceHistoryRevision(prev.messages, complete);
          return {
            ...prev,
            messages: result,
            pagination: body?.pagination
              ? { ...body.pagination, hasMore: false, before: null }
              : null,
            fullHistoryReady: true,
            fullHistoryLoading: false,
            fullHistoryError: null,
            missing: body === null,
            hasPendingToolCalls: complete.at(-1)?.kind === "trace",
            version: prev.version + 1,
            updateKind: "full",
          };
        });
        return result;
      } catch (error) {
        if (keyRef.current === key && !controller.signal.aborted) {
          setState((prev) => prev.key === key
            ? {
                ...prev,
                fullHistoryLoading: false,
                fullHistoryError: (error as Error).message,
              }
            : prev);
        }
        return stateRef.current.key === key ? stateRef.current.messages : EMPTY_MESSAGES;
      } finally {
        untrackController(controller);
        if (fullHistoryRequestRef.current?.promise === request) {
          fullHistoryRequestRef.current = null;
        }
      }
    })();
    fullHistoryRequestRef.current = { key, promise: request };
    return request;
  }, [key, token, trackController, untrackController]);

  if (!key) {
    return {
      messages: EMPTY_MESSAGES,
      loading: false,
      error: null,
      missing: false,
      refresh,
      version: 0,
      revision: null,
      updateKind: null,
      hasPendingToolCalls: false,
      hasMore: false,
      loadingEarlier: false,
      earlierError: null,
      loadEarlier,
      fullHistoryLoading: false,
      fullHistoryError: null,
      loadAllHistory,
    };
  }

  // Even before the effect above commits its loading state, never surface the
  // previous session's payload for a brand-new key.
  if (state.key !== key) {
    return {
      messages: EMPTY_MESSAGES,
      loading: true,
      error: null,
      missing: false,
      refresh,
      version: 0,
      revision: null,
      updateKind: null,
      hasPendingToolCalls: false,
      hasMore: false,
      loadingEarlier: false,
      earlierError: null,
      loadEarlier,
      fullHistoryLoading: false,
      fullHistoryError: null,
      loadAllHistory,
    };
  }

  return {
    messages: state.messages,
    loading: state.loading,
    error: state.error,
    missing: state.missing,
    refresh,
    version: state.version,
    revision: state.pagination?.revision ?? null,
    updateKind: state.updateKind,
    hasPendingToolCalls: state.hasPendingToolCalls,
    hasMore: state.pagination?.hasMore ?? false,
    loadingEarlier: state.loadingEarlier,
    earlierError: state.earlierError,
    loadEarlier,
    fullHistoryLoading: state.fullHistoryLoading,
    fullHistoryError: state.fullHistoryError,
    loadAllHistory,
  };
}

/** Produce a compact display title for a session. */
export function sessionTitle(
  session: ChatSummary,
  firstUserMessage?: string,
): string {
  return deriveTitle(
    session.title || firstUserMessage || session.preview,
    i18n.t("chat.newChat"),
  );
}

/** Attention state for a conversation row (IM plan 12.3), derived from the
 *  server-provided workflow fields — never persisted into a store. Priority:
 *  waiting approval > failed > running > scheduled. */
export function conversationListStatus(
  session: Pick<
    ChatSummary,
    "waitingApproval" | "workflowRunStatus" | "runStartedAt" | "scheduled"
  >,
): ConversationListStatus {
  if (session.waitingApproval) return "waiting_approval";
  if (session.workflowRunStatus === "failed") return "failed";
  if (
    session.workflowRunStatus === "running" ||
    session.workflowRunStatus === "queued" ||
    session.runStartedAt != null
  ) {
    return "running";
  }
  if (session.scheduled) return "scheduled";
  return null;
}
