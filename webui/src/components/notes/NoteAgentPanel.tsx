import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bot,
  Clipboard,
  Copy,
  Database,
  Loader2,
  Replace,
  Send,
  Sparkles,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import { exportNoteTempFile, isTauri } from "@/lib/tauri";

import {
  NOTE_AI_ACTIONS,
  buildAgentActionPrompt,
  buildAgentResultMarkdown,
  buildFreeformAgentPrompt,
} from "./notes-ai";
import type { NoteAiActionId, OperationNote } from "./notes-data";

interface NoteAgentPanelProps {
  note: OperationNote | null;
  collapsed?: boolean;
  width?: number;
  onAgentChatIdChange: (chatId: string) => void;
  onApplyResult: (mode: "append" | "replace", markdown: string, messageId: string) => void;
  onSaveKnowledge: (content: string) => boolean;
}

export function NoteAgentPanel({
  note,
  collapsed: collapsedProp,
  width = 306,
  onAgentChatIdChange,
  onApplyResult,
  onSaveKnowledge,
}: NoteAgentPanelProps) {
  const [draft, setDraft] = useState("");
  const collapsed = collapsedProp ?? false;
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingDisplayContentRef = useRef<string | null>(null);
  const pendingKnowledgeStartIndexRef = useRef<number | null>(null);
  const savedKnowledgeMessageIdsRef = useRef<Set<string>>(new Set());
  const { client } = useClient();

  const chatId = note?.agentChatId ?? null;
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
    send,
    stop,
    setMessages,
    streamError,
    dismissStreamError,
  } = useMonaStream(chatId, historical, hasPendingToolCalls);

  useEffect(() => {
    setDraft("");
    setNotice(null);
    pendingKnowledgeStartIndexRef.current = null;
    savedKnowledgeMessageIdsRef.current = new Set();
    if (!note?.agentChatId) setMessages([]);
  }, [note?.id, note?.agentChatId, setMessages]);

  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => {
      if (historical.length === 0 && current.length > 0) return current;
      return historical;
    });
  }, [chatId, historical, historyVersion, loading, setMessages]);

  useEffect(() => {
    if (!chatId || loading || creatingChat) return;
    const pendingPrompt = pendingPromptRef.current;
    if (!pendingPrompt) return;
    const pendingDisplay = pendingDisplayContentRef.current;
    pendingPromptRef.current = null;
    pendingDisplayContentRef.current = null;
    send(pendingPrompt, undefined, pendingDisplay ? { displayContent: pendingDisplay } : undefined);
  }, [chatId, creatingChat, loading, send]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const startIndex = pendingKnowledgeStartIndexRef.current;
    if (startIndex === null || loading || creatingChat || isStreaming) return;

    const message = messages
      .slice(startIndex)
      .find(
        (item) =>
          item.role === "assistant" &&
          !item.isStreaming &&
          item.content.trim().length > 0 &&
          isKnowledgeJsonCandidate(item.content) &&
          !savedKnowledgeMessageIdsRef.current.has(item.id),
      );
    if (!message) return;

    pendingKnowledgeStartIndexRef.current = null;
    const saved = onSaveKnowledge(message.content);
    if (saved) {
      savedKnowledgeMessageIdsRef.current.add(message.id);
      setNotice("知识点已保存");
    }
  }, [creatingChat, isStreaming, loading, messages, onSaveKnowledge]);

  const sendPromptToAgent = useCallback(
    async (prompt: string, displayContent?: string) => {
      if (!note) return false;
      const trimmed = prompt.trim();
      if (!trimmed || creatingChat) return false;
      if (isStreaming) {
        setNotice("Agent 正在处理，先停止或等它完成");
        return false;
      }

      if (chatId) {
        send(trimmed, undefined, displayContent ? { displayContent } : undefined);
        return true;
      }

      setCreatingChat(true);
      setNotice("正在创建笔记专属会话");
      pendingPromptRef.current = trimmed;
      pendingDisplayContentRef.current = displayContent ?? null;
      try {
        const nextChatId = await client.newChat();
        onAgentChatIdChange(nextChatId);
        return true;
      } catch {
        pendingPromptRef.current = null;
        pendingDisplayContentRef.current = null;
        pendingKnowledgeStartIndexRef.current = null;
        setNotice("创建会话失败");
        return false;
      } finally {
        setCreatingChat(false);
      }
    },
    [chatId, client, creatingChat, isStreaming, note, onAgentChatIdChange, send],
  );

  const runAction = useCallback(
    async (actionId: Exclude<NoteAiActionId, "freeform">) => {
      if (!note) return;
      if (actionId === "extractKnowledge") {
        pendingKnowledgeStartIndexRef.current = messages.length;
      }
      let filePath: string | undefined;
      if (isTauri()) {
        try {
          filePath = await exportNoteTempFile(note.id, note.contentMarkdown);
        } catch {
          setNotice("导出笔记文件失败，将直接发送内容");
        }
      }
      const action = NOTE_AI_ACTIONS.find((a) => a.id === actionId);
      const label = action?.label ?? actionId;
      const sent = await sendPromptToAgent(buildAgentActionPrompt(actionId, note, filePath), label);
      if (!sent && actionId === "extractKnowledge") {
        pendingKnowledgeStartIndexRef.current = null;
      }
    },
    [messages.length, note, sendPromptToAgent],
  );

  const sendDraft = useCallback(() => {
    if (!note) return;
    const question = draft.trim();
    if (!question) return;
    setDraft("");
    void sendPromptToAgent(buildFreeformAgentPrompt(note, question), question);
  }, [draft, note, sendPromptToAgent]);

  const applyResult = useCallback(
    (mode: "append" | "replace", message: UIMessage) => {
      const markdown = buildAgentResultMarkdown(message.content);
      if (!markdown) return;
      if (mode === "replace" && !window.confirm("用这段 Agent 结果替换当前笔记正文？")) return;
      onApplyResult(mode, markdown, message.id);
      setNotice(mode === "append" ? "已追加到笔记" : "已替换笔记正文");
    },
    [onApplyResult],
  );

  const copyResult = useCallback(async (message: UIMessage) => {
    const markdown = buildAgentResultMarkdown(message.content);
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setNotice("结果已复制");
    } catch {
      setNotice("复制失败");
    }
  }, []);

  if (collapsed) {
    return null;
  }

  const statusText = note?.agentChatId ? "已连接当前笔记会话" : "首次提问自动创建会话";

  return (
    <aside className="flex h-full shrink-0 flex-col border-l border-border/70 bg-background" style={{ width }}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-lg border border-border/70 bg-background">
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold text-foreground">Agent 联动</h2>
            <p className="truncate text-[11px] text-muted-foreground">{statusText}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {notice ? <span className="max-w-28 truncate text-[11px] text-muted-foreground">{notice}</span> : null}
          {isStreaming ? (
            <button
              type="button"
              aria-label="停止生成"
              title="停止生成"
              onClick={stop}
              className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <QuickActionSection
        note={note}
        disabled={creatingChat || isStreaming}
        onAction={runAction}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2.5 scrollbar-thin">
        <AgentChat
          note={note}
          messages={messages}
          loading={loading}
          historyError={historyError}
          streamError={streamError?.kind ?? null}
          isStreaming={isStreaming}
          creatingChat={creatingChat}
          appliedMessageIds={note?.appliedAgentMessageIds ?? []}
          onAppend={(message) => applyResult("append", message)}
          onReplace={(message) => applyResult("replace", message)}
          onCopy={copyResult}
          onSaveKnowledge={onSaveKnowledge}
          onDismissStreamError={dismissStreamError}
        />
      </div>

      <div className="shrink-0 p-2.5">
        <div className="flex min-h-10 items-end gap-2 rounded-xl border border-border/75 bg-background px-2.5 py-2 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                sendDraft();
              }
            }}
            disabled={!note || creatingChat}
            className="min-h-5 flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            rows={1}
            placeholder="问当前笔记、总结内容或提取知识点..."
          />
          <Button
            type="button"
            size="icon"
            aria-label="发送"
            disabled={!note || !draft.trim() || creatingChat || isStreaming}
            onClick={sendDraft}
            className="h-7 w-7 rounded-lg bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
          >
            {creatingChat ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
    </aside>
  );
}

