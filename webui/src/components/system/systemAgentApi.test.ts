import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

import { collectSystemDiagnosticEvidence, collectSystemEvidence, executeSystemAction, type SystemAgentAction } from "./systemAgentApi";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "clean_storage") return Promise.resolve({ freedGb: 1.25, cleanedIds: ["temp"], failures: [] });
    if (command === "system_get_overview") return Promise.resolve({ cpu: {}, memory: {}, disks: [], network: {}, topProcesses: [] });
    if (command === "system_check_updates") return Promise.resolve({ updates: [], wingetAvailable: true, failedCount: 0 });
    if (command === "system_list_startup_items") return Promise.resolve({
      items: [{ id: "wechat", name: "WeChat", publisher: "Tencent", source: "注册表", scope: "user", command: "C:\\WeChat\\WeChat.exe", targetPath: "C:\\WeChat\\WeChat.exe", added: "2024/05/12", enabled: true, signed: true, firstSeenAt: 1715472000, isNew: false }],
      total: 1,
      enabledCount: 1,
      disabledCount: 0,
    });
    if (command === "system_get_maintenance_history") return Promise.resolve({ events: [] });
    if (command.startsWith("system_check_")) return Promise.resolve({
      id: command.replace("system_check_", ""),
      status: "clear",
      summary: "检查完成",
      detail: "只读结果",
    });
    return Promise.resolve();
  }),
}));

describe("executeSystemAction", () => {
  it("maps a planned cleanup to the backend allowlist command", async () => {
    const action: SystemAgentAction = {
      id: "action-1",
      type: "storage_clean",
      targetIds: ["temp"],
      targetNames: ["临时文件"],
      title: "清理临时文件",
      reason: "可安全释放空间",
      risk: "low",
      evidenceTab: "storage",
    };

    const result = await executeSystemAction(action);

    expect(invoke).toHaveBeenCalledWith("clean_storage", { ids: ["temp"] });
    expect(result.success).toBe(true);
    expect(result.detail).toContain("1.25 GB");
  });

  it("rechecks WinGet after a planned software update", async () => {
    const action: SystemAgentAction = {
      id: "action-2",
      type: "software_update",
      targetIds: ["Google.Chrome.EXE"],
      targetNames: ["Google Chrome"],
      title: "更新 Google Chrome",
      reason: "存在安全更新",
      risk: "medium",
      evidenceTab: "software",
    };

    const result = await executeSystemAction(action);

    expect(invoke).toHaveBeenCalledWith("system_upgrade_software", { id: "Google.Chrome.EXE", name: "Google Chrome" });
    expect(invoke).toHaveBeenCalledWith("system_check_updates");
    expect(result.verified).toBe(true);
  });

  it("never falls back to disabling startup items for an unsupported action", async () => {
    const action = {
      id: "unexpected-action",
      type: "unsupported",
      targetIds: ["wechat"],
      targetNames: ["WeChat"],
      title: "Unknown action",
      reason: "test",
      risk: "low",
      evidenceTab: "startup",
    } as unknown as SystemAgentAction;

    await expect(executeSystemAction(action)).rejects.toThrow("不支持的系统操作");
    expect(invoke).not.toHaveBeenCalledWith("system_toggle_startup_item", { id: "wechat", enabled: false });
  });
});

describe("collectSystemEvidence", () => {
  it("keeps only the startup fields required for planning", async () => {
    const evidence = await collectSystemEvidence(null);

    expect(evidence.startup.items[0]).toMatchObject({
      added: "2024/05/12",
      firstSeenAt: 1715472000,
      isNew: false,
    });
    expect(evidence.startup.items[0]).not.toHaveProperty("command");
    expect(evidence.startup.items[0]).not.toHaveProperty("targetPath");
  });
});

describe("collectSystemDiagnosticEvidence", () => {
  it("uses symptom-specific native checks instead of repeating dashboard collection", async () => {
    vi.mocked(invoke).mockClear();
    const progress: string[] = [];

    const evidence = await collectSystemDiagnosticEvidence("network", (stage, state) => {
      progress.push(`${stage}:${state}`);
    });

    expect(evidence.checks.map((check) => check.id)).toEqual(["network_configuration", "pending_reboot", "component_health"]);
    expect(invoke).toHaveBeenCalledWith("system_check_network_configuration");
    expect(invoke).toHaveBeenCalledWith("system_check_pending_reboot");
    expect(invoke).toHaveBeenCalledWith("system_check_component_health");
    expect(invoke).not.toHaveBeenCalledWith("system_get_overview");
    expect(progress.filter((item) => item.endsWith(":completed"))).toHaveLength(3);
  });
});
