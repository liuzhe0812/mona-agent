import { describe, expect, it } from "vitest";
import { developmentContextUsage, workContextUsage } from "./context-usage";
import type { DevEvent, DevSession } from "./development-api";
import type { UIMessage } from "./types";

const session = { executor: "codex", model: "model-a", modelProvider: null } as DevSession;
const event = (sequence: number, payload: Record<string, unknown>, type = "usage.updated"): DevEvent => ({ id: String(sequence), sequence, type, runId: "run", payload });
const message = (usage: Partial<NonNullable<UIMessage["tokenUsage"]>>) => ({ role: "assistant", tokenUsage: { promptTokens: 500000, completionTokens: 2000, cachedTokens: 0, totalTokens: 502000, ...usage } }) as UIMessage;

describe("context occupancy", () => {
  it("uses the latest measurement including zero and the runtime window in Work", () => {
    expect(workContextUsage([message({ contextTokens: 20000, contextWindowTokens: 100000, contextModel: "a" })], 1000000, "a")).toEqual({ used: 20000, total: 100000 });
    expect(workContextUsage([message({ contextTokens: 0 })], 100000, "a")).toEqual({ used: 0, total: 100000 });
    expect(workContextUsage([message({})], 100000, "a")).toBeNull();
  });
  it("does not carry a previous model's window or delegated agent usage into Work", () => {
    expect(workContextUsage([message({ contextTokens: 20000, contextWindowTokens: 100000, contextModel: "a" })], 200000, "b")).toEqual({ used: 20000, total: 200000 });
    expect(workContextUsage([{ ...message({ contextTokens: 99999 }), jobId: "job" }], 200000, "a")).toBeNull();
    expect(workContextUsage([message({ contextTokens: 20000, contextWindowTokens: 100000, contextModel: "a", contextProvider: "first" })], 200000, "a", undefined, "second")).toEqual({ used: 20000, total: 200000 });
  });
  it("replays latest Code usage instead of cumulative billing, allowing compaction to reduce it", () => {
    const events = [event(2, { contextTokens: 20000, contextWindow: 258400 }), event(1, { contextTokens: 100000, contextWindow: 258400 }), event(3, { usage: { input_tokens: 900000 } })];
    expect(developmentContextUsage(events, session, 1000000)).toEqual({ used: 20000, total: 258400 });
    expect(developmentContextUsage([...events, event(4, {}, "context.compacted")], session, null)).toBeNull();
  });
  it("keeps unknown windows unknown and rejects a different model route", () => {
    expect(developmentContextUsage([event(1, { contextTokens: 20000 })], session, null)).toEqual({ used: 20000, total: null });
    expect(developmentContextUsage([event(1, { contextTokens: 20000, selectedModel: "model-b" })], session, null)).toBeNull();
    expect(developmentContextUsage([event(1, { contextTokens: 20000, modelProvider: "other" })], session, null)).toBeNull();
  });
});
