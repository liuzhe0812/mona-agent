/**
 * MaterialsLintPanel — 资料库 lint 报告面板 + 「让 Mona 修复」Agent 会话。
 *
 * 报告模式：按规则分组展示 lint 结果，点击条目跳转预览对应文件。
 * 修复模式：创建绑定 vault workspace 的 Agent 会话，把报告作为任务注入，
 * 由 Agent 直接编辑 wiki 文件完成修复（lint 本身只报告不修复）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ChevronLeft,
  Loader2,
  RotateCcw,
  Send,
  ShieldCheck,
  Square,
  Wand2,
  X,
} from "lucide-react";

import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { Button } from "@/components/ui/button";
import { useMonaStream } from "@/hooks/useMonaStream";
import { useSessionHistory } from "@/hooks/useSessions";
import type { MaterialsLintIssue, MaterialsLintReport } from "@/lib/materials-api";
import { cn } from "@/lib/utils";
import { useClientOptional } from "@/providers/ClientProvider";

interface MaterialsLintPanelProps {
  report: MaterialsLintReport | null;
  running: boolean;
  /** lint 请求失败原因（无数据时展示） */
  error?: string | null;
  /** vault 根目录绝对路径，用于绑定 Agent 会话 workspace */
  vaultRoot: string | null;
  width?: number;
  onClose: () => void;
  /** 重新运行 lint（修复完成后用户可手动验证） */
  onRefresh: () => void;
  /** 点击问题条目跳转预览 */
  onOpenIssue: (issue: MaterialsLintIssue) => void;
  onStreamingChange?: (streaming: boolean) => void;
}

/** 把 lint 报告转为 Agent 修复任务 prompt（工作目录 = vault 根目录）。 */
function buildLintFixPrompt(report: MaterialsLintReport): string {
  const lines = report.issues.map(
    (i) => `- [${i.severity}] ${i.label} | ${i.path} | ${i.message}`,
  );
  return [
    `资料库 lint 检查发现 ${report.issues.length} 个问题（${report.summary.errors} 个错误，${report.summary.warnings} 个警告），请直接编辑文件逐一修复。`,
    "",
    "路径基准（当前工作目录即笔记仓库根目录）：",
    "- Wiki 页面：.mona/materials/wiki/<path>",
    "- 原始文件：.mona/materials/raw/<path>",
    "- 提取文本：.mona/materials/text/<path>",
    "",
    "修复规则：",
    "- frontmatter-schema：补齐/修正 frontmatter。id 需 wiki- 前缀（可用 wiki-<uuid>）；type 取 source/entity/concept；created/updated 用 YYYY-MM-DD；sources 为字符串数组。",
    "- broken-wikilink：把正文里的 [[链接]] 改为存在的页面标题；目标内容确实不存在的，移除链接语法保留文本。",
    "- dangling-source：sources 中引用的 raw 文件已不存在，从 sources 列表移除该条目（不要删除页面本身）。",
    "- duplicate-title：同一标题的多个页面合并为一个（保留信息更全的），删除多余页面，并把指向被删页面的 [[链接]] 改指保留页。",
    "- orphan-page：在相关页面正文中自然地补充指向该页的 [[链接]]；确实无价值的页面可删除。",
    "- thin-page：根据该页 sources 对应的 .mona/materials/text/ 提取文本补充实质内容；无法补充则删除该页。",
    "- text-extract-error：提取失败的文件无法修复时跳过，在总结中说明。",
    "",
    "约束：",
    "- 用 write_file/edit_file 直接修改文件，不要只输出建议。",
    "- 修改 frontmatter 时保留已有 id、created 与人工添加的字段。",
    "- 全部处理后，简要总结每项改动。",
    "",
    "问题清单：",
    ...lines,
  ].join("\n");
}

