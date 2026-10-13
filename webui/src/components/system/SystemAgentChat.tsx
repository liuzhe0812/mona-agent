import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream, type SendImage, type SendOptions } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import { useClientOptional } from "@/providers/ClientProvider";

import { buildSystemAgentHandoffPrompt, type SystemAgentHandoffTask } from "./systemAgentHandoff";

interface SystemAgentChatProps {
  chatId: string | null;
  task: SystemAgentHandoffTask | null;
  onChatCreated: (chatId: string) => void;
  onTaskHandled: (taskId: string) => void;
}

export function SystemAgentChat({ chatId, task, onChatCreated, onTaskHandled }: SystemAgentChatProps) {
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const creatingTaskIdRef = useRef<string | null>(null);
  const sentTaskIdsRef = useRef(new Set<string>());
  const { client } = useClientOptional();
  const historyKey = chatId ? `websocket:${chatId}` : null;
  const { messages: historical, loading, error: historyError, hasPendingToolCalls, version: historyVersion } = useSessionHistory(historyKey);
  const { messages, isStreaming, stopping, send, stop, setMessages, streamError, dismissStreamError } = useMonaStream(chatId, historical, hasPendingToolCalls);

  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => (historical.length === 0 && current.length > 0 ? current : historical));
  }, [chatId, historical, historyVersion, loading, setMessages]);

  useEffect(() => {
    if (!task || isStreaming || sentTaskIdsRef.current.has(task.id)) return;
    if (chatId) {
      sentTaskIdsRef.current.add(task.id);
      send(buildSystemAgentHandoffPrompt(task), undefined, { displayContent: task.title });
      onTaskHandled(task.id);
      return;
    }
    if (!client || creatingTaskIdRef.current === task.id) return;

    creatingTaskIdRef.current = task.id;
    setCreating(true);
    setCreationError("");
    void client.newChat(5_000, true).then(onChatCreated).catch((error: unknown) => {
      setCreationError(String(error));
    }).finally(() => {
      creatingTaskIdRef.current = null;
      setCreating(false);
    });
  }, [chatId, client, isStreaming, onChatCreated, onTaskHandled, send, task]);

  const messageCount = messages.length;
  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messageCount]);

  const sendDraft = useCallback((content: string, images?: SendImage[], options?: SendOptions) => {
    if (!chatId || isStreaming || stopping) return;
    send(content, images, options);
  }, [chatId, isStreaming, stopping, send]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4 scrollbar-hover">
        <div className="space-y-3">
          {creationError && <StatusNotice tone="danger">创建 Mona 会话失败：{creationError}</StatusNotice>}
          {historyError && <StatusNotice tone="danger">会话历史加载失败：{historyError}</StatusNotice>}
          {streamError && <StatusNotice tone="danger" action={<Button type="button" variant="ghost" size="xs" onClick={dismissStreamError}>关闭</Button>}>消息发送失败，请稍后重试。</StatusNotice>}
          {creating && <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在创建 Mona 会话...</p>}
          {loading && <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在加载会话...</p>}
          {!loading && !creating && messages.length === 0 && <p className="rounded-lg border border-border/70 bg-muted/30 p-3 text-caption leading-5 text-muted-foreground">Mona 会在这里接管失败的维护任务。你也可以继续补充要求。</p>}
          <ThreadMessages messages={messages} isStreaming={isStreaming} />
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 p-3">
        <ThreadComposer
          chatId={chatId}
          onSend={sendDraft}
          placeholder="继续告诉 Mona..."
          sendLabel="发送给 Mona"
          stopLabel="停止执行"
          disabled={!chatId || creating}
          sendDisabled={isStreaming || stopping}
          isStreaming={isStreaming}
          stopping={stopping}
          onStop={stop}
        />
      </div>
    </div>
  );
}
