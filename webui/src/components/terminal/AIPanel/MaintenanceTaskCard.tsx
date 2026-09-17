import { useState } from "react";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader2,
  MinusCircle,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  terminalMaintenanceAuthorize,
  terminalMaintenanceCancel,
  type MaintenanceStep,
  type MaintenanceStepStatus,
  type MaintenanceTaskDetail,
  type MaintenanceTaskStatus,
} from "../ipc";

const TASK_STATUS_LABEL: Record<MaintenanceTaskStatus, string> = {
  planning: "规划中",
  waiting_approval: "待审批",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  cancelled: "已取消",
};

const TASK_STATUS_TONE: Record<MaintenanceTaskStatus, string> = {
  planning: "text-muted-foreground border-border/70",
  waiting_approval: "text-warning border-warning/40 bg-warning/10",
  running: "text-primary border-primary/40 bg-primary/10",
  succeeded: "text-success border-success/40 bg-success/10",
  failed: "text-destructive border-destructive/40 bg-destructive/10",
  cancelled: "text-muted-foreground border-border/70",
};

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

function isActive(status: MaintenanceTaskStatus): boolean {
  return status === "planning" || status === "waiting_approval" || status === "running";
}

function isDone(status: MaintenanceStepStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface Props {
  detail: MaintenanceTaskDetail;
}

export function MaintenanceTaskCard({ detail }: Props) {
  const { task, steps } = detail;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const doneCount = steps.filter((s) => isDone(s.status)).length;
  const runningStep = steps.find((s) => s.status === "running");
  const pendingApprovalSteps = steps.filter(
    (s) => s.status === "pending" && s.kind !== "inspect" && s.approvedAt == null,
  );

  const handleAuthorize = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await terminalMaintenanceAuthorize(
        task.id,
        pendingApprovalSteps.map((s) => s.id),
      );
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await terminalMaintenanceCancel(task.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 p-2.5">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        title={collapsed ? "展开运维步骤" : "折叠运维步骤"}
        className="h-auto w-full justify-start gap-2 rounded-md px-1 py-0.5 font-normal hover:bg-accent/60"
      >
        <span
          className={cn(
            "shrink-0 rounded-md border px-1.5 py-0.5 text-micro font-medium",
            TASK_STATUS_TONE[task.status],
          )}
        >
          {TASK_STATUS_LABEL[task.status]}
        </span>
        <span className="min-w-0 flex-1 truncate text-caption font-medium text-foreground" title={task.goal}>
          {task.goal}
        </span>
        <span className="shrink-0 text-micro text-muted-foreground">
          {doneCount}/{steps.length}
        </span>
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </Button>

      {!collapsed && (
        <div className="mt-2 max-h-44 space-y-1 overflow-y-auto scrollbar-thin">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} highlighted={step.id === runningStep?.id} />
          ))}
        </div>
      )}

      {/* 审批会阻塞任务推进，折叠时仍然保留入口，避免用户错过必须的确认。 */}
      {task.status === "waiting_approval" && (
        <div className="mt-2 rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5">
          <p className="text-micro text-muted-foreground">
            审批模式：只读检查已自动执行，确认后按计划连续执行变更与复检步骤。
          </p>
          <Button
            type="button"
            size="xs"
            disabled={busy || pendingApprovalSteps.length === 0}
            onClick={handleAuthorize}
            className="mt-1.5 w-full gap-1.5 text-caption"
          >
            <ShieldCheck className="h-3 w-3" />
            批准变更计划（{pendingApprovalSteps.length} 个步骤）
          </Button>
        </div>
      )}

      {!collapsed && task.status === "succeeded" && task.summary && (
        <p className="mt-2 whitespace-pre-wrap break-words text-micro leading-4 text-muted-foreground">
          {task.summary}
        </p>
      )}
      {!collapsed && task.status === "failed" && task.error && (
        <p className="mt-2 whitespace-pre-wrap break-words text-micro leading-4 text-destructive">
          {task.error}
        </p>
      )}
      {actionError && (
        <p className="mt-1.5 text-micro text-destructive">{actionError}</p>
      )}

      {!collapsed && isActive(task.status) && (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={handleCancel}
            className="gap-1 text-caption text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Ban className="h-3 w-3" />
            停止维护
          </Button>
        </div>
      )}
    </div>
  );
}

function StepRow({ step, highlighted }: { step: MaintenanceStep; highlighted: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md px-1.5 py-1",
        highlighted && "bg-primary/5",
      )}
    >
      <StepStatusIcon status={step.status} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-micro",
          step.status === "skipped" || step.status === "cancelled"
            ? "text-muted-foreground/70 line-through"
            : "text-foreground",
        )}
        title={step.title}
      >
        {step.title}
      </span>
      {step.kind === "verify" && (
        <span className="shrink-0 rounded border border-info/40 bg-info/10 px-1 py-px text-micro text-info-strong">
          复检
        </span>
      )}
      {step.exitCode != null && step.status !== "succeeded" && (
        <span className="shrink-0 text-micro text-muted-foreground">
          exit {step.exitCode}
        </span>
      )}
      {step.durationMs != null && (
        <span className="shrink-0 text-micro text-muted-foreground/70">
          {formatDuration(step.durationMs)}
        </span>
      )}
    </div>
  );
}
