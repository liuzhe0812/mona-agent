import { describe, expect, it } from "vitest";

import { enrichWithTerminalContext } from "./AIChat";

describe("desktop terminal AI binding", () => {
  it("forces terminal tools even before the terminal buffer has output", () => {
    const prompt = enrichWithTerminalContext("输入 ls", "desktop-1", {
      getBuffer: () => "",
    });

    expect(prompt).toContain("当前终端会话：desktop-1");
    expect(prompt).toContain("禁止使用 exec");
    expect(prompt).toContain("terminal_exec");
  });
});
