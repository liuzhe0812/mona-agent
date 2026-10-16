import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

import {
  buildStorageAnalysisContext,
  buildStorageDirectoryAnalysisContext,
  buildStorageFileAnalysisContext,
  collectSystemEvidence,
  executeSystemAction,
  requestStorageAnalysis,
  requestSystemDiagnosis,
  requestSystemPlan,
  type SystemAgentAction,
  type StorageAnalysisEvidence,
  type SystemEvidence,
} from "./systemAgentApi";
import type { StorageScanResult } from "./useSystemData";

const httpFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ getGatewayHttpBase: vi.fn(() => Promise.resolve("http://mona.local")) }));
vi.mock("@/lib/tauri", () => ({ httpFetch: httpFetchMock }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) => {
    if (command === "clean_storage") return Promise.resolve({ freedGb: 1.25, cleanedIds: ["temp"], failures: [] });
    if (command === "system_upgrade_software") return Promise.resolve({ success: true, message: "更新完成", exitCode: 0, residuals: [] });
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
  it("includes the chosen directory identity and only cleanup evidence inside it", () => {
    const directory = {
      id: "dir-appdata", path: "C:\\Users\\PrivateUser\\AppData", sizeGb: 10, fileCount: 10, directSizeGb: 1,
      children: [{ id: "dir-local", path: "C:\\Users\\PrivateUser\\AppData\\Local", sizeGb: 8, fileCount: 8, directSizeGb: 8 }],
    };
    const storage: StorageScanResult = {
      scanId: "scan-dir", disks: [], directories: [directory], fileTypes: [], totalScannedGb: 20,
      topFiles: [
        { id: "file-inside", path: "C:\\Users\\PrivateUser\\AppData\\Local\\data.db", parentDirName: "Local", extension: "db", sizeGb: 1, modifiedBucket: "old" },
        { id: "file-outside", path: "C:\\Windows\\system.db", parentDirName: "Windows", extension: "db", sizeGb: 2, modifiedBucket: "old" },
      ],
      cleanupItems: [
        { id: "temp", name: "临时文件", sizeGb: 2, path: "C:\\Users\\PrivateUser\\AppData\\Local\\Temp", cleanable: true, recommended: true, reason: "缓存" },
        { id: "outside", name: "其他目录", sizeGb: 3, path: "C:\\Users\\PrivateUser\\AppData-old\\Temp", cleanable: true, recommended: true, reason: "缓存" },
        { id: "system", name: "系统缓存", sizeGb: 4, path: "C:\\Windows\\Cache", cleanable: true, recommended: true, reason: "缓存" },
      ],
      scanSummary: { scannedDisk: "C:", totalFiles: 10, totalDirs: 2, scanDurationSecs: 1, cancelled: true },
    };
    const { evidence } = buildStorageDirectoryAnalysisContext(storage, directory);
    expect(evidence.selectedDirectory).toEqual({ id: "dir-appdata", name: "AppData", location: "~", scanIncomplete: true, children: [{ id: "dir-local", name: "Local" }] });
    expect(evidence.scope).toMatchObject({ id: "dir-appdata", sizeGb: 10, directSizeGb: 1 });
    expect(evidence.cleanupItems.map((item) => item.id)).toEqual(["temp"]);
    expect(evidence.largeFiles.map((item) => item.id)).toEqual(["file-inside"]);
    expect(JSON.stringify(evidence)).not.toMatch(/PrivateUser|C:|AppData-old|Windows|"path"/);
    const userDirectory = { ...directory, path: "C:\\Users\\PrivateUser", children: [] };
    expect(buildStorageDirectoryAnalysisContext(storage, userDirectory).evidence.selectedDirectory?.name).toBe("用户目录");
  });

  it("includes only the explicitly selected file and removes its personal directory prefix", () => {
    const selected = { id: "file-db", path: "C:\\Users\\PrivateUser\\.codex\\thread_history.sqlite", parentDirName: ".codex", extension: "sqlite", sizeGb: 4.1, modifiedBucket: "recent" };
    const storage: StorageScanResult = {
      scanId: "scan-file", disks: [], directories: [], cleanupItems: [], fileTypes: [], totalScannedGb: 10,
      topFiles: [selected, { ...selected, id: "other-file", path: "C:\\private-other.zip" }],
    };
    const { evidence } = buildStorageFileAnalysisContext(storage, selected);
    expect(evidence.selectedFile).toEqual({ id: "file-db", name: "thread_history.sqlite", location: "~/.codex", extension: "sqlite", sizeGb: 4.1, modifiedBucket: "recent" });
    expect(evidence.largeFiles).toHaveLength(1);
    expect(evidence.scope.id).toBe("file-db");
    expect(evidence.children).toEqual([]);
    expect(evidence.cleanupItems).toEqual([]);
    expect(JSON.stringify(evidence)).not.toMatch(/PrivateUser|C:|private-other|"path"/);
  });

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

  it.each([
    [false, true],
    [true, false],
  ])("does not verify an update with success=%s and available recheck=%s", async (success, available) => {
    vi.mocked(invoke).mockResolvedValueOnce({ success, message: "更新未完成" });
    vi.mocked(invoke).mockResolvedValueOnce({ updates: [], wingetAvailable: available, failedCount: 0 });
    const action: SystemAgentAction = { id: "update-1", type: "software_update", targetIds: ["app-1"], targetNames: ["应用"], title: "更新应用", reason: "有可用更新", risk: "medium", evidenceTab: "software" };

    const result = await executeSystemAction(action);
    expect(result.verified).toBe(false);
  });

  it("builds path-free storage analysis evidence for the selected directory", () => {
    const storage: StorageScanResult = {
      scanId: "scan-1",
      disks: [],
      directories: [{
        id: "dir-secret",
        path: "C:\\Users\\Mona\\SecretProject",
        sizeGb: 10,
        fileCount: 12,
        directSizeGb: 2,
        insight: {
          artifactKind: "Node.js 依赖目录",
          fileTypes: [{ category: "其他", sizeGb: 10 }],
          modifiedBuckets: [{ bucket: "old", count: 2, sizeGb: 3 }],
          topExtensions: [{ extension: "zip", count: 2, sizeGb: 3 }],
        },
      }],
      cleanupItems: [{
        id: "temp-cleanup",
        name: "系统临时文件",
        sizeGb: 1.5,
        path: "C:\\Users\\Mona\\AppData\\Local\\Temp",
        cleanable: true,
        recommended: true,
        reason: "可重建的临时数据",
      }],
      fileTypes: [],
      totalScannedGb: 10,
      topFiles: [{
        id: "file-private",
        path: "C:\\Users\\Mona\\SecretProject\\private-backup.zip",
        parentDirName: "SecretProject",
        extension: "zip",
        sizeGb: 3,
        modifiedBucket: "old",
      }],
    };

    const context = buildStorageAnalysisContext(storage, storage.directories[0]);
    const serialized = JSON.stringify(context.evidence);

    expect(context.evidence.scope).toMatchObject({
      id: "dir-secret",
      artifactKind: "Node.js 依赖目录",
      directSizeGb: 2,
    });
    expect(context.evidence.largeFiles).toEqual([{
      id: "file-private",
      extension: "zip",
      sizeGb: 3,
      modifiedBucket: "old",
    }]);
    expect(context.evidence.cleanupItems).toEqual([{
      id: "temp-cleanup",
      name: "系统临时文件",
      sizeGb: 1.5,
      cleanable: true,
      reason: "可重建的临时数据",
    }]);
    expect(serialized).not.toContain("SecretProject");
    expect(serialized).not.toContain("private-backup.zip");
    expect(serialized).not.toContain("AppData");
    expect(serialized).not.toContain("path");
  });
});

