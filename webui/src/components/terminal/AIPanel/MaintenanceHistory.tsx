import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  ChevronRight,
  Circle,
  Eraser,
  Loader2,
  MinusCircle,
  RefreshCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  terminalMaintenanceClear,
  terminalMaintenanceDelete,
  terminalMaintenanceGet,
  terminalMaintenanceList,
  type MaintenanceStep,
  type MaintenanceStepStatus,
  type MaintenanceTask,
  type MaintenanceTaskDetail,
  type MaintenanceTaskResolution,
  type MaintenanceTaskStatus,
} from "../ipc";

const STATUS_LABEL: Record<MaintenanceTaskStatus, string> = {
  planning: "规划中",
  waiting_approval: "待审批",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};

const STATUS_TONE: Record<MaintenanceTaskStatus, string> = {
  planning: "text-muted-foreground border-border/70",
  waiting_approval: "text-warning border-warning/40 bg-warning/10",
  running: "text-primary border-primary/40 bg-primary/10",
  succeeded: "text-success border-success/40 bg-success/10",
  failed: "text-destructive border-destructive/40 bg-destructive/10",
  cancelled: "text-muted-foreground border-border/70",
};

const RESOLUTION_LABEL: Record<MaintenanceTaskResolution, string> = {
  "": "",
  completed_changes: "完成变更",
  no_changes_needed: "无需变更",
  partial: "部分完成",
  failed: "失败",
};

const RESOLUTION_TONE: Record<MaintenanceTaskResolution, string> = {
  "": "",
  completed_changes: "text-success border-success/40 bg-success/10",
  no_changes_needed: "text-success border-success/40 bg-success/10",
  partial: "text-warning border-warning/40 bg-warning/10",
  failed: "text-destructive border-destructive/40 bg-destructive/10",
};

function badgeForTask(task: MaintenanceTask): { label: string; tone: string } {
  if (task.resolution) {
    return {
      label: RESOLUTION_LABEL[task.resolution],
      tone: RESOLUTION_TONE[task.resolution],
    };
  }
  return { label: STATUS_LABEL[task.status], tone: STATUS_TONE[task.status] };
}

/** Still-running tasks are never removed by 清除全部 (the backend keeps them
 *  for the same reason single-record delete refuses them). */
function isActiveTask(task: MaintenanceTask): boolean {
  return (
    task.status === "planning"
    || task.status === "waiting_approval"
    || task.status === "running"
  );
}

const KIND_LABEL: Record<MaintenanceStep["kind"], string> = {
  inspect: "检查",
  change: "变更",
  verify: "复检",
};

type StatusFilter = "all" | "succeeded" | "failed" | "cancelled";

/** One record, or every finished record. Both need the same confirmation
 *  flow, so they share one pending-action state. */
type PendingAction =
  | { kind: "one"; task: MaintenanceTask }
  | { kind: "all" }
  | null;

const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部结果" },
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "cancelled", label: "已取消" },
];

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function taskDurationMs(task: MaintenanceTask): number | null {
  if (task.finishedAt == null) return null;
  return task.finishedAt - (task.startedAt ?? task.createdAt);
}

function StepStatusIcon({ status }: { status: MaintenanceStepStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
    case "succeeded":
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
    case "skipped":
      return <MinusCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />;
    case "cancelled":
      return <Ban className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />;
    default:
      return <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />;
  }
}

