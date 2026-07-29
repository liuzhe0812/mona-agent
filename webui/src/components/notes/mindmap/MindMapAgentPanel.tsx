import { useCallback, useEffect, useRef, useState } from "react";
import {
  GitFork,
  Loader2,
  Network,
  Plus,
  RotateCcw,
  Send,
  Shrink,
  Square,
} from "lucide-react";

import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";
import { useClientOptional } from "@/providers/ClientProvider";
import {
  MINDMAP_ACTIONS,
  buildMindMapActionPrompt,
  buildMindMapFreeformPrompt,
  inferNoteActionDisplayLabel,
  type MindMapActionId,
} from "../notes-ai";
import type { OperationNote } from "../notes-data";
import { applyMindMapAiResult } from "./mindmap-apply";
import { useMindMapSelection } from "./MindMapSelectionContext";
import { AgentChat } from "../NoteAgentPanel";

interface MindMapAgentPanelProps {
  note: OperationNote | null;
  collapsed?: boolean;
  width?: number;
  onAgentChatIdChange: (chatId: string) => void;
  onApplyResult: (mode: "append" | "replace", markdown: string, messageId: string) => void;
  onClearChat?: () => void;
  onStreamingChange?: (streaming: boolean) => void;
}

export function MindMapAgentPanel({
  note,
  collapsed: collapsedProp,
  width = 306,
  onAgentChatIdChange,
  onApplyResult,
  onClearChat,
  onStreamingChange,
}: MindMapAgentPanelProps) {
  const [draft, setDraft] = useState("");
  const collapsed = collapsedProp ?? false;
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingDisplayContentRef = useRef<string | null>(null);
  const pendingActionRef = useRef<string | null>(null);
  const autoAppliedMessageIdsRef = useRef<Set<string>>(new Set());
  const lastNoteIdRef = useRef<string | null | undefined>(note?.id);
  const { client } = useClientOptional();
  const mindMapSelectionCtx = useMindMapSelection();

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
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  useEffect(() => {
    const noteId = note?.id ?? null;
    if (lastNoteIdRef.current === noteId) return;
    lastNoteIdRef.current = noteId;
    setDraft("");
    setNotice(null);
    pendingActionRef.current = null;
    autoAppliedMessageIdsRef.current = new Set();
    if (!note?.agentChatId) setMessages([]);
  }, [note?.id, note?.agentChatId, setMessages]);

  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => {
      if (historical.length === 0 && current.length > 0) return current;
      return historical.map((m) => {
        if (m.role === "user" && !m.displayContent) {
          const label = inferNoteActionDisplayLabel(m.content);
          if (label) return { ...m, displayContent: label };
        }
        return m;
      });
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

  // 思维导图 action 自动应用
  useEffect(() => {
    const action = pendingActionRef.current;
    if (!action || loading || creatingChat || isStreaming) return;
    if (!(action as string).startsWith("mindmap-")) return;

    const completedMessage = messages
      .filter(
        (item) =>
          item.role === "assistant" &&
          !item.isStreaming &&
          item.content.trim().length > 0 &&
          !autoAppliedMessageIdsRef.current.has(item.id),
      )
      .pop();
    if (!completedMessage) return;

    autoAppliedMessageIdsRef.current.add(completedMessage.id);
    pendingActionRef.current = null;

    if (note?.type === "mindmap") {
      const result = applyMindMapAiResult(completedMessage.content, note.contentMarkdown);
      if (!result.ok) {
        setNotice(result.notice);
        return;
      }
      onApplyResult("replace", result.markdown, completedMessage.id);
      setNotice(result.notice);
    }
  }, [creatingChat, isStreaming, loading, messages, note, onApplyResult]);

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

      if (!client) {
        setNotice("运行时未就绪，请稍后再试");
        return false;
      }

      setCreatingChat(true);
      setNotice("正在创建导图专属会话");
      pendingPromptRef.current = trimmed;
      pendingDisplayContentRef.current = displayContent ?? null;
      try {
        const nextChatId = await client.newChat(5_000, true);
        onAgentChatIdChange(nextChatId);
        return true;
      } catch {
        pendingPromptRef.current = null;
        pendingDisplayContentRef.current = null;
        setNotice("创建会话失败");
        return false;
      } finally {
        setCreatingChat(false);
      }
    },
    [chatId, client, creatingChat, isStreaming, note, onAgentChatIdChange, send],
  );

  const runMindMapAction = useCallback(
    async (actionId: MindMapActionId) => {
      if (!note) return;
      const meta = MINDMAP_ACTIONS.find((a) => a.id === actionId);
      if (!meta) return;
      if (meta.requiresSelection) {
        if (mindMapSelectionCtx.noteId !== note.id || !mindMapSelectionCtx.selection) {
          setNotice("请先在画布上选中一个节点");
          return;
        }
      }
      const baseHash = mindMapSelectionCtx.baseHash ?? "";
      pendingActionRef.current = actionId;
      const prompt = buildMindMapActionPrompt(
        actionId,
        note,
        mindMapSelectionCtx.noteId === note.id ? mindMapSelectionCtx.selection : null,
        baseHash,
      );
      const sent = await sendPromptToAgent(prompt, meta.label);
      if (!sent) {
        pendingActionRef.current = null;
      }
    },
    [note, mindMapSelectionCtx, sendPromptToAgent],
  );

  const sendDraft = useCallback(() => {
    if (!note) return;
    const question = draft.trim();
    if (!question) return;
    setDraft("");
    const baseHash = mindMapSelectionCtx.baseHash ?? "";
    const selection =
      mindMapSelectionCtx.noteId === note.id ? mindMapSelectionCtx.selection : null;
    // 标记为自由对话，AI 回答完成后自动应用
    pendingActionRef.current = "mindmap-freeform";
    void sendPromptToAgent(
      buildMindMapFreeformPrompt(note, question, selection, baseHash),
      question,
    );
  }, [draft, note, mindMapSelectionCtx, sendPromptToAgent]);

  const copyResult = useCallback(async (message: UIMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setNotice("结果已复制");
    } catch {
      setNotice("复制失败");
    }
  }, []);

  // 手动替换：从 AI 回答中提取 fenced block 并应用
  const applyReplace = useCallback(
    (message: UIMessage) => {
      if (note?.type !== "mindmap") return;
      const result = applyMindMapAiResult(message.content, note.contentMarkdown);
      if (!result.ok) {
        setNotice(result.notice);
        return;
      }
      onApplyResult("replace", result.markdown, message.id);
      setNotice(result.notice);
    },
    [note, onApplyResult],
  );

  if (collapsed) {
    return null;
  }

  const hasSelection = mindMapSelectionCtx.noteId === note?.id && !!mindMapSelectionCtx.selection;

  return (
    <aside className="flex h-full shrink-0 flex-col border-l border-border/70 bg-background" style={{ width }}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[13px] font-semibold text-foreground">Mona</h2>
        </div>
        <div className="flex items-center gap-1">
          {notice ? <span className="max-w-28 truncate text-[11px] text-muted-foreground">{notice}</span> : null}
          {chatId ? (
            <button
              type="button"
              aria-label="重置会话"
              title="重置会话"
              disabled={isStreaming || creatingChat}
              onClick={() => {
                setMessages([]);
                onClearChat?.();
              }}
              className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <MindMapQuickActions
        disabled={!note || creatingChat || isStreaming}
        hasSelection={hasSelection}
        onAction={runMindMapAction}
      />

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 scrollbar-thin">
        <AgentChat
          messages={messages}
          loading={loading}
          historyError={historyError}
          streamError={streamError?.kind ?? null}
          isStreaming={isStreaming}
          creatingChat={creatingChat}
          appliedMessageIds={note?.appliedAgentMessageIds ?? []}
          autoAppliedMessageIds={autoAppliedMessageIdsRef.current}
          canSaveAsNote={false}
          canAppend={false}
          onAppend={() => {}}
          onReplace={applyReplace}
          onCopy={copyResult}
          onSaveAsNote={() => {}}
          onDismissStreamError={dismissStreamError}
        />
      </div>

      <div className="shrink-0 p-2">
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm">
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
            className="min-h-[36px] flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            rows={2}
            placeholder="让 AI 生成、扩展或重组思维导图..."
          />
          <button
            type="button"
            aria-label={isStreaming ? "停止生成" : "发送"}
            disabled={!isStreaming && (!note || !draft.trim() || creatingChat)}
            onClick={isStreaming ? stop : sendDraft}
            className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors ${
              isStreaming
                ? "text-destructive hover:bg-destructive/10"
                : "bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
            }`}
          >
            {isStreaming ? (
              <Square className="h-3 w-3" />
            ) : creatingChat ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}

function MindMapQuickActions({
  disabled,
  hasSelection,
  onAction,
}: {
  disabled: boolean;
  hasSelection: boolean;
  onAction: (actionId: MindMapActionId) => void;
}) {
  const btnClass =
    "flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50";

  return (
    <div className="shrink-0 border-b border-border/65 px-2.5 py-2.5">
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAction("mindmap-generate")}
          className={btnClass}
        >
          <Network className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">从主题生成导图</span>
        </button>
        <button
          type="button"
          disabled={disabled || !hasSelection}
          onClick={() => onAction("mindmap-expand")}
          className={btnClass}
        >
          <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">扩展选中分支</span>
        </button>
        <button
          type="button"
          disabled={disabled || !hasSelection}
          onClick={() => onAction("mindmap-simplify")}
          className={btnClass}
        >
          <Shrink className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">精简选中分支</span>
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onAction("mindmap-reorganize")}
          className={btnClass}
        >
          <GitFork className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">重组导图</span>
        </button>
      </div>
    </div>
  );
}
