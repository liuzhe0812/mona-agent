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

  it("limits startup handoffs to a reversible enabled-state change", () => {
    const prompt = buildSystemAgentHandoffPrompt({
      id: "disable-wechat",
      title: "禁用 WeChat 启动项",
      action: "禁用启动项",
      target: "WeChat",
      arguments: { id: "reg:HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\WeChat", enabled: false },
      error: "access denied",
    });

    expect(prompt).toContain("只允许切换现有启动项的启用状态");
    expect(prompt).toContain("不得删除注册表 Run 值、快捷方式或计划任务");
    expect(prompt).toContain("不得以删除代替禁用");
    expect(prompt).toContain("可通过 enabled=true 恢复");
  });
});
