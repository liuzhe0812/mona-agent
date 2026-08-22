import { useCallback, useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Loader2,
  UserCheck,
  XCircle,
} from "lucide-react";

import { AgentAvatar } from "@/components/room/AgentAvatar";
import {
  canConnect,
  stepsToEdges,
  stepsToNodes,
  withDependency,
  withoutStep,
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
  type WorkflowFlowNode,
} from "@/components/workflow/workflow-canvas";
import { cn } from "@/lib/utils";
import type {
  WorkflowStep,
  WorkflowStepRun,
  WorkflowStepStatus,
} from "@/lib/types";

/** Border/ring accent per live step status (run mode). */
const STATUS_RING: Record<WorkflowStepStatus, string> = {
  queued: "border-border/60",
  running: "border-primary shadow-[0_0_0_3px_hsl(var(--primary)/0.15)]",
  waiting_approval: "border-amber-500 shadow-[0_0_0_3px_rgb(245_158_11/0.15)]",
  succeeded: "border-emerald-500",
  failed: "border-destructive",
  cancelled: "border-border/40 opacity-70",
  skipped: "border-border/40 opacity-60",
};

function StepStatusBadge({ status }: { status: WorkflowStepStatus }) {
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

/** One workflow step card on the canvas (Dify/Coze-style compact node). */
function WorkflowStepNode({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const { step, agentName, runState } = data;
  const status = runState?.status ?? null;
  const summary =
    step.type === "agent" ? (step.task ?? "") : (step.message ?? "");
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-lg border bg-background px-2.5 py-2 transition-colors",
        status ? STATUS_RING[status] : "border-border/60",
        selected && "ring-2 ring-primary/60",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-2 !border-border !bg-background"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2.5 !w-2.5 !border-2 !border-border !bg-background"
      />
      <div className="flex min-w-0 items-center gap-2">
        {step.type === "agent" ? (
          <AgentAvatar
            agentId={step.agentId ?? ""}
            displayName={agentName}
            className="h-6 w-6 shrink-0"
          />
        ) : (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-500/10">
            <UserCheck className="h-3.5 w-3.5 text-amber-500" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium leading-4">
            {step.type === "agent" ? agentName : step.id}
          </div>
          <div className="truncate font-mono text-[10px] leading-3 text-muted-foreground">
            {step.type === "agent" ? step.id : "approval"}
          </div>
        </div>
        {status ? <StepStatusBadge status={status} /> : null}
      </div>
      <p className="mt-1.5 line-clamp-2 min-h-0 flex-1 text-[11px] leading-4 text-muted-foreground">
        {summary}
      </p>
    </div>
  );
}

const nodeTypes = { workflowStep: WorkflowStepNode };

const EDGE_STYLE = { stroke: "hsl(var(--border))", strokeWidth: 1.5 } as const;
const EDGE_MARKER = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: "hsl(var(--border))",
} as const;

interface WorkflowCanvasProps {
  steps: WorkflowStep[];
  /** Resolve an agent id to its display name for node headers. */
  agentNameOf: (agentId: string | null | undefined) => string;
  /** Edit mode enables drag/connect/delete; readonly renders run state. */
  mode: "edit" | "readonly";
  /** Live per-step run state (readonly mode). */
  runStates?: Record<string, WorkflowStepRun>;
  selectedStepId?: string | null;
  onSelectStep?: (stepId: string | null) => void;
  /** Edit mode: called with the next steps after drag/connect/delete. */
  onChange?: (steps: WorkflowStep[]) => void;
  /** Mini preview disables pan/zoom gestures and fits the whole graph. */
  interactive?: boolean;
  className?: string;
}

/** React Flow canvas for a workflow DAG: agent/approval step cards wired by
 *  dependency edges, dagre auto-layout for steps without coordinates. */
export function WorkflowCanvas({
  steps,
  agentNameOf,
  mode,
  runStates,
  selectedStepId = null,
  onSelectStep,
  onChange,
  interactive = true,
  className,
}: WorkflowCanvasProps) {
  const editable = mode === "edit" && onChange != null;

  const nodes = useMemo(() => {
    const built = stepsToNodes(steps, agentNameOf, runStates);
    return built.map((node) => ({
      ...node,
      selected: node.id === selectedStepId,
    }));
  }, [steps, agentNameOf, runStates, selectedStepId]);

  const edges = useMemo<Edge[]>(
    () =>
      stepsToEdges(steps).map((edge) => ({
        ...edge,
        style: EDGE_STYLE,
        markerEnd: EDGE_MARKER,
      })),
    [steps],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowFlowNode>[]) => {
      if (!editable) return;
      let next: WorkflowStep[] | null = null;
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          next = (next ?? steps).map((step) =>
            step.id === change.id
              ? { ...step, position: { ...change.position! } }
              : step,
          );
        } else if (change.type === "remove") {
          next = withoutStep(next ?? steps, change.id);
          if (selectedStepId === change.id) onSelectStep?.(null);
        }
      }
      if (next) onChange(next);
    },
    [editable, steps, onChange, onSelectStep, selectedStepId],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      if (!editable) return;
      let next = steps;
      for (const change of changes) {
        if (change.type === "remove") {
          const [source, target] = change.id.split("->");
          if (source && target) next = withDependency(next, source, target, false);
        }
      }
      if (next !== steps) onChange(next);
    },
    [editable, steps, onChange],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!editable || !connection.source || !connection.target) return;
      if (!canConnect(steps, connection.source, connection.target)) return;
      onChange(withDependency(steps, connection.source, connection.target, true));
    },
    [editable, steps, onChange],
  );

  return (
    <div
      className={cn("workflow-canvas h-full w-full", className)}
      style={{ minHeight: 120 }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={editable ? onNodesChange : undefined}
        onEdgesChange={editable ? onEdgesChange : undefined}
        onConnect={editable ? onConnect : undefined}
        onNodeClick={(_, node) => onSelectStep?.(node.id)}
        onPaneClick={() => onSelectStep?.(null)}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        panOnDrag={interactive}
        zoomOnScroll={interactive}
        zoomOnPinch={interactive}
        preventScrolling={interactive}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.2}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={18}
          size={1}
          color="hsl(var(--border) / 0.5)"
        />
      </ReactFlow>
    </div>
  );
}

export { WORKFLOW_NODE_HEIGHT, WORKFLOW_NODE_WIDTH };
