import { describe, expect, it } from "vitest";

import {
  dailyDistributionToWeekdays,
  hourlyToDistribution,
  normalizeOutputStyle,
  outputStyleLabel,
} from "./profile-theme";

describe("profile work-pattern data contracts", () => {
  it("aggregates ISO date keys into Monday-first weekdays", () => {
    expect(dailyDistributionToWeekdays({
      "2026-08-31": 4, // Monday
      "2026-09-02": 3, // Wednesday
      "2026-09-05": 2, // Saturday
      "2026-09-06": 1, // Sunday
    })).toEqual([4, 0, 3, 0, 0, 2, 1]);
  });

  it("keeps compatibility with the legacy Monday-first weekday keys", () => {
    expect(dailyDistributionToWeekdays({ "0": 4, "5": 2, "6": 1 })).toEqual([4, 0, 0, 0, 0, 2, 1]);
  });

  it("keeps hourly data on one dimension without fabricating weekdays", () => {
    const distribution = hourlyToDistribution({ "9": 12, "23": 3 });

    expect(distribution).toHaveLength(24);
    expect(distribution[9]).toEqual({ hour: 9, count: 12 });
    expect(distribution[23]).toEqual({ hour: 23, count: 3 });
    expect(distribution.filter(({ count }) => count > 0)).toHaveLength(2);
  });

  it.each([
    ["concise", "concise"],
    ["简洁", "concise"],
    ["detailed", "detailed"],
    ["详细", "detailed"],
    ["adaptive", "adaptive"],
    ["自适应", "adaptive"],
  ])("normalizes %s output style to %s", (value, expected) => {
    expect(normalizeOutputStyle(value)).toBe(expected);
    expect(outputStyleLabel(value)).toBe(
      expected === "concise" ? "简洁" : expected === "detailed" ? "详细" : "自适应",
    );
  });

  it("preserves unknown output-style values and handles missing values", () => {
    expect(normalizeOutputStyle("custom")).toBeNull();
    expect(outputStyleLabel("custom")).toBe("custom");
    expect(outputStyleLabel(undefined)).toBe("未知");
  });
});
