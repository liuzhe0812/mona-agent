import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw, Send, Sparkles, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
  /** Current browser tab identity used by browser automation tools. */
  tabId?: string;
  /** Current browser page URL */
  pageUrl?: string;
  /** Current browser page title */
  pageTitle?: string;
  /** Callback when panel layout changes (to notify parent to resize WebView) */
  onToggle?: (expanded: boolean) => void;
  /** Callback when panel is closed */
  onClose?: () => void;
}

export function AiAssistantPanel({
  session,
  isAiActive,
  tabId,
  pageUrl,
  pageTitle,
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

  const browserSendOpts = useMemo<SendOptions>(() => ({
    browserTabId: tabId || undefined,
    browserPageUrl: pageUrl || undefined,
    browserPageTitle: pageTitle || undefined,
  }), [tabId, pageUrl, pageTitle]);

  const sendDraft = useCallback(() => {
    const text = draft.trim();
    if (!text || creatingChat) return;
    if (isStreaming) {
      setNotice("AI 正在处理，请稍候");
      return;
    }

    setDraft("");

    if (chatId) {
      send(text, undefined, browserSendOpts);
      return;
    }

    // No chat yet, create one first
    setCreatingChat(true);
    setNotice("正在创建会话");
    pendingPromptRef.current = text;
    pendingSendOptsRef.current = browserSendOpts;
    (async () => {
      try {
        await client.newChat(5_000, true);
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
  }, [draft, chatId, client, creatingChat, isStreaming, send, browserSendOpts]);

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
          <h2 className="truncate text-caption font-semibold text-foreground">Mona</h2>
          {isAiActive && (
            <span className="flex items-center gap-1 text-micro text-primary/80">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              操作中
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {notice ? (
            <span className="max-w-28 truncate text-micro text-muted-foreground">{notice}</span>
          ) : null}
          {chatId ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="重置会话"
              title="重置会话"
              disabled={isStreaming || creatingChat}
              onClick={handleResetChat}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {isStreaming ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="停止生成"
              title="停止生成"
              onClick={stop}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
            >
              <Square className="h-3 w-3" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleClose}
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2 scrollbar-hover">
        {streamError ? (
          <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-caption leading-relaxed text-muted-foreground mb-2">
            <span className="min-w-0 flex-1">消息过大或连接异常，请缩短内容后重试。</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={dismissStreamError}
              className="shrink-0 text-foreground/65 hover:text-foreground"
            >
              关闭
            </Button>
          </div>
        ) : null}

        {!hasMessages && !loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-caption">
            <span className="inline-flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5" />
              {isAiActive ? "AI 正在操作浏览器..." : "输入消息与 AI 对话"}
            </span>
          </div>
        ) : null}

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-caption">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在读取会话历史...
            </span>
          </div>
        ) : null}

        <ThreadMessages messages={displayMessages} isStreaming={isStreaming} />

        {creatingChat ? (
          <div className="flex items-center justify-center py-4 text-muted-foreground text-caption">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在创建会话...
            </span>
          </div>
        ) : null}
        {isStreaming ? (
          <div className="flex items-center justify-center py-4 text-muted-foreground text-caption">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              AI 正在处理...
            </span>
          </div>
        ) : null}
      </div>

      {/* Input */}
      <div className="shrink-0 p-2">
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm">
          <Textarea
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
            rows={2}
            className="min-h-[36px] flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-0 text-caption leading-5 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Button
            type="button"
            size="icon"
            aria-label="发送"
            onClick={sendDraft}
            disabled={!draft.trim() || creatingChat || isStreaming}
            className="h-6 w-6 shrink-0 rounded-lg bg-action text-white hover:bg-action-hover hover:text-white active:bg-action-hover/90 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
          >
            {creatingChat ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>
    </aside>
  );
}
