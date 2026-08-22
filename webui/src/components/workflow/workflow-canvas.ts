/** Canvas mapping helpers for the room workflow editor (multi-agent).
 *
 * Converts between ``WorkflowStep[]`` (DAG: id + dependsOn) and React Flow
 * nodes/edges. Steps without a stored ``position`` are laid out with dagre
 * (left-to-right layers, same semantics as ``executionLayers``); dragging a
 * node writes its coordinates back into the step so the layout persists
 * with the draft.
 */

import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

import type { WorkflowStep, WorkflowStepRun } from "@/lib/types";

export const WORKFLOW_NODE_WIDTH = 216;
export const WORKFLOW_NODE_HEIGHT = 84;

export interface WorkflowNodeData extends Record<string, unknown> {
  step: WorkflowStep;
  agentName: string;
  /** Live per-step run state when the canvas renders a run (readonly). */
  runState?: WorkflowStepRun | null;
}

export type WorkflowFlowNode = Node<WorkflowNodeData, "workflowStep">;

/** One edge per dependency: source = upstream step, target = dependent. */
export function stepsToEdges(steps: readonly WorkflowStep[]): Edge[] {
  const edges: Edge[] = [];
  const ids = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep) || dep === step.id) continue;
      edges.push({
        id: `${dep}->${step.id}`,
        source: dep,
        target: step.id,
      });
    }
  }
  return edges;
}

/** Dagre left-to-right layout for steps missing a stored position. When
 *  every step has coordinates they are kept as-is. Falls back to a plain
 *  layered grid when the graph cannot be ranked (e.g. a cycle under edit). */
export function layoutSteps(
  steps: readonly WorkflowStep[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const allPositioned = steps.every((s) => s.position != null);
  if (allPositioned) {
    for (const step of steps) positions.set(step.id, step.position!);
    return positions;
  }
  try {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: "LR", nodesep: 36, ranksep: 96, marginx: 8, marginy: 8 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const step of steps) {
      graph.setNode(step.id, {
        width: WORKFLOW_NODE_WIDTH,
        height: WORKFLOW_NODE_HEIGHT,
      });
    }
    const ids = new Set(steps.map((s) => s.id));
    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        if (ids.has(dep) && dep !== step.id) graph.setEdge(dep, step.id);
      }
    }
    dagre.layout(graph);
    for (const step of steps) {
      const node = graph.node(step.id);
      positions.set(step.id, {
        x: node.x - WORKFLOW_NODE_WIDTH / 2,
        y: node.y - WORKFLOW_NODE_HEIGHT / 2,
      });
    }
    return positions;
  } catch {
    // Broken draft mid-edit (cycle/missing dep): keep stored positions and
    // stack the rest below so the canvas stays usable while invalid.
    let fallbackY = 0;
    for (const step of steps) {
      if (step.position != null) {
        positions.set(step.id, step.position);
        fallbackY = Math.max(fallbackY, step.position.y + WORKFLOW_NODE_HEIGHT + 24);
      }
    }
    for (const step of steps) {
      if (!positions.has(step.id)) {
        positions.set(step.id, { x: 0, y: fallbackY });
        fallbackY += WORKFLOW_NODE_HEIGHT + 24;
      }
    }
    return positions;
  }
}

/** Build React Flow nodes from steps; stored positions win, dagre fills
 *  the gaps. */
export function stepsToNodes(
  steps: readonly WorkflowStep[],
  agentNameOf: (agentId: string | null | undefined) => string,
  runStates?: Record<string, WorkflowStepRun>,
): WorkflowFlowNode[] {
  const positions = layoutSteps(steps);
  return steps.map((step) => ({
    id: step.id,
    type: "workflowStep" as const,
    position: positions.get(step.id) ?? { x: 0, y: 0 },
    data: {
      step,
      agentName: agentNameOf(step.agentId),
      runState: runStates?.[step.id] ?? null,
    },
  }));
}

/** True when connecting ``source -> target`` keeps the graph a DAG: no
 *  self-loop, no duplicate edge and no path back from target to source. */
export function canConnect(
  steps: readonly WorkflowStep[],
  source: string,
  target: string,
): boolean {
  if (source === target) return false;
  const ids = new Set(steps.map((s) => s.id));
  if (!ids.has(source) || !ids.has(target)) return false;
  const targetStep = steps.find((s) => s.id === target);
  if (!targetStep) return false;
  if ((targetStep.dependsOn ?? []).includes(source)) return false;
  // Reachable(source) from target? Then source -> target closes a cycle.
  const adjacency = new Map<string, string[]>();
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) continue;
      const list = adjacency.get(dep) ?? [];
      list.push(step.id);
      adjacency.set(dep, list);
    }
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === source) return false;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return true;
}

/** Apply an edge change to steps: connect adds a dep, remove drops it. */
export function withDependency(
  steps: readonly WorkflowStep[],
  source: string,
  target: string,
  present: boolean,
): WorkflowStep[] {
  return steps.map((step) => {
    if (step.id !== target) return step;
    const deps = new Set(step.dependsOn ?? []);
    if (present) deps.add(source);
    else deps.delete(source);
    return { ...step, dependsOn: [...deps] };
  });
}

/** Remove a step and every dependency pointing at it. */
export function withoutStep(
  steps: readonly WorkflowStep[],
  stepId: string,
): WorkflowStep[] {
  return steps
    .filter((s) => s.id !== stepId)
    .map((s) => ({
      ...s,
      dependsOn: (s.dependsOn ?? []).filter((d) => d !== stepId),
    }));
}