export function MaintenanceHistory() {
  const [tasks, setTasks] = useState<MaintenanceTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverFilter, setServerFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setTasks(await terminalMaintenanceList(undefined, undefined, 100));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!pendingAction) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (pendingAction.kind === "all") {
        await terminalMaintenanceClear();
        // Active tasks survive the clear, so drop only the finished rows.
        setTasks((prev) => prev.filter((t) => isActiveTask(t)));
      } else {
        await terminalMaintenanceDelete(pendingAction.task.id);
        setTasks((prev) => prev.filter((t) => t.id !== pendingAction.task.id));
      }
      setPendingAction(null);
    } catch (e) {
      // 失败时保留确认框并展示原因，用户可重试或取消
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }, [pendingAction]);

  useEffect(() => {
    load();
  }, [load]);

  const serverOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) {
      if (!map.has(t.configId)) map.set(t.configId, t.targetLabel);
    }
    return [
      { value: "all", label: "全部服务器" },
      ...[...map.entries()].map(([value, label]) => ({ value, label })),
    ];
  }, [tasks]);

  const filtered = useMemo(
    () =>
      tasks.filter(
        (t) =>
          (serverFilter === "all" || t.configId === serverFilter) &&
          (statusFilter === "all" || t.status === statusFilter),
      ),
    [tasks, serverFilter, statusFilter],
  );

  /** 清除全部 only removes finished records; with none present the entry is inert. */
  const finishedCount = useMemo(() => tasks.filter((t) => !isActiveTask(t)).length, [tasks]);
  const hasFinishedTask = finishedCount > 0;

  if (selectedId) {
    return <HistoryDetail taskId={selectedId} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-2.5 py-2">
        <Select
          value={serverFilter}
          onValueChange={setServerFilter}
          options={serverOptions}
          aria-label="按服务器筛选"
          className="h-6 min-w-0 flex-1 px-1.5 text-caption"
        />
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as StatusFilter)}
          options={STATUS_FILTER_OPTIONS}
          aria-label="按结果筛选"
          className="h-6 w-auto shrink-0 px-1.5 text-caption"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={load}
          aria-label="刷新"
          title="刷新"
          className="h-6 w-6 shrink-0 text-muted-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover px-2 pb-2">
        {loadError && (
          <p className="px-1 py-4 text-center text-micro text-destructive">{loadError}</p>
        )}
        {!loadError && !loading && filtered.length === 0 && (
          <p className="px-1 py-8 text-center text-micro text-muted-foreground">
            暂无维护记录
          </p>
        )}
        <div className="space-y-1">
          {filtered.map((t) => {
            const duration = taskDurationMs(t);
            const badge = badgeForTask(t);
            return (
              <ContextMenu key={t.id}>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setSelectedId(t.id)}
                    className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "shrink-0 rounded border px-1 py-px text-micro font-medium",
                            badge.tone,
                          )}
                        >
                          {badge.label}
                        </span>
                        <span className="truncate text-micro font-medium text-foreground" title={t.goal}>
                          {t.goal}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-micro text-muted-foreground">
                        <span className="truncate">{t.targetLabel}</span>
                        <span className="shrink-0">{formatTime(t.createdAt)}</span>
                        {duration != null && (
                          <span className="shrink-0">{formatDuration(duration)}</span>
                        )}
                      </div>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-40">
                  <ContextMenuItem
                    onClick={() => {
                      setDeleteError(null);
                      setPendingAction({ kind: "one", task: t });
                    }}
                    className="text-caption text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    删除记录
                  </ContextMenuItem>
                  <ContextMenuItem
                    disabled={!hasFinishedTask}
                    onClick={() => {
                      setDeleteError(null);
                      setPendingAction({ kind: "all" });
                    }}
                    className="text-caption text-destructive focus:text-destructive"
                  >
                    <Eraser className="mr-2 h-3.5 w-3.5" />
                    清除全部
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </div>
      </div>

      <AlertDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingAction?.kind === "all" ? "清除全部维护记录？" : "删除这条维护记录？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingAction?.kind === "all"
                ? `将删除全部 ${finishedCount} 条已结束的维护记录，进行中的任务会保留。清除后无法恢复。`
                : `将删除「${pendingAction?.task.goal}」的全部执行记录，删除后无法恢复。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p className="text-caption text-destructive">
              {pendingAction?.kind === "all" ? "清除失败：" : "删除失败："}
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirm();
              }}
              disabled={deleting}
            >
              {pendingAction?.kind === "all"
                ? deleting
                  ? "清除中..."
                  : "清除全部"
                : deleting
                  ? "删除中..."
                  : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function HistoryDetail({ taskId, onBack }: { taskId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<MaintenanceTaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    terminalMaintenanceGet(taskId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  const lastVerify = useMemo(() => {
    if (!detail) return null;
    const verifies = detail.steps.filter(
      (s) => s.kind === "verify" && s.status !== "pending" && s.status !== "skipped",
    );
    return verifies.length > 0 ? verifies[verifies.length - 1] : null;
  }, [detail]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/65 px-2.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onBack}
          className="gap-1 text-caption text-muted-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          返回列表
        </Button>
        {detail && (
          <span
            className={cn(
              "rounded border px-1.5 py-0.5 text-micro font-medium",
              badgeForTask(detail.task).tone,
            )}
          >
            {badgeForTask(detail.task).label}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hover p-2.5">
        {loadError && <p className="py-4 text-center text-micro text-destructive">{loadError}</p>}
        {!detail && !loadError && (
          <p className="py-8 text-center text-micro text-muted-foreground">加载中…</p>
        )}
        {detail && (
          <div className="space-y-3">
            <section>
              <h3 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                维护目标
              </h3>
              <p className="mt-1 whitespace-pre-wrap break-words text-caption leading-4.5 text-foreground">
                {detail.task.goal}
              </p>
              <p className="mt-1 text-micro text-muted-foreground">
                {detail.task.targetLabel} · {formatTime(detail.task.createdAt)}
                {taskDurationMs(detail.task) != null &&
                  ` · 耗时 ${formatDuration(taskDurationMs(detail.task)!)}`}
              </p>
            </section>

            {detail.task.diagnosis && (
              <section>
                <h3 className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                  AI 诊断
                  <span className="rounded border border-primary/40 bg-primary/10 px-1 py-px text-micro normal-case text-primary">
                    AI 诊断
                  </span>
                </h3>
                <p className="mt-1 whitespace-pre-wrap break-words text-micro leading-4.5 text-foreground">
                  {detail.task.diagnosis}
                </p>
              </section>
            )}

            <section>
              <h3 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                执行步骤
              </h3>
              <div className="mt-1 space-y-1">
                {detail.steps.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-1.5 rounded-md border border-border/50 bg-background px-2 py-1.5"
                  >
                    <StepStatusIcon status={s.status} />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-micro text-foreground",
                        (s.status === "skipped" || s.status === "cancelled") &&
                          "text-muted-foreground/70 line-through",
                      )}
                      title={s.title}
                    >
                      {s.title}
                    </span>
                    <span className="shrink-0 rounded border border-border/70 px-1 py-px text-micro text-muted-foreground">
                      {KIND_LABEL[s.kind]}
                    </span>
                    {s.exitCode != null && (
                      <span className="shrink-0 text-micro text-muted-foreground">
                        exit {s.exitCode}
                      </span>
                    )}
                    {s.durationMs != null && (
                      <span className="shrink-0 text-micro text-muted-foreground/70">
                        {formatDuration(s.durationMs)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {lastVerify && (
              <section>
                <h3 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                  最终复检
                </h3>
                <div className="mt-1 flex items-center gap-1.5 rounded-md border border-info/30 bg-info/5 px-2 py-1.5">
                  <StepStatusIcon status={lastVerify.status} />
                  <span className="min-w-0 flex-1 truncate text-micro text-foreground" title={lastVerify.title}>
                    {lastVerify.title}
                  </span>
                  {lastVerify.exitCode != null && (
                    <span className="shrink-0 text-micro text-muted-foreground">
                      exit {lastVerify.exitCode}
                    </span>
                  )}
                </div>
              </section>
            )}

            {detail.task.summary && (
              <section>
                <h3 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                  最终摘要
                </h3>
                <p className="mt-1 whitespace-pre-wrap break-words text-micro leading-4.5 text-foreground">
                  {detail.task.summary}
                </p>
              </section>
            )}
            {detail.task.error && (
              <section>
                <h3 className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                  失败原因
                </h3>
                <p className="mt-1 whitespace-pre-wrap break-words text-micro leading-4.5 text-destructive">
                  {detail.task.error}
                </p>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
