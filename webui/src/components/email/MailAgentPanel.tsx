import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Square, RotateCcw, Zap, MessagesSquare, Sparkles, FolderInput, X } from "lucide-react";
import { AgentLogo } from "@/components/AgentLogo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream, type SendOptions } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";
import { useEmailStore } from "./store/emailStore";
import type { BatchActionRequest, BatchActionTarget, EmailBatchAction } from "./lib/types";
import { batchAction, createFolder } from "./lib/emailApi";
import { EmailAnalysisCard } from "./EmailAnalysisCard";

const EMAIL_BODY_CHAR_LIMIT = 4000;

const ACTION_LABELS: Record<string, string> = {
  mark_read: "标记为已读",
  mark_unread: "标记为未读",
  star: "加星标",
  unstar: "取消星标",
  move: "移动",
  delete: "删除",
};

interface ActionSuggestion {
  action: EmailBatchAction;
  destFolder: string | null;
  messages: BatchActionTarget[];
  count: number;
  needCreateFolder?: boolean;
}

/** 从消息列表中提取最后一个工具返回的操作建议 JSON（支持单条和数组） */
function extractActionSuggestion(messages: UIMessage[]): ActionSuggestion | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.kind !== "trace" || !msg.traces) continue;
    const fullText = msg.traces.join("\n");
    const jsonMatch = fullText.match(/操作详情（JSON）：\s*\n([\s\S]+)$/);
    if (!jsonMatch) continue;
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());

      // 数组格式（email_auto_archive 返回多个 move 建议）
      if (Array.isArray(parsed)) {
        const allTargets: BatchActionTarget[] = [];
        let destFolder: string | null = null;
        let needCreateFolder = false;
        for (const item of parsed) {
          if (item.action === "move" && Array.isArray(item.messages) && item.requires_confirmation) {
            allTargets.push(...(item.messages as BatchActionTarget[]));
            if (item.destFolder) destFolder = item.destFolder;
            if (item.need_create_folder) needCreateFolder = true;
          }
        }
        if (allTargets.length > 0) {
          return {
            action: "move",
            destFolder,
            messages: allTargets,
            count: allTargets.length,
            needCreateFolder,
          };
        }
        continue;
      }

      // 单条格式（email_action 返回）
      if (parsed && parsed.action && Array.isArray(parsed.messages) && parsed.requires_confirmation) {
        return {
          action: parsed.action as EmailBatchAction,
          destFolder: parsed.destFolder ?? null,
          messages: parsed.messages as BatchActionTarget[],
          count: parsed.count ?? parsed.messages.length,
          needCreateFolder: parsed.need_create_folder ?? false,
        };
      }
    } catch {
      // JSON 解析失败，跳过
    }
  }
  return null;
}

