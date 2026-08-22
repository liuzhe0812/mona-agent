import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentIdentity } from "@/components/room/AgentAvatar";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { StepActivityTrace } from "@/components/workflow/StepActivityTrace";
import { WorkflowCanvasDialog } from "@/components/workflow/WorkflowCanvasDialog";
import { WorkflowRunCard } from "@/components/workflow/WorkflowRunCard";
import {
  canConnect,
  layoutSteps,
  withDependency,
  withoutStep,
} from "@/components/workflow/workflow-canvas";
import {
  executionLayers,
  nextStepId,
  validateWorkflowDraft,
} from "@/components/workflow/workflow-draft";
import type { WorkflowDefinition, WorkflowRun, WorkflowStep } from "@/lib/types";

const MONA = "mona";
const ANALYST = "com.example.analyst";
const CODER = "com.example.coder";
const MEMBER_IDS = [MONA, ANALYST, CODER];

const MEMBERS: AgentIdentity[] = [
  { id: MONA, displayName: "Mona" },
  { id: ANALYST, displayName: "Analyst" },
  { id: CODER, displayName: "Coder" },
];

// The canvas itself is covered by the pure-function tests below and manual
// verification; component tests stub it with an accessible node list so the
// surrounding logic (selection, detail pane, palette, validation) runs
// without React Flow's layout engine in happy-dom.
vi.mock("@/components/workflow/WorkflowCanvas", () => ({
  WorkflowCanvas: ({
    steps,
    onSelectStep,
  }: {
    steps: WorkflowStep[];
    onSelectStep?: (id: string | null) => void;
  }) => (
    <div data-testid="workflow-canvas">
      {steps.map((s) => (
        <button key={s.id} type="button" onClick={() => onSelectStep?.(s.id)}>
          {s.id}
        </button>
      ))}
    </div>
  ),
}));

function agentStep(
  id: string,
  agentId: string | null = ANALYST,
  dependsOn: string[] = [],
): WorkflowStep {
  return { id, type: "agent", agentId, task: `${id} task`, dependsOn };
}

function approvalStep(id: string, dependsOn: string[] = []): WorkflowStep {
  return { id, type: "approval", message: "Confirm", dependsOn };
}

describe("validateWorkflowDraft", () => {
  it("accepts a serial chain", () => {
    const steps = [agentStep("a"), agentStep("b", CODER, ["a"])];
    expect(validateWorkflowDraft(steps, MEMBER_IDS)).toEqual([]);
  });

  it("accepts parallel branches with a join", () => {
    const steps = [
      agentStep("a"),
      agentStep("b", CODER),
      agentStep("c", MONA, ["a", "b"]),
    ];
    expect(validateWorkflowDraft(steps, MEMBER_IDS)).toEqual([]);
  });

  it("rejects an empty draft and an approval-only draft", () => {
    expect(validateWorkflowDraft([], MEMBER_IDS).map((e) => e.code)).toEqual([
      "empty",
    ]);
    expect(
      validateWorkflowDraft([approvalStep("ok")], MEMBER_IDS).map((e) => e.code),
    ).toContain("noAgentStep");
  });

  it("rejects duplicate and invalid step ids", () => {
    const dup = validateWorkflowDraft(
      [agentStep("a"), agentStep("a", CODER)],
      MEMBER_IDS,
    );
    expect(dup.map((e) => e.code)).toContain("duplicateId");
    const bad = validateWorkflowDraft(
      [{ ...agentStep("bad id") }],
      MEMBER_IDS,
    );
    expect(bad.map((e) => e.code)).toContain("invalidId");
  });

  it("rejects non-member agents and missing fields", () => {
    const nonMember = validateWorkflowDraft(
      [agentStep("a", "com.example.outsider")],
      MEMBER_IDS,
    );
    expect(nonMember.map((e) => e.code)).toContain("nonMember");
    const noTask = validateWorkflowDraft(
      [{ ...agentStep("a"), task: "  " }],
      MEMBER_IDS,
    );
    expect(noTask.map((e) => e.code)).toContain("missingTask");
    const noMessage = validateWorkflowDraft(
      [{ ...approvalStep("ok"), message: "" }, agentStep("a")],
      MEMBER_IDS,
    );
    expect(noMessage.map((e) => e.code)).toContain("missingMessage");
  });

  it("rejects unknown deps, self deps and cycles", () => {
    expect(
      validateWorkflowDraft([agentStep("a", ANALYST, ["ghost"])], MEMBER_IDS).map(
        (e) => e.code,
      ),
    ).toContain("unknownDep");
    expect(
      validateWorkflowDraft([agentStep("a", ANALYST, ["a"])], MEMBER_IDS).map(
        (e) => e.code,
      ),
    ).toContain("selfDep");
    const cyclic = validateWorkflowDraft(
      [agentStep("a", ANALYST, ["b"]), agentStep("b", CODER, ["a"])],
      MEMBER_IDS,
    );
    expect(cyclic.map((e) => e.code)).toContain("cycle");
  });
});

