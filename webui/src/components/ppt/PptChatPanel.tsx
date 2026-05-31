import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Square } from "lucide-react";

import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";
import { cn } from "@/lib/utils";

interface PptChatPanelProps {
  chatId: string | null;
}

export function PptChatPanel({ chatId }: PptChatPanelProps) {
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendDraft = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || !chatId || isStreaming) return;
    setDraft("");
    send(trimmed);
  }, [chatId, draft, isStreaming, send]);

  if (!chatId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-[12px]">等待生成开始...</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
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

          {messages.map((message) => (
            <ChatBubble key={message.id} message={message} />
          ))}

          {isStreaming ? (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Agent 正在处理...</span>
            </div>
          ) : null}

          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 p-2">
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
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
                : "bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground",
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
}

function ChatBubble({ message }: { message: UIMessage }) {
  if (message.kind === "trace") {
    const traces = message.traces?.length ? message.traces : message.content ? [message.content] : [];
    return (
      <div className="rounded-lg border border-border/65 bg-muted/25 px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">
        <div className="font-medium text-foreground/70">Agent 动作</div>
        {traces.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {traces.slice(-4).map((trace, index) => (
              <li key={`${message.id}-${index}`} className="truncate">
                {trace}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1">正在调用工具...</p>
        )}
      </div>
    );
  }

  const isUser = message.role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap break-words text-[12px] leading-relaxed",
          isUser
            ? "bg-sidebar-accent rounded-lg px-3 py-2 text-foreground"
            : "text-muted-foreground",
        )}
      >
        {message.reasoning ? (
          <div className="mb-2 rounded-lg border border-border/60 bg-muted/25 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
            <span className="font-medium text-foreground/70">思考</span>
            <div className="mt-1 line-clamp-4">{message.reasoning}</div>
          </div>
        ) : null}
        {isUser
          ? (message.displayContent ?? message.content) || (message.isStreaming ? "生成中..." : "")
          : message.content || (message.isStreaming ? "生成中..." : "")}
      </div>
    </div>
  );
}
