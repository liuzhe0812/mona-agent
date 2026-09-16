import { describe, expect, it } from "vitest";

import { deriveNoteTitle } from "./note-title";

describe("deriveNoteTitle", () => {
  it("removes Markdown syntax from the first meaningful line", () => {
    expect(deriveNoteTitle("\n## **你的质疑直击核心！**\n\n正文"))
      .toBe("你的质疑直击核心！");
    expect(deriveNoteTitle("- [房颤分析](https://example.com)\n\n正文"))
      .toBe("房颤分析");
  });

  it("skips structural lines and keeps the body unchanged", () => {
    const markdown = "```\n# 代码说明\n```";

    expect(deriveNoteTitle(markdown)).toBe("代码说明");
    expect(markdown).toBe("```\n# 代码说明\n```");
  });

  it("uses the fallback when no meaningful text exists", () => {
    expect(deriveNoteTitle("\n---\n", "备用标题")).toBe("备用标题");
  });
});
