import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  RotateCcw,
  Send,
  Square,
  Zap,
  ListTree,
  BarChart3,
  AlertTriangle,
  Shield,
  Wrench,
} from "lucide-react";
import { AgentLogo } from "@/components/AgentLogo";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream, type SendOptions } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";
import { useDbStore } from "./store/dbStore";
import type { QueryTab } from "./types";
import { SqlResultCard } from "./SqlResultCard";
import {
  type DbActionConfirmResult,
  ExplainPlanConfig,
  IndexDiagnosisConfig,
  DataProfileConfig,
  DiagnoseErrorConfig,
  HealthInspectionConfig,
  OptimizeConfig,
} from "./DbActionConfig";

function buildDbContext(tab: QueryTab | undefined): string | null {
  if (!tab?.connectionId) return null;
  const lines: string[] = ["[DB_CONTEXT]"];
  lines.push(`connection_id: ${tab.connectionId}`);
  if (tab.database) lines.push(`database: ${tab.database}`);
  if (tab.title) lines.push(`table: ${tab.title}`);
  if (tab.result?.message) lines.push(`error: ${tab.result.message}`);
  lines.push("[/DB_CONTEXT]");
  return lines.join("\n");
}

function extractSql(text: string): string | null {
  const codeBlockMatch = text.match(/```sql\s*\n?([\s\S]*?)\n?\s*```/i);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  const codeBlockMatch2 = text.match(/```\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch2) {
    const content = codeBlockMatch2[1].trim();
    if (/^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP)\b/i.test(content)) {
      return content;
    }
  }
  const sqlPattern = /(?:^|\n)\s*((?:SELECT|INSERT|UPDATE|DELETE|WITH)\b[\s\S]*?)(?:\n\s*$|\n(?=[^\s])|$)/i;
  const sqlMatch = text.match(sqlPattern);
  if (sqlMatch) return sqlMatch[1].trim();
  return null;
}

interface DbAgentPanelProps {
  collapsed?: boolean;
  width?: number;
}

export function DbAgentPanel({
  collapsed: collapsedProp,
  width = 320,
}: DbAgentPanelProps) {
  const [draft, setDraft] = useState("");
  const collapsed = collapsedProp ?? false;
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingSendOptsRef = useRef<SendOptions | null>(null);
  const pendingNlToSqlRef = useRef(false);
  const { client } = useClient();
  const [pendingSqlResult, setPendingSqlResult] = useState<string | null>(null);

  const activeTabId = useDbStore((s) => s.activeTabId);
  const queryTabs = useDbStore((s) => s.queryTabs);
  const updateTabSql = useDbStore((s) => s.updateTabSql);
  const setAgentStreaming = useDbStore((s) => s.setAgentStreaming);
  const activeTab = queryTabs.find((t) => t.id === activeTabId);

  const chatId = activeTab?.agentChatId ?? null;
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
    setAgentStreaming(isStreaming);
  }, [isStreaming, setAgentStreaming]);

  useEffect(() => {
    setDraft("");
    setNotice(null);
    setPendingSqlResult(null);
    if (!activeTab?.agentChatId) setMessages([]);
  }, [activeTab?.id, activeTab?.agentChatId, setMessages]);

  useEffect(() => {
    if (!chatId || loading) return;
    setMessages((current) => {
      if (historical.length === 0 && current.length > 0) return current;
      // Reconstruct displayContent for historical user messages that lost it
      // after app restart (displayContent is not persisted by the backend).
      return historical.map((m) => {
        if (m.role === "user" && !m.displayContent) {
          const label = inferDbActionDisplayLabel(m.content);
          if (label) return { ...m, displayContent: label };
        }
        return m;
      });
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

  const sendPromptToAgent = useCallback(
    async (prompt: string, displayName?: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || creatingChat) return;
      if (isStreaming) {
        setNotice("Agent 正在处理，先停止或等它完成");
        return;
      }

      const dbCtx = buildDbContext(activeTab);
      const enriched = dbCtx ? `${dbCtx}\n\n${trimmed}` : trimmed;
      const sendOpts: SendOptions = {
        dbConnectionId: activeTab?.connectionId ?? undefined,
        dbDatabase: activeTab?.database ?? undefined,
        dbTable: activeTab?.title ?? undefined,
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
        useDbStore.setState((state) => ({
          queryTabs: state.queryTabs.map((t) =>
            t.id === activeTabId ? { ...t, agentChatId: nextChatId } : t,
          ),
        }));
      } catch {
        pendingPromptRef.current = null;
        pendingSendOptsRef.current = null;
        setNotice("创建会话失败");
      } finally {
        setCreatingChat(false);
      }
    },
    [chatId, client, creatingChat, isStreaming, activeTabId, activeTab, send],
  );

  const sendDraft = useCallback(() => {
    const question = draft.trim();
    if (!question) return;
    setDraft("");
    void sendPromptToAgent(question, question);
  }, [draft, sendPromptToAgent]);

  const handleNlToSql = useCallback(() => {
    const query = draft.trim();
    if (!query || !activeTab?.connectionId) return;
    setDraft("");
    pendingNlToSqlRef.current = true;
    const columns = activeTab.tableInfo?.columns
      ?.map((c) => `${c.name} ${c.data_type}`)
      .join(", ");
    const tableDesc = activeTab.title
      ? `${activeTab.title}${columns ? ` (${columns})` : ""}`
      : "";
    const prompt = `根据以下表结构，将用户的自然语言查询转为 SQL。
数据库: ${activeTab.database ?? ""}
表: ${tableDesc}
用户查询: ${query}
只输出一条 SQL 语句，不要解释。`;
    void sendPromptToAgent(prompt, `NL2SQL: ${query}`);
  }, [draft, activeTab, sendPromptToAgent]);

  useEffect(() => {
    if (!pendingNlToSqlRef.current || isStreaming) return;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.content);
    if (!lastAssistant?.content) return;
    const extracted = extractSql(lastAssistant.content);
    if (extracted) {
      setPendingSqlResult(extracted);
    }
    pendingNlToSqlRef.current = false;
  }, [messages, isStreaming]);

  const handleResetChat = useCallback(() => {
    setMessages([]);
    useDbStore.setState((state) => ({
      queryTabs: state.queryTabs.map((t) =>
        t.id === activeTabId ? { ...t, agentChatId: null } : t,
      ),
    }));
    setNotice("会话已重置");
  }, [activeTabId, setMessages]);

  if (collapsed) {
    return null;
  }

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-l border-border/70 bg-background"
      style={{ width }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/65 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-[12px] font-semibold text-foreground">Mona</h2>
        </div>
        <div className="flex items-center gap-1">
          {notice ? (
            <span className="max-w-28 truncate text-[10px] text-muted-foreground">{notice}</span>
          ) : null}
          {chatId ? (
            <button
              type="button"
              aria-label="重置会话"
              title="重置会话"
              disabled={isStreaming || creatingChat}
              onClick={handleResetChat}
              className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-b border-border/65 px-2.5 py-2.5">
        {activeAction ? (
          <DbActionConfigPanel
            actionId={activeAction}
            activeTab={activeTab}
            onConfirm={(result) => {
              setActiveAction(null);
              void sendPromptToAgent(result.prompt, result.label);
            }}
            onCancel={() => setActiveAction(null)}
          />
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              disabled={!activeTab?.connectionId || creatingChat || isStreaming}
              onClick={() => setActiveAction("explain")}
              className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <Zap className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">执行计划</span>
            </button>
            <button
              type="button"
              disabled={!activeTab?.connectionId || creatingChat || isStreaming}
              onClick={() => setActiveAction("index")}
              className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <ListTree className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">索引诊断</span>
            </button>
            <button
              type="button"
              disabled={!activeTab?.connectionId || creatingChat || isStreaming}
              onClick={() => setActiveAction("profile")}
              className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">数据画像</span>
            </button>
            <button
              type="button"
              disabled={!activeTab?.connectionId || creatingChat || isStreaming}
              onClick={() => setActiveAction("error")}
              className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <AlertTriangle className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">诊断错误</span>
            </button>
            <button
              type="button"
              disabled={!activeTab?.connectionId || creatingChat || isStreaming}
              onClick={() => setActiveAction("health")}
              className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <Shield className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">一键巡检</span>
            </button>
            <button
              type="button"
              disabled={!activeTab?.connectionId || creatingChat || isStreaming}
              onClick={() => setActiveAction("optimize")}
              className="flex h-9 items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-left text-[11.5px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">优化建议</span>
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2 scrollbar-thin">
        {pendingSqlResult && activeTabId ? (
          <SqlResultCard
            sql={pendingSqlResult}
            onInsert={(sql) => {
              const tab = useDbStore.getState().queryTabs.find((t) => t.id === activeTabId);
              if (tab) updateTabSql(activeTabId, `${tab.sql}\n${sql}`);
            }}
            onReplace={(sql) => updateTabSql(activeTabId, sql)}
            onDismiss={() => setPendingSqlResult(null)}
          />
        ) : null}
        <DbChat
          messages={messages}
          loading={loading}
          historyError={historyError}
          streamError={streamError?.kind ?? null}
          isStreaming={isStreaming}
          creatingChat={creatingChat}
          hasActiveTab={!!activeTab?.connectionId}
          onDismissStreamError={dismissStreamError}
        />
      </div>

      <div className="shrink-0 p-2">
        <div className="flex min-h-[52px] items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-sm">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (!isStreaming) sendDraft();
              }
            }}
            disabled={!activeTab?.connectionId || creatingChat}
            className="min-h-[44px] flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            rows={2}
            placeholder="输入问题，或用中文描述想查的数据..."
          />
          <button
            type="button"
            aria-label="生成SQL"
            title="自然语言转 SQL"
            disabled={!activeTab?.connectionId || !draft.trim() || creatingChat || isStreaming}
            onClick={handleNlToSql}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-amber-500/80 transition-colors hover:bg-amber-500/10 hover:text-amber-500 disabled:pointer-events-none disabled:opacity-40"
          >
            <Zap className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={isStreaming ? "停止生成" : "发送"}
            title={isStreaming ? "停止生成" : "发送消息"}
            disabled={!isStreaming && (!activeTab?.connectionId || !draft.trim() || creatingChat)}
            onClick={isStreaming ? stop : sendDraft}
            className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors ${
              isStreaming
                ? "text-destructive hover:bg-destructive/10"
                : "bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
            }`}
          >
            {creatingChat ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : isStreaming ? (
              <Square className="h-3 w-3" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}

function DbChat({
  messages,
  loading,
  historyError,
  streamError,
  isStreaming,
  creatingChat,
  hasActiveTab,
  onDismissStreamError,
}: {
  messages: UIMessage[];
  loading: boolean;
  historyError: string | null;
  streamError: string | null;
  isStreaming: boolean;
  creatingChat: boolean;
  hasActiveTab: boolean;
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

      {!hasMessages && !loading && hasActiveTab ? (
        <AssistantHint text="可以提问关于当前数据库的问题，或使用上方快捷功能。" />
      ) : null}

      {loading ? <AssistantHint text="正在读取会话历史..." loading /> : null}

      <ThreadMessages messages={messages} isStreaming={isStreaming} />

      {creatingChat ? <AssistantHint text="正在创建会话..." loading /> : null}
      {isStreaming ? <AssistantHint text="AI 正在处理..." loading /> : null}
    </div>
  );
}

/** Pattern-to-label pairs for inferring displayContent from persisted user messages. */
const DB_ACTION_PROMPT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^分析表 .+ 的查询性能/, label: "执行计划" },
  { pattern: /^诊断表 .+ 的索引状况/, label: "索引诊断" },
  { pattern: /^诊断当前数据库所有表的索引状况/, label: "索引诊断" },
  { pattern: /^为表 .+ 生成数据画像/, label: "数据画像" },
  { pattern: /^SQL 执行报错/, label: "诊断错误" },
  { pattern: /^对当前数据库实例做健康巡检/, label: "一键巡检" },
  { pattern: /^分析表 .+ 的整体优化建议/, label: "优化建议" },
];

