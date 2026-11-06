import { describe, expect, it } from "vitest";

import { buildComposerProviderOptions } from "@/components/models/model-options";
import { workContextUsage } from "@/lib/context-usage";
import type { SettingsPayload, UIMessage } from "@/lib/types";

describe("hosted Codex capabilities", () => {
  it("keeps each model's saved effort distinct from its official default", () => {
    const settings = {
      agent: { provider: "openai", model: "two", reasoning_effort: "medium" },
      chat_providers: [{ name: "openai", label: "OpenAI", configured: true, models: [
        { id: "one", name: "One", enabled: true, reasoning_efforts: ["low", "high"],
          reasoning_effort: "high", default_reasoning_effort: "low", context_window: 234567 },
        { id: "two", name: "Two", enabled: true, reasoning_efforts: ["medium", "high"],
          reasoning_effort: "medium", default_reasoning_effort: "high" },
      ] }],
    } as SettingsPayload;
    const options = buildComposerProviderOptions(settings);
    expect(options.find((item) => item.model === "one")).toMatchObject({
      active: false, reasoningEffort: "high", defaultReasoningEffort: "low", contextWindow: 234567,
    });
    expect(options.find((item) => item.model === "two")).toMatchObject({
      active: true, reasoningEffort: "medium", defaultReasoningEffort: "high",
    });
  });

  it("uses a returned window only for the matching model and provider", () => {
    const usage = { contextTokens: 100, contextWindowTokens: 234567, contextModel: "one", contextProvider: "openai" };
    expect(workContextUsage([], null, "one", usage as UIMessage["tokenUsage"], "openai"))
      .toEqual({ used: 100, total: 234567 });
    expect(workContextUsage([], null, "two", usage as UIMessage["tokenUsage"], "openai"))
      .toEqual({ used: 100, total: null });
    expect(workContextUsage([], null, "one", usage as UIMessage["tokenUsage"], "mona_managed"))
      .toEqual({ used: 100, total: null });
  });
});
