import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentSummary } from "@/lib/types";

const INTERNAL_AGENT: AgentSummary = {
  id: "com.mona.stock-tech-analyst",
  displayName: "Tech Analyst",
  enabled: true,
  visibility: "internal",
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
  WorkflowPanel: () => null,
}));

import { RoomContextPanel } from "./RoomContextPanel";

describe("RoomContextPanel (stock-module design §4.4)", () => {
  it("keeps internal members resolvable and tags them as team built-in", async () => {
    render(
      <RoomContextPanel
        chatId="room-1"
        conversation={{
          type: "room",
          title: "Stock research",
          agentIds: ["com.mona.stock-tech-analyst"],
          hidden: true,
        }}
      />,
    );

    expect(await screen.findByText("Tech Analyst")).toBeInTheDocument();
    expect(await screen.findByText("Built-in")).toBeInTheDocument();
  });
});
