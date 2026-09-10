import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  BookOpen,
  Check,
  ChevronUp,
  Circle,
  CircleAlert,
  FileText,
  Loader2,
  ListChecks,
  MoreHorizontal,
  Network,
  RefreshCw,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  addAgentKnowledgeDocuments,
  deleteAgentKnowledgeDocument,
  listAgentKnowledgeDocuments,
  listWikiPages,
  retryAgentKnowledgeDocument,
  type AgentKnowledgeProgress,
  type AgentKnowledgeDocument,
  type WikiPageSummary,
} from "@/lib/materials-api";
import { isTauri, materialsImportFiles } from "@/lib/tauri";

const KNOWLEDGE_POLL_INTERVAL_MS = 1500;

export interface AgentKnowledgeSelection {
  kind: "raw" | "wiki";
  path: string;
  agentId: string;
}

export interface AgentKnowledgePanelProps {
  agentId: string;
  selection?: AgentKnowledgeSelection | null;
  onSelect: (selection: AgentKnowledgeSelection | null) => void;
  onKnowledgeChanged?: () => void;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^raw\//, "");
}

function rawPath(path: string): string {
  return `raw/${normalizeRelativePath(path)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function learningStatusLabel(document: AgentKnowledgeDocument): string {
  if (document.phase === "ready") return "已学习";
  if (document.phase === "failed") {
    return document.progress?.evidenceReady ? "整理未完成" : "未学习";
  }
  if (document.phase === "queued") return "等待学习";
  return "学习中";
}

const LEARNING_STAGES = [
  { key: "extracting", label: "读取资料" },
  { key: "organizing", label: "整理知识" },
  { key: "ready", label: "可以使用" },
] as const;

type LearningStageState = "pending" | "active" | "complete" | "failed";

function progressForDocument(document: AgentKnowledgeDocument): AgentKnowledgeProgress {
  if (document.progress) return document.progress;
  if (document.phase === "ready") {
    return { stage: "ready", label: "可以使用", evidenceReady: true };
  }
  if (document.phase === "failed") {
    return {
      stage: "failed",
      label: "学习未完成",
      detail: document.message,
      evidenceReady: false,
    };
  }
  if (document.phase === "queued") {
    return { stage: "queued", label: "读取资料", evidenceReady: false };
  }
  return { stage: "extracting", label: "读取资料", evidenceReady: false };
}

function progressStageIndex(progress: AgentKnowledgeProgress): number {
  if (progress.stage === "organizing") return 1;
  if (progress.stage === "ready") return 2;
  if (progress.stage === "failed") return progress.evidenceReady ? 1 : 0;
  return 0;
}

function progressStageState(
  progress: AgentKnowledgeProgress,
  index: number,
): LearningStageState {
  const activeIndex = progressStageIndex(progress);
  if (progress.stage === "failed") {
    if (index === activeIndex) return "failed";
    return index < activeIndex ? "complete" : "pending";
  }
  if (progress.stage === "ready") return "complete";
  if (index < activeIndex) return "complete";
  if (index === activeIndex) return "active";
  return "pending";
}

function progressPercent(progress: AgentKnowledgeProgress): number | null {
  const raw = typeof progress.percent === "number"
    ? progress.percent
    : typeof progress.completed === "number"
      && typeof progress.total === "number"
      && progress.total > 0
      ? (progress.completed / progress.total) * 100
      : null;
  if (raw === null || !Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, raw));
}

function progressCountLabel(progress: AgentKnowledgeProgress): string | null {
  if (typeof progress.completed !== "number" || typeof progress.total !== "number") return null;
  return `已整理 ${Math.max(0, Math.round(progress.completed))}/${Math.max(0, Math.round(progress.total))} 部分`;
}

function progressStageLabel(stage: AgentKnowledgeProgress["stage"]): string {
  if (stage === "organizing") return "整理知识";
  if (stage === "ready") return "可以使用";
  if (stage === "failed") return "学习未完成";
  return "读取资料";
}

function progressFailureReason(
  document: AgentKnowledgeDocument,
  progress: AgentKnowledgeProgress,
): string {
  return document.message ?? progress.detail ?? "这份资料未能完成学习，请重新学习。";
}

function LearningProgressDetails({ document }: { document: AgentKnowledgeDocument }) {
  const progress = progressForDocument(document);
  const failed = document.phase === "failed" || progress.stage === "failed";
  const percent = progressPercent(progress);
  const countLabel = progressCountLabel(progress);
  const detail = failed ? progressFailureReason(document, progress) : progress.detail;

  return (
    <div
      className="ml-7 rounded-md border border-border/55 bg-muted/20 px-3 py-3"
      data-testid={`learning-progress-${document.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={cn("text-caption font-medium", failed ? "text-destructive" : "text-foreground")}>
          {failed ? "学习未完成" : progress.stage === "ready" ? "可以使用" : `${progressStageLabel(progress.stage)}中`}
        </p>
        {percent !== null ? <span className="text-micro tabular-nums text-muted-foreground">{Math.round(percent)}%</span> : null}
      </div>

      <div className="mt-3 space-y-2">
        {LEARNING_STAGES.map((stage, index) => {
          const state = progressStageState(progress, index);
          return (
            <div key={stage.key} className="flex items-center gap-2 text-caption">
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                  state === "complete" && "bg-success/10 text-success",
                  state === "active" && "bg-info/10 text-info",
                  state === "failed" && "bg-destructive/10 text-destructive",
                  state === "pending" && "bg-muted text-muted-foreground",
                )}
                aria-hidden="true"
              >
                {state === "complete" ? (
                  <Check className="h-3 w-3" />
                ) : state === "active" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : state === "failed" ? (
                  <CircleAlert className="h-3 w-3" />
                ) : (
                  <Circle className="h-2.5 w-2.5" />
                )}
              </span>
              <span className={cn("min-w-0 flex-1", state === "active" && "font-medium text-info", state === "failed" && "text-destructive")}>
                {stage.label}
              </span>
              <span className="shrink-0 text-micro text-muted-foreground">
                {state === "complete" ? "已完成" : state === "active" ? "进行中" : state === "failed" ? "未完成" : "待处理"}
              </span>
            </div>
          );
        })}
      </div>

      {countLabel || percent !== null ? (
        <div className="mt-3 space-y-1.5">
          {countLabel ? <p className="text-micro text-muted-foreground">{countLabel}</p> : null}
          {percent !== null ? (
            <Progress
              value={percent}
              aria-label="资料学习进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
              className="h-1.5"
            />
          ) : null}
        </div>
      ) : null}

      {detail ? <p className={cn("mt-2 text-caption leading-5", failed ? "text-destructive" : "text-muted-foreground")}>{detail}</p> : null}
      {failed && progress.evidenceReady && !detail?.includes("原文已可检索") ? (
        <p className="mt-1 text-caption leading-5 text-muted-foreground">原文已可检索，知识整理可重试。</p>
      ) : null}
    </div>
  );
}

