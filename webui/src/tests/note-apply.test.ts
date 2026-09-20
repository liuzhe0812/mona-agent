import { describe, expect, it } from "vitest";
import {
  applyNotePatch,
  applyPendingNotePatch,
  computeNoteBaseHash,
  hasStructuredNoteEdit,
  parseNotePatch,
  prepareNotePatch,
  type NotePatch,
} from "@/components/notes/note-apply";

const CONTENT = "# 产品复盘\n\n## 结论\n\n留存下降。\n\n## 原因\n\n新手引导流失。\n";

function patchReply(payload: unknown, prefix = ""): string {
  return `${prefix}\`\`\`note-patch\n${JSON.stringify(payload)}\n\`\`\``;
}

describe("note-patch 应用", () => {
  it("baseHash 匹配且 find 唯一时 dry-run 出目标正文", () => {
    const baseHash = computeNoteBaseHash(CONTENT);
    const reply = patchReply(
      { baseHash, edits: [{ find: "留存下降。", replace: "留存下降 5%。" }] },
      "已经改好了。\n\n",
    );

    const result = prepareNotePatch(reply, CONTENT, "m1", baseHash);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pending.status).toBe("ready");
    expect(result.pending.mode).toBe("patch");
    expect(result.pending.proposedMarkdown).toContain("留存下降 5%。");
    expect(result.pending.proposedMarkdown).not.toContain("留存下降。");
    expect(result.pending.summary).toEqual({ edited: 1 });
  });

  it("支持多条 edits 按顺序应用，replace 为空即删除", () => {
    const baseHash = computeNoteBaseHash(CONTENT);
    const patch: NotePatch = {
      baseHash,
      edits: [
        { find: "## 原因\n\n新手引导流失。\n", replace: "" },
        { find: "# 产品复盘", replace: "# 产品复盘（更新）" },
      ],
    };

    const result = applyNotePatch(CONTENT, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edited).toBe(2);
    expect(result.markdown).not.toContain("新手引导流失");
    expect(result.markdown).toContain("# 产品复盘（更新）");
  });

  it("find 不存在时整次修改不生效", () => {
    const baseHash = computeNoteBaseHash(CONTENT);
    const result = applyNotePatch(CONTENT, {
      baseHash,
      edits: [{ find: "不存在的片段", replace: "x" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("未在笔记正文中找到");
  });

  it("find 不唯一时拒绝应用，避免改错位置", () => {
    const baseHash = computeNoteBaseHash(CONTENT);
    const result = applyNotePatch(CONTENT, {
      baseHash,
      edits: [{ find: "##", replace: "###" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("无法定位");
  });

  it("AI 回填错误 baseHash 时拒绝应用并标记过期", () => {
    const reply = patchReply({
      baseHash: "h-stale",
      edits: [{ find: "留存下降。", replace: "留存下降 5%。" }],
    });

    const result = prepareNotePatch(reply, CONTENT, "m1", computeNoteBaseHash(CONTENT));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pending.status).toBe("stale");
    expect(result.pending.proposedMarkdown).toBe(CONTENT);
  });
});

describe("note-replace 与普通回答", () => {
  it("解析整篇重写 block，保留内含代码围栏", () => {
    const body = "# 新标题\n\n```js\nconsole.log(1);\n```\n";
    const reply = `\`\`\`note-replace\n${body}\`\`\`\n`;
    const baseHash = computeNoteBaseHash(CONTENT);

    const result = prepareNotePatch(reply, CONTENT, "m1", baseHash);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pending.mode).toBe("replace");
    expect(result.pending.status).toBe("ready");
    expect(result.pending.proposedMarkdown).toBe(body.trim());
  });

  it("普通回答不产生修改建议", () => {
    const result = prepareNotePatch(
      "这篇笔记主要在讲留存下降的原因。",
      CONTENT,
      "m1",
      computeNoteBaseHash(CONTENT),
    );
    expect(result.ok).toBe(false);
    expect(hasStructuredNoteEdit("这篇笔记主要在讲留存下降的原因。")).toBe(false);
  });

  it("识别结构化修改指令", () => {
    expect(hasStructuredNoteEdit(patchReply({ baseHash: "h1", edits: [] }))).toBe(true);
    expect(hasStructuredNoteEdit("```note-replace\n# 新正文\n```")).toBe(true);
  });
});

describe("applyPendingNotePatch", () => {
  it("patch 模式在笔记被改动后拒绝应用", () => {
    const baseHash = computeNoteBaseHash(CONTENT);
    const reply = patchReply({
      baseHash,
      edits: [{ find: "留存下降。", replace: "留存下降 5%。" }],
    });
    const prepared = prepareNotePatch(reply, CONTENT, "m1", baseHash);
    if (!prepared.ok) throw new Error("prepare 失败");

    const applied = applyPendingNotePatch(prepared.pending, `${CONTENT}\n新增一行\n`);
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.notice).toContain("应用失败");
  });

  it("replace 模式由用户确认后直接使用 dry-run 结果", () => {
    const baseHash = computeNoteBaseHash(CONTENT);
    const reply = "```note-replace\n# 全新正文\n```";
    const prepared = prepareNotePatch(reply, CONTENT, "m1", baseHash);
    if (!prepared.ok) throw new Error("prepare 失败");

    const applied = applyPendingNotePatch(prepared.pending, `${CONTENT}\n新增一行\n`);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.markdown).toBe("# 全新正文");
    expect(applied.notice).toBe("已重写笔记正文");
  });

  it("已应用过的 pending 不再重复应用", () => {
    const baseHash = computeNoteBaseHash(CONTENT);
    const prepared = prepareNotePatch(
      patchReply({ baseHash, edits: [{ find: "留存下降。", replace: "x" }] }),
      CONTENT,
      "m1",
      baseHash,
    );
    if (!prepared.ok) throw new Error("prepare 失败");

    const first = applyPendingNotePatch(prepared.pending, CONTENT);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const again = applyPendingNotePatch({ ...prepared.pending, status: "applied" }, first.markdown);
    expect(again.ok).toBe(false);
  });
});

describe("parseNotePatch", () => {
  it("拒绝缺少 edits 或 find 的载荷", () => {
    expect(parseNotePatch("not-json").ok).toBe(false);
    expect(parseNotePatch(JSON.stringify({ baseHash: "h1" })).ok).toBe(false);
    expect(
      parseNotePatch(JSON.stringify({ baseHash: "h1", edits: [{ replace: "x" }] })).ok,
    ).toBe(false);
  });

  it("接受合法载荷", () => {
    const parsed = parseNotePatch(
      JSON.stringify({ baseHash: "h1", edits: [{ find: "a", replace: "" }] }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patch.edits[0]).toEqual({ find: "a", replace: "" });
  });
});
