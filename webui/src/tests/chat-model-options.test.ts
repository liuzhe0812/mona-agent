import { describe, expect, it } from "vitest";

import { buildComposerProviderOptions } from "@/components/thread/ThreadShell";
import type { SettingsPayload } from "@/lib/types";

describe("chat model options", () => {
  it("uses only enabled chat models and keeps the active provider first", () => {
    const settings = {
      agent: { provider: "aliyun-bailian-coding", model: "qwen3.7-plus" },
      providers: [
        { name: "agnes", label: "Agnes AI", configured: true, model: null },
        { name: "dashscope_coding_plan", label: "百炼 Coding Plan", configured: true, model: "qwen3.7-plus" },
      ],
      chat_providers: [
        {
          name: "zen",
          label: "内置供应商",
          configured: true,
          is_builtin: true,
          models: [
            { id: "hy3-free", name: "hy3-free", enabled: true },
            { id: "mimo-v2.5-free", name: "mimo-v2.5-free", enabled: false },
          ],
        },
        {
          name: "aliyun-bailian-coding",
          label: "阿里云百炼 Coding Plan（包月）",
          configured: true,
          models: [{ id: "qwen3.7-plus", name: "Qwen 3.7 Plus", enabled: true }],
        },
      ],
    } as SettingsPayload;

    expect(buildComposerProviderOptions(settings)).toEqual([
      {
        provider: "aliyun-bailian-coding",
        providerLabel: "阿里云百炼 Coding Plan（包月）",
        model: "qwen3.7-plus",
        label: "Qwen 3.7 Plus",
        free: false,
        active: true,
      },
      {
        provider: "zen",
        providerLabel: "内置供应商",
        model: "hy3-free",
        label: "hy3",
        free: true,
        active: false,
      },
    ]);
  });
});
