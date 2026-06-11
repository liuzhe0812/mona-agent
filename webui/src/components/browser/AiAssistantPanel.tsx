import { useState, useRef, useEffect, useCallback } from "react";
import { Send, X, ChevronUp } from "lucide-react";
import { AgentLogo } from "@/components/AgentLogo";
import { cn } from "@/lib/utils";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface AiAssistantPanelProps {
  /** Whether AI is currently operating the browser */
  isAiActive: boolean;
  /** Current streaming text from AI (updated in real-time) */
  streamingText?: string;
  /** Callback when user sends a message */
  onSendMessage?: (text: string) => void;
  /** Callback when panel is toggled (to notify parent to resize WebView) */
  onToggle?: (expanded: boolean) => void;
}

export function AiAssistantPanel({
  isAiActive,
  streamingText,
  onSendMessage,
  onToggle,
}: AiAssistantPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // When AI becomes active, auto-show the indicator
  // When AI stops, don't auto-hide (user may want to review)
  useEffect(() => {
    if (isAiActive && !isExpanded) {
      // Just show the indicator, don't auto-expand
    }
  }, [isAiActive, isExpanded]);

  // Update streaming text into the last assistant message
  useEffect(() => {
    if (!streamingText) return;
    setMessages((prev) => {
      const lastMsg = prev[prev.length - 1];
      if (lastMsg && lastMsg.role === "assistant") {
        // Update existing streaming message
        return prev.map((m, i) =>
          i === prev.length - 1 ? { ...m, content: streamingText } : m
        );
      }
      // Create new assistant message
      return [
        ...prev,
        {
          id: `stream-${Date.now()}`,
          role: "assistant",
          content: streamingText,
          timestamp: Date.now(),
        },
      ];
    });
  }, [streamingText]);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    setMessages((prev) => [
      ...prev,
      { id: `user-${Date.now()}`, role: "user", content: text, timestamp: Date.now() },
    ]);
    setInputText("");
    onSendMessage?.(text);
  }, [inputText, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  // Collapsed: floating indicator with AgentLogo animation
  if (!isExpanded) {
    return (
      <div className="flex h-10 shrink-0 items-center justify-end px-3 border-t border-border/40 bg-background/80">
        <button
          type="button"
          onClick={() => { setIsExpanded(true); onToggle?.(true); }}
          className={cn(
            "flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-medium transition-all",
            isAiActive
              ? "bg-primary/15 text-primary hover:bg-primary/25"
              : "bg-muted/60 text-muted-foreground hover:bg-muted"
          )}
        >
          <AgentLogo
            state={isAiActive ? "working" : "idle"}
            className="h-5 w-5"
          />
          <span>{isAiActive ? "AI 操作中" : "AI 助手"}</span>
          <ChevronUp className="h-3 w-3" />
        </button>
      </div>
    );
  }

  // Expanded: mini chat window
  return (
    <div className="flex h-72 shrink-0 flex-col border-t border-border/40 bg-black/90 backdrop-blur-xl">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <AgentLogo
            state={isAiActive ? "working" : "idle"}
            className="h-5 w-5"
          />
          <span className="text-[12px] font-medium text-white/90">
            AI 助手
          </span>
          {isAiActive && (
            <span className="flex items-center gap-1 text-[10px] text-primary/80">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              操作中
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => { setIsExpanded(false); onToggle?.(false); }}
          className="flex h-5 w-5 items-center justify-center rounded-sm text-white/50 hover:text-white/90 hover:bg-white/10 transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {messages.length === 0 && !streamingText && (
          <div className="flex items-center justify-center h-full text-white/30 text-[12px]">
            {isAiActive ? "AI 正在操作浏览器..." : "输入消息与 AI 对话"}
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed max-w-[90%]",
              msg.role === "user"
                ? "ml-auto bg-primary/20 text-white/90"
                : "mr-auto bg-white/8 text-white/75"
            )}
          >
            {msg.content}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 px-3 py-2 border-t border-white/10">
        <input
          ref={inputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息..."
          className="flex-1 h-7 rounded-full bg-white/8 border border-white/10 px-3 text-[12px] text-white/90 placeholder:text-white/30 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition-colors"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!inputText.trim()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/80 text-white hover:bg-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Send className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
