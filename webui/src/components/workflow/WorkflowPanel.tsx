import { useEffect, useState } from "react";
import { Play, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AgentIdentity } from "@/components/room/AgentAvatar";
import { WorkflowEditor } from "@/components/workflow/WorkflowEditor";
import { WorkflowRunCard } from "@/components/workflow/WorkflowRunCard";
import { Button } from "@/components/ui/button";
import { RoomCommandError } from "@/lib/mona-client";
import { showNotification } from "@/lib/tauri";
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStep,
} from "@/lib/types";
import { useClient } from "@/providers/ClientProvider";

interface WorkflowPanelProps {
  chatId: string;
  members: AgentIdentity[];
  className?: string;
}

interface WorkflowState {
  draft: WorkflowDefinition | null;
  active: WorkflowDefinition | null;
  activeRevision: number | null;
}

const NON_TERMINAL_RUNS: ReadonlySet<WorkflowRunStatus> = new Set([
  "queued",
  "running",
  "waiting_approval",
]);

/** Room-panel workflow block (phase 3): active revision + run controls, the
 *  current draft, the latest run card, and the step-card draft editor.
 *  Drafts proposed by the ``propose_workflow`` tool arrive as
 *  ``workflow_updated`` pushes and land in the draft section for review. */
export function WorkflowPanel({ chatId, members, className }: WorkflowPanelProps) {
  const { t } = useTranslation();
  const { client } = useClient();
  const [state, setState] = useState<WorkflowState | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [editing, setEditing] = useState<{
    goal: string;
    steps: WorkflowStep[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvingStep, setResolvingStep] = useState<string | null>(null);

  useEffect(() => {
    setState(null);
    setRun(null);
    setEditing(null);
    setError(null);
    let cancelled = false;
    client
      .getWorkflow(chatId)
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => {});
    client
      .getWorkflowRun(chatId)
      .then((latest) => {
        if (!cancelled) setRun(latest);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, chatId]);

  useEffect(
    () =>
      client.onWorkflowUpdated((updatedChatId, payload) => {
        if (updatedChatId !== chatId) return;
        setState((prev) => {
          const base = prev ?? { draft: null, active: null, activeRevision: null };
          return payload.draft
            ? { ...base, draft: payload.workflow }
            : {
                ...base,
                draft: null,
                active: payload.workflow,
                activeRevision:
                  payload.activeRevision ?? payload.workflow.revision,
              };
        });
      }),
    [client, chatId],
  );

  useEffect(
    () =>
      client.onWorkflowRunUpdated((updatedChatId, nextRun) => {
        if (updatedChatId === chatId) setRun(nextRun);
      }),
    [client, chatId],
  );

  useEffect(
    () =>
      client.onApprovalRequested((payload) => {
        if (payload.chatId !== chatId || payload.approvals.length === 0) {
          return;
        }
        void showNotification({
          id: `workflow-approval-${payload.runId}`,
          title: t("room.workflow.approval.notifyTitle"),
          body:
            payload.approvals[0].message ||
            t("room.workflow.approval.notifyBody"),
          icon: "warning",
        }).catch(() => {});
      }),
    [client, chatId, t],
  );

  const handleResolveApproval = (stepId: string, approve: boolean) => {
    if (!run) return;
    const token = run.steps[stepId]?.approvalToken;
    if (!token) return;
    setResolvingStep(stepId);
    setError(null);
    client
      .resolveWorkflowApproval(chatId, run.id, stepId, token, approve)
      .catch((err) => {
        const code = err instanceof RoomCommandError ? err.code : undefined;
        setError(
          code
            ? t(`room.workflow.approval.error.${code}`, {
                defaultValue: err.message,
              })
            : err instanceof Error
              ? err.message
              : String(err),
        );
      })
      .finally(() => setResolvingStep(null));
  };

  const runCommand = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = (goal: string, steps: WorkflowStep[]) =>
    runCommand(async () => {
      await client.saveWorkflowDraft(chatId, goal, steps);
      setEditing(null);
    });

  const active = state?.active ?? null;
  const draft = state?.draft ?? null;
  const runActive = run != null && NON_TERMINAL_RUNS.has(run.status);

  return (
    <div className={className}>
      {error ? (
        <p className="mb-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
      {editing ? (
        <WorkflowEditor
          members={members}
          initialGoal={editing.goal}
          initialSteps={editing.steps}
          saving={busy}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <div className="space-y-2">
          {active ? (
            <div className="rounded-lg border border-border/60 p-2">
              <div className="flex items-center gap-1.5">
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                  {t("room.workflow.active")}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {t("room.workflow.revision", { revision: active.revision })}
                </span>
                <div className="flex-1" />
                <Button
                  type="button"
                  size="sm"
                  disabled={busy || runActive}
                  onClick={() => runCommand(() => client.runWorkflow(chatId))}
                  className="h-6 px-2 text-[11px]"
                >
                  <Play className="mr-1 h-3 w-3" />
                  {t("room.workflow.run")}
                </Button>
              </div>
              {active.goal ? (
                <p className="mt-1 line-clamp-2 text-[12px] text-foreground/90">
                  {active.goal}
                </p>
              ) : null}
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("room.workflow.stepsCount", { count: active.steps.length })}
              </p>
            </div>
          ) : null}

          {draft ? (
            <div className="rounded-lg border border-dashed border-border p-2">
              <div className="flex items-center gap-1.5">
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {t("room.workflow.draft")}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {t("room.workflow.revision", { revision: draft.revision })}
                </span>
                <div className="flex-1" />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    setEditing({ goal: draft.goal, steps: draft.steps })
                  }
                  className="h-6 px-2 text-[11px]"
                >
                  {t("room.workflow.edit")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    runCommand(() => client.activateWorkflow(chatId))
                  }
                  className="h-6 px-2 text-[11px]"
                >
                  {t("room.workflow.activate")}
                </Button>
              </div>
              {draft.goal ? (
                <p className="mt-1 line-clamp-2 text-[12px] text-foreground/90">
                  {draft.goal}
                </p>
              ) : null}
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("room.workflow.stepsCount", { count: draft.steps.length })}
              </p>
            </div>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                setEditing({
                  goal: active?.goal ?? "",
                  steps: active?.steps ?? [],
                })
              }
              className="w-full"
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {active ? t("room.workflow.editNewVersion") : t("room.workflow.new")}
            </Button>
          )}

          {!active && !draft ? (
            <div>
              <p className="text-[13px] leading-relaxed text-muted-foreground/70">
                {t("room.workflow.empty")}
              </p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/60">
                {t("room.workflow.hint")}
              </p>
            </div>
          ) : null}

          {run ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                {t("room.workflow.run.title")}
              </div>
              <WorkflowRunCard
                run={run}
                members={members}
                cancelling={busy}
                resolvingStep={resolvingStep}
                onCancel={() =>
                  runCommand(() => client.cancelWorkflowRun(chatId, run.id))
                }
                onResolveApproval={handleResolveApproval}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
