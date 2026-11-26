import { describe, expect, it } from "vitest";

import { buildComposerProviderOptions } from "./model-options";
import type { SettingsPayload } from "@/lib/types";

describe("API model metadata", () => {
  it("applies a known resolved window only to its matching active route", () => {
    const model = { id: "shared-id", name: "Friendly Model", enabled: true, context_window: null,
      reasoning_efforts: ["low", "high"], default_reasoning_effort: "low" };
    const settings = {
      agent: { executor: "mona", provider: "custom-one", model: model.id, reasoning_effort: "high",
        context_window_source: "discovered", context_window_tokens: 196_608 },
      chat_providers: [
        { name: "custom-one", label: "One", configured: true, models: [model] },
        { name: "custom-two", label: "Two", configured: true, models: [model] },
      ],
    } as SettingsPayload;

    const options = buildComposerProviderOptions(settings);
    expect(options.find((option) => option.provider === "custom-one")).toMatchObject({
      label: "Friendly Model", active: true, contextWindow: 196_608,
      reasoningEfforts: ["low", "high"], reasoningEffort: "high", defaultReasoningEffort: "low",
    });
    expect(options.find((option) => option.provider === "custom-two")?.contextWindow).toBeNull();

    settings.agent.context_window_source = "default";
    expect(buildComposerProviderOptions(settings)[0].contextWindow).toBeNull();
    settings.agent.context_window_source = "reference";
    expect(buildComposerProviderOptions(settings)[0]).toMatchObject({ contextWindow: 196_608, contextWindowSource: "reference" });
    settings.agent.context_window_source = "discovered";
    settings.agent.executor = "codex";
    expect(buildComposerProviderOptions(settings)[0].contextWindow).toBeNull();
  });
});