function AgentChat({
  note,
  messages,
  loading,
  historyError,
  streamError,
  isStreaming,
  creatingChat,
  appliedMessageIds,
  onAppend,
  onReplace,
  onCopy,
  onSaveKnowledge,
  onDismissStreamError,
}: {
  note: OperationNote | null;
  messages: UIMessage[];
  loading: boolean;
  historyError: string | null;
  streamError: string | null;
  isStreaming: boolean;
  creatingChat: boolean;
  appliedMessageIds: string[];
  onAppend: (message: UIMessage) => void;
  onReplace: (message: UIMessage) => void;
  onCopy: (message: UIMessage) => void;
  onSaveKnowledge: (content: string) => void;
  onDismissStreamError: () => void;
}) {
  const hasMessages = messages.length > 0;

  return (
    <div className="space-y-2.5">
      {historyError ? (
        <InlineNotice>会话历史加载失败：{historyError}</InlineNotice>
      ) : null}
      {streamError ? (
        <InlineNotice onClose={onDismissStreamError}>消息过大或连接异常，请缩短内容后重试。</InlineNotice>
      ) : null}

      {!hasMessages && !loading ? (
        <AssistantHint
          text={note ? `当前笔记：${note.title}。可以直接提问，也可以用下面的快捷功能。` : "先选择或新建一篇笔记。"}
        />
      ) : null}

      {loading ? <AssistantHint text="正在读取这篇笔记的 Agent 会话..." loading /> : null}

      {messages.map((message) => (
        <ChatBubble
          key={message.id}
          message={message}
          applied={appliedMessageIds.includes(message.id)}
          onAppend={onAppend}
          onReplace={onReplace}
          onCopy={onCopy}
          onSaveKnowledge={onSaveKnowledge}
        />
      ))}

      {creatingChat ? <AssistantHint text="正在创建笔记专属会话..." loading /> : null}
      {isStreaming ? <AssistantHint text="Agent 正在处理..." loading /> : null}

    </div>
  );
}

