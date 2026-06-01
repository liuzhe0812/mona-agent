import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Layers, Loader2, Send, Square } from "lucide-react";

import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
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

  const userMessages = useMemo(
    () => messages.filter((m) => m.role === "user"),
    [messages],
  );

  const stats = useMemo(() => {
    let reasoningSteps = 0;
    let toolCalls = 0;
    let added = 0;
    let deleted = 0;
    for (const m of messages) {
      if (m.role === "assistant" && m.kind !== "trace") {
        if (m.reasoning || m.reasoningStreaming) {
          reasoningSteps += 1;
        }
      }
      if (m.kind === "trace") {
        toolCalls += m.traces?.length ?? (m.content.trim() ? 1 : 0);
      }
      if (m.fileEdits) {
        for (const fe of m.fileEdits) {
          if (fe.status !== "error" && !fe.binary) {
            added += fe.added;
            deleted += fe.deleted;
          }
        }
      }
    }
    return { reasoningSteps, toolCalls, added, deleted };
  }, [messages]);

  if (!chatId) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        选择历史项目或开始新生成
      </div>
    );
  }

  const hasStats = stats.reasoningSteps > 0 || stats.toolCalls > 0 || stats.added > 0 || stats.deleted > 0;

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

          {hasStats && (
            <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              <Layers className="h-3.5 w-3.5 shrink-0" />
              {isStreaming ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              ) : null}
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                {stats.reasoningSteps > 0 && (
                  <span>{stats.reasoningSteps} 次思考</span>
                )}
                {stats.toolCalls > 0 && (
                  <span>{stats.toolCalls} 次工具调用</span>
                )}
                {(stats.added > 0 || stats.deleted > 0) && (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <span className="text-emerald-600/75 dark:text-emerald-300/75">+{stats.added}</span>
                    <span className="text-rose-600/70 dark:text-rose-300/75">-{stats.deleted}</span>
                  </span>
                )}
              </span>
            </div>
          )}

          {userMessages.map((message) => (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-sidebar-accent px-3 py-2 text-[12px] leading-relaxed text-foreground">
                {(message.displayContent ?? message.content) || (message.isStreaming ? "生成中..." : "")}
              </div>
            </div>
          ))}

          {isStreaming && !hasStats && (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              <span>Agent 正在处理...</span>
            </div>
          )}

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
