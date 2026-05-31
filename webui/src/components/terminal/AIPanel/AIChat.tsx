import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Loader2, Shield, Square, FileText } from "lucide-react";
import { useClient } from "@/providers/ClientProvider";
import { useTerminalStore } from "../store/terminalStore";
import { isTauri, openPathWithSystemApp } from "@/lib/tauri";
import type { InboundEvent } from "@/lib/types";
import type { ActionConfirmResult } from "./ActionConfig";

interface Props {
  sessionId: string | null;
  initialAction?: ActionConfirmResult;
  onInitialMessageSent?: () => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  label?: string;
}

interface ReportInfo {
  title: string;
  path: string;
  fileName: string;
}

export function AIChat({ sessionId, initialAction, onInitialMessageSent }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [reports, setReports] = useState<ReportInfo[]>([]);
  const { client } = useClient();
  const registry = useTerminalStore((s) => s.terminalRegistry);
  const execMode = useTerminalStore((s) => s.terminalExecMode);
  const setExecMode = useTerminalStore((s) => s.setTerminalExecMode);
  const initialActionRef = useRef(initialAction);
  const onInitialMessageSentRef = useRef(onInitialMessageSent);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initialActionRef.current = initialAction;
  }, [initialAction]);

  useEffect(() => {
    onInitialMessageSentRef.current = onInitialMessageSent;
  }, [onInitialMessageSent]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client.newChat(5_000, true).then((id) => {
      if (!cancelled) setChatId(id);
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
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
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!chatId) return;
    let buffer = "";
    const handle = (ev: InboundEvent) => {
      if (ev.event === "delta") {
        const chunk = typeof ev.text === "string" ? ev.text : "";
        if (!chunk) return;
        buffer += chunk;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === "assistant") {
            updated[updated.length - 1] = { ...last, content: buffer };
          } else {
            updated.push({ role: "assistant", content: buffer });
          }
          return updated;
        });
        setIsLoading(true);
        return;
      }
      if (ev.event === "stream_end") {
        buffer = "";
        return;
      }
      if (ev.event === "turn_end") {
        buffer = "";
        setIsLoading(false);
        return;
      }
      if (ev.event === "message") {
        if (ev.kind === "tool_hint" || ev.kind === "progress") return;
        if (ev.kind === "reasoning") return;
        const text = ev.text;
        if (!text) return;
        setMessages((prev) => [...prev, { role: "assistant", content: text }]);
        setIsLoading(false);
        return;
      }
    };
    const unsub = client.onChat(chatId, handle);
    return unsub;
  }, [chatId, client]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, reports]);

  useEffect(() => {
    const action = initialActionRef.current;
    if (!action || !chatId) return;
    const enriched = enrichWithTerminalContext(action.prompt, sessionId, registry);
    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: action.label,
        label: action.label,
      },
    ]);
    setIsLoading(true);
    client.sendMessage(chatId, enriched, undefined, { terminalSessionId: sessionId ?? undefined, terminalExecMode: execMode });
    initialActionRef.current = undefined;
    onInitialMessageSentRef.current?.();
  }, [chatId, sessionId, registry, client, execMode]);

  const handleSend = useCallback(() => {
    if (!input.trim() || !chatId) return;
    const text = input.trim();
    setInput("");
    const enriched = enrichWithTerminalContext(text, sessionId, registry);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setIsLoading(true);
    client.sendMessage(chatId, enriched, undefined, { terminalSessionId: sessionId ?? undefined, terminalExecMode: execMode });
  }, [input, chatId, sessionId, registry, client, execMode]);

  const isLoadingRef = useRef(false);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  useEffect(() => {
    const cid = chatId;
    const c = client;
    return () => {
      if (cid && isLoadingRef.current) {
        try { c.sendMessage(cid, "/stop"); } catch {}
      }
      if (cid && cid.startsWith("ephemeral:")) {
        try { c.deleteChat(cid); } catch {}
      }
    };
  }, [chatId, client]);

  const handleStop = useCallback(() => {
    if (!chatId) return;
    setIsLoading(false);
    client.sendMessage(chatId, "/stop");
  }, [chatId, client]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isLoading) handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-3">
        {messages.length === 0 && reports.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-8">
            输入问题，AI 将基于终端上下文回答
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-xs leading-relaxed whitespace-pre-wrap break-words ${
              msg.role === "user"
                ? "bg-sidebar-accent rounded-lg px-3 py-2 text-foreground w-fit"
                : "text-muted-foreground"
            }`}
          >
            {msg.role === "user" && msg.label && (
              <span className="mr-1 inline-flex items-center gap-0.5 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground/80">
                {msg.label}
              </span>
            )}
            {msg.content}
          </div>
        ))}
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
        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>思考中...</span>
          </div>
        )}
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入问题，AI 将基于终端上下文回答..."
            className="min-h-[36px] flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground"
            rows={2}
          />
          <button
            type="button"
            onClick={isLoading ? handleStop : handleSend}
            disabled={!isLoading && (!input.trim() || !chatId)}
            className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors ${
              isLoading
                ? "text-destructive hover:bg-destructive/10"
                : "bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
            }`}
          >
            {isLoading ? (
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
