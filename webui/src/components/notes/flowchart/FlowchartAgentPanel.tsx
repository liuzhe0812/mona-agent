/**
 * 流程图 AI 面板：连续会话、patch 预览后确认应用。
 *
 * 设计依据：docs/design/2026-07-29-ai-flowchart-notes-feature-design.md §9.10, §9.11
 *           docs/design/2026-07-29-wps-flowchart-gap-development-plan.md §7.1, §7.2
 *
 * 主要职责：
 * 1. AI 回答完成后仅做 parse + dry-run，生成 PendingFlowchartPatch；
 * 2. 在变更卡片上展示变更摘要，用户点击"应用到流程图"后才修改文档；
 * 3. 生成期间语义变化（baseHash 不匹配）时标记 stale，禁止应用；
 * 4. 拖动节点或改样式不改变 semantic hash，不会使 patch 过期。
 *
 * 与 MindMapAgentPanel 的差异：
 * - 流程图只有 patch 一种 fenced block（没有 mindmap 那种 replace + patch 双契约）；
 * - 选区是 nodeIds/edgeIds，不是 path；
 * - 所有 AI 修改都不自动应用，必须经过变更卡片确认。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  RotateCcw,
  X,
} from "lucide-react";

import { useMonaStream, type SendImage } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";
import { useClientOptional } from "@/providers/ClientProvider";
import {
  buildFlowchartFreeformPrompt,
  inferNoteActionDisplayLabel,
} from "../notes-ai";
import type { OperationNote } from "../notes-data";
import {
  applyPendingPatch,
  prepareFlowchartPatch,
  type PendingFlowchartPatch,
} from "./flowchart-apply";
import { useFlowchartSelection } from "./FlowchartSelectionContext";
import { AgentChat } from "../NoteAgentPanel";
import { AgentComposer } from "../AgentComposer";

interface FlowchartAgentPanelProps {
  note: OperationNote | null;
  collapsed?: boolean;
  width?: number;
  onAgentChatIdChange: (chatId: string) => void;
  onApplyResult: (mode: "append" | "replace", markdown: string, messageId: string) => void;
  onClearChat?: () => void;
  onStreamingChange?: (streaming: boolean) => void;
  /**
   * 初始 prompt：用于"从笔记生成流程图"等场景（设计文档 §7.10）。
   * 当 note 切换到对应 noteId 且 requestId 是新的时，自动调用 sendPromptToAgent。
   * 处理完成后调用 onInitialPromptHandled 通知 NotesView 清空请求。
   */
  initialPrompt?: {
    prompt: string;
    displayContent: string;
    requestId: number;
  } | null;
  onInitialPromptHandled?: () => void;
}

