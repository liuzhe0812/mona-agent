import { describe, expect, it } from "vitest";

import { buildSystemAgentHandoffPrompt } from "./systemAgentHandoff";

describe("buildSystemAgentHandoffPrompt", () => {
  it("preserves the failed action, target, arguments, and raw error", () => {
    const prompt = buildSystemAgentHandoffPrompt({
      id: "uninstall-notepad",
      title: "卸载 Notepad++",
      action: "卸载软件",
      target: "Notepad++",
      arguments: { id: null, name: "Notepad++", installLocation: "C:\\Program Files\\Notepad++" },
      error: "WinGet exit code 1603",
    });

    expect(prompt).toContain("请直接接管并完成任务，而不是只说明步骤");
    expect(prompt).toContain("操作：卸载软件");
    expect(prompt).toContain("目标：Notepad++");
    expect(prompt).toContain('"installLocation":"C:\\\\Program Files\\\\Notepad++"');
    expect(prompt).toContain("错误：WinGet exit code 1603");
  });
});