/**
 * Infer a short display label from a persisted user message that was sent by a
 * database AI quick-action.  Returns `undefined` when the content doesn't match
 * any known action pattern (i.e. a freeform question).
 */
function inferDbActionDisplayLabel(content: string): string | undefined {
  if (!content) return undefined;
  for (const { pattern, label } of DB_ACTION_PROMPT_PATTERNS) {
    if (pattern.test(content)) return label;
  }
  return undefined;
}

function DbActionConfigPanel({
  actionId,
  activeTab,
  onConfirm,
  onCancel,
}: {
  actionId: string;
  activeTab: QueryTab | undefined;
  onConfirm: (result: DbActionConfirmResult) => void;
  onCancel: () => void;
}) {
  switch (actionId) {
    case "explain":
      return <ExplainPlanConfig activeTab={activeTab} onConfirm={onConfirm} onCancel={onCancel} />;
    case "index":
      return <IndexDiagnosisConfig activeTab={activeTab} onConfirm={onConfirm} onCancel={onCancel} />;
    case "profile":
      return <DataProfileConfig activeTab={activeTab} onConfirm={onConfirm} onCancel={onCancel} />;
    case "error":
      return <DiagnoseErrorConfig activeTab={activeTab} onConfirm={onConfirm} onCancel={onCancel} />;
    case "health":
      return <HealthInspectionConfig activeTab={activeTab} onConfirm={onConfirm} onCancel={onCancel} />;
    case "optimize":
      return <OptimizeConfig activeTab={activeTab} onConfirm={onConfirm} onCancel={onCancel} />;
    default:
      return null;
  }
}

function AssistantHint({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <p className="text-center text-xs text-muted-foreground py-8">
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
    <div className="flex items-start gap-2 rounded-lg border border-border/70 bg-background px-3 py-2 text-xs leading-relaxed text-muted-foreground">
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
