import { describe, expect, it } from "vitest";

import { buildInspectionCards, type InspectionInput } from "./inspectionModel";
import type { DiagnosticCheck, MaintenanceHistory } from "./useSystemData";

const NOW = 1_800_000_000_000;

function emptyInput(overrides: Partial<InspectionInput> = {}): InspectionInput {
  return {
    diagnostics: [],
    storage: null,
    software: null,
    startup: null,
    boot: null,
    maintenance: null,
    now: NOW,
    ...overrides,
  };
}

function attentionCheck(id: string, summary = "检测到异常"): DiagnosticCheck {
  return { id, status: "attention", summary, detail: "详情" };
}

function maintenance(events: MaintenanceHistory["events"]): MaintenanceHistory {
  return { events };
}

describe("buildInspectionCards", () => {
  it("returns an empty array when all sources are healthy", () => {
    expect(buildInspectionCards(emptyInput())).toEqual([]);
  });

  it("creates a warning card for each attention diagnostic without an action goal", () => {
    const cards = buildInspectionCards(emptyInput({
      diagnostics: [attentionCheck("pending_reboot", "检测到待重启状态")],
    }));

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "diagnostic:pending_reboot",
      tone: "warning",
      title: "待重启状态",
      detail: "检测到待重启状态",
      goal: null,
      tab: "overview",
    });
  });

  it("creates a cleanable storage card only above the minimum size", () => {
    const small = buildInspectionCards(emptyInput({
      storage: {
        disks: [], directories: [], fileTypes: [], totalScannedGb: 1,
        cleanupItems: [{ id: "temp", name: "临时文件", sizeGb: 0.05, cleanable: true, recommended: true, reason: "" }],
      } as unknown as InspectionInput["storage"],
    }));
    expect(small.find((card) => card.id === "storage")).toBeUndefined();

    const large = buildInspectionCards(emptyInput({
      storage: {
        disks: [], directories: [], fileTypes: [], totalScannedGb: 5,
        cleanupItems: [{ id: "temp", name: "临时文件", sizeGb: 2.5, cleanable: true, recommended: true, reason: "" }],
      } as unknown as InspectionInput["storage"],
    }));
    expect(large.find((card) => card.id === "storage")).toMatchObject({
      tone: "info",
      metric: "2.5 GB",
      goal: "释放磁盘可清理空间",
      actionLabel: "一键清理",
      tab: "storage",
    });
  });

  it("prioritizes diagnostics over storage over software and caps at three cards", () => {
    const cards = buildInspectionCards(emptyInput({
      diagnostics: [attentionCheck("pending_reboot")],
      storage: {
        disks: [], directories: [], fileTypes: [], totalScannedGb: 5,
        cleanupItems: [{ id: "temp", name: "临时文件", sizeGb: 3, cleanable: true, recommended: true, reason: "" }],
      } as unknown as InspectionInput["storage"],
      software: { updates: [{ id: "a", name: "App" }] } as InspectionInput["software"],
      startup: {
        items: [{ id: "s1", name: "NewApp", isNew: true }],
      } as InspectionInput["startup"],
      boot: { points: [], lastDurationMs: null, lastDeltaMs: 5_000 },
    }));

    expect(cards.map((card) => card.id)).toEqual(["diagnostic:pending_reboot", "storage", "software"]);
  });

  it("creates a startup review card listing new item names", () => {
    const cards = buildInspectionCards(emptyInput({
      startup: {
        items: [
          { id: "s1", name: "WeChat", isNew: true },
          { id: "s2", name: "OneDrive", isNew: false },
        ],
      } as InspectionInput["startup"],
    }));

    expect(cards[0]).toMatchObject({
      id: "startup",
      tone: "warning",
      detail: "WeChat",
      metric: "1 项",
      actionLabel: "一键审查",
      tab: "startup",
    });
  });

  it("creates a boot slowdown card only when delta exceeds the threshold", () => {
    const noCard = buildInspectionCards(emptyInput({
      boot: { points: [], lastDurationMs: null, lastDeltaMs: 2_000 },
    }));
    expect(noCard.find((card) => card.id === "boot")).toBeUndefined();

    const cards = buildInspectionCards(emptyInput({
      boot: { points: [], lastDurationMs: null, lastDeltaMs: 4_500 },
    }));
    expect(cards[0]).toMatchObject({
      id: "boot",
      metric: "慢 4.5 秒",
      goal: "分析开机变慢的原因",
      actionLabel: "一键诊断",
    });
  });

  it("shows a maintained success card when a category is healthy and recently maintained", () => {
    const cards = buildInspectionCards(emptyInput({
      maintenance: maintenance([{
        id: "m1", ts: (NOW - 2 * 86_400_000) / 1000, category: "清理", title: "清理 C 盘缓存",
        source: "用户操作", status: "成功", detail: "", bytesChanged: 0, reversible: false, relatedId: null, restoreEnabled: null,
      }]),
    }));

    const storageCard = cards.find((card) => card.id === "maintained:storage");
    expect(storageCard).toMatchObject({
      tone: "success",
      title: "存储空间状态良好",
      metric: "2 天前",
      goal: null,
      tab: "storage",
    });
  });

  it("does not show a maintained card when the category still has an issue", () => {
    const cards = buildInspectionCards(emptyInput({
      software: { updates: [{ id: "a", name: "App" }] } as InspectionInput["software"],
      maintenance: maintenance([{
        id: "m1", ts: (NOW - 86_400_000) / 1000, category: "更新", title: "更新 Chrome",
        source: "用户操作", status: "成功", detail: "", bytesChanged: 0, reversible: false, relatedId: null, restoreEnabled: null,
      }]),
    }));

    expect(cards.find((card) => card.id === "maintained:software")).toBeUndefined();
    expect(cards.find((card) => card.id === "software")).toBeTruthy();
  });

  it("shows the latest maintenance card with relative time", () => {
    const cards = buildInspectionCards(emptyInput({
      maintenance: maintenance([{
        id: "m1", ts: (NOW - 3 * 86_400_000) / 1000, category: "更新", title: "更新 Visual Studio Code",
        source: "用户操作", status: "成功", detail: "", bytesChanged: 0, reversible: false, relatedId: null, restoreEnabled: null,
      }]),
    }));

    const card = cards.find((item) => item.id === "maintenance");
    expect(card).toMatchObject({
      tone: "success",
      title: "最近维护",
      detail: "更新 Visual Studio Code",
      metric: "3 天前",
      tab: "maintenance",
    });
  });

  it("ignores maintenance events older than the recent window", () => {
    const cards = buildInspectionCards(emptyInput({
      maintenance: maintenance([{
        id: "m1", ts: (NOW - 10 * 86_400_000) / 1000, category: "清理", title: "清理 C 盘缓存",
        source: "用户操作", status: "成功", detail: "", bytesChanged: 0, reversible: false, relatedId: null, restoreEnabled: null,
      }]),
    }));

    expect(cards.find((card) => card.id === "maintenance")).toBeUndefined();
    expect(cards.find((card) => card.id === "maintained:storage")).toBeUndefined();
  });
});
