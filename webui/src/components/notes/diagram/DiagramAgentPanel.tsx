/**
 * 图表 AI 面板（mona-diagram-patch v2）。
 *
 * AI 回答完成后用 prepareDiagramPatch 做 dry-run：生成期间文档状态未变
 * （revision + documentHash 匹配）则自动应用；否则标记 stale，展示变更卡片
 * 等待手动应用。手动应用前再次基于中心最新状态校验（applyPendingDiagramPatch）。
 *
 * 与 FlowchartAgentPanel 差异：stale 基于 docState 而非单一 baseHash；
 * 契约由 buildAgentContract 随图表类型动态生成；onApplyResult 整体替换。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, RotateCcw, X } from "lucide-react";

import { useMonaStream, type SendImage } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import { useClientOptional } from "@/providers/ClientProvider";
import type { OperationNote } from "../notes-data";
import { AgentChat } from "../NoteAgentPanel";
import { AgentComposer } from "../AgentComposer";
import {
  applyPendingDiagramPatch,
  formatDiagramSummary,
  prepareDiagramPatch,
  type PendingDiagramPatch,
} from "./diagram-apply";
import { buildAgentContract } from "./diagram-capabilities";
import { computeDiagramDocumentHash, computeDiagramSemanticHash } from "./diagram-hash";
import { buildDiagramIndexMarkdown, parseDiagramMarkdown } from "./diagram-serializer";
import {
  useDiagramSelection,
  type DiagramDocumentStateSnapshot,
} from "./DiagramSelectionContext";

interface DiagramAgentPanelProps {
  note: OperationNote | null;
  collapsed?: boolean;
  width?: number;
  onAgentChatIdChange: (chatId: string) => void;
  onApplyResult: (markdown: string, messageId: string) => void;
  onClearChat?: () => void;
  onStreamingChange?: (streaming: boolean) => void;
}

export function DiagramAgentPanel({
  note,
  collapsed: collapsedProp,
  width = 306,
  onAgentChatIdChange,
  onApplyResult,
  onClearChat,
  onStreamingChange,
}: DiagramAgentPanelProps) {
  const [draft, setDraft] = useState("");
  const collapsed = collapsedProp ?? false;
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const pendingSendRef = useRef<{
    prompt: string;
    display: string | null;
    images: SendImage[] | null;
  } | null>(null);
  /** 发起请求时记录的文档状态快照，用于生成期间 stale 检测 */
  const requestDocStateRef = useRef<DiagramDocumentStateSnapshot | null>(null);
  /** 已 prepare 过的 message ID，避免重复 dry-run */
  const preparedMessageIdsRef = useRef<Set<string>>(new Set());
  const [pendingPatches, setPendingPatches] = useState<Map<string, PendingDiagramPatch>>(
    () => new Map(),
  );
  const lastNoteIdRef = useRef<string | null | undefined>(note?.id);
  const { client } = useClientOptional();
  const diagramSelectionCtx = useDiagramSelection();

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

  const currentDocState = diagramSelectionCtx.docState;

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  // 切换笔记时清空本地状态
  useEffect(() => {
    const noteId = note?.id ?? null;
    if (lastNoteIdRef.current === noteId) return;
    lastNoteIdRef.current = noteId;
    setDraft("");
    setNotice(null);
    requestDocStateRef.current = null;
    preparedMessageIdsRef.current = new Set();
    setPendingPatches(new Map());
    if (!note?.agentChatId) setMessages([]);
  }, [note?.id, note?.agentChatId, setMessages]);

  // 历史消息合并到流式状态
  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) =>
      historical.length === 0 && current.length > 0 ? current : historical,
    );
  }, [chatId, historical, historyVersion, loading, setMessages]);

  // 创建专属会话完成后补发挂起的 prompt
  useEffect(() => {
    if (!chatId || loading || creatingChat) return;
    const pending = pendingSendRef.current;
    if (!pending) return;
    pendingSendRef.current = null;
    send(
      pending.prompt,
      pending.images ?? undefined,
      pending.display ? { displayContent: pending.display } : undefined,
    );
  }, [chatId, creatingChat, loading, send]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /** 构造图表专属 freeform prompt（含 Agent 能力契约）。 */
  const buildPrompt = useCallback(
    (question: string): string => {
      if (!note) return question;
      const parsed = parseDiagramMarkdown(note.contentMarkdown);
      if (!parsed.ok) return question;
      const doc = parsed.document;
      const revision = requestDocStateRef.current?.revision ?? 0;
      const indexMd = buildDiagramIndexMarkdown(note.title, doc);
      const contract = buildAgentContract(doc.diagramKind);
      const docHash = computeDiagramDocumentHash(doc);
      const semanticHash = computeDiagramSemanticHash(doc);
      return [
        "用户正在图表编辑器中处理当前图。请围绕图表内容回答用户问题。",
        "",
        `用户问题：\n${question}`,
        "",
        `当前图表标题：${note.title}`,
        "当前图表索引：",
        indexMd,
        "",
        `文档状态：revision=${revision}, documentHash=${docHash}, semanticHash=${semanticHash}`,
        "",
        "回答规则：",
        "1. 如果用户的意图是修改图表，按下面的契约输出结构化结果；",
        "2. 如果只是提问或讨论，正常回答即可，不要输出 fenced block；",
        "3. 所有修改统一用 ```mona-diagram-patch fenced block；",
        "4. 不要追问，不要询问更多信息。",
        "",
        contract,
      ].join("\n");
    },
    [note],
  );

  // AI 回答完成后：dry-run patch，文档状态未变则自动应用，否则标记 stale
  useEffect(() => {
    if (loading || creatingChat || isStreaming || !note) return;
    const completedMessage = messages
      .filter(
        (item) =>
          item.role === "assistant" &&
          !item.isStreaming &&
          item.content.trim().length > 0 &&
          !preparedMessageIdsRef.current.has(item.id),
      )
      .pop();
    if (!completedMessage) return;

    preparedMessageIdsRef.current.add(completedMessage.id);
    const requestDocState = requestDocStateRef.current;
    const result = prepareDiagramPatch(
      completedMessage.content,
      note.contentMarkdown,
      completedMessage.id,
      requestDocState ?? { revision: 0, documentHash: "", semanticHash: "" },
    );
    if (!result.ok) return; // 纯讨论，无 patch

    const pending = result.pending;
    const record = (status: PendingDiagramPatch["status"]) =>
      setPendingPatches((prev) => {
        const next = new Map(prev);
        next.set(
          completedMessage.id,
          status === pending.status ? pending : { ...pending, status },
        );
        return next;
      });

    if (pending.status === "invalid") {
      record("invalid");
      requestDocStateRef.current = null;
      return;
    }

    const docUnchanged =
      !!requestDocState &&
      !!currentDocState &&
      requestDocState.revision === currentDocState.revision &&
      requestDocState.documentHash === currentDocState.documentHash;

    if (docUnchanged && currentDocState) {
      const applyResult = applyPendingDiagramPatch(
        pending,
        note.contentMarkdown,
        note.title || "未命名图表",
        currentDocState,
      );
      if (applyResult.ok) {
        onApplyResult(applyResult.markdown, completedMessage.id);
        setNotice(applyResult.notice);
        record("applied");
      } else {
        record("stale");
      }
    } else if (requestDocState && currentDocState) {
      // 生成期间文档已变化：标记 stale
      record("stale");
    } else {
      // 缺少文档状态快照（上下文未就绪）：保留手动确认
      record(pending.status);
    }
    requestDocStateRef.current = null;
  }, [creatingChat, isStreaming, loading, messages, note, currentDocState, onApplyResult]);

  /** 发送 prompt：校验输入、记录 docState、复用现有会话或创建专属会话。 */
  const sendPromptToAgent = useCallback(
    async (prompt: string, images?: SendImage[], displayContent?: string): Promise<boolean> => {
      if (!note) return false;
      const trimmed = prompt.trim();
      if ((!trimmed && (!images || images.length === 0)) || creatingChat) return false;
      if (isStreaming) {
        setNotice("Agent 正在处理，先停止或等它完成");
        return false;
      }
      // 记录发起请求时的文档状态，用于后续 stale 检测
      requestDocStateRef.current = currentDocState;

      if (chatId) {
        send(trimmed, images, displayContent ? { displayContent } : undefined);
        return true;
      }
      if (!client) {
        setNotice("运行时未就绪，请稍后再试");
        return false;
      }

      setCreatingChat(true);
      setNotice("正在创建图表专属会话");
      pendingSendRef.current = {
        prompt: trimmed,
        display: displayContent ?? null,
        images: images ?? null,
      };
      try {
        const nextChatId = await client.newChat(5_000, true);
        onAgentChatIdChange(nextChatId);
        return true;
      } catch {
        pendingSendRef.current = null;
        setNotice("创建会话失败");
        return false;
      } finally {
        setCreatingChat(false);
      }
    },
    [chatId, client, creatingChat, isStreaming, note, onAgentChatIdChange, send, currentDocState],
  );

  const sendDraft = useCallback(
    (text: string, images?: SendImage[]) => {
      if (!note) return;
      const question = text.trim();
      if (!question && (!images || images.length === 0)) return;
      void sendPromptToAgent(buildPrompt(question), images, question);
    },
    [note, buildPrompt, sendPromptToAgent],
  );

  // 更新 pending patch 状态（手动应用/忽略/失败回退共用）
  const setPatchStatus = useCallback(
    (messageId: string, status: PendingDiagramPatch["status"]) => {
      setPendingPatches((prev) => {
        const next = new Map(prev);
        const p = next.get(messageId);
        if (p) next.set(messageId, { ...p, status });
        return next;
      });
    },
    [],
  );

  // 手动应用 pending patch：再次校验当前文档状态
  const applyPatch = useCallback(
    (messageId: string) => {
      if (!note || !currentDocState) return;
      const pending = pendingPatches.get(messageId);
      if (!pending) return;
      const result = applyPendingDiagramPatch(
        pending,
        note.contentMarkdown,
        note.title || "未命名图表",
        currentDocState,
      );
      if (!result.ok) {
        setNotice(result.notice);
        setPatchStatus(messageId, "stale");
        return;
      }
      onApplyResult(result.markdown, messageId);
      setNotice(result.notice);
      setPatchStatus(messageId, "applied");
    },
    [note, currentDocState, onApplyResult, pendingPatches, setPatchStatus],
  );

  if (collapsed) return null;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-border/70 bg-background"
      style={{ width }}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <h2 className="truncate text-[13px] font-semibold text-foreground">Mona</h2>
        <div className="flex items-center gap-1">
          {notice ? (
            <span className="max-w-28 truncate text-[11px] text-muted-foreground">{notice}</span>
          ) : null}
          {chatId ? (
            <button
              type="button"
              aria-label="重置会话"
              title="重置会话"
              disabled={isStreaming || creatingChat}
              onClick={() => {
                setMessages([]);
                setPendingPatches(new Map());
                preparedMessageIdsRef.current = new Set();
                onClearChat?.();
              }}
              className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 scrollbar-thin">
        <AgentChat
          messages={messages}
          loading={loading}
          historyError={historyError}
          streamError={streamError?.kind ?? null}
          isStreaming={isStreaming}
          creatingChat={creatingChat}
          appliedMessageIds={note?.appliedAgentMessageIds ?? []}
          autoAppliedMessageIds={preparedMessageIdsRef.current}
          canSaveAsNote={false}
          canAppend={false}
          onAppend={() => {}}
          onReplace={() => {}}
          onCopy={async (m) => {
            try {
              await navigator.clipboard.writeText(m.content);
              setNotice("结果已复制");
            } catch {
              setNotice("复制失败");
            }
          }}
          onSaveAsNote={() => {}}
          onDismissStreamError={dismissStreamError}
        />

        {pendingPatches.size > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {Array.from(pendingPatches.entries()).map(([messageId, pending]) => (
              <DiagramPatchCard
                key={messageId}
                pending={pending}
                onApply={() => applyPatch(messageId)}
                onIgnore={() => setPatchStatus(messageId, "ignored")}
              />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 p-2">
        <AgentComposer
          value={draft}
          onChange={setDraft}
          onSend={sendDraft}
          disabled={!note || creatingChat}
          placeholder="让 AI 生成、续写或优化图表..."
          isStreaming={isStreaming}
          creatingChat={creatingChat}
          onStop={stop}
        />
      </div>
    </aside>
  );
}

/** 变更卡片：展示 patch 摘要，提供应用/忽略按钮。 */
function DiagramPatchCard({
  pending,
  onApply,
  onIgnore,
}: {
  pending: PendingDiagramPatch;
  onApply: () => void;
  onIgnore: () => void;
}) {
  const { status, error } = pending;
  if (status === "ignored") return null;

  if (status === "applied") {
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-[hsl(var(--flowchart-success)/0.3)] bg-[hsl(var(--flowchart-success)/0.08)] px-2.5 py-2 text-[11px] font-medium text-[hsl(var(--flowchart-success))]">
        <Check className="h-3.5 w-3.5" />
        已应用到图表
      </div>
    );
  }

  if (status === "invalid") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
        <div className="flex items-center gap-1.5 font-medium">
          <AlertTriangle className="h-3.5 w-3.5" />
          修改无效
        </div>
        {error ? <div className="mt-1 text-destructive/80">{error}</div> : null}
      </div>
    );
  }

  const isStale = status === "stale";
  return (
    <div
      className={`rounded-md border px-2.5 py-2 text-[11px] ${
        isStale ? "border-amber-500/40 bg-amber-500/5" : "border-border/70 bg-muted/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          {isStale ? "图表已修改，该建议过期" : "AI 建议修改"}
        </span>
        <button
          type="button"
          aria-label="忽略"
          title="忽略"
          onClick={onIgnore}
          className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="mt-1.5 text-muted-foreground">{formatDiagramSummary(pending.summary)}</div>
      {isStale ? (
        <div className="mt-1.5 text-amber-700 dark:text-amber-400">请基于最新图表重新生成</div>
      ) : (
        <button
          type="button"
          onClick={onApply}
          className="mt-2 inline-flex h-7 items-center gap-1 rounded-md bg-foreground px-2.5 text-[11px] font-medium text-background hover:bg-foreground/90"
        >
          <Check className="h-3 w-3" />
          应用到图表
        </button>
      )}
    </div>
  );
}
