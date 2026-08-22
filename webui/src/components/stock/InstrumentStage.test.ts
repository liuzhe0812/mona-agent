import { describe, expect, it } from "vitest";

import { horizonBrief, isCurrentIntradayEvent, reportHorizonComparison, summarizeReportComparison } from "./InstrumentStage";

describe("InstrumentStage intraday generation guard", () => {
  it("rejects events from an old generation or another instrument", () => {
    expect(isCurrentIntradayEvent(3, 3, "XSHE:000001", "XSHE:000001")).toBe(true);
    expect(isCurrentIntradayEvent(2, 3, "XSHE:000001", "XSHE:000001")).toBe(false);
    expect(isCurrentIntradayEvent(3, 3, "XSHE:000001", "XSHG:600519")).toBe(false);
  });
});

describe("InstrumentStage report comparison", () => {
  it("compresses identical three-horizon stances without compressing mixed stances", () => {
    expect(horizonBrief({
      shortTerm: { stance: "insufficient_data", status: "insufficient_data" },
      mediumTerm: { stance: "insufficient_data", status: "insufficient_data" },
      longTerm: { stance: "insufficient_data", status: "insufficient_data" },
    })).toBe("三周期均数据不足");
    expect(horizonBrief({
      shortTerm: { stance: "positive", status: "available" },
      mediumTerm: { stance: "neutral", status: "available" },
      longTerm: { stance: "negative", status: "available" },
    })).toBe("短看多 · 中中性 · 长看空");
  });

  it("compares V4 report-list horizon stances instead of the legacy composite stance", () => {
    const current = {
      kind: "deep_research",
      stance: null,
      horizonStances: {
        shortTerm: { stance: "positive", status: "available" },
        mediumTerm: { stance: "neutral", status: "available" },
        longTerm: { stance: "negative", status: "available" },
      },
    } as never;
    const previous = {
      kind: "deep_research",
      stance: null,
      horizonStances: {
        shortTerm: { stance: "neutral", status: "available" },
        mediumTerm: { stance: "neutral", status: "available" },
        longTerm: { stance: "negative", status: "available" },
      },
    } as never;

    expect(summarizeReportComparison([current, previous])).toBe("短线中性 → 看涨");
    expect(reportHorizonComparison([current, previous])).toMatchObject({ hasCurrentReport: true, hasPreviousReport: true });
  });
});
