import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Clipboard,
  Copy,
  FileCode2,
  FilePlus2,
  Languages,
  Loader2,
  Pencil,
  Plus,
  Replace,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";

import { MessageBubble } from "@/components/MessageBubble";
import { AgentLogo } from "@/components/AgentLogo";
import { AgentActivityCluster } from "@/components/thread/AgentActivityCluster";
import { buildDisplayUnits, type DisplayUnit } from "@/components/thread/ThreadMessages";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { deriveNoteTitle } from "@/lib/note-title";
import { useMonaStream, type SendImage } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";
import { useClientOptional } from "@/providers/ClientProvider";
import { exportNoteTempFile, isTauri } from "@/lib/tauri";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import {
  NOTE_AI_ACTIONS,
  buildAgentActionPrompt,
  buildAgentResultMarkdown,
  buildFreeformAgentPrompt,
  buildTransformationPrompt,
  inferNoteActionDisplayLabel,
} from "./notes-ai";
import {
  applyPendingNotePatch,
  computeNoteBaseHash,
  hasStructuredNoteEdit,
  prepareNotePatch,
  type PendingNotePatch,
} from "./note-apply";
import { ConfirmDialog } from "./NotesDialogs";
import {
  TRANSFORMATION_VARIABLES,
  type NoteAiActionId,
  type NoteTransformation,
  type OperationNote,
} from "./notes-data";
import { nowTimestamp } from "./notes-data";

interface NoteAgentPanelProps {
  note: OperationNote | null;
  transformations: NoteTransformation[];
  collapsed?: boolean;
  width?: number;
  onAgentChatIdChange: (chatId: string) => void;
  onApplyResult: (mode: "append" | "replace", markdown: string, messageId: string) => void;
  onSaveAsNote?: (markdown: string, title: string) => void;
  onTransformationsChange: (transformations: NoteTransformation[]) => void;
  onClearChat?: () => void;
  onStreamingChange?: (streaming: boolean) => void;
}