describe("executionLayers", () => {
  it("layers serial chains one step per layer", () => {
    expect(
      executionLayers([agentStep("a"), agentStep("b", CODER, ["a"])]),
    ).toEqual([["a"], ["b"]]);
  });

  it("groups parallel branches and diamonds", () => {
    const layers = executionLayers([
      agentStep("a"),
      agentStep("b", CODER, ["a"]),
      agentStep("c", MONA, ["a"]),
      agentStep("d", ANALYST, ["b", "c"]),
    ]);
    expect(layers).toEqual([["a"], ["b", "c"], ["d"]]);
  });
});

describe("nextStepId", () => {
  it("picks the first unused step-N id", () => {
    expect(nextStepId([])).toBe("step-1");
    expect(nextStepId([agentStep("step-1"), agentStep("step-3")])).toBe("step-2");
  });
});

describe("workflow-canvas helpers", () => {
  it("keeps stored positions and lays out unpositioned steps left-to-right", () => {
    const positioned = layoutSteps([
      { ...agentStep("a"), position: { x: 10, y: 20 } },
      { ...agentStep("b", CODER, ["a"]), position: { x: 300, y: 20 } },
    ]);
    expect(positioned.get("a")).toEqual({ x: 10, y: 20 });
    expect(positioned.get("b")).toEqual({ x: 300, y: 20 });

    const auto = layoutSteps([agentStep("a"), agentStep("b", CODER, ["a"])]);
    const a = auto.get("a")!;
    const b = auto.get("b")!;
    // Dagre LR ranking: the downstream step sits to the right.
    expect(b.x).toBeGreaterThan(a.x);
  });

  it("canConnect rejects self-loops, duplicates and cycles", () => {
    const steps = [agentStep("a"), agentStep("b", CODER, ["a"]), agentStep("c")];
    expect(canConnect(steps, "a", "a")).toBe(false);
    expect(canConnect(steps, "a", "b")).toBe(false); // already depends
    expect(canConnect(steps, "b", "a")).toBe(false); // would close a cycle
    expect(canConnect(steps, "a", "c")).toBe(true);
    expect(canConnect(steps, "ghost", "c")).toBe(false);
  });

  it("withDependency adds and removes edges", () => {
    const steps = [agentStep("a"), agentStep("b")];
    const linked = withDependency(steps, "a", "b", true);
    expect(linked[1].dependsOn).toEqual(["a"]);
    expect(withDependency(linked, "a", "b", false)[1].dependsOn).toEqual([]);
  });

  it("withoutStep drops the step and edges pointing at it", () => {
    const steps = [
      agentStep("a"),
      agentStep("b", CODER, ["a"]),
      agentStep("c", MONA, ["b"]),
    ];
    const next = withoutStep(steps, "b");
    expect(next.map((s) => s.id)).toEqual(["a", "c"]);
    expect(next[1].dependsOn).toEqual([]);
  });
});

describe("WorkflowCanvasDialog", () => {
  function renderDialog(
    props: Partial<Parameters<typeof WorkflowCanvasDialog>[0]> = {},
  ) {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <WorkflowCanvasDialog
        open
        members={MEMBERS}
        initialGoal="Draft goal"
        initialSteps={[]}
        saving={false}
        onSave={onSave}
        onClose={onClose}
        {...props}
      />,
    );
    return { onSave, onClose, ...view };
  }

  it("adds a member node and flags the missing task live", () => {
    renderDialog();
    fireEvent.click(screen.getByText("Analyst"));
    expect(screen.getByText("Step step-1 is missing a task.")).toBeTruthy();
    expect(screen.getByText("Save draft")).toHaveProperty("disabled", true);
  });

  it("chains new nodes onto the previous one and saves a valid draft", () => {
    const { onSave } = renderDialog();
    fireEvent.click(screen.getByText("Analyst"));
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Research" },
    });
    fireEvent.click(screen.getByText("Coder"));
    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Summarize" },
    });
    fireEvent.click(screen.getByText("Save draft"));
    expect(onSave).toHaveBeenCalledTimes(1);
    const [goal, steps] = onSave.mock.calls[0] as [string, WorkflowStep[]];
    expect(goal).toBe("Draft goal");
    expect(steps.map((s) => s.id)).toEqual(["step-1", "step-2"]);
    expect(steps[1].dependsOn).toEqual(["step-1"]);
    expect(steps.every((s) => s.position != null)).toBe(true);
  });

  it("asks before discarding unsaved changes", () => {
    const clean = renderDialog();
    fireEvent.click(screen.getByText("Cancel"));
    expect(clean.onClose).toHaveBeenCalledTimes(1);
    clean.unmount();

    const dirty = renderDialog({ initialSteps: [agentStep("a")] });
    fireEvent.click(screen.getByText("Analyst"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
    expect(dirty.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Discard"));
    expect(dirty.onClose).toHaveBeenCalledTimes(1);
  });
});

function makeDefinition(steps: WorkflowStep[]): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: "wf_test",
    roomId: "room1",
    revision: 2,
    status: "active",
    goal: "Ship a report",
    trigger: { type: "manual" },
    steps,
    createdAt: "2026-08-12T09:00:00",
    createdBy: "user",
  };
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    schemaVersion: 1,
    id: "run_1",
    roomId: "room1",
    workflowId: "wf_test",
    workflowRevision: 2,
    workflow: makeDefinition([
      agentStep("a"),
      agentStep("b", CODER, ["a"]),
      approvalStep("ok", ["b"]),
    ]),
    status: "running",
    triggerType: "manual",
    startedBy: "user",
    startedAt: "2026-08-12T09:30:00",
    steps: {
      a: { status: "succeeded", output: { summary: "结论摘要" } },
      b: { status: "running" },
      ok: { status: "queued" },
    },
    ...overrides,
  };
}

