import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchVideoSessionModelBinding, listSessions } from "@/lib/api";
import { RoomCommandError } from "@/lib/mona-client";
import type { AgentModelBinding } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";

// Keep the sidebar and workbench controls on the same saved session binding.
const bindingListeners = new Map<string, Set<(value?: AgentModelBinding | null, error?: string, saving?: boolean) => void>>();
const pendingBindings = new Set<string>();

export function useVideoSessionKind(chatId: string | null, knownKind?: string | null) {
  const { token } = useClient();
  const [resolved, setResolved] = useState<{ chatId: string; kind: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const agentKind = knownKind !== undefined ? knownKind : resolved?.chatId === chatId ? resolved.kind : undefined;
  useEffect(() => {
    setError(null);
    if (!chatId || knownKind !== undefined) return;
    let active = true;
    void listSessions(token).then((sessions) => {
      const session = sessions.find((item) => item.channel === "websocket" && item.chatId === chatId);
      if (!session) throw new Error("Session not found");
      if (active) setResolved({ chatId, kind: session.agentKind ?? null });
    }).catch(() => { if (active) setError("会话信息未能读取，请稍后重新打开项目。"); });
    return () => { active = false; };
  }, [chatId, knownKind, token]);
  return { agentKind, error };
}

export function useVideoModelBinding(chatId: string | null, initialBinding: AgentModelBinding | null = null, enabled = true) {
  const { client, token } = useClient();
  const [binding, setBinding] = useState<AgentModelBinding | null>(initialBinding);
  const [loading, setLoading] = useState(Boolean(chatId) && enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const activeChat = useRef(chatId);
  activeChat.current = chatId;
  useEffect(() => {
    let active = true;
    let bindingUpdated = false;
    setError(null);
    if (!enabled || !chatId) { setLoading(false); return; }
    const receiveBinding = (value?: AgentModelBinding | null, error?: string, saving?: boolean) => {
      bindingUpdated = true;
      if (value !== undefined) { setBinding(value); setError(null); }
      if (error !== undefined) setError(error);
      if (saving !== undefined) setSaving(saving);
    };
    const listeners = bindingListeners.get(chatId) ?? new Set();
    bindingListeners.set(chatId, listeners);
    listeners.add(receiveBinding);
    setSaving(pendingBindings.has(chatId));
    setLoading(true);
    void fetchVideoSessionModelBinding(token, chatId).then((value) => { if (active && !bindingUpdated) listeners.forEach((receive) => receive(value)); })
      .catch(() => { if (active && !bindingUpdated) setError("模型设置未能读取，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      listeners.delete(receiveBinding);
      if (!listeners.size) bindingListeners.delete(chatId);
    };
  }, [chatId, enabled, token, revision]);
  const publishBinding = useCallback((value: AgentModelBinding | null) => {
    if (chatId) bindingListeners.get(chatId)?.forEach((receive) => receive(value));
    else if (activeChat.current === chatId) setBinding(value);
  }, [chatId]);
  const changeBinding = useCallback(async (value: AgentModelBinding | null) => {
    if (!enabled) return null;
    if (chatId && pendingBindings.has(chatId)) throw new ApiError(409, "正在切换模型，请稍候。");
    if (chatId) {
      pendingBindings.add(chatId);
      bindingListeners.get(chatId)?.forEach((receive) => receive(undefined, undefined, true));
    }
    setSaving(true);
    try {
      let saved = value;
      if (chatId) {
        try { saved = await client.updateVideoModelBinding(chatId, value); }
        catch (failure) {
          if (failure instanceof RoomCommandError) throw new ApiError(409, failure.message);
          try { saved = await fetchVideoSessionModelBinding(token, chatId); }
          catch {
            bindingListeners.get(chatId)?.forEach((receive) => receive(undefined, "请重新读取模型设置后继续。"));
            throw new ApiError(503, "模型切换结果暂时无法确认，请重新读取后再继续制作。");
          }
          publishBinding(saved);
          if (saved?.executor !== value?.executor || saved?.model !== value?.model || saved?.provider !== value?.provider || saved?.effort !== value?.effort) {
            throw new ApiError(409, "模型未切换，已恢复显示实际使用的模型。");
          }
        }
      }
      publishBinding(saved);
      return saved;
    }
    finally {
      if (chatId) {
        pendingBindings.delete(chatId);
        bindingListeners.get(chatId)?.forEach((receive) => receive(undefined, undefined, false));
      }
      if (activeChat.current === chatId) setSaving(false);
    }
  }, [chatId, client, enabled, publishBinding, token]);
  return { binding, setBinding, changeBinding, loading, saving, error, reload: () => setRevision((value) => value + 1) };
}
