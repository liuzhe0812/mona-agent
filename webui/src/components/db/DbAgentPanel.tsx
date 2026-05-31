import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  Loader2,
  Send,
  Sparkles,
  Square,
  Zap,
  ListTree,
  BarChart3,
  AlertTriangle,
  Shield,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMonaStream, type SendOptions } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { UIMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useClient } from "@/providers/ClientProvider";
import { useDbStore } from "./store/dbStore";
import type { QueryTab } from "./types";

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
  const pendingPromptRef = useRef<string | null>(null);
  const pendingSendOptsRef = useRef<SendOptions | null>(null);
  const pendingNlToSqlRef = useRef(false);
  const { client } = useClient();

  const activeTabId = useDbStore((s) => s.activeTabId);
  const queryTabs = useDbStore((s) => s.queryTabs);
  const updateTabSql = useDbStore((s) => s.updateTabSql);
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
    setDraft("");
    setNotice(null);
    if (!activeTab?.agentChatId) setMessages([]);
  }, [activeTab?.id, activeTab?.agentChatId, setMessages]);

  useEffect(() => {
    if (!chatId || loading) return;
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
    if (extracted && activeTabId) {
      updateTabSql(activeTabId, extracted);
    }
    pendingNlToSqlRef.current = false;
  }, [messages, isStreaming, activeTabId, updateTabSql]);

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
          <span className="grid h-5 w-5 place-items-center rounded-md border border-border/70 bg-background">
            <Bot className="h-3 w-3 text-muted-foreground" />
          </span>
          <h2 className="truncate text-[12px] font-semibold text-foreground">AI 助手</h2>
        </div>
        <div className="flex items-center gap-1">
          {notice ? (
            <span className="max-w-28 truncate text-[10px] text-muted-foreground">{notice}</span>
          ) : null}
          {isStreaming ? (
            <button
              type="button"
              aria-label="停止生成"
              title="停止生成"
              onClick={stop}
              className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Square className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-b border-border/65 px-1 py-0.5">
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            disabled={!activeTab?.connectionId || creatingChat || isStreaming}
            onClick={() =>
              void sendPromptToAgent(
                `分析表 ${activeTab?.title ?? ""} 的查询性能。用 db_query 执行 SHOW CREATE TABLE 和 EXPLAIN 分析，指出全表扫描、文件排序、临时表等性能问题`,
                "执行计划",
              )
            }
            className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Zap className="h-3 w-3 shrink-0" />
            <span>执行计划</span>
          </button>
          <button
            type="button"
            disabled={!activeTab?.connectionId || creatingChat || isStreaming}
            onClick={() =>
              void sendPromptToAgent(
                `诊断表 ${activeTab?.title ?? ""} 的索引状况。用 db_query 执行 SHOW INDEX 和索引使用统计查询，找出冗余索引和缺失索引`,
                "索引诊断",
              )
            }
            className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <ListTree className="h-3 w-3 shrink-0" />
            <span>索引诊断</span>
          </button>
          <button
            type="button"
            disabled={!activeTab?.connectionId || creatingChat || isStreaming}
            onClick={() =>
              void sendPromptToAgent(
                `为表 ${activeTab?.title ?? ""} 生成数据画像。用 db_query 执行 DESCRIBE 和统计查询（行数、空值率、枚举分布等）`,
                "数据画像",
              )
            }
            className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <BarChart3 className="h-3 w-3 shrink-0" />
            <span>数据画像</span>
          </button>
          <button
            type="button"
            disabled={!activeTab?.connectionId || creatingChat || isStreaming}
            onClick={() =>
              void sendPromptToAgent(
                `SQL 执行报错：${activeTab?.result?.message ?? ""}。请用 db_query 查询相关表结构（SHOW CREATE TABLE），分析错误原因并给出修复 SQL`,
                "诊断错误",
              )
            }
            className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span>诊断错误</span>
          </button>
          <button
            type="button"
            disabled={!activeTab?.connectionId || creatingChat || isStreaming}
            onClick={() =>
              void sendPromptToAgent(
                `对当前数据库实例做健康巡检。用 db_query 执行 SHOW STATUS / SHOW VARIABLES / SHOW PROCESSLIST 等查询，生成巡检报告`,
                "一键巡检",
              )
            }
            className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Shield className="h-3 w-3 shrink-0" />
            <span>一键巡检</span>
          </button>
          <button
            type="button"
            disabled={!activeTab?.connectionId || creatingChat || isStreaming}
            onClick={() =>
              void sendPromptToAgent(
                `分析表 ${activeTab?.title ?? ""} 的整体优化建议。用 db_query 查询表结构、索引、数据量和碎片率，给出优化建议`,
                "优化建议",
              )
            }
            className="flex items-center gap-1.5 rounded px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <Wrench className="h-3 w-3 shrink-0" />
            <span>优化建议</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2 scrollbar-thin">
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
        <div className="flex min-h-9 items-end gap-1.5 rounded-xl border border-border/75 bg-background px-2.5 py-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.04)]">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                sendDraft();
              }
            }}
            disabled={!activeTab?.connectionId || creatingChat}
            className="min-h-5 flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            rows={1}
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
          <Button
            type="button"
            size="icon"
            aria-label="发送"
            title="发送消息"
            disabled={!activeTab?.connectionId || !draft.trim() || creatingChat || isStreaming}
            onClick={sendDraft}
            className="h-6 w-6 rounded-lg bg-foreground text-background hover:bg-foreground/90 disabled:bg-muted disabled:text-muted-foreground"
          >
            {creatingChat ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </Button>
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
    <div className="space-y-2.5">
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

      {messages.map((message) => (
        <ChatBubble key={message.id} message={message} />
      ))}

      {creatingChat ? <AssistantHint text="正在创建会话..." loading /> : null}
      {isStreaming ? <AssistantHint text="AI 正在处理..." loading /> : null}
    </div>
  );
}

function ChatBubble({ message }: { message: UIMessage }) {
  if (message.kind === "trace") {
    const traces = message.traces?.length
      ? message.traces
      : message.content
        ? [message.content]
        : [];
    return (
      <div className="rounded-lg border border-border/65 bg-muted/25 px-2.5 py-2 text-[11px] leading-5 text-muted-foreground">
        <div className="font-medium text-foreground/70">AI 动作</div>
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
        {message.displayContent || message.content || (message.isStreaming ? "生成中..." : "")}
      </div>
    </div>
  );
}

function AssistantHint({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <div className="flex justify-center">
      <div className="rounded-xl border border-border/70 bg-background px-2.5 py-2 text-[11.5px] leading-5 text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
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
  children: React.ReactNode;
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
