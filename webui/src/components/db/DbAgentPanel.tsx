import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RotateCcw, Send, Square, Zap, AlertTriangle } from "lucide-react";
import { AgentLogo } from "@/components/AgentLogo";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { useMonaStream, type SendOptions } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import { isTauri } from "@/lib/tauri";
import type { UIMessage } from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";
import { useDbStore } from "./store/dbStore";
import type { DbSqlDraft } from "./types";
import { SqlResultCard } from "./SqlResultCard";

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
  const [sqlDraft, setSqlDraft] = useState<DbSqlDraft | null>(null);
  const pendingPromptRef = useRef<string | null>(null);
  const pendingSendOptsRef = useRef<SendOptions | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { client } = useClient();

  const activeTabId = useDbStore((s) => s.activeTabId);
  const queryTabs = useDbStore((s) => s.queryTabs);
  const activeConnections = useDbStore((s) => s.activeConnections);
  const updateTabSql = useDbStore((s) => s.updateTabSql);
  const setAgentStreaming = useDbStore((s) => s.setAgentStreaming);
  const activeTab = queryTabs.find((t) => t.id === activeTabId);

  const activeConnection = activeTab?.connectionId
    ? activeConnections.find((c) => c.id === activeTab.connectionId)
    : undefined;

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
    setSqlDraft(null);
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

  // Listen for structured SQL drafts published by the AI via db_sql_draft tool.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<DbSqlDraft>("db-sql-draft-ready", (event) => {
        setSqlDraft(event.payload);
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  // 草稿卡片现在挂在对话流最底部，新草稿到达时自动滚到底部，避免用户回滚查找。
  useEffect(() => {
    if (!sqlDraft) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [sqlDraft]);

  const buildSendOpts = useCallback((): SendOptions => {
    const opts: SendOptions = {
      dbConnectionId: activeTab?.connectionId ?? undefined,
      dbDatabase: activeTab?.database ?? undefined,
      dbTable: activeTab?.title ?? undefined,
      dbCurrentSql: activeTab?.sql?.trim() || undefined,
      dbLastError: activeTab?.result?.message ?? undefined,
    };
    if (activeConnection) {
      opts.dbType = activeConnection.config.db_type;
      if (activeConnection.server_version) {
        opts.dbServerVersion = activeConnection.server_version;
      }
    }
    return opts;
  }, [activeTab, activeConnection]);

  const sendPromptToAgent = useCallback(
    async (prompt: string, displayName?: string) => {
      const trimmed = prompt.trim();
      if (!trimmed || creatingChat) return;
      if (isStreaming) {
        setNotice("Agent 正在处理，先停止或等它完成");
        return;
      }

      const sendOpts = buildSendOpts();
      if (displayName) sendOpts.displayContent = displayName;

      if (chatId) {
        send(trimmed, undefined, sendOpts);
        return;
      }

      setCreatingChat(true);
      setNotice("正在创建会话");
      pendingPromptRef.current = trimmed;
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
    [chatId, client, creatingChat, isStreaming, activeTabId, buildSendOpts, send],
  );

  const sendDraft = useCallback(() => {
    const question = draft.trim();
    if (!question) return;
    setDraft("");
    void sendPromptToAgent(question, question);
  }, [draft, sendPromptToAgent]);

  const handleContextAction = useCallback(
    (action: "explain_sql" | "diagnose_error") => {
      if (!activeTab?.connectionId) return;
      let prompt = "";
      let label = "";
      if (action === "explain_sql") {
        prompt = "解释当前 SQL 编辑器中的语句：分析执行计划、潜在性能问题和优化建议。";
        label = "解释当前 SQL";
      } else {
        prompt = "诊断当前 SQL 执行报错的原因，并给出修复建议。";
        label = "诊断当前错误";
      }
      void sendPromptToAgent(prompt, label);
    },
    [activeTab, sendPromptToAgent],
  );

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

  const hasSql = !!activeTab?.sql?.trim();
  const hasError = !!activeTab?.result?.message;

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

      <div className="shrink-0 border-b border-border/65 px-2.5 py-2">
        <div className="flex flex-wrap gap-1.5">
          {hasSql ? (
            <ContextActionButton
              icon={<Zap className="h-3.5 w-3.5" />}
              label="解释当前 SQL"
              disabled={creatingChat || isStreaming}
              onClick={() => handleContextAction("explain_sql")}
            />
          ) : null}
          {hasError ? (
            <ContextActionButton
              icon={<AlertTriangle className="h-3.5 w-3.5" />}
              label="诊断当前错误"
              disabled={creatingChat || isStreaming}
              onClick={() => handleContextAction("diagnose_error")}
            />
          ) : null}
          {!hasSql && !hasError ? (
            <p className="px-1 py-1 text-[10.5px] text-muted-foreground">
              打开 SQL 或执行出错时，这里会出现对应的快捷分析动作。
            </p>
          ) : null}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2 scrollbar-thin"
      >
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
        {sqlDraft && activeTabId ? (
          <div className="mt-2">
            <SqlResultCard
              draft={sqlDraft}
              onInsert={(sql) => {
                const tab = useDbStore.getState().queryTabs.find((t) => t.id === activeTabId);
                if (tab) updateTabSql(activeTabId, `${tab.sql}\n${sql}`);
              }}
              onReplace={(sql) => updateTabSql(activeTabId, sql)}
              onDismiss={() => setSqlDraft(null)}
            />
          </div>
        ) : null}
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
            placeholder="描述想查的数据或想做的分析..."
          />
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

function ContextActionButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 text-[11px] font-medium text-foreground/82 transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      {icon}
      <span className="max-w-[140px] truncate">{label}</span>
    </button>
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
        <AssistantHint text="描述你想查的数据或想做的分析，AI 会自动获取上下文。" />
      ) : null}

      {loading ? <AssistantHint text="正在读取会话历史..." loading /> : null}

      <ThreadMessages messages={messages} isStreaming={isStreaming} />

      {creatingChat ? <AssistantHint text="正在创建会话..." loading /> : null}
      {isStreaming ? <AssistantHint text="AI 正在处理..." loading /> : null}
    </div>
  );
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
