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

/** Lazy-load a session's on-disk messages the first time the UI displays it. */
export function useSessionHistory(key: string | null): {
  messages: UIMessage[];
  loading: boolean;
  error: string | null;
  /** True when the history endpoint reports that no WebUI transcript exists. */
  missing: boolean;
  refresh: () => void;
  version: number;
  /** ``true`` when the replayed transcript ends with a trace row (turn still in flight). */
  hasPendingToolCalls: boolean;
} {
  const { token } = useClientOptional();
  const [refreshSeq, setRefreshSeq] = useState(0);
  const refresh = useCallback(() => {
    setRefreshSeq((value) => value + 1);
  }, []);
  const [state, setState] = useState<{
    key: string | null;
    messages: UIMessage[];
    loading: boolean;
    error: string | null;
    missing: boolean;
    hasPendingToolCalls: boolean;
    version: number;
  }>({
    key: null,
    messages: [],
    loading: false,
    error: null,
    missing: false,
    hasPendingToolCalls: false,
    version: 0,
  });

  useEffect(() => {
    if (!key) {
      setState({
        key: null,
        messages: [],
        loading: false,
        error: null,
        missing: false,
        hasPendingToolCalls: false,
        version: 0,
      });
      return;
    }
    let cancelled = false;
    // Mark the new key as loading immediately so callers never see stale
    // messages from the previous session during the render right after a switch.
    setState((prev) => prev.key === key
      ? { ...prev, loading: true, error: null }
      : {
          key,
          messages: [],
          loading: true,
          error: null,
          missing: false,
          hasPendingToolCalls: false,
          version: 0,
        });
    (async () => {
      try {
        const body = await fetchWebuiThread(token, key);
        if (cancelled) return;
        if (!body?.messages?.length) {
          setState((prev) => ({
            key,
            messages: [],
            loading: false,
            error: null,
            missing: body === null,
            hasPendingToolCalls: false,
            version: prev.key === key ? prev.version + 1 : 1,
          }));
          return;
        }
        const ui: UIMessage[] = body.messages.map((m, idx) => ({
          ...m,
          id: m.id ?? `hist-${idx}`,
          createdAt: typeof m.createdAt === "number" ? m.createdAt : Date.now(),
          images: resolveUIImageUrls(m.images),
          media: resolveMediaAttachmentUrls(m.media),
        }));
        const last = ui[ui.length - 1];
        const hasPending = last?.kind === "trace";
        setState((prev) => ({
          key,
          messages: ui,
          loading: false,
          error: null,
          missing: false,
          hasPendingToolCalls: hasPending,
          version: prev.key === key ? prev.version + 1 : 1,
        }));
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setState((prev) => ({
            key,
            messages: [],
            loading: false,
            error: null,
            missing: true,
            hasPendingToolCalls: false,
            version: prev.key === key ? prev.version + 1 : 1,
          }));
        } else {
          setState((prev) => ({
            key,
            messages: [],
            loading: false,
            error: (e as Error).message,
            missing: false,
            hasPendingToolCalls: false,
            version: prev.key === key ? prev.version : 0,
          }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, token, refreshSeq]);

  if (!key) {
    return {
      messages: EMPTY_MESSAGES,
      loading: false,
      error: null,
      missing: false,
      refresh,
      version: 0,
      hasPendingToolCalls: false,
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
      hasPendingToolCalls: false,
    };
  }

  return {
    messages: state.messages,
    loading: state.loading,
    error: state.error,
    missing: state.missing,
    refresh,
    version: state.version,
    hasPendingToolCalls: state.hasPendingToolCalls,
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