export function MaterialsLintPanel({
  report,
  running,
  error,
  vaultRoot,
  width = 320,
  onClose,
  onRefresh,
  onOpenIssue,
  onStreamingChange,
}: MaterialsLintPanelProps) {
  const { client } = useClientOptional();
  const [mode, setMode] = useState<"report" | "chat">("report");
  const [chatId, setChatId] = useState<string | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const pendingPromptRef = useRef<{ prompt: string; displayContent: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const historyKey = chatId ? `websocket:${chatId}` : null;
  const { messages: historical, loading: historyLoading } = useSessionHistory(historyKey);
  const {
    messages,
    isStreaming,
    send,
    stop,
  } = useMonaStream(chatId, historical, false);

  useEffect(() => {
    onStreamingChange?.(isStreaming);
  }, [isStreaming, onStreamingChange]);

  const messagesLen = messages.length;
  useLayoutEffect(() => {
    if (mode === "chat") bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messagesLen, mode]);

  // chatId 就位后补发待发送的修复 prompt
  useEffect(() => {
    const pending = pendingPromptRef.current;
    if (!chatId || !pending) return;
    pendingPromptRef.current = null;
    send(pending.prompt, undefined, { displayContent: pending.displayContent });
  }, [chatId, send]);

  const startFix = useCallback(async () => {
    if (!report || report.issues.length === 0) return;
    if (isStreaming || creatingChat) return;
    if (!client) {
      setNotice("运行时未就绪，请稍后再试");
      return;
    }
    if (!vaultRoot) {
      setNotice("未获取到仓库路径，无法启动修复");
      return;
    }
    setNotice(null);
    const prompt = buildLintFixPrompt(report);
    const displayContent = `修复资料库 lint 报告（${report.summary.errors} 个错误 / ${report.summary.warnings} 个警告）`;
    setMode("chat");
    if (chatId) {
      send(prompt, undefined, { displayContent });
      return;
    }
    setCreatingChat(true);
    pendingPromptRef.current = { prompt, displayContent };
    try {
      // workspace 绑定 vault：Agent 的文件工具直接作用于 .mona/materials/
      const nextChatId = await client.newChat(5_000, false, vaultRoot);
      setChatId(nextChatId);
    } catch (err) {
      pendingPromptRef.current = null;
      setMode("report");
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingChat(false);
    }
  }, [report, isStreaming, creatingChat, client, vaultRoot, chatId, send]);

  const sendDraft = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || !chatId || isStreaming) return;
    setDraft("");
    send(trimmed);
  }, [chatId, draft, isStreaming, send]);

  const issues = report?.issues ?? [];
  const summary = report?.summary;

  return (
    <aside
      style={{ width }}
      className="flex h-full min-h-0 shrink-0 flex-col border-l border-border/70 bg-background"
    >
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/70 px-2.5">
        {mode === "chat" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="返回报告"
            title="返回报告"
            onClick={() => setMode("report")}
            className="h-6 w-6 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {mode === "chat" ? "Mona 修复中" : "质量检查"}
        </span>
        {mode === "report" && summary ? (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            {summary.errors > 0 ? (
              <span className="text-destructive">{summary.errors} 错误</span>
            ) : null}
            {summary.warnings > 0 ? (
              <span className="text-amber-500">{summary.warnings} 警告</span>
            ) : null}
            {summary.errors === 0 && summary.warnings === 0 ? "无问题" : null}
          </span>
        ) : null}
        {mode === "report" ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="重新检查"
            title="重新检查"
            disabled={running}
            onClick={onRefresh}
            className="h-6 w-6 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="关闭面板"
          title="关闭面板"
          onClick={onClose}
          className="h-6 w-6 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {mode === "report" ? (
        <>
          {/* 报告列表 */}
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover">
            {running && !report ? (
              <div className="flex items-center gap-1.5 p-3 text-[12px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                <span>正在检查...</span>
              </div>
            ) : error && !report ? (
              <div className="flex items-start gap-2 p-3 text-[12px] text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>检查失败：{error}</span>
              </div>
            ) : issues.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
                <ShieldCheck className="h-5 w-5 text-muted-foreground" />
                <p className="text-[12.5px] text-muted-foreground">
                  未发现问题，资料库状态良好。
                </p>
              </div>
            ) : (
              <ul className="py-1">
                {issues.map((issue, index) => (
                  <li key={`${issue.rule}:${issue.path}:${index}`}>
                    <button
                      type="button"
                      onClick={() => onOpenIssue(issue)}
                      className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-accent"
                    >
                      {issue.severity === "error" ? (
                        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {issue.label}
                          </span>
                          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                            {issue.path}
                          </span>
                        </span>
                        <span className="mt-0.5 block break-words text-[12px] leading-5 text-foreground">
                          {issue.message}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 底部：让 Mona 修复 */}
          <div className="shrink-0 border-t border-border/70 p-2.5">
            {notice ? (
              <p className="mb-1.5 text-[11px] text-destructive">{notice}</p>
            ) : null}
            <Button
              type="button"
              disabled={issues.length === 0 || running || creatingChat || isStreaming}
              onClick={() => void startFix()}
              className="h-8 w-full rounded-md text-[13px]"
            >
              {creatingChat ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              让 Mona 修复
            </Button>
          </div>
        </>
      ) : (
        <>
          {/* 修复会话 */}
          <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 scrollbar-hover">
            <div className="space-y-3">
              {historyLoading ? (
                <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>正在加载会话...</span>
                </div>
              ) : null}
              {creatingChat ? (
                <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>正在创建修复会话...</span>
                </div>
              ) : null}
              <ThreadMessages messages={messages} isStreaming={isStreaming} />
              <div ref={bottomRef} />
            </div>
          </div>
          <div className="shrink-0 p-2">
            {notice ? (
              <p className="mb-1.5 px-1 text-[11px] text-destructive">{notice}</p>
            ) : null}
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
                disabled={!chatId || isStreaming}
                className="min-h-[36px] flex-1 resize-none bg-transparent text-[12px] leading-5 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                rows={2}
                placeholder="补充说明（如：只修错误）..."
              />
              <button
                type="button"
                aria-label={isStreaming ? "停止生成" : "发送"}
                disabled={!isStreaming && (!chatId || !draft.trim())}
                onClick={isStreaming ? stop : sendDraft}
                className={cn(
                  "grid h-6 w-6 shrink-0 place-items-center rounded-lg transition-colors",
                  isStreaming
                    ? "text-destructive hover:bg-destructive/10"
                    : "bg-action text-white hover:bg-action-hover hover:text-white disabled:bg-muted disabled:text-muted-foreground",
                )}
              >
                {isStreaming ? (
                  <Square className="h-3 w-3" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
              </button>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
