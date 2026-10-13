import { describe, expect, it } from "vitest";

import { buildComposerModelOptions, buildComposerProviderOptions } from "@/components/thread/ThreadShell";
import { modelKey } from "@/components/models/model-sources";
import type { DevExecutor } from "@/lib/development-api";
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

  it("adds native catalog models to ordinary chat while keeping same-named sources distinct", () => {
    const settings = {
      agent: { provider: "example", model: "shared", executor: "mona", native_model: null },
      chat_providers: [{
        name: "example", label: "Example API", configured: true,
        models: [{ id: "shared", name: "API Shared", enabled: true }],
      }],
    } as SettingsPayload;
    const codex: DevExecutor = {
      id: "codex", name: "Codex", available: true, reason: "已连接",
      probe: { state: "ready", authentication: "ready", authMode: "chatgpt", reason: "已连接" },
      models: [{ id: "shared", label: "原生 Shared", contextWindow: 128_000 }],
    };

    const options = buildComposerModelOptions(settings, [codex]);
    const api = options.find((option) => option.provider === "example");
    const native = options.find((option) => option.provider === "native:codex");

    expect(api).toMatchObject({ model: "shared", label: "API Shared", active: true });
    expect(native).toMatchObject({
      model: "shared", label: "原生 Shared", executor: "codex", active: false,
      contextWindow: 128_000, disabledReason: null,
    });
    expect(modelKey(api!)).not.toBe(modelKey(native!));
  });

  it("uses the saved native source as active and disables options without ready authentication", () => {
    const settings = {
      agent: { provider: "example", model: "shared", executor: "codex", native_model: "shared", native_reasoning_effort: "high" },
      chat_providers: [{ name: "example", label: "Example API", configured: true,
        models: [{ id: "shared", name: "API Shared", enabled: true }] }],
    } as SettingsPayload;
    const codex: DevExecutor = {
      id: "codex", name: "Codex", available: true, reason: "",
      probe: { state: "detected", authentication: "required", reason: "请连接账号" },
      models: [{ id: "shared", label: "原生 Shared", reasoningEfforts: ["low", "high"] }, { id: "", label: "执行者默认模型" }],
    };

    const options = buildComposerModelOptions(settings, [codex]);

    expect(options.find((option) => option.provider === "example")).toMatchObject({ active: false });
    expect(options).toHaveLength(2);
    expect(options.find((option) => option.executor === "codex")).toMatchObject({
      active: true, reasoningEffort: "high", disabledReason: "请连接账号",
    });
  });
});
