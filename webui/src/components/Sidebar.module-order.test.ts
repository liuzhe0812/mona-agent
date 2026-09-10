import { describe, expect, it } from "vitest";

import { mergeSidebarModules } from "./Sidebar";

describe("mergeSidebarModules", () => {
  it("moves Terminal below Plans for users still on the old default order", () => {
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
      "note",
      "doc",
      "email",
      "schedule",
      "ssh",
      "db",
      "system",
      "profile",
      "stock",
    ]);
  });

  it("keeps a user-customized module order unchanged", () => {
    const customized = [
      { key: "ssh", visible: true, order: 0 },
      { key: "chat", visible: true, order: 1 },
    ];

    expect(mergeSidebarModules(customized).slice(0, 2).map((module) => module.key)).toEqual([
      "ssh",
      "chat",
    ]);
  });
});