export function MailAgentPanel() {
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [executingAction, setExecutingAction] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [allowCreateFolder, setAllowCreateFolder] = useState(false);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingSendOptsRef = useRef<SendOptions | null>(null);
  const { client } = useClient();

  const selectedMessage = useEmailStore((s) => s.selectedMessage);
  const gatewayUrl = useEmailStore((s) => s.gatewayUrl);
  const agentChatId = useEmailStore((s) => s.agentChatId);
  const setAgentChatId = useEmailStore((s) => s.setAgentChatId);
  const analysisLoading = useEmailStore((s) => s.analysisLoading);
  const runAnalysis = useEmailStore((s) => s.runAnalysis);
  const accounts = useEmailStore((s) => s.accounts);
  const analysisCache = useEmailStore((s) => s.analysisCache);
  const bodyCache = useEmailStore((s) => s.bodyCache);

  // 流式对话
  const chatId = agentChatId;
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

  // A2: 切换邮件时重置 AI 会话，防止上一封邮件的上下文残留
  const lastEmailUidRef = useRef<string | null>(null);
  useEffect(() => {
    const currentUid = selectedMessage?.uid ?? null;
    if (lastEmailUidRef.current !== null && currentUid !== null && lastEmailUidRef.current !== currentUid) {
      if (agentChatId) {
        setAgentChatId(null);
        setMessages([]);
      }
    }
    lastEmailUidRef.current = currentUid;
  }, [selectedMessage?.uid, agentChatId, setAgentChatId, setMessages]);

  useEffect(() => {
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
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 1800);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const actionSuggestion = !isStreaming ? extractActionSuggestion(messages) : null;

  const handleRunAnalysis = useCallback(async () => {
    if (!selectedMessage || !gatewayUrl) return;
    try {
      await runAnalysis(gatewayUrl, selectedMessage);
    } catch {
      // 错误已存入 store
    }
  }, [gatewayUrl, runAnalysis, selectedMessage]);

  const buildEmailContext = useCallback((): string | null => {
    if (!selectedMessage) return null;
    const lines: string[] = ["[EMAIL_CONTEXT]"];
    lines.push(`account_id: ${selectedMessage.accountId}`);
    lines.push(`folder: ${selectedMessage.folder}`);
    lines.push(`uid: ${selectedMessage.uid}`);
    lines.push(`subject: ${selectedMessage.subject}`);
    lines.push(`from: ${selectedMessage.fromAddress}`);
    if (selectedMessage.fromName) lines.push(`from_name: ${selectedMessage.fromName}`);
    lines.push(`date: ${selectedMessage.date}`);

    // 注入已有分析结果（复用 email_analyze 流水线）
    const analysisKey = `${selectedMessage.uid}:${selectedMessage.accountId}:${selectedMessage.folder}`;
    const analysis = analysisCache[analysisKey];
    if (analysis) {
      lines.push("[EMAIL_ANALYSIS]");
      lines.push(`summary: ${analysis.summary}`);
      lines.push(`category: ${analysis.category}`);
      lines.push(`intent: ${analysis.intent}`);
      lines.push(`urgency: ${analysis.urgency}`);
      if (analysis.keyInfo) lines.push(`key_info: ${analysis.keyInfo}`);
      lines.push("[/EMAIL_ANALYSIS]");
    }

    // 注入正文（截断 + 截断提示）
    const bodyKey = analysisKey;
    const cached = bodyCache[bodyKey];
    const bodyText = cached?.bodyText || selectedMessage.bodyText || "";
    if (bodyText) {
      lines.push("[EMAIL_BODY]");
      if (bodyText.length > EMAIL_BODY_CHAR_LIMIT) {
        const truncated = bodyText.slice(0, EMAIL_BODY_CHAR_LIMIT);
        lines.push(truncated);
        lines.push(
          `\n…（正文已截断，如需完整内容请使用 read_email_body 工具读取 account_id=${selectedMessage.accountId} folder=${selectedMessage.folder} uid=${selectedMessage.uid}）`,
        );
      } else {
        lines.push(bodyText);
      }
      lines.push("[/EMAIL_BODY]");
    }

    lines.push("[/EMAIL_CONTEXT]");
    return lines.join("\n");
  }, [selectedMessage, analysisCache, bodyCache]);

  const sendPromptToAgent = useCallback(
    async (prompt: string, displayName?: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || creatingChat) return;
      if (isStreaming) {
        setNotice("Agent 正在处理，先停止或等它完成");
        return;
      }

      const emailCtx = buildEmailContext();
      const enriched = emailCtx ? `${emailCtx}\n\n${trimmed}` : trimmed;
      const sendOpts: SendOptions = {
        displayContent: displayName,
      };

      if (chatId) {
        send(enriched, undefined, sendOpts);
        return;
      }

      setCreatingChat(true);
      setNotice("正在创建会话");
      pendingPromptRef.current = enriched;
      pendingSendOptsRef.current = sendOpts;
      try {
        const nextChatId = await client.newChat(5_000, true);
        setAgentChatId(nextChatId);
      } catch {
        pendingPromptRef.current = null;
        pendingSendOptsRef.current = null;
        setNotice("创建会话失败");
      } finally {
        setCreatingChat(false);
      }
    },
    [chatId, client, creatingChat, isStreaming, buildEmailContext, send, setAgentChatId],
  );

  const sendDraft = useCallback(() => {
    const question = draft.trim();
    if (!question) return;
    setDraft("");
    setActionResult(null);
    void sendPromptToAgent(question, question);
  }, [draft, sendPromptToAgent]);

  const handleResetChat = useCallback(() => {
    setMessages([]);
    setAgentChatId(null);
    setActionResult(null);
    setNotice("会话已重置");
  }, [setAgentChatId, setMessages]);

  const handleConfirmAction = useCallback(async () => {
    if (!actionSuggestion || !gatewayUrl) return;
    setExecutingAction(true);
    setActionResult(null);
    try {
      // 如果需要创建文件夹，先按账号创建
      if (actionSuggestion.needCreateFolder && actionSuggestion.destFolder) {
        const accountIds = [...new Set(actionSuggestion.messages.map((m) => m.accountId))];
        for (const aid of accountIds) {
          const acct = accounts.find((a) => a.id === aid);
          if (!acct) continue;
          try {
            await createFolder(gatewayUrl, acct, actionSuggestion.destFolder);
          } catch {
            // 文件夹可能已存在，忽略错误
          }
        }
      }

      const req: BatchActionRequest = {
        action: actionSuggestion.action,
        messages: actionSuggestion.messages,
        destFolder: actionSuggestion.destFolder,
      };
      const resp = await batchAction(gatewayUrl, req);
      if (resp.failed > 0) {
        setActionResult(`成功 ${resp.success} 封，失败 ${resp.failed} 封：${resp.errors.slice(0, 3).join("; ")}`);
      } else {
        setActionResult(`操作完成：${ACTION_LABELS[actionSuggestion.action] ?? actionSuggestion.action} ${resp.success} 封邮件`);
      }
    } catch (e) {
      setActionResult(`执行失败：${String(e)}`);
    } finally {
      setExecutingAction(false);
    }
  }, [actionSuggestion, gatewayUrl, accounts]);

  return (
    <div className="flex h-full flex-col bg-card">
      {/* 顶部工具栏 */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 px-2.5">
        <div className="flex items-center gap-1.5">
          <MessagesSquare className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-caption font-medium text-foreground">邮件 AI 助手</span>
        </div>
        <div className="flex items-center gap-0.5">
          {chatId ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="重置会话"
              title="重置会话"
              disabled={isStreaming || creatingChat}
              onClick={handleResetChat}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          {isStreaming ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="停止生成"
              title="停止生成"
              onClick={stop}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
            >
              <Square className="h-3 w-3" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* 快捷操作 */}
      <div className="shrink-0 border-b border-border/65 px-2.5 py-2">
        <div className="flex gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!selectedMessage || analysisLoading}
            onClick={() => void handleRunAnalysis()}
            className="h-8 flex-1 gap-1.5 px-2.5 text-caption font-medium"
          >
            {analysisLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3 text-primary" />
            )}
            内容分析
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={creatingChat || isStreaming}
            onClick={() => {
              setAllowCreateFolder(false);
              setShowArchiveDialog(true);
            }}
            className="h-8 flex-1 gap-1.5 px-2.5 text-caption font-medium"
          >
            <FolderInput className="h-3 w-3 text-info" />
            自动归档
          </Button>
        </div>
      </div>

      {/* 消息列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2 scrollbar-thin">
        {selectedMessage ? (
          (() => {
            const analysisKey = `${selectedMessage.uid}:${selectedMessage.accountId}:${selectedMessage.folder}`;
            const analysis = analysisCache[analysisKey];
            if (analysis) {
              return (
                <EmailAnalysisCard
                  analysis={analysis}
                  message={selectedMessage}
                  accountId={selectedMessage.accountId}
                />
              );
            }
            return null;
          })()
        ) : null}
        <EmailChat
          messages={messages}
          loading={loading}
          historyError={historyError}
          streamError={streamError?.kind ?? null}
          isStreaming={isStreaming}
          creatingChat={creatingChat}
          onDismissStreamError={dismissStreamError}
        />
      </div>

      {/* 操作建议确认 */}
      {actionSuggestion && !isStreaming ? (
        <div className="shrink-0 border-t border-border/70 bg-warning/10 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-caption font-medium text-foreground">
            <Zap className="h-3.5 w-3.5 text-warning" />
            AI 建议操作：{ACTION_LABELS[actionSuggestion.action] ?? actionSuggestion.action}
            {actionSuggestion.destFolder ? ` → ${actionSuggestion.destFolder}` : ""}
            {" "}
            （{actionSuggestion.count} 封）
          </div>
          {actionResult ? (
            <p className="text-micro text-muted-foreground">{actionResult}</p>
          ) : (
            <div className="flex gap-1.5">
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1 text-micro"
                disabled={executingAction}
                onClick={() => void handleConfirmAction()}
              >
                {executingAction ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                确认执行
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-micro"
                disabled={executingAction}
                onClick={() => setActionResult("已取消")}
              >
                取消
              </Button>
            </div>
          )}
        </div>
      ) : null}

      {/* 输入框 */}
      <div className="shrink-0 p-2">
        {notice ? (
          <div className="mb-1.5 text-micro text-muted-foreground">{notice}</div>
        ) : null}
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                sendDraft();
              }
            }}
            disabled={creatingChat}
            className="min-h-[36px] flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-0 text-caption leading-5 shadow-none focus-visible:ring-0"
            rows={2}
            placeholder="输入问题，如「找上个月张总发的关于预算的邮件」..."
          />
          <Button
            type="button"
            size="icon"
            aria-label="发送"
            title="发送消息"
            disabled={!draft.trim() || creatingChat || isStreaming}
            onClick={sendDraft}
            className="h-6 w-6 rounded-lg bg-action text-white hover:bg-action-hover hover:text-white disabled:bg-muted disabled:text-muted-foreground"
          >
            {creatingChat ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </Button>
        </div>
      </div>

      {/* 自动归档确认弹窗 */}
      {showArchiveDialog ? (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm" onClick={() => setShowArchiveDialog(false)}>
          <div
            className="mx-4 w-full max-w-sm rounded-2xl border border-border/70 bg-background p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <FolderInput className="h-4 w-4 text-info" />
                <span className="text-ui font-medium text-foreground">自动归档邮件</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setShowArchiveDialog(false)}
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                aria-label="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>

            <p className="mb-3 text-caption leading-relaxed text-muted-foreground">
              AI 将读取已分析邮件的内容，智能判断每封邮件应归入的文件夹。不匹配的邮件将归入「其他」文件夹。
            </p>

            <label className="mb-3 flex cursor-pointer items-start gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2">
              <Checkbox
                checked={allowCreateFolder}
                onCheckedChange={(v) => setAllowCreateFolder(v === true)}
                className="mt-0.5"
              />
              <span className="text-caption leading-relaxed text-foreground">
                允许 AI 自动创建文件夹
                <span className="ml-1 text-micro text-muted-foreground">（不勾选则不匹配的邮件归入「其他」）</span>
              </span>
            </label>

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8 flex-1 gap-1 text-caption"
                disabled={creatingChat || isStreaming}
                onClick={() => {
                  setShowArchiveDialog(false);
                  void sendPromptToAgent(
                    `请使用 email_auto_archive 工具，对当前邮箱 INBOX 中已分析的邮件进行自动归档。allow_create_folder=${allowCreateFolder}`,
                    "自动归档邮件",
                  );
                }}
              >
                开始归档
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-3 text-caption"
                onClick={() => setShowArchiveDialog(false)}
              >
                取消
              </Button>
            </div>
          </div>
        </div>
      ) : null}

    </div>
  );
}