export function AgentKnowledgePanel({
  agentId,
  selection = null,
  onSelect,
  onKnowledgeChanged,
}: AgentKnowledgePanelProps) {
  const [documents, setDocuments] = useState<AgentKnowledgeDocument[]>([]);
  const [wikiPages, setWikiPages] = useState<WikiPageSummary[]>([]);
  const [showLearningResults, setShowLearningResults] = useState(false);
  const [expandedProgressId, setExpandedProgressId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionDocumentId, setActionDocumentId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AgentKnowledgeDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readySignatureRef = useRef<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const next = await listAgentKnowledgeDocuments(agentId);
      setDocuments(next);
      const readySignature = next
        .filter((document) => document.phase === "ready")
        .map((document) => `${document.id}:${document.updatedAt}`)
        .sort()
        .join("|");
      if (readySignatureRef.current !== null && readySignatureRef.current !== readySignature) {
        onKnowledgeChanged?.();
      }
      readySignatureRef.current = readySignature;
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加载知识");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [agentId, onKnowledgeChanged]);

  useEffect(() => {
    setDocuments([]);
    setWikiPages([]);
    setShowLearningResults(false);
    setExpandedProgressId(null);
    setError(null);
    readySignatureRef.current = null;
    void refresh();
  }, [agentId, refresh]);

  const hasLearningDocuments = documents.some(
    (document) => document.phase === "queued" || document.phase === "learning",
  );
  useEffect(() => {
    if (!hasLearningDocuments) return;
    const timer = window.setInterval(() => {
      void refresh(true);
    }, KNOWLEDGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasLearningDocuments, refresh]);

  const handleAdd = useCallback(async () => {
    if (busy) return;
    if (!isTauri()) {
      setError("当前环境不支持添加资料。");
      return;
    }
    try {
      setError(null);
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: "资料",
            extensions: [
              "pdf",
              "docx",
              "xlsx",
              "pptx",
              "txt",
              "md",
              "csv",
              "json",
              "html",
              "png",
              "jpg",
              "jpeg",
              "webp",
            ],
          },
        ],
      });
      if (!selected) return;
      const sourcePaths = Array.isArray(selected) ? selected : [selected];
      if (sourcePaths.length === 0) return;

      setBusy(true);
      const imported = await materialsImportFiles(sourcePaths, "", undefined, agentId);
      const paths = imported
        .filter((entry) => entry.kind === "file")
        .map((entry) => normalizeRelativePath(entry.path));
      if (paths.length > 0) {
        await addAgentKnowledgeDocuments(agentId, paths);
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "添加资料失败，请重试。");
    } finally {
      setBusy(false);
    }
  }, [agentId, busy, refresh]);

  const toggleLearningResults = useCallback(async () => {
    const next = !showLearningResults;
    setShowLearningResults(next);
    if (!next) return;
    try {
      setWikiPages(await listWikiPages(undefined, agentId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法加载学习结果");
    }
  }, [agentId, showLearningResults]);

  const handleRetry = useCallback(async (document: AgentKnowledgeDocument) => {
    if (busy) return;
    setBusy(true);
    setActionDocumentId(document.id);
    setError(null);
    try {
      await retryAgentKnowledgeDocument(document.id, agentId);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重新学习失败，请重试。");
    } finally {
      setBusy(false);
      setActionDocumentId(null);
    }
  }, [agentId, busy, refresh]);

  const handleRemove = useCallback(async () => {
    if (!removeTarget || busy) return;
    const target = removeTarget;
    setBusy(true);
    setActionDocumentId(target.id);
    setError(null);
    try {
      await deleteAgentKnowledgeDocument(target.id, agentId);
      setDocuments((current) => current.filter((document) => document.id !== target.id));
      if (
        selection?.agentId === agentId
        && normalizeRelativePath(selection.path) === normalizeRelativePath(target.path)
      ) {
        onSelect(null);
      }
      setRemoveTarget(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "移除资料失败，请重试。");
    } finally {
      setBusy(false);
      setActionDocumentId(null);
    }
  }, [agentId, busy, onSelect, refresh, removeTarget, selection]);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border/50 px-4 py-4">
        <div>
          <h2 className="text-title-sm">知识</h2>
          <p className="mt-1 text-caption leading-5 text-muted-foreground">
            添加资料，让这个 Agent 在完成任务时参考其中的信息。
          </p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="gap-1.5"
            aria-pressed={selection === null}
            onClick={() => onSelect(null)}
          >
            <Network className="h-3.5 w-3.5" />
            知识图谱
          </Button>
          <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={() => void toggleLearningResults()}>
            <BookOpen className="h-3.5 w-3.5" />
            {showLearningResults ? "返回资料" : "查看学习结果"}
          </Button>
          <Button
            type="button"
            size="sm"
            className="ml-auto gap-1.5"
            disabled={busy}
            onClick={() => void handleAdd()}
          >
            <Upload className="h-3.5 w-3.5" />
            添加资料
          </Button>
        </div>
      </header>

      {error ? (
        <div role="alert" className="mx-5 mt-3 rounded-md border border-destructive/35 bg-destructive/5 px-3 py-2 text-caption text-destructive">
          {error}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {showLearningResults ? (
          wikiPages.length === 0 ? (
            <div className="px-5 py-12 text-center text-caption text-muted-foreground">
              还没有学习结果。
            </div>
          ) : (
            <div className="space-y-1 p-2">
              {wikiPages.map((page) => (
                <Button
                  key={page.id || page.path}
                  type="button"
                  variant="ghost"
                  onClick={() => onSelect({ kind: "wiki", path: page.path, agentId })}
                  className={cn(
                    "h-auto w-full justify-start gap-2 rounded-md px-3 py-2.5 text-left text-ui font-normal hover:bg-accent/45",
                    selection?.kind === "wiki" && selection.path === page.path && "bg-accent/55",
                  )}
                >
                  <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{page.title}</span>
                </Button>
              ))}
            </div>
          )
        ) : loading && documents.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-5 py-12 text-caption text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载知识...
          </div>
        ) : documents.length === 0 ? (
          <div className="px-5 py-12 text-center text-caption text-muted-foreground">
            还没有资料。添加资料后，这个 Agent 会自动学习。
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {documents.map((document) => {
              const selected = selection?.kind === "raw" && selection.agentId === agentId
                && normalizeRelativePath(selection.path) === normalizeRelativePath(document.path);
              const isActing = actionDocumentId === document.id;
              const progressExpanded = expandedProgressId === document.id;
              const canShowProgress = document.phase !== "ready";
              return (
                <article
                  key={document.id}
                  className={cn(
                    "flex flex-col gap-2 rounded-md px-3 py-3 transition-colors hover:bg-accent/35",
                    selected && "bg-accent/55",
                  )}
                >
                  <div className="flex w-full min-w-0 items-start gap-3">
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`选择 ${document.name}`}
                      aria-pressed={selected}
                      onClick={() => onSelect(selected ? null : { kind: "raw", path: rawPath(document.path), agentId })}
                      className="h-auto min-w-0 flex-1 items-start justify-start gap-2 p-0 text-left font-normal hover:bg-transparent hover:text-foreground"
                    >
                      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui">{document.name}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-micro text-muted-foreground">
                          <span>{formatBytes(document.size)}</span>
                          <span aria-hidden>·</span>
                          <span
                            className={cn(
                              "inline-flex items-center gap-1",
                              document.phase === "ready"
                                ? "text-success"
                                : document.phase === "failed"
                                  ? "text-destructive"
                                  : "text-muted-foreground",
                            )}
                          >
                            {document.phase === "ready" ? (
                              <CheckCircle2 className="h-3 w-3" />
                            ) : document.phase === "failed" ? (
                              <XCircle className="h-3 w-3" />
                            ) : (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            {learningStatusLabel(document)}
                          </span>
                        </span>
                      </span>
                    </Button>
                    {canShowProgress ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${progressExpanded ? "收起" : "查看"}学习进度 ${document.name}`}
                        aria-expanded={progressExpanded}
                        aria-controls={`learning-progress-${document.id}`}
                        title={progressExpanded ? "收起学习进度" : "查看学习进度"}
                        onClick={() => setExpandedProgressId((current) => current === document.id ? null : document.id)}
                        className={cn(
                          "-mt-1 h-8 w-8 shrink-0 text-muted-foreground",
                          progressExpanded && "bg-accent/55 text-foreground",
                        )}
                      >
                        {progressExpanded ? <ChevronUp className="h-4 w-4" /> : <ListChecks className="h-4 w-4" />}
                      </Button>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`更多操作 ${document.name}`}
                          disabled={busy}
                          className="-mt-1 h-8 w-8 shrink-0 text-muted-foreground"
                        >
                          {isActing ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <MoreHorizontal className="h-4 w-4" />
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-36">
                        <DropdownMenuItem
                          aria-label={`重新学习 ${document.name}`}
                          disabled={busy}
                          onSelect={() => void handleRetry(document)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          重新学习
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          aria-label={`删除 ${document.name}`}
                          disabled={busy}
                          onSelect={() => setRemoveTarget(document)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {progressExpanded ? <LearningProgressDetails document={document} /> : null}
                  {document.phase === "failed" && !progressExpanded ? (
                    <div className="pl-6 text-caption text-destructive">
                      {document.message ?? document.progress?.detail ?? "这份资料学习失败，请重新学习。"}
                      {document.progress?.evidenceReady && !document.message?.includes("原文已可检索") ? (
                        <p className="mt-1 text-muted-foreground">原文已可检索，知识整理可重试。</p>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
          <AlertDialogTitle>删除这份资料？</AlertDialogTitle>
          <AlertDialogDescription>
              删除后，这个 Agent 不会再使用它，但不会删除电脑上的原文件。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void handleRemove();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
