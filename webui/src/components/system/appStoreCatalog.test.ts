import { describe, expect, it } from "vitest";

import { curatedApps } from "./appStoreCatalog";

describe("appStoreCatalog", () => {
  it("keeps a broad, unique catalog in every functional category", () => {
    expect(curatedApps.length).toBeGreaterThanOrEqual(150);
    expect(new Set(curatedApps.map((app) => app.id.toLocaleLowerCase())).size).toBe(curatedApps.length);

    for (const category of ["browser", "office", "social", "media", "utilities", "development", "creative", "games"] as const) {
      expect(curatedApps.filter((app) => app.category === category).length, category).toBeGreaterThanOrEqual(20);
    }
  });
});
