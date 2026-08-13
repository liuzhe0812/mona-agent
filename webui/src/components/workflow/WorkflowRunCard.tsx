import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Loader2,
  UserCheck,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  AgentAvatar,
  fallbackAgentName,
  type AgentIdentity,
} from "@/components/room/AgentAvatar";
import { executionLayers } from "@/components/workflow/workflow-draft";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepStatus,
} from "@/lib/types";

const NON_TERMINAL_RUNS: ReadonlySet<WorkflowRunStatus> = new Set([
  "queued",
  "running",
  "waiting_approval",
]);

const RUN_STATUS_CLASSES: Record<WorkflowRunStatus, string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-primary/10 text-primary",
  waiting_approval: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  succeeded: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};

function StepStatusIcon({ status }: { status: WorkflowStepStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
    case "waiting_approval":
      return <UserCheck className="h-3.5 w-3.5 text-amber-500" />;
    case "succeeded":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-destructive" />;
    case "cancelled":
    case "skipped":
      return <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />;
    default:
      return <CircleDashed className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

/** Step display order: dependency layers of the run's workflow snapshot. */
function orderedStepIds(run: WorkflowRun): string[] {
  try {
    return executionLayers(run.workflow.steps).flat();
  } catch {
    return run.workflow.steps.map((s) => s.id);
  }
}

interface WorkflowRunCardProps {
  run: WorkflowRun;
  members: AgentIdentity[];
  cancelling: boolean;
  /** Step id whose approval is being resolved (disables its buttons). */
  resolvingStep?: string | null;
  onCancel: () => void;
  onResolveApproval?: (stepId: string, approve: boolean) => void;
}

/** Compact run card for the room panel (phase 3): run status chip, cancel
 *  action while non-terminal, and per-step status rows in dependency order. */
export function WorkflowRunCard({
  run,
  members,
  cancelling,
  resolvingStep = null,
  onCancel,
  onResolveApproval,
}: WorkflowRunCardProps) {
  const { t } = useTranslation();
  const memberNames = new Map(members.map((m) => [m.id, m.displayName]));
  const stepMap = new Map(run.workflow.steps.map((s) => [s.id, s]));
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-2">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            RUN_STATUS_CLASSES[run.status],
          )}
        >
          {t(`room.workflow.run.status.${run.status}`)}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {t("room.workflow.run.revision", { revision: run.workflowRevision })}
        </span>
        <div className="flex-1" />
        {NON_TERMINAL_RUNS.has(run.status) ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={cancelling}
            onClick={onCancel}
            className="h-6 px-2 text-[11px]"
          >
            {t("room.workflow.cancelRun")}
          </Button>
        ) : null}
      </div>
      <ol className="mt-1.5 space-y-1">
        {orderedStepIds(run).map((stepId) => {
          const step = stepMap.get(stepId);
          if (!step) return null;
          const stepRun = run.steps[stepId];
          const status = stepRun?.status ?? "queued";
          const agentId = step.agentId ?? "";
          return (
            <li key={stepId} className="rounded-md bg-background px-1.5 py-1">
              <div className="flex items-center gap-1.5">
                <StepStatusIcon status={status} />
                {step.type === "agent" ? (
                  <AgentAvatar
                    agentId={agentId}
                    displayName={memberNames.get(agentId)}
                    className="h-4 w-4"
                  />
                ) : (
                  <UserCheck className="h-3.5 w-3.5 text-amber-500" />
                )}
                <span className="truncate font-mono text-[11px] font-medium">
                  {step.id}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {step.type === "agent"
                    ? (memberNames.get(agentId) ?? fallbackAgentName(agentId))
                    : t("room.workflow.run.approval")}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {t(`room.workflow.run.stepStatus.${status}`)}
                </span>
              </div>
              {stepRun?.error ? (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-destructive">
                  {stepRun.error}
                </p>
              ) : null}
              {status === "succeeded" && stepRun?.output?.summary ? (
                <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                  {stepRun.output.summary}
                </p>
              ) : null}
              {stepRun?.approvalDecision ? (
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  {t(
                    `room.workflow.approval.decision.${stepRun.approvalDecision}`,
                    { by: stepRun.approvalResolvedBy ?? "user" },
                  )}
                </p>
              ) : null}
              {status === "waiting_approval" && onResolveApproval ? (
                <div className="mt-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-1.5 py-1">
                  {step.message ? (
                    <p className="text-[11px] leading-relaxed text-foreground/90">
                      {step.message}
                    </p>
                  ) : null}
                  <div className="mt-1 flex gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={resolvingStep === stepId}
                      onClick={() => onResolveApproval(stepId, true)}
                      className="h-6 flex-1 px-2 text-[11px]"
                    >
                      {t("room.workflow.approval.approve")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={resolvingStep === stepId}
                      onClick={() => onResolveApproval(stepId, false)}
                      className="h-6 flex-1 px-2 text-[11px]"
                    >
                      {t("room.workflow.approval.reject")}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
