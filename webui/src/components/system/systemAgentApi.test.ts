import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

import { collectSystemEvidence, executeSystemAction, type SystemAgentAction } from "./systemAgentApi";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "clean_storage") return Promise.resolve({ freedGb: 1.25, cleanedIds: ["temp"], failures: [] });
    if (command === "system_get_overview") return Promise.resolve({ cpu: {}, memory: {}, disks: [], network: {}, topProcesses: [] });
    if (command === "system_check_updates") return Promise.resolve({ updates: [], wingetAvailable: true, failedCount: 0 });
    if (command === "system_list_startup_items") return Promise.resolve({
      items: [{ id: "wechat", name: "WeChat", publisher: "Tencent", source: "注册表", scope: "user", command: "C:\\WeChat\\WeChat.exe", targetPath: "C:\\WeChat\\WeChat.exe", added: "2024/05/12", enabled: true, signed: true, firstSeenAt: 1715472000 }],
      total: 1,
      enabledCount: 1,
      disabledCount: 0,
    });
    if (command === "system_get_maintenance_history") return Promise.resolve({ events: [] });
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
});

describe("collectSystemEvidence", () => {
  it("keeps only the startup fields required for planning", async () => {
    const evidence = await collectSystemEvidence(null);

    expect(evidence.startup.items[0]).toMatchObject({
      added: "2024/05/12",
      firstSeenAt: 1715472000,
    });
    expect(evidence.startup.items[0]).not.toHaveProperty("command");
    expect(evidence.startup.items[0]).not.toHaveProperty("targetPath");
  });
});
