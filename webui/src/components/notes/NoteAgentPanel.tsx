import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  Clipboard,
  Copy,
  Database,
  FileCode2,
  Languages,
  Loader2,
  Pen,
  PenLine,
  Replace,
  RotateCcw,
  Send,
  Sparkles,
  Square,
} from "lucide-react";

import { MessageBubble } from "@/components/MessageBubble";
import { AgentLogo } from "@/components/AgentLogo";
import { AgentActivityCluster } from "@/components/thread/AgentActivityCluster";
import { buildDisplayUnits, type DisplayUnit } from "@/components/thread/ThreadMessages";
import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";
import { useKnowledgeDialog } from "@/providers/KnowledgeDialogProvider";
import { exportNoteTempFile, isTauri } from "@/lib/tauri";

import {
  NOTE_AI_ACTIONS,
  buildAgentActionPrompt,
  buildAgentResultMarkdown,
  buildFreeformAgentPrompt,
  createKnowledgeDraftFromCandidate,
  inferNoteActionDisplayLabel,
  parseExtractedKnowledgeCandidates,
  type ExtractedKnowledgeDraft,
} from "./notes-ai";
import { ConfirmDialog } from "./NotesDialogs";
import type { KnowledgeCategory, NoteAiActionId, OperationNote } from "./notes-data";

interface NoteAgentPanelProps {
  note: OperationNote | null;
  notebook: import("./notes-data").Notebook | null;
  knowledgeCategories: KnowledgeCategory[];
  knowledgeTags: string[];
  collapsed?: boolean;
  width?: number;
  onAgentChatIdChange: (chatId: string) => void;
  onApplyResult: (mode: "append" | "replace", markdown: string, messageId: string) => void;
  onSaveKnowledge: (draft: ExtractedKnowledgeDraft) => boolean;
  onClearChat?: () => void;
  onStreamingChange?: (streaming: boolean) => void;
}

