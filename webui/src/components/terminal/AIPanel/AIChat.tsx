import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Shield, Square, FileText } from "lucide-react";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream, type SendOptions } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import { useClient } from "@/providers/ClientProvider";
import { useTerminalStore } from "../store/terminalStore";
import { isTauri, openPathWithSystemApp } from "@/lib/tauri";
import type { ActionConfirmResult } from "./ActionConfig";

interface Props {
  sessionId: string | null;
  initialAction?: ActionConfirmResult;
  onInitialMessageSent?: () => void;
}

interface ReportInfo {
  title: string;
  path: string;
  fileName: string;
}

export function AIChat({ sessionId, initialAction, onInitialMessageSent }: Props) {
  const [draft, setDraft] = useState("");
  const [chatId, setChatId] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [reports, setReports] = useState<ReportInfo[]>([]);
  const { client } = useClient();
  const registry = useTerminalStore((s) => s.terminalRegistry);
  const execMode = useTerminalStore((s) => s.terminalExecMode);
  const setExecMode = useTerminalStore((s) => s.setTerminalExecMode);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingSendOptsRef = useRef<SendOptions | null>(null);
  const onInitialMessageSentRef = useRef(onInitialMessageSent);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onInitialMessageSentRef.current = onInitialMessageSent;
  }, [onInitialMessageSent]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client.newChat(5_000, true).then((id) => {
      if (!cancelled) setChatId(id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [client]);

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
    send,
    stop,
    setMessages,
  } = useMonaStream(chatId, historical, hasPendingToolCalls);

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
    pendingPromptRef.current = null;
    pendingSendOptsRef.current = null;
    send(pendingPrompt, undefined, opts ?? undefined);
  }, [chatId, creatingChat, isStreaming, send]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, reports]);

  useEffect(() => {
    const action = initialAction;
    if (!action || !chatId || isStreaming || creatingChat) return;
    const enriched = enrichWithTerminalContext(action.prompt, sessionId, registry);
    const sendOpts: SendOptions = {
      terminalSessionId: sessionId ?? undefined,
      terminalExecMode: execMode,
      // IMPORTANT: displayContent shows the action label (e.g. "健康巡检") in the
      // message bubble instead of the full enriched prompt. Persisted to server for
      // history replay. DO NOT remove this field.
      displayContent: action.label,
    };
    if (chatId) {
      send(enriched, undefined, sendOpts);
    }
    onInitialMessageSentRef.current?.();
  }, [chatId, initialAction, sessionId, registry, execMode, isStreaming, creatingChat, send]);

  const handleSend = useCallback(() => {
    if (!draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    const enriched = enrichWithTerminalContext(text, sessionId, registry);
    const sendOpts: SendOptions = {
      terminalSessionId: sessionId ?? undefined,
      terminalExecMode: execMode,
      // IMPORTANT: displayContent shows the user's original input in the message
      // bubble, not the enriched prompt with terminal context. Persisted to server
      // for history replay. DO NOT remove this field.
      displayContent: text,
    };

    if (chatId) {
      send(enriched, undefined, sendOpts);
      return;
    }

    setCreatingChat(true);
    pendingPromptRef.current = enriched;
    pendingSendOptsRef.current = sendOpts;
    client.newChat(5_000, true).then((nextChatId) => {
      setChatId(nextChatId);
      setCreatingChat(false);
    }).catch(() => {
      pendingPromptRef.current = null;
      pendingSendOptsRef.current = null;
      setCreatingChat(false);
    });
  }, [draft, chatId, sessionId, registry, client, execMode, send]);

  const handleStop = useCallback(() => {
    stop();
  }, [stop]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isStreaming) handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden p-3 space-y-3">
        {messages.length === 0 && reports.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-8">
            输入问题，AI 将基于终端上下文回答
          </p>
        )}
        <ThreadMessages messages={messages} isStreaming={isStreaming} />
        {reports.map((report, i) => (
          <button
            key={`report-${i}`}
            type="button"
            onClick={() => openPathWithSystemApp(report.path)}
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-background px-2.5 py-1.5 text-[11px] text-foreground hover:bg-sidebar-accent/50 transition-colors"
          >
            <FileText className="h-3.5 w-3.5 text-[#1d6feb]" />
            <span className="font-medium">{report.title}</span>
            <span className="text-muted-foreground">— 点击查看报告</span>
          </button>
        ))}
      </div>
      <div className="shrink-0 p-2">
        <div className="flex items-center gap-1.5 px-2.5 pb-1.5">
          <Shield className="h-3 w-3 text-muted-foreground" />
          <select
            value={execMode}
            onChange={(e) => setExecMode(e.target.value as "auto" | "approval")}
            className="bg-transparent text-[11px] text-muted-foreground outline-none cursor-pointer hover:text-foreground transition-colors"
          >
            <option value="auto">自动模式（安全命令直接执行）</option>
            <option value="approval">审批模式（所有命令需确认）</option>
          </select>
        </div>
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入问题，AI 将基于终端上下文回答..."
            className="min-h-[36px] flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground"
            rows={2}
          />
          <button
            type="button"
            onClick={isStreaming ? handleStop : handleSend}
            disabled={!isStreaming && (!draft.trim() || !chatId)}
            className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors ${
              isStreaming
                ? "text-destructive hover:bg-destructive/10"
                : "bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
            }`}
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

function enrichWithTerminalContext(
  message: string,
  sessionId: string | null,
  registry: { getBuffer: (id: string) => string },
): string {
  if (!sessionId) return message;
  const data = registry.getBuffer(sessionId);
  if (!data || data.trim().length === 0) return message;
  const tail = data.length > 4000 ? data.slice(-4000) : data;
  return `[终端上下文]\n\`\`\`\n${tail}\n\`\`\`\n\n${message}`;
}
