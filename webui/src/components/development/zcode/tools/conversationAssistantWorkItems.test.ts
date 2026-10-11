import { describe, expect, it } from "vitest";
import type { Activity } from "../DevelopmentActivity";
import type { WorkRow } from "../types";
import { buildAssistantWorkRenderItems } from "./conversationAssistantWorkItems";

function toolRow(
  rowId: string,
  kind: string,
  input: unknown,
  state: Activity["state"] = "returned",
  extra: Partial<Activity> = {},
): WorkRow {
  return {
    rowId,
    kind: "toolCall",
    activity: {
      id: `activity:${rowId}`,
      sequence: 0,
      label: kind,
      description: "",
      output: "",
      paths: [],
      state,
      truncated: false,
      kind,
      input,
      ...extra,
    },
  };
}

describe("buildAssistantWorkRenderItems", () => {
  it("keeps pending shells without commands and empty reasoning from splitting Explore", () => {
    const first = toolRow("session:run:read", "read_file", { path: "README.md" });
    const waitingShell = toolRow("session:run:waiting", "exec", {}, "pending", {
      inputStreaming: true,
      inputText: "",
    });
    const emptyReasoning: WorkRow = {
      rowId: "session:run:empty-reasoning",
      kind: "reasoning",
      activity: {
        id: "reasoning-empty",
        sequence: 1,
        label: "思考",
        description: "",
        output: "",
        paths: [],
        state: "pending",
        truncated: false,
        reasoningText: "  ",
      },
    };
    const streamingShell = toolRow("session:run:rg", "exec", {}, "pending", {
      inputStreaming: true,
      inputText: '{"command":"rg --files',
    });

    const [group] = buildAssistantWorkRenderItems(
      [first, waitingShell, emptyReasoning, streamingShell],
      { stageTailIsRunning: true },
    );

    expect(group).toMatchObject({
      kind: "exploreGroup",
      key: "explore:session:run:read",
      rows: [{ rowId: "session:run:read" }, { rowId: "session:run:rg" }],
      node: {
        toolCall: { status: "in_progress", toolId: "explore:session:run:read" },
        childToolCalls: [
          { toolCall: { toolId: "session:run:read" } },
          { toolCall: { toolId: "session:run:rg", input: { command: "rg --files" } } },
        ],
      },
    });
  });

  it("anchors Execute identity to the first row and keeps cancelled child status", () => {
    const first = toolRow("session:run:first", "exec", { command: "npm run build" }, "cancelled");
    const second = toolRow("session:run:second", "exec", { command: "npm test" });
    const third = toolRow("session:run:third", "exec", { command: "npm run lint" });

    const two = buildAssistantWorkRenderItems([first, second]);
    const three = buildAssistantWorkRenderItems([first, second, third]);

    expect(two[0]).toMatchObject({
      kind: "executeGroup",
      key: "execute:session:run:first",
      node: {
        toolCall: { status: "stopped", toolId: "execute:session:run:first" },
        childToolCalls: [
          { toolCall: { status: "stopped", toolId: "session:run:first" } },
          { toolCall: { status: "completed", toolId: "session:run:second" } },
        ],
      },
    });
    expect(three[0]).toMatchObject({
      kind: "executeGroup",
      key: "execute:session:run:first",
      node: { childToolCalls: [{}, {}, {}] },
    });
  });
});
