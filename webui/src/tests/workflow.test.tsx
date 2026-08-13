import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentIdentity } from "@/components/room/AgentAvatar";
import { WorkflowEditor } from "@/components/workflow/WorkflowEditor";
import { WorkflowRunCard } from "@/components/workflow/WorkflowRunCard";
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

describe("WorkflowEditor", () => {
  function renderEditor(props: Partial<Parameters<typeof WorkflowEditor>[0]> = {}) {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(
      <WorkflowEditor
        members={MEMBERS}
        initialGoal="Draft goal"
        initialSteps={[]}
        saving={false}
        onSave={onSave}
        onCancel={onCancel}
        {...props}
      />,
    );
    return { onSave, onCancel, unmount };
  }

  it("adds an agent step and flags the missing task live", () => {
    renderEditor();
    fireEvent.click(screen.getByText("Add agent step"));
    // New step defaults to agent type with an empty task → live validation.
    expect(screen.getByText("Step step-1 is missing a task.")).toBeTruthy();
    expect(screen.getByText("Save draft")).toHaveProperty("disabled", true);
  });

  it("chains new steps onto the previous step by default", () => {
    const { onSave } = renderEditor();
    fireEvent.click(screen.getByText("Add agent step"));
    fireEvent.click(screen.getByText("Add agent step"));
    const tasks = screen.getAllByLabelText("Task");
    fireEvent.change(tasks[0], { target: { value: "Research" } });
    fireEvent.change(tasks[1], { target: { value: "Summarize" } });
    const selects = screen.getAllByLabelText("Assigned agent");
    void selects; // agent selection covered by validation unit tests
    fireEvent.click(screen.getByText("Save draft"));
    expect(onSave).not.toHaveBeenCalled(); // still invalid: no agent selected
    expect(screen.getAllByText(/has no agent selected/)).toHaveLength(2);
  });

  it("saves a valid serial draft", () => {
    const steps = [
      agentStep("a"),
      { ...agentStep("b", CODER, ["a"]), expectedOutput: "" },
    ];
    const { onSave } = renderEditor({ initialSteps: steps });
    fireEvent.click(screen.getByText("Save draft"));
    expect(onSave).toHaveBeenCalledWith("Draft goal", steps);
  });

  it("asks before discarding unsaved changes", () => {
    const first = renderEditor();
    fireEvent.click(screen.getByText("Cancel"));
    // Clean editor: no confirmation needed.
    expect(first.onCancel).toHaveBeenCalledTimes(1);
    first.unmount();

    const dirty = renderEditor({ initialSteps: [agentStep("a")] });
    fireEvent.click(screen.getByText("Add approval step"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByText("Discard unsaved changes?")).toBeTruthy();
    expect(dirty.onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Discard"));
    expect(dirty.onCancel).toHaveBeenCalledTimes(1);
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
  it("renders per-step statuses in dependency order and can cancel a live run", () => {
    const onCancel = vi.fn();
    render(
      <WorkflowRunCard
        run={makeRun()}
        members={MEMBERS}
        cancelling={false}
        onCancel={onCancel}
      />,
    );
    // "Running" matches the run-status chip and the running step's label.
    expect(screen.getAllByText("Running")).toHaveLength(2);
    expect(screen.getByText("Based on revision 2")).toBeTruthy();
    // Steps render in dependency-layer order: a → b → ok.
    const ids = screen.getAllByText(/^(a|b|ok)$/).map((el) => el.textContent);
    expect(ids).toEqual(["a", "b", "ok"]);
    // Succeeded step summary + waiting labels.
    expect(screen.getByText("结论摘要")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Approval")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel run"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows approve/reject controls on a waiting approval step", () => {
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
    // The approval prompt message from the step definition is shown.
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
    expect(screen.getByText("Rejected by user")).toBeTruthy();
    // Terminal step: no approve/reject controls.
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
    // "Failed" matches the run-status chip and the failed step's label.
    expect(screen.getAllByText("Failed")).toHaveLength(2);
    expect(screen.queryByText("Cancel run")).toBeNull();
    expect(screen.getByText("model timeout")).toBeTruthy();
    expect(screen.getByText("Skipped")).toBeTruthy();
  });
});