describe("system analysis cancellation", () => {
  it.each([
    ["plan", requestSystemPlan],
    ["diagnose", requestSystemDiagnosis],
    ["storage/analyze", requestStorageAnalysis],
  ] as const)("passes the abort signal to %s", async (route, request) => {
    const controller = new AbortController();
    httpFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ summary: "完成", findings: [], actions: [], hypotheses: [], cautions: [] }) });
    const evidence = { scanId: "scan-1", scope: { id: "root" }, children: [], largeFiles: [], cleanupItems: [] };

    await request("分析当前状态", evidence as unknown as SystemEvidence & StorageAnalysisEvidence, controller.signal);

    expect(httpFetchMock).toHaveBeenLastCalledWith(
      `http://mona.local/api/system/${route}`,
      expect.objectContaining({ method: "POST", signal: controller.signal }),
    );
  });
});

describe("requestStorageAnalysis", () => {
  it("sends prior user and assistant text with the current question", async () => {
    const evidence: StorageAnalysisEvidence = {
      scanId: "scan-1",
      scope: {
        id: "dir-root",
        sizeGb: 10,
        fileCount: 12,
        directSizeGb: 1,
        artifactKind: null,
        fileTypes: [],
        modifiedBuckets: [],
        topExtensions: [],
      },
      children: [],
      largeFiles: [],
      cleanupItems: [],
    };
    const history = [
      { role: "user" as const, content: "C 盘空间不足。" },
      { role: "assistant" as const, content: "主要占用来自 Users。" },
    ];
    httpFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ scanId: "scan-1", summary: "说明如上。", findings: [], cautions: [] }),
    });

    await requestStorageAnalysis("这里能清理吗？", evidence, undefined, history);

    const [, request] = httpFetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(request.body)).toMatchObject({
      goal: "这里能清理吗？",
      evidence,
      history,
    });
  });

  it("uses the dedicated Gateway route and keeps only evidence-linked findings", async () => {
    const evidence: StorageAnalysisEvidence = {
      scanId: "scan-1",
      scope: {
        id: "dir-root",
        sizeGb: 10,
        fileCount: 12,
        directSizeGb: 1,
        artifactKind: null,
        fileTypes: [],
        modifiedBuckets: [],
        topExtensions: [],
      },
      children: [],
      largeFiles: [],
      cleanupItems: [],
    };
    httpFetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        scanId: "scan-1",
        summary: "扫描分析完成",
        findings: [{
          id: "storage-finding-1",
          title: "主要占用",
          detail: "当前范围占用较大。",
          confidence: "high",
          risk: "keep",
          evidenceIds: ["dir-root"],
          action: "none",
          targetIds: [],
          relatedSizeGb: 10,
        }, {
          id: "storage-finding-2",
          title: "虚构证据",
          detail: "不应进入界面。",
          confidence: "high",
          risk: "review",
          evidenceIds: ["not-scanned"],
          action: "inspect_directory",
          targetIds: ["not-scanned"],
          relatedSizeGb: 99,
        }],
        cautions: [],
      }),
    });

    const result = await requestStorageAnalysis("分析当前范围", evidence);

    expect(httpFetchMock).toHaveBeenCalledWith(
      "http://mona.local/api/system/storage/analyze",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].evidenceIds).toEqual(["dir-root"]);
  });
});


