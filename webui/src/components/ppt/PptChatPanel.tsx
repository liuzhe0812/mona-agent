import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Send, Square } from "lucide-react";

import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import { cn } from "@/lib/utils";

interface PptChatPanelProps {
  chatId: string | null;
  onStreamingChange?: (streaming: boolean) => void;
  /** Map of chatId → displayContent for the first user message in that chat. */
  displayContentMap?: Record<string, string>;
}

export interface PptChatPanelHandle {
  send: (content: string, displayContent?: string) => void;
}

export const PptChatPanel = forwardRef<PptChatPanelHandle, PptChatPanelProps>(function PptChatPanel(
  { chatId, onStreamingChange, displayContentMap },
  ref,
) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const historyKey = chatId ? `websocket:${chatId}` : null;
  const {
    messages: historical,
    loading,
    error: historyError,
    hasPendingToolCalls,
    version: historyVersion,
  } = useSessionHistory(historyKey);
  const {
    messages,
    isStreaming,
    send,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMonaStream(chatId, historical, hasPendingToolCalls);

  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current !== isStreaming) {
      onStreamingChange?.(isStreaming);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, onStreamingChange]);

  useEffect(() => {
    if (!chatId) {
      setMessages([]);
    }
  }, [chatId, setMessages]);

  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => {
      if (historical.length === 0 && current.length > 0) return current;
      // Apply displayContent to the first user message if provided
      const dc = displayContentMap?.[chatId];
      return historical.map((m, i) => {
        if (m.role === "user" && !m.displayContent && dc) {
          // Only apply to the first user message
          const isFirstUser = !historical.slice(0, i).some((h) => h.role === "user");
          if (isFirstUser) return { ...m, displayContent: dc };
        }
        return m;
      });
    });
  }, [chatId, historical, historyVersion, loading, setMessages, displayContentMap]);

  const messagesLen = messages.length;
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messagesLen]);

  const sendDraft = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || !chatId || isStreaming) return;
    setDraft("");
    send(trimmed);
  }, [chatId, draft, isStreaming, send]);

  useImperativeHandle(ref, () => ({
    send: (content: string, displayContent?: string) => {
      if (!chatId) return;
      send(content, undefined, displayContent ? { displayContent } : undefined);
    },
  }), [chatId, send]);

  if (!chatId) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        选择历史项目或开始新生成
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 scrollbar-thin">
        <div className="space-y-3">
          {historyError ? (
            <div className="text-[11px] text-destructive">会话历史加载失败：{historyError}</div>
          ) : null}
          {streamError ? (
            <div className="flex items-center justify-between text-[11px] text-destructive">
              <span>消息过大或连接异常，请缩短内容后重试。</span>
              <button
                type="button"
                onClick={dismissStreamError}
                className="text-foreground/65 hover:text-foreground"
              >
                关闭
              </button>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>正在加载会话...</span>
            </div>
          ) : null}

          <ThreadMessages messages={messages} isStreaming={isStreaming} />

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 p-2">
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                sendDraft();
              }
            }}
            disabled={!chatId || isStreaming}
            className="min-h-[36px] flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            rows={2}
            placeholder="输入消息..."
          />
          <button
            type="button"
            aria-label={isStreaming ? "停止生成" : "发送"}
            disabled={!isStreaming && (!chatId || !draft.trim())}
            onClick={isStreaming ? stop : sendDraft}
            className={cn(
              "grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors",
              isStreaming
                ? "text-destructive hover:bg-destructive/10"
                : "bg-action text-white hover:bg-action-hover hover:text-white disabled:bg-muted disabled:text-muted-foreground",
            )}
          >
            {isStreaming ? (
              <Square className="h-3 w-3" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
});
