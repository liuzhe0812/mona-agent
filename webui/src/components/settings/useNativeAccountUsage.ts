import { useCallback, useEffect, useRef, useState } from "react";
import { developmentApi, type NativeAccountUsage } from "@/lib/development-api";

interface UsageSession {
  active: boolean;
  revision: number;
  readId: number;
  readController: AbortController | null;
  readPromise: Promise<void> | null;
  changesController: AbortController | null;
  retryTimer: number | null;
  retryResolver: (() => void) | null;
}

function isActive(session: UsageSession, current: UsageSession | null): boolean {
  return session.active && current === session;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useNativeAccountUsage(
  enabled: boolean,
  connected: boolean,
  refreshKey: number,
): { usage: NativeAccountUsage | null; refresh: () => Promise<void>; loading: boolean; error: string | null } {
  const [usage, setUsage] = useState<NativeAccountUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usageRef = useRef(usage);
  usageRef.current = usage;
  const sessionRef = useRef<UsageSession | null>(null);

  const readUsage = useCallback((session: UsageSession, replace = false): Promise<void> => {
    if (!isActive(session, sessionRef.current)) return Promise.resolve();
    if (session.readPromise && !replace) return session.readPromise;
    if (session.readPromise) {
      session.readId++;
      session.readController?.abort();
      session.readController = null;
      session.readPromise = null;
    }

    const requestId = ++session.readId;
    const controller = new AbortController();
    session.readController = controller;
    setLoading(true);

    const task = Promise.resolve().then(async () => {
      try {
        const next = await developmentApi.accountUsage("codex", controller.signal);
        if (!isActive(session, sessionRef.current) || session.readId !== requestId) return;
        session.revision = Math.max(session.revision, next.revision);
        setUsage(previous => {
          const quotaUnavailable = Boolean(next.error) && next.fetchedAt === null;
          if (!quotaUnavailable || !previous || previous.connected !== next.connected || previous.accountKey !== next.accountKey || previous.email !== next.email || previous.planType !== next.planType) {
            return next;
          }
          return { ...previous, revision: next.revision, error: next.error };
        });
        setError(next.error);
      } catch (cause) {
        if (!isActive(session, sessionRef.current) || session.readId !== requestId || controller.signal.aborted) return;
        const message = errorMessage(cause);
        setUsage(previous => previous ? { ...previous, error: message } : null);
        setError(message);
      } finally {
        if (isActive(session, sessionRef.current) && session.readId === requestId && session.readPromise === task) {
          session.readController = null;
          session.readPromise = null;
          setLoading(false);
        }
      }
    });
    session.readPromise = task;
    return task;
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const session = sessionRef.current;
    return session ? readUsage(session) : Promise.resolve();
  }, [readUsage]);

  useEffect(() => {
    if (!enabled || !connected) {
      setUsage(null);
      setError(null);
      setLoading(false);
    }
    if (!enabled || !connected) return;

    const session: UsageSession = {
      active: true,
      revision: usageRef.current?.revision ?? 0,
      readId: 0,
      readController: null,
      readPromise: null,
      changesController: null,
      retryTimer: null,
      retryResolver: null,
    };
    sessionRef.current = session;

    const waitBeforeRetry = (delay: number) => new Promise<void>(resolve => {
      session.retryResolver = resolve;
      session.retryTimer = window.setTimeout(() => {
        session.retryTimer = null;
        session.retryResolver = null;
        resolve();
      }, delay);
    });

    const watchChanges = async () => {
      const backoff = [1000, 2000, 4000, 8000, 16000, 30000];
      let failures = 0;
      while (isActive(session, sessionRef.current)) {
        const controller = new AbortController();
        session.changesController = controller;
        try {
          const change = await developmentApi.accountUsageChanges("codex", session.revision, controller.signal);
          if (!isActive(session, sessionRef.current)) return;
          session.changesController = null;
          failures = 0;
          if (change.identityChanged || change.revision !== session.revision) {
            session.revision = change.revision;
            if (change.identityChanged) {
              setUsage(null);
              setError(null);
            }
            await readUsage(session, true);
          }
        } catch {
          if (!isActive(session, sessionRef.current)) return;
          session.changesController = null;
          const delay = backoff[Math.min(failures, backoff.length - 1)];
          failures++;
          await waitBeforeRetry(delay);
          if (isActive(session, sessionRef.current)) await readUsage(session);
        }
      }
    };

    void readUsage(session).then(() => {
      if (isActive(session, sessionRef.current)) void watchChanges();
    });

    return () => {
      session.active = false;
      sessionRef.current = sessionRef.current === session ? null : sessionRef.current;
      session.changesController?.abort();
      session.readController?.abort();
      session.readId++;
      if (session.retryTimer !== null) window.clearTimeout(session.retryTimer);
      session.retryTimer = null;
      session.retryResolver?.();
      session.retryResolver = null;
      session.readController = null;
      session.readPromise = null;
    };
  }, [connected, enabled, readUsage]);

  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    void refresh();
  }, [refresh, refreshKey]);

  return {
    usage: enabled && connected ? usage : null,
    refresh,
    loading: enabled && connected && loading,
    error: enabled && connected ? error : null,
  };
}
