import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowDefinition } from "@/lib/types";

const activeWorkflow: WorkflowDefinition = {
  schemaVersion: 1,
  id: "workflow-1",
  roomId: "room-1",
  revision: 2,
  status: "active",
  goal: "Ship the release",
  trigger: { type: "manual" },
  steps: [
    { id: "plan", type: "agent", agentId: "mona", task: "Plan" },
    { id: "build", type: "agent", agentId: "mona", task: "Build", dependsOn: ["plan"] },
  ],
  createdAt: "2026-08-30T00:00:00Z",
  createdBy: "user",
};

const clientMocks = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  onWorkflowUpdated: vi.fn(() => () => {}),
  onApprovalRequested: vi.fn(() => () => {}),
  saveWorkflowDraft: vi.fn(async () => undefined),
  activateWorkflow: vi.fn(async () => undefined),
  runWorkflow: vi.fn(async () => undefined),
}));

vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({ client: clientMocks, token: "test-token" }),
}));
vi.mock("@/lib/tauri", () => ({ showNotification: vi.fn(async () => undefined) }));
vi.mock("@/components/workflow/WorkflowCanvasDialog", () => ({
  WorkflowCanvasDialog: ({ open, initialGoal }: { open: boolean; initialGoal: string }) => (
    open ? <div role="dialog">Editor: {initialGoal || "New workflow"}</div> : null
  ),
}));

import { WorkflowPanel } from "./WorkflowPanel";

describe("WorkflowPanel compact entry", () => {
  beforeEach(() => {
    clientMocks.getWorkflow.mockReset();
  });

  it("shows the active step count and opens the existing editor", async () => {
    const user = userEvent.setup();
    clientMocks.getWorkflow.mockResolvedValue({
      draft: null,
      active: activeWorkflow,
      activeRevision: activeWorkflow.revision,
    });
    render(<WorkflowPanel chatId="room-1" members={[]} />);

    const entry = await screen.findByRole("button", { name: /Workflow · 2 steps/ });
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
    await user.click(entry);

    expect(screen.getByRole("dialog")).toHaveTextContent("Editor: Ship the release");
  });

  it("shows a single add-workflow entry when nothing is configured", async () => {
    clientMocks.getWorkflow.mockResolvedValue({
      draft: null,
      active: null,
      activeRevision: null,
    });
    render(<WorkflowPanel chatId="room-1" members={[]} />);

    await waitFor(() => expect(
      screen.getByRole("button", { name: /Add workflow/ }),
    ).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
  });
});
