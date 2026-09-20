import { describe, expect, it } from "vitest";
import {
  buildAgentActionPrompt,
  buildFlowchartFreeformPrompt,
  buildFreeformAgentPrompt,
  inferNoteActionDisplayLabel,
} from "@/components/notes/notes-ai";
import { computeNoteBaseHash } from "@/components/notes/note-apply";
import type { OperationNote } from "@/components/notes/notes-data";
import { createConversationCanvasNote, conversationCanvasBaseHash } from "@/components/canvas/conversation-canvas";

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

describe("note freeform patch contract", () => {
  it("携带 baseHash 与结构化修改规则，同时保持可推断显示标签的结构", () => {
    const baseHash = computeNoteBaseHash(note.contentMarkdown);
    const prompt = buildFreeformAgentPrompt(note, "把结论改成留存下降 5%", baseHash);

    expect(prompt).toContain("```note-patch");
    expect(prompt).toContain("```note-replace");
    expect(prompt).toContain(`"baseHash":"${baseHash}"`);
    expect(prompt).toContain(`- 正文哈希：${baseHash}`);
    expect(inferNoteActionDisplayLabel(prompt)).toBe("把结论改成留存下降 5%");
  });

  it("未提供 baseHash 时不注入修改规则", () => {
    const prompt = buildFreeformAgentPrompt(note, "总结一下");

    expect(prompt).not.toContain("note-patch");
    expect(inferNoteActionDisplayLabel(prompt)).toBe("总结一下");
  });
});

describe("flowchart AI quality contract", () => {
  it("exposes visual blueprint, groups, pools and full document conflict protection", () => {
    const canvas = createConversationCanvasNote("flowchart", "系统架构图", "chat-1");
    const prompt = buildFlowchartFreeformPrompt(
      canvas,
      "绘制带分区和图标的系统架构图",
      null,
      conversationCanvasBaseHash(canvas),
    );

    expect(prompt).toContain('"baseDocumentHash"');
    expect(prompt).toContain('"style"');
    expect(prompt).toContain('"icon"');
    expect(prompt).toContain('"groups"');
    expect(prompt).toContain('"pools"');
    expect(prompt).toContain('"reflow"');
    expect(prompt).toContain("反馈边走图形外侧");
    expect(prompt).not.toContain("新节点不要输出 position、size");
  });
});
