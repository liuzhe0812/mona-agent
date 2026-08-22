import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  fallbackAgentName,
  resolveAgentDisplayName,
  type AgentIdentity,
} from "@/components/room/AgentAvatar";
import { useAgents } from "@/components/room/useAgents";
import { WorkflowRunCard } from "@/components/workflow/WorkflowRunCard";
import { useClientContextOrNull } from "@/providers/ClientProvider";
import type { ToolProgressEvent, WorkflowRun } from "@/lib/types";

interface WorkflowRunMessageProps {
  run: WorkflowRun;
  /** Live tool activity streamed while steps run, keyed ``runId:stepId``. */
  stepActivities?: Record<string, ToolProgressEvent[]>;
}

/** In-conversation workflow run card (IM group-chat parity): the run renders
 *  inside the room's message flow at the position it started, live-updating
 *  as ``workflow_run_updated`` frames merge into the message list. Actions
 *  (cancel / approval) reuse the room commands via the ambient client. */
export function WorkflowRunMessage({ run, stepActivities }: WorkflowRunMessageProps) {
  const { t } = useTranslation();
  const clientCtx = useClientContextOrNull();
  const client = clientCtx?.client ?? null;
  const agentsById = useAgents(clientCtx?.token ?? null);
  const [cancelling, setCancelling] = useState(false);
  const [retryingStep, setRetryingStep] = useState<string | null>(null);
  const [cancellingStep, setCancellingStep] = useState<string | null>(null);
  const [resolvingStep, setResolvingStep] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const members = useMemo<AgentIdentity[]>(() => {
    const ids = new Set<string>();
    for (const step of run.workflow.steps) {
      if (step.type === "agent" && step.agentId) ids.add(step.agentId);
    }
    return [...ids].map((id) => ({
      id,
      displayName:
        agentsById.size > 0
          ? resolveAgentDisplayName(agentsById, id)
          : fallbackAgentName(id),
    }));
  }, [run.workflow.steps, agentsById]);

  const handleCancel = () => {
    if (!client) return;
    setCancelling(true);
    setActionError(null);
    client
      .cancelWorkflowRun(run.roomId, run.id)
      .catch((err) =>
        setActionError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setCancelling(false));
  };

  const handleResolveApproval = (stepId: string, approve: boolean) => {
    if (!client) return;
    const token = run.steps[stepId]?.approvalToken;
    if (!token) return;
    setResolvingStep(stepId);
    setActionError(null);
    client
      .resolveWorkflowApproval(run.roomId, run.id, stepId, token, approve)
      .catch((err) =>
        setActionError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setResolvingStep(null));
  };

  const handleRetryStep = (stepId: string) => {
    if (!client || retryingStep) return;
    setRetryingStep(stepId);
    setActionError(null);
    client
      .retryWorkflowStep(run.roomId, run.id, stepId)
      .catch((err) =>
        setActionError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setRetryingStep(null));
  };

  const handleCancelStep = (stepId: string, jobId: string) => {
    if (!client || cancellingStep) return;
    setCancellingStep(stepId);
    setActionError(null);
    client
      .cancelAgentJob(run.roomId, jobId)
      .catch((err) =>
        setActionError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setCancellingStep(null));
  };

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
        {t("room.workflow.run.title")}
      </div>
      <WorkflowRunCard
        run={run}
        members={members}
        cancelling={cancelling}
        resolvingStep={resolvingStep}
        stepActivities={stepActivities}
        onCancel={handleCancel}
        onResolveApproval={client ? handleResolveApproval : undefined}
        onRetryStep={client ? handleRetryStep : undefined}
        onCancelStep={client ? handleCancelStep : undefined}
        retryingStep={retryingStep}
        cancellingStep={cancellingStep}
      />
      {actionError ? (
        <p className="mt-1 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