export function FlowchartAgentPanel({
  note,
  collapsed: collapsedProp,
  width = 306,
  onAgentChatIdChange,
  onApplyResult,
  onClearChat,
  onStreamingChange,
  initialPrompt,
  onInitialPromptHandled,
}: FlowchartAgentPanelProps) {
  const [draft, setDraft] = useState("");
  const collapsed = collapsedProp ?? false;
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingDisplayContentRef = useRef<string | null>(null);
  const pendingImagesRef = useRef<SendImage[] | null>(null);
  /** 发起请求时记录的 baseHash，用于检测生成期间语义变化 */
  const requestBaseHashRef = useRef<string | null>(null);
  /** 已 prepare 过的 message ID，避免重复 dry-run */
  const preparedMessageIdsRef = useRef<Set<string>>(new Set());
  /** 待确认的 patch 列表（按 message 索引） */
  const [pendingPatches, setPendingPatches] = useState<Map<string, PendingFlowchartPatch>>(
    () => new Map(),
  );
  const lastNoteIdRef = useRef<string | null | undefined>(note?.id);
  const { client } = useClientOptional();
  const flowchartSelectionCtx = useFlowchartSelection();

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
    requestBaseHashRef.current = null;
    preparedMessageIdsRef.current = new Set();
    setPendingPatches(new Map());
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
    if (!pendingPrompt && !pendingImagesRef.current) return;
    const pendingDisplay = pendingDisplayContentRef.current;
    const pendingImages = pendingImagesRef.current;
    pendingPromptRef.current = null;
    pendingDisplayContentRef.current = null;
    pendingImagesRef.current = null;
    send(
      pendingPrompt ?? "",
      pendingImages ?? undefined,
      pendingDisplay ? { displayContent: pendingDisplay } : undefined,
    );
  }, [chatId, creatingChat, loading, send]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // AI 回答完成后只做 prepare（dry-run）并写入变更卡片；
  // 任何情况下都必须由用户点击"应用到流程图"后才提交修改。
  useEffect(() => {
    if (loading || creatingChat || isStreaming) return;
    if (!note || note.type !== "flowchart") return;
    // 找到最新的、未 prepare 过的 assistant 完成消息
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
    const requestBaseHash = requestBaseHashRef.current ?? flowchartSelectionCtx.baseHash ?? "";
    const result = prepareFlowchartPatch(
      completedMessage.content,
      note.contentMarkdown,
      note.title || "未命名流程图",
      completedMessage.id,
      requestBaseHash,
    );
    if (!result.ok) {
      // AI 没返回 patch（如 audit 纯文本回答），不展示变更卡片
      return;
    }

    const currentHash = flowchartSelectionCtx.baseHash ?? "";
    // 不自动应用：baseHash 匹配 → ready（等待用户确认）；不匹配 → stale
    const status = result.pending.requestBaseHash === currentHash ? "ready" : "stale";
    setPendingPatches((prev) => {
      const next = new Map(prev);
      next.set(completedMessage.id, { ...result.pending, status });
      return next;
    });
    requestBaseHashRef.current = null;
  }, [creatingChat, isStreaming, loading, messages, note, flowchartSelectionCtx.baseHash]);

  // stale 检测：当前文档 baseHash 与 requestBaseHash 不同时，标记 pending 为 stale
  const currentBaseHash = flowchartSelectionCtx.baseHash;
  useEffect(() => {
    if (!currentBaseHash) return;
    setPendingPatches((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [messageId, pending] of next) {
        if (pending.status === "ready" && pending.requestBaseHash !== currentBaseHash) {
          next.set(messageId, { ...pending, status: "stale" });
          changed = true;
        } else if (pending.status === "stale" && pending.requestBaseHash === currentBaseHash) {
          // 用户撤销回原 hash，恢复 ready
          next.set(messageId, { ...pending, status: "ready" });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [currentBaseHash]);

  const sendPromptToAgent = useCallback(
    async (prompt: string, images?: SendImage[], displayContent?: string) => {
      if (!note) return false;
      const trimmed = prompt.trim();
      if ((!trimmed && (!images || images.length === 0)) || creatingChat) return false;
      if (isStreaming) {
        setNotice("Agent 正在处理，先停止或等它完成");
        return false;
      }

      // 记录发起请求时的 baseHash，用于后续 stale 检测
      requestBaseHashRef.current = flowchartSelectionCtx.baseHash ?? null;

      if (chatId) {
        send(trimmed, images, displayContent ? { displayContent } : undefined);
        return true;
      }

      if (!client) {
        setNotice("运行时未就绪，请稍后再试");
        return false;
      }

      setCreatingChat(true);
      setNotice("正在创建流程图专属会话");
      pendingPromptRef.current = trimmed;
      pendingDisplayContentRef.current = displayContent ?? null;
      pendingImagesRef.current = images ?? null;
      try {
        const nextChatId = await client.newChat(5_000, true);
        onAgentChatIdChange(nextChatId);
        return true;
      } catch {
        pendingPromptRef.current = null;
        pendingDisplayContentRef.current = null;
        pendingImagesRef.current = null;
        setNotice("创建会话失败");
        return false;
      } finally {
        setCreatingChat(false);
      }
    },
    [chatId, client, creatingChat, isStreaming, note, onAgentChatIdChange, send, flowchartSelectionCtx.baseHash],
  );

  const sendDraft = useCallback((text: string, images?: SendImage[]) => {
    if (!note) return;
    const question = text.trim();
    if (!question && (!images || images.length === 0)) return;
    const baseHash = flowchartSelectionCtx.baseHash ?? "";
    const selection =
      flowchartSelectionCtx.noteId === note.id ? flowchartSelectionCtx.selection : null;
    void sendPromptToAgent(
      buildFlowchartFreeformPrompt(note, question, selection, baseHash),
      images,
      question,
    );
  }, [note, flowchartSelectionCtx, sendPromptToAgent]);

  // 从普通笔记生成流程图时的初始 prompt（设计文档 §7.10）
  const lastHandledInitialPromptIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!initialPrompt) return;
    if (lastHandledInitialPromptIdRef.current === initialPrompt.requestId) return;
    if (!note) return;
    lastHandledInitialPromptIdRef.current = initialPrompt.requestId;
    void sendPromptToAgent(initialPrompt.prompt, undefined, initialPrompt.displayContent).then(
      (ok) => {
        if (ok) onInitialPromptHandled?.();
      },
    );
  }, [initialPrompt, note, sendPromptToAgent, onInitialPromptHandled]);

  const copyResult = useCallback(async (message: UIMessage) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setNotice("结果已复制");
    } catch {
      setNotice("复制失败");
    }
  }, []);

  // 应用 pending patch：再次校验 baseHash，通过后提交
  const applyPatch = useCallback(
    (messageId: string) => {
      if (note?.type !== "flowchart") return;
      const pending = pendingPatches.get(messageId);
      if (!pending) return;
      const result = applyPendingPatch(
        pending,
        note.contentMarkdown,
        note.title || "未命名流程图",
      );
      if (!result.ok) {
        setNotice(result.notice);
        // 标记为 stale
        setPendingPatches((prev) => {
          const next = new Map(prev);
          const p = next.get(messageId);
          if (p) next.set(messageId, { ...p, status: "stale" });
          return next;
        });
        return;
      }
      onApplyResult("replace", result.markdown, messageId);
      setNotice(result.notice);
      setPendingPatches((prev) => {
        const next = new Map(prev);
        const p = next.get(messageId);
        if (p) next.set(messageId, { ...p, status: "applied" });
        return next;
      });
    },
    [note, onApplyResult, pendingPatches],
  );

  const ignorePatch = useCallback((messageId: string) => {
    setPendingPatches((prev) => {
      const next = new Map(prev);
      const p = next.get(messageId);
      if (p) next.set(messageId, { ...p, status: "ignored" });
      return next;
    });
  }, []);

  if (collapsed) {
    return null;
  }

  return (
    <aside className="flex h-full shrink-0 flex-col border-l border-border/70 bg-card" style={{ width }}>
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
                setPendingPatches(new Map());
                preparedMessageIdsRef.current = new Set();
                onClearChat?.();
              }}
              className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
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
          onReplace={() => {
            // 不再走旧的自动应用路径；应用通过变更卡片触发
          }}
          onCopy={copyResult}
          onSaveAsNote={() => {}}
          onDismissStreamError={dismissStreamError}
        />

        {/* 待确认的变更卡片列表 */}
        {pendingPatches.size > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {Array.from(pendingPatches.entries()).map(([messageId, pending]) => (
              <FlowchartPatchCard
                key={messageId}
                pending={pending}
                onApply={() => applyPatch(messageId)}
                onIgnore={() => ignorePatch(messageId)}
              />
            ))}
          </div>
        )}

        {/* 生成期间提示 */}
        {isStreaming && requestBaseHashRef.current && (
          <div className="mt-2 rounded-md border border-blue-500/30 bg-blue-500/5 px-2.5 py-2 text-[11px] text-blue-700 dark:text-blue-300">
            AI 正在生成。拖动节点或改样式不会使结果过期；修改文字、增删节点或连线会使结果过期。
          </div>
        )}
      </div>

      <div className="shrink-0 p-2">
        <AgentComposer
          value={draft}
          onChange={setDraft}
          onSend={sendDraft}
          disabled={!note || creatingChat}
          placeholder="让 AI 生成、续写或优化流程图..."
          isStreaming={isStreaming}
          creatingChat={creatingChat}
          onStop={stop}
        />
      </div>
    </aside>
  );
}

