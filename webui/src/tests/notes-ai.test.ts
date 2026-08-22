import { describe, expect, it } from "vitest";
import { buildAgentActionPrompt } from "@/components/notes/notes-ai";
import type { OperationNote } from "@/components/notes/notes-data";

const note: OperationNote = {
  id: "note-1",
  notebookId: "notebook-1",
  title: "产品复盘",
  preview: "复盘内容",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  source: { kind: "manual", label: "手动" },
  contentMarkdown: "# 产品复盘\n\n内容",
};

describe("note AI artifact paths", () => {
  it("writes generated HTML to the active workspace notes directory", () => {
    const prompt = buildAgentActionPrompt("generateHtml", note, "notes/source.md");

    expect(prompt).toContain("当前工作区的 notes/ 子目录");
    expect(prompt).not.toContain(".mona/output");
  });

  it("uses the same workspace-relative path without a source file", () => {
    const prompt = buildAgentActionPrompt("generateHtml", note);

    expect(prompt).toContain("当前工作区的 notes/ 子目录");
    expect(prompt).not.toContain(".mona/output");
  });
});