function EmailChat({
  messages,
  loading,
  historyError,
  streamError,
  isStreaming,
  creatingChat,
  onDismissStreamError,
}: {
  messages: UIMessage[];
  loading: boolean;
  historyError: string | null;
  streamError: string | null;
  isStreaming: boolean;
  creatingChat: boolean;
  onDismissStreamError: () => void;
}) {
  const hasMessages = messages.length > 0;

  return (
    <div className="flex w-full flex-col">
      {historyError ? (
        <InlineNotice>会话历史加载失败：{historyError}</InlineNotice>
      ) : null}
      {streamError ? (
        <InlineNotice onClose={onDismissStreamError}>
          消息过大或连接异常，请缩短内容后重试。
        </InlineNotice>
      ) : null}

      {!hasMessages && !loading ? (
        <AssistantHint text="可以问我关于邮件的任何问题，如「找上个月张总发的关于预算的邮件」或「把这周所有营销邮件标为已读」" />
      ) : null}

      {loading ? <AssistantHint text="正在读取会话历史..." loading /> : null}

      <ThreadMessages messages={messages} isStreaming={isStreaming} />

      {creatingChat ? <AssistantHint text="正在创建会话..." loading /> : null}
      {isStreaming ? <AssistantHint text="AI 正在处理..." loading /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 共享子组件
// ---------------------------------------------------------------------------

function AssistantHint({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <p className="text-center text-caption text-muted-foreground py-8">
      <span className="inline-flex items-center gap-2">
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <AgentLogo state="idle" className="h-4 w-4" />
        )}
        {text}
      </span>
    </p>
  );
}

function InlineNotice({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border/70 bg-background px-3 py-2 text-caption leading-relaxed text-muted-foreground">
      <span className="min-w-0 flex-1">{children}</span>
      {onClose ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onClose}
          className="shrink-0 text-foreground/65 hover:bg-transparent hover:text-foreground"
        >
          关闭
        </Button>
      ) : null}
    </div>
  );
}
