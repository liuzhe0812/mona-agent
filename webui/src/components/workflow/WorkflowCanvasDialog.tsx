import { useMemo, useState } from "react";
import { Bot, LayoutGrid, Trash2, UserCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AgentAvatar, type AgentIdentity } from "@/components/room/AgentAvatar";
import { WorkflowCanvas } from "@/components/workflow/WorkflowCanvas";
import {
  WORKFLOW_NODE_WIDTH,
  withoutStep,
} from "@/components/workflow/workflow-canvas";
import {
  nextStepId,
  validateWorkflowDraft,
} from "@/components/workflow/workflow-draft";
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
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WorkflowStep } from "@/lib/types";

interface WorkflowCanvasDialogProps {
  open: boolean;
  members: AgentIdentity[];
  initialGoal: string;
  initialSteps: WorkflowStep[];
  saving: boolean;
  onSave: (goal: string, steps: WorkflowStep[]) => void;
  onClose: () => void;
}

/** Full-screen canvas editor for a room workflow draft: node palette on the
 *  left, React Flow canvas in the middle, selected-step config on the right
 *  (Dify/Coze-style). Dependencies are drawn as edges; positions persist on
 *  the step so the saved draft reopens with the same layout. */
export function WorkflowCanvasDialog({
  open,
  members,
  initialGoal,
  initialSteps,
  saving,
  onSave,
  onClose,
}: WorkflowCanvasDialogProps) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState(initialGoal);
  const [steps, setSteps] = useState<WorkflowStep[]>(initialSteps);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [layoutNonce, setLayoutNonce] = useState(0);

  const dirty = goal !== initialGoal || steps !== initialSteps;
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);
  const errors = useMemo(
    () => validateWorkflowDraft(steps, memberIds),
    [steps, memberIds],
  );
  const agentNameOf = useMemo(() => {
    const names = new Map(members.map((m) => [m.id, m.displayName]));
    return (agentId: string | null | undefined) =>
      (agentId && names.get(agentId)) || agentId || "";
  }, [members]);

  const selected = steps.find((s) => s.id === selectedId) ?? null;

  const patchStep = (id: string, patch: Partial<WorkflowStep>) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  /** Place a new node right of the rightmost existing one so it never
   *  spawns on top of the current graph. */
  const nextSpawnPosition = (): { x: number; y: number } => {
    let maxX = 0;
    let ySum = 0;
    for (const step of steps) {
      if (step.position) {
        maxX = Math.max(maxX, step.position.x);
        ySum += step.position.y;
      }
    }
    const centerY = steps.length > 0 ? ySum / steps.length : 0;
    return {
      x: steps.length > 0 ? maxX + WORKFLOW_NODE_WIDTH + 96 : 0,
      y: centerY,
    };
  };

  const addAgentStep = (agentId: string) => {
    const id = nextStepId(steps);
    setSteps((prev) => {
      const predecessor = prev[prev.length - 1];
      return [
        ...prev,
        {
          id,
          type: "agent",
          agentId,
          task: "",
          expectedOutput: "",
          dependsOn: predecessor ? [predecessor.id] : [],
          position: nextSpawnPosition(),
        },
      ];
    });
    setSelectedId(id);
  };

  const addApprovalStep = () => {
    const id = nextStepId(steps);
    setSteps((prev) => {
      const predecessor = prev[prev.length - 1];
      return [
        ...prev,
        {
          id,
          type: "approval",
          message: "",
          dependsOn: predecessor ? [predecessor.id] : [],
          position: nextSpawnPosition(),
        },
      ];
    });
    setSelectedId(id);
  };

  const autoLayout = () => {
    setSteps((prev) => prev.map((s) => ({ ...s, position: null })));
    // Force a canvas remount so fitView recentres on the fresh layout.
    setLayoutNonce((n) => n + 1);
  };

  const handleClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  const agentOptions = members.map((m) => ({ value: m.id, label: m.displayName }));

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) handleClose(); }}>
      <DialogContent
        className="flex h-[88vh] w-[94vw] max-w-[1200px] flex-col gap-0 overflow-hidden p-0"
        aria-label={t("room.panel.workflow")}
        aria-describedby={undefined}
      >
        {/* Header: goal + actions */}
        <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5">
          <DialogTitle className="shrink-0 text-sm font-medium">
            {t("room.panel.workflow")}
          </DialogTitle>
          <Input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder={t("room.workflow.editor.goalPlaceholder")}
            aria-label={t("room.workflow.editor.goal")}
            className="h-8 flex-1"
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={autoLayout}
            title={t("room.workflow.canvas.autoLayout")}
            className="gap-1.5"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            {t("room.workflow.canvas.autoLayout")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={handleClose}
          >
            {t("room.workflow.editor.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || errors.length > 0}
            onClick={() => onSave(goal, steps)}
          >
            {t("room.workflow.editor.save")}
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Node palette */}
          <div className="flex w-48 shrink-0 flex-col border-r border-border/45">
            <div className="px-3 pb-1.5 pt-3 text-xs font-medium text-muted-foreground">
              {t("room.workflow.canvas.members")}
            </div>
            <div className="scrollbar-hover min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
              {members.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => addAgentStep(member.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                >
                  <AgentAvatar
                    agentId={member.id}
                    displayName={member.displayName}
                    className="h-6 w-6"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                    {member.displayName}
                  </span>
                  <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              ))}
              <button
                type="button"
                onClick={addApprovalStep}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/10">
                  <UserCheck className="h-3.5 w-3.5 text-amber-500" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                  {t("room.workflow.editor.typeApproval")}
                </span>
              </button>
            </div>
          </div>

          {/* Canvas */}
          <div className="min-w-0 flex-1 bg-muted/20">
            {steps.length === 0 ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted-foreground">
                {t("room.workflow.canvas.emptyHint")}
              </div>
            ) : (
              <WorkflowCanvas
                key={layoutNonce}
                steps={steps}
                agentNameOf={agentNameOf}
                mode="edit"
                selectedStepId={selectedId}
                onSelectStep={setSelectedId}
                onChange={setSteps}
              />
            )}
          </div>

          {/* Step config */}
          <div className="flex w-64 shrink-0 flex-col border-l border-border/45">
            <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3 text-xs font-medium text-muted-foreground">
              {t("room.workflow.canvas.config")}
              <div className="flex-1" />
              {selected ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setSteps((prev) => withoutStep(prev, selected.id));
                    setSelectedId(null);
                  }}
                  title={t("room.workflow.editor.remove")}
                  aria-label={t("room.workflow.editor.remove")}
                  className="h-6 w-6 text-muted-foreground"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              ) : null}
            </div>
            <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {selected ? (
                <div className="space-y-2.5">
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {t("room.workflow.editor.stepId")}
                    </label>
                    <Input
                      value={selected.id}
                      onChange={(e) => {
                        const nextId = e.target.value;
                        const prevId = selected.id;
                        setSteps((prev) =>
                          prev.map((s) => ({
                            ...s,
                            id: s.id === prevId ? nextId : s.id,
                            dependsOn: (s.dependsOn ?? []).map((d) =>
                              d === prevId ? nextId : d,
                            ),
                          })),
                        );
                        setSelectedId(nextId);
                      }}
                      aria-label={t("room.workflow.editor.stepId")}
                      className="mt-1 h-7 font-mono text-[12px]"
                    />
                  </div>
                  {selected.type === "agent" ? (
                    <>
                      <div>
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t("room.workflow.editor.agent")}
                        </label>
                        <div className="mt-1">
                          <Select
                            value={selected.agentId ?? ""}
                            onValueChange={(value) =>
                              patchStep(selected.id, { agentId: value })
                            }
                            options={agentOptions}
                            placeholder={t("room.workflow.editor.agent")}
                            aria-label={t("room.workflow.editor.agent")}
                          />
                        </div>
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t("room.workflow.editor.task")}
                        </label>
                        <Textarea
                          value={selected.task ?? ""}
                          onChange={(e) =>
                            patchStep(selected.id, { task: e.target.value })
                          }
                          placeholder={t("room.workflow.editor.taskPlaceholder")}
                          aria-label={t("room.workflow.editor.task")}
                          className="mt-1 min-h-[72px]"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] font-medium text-muted-foreground">
                          {t("room.workflow.editor.expectedOutput")}
                        </label>
                        <Input
                          value={selected.expectedOutput ?? ""}
                          onChange={(e) =>
                            patchStep(selected.id, {
                              expectedOutput: e.target.value,
                            })
                          }
                          placeholder={t("room.workflow.editor.expectedOutput")}
                          aria-label={t("room.workflow.editor.expectedOutput")}
                          className="mt-1 h-7 text-[12px]"
                        />
                      </div>
                    </>
                  ) : (
                    <div>
                      <label className="text-[11px] font-medium text-muted-foreground">
                        {t("room.workflow.editor.message")}
                      </label>
                      <Textarea
                        value={selected.message ?? ""}
                        onChange={(e) =>
                          patchStep(selected.id, { message: e.target.value })
                        }
                        placeholder={t("room.workflow.editor.messagePlaceholder")}
                        aria-label={t("room.workflow.editor.message")}
                        className="mt-1 min-h-[72px]"
                      />
                    </div>
                  )}
                  <div>
                    <label className="text-[11px] font-medium text-muted-foreground">
                      {t("room.workflow.editor.dependsOn")}
                    </label>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(selected.dependsOn ?? []).length === 0 ? (
                        <span className="text-[11px] text-muted-foreground/70">
                          —
                        </span>
                      ) : (
                        (selected.dependsOn ?? []).map((dep) => (
                          <span
                            key={dep}
                            className="rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {dep}
                          </span>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="pt-2 text-[12px] leading-relaxed text-muted-foreground/80">
                  {t("room.workflow.canvas.selectNode")}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Validation errors */}
        {errors.length > 0 ? (
          <div className="border-t border-destructive/40 bg-destructive/5 px-4 py-1.5">
            <ul className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-destructive">
              {errors.map((error, i) => (
                <li key={i}>
                  {t(`room.workflow.errors.${error.code}`, {
                    step: error.stepId,
                    detail: error.detail,
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("room.workflow.editor.discardTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("room.workflow.editor.discardBody")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("room.workflow.editor.keepEditing")}
              </AlertDialogCancel>
              <AlertDialogAction onClick={onClose}>
                {t("room.workflow.editor.discardConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
