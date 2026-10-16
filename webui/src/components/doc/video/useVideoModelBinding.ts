import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchVideoSessionModelBinding } from "@/lib/api";
import { RoomCommandError } from "@/lib/mona-client";
import type { AgentModelBinding } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";

export function useVideoModelBinding(chatId: string | null, initialBinding: AgentModelBinding | null = null) {
  const { client, token } = useClient();
  const [binding, setBinding] = useState<AgentModelBinding | null>(initialBinding);
  const [loading, setLoading] = useState(Boolean(chatId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const activeChat = useRef(chatId);
  activeChat.current = chatId;
  useEffect(() => {
    let active = true;
    setError(null);
    if (!chatId) { setLoading(false); return; }
    setLoading(true);
    void fetchVideoSessionModelBinding(token, chatId).then((value) => { if (active) setBinding(value); })
      .catch(() => { if (active) setError("模型设置未能读取，请重试。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [chatId, token, revision]);
  const changeBinding = useCallback(async (value: AgentModelBinding | null) => {
    setSaving(true);
    try {
      let saved = value;
      if (chatId) {
        try { saved = await client.updateVideoModelBinding(chatId, value); }
        catch (failure) {
          if (failure instanceof RoomCommandError) throw new ApiError(409, failure.message);
          try { saved = await fetchVideoSessionModelBinding(token, chatId); }
          catch {
            if (activeChat.current === chatId) setError("请重新读取模型设置后继续。");
            throw new ApiError(503, "模型切换结果暂时无法确认，请重新读取后再继续制作。");
          }
          if (activeChat.current === chatId) setBinding(saved);
          if (saved?.executor !== value?.executor || saved?.model !== value?.model || saved?.provider !== value?.provider || saved?.effort !== value?.effort) {
            throw new ApiError(409, "模型未切换，已恢复显示实际使用的模型。");
          }
        }
      }
      if (activeChat.current === chatId) setBinding(saved);
      return saved;
    }
    finally { setSaving(false); }
  }, [chatId, client, token]);
  return { binding, setBinding, changeBinding, loading, saving, error, reload: () => setRevision((value) => value + 1) };
}
