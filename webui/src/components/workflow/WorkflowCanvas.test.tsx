import { createElement, type ComponentType } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

type MockNode = {
  id: string;
  type: string;
  data: Record<string, unknown>;
  selected?: boolean;
  [key: string]: unknown;
};

type MockFlowProps = {
  nodes: MockNode[];
  edges: unknown[];
  nodeTypes: Record<string, ComponentType<Record<string, unknown>>>;
};

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Handle: ({ className }: { className?: string }) => (
    <span data-testid="workflow-handle" className={className} />
  ),
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Left: "left", Right: "right" },
  ReactFlow: ({ nodes, edges, nodeTypes }: MockFlowProps) => (
    <div data-testid="react-flow-mock">
      <output data-testid="workflow-edges">{JSON.stringify(edges)}</output>
      {nodes.map((node) => {
        const Node = nodeTypes[node.type];
        return (
          <div key={node.id} data-testid={`workflow-node-${node.id}`}>
            {createElement(Node, node)}
          </div>
        );
      })}
    </div>
  ),
}));

import { WorkflowCanvas } from "./WorkflowCanvas";
import type { WorkflowStep } from "@/lib/types";

const STEPS: WorkflowStep[] = [
  { id: "plan", type: "agent", agentId: "planner", task: "Plan", dependsOn: [] },
  { id: "run", type: "agent", agentId: "runner", task: "Run", dependsOn: ["plan"] },
  { id: "approve", type: "approval", message: "Approve", dependsOn: ["run"] },
  { id: "done", type: "agent", agentId: "writer", task: "Write", dependsOn: ["plan"] },
];

function edgeState() {
  return JSON.parse(screen.getByTestId("workflow-edges").textContent ?? "[]") as Array<{
    id: string;
    animated?: boolean;
    style?: { stroke?: string };
  }>;
}

describe("WorkflowCanvas visual states", () => {
  it("keeps node states distinct and animates only edges touching a running step", () => {
    render(
      <WorkflowCanvas
        steps={STEPS}
        agentNameOf={(agentId) => agentId ?? ""}
        mode="readonly"
        selectedStepId="plan"
        runStates={{
          run: { status: "running" },
          approve: { status: "waiting_approval" },
        }}
      />,
    );

    const plan = screen.getByTestId("workflow-node-plan").firstElementChild;
    const run = screen.getByTestId("workflow-node-run").firstElementChild;
    const approve = screen.getByTestId("workflow-node-approve").firstElementChild;
    const done = screen.getByTestId("workflow-node-done").firstElementChild;

    expect(plan).toHaveClass("bg-card", "ring-2", "ring-foreground/40");
    expect(plan).not.toHaveClass("ring-primary");
    expect(run).toHaveClass("bg-card", "border-[hsl(var(--ai-cyan))]");
    expect(run).not.toHaveClass("shadow-[0_0_0_3px_hsl(var(--primary)/0.15)]");
    expect(approve).toHaveClass("border-[hsl(var(--brand-amber))]");
    expect(approve).not.toHaveClass("shadow-[0_0_0_3px_rgb(245_158_11/0.15)]");
    expect(done).toHaveClass("bg-card");

    expect(screen.getAllByTestId("workflow-handle")[0]).toHaveClass(
      "!border-editor-surface",
      "!bg-card",
    );

    const edges = edgeState();
    expect(edges.find((edge) => edge.id === "plan->run")).toMatchObject({
      animated: true,
      style: { stroke: "hsl(var(--ai-cyan))" },
    });
    expect(edges.find((edge) => edge.id === "run->approve")).toMatchObject({
      animated: true,
      style: { stroke: "hsl(var(--ai-cyan))" },
    });
    expect(edges.find((edge) => edge.id === "plan->done")).toMatchObject({
      animated: false,
      style: { stroke: "hsl(var(--border))" },
    });
  });
});
