import { useCallback, useEffect, useRef, useState } from "react";
import { Shield, FileText } from "lucide-react";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { useMonaStream, type SendImage, type SendOptions } from "@/hooks/useMonaStream";
import { usePendingQueue } from "@/hooks/usePendingQueue";
import { useSessionHistory } from "@/hooks/useSessions";
import { useClient } from "@/providers/ClientProvider";
import { useTerminalStore, loadPersistedAiChatId, terminalAiChatKey } from "../store/terminalStore";
import { isTauri, openPathWithSystemApp } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { MessageQuote, UIMessage } from "@/lib/types";
import type { SessionType } from "../types/terminal";

interface Props {
  sessionId: string | null;
  sessionTypeOverride?: SessionType;
  onStreamingChange?: (streaming: boolean) => void;
}

interface ReportInfo {
  title: string;
  path: string;
  fileName: string;
}

export function AIChat({ sessionId, sessionTypeOverride, onStreamingChange }: Props) {
  const [creatingChat, setCreatingChat] = useState(false);
  const [reports, setReports] = useState<ReportInfo[]>([]);
  const [quote, setQuote] = useState<MessageQuote | null>(null);
  const { client } = useClient();
  const registry = useTerminalStore((s) => s.terminalRegistry);
  const execMode = useTerminalStore((s) => s.terminalExecMode);
  const setExecMode = useTerminalStore((s) => s.setTerminalExecMode);
  const setAiChatId = useTerminalStore((s) => s.setAiChatId);
  const chatId = useTerminalStore((s) =>
    s.aiChatIds[terminalAiChatKey(sessionId)] ?? null,
  );
  const storedSessionType = useTerminalStore(
    (s) => s.sessions.find((sess) => sess.id === sessionId)?.type ?? null,
  );
  const sessionType = sessionTypeOverride ?? storedSessionType;
  const canExec =
    sessionType === "ssh" || sessionType === "local" || sessionType === "desktop";
  const effectiveSessionId = canExec ? sessionId : null;
  const pendingPromptRef = useRef<string | null>(null);
  const pendingSendOptsRef = useRef<SendOptions | null>(null);
  const pendingImagesRef = useRef<SendImage[] | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pendingQueue = usePendingQueue();

  // Bind this terminal session to a Mona chat. The binding survives panel
  // remounts and SSH reconnects, so the previous conversation is restored
  // instead of starting an empty one.
  useEffect(() => {
    if (!client || chatId) return;
    // A panel whose terminal session is already gone (closed tab) must not
    // provision another chat.
    if (sessionId && storedSessionType === null) return;
    const restored = sessionId ? loadPersistedAiChatId(sessionId) : null;
    if (restored) {
      setAiChatId(sessionId, restored);
      return;
    }
    let cancelled = false;
    client
      .newChat(5_000, false)
      .then((id) => {
        if (!cancelled) setAiChatId(sessionId, id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, chatId, sessionId, storedSessionType, setAiChatId]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<ReportInfo>("terminal-report-ready", (event) => {
        setReports((prev) => [...prev, event.payload]);
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  const historyKey = chatId ? `websocket:${chatId}` : null;
  const {
    messages: historical,
    loading,
    hasPendingToolCalls,
    version: historyVersion,
  } = useSessionHistory(historyKey);
  const {
    messages,
    isStreaming,
    stopping,
    send,
    inject,
    stop,
    setMessages,
  } = useMonaStream(chatId, historical, hasPendingToolCalls);

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => {
      if (historical.length === 0 && current.length > 0) return current;
      return historical;
    });
  }, [chatId, historical, historyVersion, loading, setMessages]);

  useEffect(() => {
    if (!chatId || isStreaming || creatingChat) return;
    const pendingPrompt = pendingPromptRef.current;
    if (!pendingPrompt) return;
    const opts = pendingSendOptsRef.current;
    const pendingImages = pendingImagesRef.current;
    pendingPromptRef.current = null;
    pendingSendOptsRef.current = null;
    pendingImagesRef.current = undefined;
    send(pendingPrompt, pendingImages, opts ?? undefined);
  }, [chatId, creatingChat, isStreaming, send]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, reports]);

  /** Build the terminal-enriched payload and terminal-specific SendOptions. */
  const buildTerminalSend = useCallback(
    (text: string, images?: SendImage[]): { content: string; images: SendImage[] | undefined; options: SendOptions } => {
      const enriched = enrichWithTerminalContext(text, effectiveSessionId, registry);
      const options: SendOptions = {
        terminalSessionId: effectiveSessionId ?? undefined,
        terminalExecMode: effectiveSessionId ? execMode : undefined,
        // IMPORTANT: displayContent shows the user's original input in the message
        // bubble, not the enriched prompt with terminal context. Persisted to server
        // for history replay. DO NOT remove this field.
        displayContent: text,
      };
      return { content: enriched, images, options };
    },
    [effectiveSessionId, registry, execMode],
  );

  /** Called by ThreadComposer when the user submits. Routes to pending queue
   *  while streaming, otherwise sends immediately (or provisions a new chat). */
  const handleSubmit = useCallback(
    (content: string, images?: SendImage[], options?: SendOptions) => {
      const { content: enriched, images: payload, options: terminalOpts } =
        buildTerminalSend(content, images);
      // Merge any extra options ThreadComposer may have added (e.g. quote).
      const mergedOptions: SendOptions = { ...terminalOpts, ...options };

      // While the model is streaming, stage into the pending queue so the user
      // can append or discard before the next turn.
      if (isStreaming) {
        pendingQueue.enqueue(enriched, payload, mergedOptions);
        return;
      }

      if (chatId) {
        send(enriched, payload, mergedOptions);
        return;
      }

      setCreatingChat(true);
      pendingPromptRef.current = enriched;
      pendingSendOptsRef.current = mergedOptions;
      pendingImagesRef.current = payload;
      client.newChat(5_000, false).then((nextChatId) => {
        setAiChatId(sessionId, nextChatId);
        setCreatingChat(false);
      }).catch(() => {
        pendingPromptRef.current = null;
        pendingSendOptsRef.current = null;
        pendingImagesRef.current = undefined;
        setCreatingChat(false);
      });
    },
    [buildTerminalSend, isStreaming, chatId, sessionId, client, send, setAiChatId, pendingQueue],
  );

  const handlePendingAppend = useCallback(
    (id: string) => {
      const msg = pendingQueue.messages.find((m) => m.id === id);
      if (!msg) return;
      inject(msg.content, msg.images, msg.options);
      pendingQueue.remove(id);
    },
    [inject, pendingQueue],
  );

  const handleQuote = useCallback((message: UIMessage, author: string) => {
    const content = (
      message.role === "user"
        ? message.displayContent ?? message.content
        : message.content
    ).trim();
    if (!content) return;
    setQuote({ author, content });
  }, []);

  const execModeSelector = canExec ? (
    <div className="flex items-center gap-1">
      <Shield className="h-3 w-3 text-muted-foreground" />
      <Select
        value={execMode}
        onValueChange={(v) => setExecMode(v as "auto" | "approval")}
        aria-label="执行模式"
        options={[
          { value: "auto", label: "自动模式" },
          { value: "approval", label: "审批模式" },
        ]}
        className="h-6 min-w-0 border-transparent bg-transparent px-1 text-micro text-muted-foreground shadow-none"
      />
    </div>
  ) : undefined;

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3 text-black">
        {messages.length === 0 && reports.length === 0 && (
          <p className="text-center text-caption text-muted-foreground py-8">
            输入问题，AI 将基于终端上下文回答
          </p>
        )}
        <ThreadMessages messages={messages} isStreaming={isStreaming} onQuote={handleQuote} />
        {reports.map((report, i) => (
          <Button
            key={`report-${i}`}
            type="button"
            variant="outline"
            size="xs"
            onClick={() => openPathWithSystemApp(report.path)}
            className="gap-1.5 text-caption"
          >
            <FileText className="h-3.5 w-3.5 text-info" />
            <span className="font-medium">{report.title}</span>
            <span className="text-muted-foreground">— 点击查看报告</span>
          </Button>
        ))}
      </div>
      <div className="shrink-0 px-2 pb-2">
        <ThreadComposer
          onSend={handleSubmit}
          isStreaming={isStreaming}
          stopping={stopping}
          onStop={stop}
          placeholder="输入问题，AI 将基于终端上下文回答..."
          disabled={!chatId && creatingChat}
          leadingActions={execModeSelector}
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

export function enrichWithTerminalContext(
  message: string,
  sessionId: string | null,
  registry: { getBuffer: (id: string) => string },
): string {
  if (!sessionId) return message;
  const data = registry.getBuffer(sessionId);
  const binding = `[当前终端会话：${sessionId}]\n涉及命令时必须使用 terminal_task、terminal_exec 和 terminal_output；禁止使用 exec，它运行在 Mona 所在的本机，不是当前 SSH 桌面终端。`;
  if (!data || data.trim().length === 0) return `${binding}\n\n${message}`;
  const tail = data.length > 4000 ? data.slice(-4000) : data;
  return `${binding}\n\n[终端上下文]\n\`\`\`\n${tail}\n\`\`\`\n\n${message}`;
}
