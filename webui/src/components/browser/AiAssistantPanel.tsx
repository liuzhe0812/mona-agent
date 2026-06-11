import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw, Send, Sparkles, Square, X } from "lucide-react";
import { AgentLogo } from "@/components/AgentLogo";
import { Input } from "@/components/ui/input";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream, type SendOptions } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { ChatSummary, UIMessage } from "@/lib/types";
import { normalizeLegacyLongTaskMessages } from "@/lib/thread-display-compat";
import { scrubSubagentUiMessages } from "@/lib/subagent-channel-display";
import { useClient } from "@/providers/ClientProvider";

function projectMessages(messages: UIMessage[]): UIMessage[] {
  return scrubSubagentUiMessages(normalizeLegacyLongTaskMessages(messages));
}

interface AiAssistantPanelProps {
  /** Current active chat session (same as main chat) */
  session: ChatSummary | null;
  /** Whether AI is currently operating the browser */
  isAiActive: boolean;
  /** Callback when panel layout changes (to notify parent to resize WebView) */
  onToggle?: (expanded: boolean) => void;
  /** Callback when panel is closed */
  onClose?: () => void;
}

export function AiAssistantPanel({
  session,
  isAiActive,
  onToggle,
  onClose,
}: AiAssistantPanelProps) {
  const chatId = session?.chatId ?? null;
  const historyKey = session?.key ?? null;
  const {
    messages: historical,
    loading,
    hasPendingToolCalls,
    version: historyVersion,
  } = useSessionHistory(historyKey);
  const { client } = useClient();

  const initial = useMemo(() => projectMessages(historical), [historical]);
  const {
    messages,
    isStreaming,
    send,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMonaStream(chatId, initial, hasPendingToolCalls);

  const [draft, setDraft] = useState("");
  const [creatingChat, setCreatingChat] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingSendOptsRef = useRef<SendOptions | null>(null);

  const displayMessages = useMemo(() => projectMessages(messages), [messages]);

  // Sync historical messages when they load/update
  useEffect(() => {
    if (!chatId || loading) return;
    setMessages(projectMessages(historical));
  }, [chatId, historical, historyVersion, loading, setMessages]);

  // Reset on session change
  useEffect(() => {
    setDraft("");
    setNotice(null);
  }, [session?.key]);

  // Auto-dismiss notice
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Send pending prompt after chat creation
  useEffect(() => {
    if (!chatId || isStreaming || creatingChat) return;
    const pendingPrompt = pendingPromptRef.current;
    if (!pendingPrompt) return;
    const opts = pendingSendOptsRef.current;
    pendingPromptRef.current = null;
    pendingSendOptsRef.current = null;
    send(pendingPrompt, undefined, opts ?? undefined);
  }, [chatId, creatingChat, isStreaming, send]);

  const sendDraft = useCallback(() => {
    const text = draft.trim();
    if (!text || creatingChat) return;
    if (isStreaming) {
      setNotice("AI 正在处理，请稍候");
      return;
    }

    setDraft("");

    if (chatId) {
      send(text);
      return;
    }

    // No chat yet, create one first
    setCreatingChat(true);
    setNotice("正在创建会话");
    pendingPromptRef.current = text;
    (async () => {
      try {
        const nextChatId = await client.newChat(5_000, true);
        // The session will be picked up by useSessions automatically
        // For now we just set the pending prompt
        pendingPromptRef.current = text;
      } catch {
        pendingPromptRef.current = null;
        setNotice("创建会话失败");
      } finally {
        setCreatingChat(false);
      }
    })();
  }, [draft, chatId, client, creatingChat, isStreaming, send]);

  const handleResetChat = useCallback(() => {
    setMessages([]);
  }, [setMessages]);

  const handleClose = () => {
    onToggle?.(false);
    onClose?.();
  };

  const hasMessages = displayMessages.length > 0;

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border/70 bg-background">
      {/* Header */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[12px] font-semibold text-foreground">Mona</h2>
          {isAiActive && (
            <span className="flex items-center gap-1 text-[10px] text-primary/80">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              操作中
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {notice ? (
            <span className="max-w-28 truncate text-[10px] text-muted-foreground">{notice}</span>
          ) : null}
          {chatId ? (
            <button
              type="button"
              aria-label="重置会话"
              title="重置会话"
              disabled={isStreaming || creatingChat}
              onClick={handleResetChat}
              className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {isStreaming ? (
            <button
              type="button"
              aria-label="停止生成"
              title="停止生成"
              onClick={stop}
              className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Square className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={handleClose}
            className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2 scrollbar-thin">
        {streamError ? (
          <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground mb-2">
            <span className="min-w-0 flex-1">消息过大或连接异常，请缩短内容后重试。</span>
            <button
              type="button"
              onClick={dismissStreamError}
              className="shrink-0 text-foreground/65 hover:text-foreground"
            >
              关闭
            </button>
          </div>
        ) : null}

        {!hasMessages && !loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-[12px]">
            <span className="inline-flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5" />
              {isAiActive ? "AI 正在操作浏览器..." : "输入消息与 AI 对话"}
            </span>
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-[12px]">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在读取会话历史...
            </span>
          </div>
        ) : null}

        <ThreadMessages messages={displayMessages} isStreaming={isStreaming} />

        {creatingChat ? (
          <div className="flex items-center justify-center py-4 text-muted-foreground text-[12px]">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在创建会话...
            </span>
          </div>
        ) : null}
        {isStreaming ? (
          <div className="flex items-center justify-center py-4 text-muted-foreground text-[12px]">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              AI 正在处理...
            </span>
          </div>
        ) : null}
      </div>

      {/* Input */}
      <div className="shrink-0 p-2">
        <div className="flex min-h-9 items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendDraft();
              }
            }}
            disabled={creatingChat}
            placeholder="输入消息..."
            className="flex-1 h-5 border-0 bg-transparent text-[12px] leading-5 px-0 focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <button
            type="button"
            onClick={sendDraft}
            disabled={!draft.trim() || creatingChat || isStreaming}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-foreground text-background hover:bg-foreground/90 transition-colors disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
          >
            {creatingChat ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}
