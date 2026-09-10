import { useEffect, useState } from "react";
import { ChevronRight, Play, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AgentIdentity } from "@/components/room/AgentAvatar";
import { Button } from "@/components/ui/button";
import { WorkflowCanvasDialog } from "@/components/workflow/WorkflowCanvasDialog";
import { showNotification } from "@/lib/tauri";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/types";
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

/** Compact secondary workflow entry for the room sidebar. */
export function WorkflowPanel({ chatId, members, className }: WorkflowPanelProps) {
  const { t } = useTranslation();
  const { client } = useClient();
  const [state, setState] = useState<WorkflowState | null>(null);
  const [editing, setEditing] = useState<{ goal: string; steps: WorkflowStep[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setState(null);
    setEditing(null);
    setError(null);
    let cancelled = false;
    client.getWorkflow(chatId)
      .then((next) => { if (!cancelled) setState(next); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [client, chatId]);

  useEffect(
    () => client.onWorkflowUpdated((updatedChatId, payload) => {
      if (updatedChatId !== chatId) return;
      setState((previous) => {
        const base = previous ?? { draft: null, active: null, activeRevision: null };
        return payload.draft
          ? { ...base, draft: payload.workflow }
          : {
              ...base,
              draft: null,
              active: payload.workflow,
              activeRevision: payload.activeRevision ?? payload.workflow.revision,
            };
      });
    }),
    [client, chatId],
  );

  useEffect(
    () => client.onApprovalRequested((payload) => {
      if (payload.chatId !== chatId || payload.approvals.length === 0) return;
      void showNotification({
        id: `workflow-approval-${payload.runId}`,
        title: t("room.workflow.approval.notifyTitle"),
        body: payload.approvals[0].message || t("room.workflow.approval.notifyBody"),
        icon: "warning",
      }).catch(() => {});
    }),
    [client, chatId, t],
  );

  const runCommand = async (command: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await command();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = (goal: string, steps: WorkflowStep[]) => {
    void runCommand(async () => {
      await client.saveWorkflowDraft(chatId, goal, steps);
      setEditing(null);
    });
  };

  const active = state?.active ?? null;
  const draft = state?.draft ?? null;
  const editable = draft ?? active;
  const label = draft
    ? t("room.workflow.compactDraft", { count: draft.steps.length })
    : active
      ? t("room.workflow.compactActive", { count: active.steps.length })
      : t("room.workflow.compactEmpty");

  return (
    <div className={className}>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => setEditing({ goal: editable?.goal ?? "", steps: editable?.steps ?? [] })}
          className="h-9 min-w-0 flex-1 justify-start gap-2 px-2 text-caption font-normal text-muted-foreground hover:text-foreground"
        >
          <Workflow className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0" />
        </Button>
        {draft ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void runCommand(() => client.activateWorkflow(chatId))}
            className="h-8 px-2 text-caption"
          >
            {t("room.workflow.activate")}
          </Button>
        ) : active ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void runCommand(() => client.runWorkflow(chatId))}
            className="h-8 gap-1 px-2 text-caption"
          >
            <Play className="h-3 w-3" />
            {t("room.workflow.runAction")}
          </Button>
        ) : null}
      </div>
      {error ? <p className="mt-1 text-caption text-destructive">{error}</p> : null}
      {editing ? (
        <WorkflowCanvasDialog
          open
          members={members}
          initialGoal={editing.goal}
          initialSteps={editing.steps}
          saving={busy}
          onSave={handleSave}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
