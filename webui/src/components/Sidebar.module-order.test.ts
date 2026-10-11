import { describe, expect, it } from "vitest";

import { mergeSidebarModules } from "./Sidebar";

describe("mergeSidebarModules", () => {
  it("merges terminal and database without removing the development entry", () => {
    const legacyDefault = [
      "chat",
      "note",
      "doc",
      "ssh",
      "email",
      "schedule",
      "db",
      "system",
      "profile",
      "stock",
    ].map((key, order) => ({ key, visible: true, order }));

    expect(mergeSidebarModules(legacyDefault).map((module) => module.key)).toEqual([
      "chat",
      "development",
      "note",
      "doc",
      "email",
      "schedule",
      "db",
      "system",
      "profile",
      "stock",
    ]);
  });

  it("has one operations entry and preserves a hidden choice when both old entries were hidden", () => {
    const merged = mergeSidebarModules([{ key: "ssh", visible: false, order: 0 }, { key: "db", visible: false, order: 6 }]);
    expect(merged.filter((item) => item.key === "db")).toHaveLength(1);
    expect(merged.some((item) => item.key === "ssh")).toBe(false);
    expect(merged.find((item) => item.key === "db")?.visible).toBe(false);
  });

  it("keeps a user-customized module order unchanged", () => {
    const customized = [
      { key: "ssh", visible: true, order: 0 },
      { key: "chat", visible: true, order: 1 },
    ];

    expect(mergeSidebarModules(customized).slice(0, 2).map((module) => module.key)).toEqual([
      "db",
      "chat",
    ]);
  });
});
