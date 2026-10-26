import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentSummary, WorkflowRun } from "@/lib/types";

const INTERNAL_AGENT: AgentSummary = {
  id: "com.mona.team-tech-analyst",
  displayName: "Team Analyst",
  enabled: true,
  visibility: "internal",
};

const DISCUSSION_RUN: WorkflowRun = {
  schemaVersion: 1,
  id: "run-topic",
  roomId: "room-1",
  workflowId: "discussion-debate-1",
  workflowRevision: 1,
  status: "running",
  triggerType: "manual",
  startedBy: "user",
  startedAt: "2026-08-30T00:00:00Z",
  workflow: {
    schemaVersion: 1,
    id: "discussion-debate-1",
    roomId: "room-1",
    revision: 1,
    status: "active",
    goal: "名画和猫只能救一个",
    trigger: { type: "manual" },
    steps: [
      { id: "round-1-speaker-1", type: "agent", agentId: "mona", task: "a" },
      { id: "round-1-speaker-2", type: "agent", agentId: INTERNAL_AGENT.id, task: "b", dependsOn: ["round-1-speaker-1"] },
      { id: "round-2-speaker-1", type: "agent", agentId: "mona", task: "c", dependsOn: ["round-1-speaker-2"] },
      { id: "round-2-speaker-2", type: "agent", agentId: INTERNAL_AGENT.id, task: "d", dependsOn: ["round-2-speaker-1"] },
      { id: "summary", type: "agent", agentId: "mona", task: "judge", dependsOn: ["round-2-speaker-2"] },
    ],
    createdAt: "2026-08-30T00:00:00Z",
    createdBy: "user",
  },
  steps: {
    "round-1-speaker-1": { status: "succeeded" },
    "round-1-speaker-2": { status: "running" },
    "round-2-speaker-1": { status: "queued" },
    "round-2-speaker-2": { status: "queued" },
    summary: { status: "queued" },
  },
  inputs: {
    discussion: {
      mode: "debate",
      maxRounds: 2,
      participantIds: ["mona", INTERNAL_AGENT.id],
      positions: { mona: "救猫", [INTERNAL_AGENT.id]: "救画" },
      summaryAgentId: "mona",
    },
  },
};

const QUARREL_RUN: WorkflowRun = {
  ...DISCUSSION_RUN,
  inputs: {
    discussion: {
      mode: "quarrel",
      maxRounds: 2,
      participantIds: ["mona", INTERNAL_AGENT.id],
      positions: { mona: "救猫", [INTERNAL_AGENT.id]: "救画" },
      summaryAgentId: null,
    },
  },
};

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    listAgents: vi.fn(async () => [INTERNAL_AGENT]),
    listArtifacts: vi.fn(async () => ({ files: [], truncated: false })),
  };
});
vi.mock("@/providers/ClientProvider", () => ({
  useClient: () => ({
    client: {
      // Room state never resolves: the panel falls back to the
      // session-carried conversation member ids.
      getRoomState: () => new Promise(() => {}),
      onRoomUpdated: () => () => {},
      onArtifactsChanged: () => () => {},
    },
    token: "test-token",
  }),
}));
vi.mock("@/components/workflow/WorkflowPanel", () => ({
  WorkflowPanel: () => <div data-testid="compact-workflow-entry">workflow entry</div>,
}));

import { RoomContextPanel } from "./RoomContextPanel";

describe("RoomContextPanel", () => {
  it("keeps internal members resolvable and tags them as team built-in", async () => {
    render(
      <RoomContextPanel
        chatId="room-1"
        conversation={{
          type: "room",
          title: "Team research",
          agentIds: ["com.mona.team-tech-analyst"],
          hidden: true,
        }}
      />,
    );

    expect(await screen.findByText("Team Analyst")).toBeInTheDocument();
    expect(await screen.findByText("Built-in")).toBeInTheDocument();

    expect(screen.getByText("Group chat").parentElement?.parentElement).toHaveClass("bg-card");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveClass(
      "hover:bg-foreground/[0.05]",
    );
    expect(screen.getByTestId("compact-workflow-entry")).toBeInTheDocument();
  });

  it("replaces the static goal with live discussion progress", async () => {
    render(
      <RoomContextPanel
        chatId="room-1"
        conversation={{
          type: "room",
          title: "Debate room",
          agentIds: ["mona", INTERNAL_AGENT.id],
          goal: "unused static goal",
        }}
        discussionRun={DISCUSSION_RUN}
      />,
    );

    expect(await screen.findByText("Current task")).toBeInTheDocument();
    expect(screen.getByText("Debate")).toBeInTheDocument();
    expect(screen.getByText("名画和猫只能救一个")).toBeInTheDocument();
    expect(screen.getByText(/Round 1 \/ 2/)).toHaveTextContent("Team Analyst is working");
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End topic" })).toBeInTheDocument();
    expect(screen.queryByText("unused static goal")).not.toBeInTheDocument();
  });

  it("keeps quarrel runs labeled as quarrel in room progress", async () => {
    render(
      <RoomContextPanel
        chatId="room-1"
        conversation={{
          type: "room",
          title: "Quarrel room",
          agentIds: ["mona", INTERNAL_AGENT.id],
        }}
        discussionRun={QUARREL_RUN}
      />,
    );

    expect(await screen.findByText("Quarrel")).toBeInTheDocument();
    expect(screen.queryByText("Open discussion")).not.toBeInTheDocument();
  });
});