export function NoteAgentPanel({
  note,
  notebook,
  knowledgeCategories,
  knowledgeTags,
  collapsed: collapsedProp,
  width = 306,
  onAgentChatIdChange,
  onApplyResult,
  onSaveKnowledge,
  onClearChat,
  onStreamingChange,
}: NoteAgentPanelProps) {
  const [draft, setDraft] = useState("");
  const collapsed = collapsedProp ?? false;
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [replaceConfirmMessage, setReplaceConfirmMessage] = useState<UIMessage | null>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingDisplayContentRef = useRef<string | null>(null);
  const pendingKnowledgeStartIndexRef = useRef<number | null>(null);
  const pendingActionRef = useRef<Exclude<NoteAiActionId, "freeform"> | null>(null);
  const autoAppliedMessageIdsRef = useRef<Set<string>>(new Set());
  const processedKnowledgeMessageIdsRef = useRef<Set<string>>(new Set());
  const lastNoteIdRef = useRef<string | null | undefined>(note?.id);
  const processedSaveIdsRef = useRef<Set<string>>(new Set());
  const onSaveKnowledgeRef = useRef(onSaveKnowledge);
  onSaveKnowledgeRef.current = onSaveKnowledge;
  const { client } = useClient();

  const {
    candidates: knowledgeCandidates,
    isDialogOpen: knowledgeDialogOpen,
    openDialog: openKnowledgeDialog,
    reopenDialog: reopenKnowledgeDialog,
    clearCandidates: clearKnowledgeCandidates,
    registerSaveHandler,
  } = useKnowledgeDialog();

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

  // Notify parent when streaming state changes
  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // Register save handler for the global knowledge dialog
  useEffect(() => {
    registerSaveHandler((candidateId, draft) => {
      processedSaveIdsRef.current.add(candidateId);
      const success = onSaveKnowledgeRef.current(draft);
      if (success) setNotice("知识点已保存");
      return success;
    });
  }, [registerSaveHandler]);

  // Process saved candidates that were persisted without a handler (e.g. user saved while on another page)
  useEffect(() => {
    const currentNoteId = note?.id;
    if (!currentNoteId) return;

    for (const candidate of knowledgeCandidates) {
      if (
        candidate.status === "saved" &&
        candidate.noteId === currentNoteId &&
        !processedSaveIdsRef.current.has(candidate.id)
      ) {
        processedSaveIdsRef.current.add(candidate.id);
        const draft = createKnowledgeDraftFromCandidate(candidate.draft);
        onSaveKnowledge(draft);
      }
    }
  }, [knowledgeCandidates, note?.id, onSaveKnowledge]);

  useEffect(() => {
    const noteId = note?.id ?? null;
    if (lastNoteIdRef.current === noteId) return;
    lastNoteIdRef.current = noteId;
    setDraft("");
    setNotice(null);
    clearKnowledgeCandidates();
    pendingKnowledgeStartIndexRef.current = null;
    pendingActionRef.current = null;
    autoAppliedMessageIdsRef.current = new Set();
    processedKnowledgeMessageIdsRef.current = new Set();
    processedSaveIdsRef.current = new Set();
    if (!note?.agentChatId) setMessages([]);
  }, [note?.id, note?.agentChatId, setMessages, clearKnowledgeCandidates]);

  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => {
      if (historical.length === 0 && current.length > 0) return current;
      // Reconstruct displayContent for historical user messages that lost it
      // after app restart (displayContent is not persisted by the backend).
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

  useEffect(() => {
    const startIndex = pendingKnowledgeStartIndexRef.current;
    if (startIndex === null || loading || creatingChat || isStreaming) return;

    const completedMessages = messages
      .slice(startIndex)
      .filter(
        (item) =>
          item.role === "assistant" &&
          !item.isStreaming &&
          item.content.trim().length > 0 &&
          !processedKnowledgeMessageIdsRef.current.has(item.id),
      );
    const message =
      completedMessages.find((item) => isKnowledgeJsonCandidate(item.content)) ??
      completedMessages[completedMessages.length - 1];
    if (!message) return;

    pendingKnowledgeStartIndexRef.current = null;
    processedKnowledgeMessageIdsRef.current.add(message.id);

    try {
      const candidates = parseExtractedKnowledgeCandidates(message.content);
      openKnowledgeDialog(candidates, note?.id ?? "");
      setNotice(`生成 ${candidates.length} 个候选知识点`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "未识别到候选知识点";
      setNotice(msg);
    }
  }, [creatingChat, isStreaming, loading, messages, note?.id, openKnowledgeDialog]);

  useEffect(() => {
    const action = pendingActionRef.current;
    if (!action || loading || creatingChat || isStreaming) return;
    if (action !== "polish" && action !== "translate" && action !== "continue") return;

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

    const markdown = buildAgentResultMarkdown(completedMessage.content);
    if (!markdown) return;

    autoAppliedMessageIdsRef.current.add(completedMessage.id);
    pendingActionRef.current = null;

    const mode = action === "continue" ? "append" : "replace";
    onApplyResult(mode, markdown, completedMessage.id);
    setNotice(mode === "append" ? "已追加到笔记" : "已替换笔记正文");
  }, [creatingChat, isStreaming, loading, messages, onApplyResult]);

  const sendPromptToAgent = useCallback(
    async (prompt: string, displayContent?: string) => {
      if (!note) return false;
      const trimmed = prompt.trim();
      if (!trimmed || creatingChat) return false;
      if (isStreaming) {
        setNotice("Agent 正在处理，先停止或等它完成");
        return false;
      }

      // Inject knowledge base context if enabled
      let finalPrompt = trimmed;
      if (notebook?.knowledgeBaseEnabled && isTauri()) {
        try {
          const { searchNotebookNotes } = await import("@/lib/tauri");
          const { formatKnowledgeBaseContext } = await import("./notes-ai");
          const results = await searchNotebookNotes(notebook.id, trimmed);
          const kbContext = formatKnowledgeBaseContext(results);
          if (kbContext) {
            finalPrompt = `${kbContext}\n\n---\n\n${trimmed}`;
          }
        } catch {
          // Search failed, proceed without context
        }
      }

      if (chatId) {
        send(finalPrompt, undefined, displayContent ? { displayContent } : undefined);
        return true;
      }

      setCreatingChat(true);
      setNotice("正在创建笔记专属会话");
      pendingPromptRef.current = finalPrompt;
      pendingDisplayContentRef.current = displayContent ?? null;
      try {
        const nextChatId = await client.newChat(5_000, true);
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
    [chatId, client, creatingChat, isStreaming, note, notebook, onAgentChatIdChange, send],
  );

  const runAction = useCallback(
    async (actionId: Exclude<NoteAiActionId, "freeform">) => {
      if (!note) return;
      if (actionId === "extractKnowledge") {
        pendingKnowledgeStartIndexRef.current = messages.length;
        clearKnowledgeCandidates();
      }
      pendingActionRef.current = actionId;
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
      const sent = await sendPromptToAgent(
        buildAgentActionPrompt(actionId, note, filePath, knowledgeCategories, knowledgeTags),
        label,
      );
      if (!sent) {
        if (actionId === "extractKnowledge") {
          pendingKnowledgeStartIndexRef.current = null;
        }
        pendingActionRef.current = null;
      }
    },
    [clearKnowledgeCandidates, knowledgeCategories, knowledgeTags, messages.length, note, sendPromptToAgent],
  );

  const sendDraft = useCallback(() => {
    if (!note) return;
    const question = draft.trim();
    if (!question) return;
    setDraft("");
    void sendPromptToAgent(buildFreeformAgentPrompt(note, question), question);
  }, [draft, note, sendPromptToAgent]);

  const applyResult = useCallback(
    (mode: "append" | "replace", message: UIMessage, skipConfirm = false) => {
      const markdown = buildAgentResultMarkdown(message.content);
      if (!markdown) return;
      if (!skipConfirm && mode === "replace") {
        setReplaceConfirmMessage(message);
        return;
      }
      onApplyResult(mode, markdown, message.id);
    },
    [onApplyResult],
  );

  const handleReplaceConfirm = useCallback(() => {
    if (!replaceConfirmMessage) return;
    const markdown = buildAgentResultMarkdown(replaceConfirmMessage.content);
    if (markdown) {
      onApplyResult("replace", markdown, replaceConfirmMessage.id);
    }
    setReplaceConfirmMessage(null);
  }, [replaceConfirmMessage, onApplyResult]);

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

  return (
    <>
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

      <QuickActionSection
        note={note}
        disabled={creatingChat || isStreaming}
        onAction={runAction}
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
          onAppend={(message) => applyResult("append", message)}
          onReplace={(message) => applyResult("replace", message)}
          onCopy={copyResult}
          onDismissStreamError={dismissStreamError}
        />
      </div>

      <KnowledgeCandidateDock
        candidates={knowledgeCandidates}
        isDialogOpen={knowledgeDialogOpen}
        onReopen={reopenKnowledgeDialog}
      />

      <div className="shrink-0 p-2">
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
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
            placeholder="问当前笔记、总结内容或提取知识点..."
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

    <ConfirmDialog
      open={replaceConfirmMessage !== null}
      title="替换笔记正文"
      message="用这段 Agent 结果替换当前笔记正文？"
      destructive
      onConfirm={handleReplaceConfirm}
      onOpenChange={(open) => { if (!open) setReplaceConfirmMessage(null); }}
    />
    </>
  );
}

function KnowledgeCandidateDock({
  candidates,
  isDialogOpen,
  onReopen,
}: {
  candidates: { status: string }[];
  isDialogOpen: boolean;
  onReopen: () => void;
}) {
  const pendingCount = candidates.filter((c) => c.status === "pending").length;
  if (pendingCount === 0 || isDialogOpen) return null;

  return (
    <div className="shrink-0 border-t border-border/65 bg-background px-2.5 py-2">
      <button
        type="button"
        onClick={onReopen}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/25 px-2.5 text-left text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <span className="min-w-0 truncate">
          {pendingCount > 0 ? `${pendingCount} 条知识点待确认` : "查看已生成知识点"}
        </span>
        <span className="shrink-0 rounded-full border border-border/65 bg-background px-1.5 py-0.5 text-[10.5px]">
          打开
        </span>
      </button>
    </div>
  );
}

function AgentChat({
  messages,
  loading,
  historyError,
  streamError,
  isStreaming,
  creatingChat,
  appliedMessageIds,
  autoAppliedMessageIds,
  onAppend,
  onReplace,
  onCopy,
  onDismissStreamError,
}: {
  messages: UIMessage[];
  loading: boolean;
  historyError: string | null;
  streamError: string | null;
  isStreaming: boolean;
  creatingChat: boolean;
  appliedMessageIds: string[];
  autoAppliedMessageIds: Set<string>;
  onAppend: (message: UIMessage) => void;
  onReplace: (message: UIMessage) => void;
  onCopy: (message: UIMessage) => void;
  onDismissStreamError: () => void;
}) {
  const units = useMemo(() => buildDisplayUnits(messages), [messages]);
  const liveActivityClusterIndex = isStreaming ? currentActivityClusterIndex(units) : -1;

  return (
    <div className="flex w-full flex-col">
      {historyError ? (
        <InlineNotice>会话历史加载失败：{historyError}</InlineNotice>
      ) : null}
      {streamError ? (
        <InlineNotice onClose={onDismissStreamError}>消息过大或连接异常，请缩短内容后重试。</InlineNotice>
      ) : null}

      {loading ? <AssistantHint text="正在读取这篇笔记的 Agent 会话..." loading /> : null}

      {units.map((unit, index) => {
        const prev = units[index - 1];
        const marginTop = index > 0 ? marginAfterPrevUnit(prev) : "";
        const next = units[index + 1];
        const hasBodyBelow =
          unit.type === "cluster"
          && next?.type === "single"
          && next.message.role === "assistant";

        return (
          <div key={unitKey(unit, index)} className={marginTop}>
            {unit.type === "cluster" ? (
              <AgentActivityCluster
                messages={unit.messages}
                isTurnStreaming={index === liveActivityClusterIndex}
                hasBodyBelow={hasBodyBelow}
              />
            ) : (
              <SingleMessageWithActions
                message={unit.message}
                appliedMessageIds={appliedMessageIds}
                autoAppliedMessageIds={autoAppliedMessageIds}
                onAppend={onAppend}
                onReplace={onReplace}
                onCopy={onCopy}
              />
            )}
          </div>
        );
      })}

      {creatingChat ? <AssistantHint text="正在创建笔记专属会话..." loading /> : null}
      {isStreaming ? <AssistantHint text="Agent 正在处理..." loading /> : null}
    </div>
  );
}

function SingleMessageWithActions({
  message,
  appliedMessageIds,
  autoAppliedMessageIds,
  onAppend,
  onReplace,
  onCopy,
}: {
  message: UIMessage;
  appliedMessageIds: string[];
  autoAppliedMessageIds: Set<string>;
  onAppend: (message: UIMessage) => void;
  onReplace: (message: UIMessage) => void;
  onCopy: (message: UIMessage) => void;
}) {
  const isKnowledgeResult =
    message.role === "assistant" && !message.isStreaming && isKnowledgeJsonCandidate(message.content);

  return (
    <div className="min-w-0">
      {isKnowledgeResult ? (
        <div className="rounded-lg border border-border/65 bg-muted/25 px-2.5 py-2 text-[12px] leading-5 text-muted-foreground">
          已生成候选知识点，请在弹窗中确认保存。
        </div>
      ) : (
        <MessageBubble message={message} showAssistantCopyAction={false} />
      )}
      <NoteMessageActions
        message={message}
        applied={appliedMessageIds.includes(message.id)}
        autoApplied={autoAppliedMessageIds.has(message.id)}
        onAppend={onAppend}
        onReplace={onReplace}
        onCopy={onCopy}
      />
    </div>
  );
}

function currentActivityClusterIndex(units: DisplayUnit[]): number {
  const last = units.length - 1;
  return units[last]?.type === "cluster" ? last : -1;
}

function unitKey(unit: DisplayUnit, index: number): string {
  if (unit.type === "cluster") {
    const anchor = unit.messages[0]?.id;
    return anchor != null ? `cluster-${anchor}` : `cluster-idx-${index}`;
  }
  return unit.message.id;
}

function marginAfterPrevUnit(prev: DisplayUnit): string {
  if (prev.type === "cluster") return "mt-4";
  const p = prev.message;
  const denseP =
    p.kind === "trace"
    || (
      p.role === "assistant"
      && p.content.trim().length === 0
      && (!!p.reasoning || !!p.reasoningStreaming)
    );
  if (denseP) return "mt-2";
  return "mt-5";
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
        <button
          type="button"
          disabled={!note || disabled}
          onClick={() => onAction("polish")}
          className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <PenLine className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">润色优化</span>
        </button>
        <button
          type="button"
          disabled={!note || disabled}
          onClick={() => onAction("translate")}
          className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Languages className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">翻译</span>
        </button>
        <button
          type="button"
          disabled={!note || disabled}
          onClick={() => onAction("continue")}
          className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Pen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">续写扩展</span>
        </button>
        <button
          type="button"
          disabled={!note || disabled}
          onClick={() => onAction("generateHtml")}
          className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">生成HTML文档</span>
        </button>
      </div>
    </div>
  );
}

function NoteMessageActions({
  message,
  applied,
  autoApplied,
  onAppend,
  onReplace,
  onCopy,
}: {
  message: UIMessage;
  applied: boolean;
  autoApplied: boolean;
  onAppend: (message: UIMessage) => void;
  onReplace: (message: UIMessage) => void;
  onCopy: (message: UIMessage) => void;
}) {
  if (message.kind === "trace") return null;
  if (message.role === "user") return null;

  const isKnowledgeResult = !message.isStreaming && isKnowledgeJsonCandidate(message.content);
  const canApply =
    message.role === "assistant" &&
    !message.isStreaming &&
    message.content.trim().length > 0 &&
    !isKnowledgeResult &&
    !autoApplied;

  if (!canApply && !autoApplied) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/40 pt-2">
      {autoApplied ? (
        <>
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-[#1f9d7a]/25 bg-[#1f9d7a]/8 px-2 text-[11px] text-[#11745a]">
            <Check className="h-3.5 w-3.5" />
            已应用
          </span>
          <MiniAction label="复制" onClick={() => onCopy(message)}>
            <Copy className="h-3.5 w-3.5" />
          </MiniAction>
        </>
      ) : null}
      {canApply ? (
        <>
          <MiniAction label={applied ? "已追加" : "追加"} disabled={applied} onClick={() => onAppend(message)}>
            <Clipboard className="h-3.5 w-3.5" />
          </MiniAction>
          <MiniAction label="替换" onClick={() => onReplace(message)}>
            <Replace className="h-3.5 w-3.5" />
          </MiniAction>
          <MiniAction label="复制" onClick={() => onCopy(message)}>
            <Copy className="h-3.5 w-3.5" />
          </MiniAction>
        </>
      ) : null}
    </div>
  );
}

function AssistantHint({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <AgentLogo state="idle" className="h-3 w-3" />}
      <span>{text}</span>
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
    <div className="flex items-start gap-2 text-xs text-muted-foreground">
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
    content.includes('"items"') &&
    content.includes('"categoryName"') &&
    content.includes('"title"') &&
    content.includes('"summary"') &&
    content.includes('"sourceDescription"') &&
    content.includes('"tags"')
  );
}


