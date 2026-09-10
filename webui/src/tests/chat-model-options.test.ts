import { describe, expect, it } from "vitest";

import { buildComposerProviderOptions } from "@/components/thread/ThreadShell";
import type { SettingsPayload } from "@/lib/types";

describe("chat model options", () => {
  it("uses only enabled chat models and keeps the active provider first", () => {
    const settings = {
      agent: { provider: "aliyun-bailian-coding", model: "qwen3.7-plus", reasoning_effort: "high" },
      providers: [
        { name: "agnes", label: "Agnes AI", configured: true, model: null },
        { name: "dashscope_coding_plan", label: "百炼 Coding Plan", configured: true, model: "qwen3.7-plus" },
      ],
      chat_providers: [
        {
          name: "mona_managed",
          label: "Mona AI",
          configured: true,
          is_builtin: true,
          models: [{
            id: "deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            enabled: true,
            description: "编程主力",
            context_window: 1_000_000,
            tags: ["编程", "快速"],
            price_tier: "经济",
            reasoning_efforts: ["medium", "high", "max"],
            default_reasoning_effort: "high",
          }],
        },
        {
          name: "aliyun-bailian-coding",
          label: "阿里云百炼 Coding Plan（包月）",
          configured: true,
          models: [{ id: "qwen3.7-plus", name: "Qwen 3.7 Plus", enabled: true }],
        },
      ],
    } as SettingsPayload;

    const options = buildComposerProviderOptions(settings, [{
      model: "deepseek-v4-flash",
      input_amount_per_million: "1",
      cached_input_amount_per_million: "0.02",
      output_amount_per_million: "2",
      promotion_label: "↓50%",
      promotion_name: "新用户限时优惠",
      discount_percent: 50,
      original_input_amount_per_million: "2",
      original_cached_input_amount_per_million: "0.04",
      original_output_amount_per_million: "4",
    }]);
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
        provider: "aliyun-bailian-coding",
        providerLabel: "阿里云百炼 Coding Plan（包月）",
        model: "qwen3.7-plus",
        label: "Qwen 3.7 Plus",
        active: true,
    });
    expect(options[1]).toMatchObject({
        provider: "mona_managed",
        providerLabel: "Mona AI",
        model: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        active: false,
        isBuiltin: true,
        description: "编程主力",
        contextWindow: 1_000_000,
        priceTier: "经济",
        reasoningEffort: "high",
        inputAmountPerMillion: "1",
        cachedInputAmountPerMillion: "0.02",
        outputAmountPerMillion: "2",
        promotionLabel: "↓50%",
        promotionName: "新用户限时优惠",
        discountPercent: 50,
        originalInputAmountPerMillion: "2",
        originalCachedInputAmountPerMillion: "0.04",
        originalOutputAmountPerMillion: "4",
    });
  });

  it("excludes enabled image and video models from the composer picker", () => {
    const settings = {
      agent: { provider: "custom-media", model: "qwen" },
      chat_providers: [
        {
          name: "custom-media",
          label: "自建媒体",
          is_custom: true,
          configured: true,
          models: [
            { id: "qwen", name: "Qwen", type: "chat", enabled: true },
            { id: "z-image", name: "Z Image", type: "image", enabled: true },
            { id: "h3-video", name: "H3 Video", type: "video", enabled: true },
          ],
        },
      ],
    } as SettingsPayload;

    expect(buildComposerProviderOptions(settings).map((option) => option.model)).toEqual(["qwen"]);
  });
});
