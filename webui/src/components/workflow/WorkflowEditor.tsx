import { useMemo, useState } from "react";
import { Bot, Trash2, UserCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { AgentIdentity } from "@/components/room/AgentAvatar";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { WorkflowStep } from "@/lib/types";

interface WorkflowEditorProps {
  /** Room members selectable as step agents. */
  members: AgentIdentity[];
  initialGoal: string;
  initialSteps: WorkflowStep[];
  saving: boolean;
  onSave: (goal: string, steps: WorkflowStep[]) => void;
  onCancel: () => void;
}

/** Vertical step-card editor for a room workflow draft (phase 3). Steps are
 *  listed top-down; execution order comes from ``dependsOn`` edges, validated
 *  live (unique ids, resolvable deps, no cycles, member agents). */
export function WorkflowEditor({
  members,
  initialGoal,
  initialSteps,
  saving,
  onSave,
  onCancel,
}: WorkflowEditorProps) {
  const { t } = useTranslation();
  const [goal, setGoal] = useState(initialGoal);
  const [steps, setSteps] = useState<WorkflowStep[]>(initialSteps);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const dirty = goal !== initialGoal || steps !== initialSteps;
  const memberIds = useMemo(() => members.map((m) => m.id), [members]);
  const errors = useMemo(
    () => validateWorkflowDraft(steps, memberIds),
    [steps, memberIds],
  );

  const updateStep = (index: number, patch: Partial<WorkflowStep>) => {
    setSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  };

  const removeStep = (index: number) => {
    setSteps((prev) => {
      const removed = prev[index];
      return prev
        .filter((_, i) => i !== index)
        .map((step) => ({
          ...step,
          dependsOn: (step.dependsOn ?? []).filter((d) => d !== removed.id),
        }));
    });
  };

  const addStep = (type: WorkflowStep["type"]) => {
    setSteps((prev) => {
      const id = nextStepId(prev);
      // Default to a serial chain: the new step depends on the previous one.
      const dependsOn = prev.length > 0 ? [prev[prev.length - 1].id] : [];
      const step: WorkflowStep =
        type === "agent"
          ? { id, type, agentId: null, task: "", expectedOutput: "", dependsOn }
          : { id, type, message: "", dependsOn };
      return [...prev, step];
    });
  };

  const toggleDep = (index: number, depId: string, checked: boolean) => {
    setSteps((prev) =>
      prev.map((step, i) => {
        if (i !== index) return step;
        const deps = new Set(step.dependsOn ?? []);
        if (checked) deps.add(depId);
        else deps.delete(depId);
        return { ...step, dependsOn: [...deps] };
      }),
    );
  };

  const handleCancel = () => {
    if (dirty) setConfirmDiscard(true);
    else onCancel();
  };

  const agentOptions = members.map((m) => ({ value: m.id, label: m.displayName }));
  const typeOptions = [
    { value: "agent", label: t("room.workflow.editor.typeAgent") },
    { value: "approval", label: t("room.workflow.editor.typeApproval") },
  ];

  return (
    <div className="space-y-2.5">
      <div>
        <label className="text-xs font-medium text-muted-foreground">
          {t("room.workflow.editor.goal")}
        </label>
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={t("room.workflow.editor.goalPlaceholder")}
          aria-label={t("room.workflow.editor.goal")}
          className="mt-1 min-h-[52px]"
        />
      </div>

      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li
            key={index}
            className="rounded-lg border border-border/60 bg-background p-2"
          >
            <div className="flex items-center gap-1.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                {index + 1}
              </span>
              <Input
                value={step.id}
                onChange={(e) => updateStep(index, { id: e.target.value })}
                aria-label={t("room.workflow.editor.stepId")}
                className="w-28 font-mono text-[12px]"
              />
              <div className="w-24">
                <Select
                  value={step.type}
                  onValueChange={(value) => {
                    const type = value as WorkflowStep["type"];
                    updateStep(
                      index,
                      type === "agent"
                        ? { type, message: undefined }
                        : {
                            type,
                            agentId: undefined,
                            task: undefined,
                            expectedOutput: undefined,
                          },
                    );
                  }}
                  options={typeOptions}
                  aria-label={t("room.workflow.editor.type")}
                />
              </div>
              <div className="flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeStep(index)}
                title={t("room.workflow.editor.remove")}
                aria-label={t("room.workflow.editor.remove")}
                className="h-6 w-6 text-muted-foreground"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            {step.type === "agent" ? (
              <div className="mt-2 space-y-1.5">
                <Select
                  value={step.agentId ?? ""}
                  onValueChange={(value) => updateStep(index, { agentId: value })}
                  options={agentOptions}
                  placeholder={t("room.workflow.editor.agent")}
                  aria-label={t("room.workflow.editor.agent")}
                />
                <Textarea
                  value={step.task ?? ""}
                  onChange={(e) => updateStep(index, { task: e.target.value })}
                  placeholder={t("room.workflow.editor.taskPlaceholder")}
                  aria-label={t("room.workflow.editor.task")}
                  className="min-h-[44px]"
                />
                <Input
                  value={step.expectedOutput ?? ""}
                  onChange={(e) =>
                    updateStep(index, { expectedOutput: e.target.value })
                  }
                  placeholder={t("room.workflow.editor.expectedOutput")}
                  aria-label={t("room.workflow.editor.expectedOutput")}
                />
              </div>
            ) : (
              <div className="mt-2">
                <Textarea
                  value={step.message ?? ""}
                  onChange={(e) => updateStep(index, { message: e.target.value })}
                  placeholder={t("room.workflow.editor.messagePlaceholder")}
                  aria-label={t("room.workflow.editor.message")}
                  className="min-h-[44px]"
                />
              </div>
            )}

            {steps.length > 1 ? (
              <div className="mt-2">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {t("room.workflow.editor.dependsOn")}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {steps.map((other, otherIndex) =>
                    otherIndex === index ? null : (
                      <label
                        key={otherIndex}
                        className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted-foreground"
                      >
                        <Checkbox
                          checked={(step.dependsOn ?? []).includes(other.id)}
                          onCheckedChange={(value) =>
                            toggleDep(index, other.id, value === true)
                          }
                          aria-label={other.id}
                          className="h-3.5 w-3.5"
                        />
                        {other.id}
                      </label>
                    ),
                  )}
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="flex gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => addStep("agent")}
          className="flex-1"
        >
          <Bot className="mr-1 h-3.5 w-3.5" />
          {t("room.workflow.editor.addAgent")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => addStep("approval")}
          className="flex-1"
        >
          <UserCheck className="mr-1 h-3.5 w-3.5" />
          {t("room.workflow.editor.addApproval")}
        </Button>
      </div>

      {errors.length > 0 ? (
        <ul className="space-y-0.5 rounded-lg border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive">
          {errors.map((error, i) => (
            <li key={i}>
              {t(`room.workflow.errors.${error.code}`, {
                step: error.stepId,
                detail: error.detail,
              })}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" size="sm" variant="ghost" onClick={handleCancel}>
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
            <AlertDialogAction onClick={onCancel}>
              {t("room.workflow.editor.discardConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
