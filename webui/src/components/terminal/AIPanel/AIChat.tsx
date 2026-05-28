import { useCallback, useEffect, useRef, useState } from "react";
import { Send, Loader2, Shield } from "lucide-react";
import { useClient } from "@/providers/ClientProvider";
import { useTerminalStore } from "../store/terminalStore";
import type { InboundEvent } from "@/lib/types";

interface Props {
  sessionId: string | null;
  initialMessage?: string;
  onInitialMessageSent?: () => void;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function AIChat({ sessionId, initialMessage, onInitialMessageSent }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const { client } = useClient();
  const registry = useTerminalStore((s) => s.terminalRegistry);
  const execMode = useTerminalStore((s) => s.terminalExecMode);
  const setExecMode = useTerminalStore((s) => s.setTerminalExecMode);
  const initialMessageRef = useRef(initialMessage);
  const onInitialMessageSentRef = useRef(onInitialMessageSent);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initialMessageRef.current = initialMessage;
  }, [initialMessage]);

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
  }, [messages]);

  useEffect(() => {
    const msg = initialMessageRef.current;
    if (!msg || !chatId) return;
    const enriched = enrichWithTerminalContext(msg, sessionId, registry);
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setIsLoading(true);
    client.sendMessage(chatId, enriched, undefined, { terminalSessionId: sessionId ?? undefined, terminalExecMode: execMode });
    initialMessageRef.current = undefined;
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-3">
        {messages.length === 0 && (
          <p className="text-center text-xs text-muted-foreground py-8">
            输入问题，AI 将基于终端上下文回答
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`text-xs leading-relaxed whitespace-pre-wrap break-words ${
              msg.role === "user" ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            {msg.content}
          </div>
        ))}
        {isLoading && messages[messages.length - 1]?.role !== "assistant" && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>思考中...</span>
          </div>
        )}
      </div>
      <div className="border-t">
        <div className="flex items-center gap-2 px-3 pt-2">
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
        <div className="flex items-center gap-2 px-3 py-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入问题..."
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || !chatId}
            className="rounded p-1 hover:bg-sidebar-accent/50 disabled:opacity-40"
          >
            {isLoading ? (
              <Loader2 className="h-3 w-3 text-muted-foreground animate-spin" />
            ) : (
              <Send className="h-3 w-3 text-muted-foreground" />
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
