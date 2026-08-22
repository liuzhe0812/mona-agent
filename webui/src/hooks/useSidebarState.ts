import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useClientOptional } from "@/providers/ClientProvider";
import {
  fetchSidebarState,
  updateSidebarState as persistSidebarState,
} from "@/lib/api";
import type { ChatSummary, SidebarStatePayload } from "@/lib/types";

export const DEFAULT_SIDEBAR_STATE: SidebarStatePayload = {
  schema_version: 5,
  pinned_keys: [],
  archived_keys: [],
  title_overrides: {},
  last_read_at_by_key: {},
  tags_by_key: {},
  collapsed_groups: {},
  view: {
    density: "comfortable",
    show_previews: false,
    show_timestamps: false,
    show_archived: false,
    sort: "updated_desc",
  },
  updated_at: null,
};

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") continue;
    const cleanedKey = key.trim();
    const cleanedValue = raw.trim();
    if (!cleanedKey || !cleanedValue) continue;
    out[cleanedKey] = cleanedValue;
  }
  return out;
}

function tagsMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleanedKey = key.trim();
    if (!cleanedKey) continue;
    const tags = uniqueStrings(raw).slice(0, 12);
    if (tags.length) out[cleanedKey] = tags;
  }
  return out;
}

function boolMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleanedKey = key.trim();
    if (cleanedKey) out[cleanedKey] = Boolean(raw);
  }
  return out;
}

export function normalizeSidebarState(raw: unknown): SidebarStatePayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SIDEBAR_STATE, view: { ...DEFAULT_SIDEBAR_STATE.view } };
  }
  const value = raw as Partial<SidebarStatePayload>;
  const view = value.view && typeof value.view === "object"
    ? value.view
    : DEFAULT_SIDEBAR_STATE.view;
  const density = view.density === "compact" ? "compact" : "comfortable";
  const sort = ["updated_desc", "created_desc", "title_asc"].includes(view.sort)
    ? view.sort
    : "updated_desc";
  return {
    schema_version: 5,
    pinned_keys: uniqueStrings(value.pinned_keys),
    archived_keys: uniqueStrings(value.archived_keys),
    title_overrides: stringMap(value.title_overrides),
    last_read_at_by_key: stringMap(value.last_read_at_by_key),
    tags_by_key: tagsMap(value.tags_by_key),
    collapsed_groups: boolMap(value.collapsed_groups),
    view: {
      density,
      show_previews: Boolean(view.show_previews),
      show_timestamps: Boolean(view.show_timestamps),
      show_archived: Boolean(view.show_archived),
      sort,
    },
    updated_at: typeof value.updated_at === "string" ? value.updated_at : null,
  };
}

function pruneMissingSessions(
  state: SidebarStatePayload,
  sessions: ChatSummary[],
): SidebarStatePayload {
  const valid = new Set(sessions.map((session) => session.key));
  const filterKeys = (keys: string[]) => keys.filter((key) => valid.has(key));
  const filterMap = <T,>(map: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(map)) {
      if (valid.has(key)) out[key] = value;
    }
    return out;
  };
  return {
    ...state,
    pinned_keys: filterKeys(state.pinned_keys),
    archived_keys: filterKeys(state.archived_keys),
    title_overrides: filterMap(state.title_overrides),
    last_read_at_by_key: filterMap(state.last_read_at_by_key),
    tags_by_key: filterMap(state.tags_by_key),
  };
}

function sameState(a: SidebarStatePayload, b: SidebarStatePayload): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** IM plan 11.1: a session is unread when its latest user-visible activity
 *  was produced by an agent or system business event after the local
 *  last-read marker. The user's own messages never create unread state.
 *
 *  Timestamps are ISO strings from the same server source, so plain string
 *  comparison matches chronological order. A missing marker counts as unread
 *  for non-user activity — v2 migration seeds markers from ``previewAt``, so
 *  an absent marker means the activity arrived before any read happened. */