export function NoteAgentPanel({
  note,
  transformations,
  collapsed: collapsedProp,
  width = 306,
  onAgentChatIdChange,
  onApplyResult,
  onSaveAsNote,
  onTransformationsChange,
  onClearChat,
  onStreamingChange,
}: NoteAgentPanelProps) {
  const collapsed = collapsedProp ?? false;
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [replaceConfirmMessage, setReplaceConfirmMessage] = useState<UIMessage | null>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingDisplayContentRef = useRef<string | null>(null);
  const pendingImagesRef = useRef<SendImage[] | null>(null);
  // 普通笔记 action 中只有 translate 自动应用
  const pendingActionRef = useRef<Exclude<NoteAiActionId, "freeform"> | null>(null);
  const autoAppliedMessageIdsRef = useRef<Set<string>>(new Set());
  /** 发起 note-patch 请求时快照的正文哈希（undefined 表示当前回答不参与自动修改） */
  const requestBaseHashRef = useRef<string | null>(null);
  /** 已 dry-run 过的 message ID，避免重复解析 */
  const preparedMessageIdsRef = useRef<Set<string>>(new Set());
  /** 是否已回看过历史中的结构化修改（每个会话只回看一次） */
  const historyScannedRef = useRef(false);
  /** 待确认的笔记修改（按 message ID 索引） */
  const [pendingPatches, setPendingPatches] = useState<Map<string, PendingNotePatch>>(
    () => new Map(),
  );
  const lastNoteIdRef = useRef<string | null | undefined>(note?.id);
  const { client } = useClientOptional();

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

  useEffect(() => {
    const noteId = note?.id ?? null;
    if (lastNoteIdRef.current === noteId) return;
    lastNoteIdRef.current = noteId;
    setNotice(null);
    pendingActionRef.current = null;
    autoAppliedMessageIdsRef.current = new Set();
    requestBaseHashRef.current = null;
    preparedMessageIdsRef.current = new Set();
    historyScannedRef.current = false;
    setPendingPatches(new Map());
    if (!note?.agentChatId) setMessages([]);
  }, [note?.id, note?.agentChatId, setMessages]);

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
    const pendingImages = pendingImagesRef.current ?? undefined;
    pendingPromptRef.current = null;
    pendingDisplayContentRef.current = null;
    pendingImagesRef.current = null;
    send(
      pendingPrompt,
      pendingImages,
      pendingDisplay ? { displayContent: pendingDisplay } : undefined,
    );
  }, [chatId, creatingChat, loading, send]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const action = pendingActionRef.current;
    if (!action || loading || creatingChat || isStreaming) return;
    if (action !== "translate") return;

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

    const markdown = buildAgentResultMarkdown(completedMessage.content);
    if (!markdown) return;

    onApplyResult("replace", markdown, completedMessage.id);
    setNotice("已替换笔记正文");
  }, [creatingChat, isStreaming, loading, messages, note, onApplyResult]);

  // AI 回答完成后解析结构化修改指令：baseHash 仍匹配的 note-patch 自动应用，
  // 否则（笔记在生成期间被改过 / 整篇重写）留给用户手动确认。
  useEffect(() => {
    if (loading || creatingChat || isStreaming) return;
    if (!note) return;
    // translate 等快速操作走上面的自动替换路径
    if (pendingActionRef.current === "translate") return;

    const appliedIds = new Set(note.appliedAgentMessageIds ?? []);
    const candidates = messages.filter(
      (item) =>
        item.role === "assistant" &&
        !item.isStreaming &&
        item.content.trim().length > 0 &&
        !preparedMessageIdsRef.current.has(item.id) &&
        !appliedIds.has(item.id),
    );

    const liveBaseHash = requestBaseHashRef.current;
    let completedMessage = liveBaseHash ? candidates[candidates.length - 1] : undefined;
    if (!completedMessage && !liveBaseHash) {
      // 本次会话没有发起过修改请求：回看历史里最后一条未应用的结构化修改（重启后可手动应用）
      if (historyScannedRef.current) return;
      completedMessage = [...candidates]
        .reverse()
        .find((item) => hasStructuredNoteEdit(item.content));
    }
    if (!completedMessage) return;
    historyScannedRef.current = true;

    preparedMessageIdsRef.current.add(completedMessage.id);
    requestBaseHashRef.current = null;

    const result = prepareNotePatch(
      completedMessage.content,
      note.contentMarkdown,
      completedMessage.id,
      liveBaseHash ?? computeNoteBaseHash(note.contentMarkdown),
    );
    // 普通回答（无结构化 block）：不展示变更卡片，保留追加/替换按钮
    if (!result.ok) return;

    const currentHash = computeNoteBaseHash(note.contentMarkdown);
    const basisHash = liveBaseHash ?? result.pending.patch?.baseHash ?? currentHash;
    if (result.pending.status === "ready" && result.pending.mode === "patch") {
      const applied = applyPendingNotePatch(result.pending, note.contentMarkdown);
      if (applied.ok) {
        autoAppliedMessageIdsRef.current.add(completedMessage.id);
        onApplyResult("replace", applied.markdown, completedMessage.id);
        setNotice(applied.notice);
      } else {
        setPendingPatches((prev) =>
          new Map(prev).set(completedMessage.id, {
            ...result.pending,
            status: "stale",
            error: applied.message,
          }),
        );
      }
      return;
    }

    setPendingPatches((prev) =>
      new Map(prev).set(completedMessage.id, {
        ...result.pending,
        requestBaseHash: basisHash,
        status:
          result.pending.status === "invalid"
            ? "invalid"
            : basisHash === currentHash
              ? "ready"
              : "stale",
      }),
    );
  }, [creatingChat, isStreaming, loading, messages, note, onApplyResult]);

  // 笔记正文变化时刷新待确认卡片状态：patch 的 baseHash 与当前正文一致才可应用。
  const currentNoteHash = note ? computeNoteBaseHash(note.contentMarkdown) : "";
  useEffect(() => {
    if (!currentNoteHash) return;
    setPendingPatches((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [messageId, pending] of next) {
        if (
          pending.mode !== "patch"
          || pending.status === "applied"
          || pending.status === "ignored"
          || pending.status === "invalid"
        ) {
          continue;
        }
        const canApplyNow = pending.patch?.baseHash === currentNoteHash;
        if (pending.status === "ready" && !canApplyNow) {
          next.set(messageId, { ...pending, status: "stale" });
          changed = true;
        } else if (pending.status === "stale" && canApplyNow) {
          next.set(messageId, { ...pending, status: "ready" });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [currentNoteHash]);

  const sendPromptToAgent = useCallback(
    async (prompt: string, displayContent?: string, images?: SendImage[]) => {
      if (!note) return false;
      const trimmed = prompt.trim();
      const hasImages = !!images && images.length > 0;
      if ((!trimmed && !hasImages) || creatingChat) return false;
      if (isStreaming) {
        setNotice("Agent 正在处理，先停止或等它完成");
        return false;
      }

      const finalPrompt = trimmed;
      const options = displayContent ? { displayContent } : undefined;

      if (chatId) {
        send(finalPrompt, images, options);
        return true;
      }

      if (!client) {
        setNotice("运行时未就绪，请稍后再试");
        return false;
      }

      setCreatingChat(true);
      setNotice("正在创建笔记专属会话");
      pendingPromptRef.current = finalPrompt;
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
    [chatId, client, creatingChat, isStreaming, note, onAgentChatIdChange, send],
  );

  const runAction = useCallback(
    async (actionId: Exclude<NoteAiActionId, "freeform">) => {
      if (!note) return;
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
        buildAgentActionPrompt(actionId, note, filePath),
        label,
      );
      if (!sent) {
        pendingActionRef.current = null;
      }
    },
    [note, sendPromptToAgent],
  );

  const runTransformation = useCallback(
    async (transformation: NoteTransformation) => {
      if (!note) return;
      const prompt = buildTransformationPrompt(transformation, note);
      await sendPromptToAgent(prompt, transformation.name);
    },
    [note, sendPromptToAgent],
  );

  // 自由对话：带上正文哈希，AI 才能返回可自动应用的 note-patch。
  const sendDraft = useCallback(
    async (text: string, images?: SendImage[], displayContent?: string) => {
      if (!note) return;
      const question = text.trim();
      if (!question && (!images || images.length === 0)) return;
      const baseHash = computeNoteBaseHash(note.contentMarkdown);
      requestBaseHashRef.current = baseHash;
      const sent = await sendPromptToAgent(
        buildFreeformAgentPrompt(note, question, baseHash),
        displayContent ?? question,
        images,
      );
      if (!sent) requestBaseHashRef.current = null;
    },
    [note, sendPromptToAgent],
  );

  // 应用待确认修改：再次校验 baseHash 后提交
  const applyPatchFromCard = useCallback(
    (messageId: string) => {
      if (!note) return;
      const pending = pendingPatches.get(messageId);
      if (!pending) return;
      const result = applyPendingNotePatch(pending, note.contentMarkdown);
      if (!result.ok) {
        setNotice(result.notice);
        setPendingPatches((prev) => {
          const next = new Map(prev);
          const item = next.get(messageId);
          if (item) next.set(messageId, { ...item, status: "stale", error: result.message });
          return next;
        });
        return;
      }
      onApplyResult("replace", result.markdown, messageId);
      setNotice(result.notice);
      setPendingPatches((prev) => {
        const next = new Map(prev);
        const item = next.get(messageId);
        if (item) next.set(messageId, { ...item, status: "applied" });
        return next;
      });
    },
    [note, onApplyResult, pendingPatches],
  );

  const ignorePatch = useCallback((messageId: string) => {
    setPendingPatches((prev) => {
      const next = new Map(prev);
      const item = next.get(messageId);
      if (item) next.set(messageId, { ...item, status: "ignored" });
      return next;
    });
  }, []);

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

  const saveAsNote = useCallback(
    (message: UIMessage) => {
      if (!onSaveAsNote) return;
      const markdown = buildAgentResultMarkdown(message.content);
      if (!markdown) return;
      const title = deriveNoteTitle(markdown, `AI 回复 ${new Date().toLocaleString("zh-CN")}`);
      onSaveAsNote(markdown, title);
      setNotice("已保存为新笔记");
    },
    [onSaveAsNote],
  );

  // Transformation management dialog state
  const [managerOpen, setManagerOpen] = useState(false);
  const [editingTransformation, setEditingTransformation] = useState<NoteTransformation | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<NoteTransformation | null>(null);

  const handleCreateTransformation = useCallback(() => {
    setEditingTransformation({
      id: `transformation-${crypto.randomUUID()}`,
      name: "",
      description: "",
      promptTemplate: "",
      createdAt: nowTimestamp(),
      updatedAt: nowTimestamp(),
    });
  }, []);

  const handleEditTransformation = useCallback((transformation: NoteTransformation) => {
    setEditingTransformation({ ...transformation });
  }, []);

  const handleSaveTransformation = useCallback(
    (transformation: NoteTransformation) => {
      const name = transformation.name.trim();
      if (!name) {
        setNotice("模板名称不能为空");
        return;
      }
      if (!transformation.promptTemplate.trim()) {
        setNotice("模板内容不能为空");
        return;
      }
      const updated: NoteTransformation = {
        ...transformation,
        name,
        updatedAt: nowTimestamp(),
      };
      const exists = transformations.some((t) => t.id === updated.id);
      const next = exists
        ? transformations.map((t) => (t.id === updated.id ? updated : t))
        : [...transformations, updated];
      onTransformationsChange(next);
      setEditingTransformation(null);
      setNotice(exists ? "模板已更新" : "模板已创建");
    },
    [onTransformationsChange, transformations],
  );

  const handleDeleteTransformation = useCallback(
    (transformation: NoteTransformation) => {
      onTransformationsChange(transformations.filter((t) => t.id !== transformation.id));
      setDeleteCandidate(null);
      setNotice("模板已删除");
    },
    [onTransformationsChange, transformations],
  );

  /** 含结构化修改指令的回答：隐藏「追加/替换」，避免把 JSON block 写进正文 */
  const structuredEditMessageIds = useMemo(
    () => messages.filter((message) => hasStructuredNoteEdit(message.content)).map((m) => m.id),
    [messages],
  );

  if (collapsed) {
    return null;
  }

  return (
    <>
    <aside className="flex h-full shrink-0 flex-col border-l border-border/70 bg-card" style={{ width }}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-ui font-semibold text-foreground">Mona</h2>
        </div>
        <div className="flex items-center gap-1">
          {notice ? <span className="max-w-28 truncate text-micro text-muted-foreground">{notice}</span> : null}
          {chatId ? (
            <Button
              type="button"
              variant="ghost"
              aria-label="重置会话"
              title="重置会话"
              disabled={isStreaming || creatingChat}
              onClick={() => {
                setMessages([]);
                setPendingPatches(new Map());
                preparedMessageIdsRef.current = new Set();
                historyScannedRef.current = false;
                requestBaseHashRef.current = null;
                onClearChat?.();
              }}
              className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      <QuickActionSection
        note={note}
        disabled={creatingChat || isStreaming}
        onAction={runAction}
      />

      <TransformationSection
        transformations={transformations}
        disabled={!note || creatingChat || isStreaming}
        onRun={runTransformation}
        onManage={() => setManagerOpen(true)}
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
          structuredEditMessageIds={structuredEditMessageIds}
          canSaveAsNote={!!onSaveAsNote}
          canAppend={true}
          onAppend={(message) => applyResult("append", message)}
          onReplace={(message) => applyResult("replace", message)}
          onCopy={copyResult}
          onSaveAsNote={saveAsNote}
          onDismissStreamError={dismissStreamError}
        />

        {/* 待确认的笔记修改卡片 */}
        {pendingPatches.size > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {Array.from(pendingPatches.entries()).map(([messageId, pending]) => (
              <NotePatchCard
                key={messageId}
                pending={pending}
                onApply={() => applyPatchFromCard(messageId)}
                onIgnore={() => ignorePatch(messageId)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0">
        {/* 与终端模块的输入框保持一致（ThreadComposer） */}
        <ThreadComposer
          key={note?.id ?? "no-note"}
          onSend={(content, images, options) =>
            sendDraft(content, images, options?.displayContent)
          }
          disabled={!note || creatingChat}
          placeholder="输入问题，AI 将基于当前笔记回答..."
          isStreaming={isStreaming}
          onStop={stop}
        />
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

    <TransformationManagerDialog
      open={managerOpen}
      transformations={transformations}
      onOpenChange={setManagerOpen}
      onCreate={handleCreateTransformation}
      onEdit={handleEditTransformation}
      onDelete={setDeleteCandidate}
    />

    {editingTransformation ? (
      <TransformationEditorDialog
        transformation={editingTransformation}
        onOpenChange={(open) => { if (!open) setEditingTransformation(null); }}
        onSave={handleSaveTransformation}
      />
    ) : null}

    <ConfirmDialog
      open={deleteCandidate !== null}
      title="删除模板"
      message={`确定删除模板"${deleteCandidate?.name ?? ""}"？此操作不可撤销。`}
      destructive
      onConfirm={() => { if (deleteCandidate) handleDeleteTransformation(deleteCandidate); }}
      onOpenChange={(open) => { if (!open) setDeleteCandidate(null); }}
    />
    </>
  );
}

export function AgentChat({
  messages,
  loading,
  historyError,
  streamError,
  isStreaming,
  creatingChat,
  appliedMessageIds,
  autoAppliedMessageIds,
  structuredEditMessageIds = [],
  canSaveAsNote,
  canAppend,
  onAppend,
  onReplace,
  onCopy,
  onSaveAsNote,
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
  /** 含 note-patch / note-replace 结构化指令的消息，交由变更卡片处理 */
  structuredEditMessageIds?: string[];
  canSaveAsNote: boolean;
  canAppend: boolean;
  onAppend: (message: UIMessage) => void;
  onReplace: (message: UIMessage) => void;
  onCopy: (message: UIMessage) => void;
  onSaveAsNote: (message: UIMessage) => void;
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
                structuredEdit={structuredEditMessageIds.includes(unit.message.id)}
                canSaveAsNote={canSaveAsNote}
                canAppend={canAppend}
                onAppend={onAppend}
                onReplace={onReplace}
                onCopy={onCopy}
                onSaveAsNote={onSaveAsNote}
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
  structuredEdit,
  canSaveAsNote,
  canAppend,
  onAppend,
  onReplace,
  onCopy,
  onSaveAsNote,
}: {
  message: UIMessage;
  appliedMessageIds: string[];
  autoAppliedMessageIds: Set<string>;
  structuredEdit: boolean;
  canSaveAsNote: boolean;
  canAppend: boolean;
  onAppend: (message: UIMessage) => void;
  onReplace: (message: UIMessage) => void;
  onCopy: (message: UIMessage) => void;
  onSaveAsNote: (message: UIMessage) => void;
}) {
  return (
    <div className="min-w-0">
      <MessageBubble message={message} />
      <NoteMessageActions
        message={message}
        applied={appliedMessageIds.includes(message.id)}
        autoApplied={autoAppliedMessageIds.has(message.id)}
        structuredEdit={structuredEdit}
        canSaveAsNote={canSaveAsNote}
        canAppend={canAppend}
        onAppend={onAppend}
        onReplace={onReplace}
        onCopy={onCopy}
        onSaveAsNote={onSaveAsNote}
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
  const btnClass =
    "h-9 justify-start gap-2 rounded-lg border-border/70 px-2.5 text-left text-micro font-medium text-foreground/82 hover:bg-foreground/[0.06] hover:text-foreground";

  return (
    <div className="shrink-0 border-b border-border/65 px-2.5 py-2.5">
      <div className="grid grid-cols-2 gap-1.5">
        <Button
          type="button"
          variant="outline"
          disabled={!note || disabled}
          onClick={() => onAction("summary")}
          className={btnClass}
        >
          <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">总结当前笔记</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!note || disabled}
          onClick={() => onAction("translate")}
          className={btnClass}
        >
          <Languages className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">翻译</span>
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!note || disabled}
          onClick={() => onAction("generateHtml")}
          className={btnClass}
        >
          <FileCode2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">生成HTML文档</span>
        </Button>
      </div>
    </div>
  );
}

function TransformationSection({
  transformations,
  disabled,
  onRun,
  onManage,
}: {
  transformations: NoteTransformation[];
  disabled: boolean;
  onRun: (transformation: NoteTransformation) => void;
  onManage: () => void;
}) {
  if (transformations.length === 0) {
    // Show a compact entry point when there are no custom templates yet.
    return (
      <div className="shrink-0 border-b border-border/65 px-2.5 py-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onManage}
          className="h-8 w-full gap-1.5 rounded-lg border border-dashed border-border/70 text-micro font-normal text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Wand2 className="h-3.5 w-3.5" />
          <span>自定义 AI 模板</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-b border-border/65 px-2.5 py-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-micro font-medium uppercase tracking-wide text-muted-foreground">
          自定义模板
        </span>
        <Button
          type="button"
          variant="ghost"
          onClick={onManage}
          aria-label="管理模板"
          title="管理模板"
          className="h-5 w-5 rounded-md p-0 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Settings2 className="h-3 w-3" />
        </Button>
      </div>
      <div className="flex max-h-32 flex-col gap-1 overflow-y-auto scrollbar-thin">
        {transformations.map((transformation) => (
          <Button
            key={transformation.id}
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => onRun(transformation)}
            title={transformation.description || transformation.name}
            className="h-8 justify-start gap-2 rounded-lg border-border/70 px-2.5 text-left text-micro font-medium text-foreground/82 hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <Wand2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">{transformation.name}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}

function TransformationManagerDialog({
  open,
  transformations,
  onOpenChange,
  onCreate,
  onEdit,
  onDelete,
}: {
  open: boolean;
  transformations: NoteTransformation[];
  onOpenChange: (open: boolean) => void;
  onCreate: () => void;
  onEdit: (transformation: NoteTransformation) => void;
  onDelete: (transformation: NoteTransformation) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px] gap-0 rounded-xl border-border/70 p-0">
        <DialogTitle className="sr-only">管理 AI 模板</DialogTitle>
        <div className="flex items-center justify-between border-b border-border/65 px-4 py-3">
          <h2 className="text-ui font-semibold text-foreground">AI 模板管理</h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-micro"
            onClick={onCreate}
          >
            <Plus className="h-3.5 w-3.5" />
            新建模板
          </Button>
        </div>
        <div className="max-h-[420px] min-h-[120px] overflow-y-auto scrollbar-thin">
          {transformations.length === 0 ? (
            <div className="flex h-[120px] flex-col items-center justify-center gap-2 text-caption text-muted-foreground">
              <Wand2 className="h-6 w-6 opacity-50" />
              <span>还没有自定义模板</span>
              <Button
                type="button"
                variant="link"
                onClick={onCreate}
                className="h-auto p-0 text-micro"
              >
                创建第一个模板
              </Button>
            </div>
          ) : (
            <ul className="py-1">
              {transformations.map((transformation) => (
                <li
                  key={transformation.id}
                  className="group flex items-start gap-2 px-3 py-2 hover:bg-foreground/[0.06]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Wand2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 truncate text-ui font-medium text-foreground">
                        {transformation.name}
                      </span>
                    </div>
                    {transformation.description ? (
                      <p className="mt-0.5 line-clamp-1 pl-6 text-micro text-muted-foreground">
                        {transformation.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label="编辑"
                      onClick={() => onEdit(transformation)}
                      className="h-6 w-6 rounded-md p-0 text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label="删除"
                      onClick={() => onDelete(transformation)}
                      className="h-6 w-6 rounded-md p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TransformationEditorDialog({
  transformation,
  onOpenChange,
  onSave,
}: {
  transformation: NoteTransformation;
  onOpenChange: (open: boolean) => void;
  onSave: (transformation: NoteTransformation) => void;
}) {
  const [draft, setDraft] = useState<NoteTransformation>(transformation);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Sync when a different transformation is opened
  useEffect(() => {
    setDraft(transformation);
  }, [transformation.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const insertVariable = useCallback((token: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = `${draft.promptTemplate.slice(0, start)}${token}${draft.promptTemplate.slice(end)}`;
    setDraft({ ...draft, promptTemplate: next });
    // Restore cursor after the inserted token
    requestAnimationFrame(() => {
      textarea.focus();
      const pos = start + token.length;
      textarea.setSelectionRange(pos, pos);
    });
  }, [draft]);

  const handleSave = useCallback(() => {
    onSave(draft);
  }, [draft, onSave]);

  const isValid = draft.name.trim().length > 0 && draft.promptTemplate.trim().length > 0;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px] gap-0 rounded-xl border-border/70 p-0">
        <DialogTitle className="border-b border-border/65 px-4 py-3 text-ui font-semibold text-foreground">
          {transformation.name ? `编辑模板：${transformation.name}` : "新建 AI 模板"}
        </DialogTitle>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto scrollbar-thin p-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-micro font-medium text-foreground">名称</label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="例如：生成会议纪要"
              className="h-8 rounded-lg border-border/70 px-2.5 text-caption"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-micro font-medium text-foreground">描述（可选）</label>
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="简短描述这个模板的用途"
              className="h-8 rounded-lg border-border/70 px-2.5 text-caption"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-micro font-medium text-foreground">Prompt 模板</label>
              <span className="text-micro text-muted-foreground">
                支持变量插入
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {TRANSFORMATION_VARIABLES.map((variable) => (
                <Button
                  key={variable.token}
                  type="button"
                  variant="outline"
                  onClick={() => insertVariable(variable.token)}
                  title={variable.description}
                  className="h-auto rounded-md border-border/60 bg-muted/30 px-1.5 py-0.5 text-micro font-normal text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
                >
                  {variable.label}
                </Button>
              ))}
            </div>
            <Textarea
              ref={textareaRef}
              value={draft.promptTemplate}
              onChange={(e) => setDraft({ ...draft, promptTemplate: e.target.value })}
              placeholder={`请基于以下笔记内容完成任务：\n\n{{note_content}}\n\n任务：...`}
              rows={10}
              className="min-h-[160px] resize-y rounded-lg border-border/70 px-2.5 py-2 font-mono text-caption leading-5"
            />
            <p className="text-micro text-muted-foreground">
              变量会在执行时替换为当前笔记的实际内容。如果不使用变量，笔记内容会自动附在 prompt 末尾。
            </p>
          </div>
        </div>
        <DialogFooter className="border-t border-border/65 px-4 py-3">
          <Button variant="ghost" size="sm" className="h-8" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" className="h-8" disabled={!isValid} onClick={handleSave}>
            保存模板
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoteMessageActions({
  message,
  applied,
  autoApplied,
  structuredEdit,
  canSaveAsNote,
  canAppend,
  onAppend,
  onReplace,
  onCopy,
  onSaveAsNote,
}: {
  message: UIMessage;
  applied: boolean;
  autoApplied: boolean;
  structuredEdit: boolean;
  canSaveAsNote: boolean;
  canAppend: boolean;
  onAppend: (message: UIMessage) => void;
  onReplace: (message: UIMessage) => void;
  onCopy: (message: UIMessage) => void;
  onSaveAsNote: (message: UIMessage) => void;
}) {
  if (message.kind === "trace") return null;
  if (message.role === "user") return null;

  const canApply =
    message.role === "assistant" &&
    !message.isStreaming &&
    message.content.trim().length > 0 &&
    !autoApplied;

  if (!canApply && !autoApplied) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-border/40 pt-2">
      {autoApplied ? (
        <>
          <span className="inline-flex h-7 items-center gap-1 rounded-md border border-success/25 bg-success/10 px-2 text-micro text-success">
            <Check className="h-3.5 w-3.5" />
            已应用
          </span>
          <MiniAction label="复制" onClick={() => onCopy(message)}>
            <Copy className="h-3.5 w-3.5" />
          </MiniAction>
          {canSaveAsNote ? (
            <MiniAction label="存为笔记" onClick={() => onSaveAsNote(message)}>
              <FilePlus2 className="h-3.5 w-3.5" />
            </MiniAction>
          ) : null}
        </>
      ) : null}
      {canApply ? (
        <>
          {structuredEdit ? (
            // 结构化修改指令由变更卡片应用，不能把 JSON block 当正文写入
            <span className="inline-flex h-7 items-center gap-1 rounded-md border border-border/70 bg-muted/25 px-2 text-micro text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              已生成修改建议
            </span>
          ) : (
            <>
              {canAppend ? (
                <MiniAction label={applied ? "已追加" : "追加"} disabled={applied} onClick={() => onAppend(message)}>
                  <Clipboard className="h-3.5 w-3.5" />
                </MiniAction>
              ) : null}
              <MiniAction label="替换" onClick={() => onReplace(message)}>
                <Replace className="h-3.5 w-3.5" />
              </MiniAction>
            </>
          )}
          <MiniAction label="复制" onClick={() => onCopy(message)}>
            <Copy className="h-3.5 w-3.5" />
          </MiniAction>
          {canSaveAsNote ? (
            <MiniAction label="存为笔记" onClick={() => onSaveAsNote(message)}>
              <FilePlus2 className="h-3.5 w-3.5" />
            </MiniAction>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 变更卡片：展示结构化修改摘要，提供应用/忽略按钮 */
function NotePatchCard({
  pending,
  onApply,
  onIgnore,
}: {
  pending: PendingNotePatch;
  onApply: () => void;
  onIgnore: () => void;
}) {
  const { summary, status, error } = pending;

  if (status === "applied") {
    return (
      <div className="rounded-md border border-success/30 bg-success/5 px-2.5 py-2 text-micro text-success">
        <div className="flex items-center gap-1.5 font-medium">
          <Check className="h-3.5 w-3.5" />
          已应用到笔记
        </div>
      </div>
    );
  }

  if (status === "ignored") return null;

  if (status === "invalid") {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-micro text-destructive">
        <div className="flex items-center gap-1.5 font-medium">
          <AlertTriangle className="h-3.5 w-3.5" />
          修改无效
        </div>
        {error ? <div className="mt-1 text-destructive/80">{error}</div> : null}
      </div>
    );
  }

  const isStale = status === "stale";
  const isReplace = "replaced" in summary && summary.replaced;

  return (
    <div
      className={`rounded-md border px-2.5 py-2 text-micro ${
        isStale ? "border-warning/40 bg-warning/5" : "border-border/70 bg-muted/40"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-foreground">
          {isStale ? "笔记已修改，该建议已过期" : "AI 建议修改笔记"}
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
        {isReplace ? (
          <span>将重写整篇笔记正文</span>
        ) : (
          <span>修改 {("edited" in summary && summary.edited) || 0} 处内容</span>
        )}
      </div>

      {!isStale ? (
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            onClick={onApply}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-action px-2.5 text-micro font-medium text-white hover:bg-action-hover hover:text-white"
          >
            <Check className="h-3 w-3" />
            应用到笔记
          </button>
        </div>
      ) : (
        <div className="mt-1.5 text-warning">
          {pending.mode === "patch" ? "请基于最新笔记重新生成" : "笔记已变化，请确认后再应用"}
        </div>
      )}
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
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onClose}
          className="h-auto shrink-0 px-1 py-0 font-normal text-foreground/65 hover:bg-transparent hover:text-foreground"
        >
          关闭
        </Button>
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
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      className="h-7 gap-1 rounded-md border-border/70 bg-muted/25 px-2 text-micro font-medium text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-55"
    >
      {children}
      {label}
    </Button>
  );
}
