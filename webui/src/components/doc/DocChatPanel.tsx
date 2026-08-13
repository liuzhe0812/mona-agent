import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Send, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";

interface DocChatPanelProps {
  chatId: string | null;
  /** Send the user's draft. May return a displayContent string to override
   *  the optimistic message's text (e.g. an "[已附文档: ...]" suffix). */
  onSend: (content: string) => string | void;
  placeholder?: string;
  /** Notified when streaming state changes (true = AI replying, false = idle). */
  onStreamingChange?: (streaming: boolean) => void;
}

export function DocChatPanel({ chatId, onSend, placeholder, onStreamingChange }: DocChatPanelProps) {
  const [draft, setDraft] = useState("");
  const [awaitingResponse, setAwaitingResponse] = useState(false);
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
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMonaStream(chatId, historical, hasPendingToolCalls);

  const busy = isStreaming || awaitingResponse;

  // Clear awaitingResponse once the server starts streaming back
  useEffect(() => {
    if (isStreaming) setAwaitingResponse(false);
  }, [isStreaming]);

  // Notify parent of streaming state changes
  useEffect(() => {
    onStreamingChange?.(isStreaming);
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
      return historical;
    });
  }, [chatId, historical, historyVersion, loading, setMessages]);

  const messagesLen = messages.length;
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messagesLen]);

  const sendDraft = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || !chatId || busy) return;
    setDraft("");
    // Parent's onSend handles the actual WS send and may return a displayContent
    // string (e.g. with an "[已附文档: ...]" suffix) to show in the optimistic
    // user message. Falls back to the trimmed draft.
    const displayContent = onSend(trimmed);
    setMessages((prev: UIMessage[]) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
        ...(typeof displayContent === "string" && displayContent !== trimmed
          ? { displayContent }
          : {}),
        createdAt: Date.now(),
      },
    ]);
    setAwaitingResponse(true);
  }, [chatId, draft, busy, setMessages, onSend]);

  if (!chatId) {
    return (
      <div className="flex h-full items-center justify-center text-caption text-muted-foreground">
        选择历史项目或开始新生成
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 scrollbar-thin">
        <div className="space-y-3">
          {historyError ? (
            <div className="text-caption text-destructive">会话历史加载失败：{historyError}</div>
          ) : null}
          {streamError ? (
            <div className="flex items-center justify-between text-caption text-destructive">
              <span>消息过大或连接异常，请缩短内容后重试。</span>
              <Button
                type="button"
                variant="ghost"
                onClick={dismissStreamError}
                className="h-auto p-0 text-caption text-foreground/65 hover:bg-transparent hover:text-foreground"
              >
                关闭
              </Button>
            </div>
          ) : null}

          {loading ? (
            <div className="flex items-center gap-1.5 text-caption text-muted-foreground">
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
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                sendDraft();
              }
            }}
            disabled={!chatId || busy}
            className="min-h-[36px] flex-1 resize-none rounded-lg border-0 bg-transparent px-0 text-ui leading-5 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            rows={2}
            placeholder={placeholder ?? "输入消息..."}
          />
          <Button
            type="button"
            aria-label={isStreaming ? "停止生成" : "发送"}
            variant={isStreaming ? "outline" : "default"}
            disabled={isStreaming ? false : busy || !draft.trim()}
            onClick={isStreaming ? stop : sendDraft}
            className="h-6 w-6 shrink-0 rounded-lg p-0"
          >
            {isStreaming ? (
              <Square className="h-3 w-3" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
