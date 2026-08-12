import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Send, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusNotice } from "@/components/ui/status-notice";
import { Textarea } from "@/components/ui/textarea";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream } from "@/hooks/useMonaStream";
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
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const creatingTaskIdRef = useRef<string | null>(null);
  const sentTaskIdsRef = useRef(new Set<string>());
  const { client } = useClientOptional();
  const historyKey = chatId ? `websocket:${chatId}` : null;
  const { messages: historical, loading, error: historyError, hasPendingToolCalls, version: historyVersion } = useSessionHistory(historyKey);
  const { messages, isStreaming, send, stop, setMessages, streamError, dismissStreamError } = useMonaStream(chatId, historical, hasPendingToolCalls);

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

  const sendDraft = useCallback(() => {
    const content = draft.trim();
    if (!content || !chatId || isStreaming) return;
    setDraft("");
    send(content);
  }, [chatId, draft, isStreaming, send]);

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

      <div className="shrink-0 border-t border-border/70 p-3">
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-lg border border-border/75 bg-background px-2.5 py-1.5 shadow-sm">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                sendDraft();
              }
            }}
            disabled={!chatId || isStreaming || creating}
            className="min-h-[36px] flex-1 resize-none rounded-lg border-0 bg-transparent px-0 text-caption leading-5 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            rows={2}
            placeholder="继续告诉 Mona..."
          />
          <Button
            type="button"
            aria-label={isStreaming ? "停止执行" : "发送给 Mona"}
            variant={isStreaming ? "destructive" : "default"}
            size="icon"
            disabled={isStreaming ? false : !chatId || !draft.trim() || creating}
            onClick={isStreaming ? stop : sendDraft}
            className="h-7 w-7 shrink-0 rounded-lg"
          >
            {isStreaming ? <Square className="h-3 w-3" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