describe("WorkflowRunCard", () => {
  it("renders the run chip, expands a step row for its summary and cancels", () => {
    const onCancel = vi.fn();
    render(
      <WorkflowRunCard
        run={makeRun()}
        members={MEMBERS}
        cancelling={false}
        onCancel={onCancel}
      />,
    );
    // "Running" matches the run-status chip and the running step's row label.
    expect(screen.getAllByText("Running")).toHaveLength(2);
    expect(screen.getByText("Based on revision 2")).toBeTruthy();
    // Steps render in dependency-layer order: a → b → ok.
    const ids = screen.getAllByText(/^(a|b|ok)$/).map((el) => el.textContent);
    expect(ids).toEqual(["a", "b", "ok"]);
    // Expanding the succeeded step reveals its output summary.
    fireEvent.click(screen.getByText("a"));
    expect(screen.getByText("结论摘要")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel run"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows approve/reject controls when a waiting approval row expands", () => {
    const onResolveApproval = vi.fn();
    render(
      <WorkflowRunCard
        run={makeRun({
          status: "waiting_approval",
          steps: {
            a: { status: "succeeded" },
            b: { status: "succeeded" },
            ok: { status: "waiting_approval", approvalToken: "tok-1" },
          },
        })}
        members={MEMBERS}
        cancelling={false}
        onCancel={vi.fn()}
        onResolveApproval={onResolveApproval}
      />,
    );
    fireEvent.click(screen.getByText("ok"));
    expect(screen.getByText("Confirm")).toBeTruthy();
    fireEvent.click(screen.getByText("Approve"));
    expect(onResolveApproval).toHaveBeenCalledWith("ok", true);
    fireEvent.click(screen.getByText("Reject"));
    expect(onResolveApproval).toHaveBeenCalledWith("ok", false);
  });

  it("disables approval buttons while the decision is in flight", () => {
    render(
      <WorkflowRunCard
        run={makeRun({
          status: "waiting_approval",
          steps: {
            a: { status: "succeeded" },
            b: { status: "succeeded" },
            ok: { status: "waiting_approval", approvalToken: "tok-1" },
          },
        })}
        members={MEMBERS}
        cancelling={false}
        resolvingStep="ok"
        onCancel={vi.fn()}
        onResolveApproval={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("ok"));
    expect(screen.getByText("Approve")).toHaveProperty("disabled", true);
    expect(screen.getByText("Reject")).toHaveProperty("disabled", true);
  });

  it("renders the recorded decision on resolved approval steps", () => {
    render(
      <WorkflowRunCard
        run={makeRun({
          status: "failed",
          steps: {
            a: { status: "succeeded" },
            b: { status: "succeeded" },
            ok: {
              status: "failed",
              error: "Rejected by user.",
              approvalDecision: "rejected",
              approvalResolvedBy: "user",
            },
          },
        })}
        members={MEMBERS}
        cancelling={false}
        onCancel={vi.fn()}
        onResolveApproval={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("ok"));
    expect(screen.getByText("Rejected by user")).toBeTruthy();
    expect(screen.queryByText("Approve")).toBeNull();
  });

  it("hides the cancel action on terminal runs and shows step errors", () => {
    const onCancel = vi.fn();
    render(
      <WorkflowRunCard
        run={makeRun({
          status: "failed",
          steps: {
            a: { status: "succeeded", output: { summary: "ok" } },
            b: { status: "failed", error: "model timeout" },
            ok: { status: "skipped" },
          },
        })}
        members={MEMBERS}
        cancelling={false}
        onCancel={onCancel}
      />,
    );
    // "Failed" matches the run-status chip and the failed step's row label.
    expect(screen.getAllByText("Failed")).toHaveLength(2);
    expect(screen.queryByText("Cancel run")).toBeNull();
    expect(screen.getByText("Skipped")).toBeTruthy();
    fireEvent.click(screen.getByText("b"));
    expect(screen.getByText("model timeout")).toBeTruthy();
  });

  it("offers retry for a failed agent step", () => {
    const onRetryStep = vi.fn();
    render(
      <WorkflowRunCard
        run={makeRun({
          status: "failed",
          steps: {
            a: { status: "succeeded" },
            b: { status: "failed", error: "model timeout" },
            ok: { status: "skipped" },
          },
        })}
        members={MEMBERS}
        cancelling={false}
        onCancel={vi.fn()}
        onRetryStep={onRetryStep}
      />,
    );
    fireEvent.click(screen.getByText("b"));
    fireEvent.click(screen.getByText("Retry this step"));
    expect(onRetryStep).toHaveBeenCalledWith("b");
  });

  it("offers step cancellation while an agent job is running", () => {
    const onCancelStep = vi.fn();
    render(
      <WorkflowRunCard
        run={makeRun({
          steps: {
            a: { status: "succeeded" },
            b: { status: "running", jobId: "job_b" },
            ok: { status: "queued" },
          },
        })}
        members={MEMBERS}
        cancelling={false}
        onCancel={vi.fn()}
        onCancelStep={onCancelStep}
      />,
    );
    fireEvent.click(screen.getByText("b"));
    fireEvent.click(screen.getByText("Cancel this step"));
    expect(onCancelStep).toHaveBeenCalledWith("b", "job_b");
  });
});

describe("StepActivityTrace", () => {
  it("renders nothing when no event formats to a line", () => {
    const { container } = render(
      <StepActivityTrace events={[{ phase: "start" }, { name: "" }]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per tool call and appends the error tail", () => {
    render(
      <StepActivityTrace
        events={[
          { phase: "start", call_id: "c1", name: "web_search", arguments: { q: "x" } },
          { phase: "error", call_id: "c2", name: "read_file", error: "boom" },
        ]}
      />,
    );
    fireEvent.click(screen.getByText("Used 2 tools"));
    expect(screen.getByText('web_search({"q":"x"})')).toBeTruthy();
    expect(screen.getByText("read_file() — boom")).toBeTruthy();
  });
});

describe("ThreadMessages workflowRun", () => {
  it("renders a workflowRun message as a run card inside the thread", () => {
    render(
      <ThreadMessages
        messages={[
          { id: "u1", role: "user", content: "run it", createdAt: 1 },
          {
            id: "wfr1",
            role: "assistant",
            kind: "workflowRun",
            content: "",
            workflowRunId: "run_1",
            payload: makeRun(),
            createdAt: 2,
          },
        ]}
      />,
    );
    // Run status chip + revision line from the embedded run card.
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getByText("Based on revision 2")).toBeTruthy();
    // The plain bubble for the run message must not render alongside.
    expect(screen.getAllByText(/^(a|b|ok)$/).length).toBe(3);
  });

  it("falls back to the plain renderer for malformed payloads", () => {
    render(
      <ThreadMessages
        messages={[
          {
            id: "wfr2",
            role: "assistant",
            kind: "workflowRun",
            content: "",
            workflowRunId: "bad",
            payload: { nope: true },
            createdAt: 1,
          },
        ]}
      />,
    );
    expect(screen.queryByText("Based on revision 2")).toBeNull();
  });
});

describe("workflow step activity projection", () => {
  it("shows live step activity inside the run card when the step expands", () => {
    render(
      <WorkflowRunCard
        run={makeRun()}
        members={MEMBERS}
        cancelling={false}
        onCancel={vi.fn()}
        stepActivities={{
          "run_1:b": [
            { phase: "start", call_id: "c1", name: "web_search", arguments: { q: "mona" } },
          ],
        }}
      />,
    );
    // Collapsed: the trail stays hidden with the step detail.
    expect(screen.queryByText('web_search({"q":"mona"})')).toBeNull();
    fireEvent.click(screen.getByText("b"));
    fireEvent.click(screen.getByText("Using a tool"));
    expect(screen.getByText('web_search({"q":"mona"})')).toBeTruthy();
  });

  it("renders persisted tool events below the step result message", () => {
    render(
      <ThreadMessages
        messages={[
          {
            id: "m1",
            role: "assistant",
            content: "分析完成",
            authorId: ANALYST,
            createdAt: 1,
            toolEvents: [
              { phase: "start", call_id: "c1", name: "read_file", arguments: { path: "a.md" } },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByText("分析完成")).toBeTruthy();
    fireEvent.click(screen.getByText("Using a tool"));
    expect(screen.getByText('read_file({"path":"a.md"})')).toBeTruthy();
  });
});
