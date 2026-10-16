import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowRun } from "@/lib/types";

vi.mock("@/components/room/useAgents", () => ({
  useAgents: () => new Map(),
}));
vi.mock("@/providers/ClientProvider", () => ({
  useClientContextOrNull: () => null,
}));

import { DiscussionRunMessage } from "./DiscussionRunMessage";

const QUARREL_RUN: WorkflowRun = {
  schemaVersion: 1,
  id: "run-quarrel",
  roomId: "room-1",
  workflowId: "discussion-quarrel-1",
  workflowRevision: 1,
  status: "running",
  triggerType: "manual",
  startedBy: "user",
  startedAt: "2026-10-15T00:00:00Z",
  workflow: {
    schemaVersion: 1,
    id: "discussion-quarrel-1",
    roomId: "room-1",
    revision: 1,
    status: "active",
    goal: "增长还是利润？",
    trigger: { type: "manual" },
    steps: [
      { id: "round-1-speaker-1", type: "agent", agentId: "agent.a", task: "a" },
      { id: "round-1-speaker-2", type: "agent", agentId: "agent.b", task: "b" },
    ],
    createdAt: "2026-10-15T00:00:00Z",
    createdBy: "user",
  },
  steps: {
    "round-1-speaker-1": { status: "succeeded" },
    "round-1-speaker-2": { status: "running" },
  },
  inputs: {
    discussion: {
      mode: "quarrel",
      maxRounds: 1,
      participantIds: ["agent.a", "agent.b"],
      positions: {},
      roles: { "agent.a": "张三", "agent.b": "李四" },
      styles: {},
      summaryAgentId: null,
    },
  },
};

describe("DiscussionRunMessage", () => {
  it("preserves quarrel mode on the run card", () => {
    render(<DiscussionRunMessage run={QUARREL_RUN} />);

    expect(screen.getByText("Quarrel")).toBeInTheDocument();
    expect(screen.queryByText("Open discussion")).not.toBeInTheDocument();
    expect(screen.getByText("增长还是利润？")).toBeInTheDocument();
    expect(screen.getByText("A → 张三")).toBeInTheDocument();
    expect(screen.getByText("B → 李四")).toBeInTheDocument();
  });
});
