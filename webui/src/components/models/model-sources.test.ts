import { beforeEach, describe, expect, it } from "vitest";
import { orderedSources, useModelPreferences } from "./model-sources";

beforeEach(() => {
  useModelPreferences.setState({ hiddenNative: [], providerOrder: [] });
});

describe("orderedSources", () => {
  it("keeps the default primary-first order until a saved order exists", () => {
    expect(orderedSources([
      "custom-b", "anthropic", "openai", "custom-a", "native:codebuddy", "mona_managed", "new-source",
    ], [])).toEqual([
      "mona_managed", "openai", "anthropic", "native:codebuddy", "custom-b", "custom-a", "new-source",
    ]);
  });

  it("applies the saved full order and appends unknown current sources", () => {
    expect(orderedSources(
      ["mona_managed", "openai", "anthropic", "custom-a", "custom-b", "new-source"],
      ["anthropic", "custom-b", "stale-source", "mona_managed", "anthropic"],
    )).toEqual(["anthropic", "custom-b", "mona_managed", "openai", "custom-a", "new-source"]);
  });

  it("keeps legacy custom-only order after the original primary sources", () => {
    expect(orderedSources(
      ["mona_managed", "openai", "anthropic", "custom-a", "custom-b", "new-source"],
      ["custom-b", "custom-a"],
    )).toEqual(["mona_managed", "openai", "anthropic", "custom-b", "custom-a", "new-source"]);
  });
});

describe("moveProvider", () => {
  it("moves within the complete current order and retains native visibility preferences", () => {
    useModelPreferences.setState({ hiddenNative: ["hidden-model"], providerOrder: ["old-a", "old-b"] });

    useModelPreferences.getState().moveProvider("openai", "custom-b", [
      "mona_managed", "openai", "anthropic", "native:codebuddy", "custom-a", "custom-b", "new-source",
    ]);

    expect(useModelPreferences.getState().providerOrder).toEqual([
      "mona_managed", "anthropic", "native:codebuddy", "custom-a", "openai", "custom-b", "new-source",
    ]);
    expect(useModelPreferences.getState().hiddenNative).toEqual(["hidden-model"]);
  });

  it("keeps the two-argument custom reorder API compatible with existing callers", () => {
    useModelPreferences.setState({ providerOrder: ["custom-b", "custom-a"] });

    useModelPreferences.getState().moveProvider("custom-a", "custom-b");

    expect(useModelPreferences.getState().providerOrder).toEqual(["custom-a", "custom-b"]);
  });
});