function QuickActionSection({
  note,
  disabled,
  onAction,
}: {
  note: OperationNote | null;
  disabled: boolean;
  onAction: (actionId: Exclude<NoteAiActionId, "freeform">) => void;
}) {
  return (
    <div className="shrink-0 border-b border-border/65 px-2.5 py-2.5">
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          disabled={!note || disabled}
          onClick={() => onAction("summary")}
          className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">总结当前笔记</span>
        </button>
        <button
          type="button"
          disabled={!note || disabled}
          onClick={() => onAction("extractKnowledge")}
          className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Database className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">提取知识点</span>
        </button>
      </div>
    </div>
  );
}

function ChatBubble({
  message,
  applied,
  onAppend,
  onReplace,
  onCopy,
  onSaveKnowledge,
}: {
  message: UIMessage;
  applied: boolean;
  onAppend: (message: UIMessage) => void;
  onReplace: (message: UIMessage) => void;
  onCopy: (message: UIMessage) => void;
  onSaveKnowledge: (content: string) => void;
}) {
  if (message.kind === "trace") {
    const traces = message.traces?.length ? message.traces : message.content ? [message.content] : [];
    return (
      <div className="rounded-lg border border-border/65 bg-muted/25 px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">
        <div className="font-medium text-foreground/70">Agent 动作</div>
        {traces.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {traces.slice(-4).map((trace, index) => (
              <li key={`${message.id}-${index}`} className="truncate">
                {trace}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1">正在调用工具...</p>
        )}
      </div>
    );
  }

  const isUser = message.role === "user";
  const canApply =
    !isUser &&
    message.role === "assistant" &&
    !message.isStreaming &&
    message.content.trim().length > 0;
  const canSaveKnowledge = canApply && isKnowledgeJsonCandidate(message.content);

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[90%] whitespace-pre-wrap rounded-xl px-2.5 py-2 text-[11.5px] leading-5",
          isUser
            ? "bg-foreground text-background"
            : "border border-border/70 bg-background text-foreground/86",
        )}
      >
        {message.reasoning ? (
          <div className="mb-2 rounded-lg border border-border/60 bg-muted/25 px-2 py-1.5 text-[11px] leading-4 text-muted-foreground">
            <span className="font-medium text-foreground/70">思考</span>
            <div className="mt-1 line-clamp-4">{message.reasoning}</div>
          </div>
        ) : null}
        {isUser
          ? (message.displayContent ?? message.content) || (message.isStreaming ? "生成中..." : "")
          : message.content || (message.isStreaming ? "生成中..." : "")}
        {canApply ? (
          <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/60 pt-2">
            <MiniAction label={applied ? "已追加" : "追加"} disabled={applied} onClick={() => onAppend(message)}>
              <Clipboard className="h-3.5 w-3.5" />
            </MiniAction>
            <MiniAction label="替换" onClick={() => onReplace(message)}>
              <Replace className="h-3.5 w-3.5" />
            </MiniAction>
            <MiniAction label="复制" onClick={() => onCopy(message)}>
              <Copy className="h-3.5 w-3.5" />
            </MiniAction>
            {canSaveKnowledge ? (
              <MiniAction label="保存知识点" onClick={() => onSaveKnowledge(message.content)}>
                <Database className="h-3.5 w-3.5" />
              </MiniAction>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantHint({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-xl border border-border/70 bg-background px-2.5 py-2 text-[11.5px] leading-5 text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
          {text}
        </span>
      </div>
    </div>
  );
}

function InlineNotice({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-[11.5px] leading-5 text-muted-foreground">
      <span className="min-w-0 flex-1">{children}</span>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 text-foreground/65 hover:text-foreground"
        >
          关闭
        </button>
      ) : null}
    </div>
  );
}

function MiniAction({
  label,
  disabled = false,
  children,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-border/70 bg-muted/25 px-2 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-55"
    >
      {children}
      {label}
    </button>
  );
}

function isKnowledgeJsonCandidate(content: string): boolean {
  return (
    content.includes('"categoryName"') &&
    content.includes('"title"') &&
    content.includes('"summary"') &&
    content.includes('"content"') &&
    content.includes('"sourceDescription"') &&
    content.includes('"tags"')
  );
}
