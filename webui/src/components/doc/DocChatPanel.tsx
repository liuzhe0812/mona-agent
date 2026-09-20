import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { Button } from "@/components/ui/button";
import { useMonaStream, type SendImage, type SendOptions } from "@/hooks/useMonaStream";
import { usePendingQueue } from "@/hooks/usePendingQueue";
import { useSessionHistory } from "@/hooks/useSessions";
import type { MessageQuote, UIMessage } from "@/lib/types";

interface DocChatPanelProps {
  chatId: string | null;
  /** Adds document- or workflow-specific context to composer sends. */
  getSendOptions?: (content: string) => SendOptions | undefined;
  placeholder?: string;
  /** Notified when streaming state changes (true = AI replying, false = idle). */
  onStreamingChange?: (streaming: boolean) => void;
}

export function DocChatPanel({
  chatId,
  getSendOptions,
  placeholder,
  onStreamingChange,
}: DocChatPanelProps) {
  const [quote, setQuote] = useState<MessageQuote | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const onStreamingChangeRef = useRef(onStreamingChange);
  const pendingQueue = usePendingQueue();

  useEffect(() => {
    onStreamingChangeRef.current = onStreamingChange;
  }, [onStreamingChange]);

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
    isAwaitingModelResponse,
    stopping,
    stop,
    send,
    inject,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMonaStream(chatId, historical, hasPendingToolCalls);

  useEffect(() => {
    onStreamingChangeRef.current?.(isStreaming);
  }, [isStreaming]);

  useEffect(() => {
    if (!chatId) setMessages([]);
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

  const handleSubmit = useCallback((
    content: string,
    images?: SendImage[],
    composerOptions?: SendOptions,
  ) => {
    if (!chatId) return;
    const contextOptions = getSendOptions?.(content);
    const options: SendOptions = {
      ...contextOptions,
      ...composerOptions,
      displayContent: composerOptions?.displayContent ?? contextOptions?.displayContent ?? content,
    };
    if (isStreaming) {
      pendingQueue.enqueue(content, images, options);
      return;
    }
    send(content, images, options);
  }, [chatId, getSendOptions, isStreaming, pendingQueue, send]);

  const handlePendingAppend = useCallback((id: string) => {
    const pending = pendingQueue.messages.find((message) => message.id === id);
    if (!pending) return;
    inject(pending.content, pending.images, pending.options);
    pendingQueue.remove(id);
  }, [inject, pendingQueue]);

  const handleQuote = useCallback((message: UIMessage, author: string) => {
    const content = (message.role === "user" ? message.displayContent ?? message.content : message.content).trim();
    if (content) setQuote({ author, content });
  }, []);

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
          <ThreadMessages messages={messages} isStreaming={isStreaming} onQuote={handleQuote} />
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 px-2 pb-2">
        <ThreadComposer
          onSend={handleSubmit}
          isStreaming={isStreaming}
          isAwaitingModelResponse={isAwaitingModelResponse}
          stopping={stopping}
          onStop={stop}
          disabled={!chatId}
          placeholder={placeholder ?? "输入消息..."}
          quote={quote}
          onClearQuote={() => setQuote(null)}
          pendingMessages={pendingQueue.messages}
          onPendingAppend={handlePendingAppend}
          onPendingRemove={pendingQueue.remove}
          onPendingEdit={pendingQueue.update}
          isPendingFull={pendingQueue.messages.length >= 3}
        />
      </div>
    </div>
  );
}