/** 变更卡片：展示 patch 摘要，提供应用/忽略按钮 */
function FlowchartPatchCard({
  pending,
  onApply,
  onIgnore,
}: {
  pending: PendingFlowchartPatch;
  onApply: () => void;
  onIgnore: () => void;
}) {
  const { summary, status, error } = pending;

  if (status === "applied") {
    return (
      <div className="rounded-md border border-[hsl(var(--flowchart-success)/0.3)] bg-[hsl(var(--flowchart-success)/0.08)] px-2.5 py-2 text-[11px] text-[hsl(var(--flowchart-success))]">
        <div className="flex items-center gap-1.5 font-medium">
          <Check className="h-3.5 w-3.5" />
          已应用到流程图
        </div>
      </div>
    );
  }

  if (status === "ignored") {
    return null;
  }

  if (status === "invalid") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
        <div className="flex items-center gap-1.5 font-medium">
          <AlertTriangle className="h-3.5 w-3.5" />
          修改无效
        </div>
        <div className="mt-1 text-destructive/80">{error}</div>
      </div>
    );
  }

  const isStale = status === "stale";

  return (
    <div
      className={`rounded-md border px-2.5 py-2 text-[11px] ${
        isStale
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-border/70 bg-muted/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          {isStale ? "流程图已修改，该建议过期" : "AI 建议修改"}
        </span>
        <button
          type="button"
          aria-label="忽略"
          title="忽略"
          onClick={onIgnore}
          className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="mt-1.5 text-muted-foreground">
        {summary.replacedGraph ? (
          <span>将替换完整流程图</span>
        ) : (
          <div className="flex flex-wrap gap-x-2 gap-y-0.5">
            {summary.addedPools > 0 && <span>新增 {summary.addedPools} 泳池</span>}
            {summary.addedLanes > 0 && <span>新增 {summary.addedLanes} 泳道</span>}
            {summary.movedToLane > 0 && <span>移动 {summary.movedToLane} 节点归属</span>}
            {summary.addedNodes > 0 && <span>新增 {summary.addedNodes} 节点</span>}
            {summary.updatedNodes > 0 && <span>修改 {summary.updatedNodes} 节点</span>}
            {summary.removedNodes > 0 && <span className="text-destructive/80">删除 {summary.removedNodes} 节点</span>}
            {summary.addedEdges > 0 && <span>新增 {summary.addedEdges} 连线</span>}
            {summary.updatedEdges > 0 && <span>修改 {summary.updatedEdges} 连线</span>}
            {summary.removedEdges > 0 && <span className="text-destructive/80">删除 {summary.removedEdges} 连线</span>}
          </div>
        )}
      </div>

      {!isStale && (
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            onClick={onApply}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-action px-2.5 text-micro font-medium text-white hover:bg-action-hover hover:text-white"
          >
            <Check className="h-3 w-3" />
            应用到流程图
          </button>
        </div>
      )}
      {isStale && (
        <div className="mt-1.5 text-amber-700 dark:text-amber-400">
          请基于最新流程图重新生成
        </div>
      )}
    </div>
  );
}