export function isSessionUnread(
  session: Pick<ChatSummary, "previewAt" | "previewAuthorType">,
  lastReadAt: string | null | undefined,
): boolean {
  if (!session.previewAt) return false;
  if (session.previewAuthorType === "user") return false;
  if (!lastReadAt) return true;
  return session.previewAt > lastReadAt;
}

/** IM plan 11.2: advance the last-read marker to a seen ``previewAt``.
 *
 *  The marker only moves forward and only to a timestamp the client actually
 *  rendered — never to the wall-clock now — so a concurrent new message is
 *  not swallowed. Returns the input state unchanged when no advance is due. */
export function markSessionRead(
  state: SidebarStatePayload,
  key: string,
  previewAt: string | null | undefined,
): SidebarStatePayload {
  if (!previewAt) return state;
  const existing = state.last_read_at_by_key[key];
  if (existing && existing >= previewAt) return state;
  return {
    ...state,
    last_read_at_by_key: { ...state.last_read_at_by_key, [key]: previewAt },
  };
}

export function markAllSessionsRead(
  state: SidebarStatePayload,
  sessions: ChatSummary[],
): SidebarStatePayload {
  const markers = { ...state.last_read_at_by_key };
  let changed = false;
  for (const session of sessions) {
    const previewAt = session.previewAt;
    const current = markers[session.key];
    if (!previewAt || (current && current >= previewAt)) continue;
    markers[session.key] = previewAt;
    changed = true;
  }
  return changed ? { ...state, last_read_at_by_key: markers } : state;
}

export function useSidebarState(
  sessions: ChatSummary[],
  sessionsLoaded: boolean,
): {
  state: SidebarStatePayload;
  loading: boolean;
  update: (
    updater: (state: SidebarStatePayload) => SidebarStatePayload,
  ) => Promise<void>;
} {
  const { token } = useClientOptional();
  const tokenRef = useRef(token);
  const stateRef = useRef(DEFAULT_SIDEBAR_STATE);
  const persistVersionRef = useRef(0);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const [state, setState] = useState<SidebarStatePayload>(DEFAULT_SIDEBAR_STATE);
  const [loading, setLoading] = useState(true);
  tokenRef.current = token;
  stateRef.current = state;

  useEffect(() => {
    // 等待 runtime token 就绪再拉取：界面先于运行时显示，空 token 必然
    // 401，会把内存态误判为空标记表（所有会话显示未读），后续写入再以
    // DEFAULT 覆盖磁盘上已有的已读标记。
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    const load = (async () => {
      try {
        const loaded = normalizeSidebarState(await fetchSidebarState(tokenRef.current));
        if (cancelled) return;
        stateRef.current = loaded;
        setState(loaded);
      } catch {
        if (cancelled) return;
        stateRef.current = DEFAULT_SIDEBAR_STATE;
        setState(DEFAULT_SIDEBAR_STATE);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    loadPromiseRef.current = load;
    return () => {
      cancelled = true;
    };
  }, [token]);

  const update = useCallback(
    async (updater: (current: SidebarStatePayload) => SidebarStatePayload) => {
      // 首次磁盘加载完成前不得写入，否则未加载的 DEFAULT 会覆盖服务端标记。
      await loadPromiseRef.current;
      const next = normalizeSidebarState(updater(stateRef.current));
      const version = persistVersionRef.current + 1;
      persistVersionRef.current = version;
      stateRef.current = next;
      setState(next);
      try {
        const persisted = normalizeSidebarState(
          await persistSidebarState(tokenRef.current, next),
        );
        if (persistVersionRef.current !== version) return;
        stateRef.current = persisted;
        setState(persisted);
      } catch {
        // Keep the optimistic UI state. Older gateways or transient auth expiry
        // should not break the chat list; the next refresh can try again.
      }
    },
    [],
  );

  const pruned = useMemo(() => {
    if (!sessionsLoaded || loading) return state;
    return pruneMissingSessions(state, sessions);
  }, [loading, sessions, sessionsLoaded, state]);

  useEffect(() => {
    if (!sessionsLoaded || loading || sameState(pruned, state)) return;
    void update(() => pruned);
  }, [loading, pruned, sessionsLoaded, state, update]);

  return { state, loading, update };
}
