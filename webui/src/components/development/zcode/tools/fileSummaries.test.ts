import { describe, expect, it } from "vitest";
import { readRawToolCallFileSummaries } from "./fileSummaries";

describe("readRawToolCallFileSummaries", () => {
  it("keeps multi-file action types, line counts, and patch text from native changes", () => {
    const summaries = readRawToolCallFileSummaries(
      {
        changes: {
          "src/changed.ts": {
            type: "update",
            oldText: "const before = 1;\n",
            newText: "const after = 1;\n",
          },
          "src/new.ts": {
            type: "add",
            newText: "export const added = true;\n",
          },
          "src/removed.ts": {
            type: "delete",
            oldText: "export const removed = true;\n",
          },
        },
      },
      { toolName: "edit_file", kind: "edit_file", input: {}, output: "" },
    );

    expect(summaries).toEqual([
      expect.objectContaining({
        path: "src/changed.ts",
        actionLabel: "Edited",
        operationKind: "update",
        changeStat: { added: 1, removed: 1 },
      }),
      expect.objectContaining({
        path: "src/new.ts",
        actionLabel: "Created",
        operationKind: "write",
        changeStat: { added: 1, removed: 0 },
      }),
      expect.objectContaining({
        path: "src/removed.ts",
        actionLabel: "Deleted",
        operationKind: "delete",
        changeStat: { added: 0, removed: 1 },
      }),
    ]);
    expect(summaries[0]?.patch).toContain("-const before = 1;");
    expect(summaries[0]?.patch).toContain("+const after = 1;");
  });
});
