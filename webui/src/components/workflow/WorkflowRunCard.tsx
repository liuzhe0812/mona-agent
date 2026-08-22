import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
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
import { StepActivityTrace } from "@/components/workflow/StepActivityTrace";
import { executionLayers } from "@/components/workflow/workflow-draft";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  ToolProgressEvent,
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
  /** Live tool activity streamed while steps run, keyed ``runId:stepId``. */
  stepActivities?: Record<string, ToolProgressEvent[]>;
  onCancel: () => void;
  onResolveApproval?: (stepId: string, approve: boolean) => void;
  onRetryStep?: (stepId: string) => void;
  onCancelStep?: (stepId: string, jobId: string) => void;
  retryingStep?: string | null;
  cancellingStep?: string | null;
}

/** Compact run card: status chip + cancel action, then one row per step in
 *  dependency order. Clicking a row expands its detail inline — the live
 *  tool trail, the full error, the output summary, or the approval actions. */
export function WorkflowRunCard({
  run,
  members,
  cancelling,
  resolvingStep = null,
  stepActivities,
  onCancel,
  onResolveApproval,
  onRetryStep,
  onCancelStep,
  retryingStep = null,
  cancellingStep = null,
}: WorkflowRunCardProps) {
  const { t } = useTranslation();
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const memberNames = new Map(members.map((m) => [m.id, m.displayName]));
  const stepMap = new Map(run.workflow.steps.map((s) => [s.id, s]));

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-2">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            RUN_STATUS_CLASSES[run.status],
          )}
        >
          {t(`room.workflow.run.status.${run.status}`)}
        </span>
        <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
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

      <ol className="mt-1.5 space-y-0.5">
        {orderedStepIds(run).map((stepId) => {
          const step = stepMap.get(stepId);
          if (!step) return null;
          const stepRun = run.steps[stepId];
          const status = stepRun?.status ?? "queued";
          const agentId = step.agentId ?? "";
          const expanded = expandedStepId === stepId;
          return (
            <li key={stepId} className="rounded-md bg-background">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedStepId(expanded ? null : stepId)}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/60"
              >
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
                <span className="shrink-0 whitespace-nowrap font-mono text-[11px] font-medium">
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
                {expanded ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                )}
              </button>

              {expanded ? (
                <div className="border-t border-border/45 px-2 py-1.5">
                  {(() => {
                    const liveEvents = stepActivities?.[`${run.id}:${stepId}`];
                    return liveEvents && liveEvents.length > 0 ? (
                      <div className="mb-1.5">
                        <StepActivityTrace events={liveEvents} />
                      </div>
                    ) : null;
                  })()}
                  {stepRun?.error ? (
                    <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-destructive">
                      {stepRun.error}
                    </p>
                  ) : null}
                  {status === "succeeded" && stepRun?.output?.summary ? (
                    <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
                      {stepRun.output.summary}
                    </p>
                  ) : null}
                  {stepRun?.approvalDecision ? (
                    <p className="text-[10px] text-muted-foreground">
                      {t(
                        `room.workflow.approval.decision.${stepRun.approvalDecision}`,
                        { by: stepRun.approvalResolvedBy ?? "user" },
                      )}
                    </p>
                  ) : null}
                  {status === "failed" &&
                  step.type === "agent" &&
                  onRetryStep ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={retryingStep === stepId}
                      onClick={() => onRetryStep(stepId)}
                      aria-label={t("room.workflow.run.retryStep")}
                      className="mt-1 h-6 px-2 text-[11px]"
                    >
                      {t("room.workflow.run.retryStep")}
                    </Button>
                  ) : null}
                  {status === "running" &&
                  step.type === "agent" &&
                  stepRun?.jobId &&
                  onCancelStep ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={cancellingStep === stepId}
                      onClick={() => onCancelStep(stepId, stepRun.jobId as string)}
                      aria-label={t("room.workflow.run.cancelStep")}
                      className="mt-1 h-6 px-2 text-[11px]"
                    >
                      {t("room.workflow.run.cancelStep")}
                    </Button>
                  ) : null}
                  {status === "waiting_approval" && onResolveApproval ? (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-1.5 py-1">
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
                          className="h-6 px-2 text-[11px]"
                        >
                          {t("room.workflow.approval.approve")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={resolvingStep === stepId}
                          onClick={() => onResolveApproval(stepId, false)}
                          className="h-6 px-2 text-[11px]"
                        >
                          {t("room.workflow.approval.reject")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {!stepRun?.error &&
                  !(status === "succeeded" && stepRun?.output?.summary) &&
                  !stepRun?.approvalDecision &&
                  status !== "waiting_approval" ? (
                    <p className="text-[11px] text-muted-foreground/70">
                      {t(`room.workflow.run.stepStatus.${status}`)}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
