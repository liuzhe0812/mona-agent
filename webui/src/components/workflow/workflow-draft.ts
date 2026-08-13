/** Client-side workflow draft validation (multi-agent phase 3).
 *
 * Mirrors ``mona/agent/workflow.py`` checks so the editor rejects broken
 * drafts before they reach the server: unique ids, existing deps, no cycles,
 * room membership, required fields per step type, at least one agent step.
 * The server remains the authority — these checks only drive editor UX.
 */

import type { WorkflowStep } from "@/lib/types";

export type DraftErrorCode =
  | "empty"
  | "noAgentStep"
  | "duplicateId"
  | "invalidId"
  | "missingAgent"
  | "nonMember"
  | "missingTask"
  | "missingMessage"
  | "unknownDep"
  | "selfDep"
  | "cycle";

export interface DraftError {
  code: DraftErrorCode;
  stepId?: string;
  detail?: string;
}

const STEP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Order steps into parallel-ready layers (a step joins the earliest layer
 *  after its deps — same semantics as the backend ``execution_layers``).
 *  Throws on unknown dep / self-dep / cycle; callers normally run
 *  ``validateWorkflowDraft`` first and only layer valid drafts. */
export function executionLayers(steps: WorkflowStep[]): string[][] {
  const ids = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (dep === step.id) {
        throw new Error(`step ${step.id} depends on itself`);
      }
      if (!ids.has(dep)) {
        throw new Error(`step ${step.id} depends on unknown step ${dep}`);
      }
    }
  }
  const layers: string[][] = [];
  const layerOf = new Map<string, number>();
  let resolved = 0;
  while (resolved < steps.length) {
    const index = layers.length;
    const ready = steps.filter(
      (s) =>
        !layerOf.has(s.id) &&
        (s.dependsOn ?? []).every((d) => layerOf.has(d)),
    );
    if (ready.length === 0) {
      throw new Error("workflow contains a dependency cycle");
    }
    const layer: string[] = [];
    for (const step of ready) {
      layerOf.set(step.id, index);
      layer.push(step.id);
    }
    layers.push(layer);
    resolved += ready.length;
  }
  return layers;
}

/** Validate a draft against the same rules the server enforces. */
export function validateWorkflowDraft(
  steps: WorkflowStep[],
  memberIds: readonly string[],
): DraftError[] {
  const errors: DraftError[] = [];
  if (steps.length === 0) {
    return [{ code: "empty" }];
  }
  const seen = new Set<string>();
  let agentSteps = 0;
  for (const step of steps) {
    if (!step.id || !STEP_ID_PATTERN.test(step.id)) {
      errors.push({ code: "invalidId", stepId: step.id });
    } else if (seen.has(step.id)) {
      errors.push({ code: "duplicateId", stepId: step.id });
    } else {
      seen.add(step.id);
    }
    if (step.type === "agent") {
      agentSteps += 1;
      if (!step.agentId) {
        errors.push({ code: "missingAgent", stepId: step.id });
      } else if (!memberIds.includes(step.agentId)) {
        errors.push({ code: "nonMember", stepId: step.id, detail: step.agentId });
      }
      if (!step.task?.trim()) {
        errors.push({ code: "missingTask", stepId: step.id });
      }
    } else if (!step.message?.trim()) {
      errors.push({ code: "missingMessage", stepId: step.id });
    }
  }
  if (agentSteps === 0) {
    errors.push({ code: "noAgentStep" });
  }
  const ids = new Set(steps.map((s) => s.id));
  let structuralError = false;
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (dep === step.id) {
        errors.push({ code: "selfDep", stepId: step.id });
        structuralError = true;
      } else if (!ids.has(dep)) {
        errors.push({ code: "unknownDep", stepId: step.id, detail: dep });
        structuralError = true;
      }
    }
  }
  // Cycle detection only makes sense once every dep resolves.
  if (!structuralError && !errors.some((e) => e.code === "duplicateId" || e.code === "invalidId")) {
    try {
      executionLayers(steps);
    } catch {
      errors.push({ code: "cycle" });
    }
  }
  return errors;
}

/** Next available ``step-N`` id for the editor's add action: the first
 *  gap is filled so renumbered steps stay compact after removals. */
export function nextStepId(existing: readonly WorkflowStep[]): string {
  const used = new Set(existing.map((s) => s.id));
  let n = 1;
  while (used.has(`step-${n}`)) {
    n += 1;
  }
  return `step-${n}`;
}
