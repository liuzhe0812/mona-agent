import { describe, expect, it } from "vitest";

import { cleanSessionPreview, isGenericMonaTitle } from "./session-preview";

describe("session preview display", () => {
  it("cleans markdown into a single-line preview", () => {
    expect(cleanSessionPreview("**完成**\n- 已生成 [报告](report.pdf)"))
      .toBe("完成 已生成 报告");
  });

  it("rejects generic Mona labels as task titles", () => {
    expect(isGenericMonaTitle("Mona", "Mona")).toBe(true);
    expect(isGenericMonaTitle("新对话", "Mona")).toBe(true);
    expect(isGenericMonaTitle("总结昨日 AI 晨报", "Mona")).toBe(false);
  });
});
