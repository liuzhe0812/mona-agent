import { describe, expect, it } from "vitest";
import { modelPresentation } from "./model-presentation";

const fallback = { id: "custom", label: "自定义供应商" };

describe("modelPresentation", () => {
  it.each([
    ["deepseek/deepseek-v4-pro-0813", "deepseek", "深度求索", "DeepSeek V4 Pro 0813"],
    ["glm-5.3", "zhipu", "智谱", "GLM 5.3"],
    ["moonshot/kimi-k3", "moonshot", "月之暗面", "Kimi K3"],
    ["qwen/qwen3.7-plus", "alibaba", "阿里巴巴", "Qwen 3.7 Plus"],
    ["seed-2.1-pro", "bytedance", "字节跳动", "Seed 2.1 Pro"],
    ["gpt-5.6-sol", "openai", "OpenAI", "GPT 5.6 Sol"],
    ["claude-3-7-sonnet-2025-02-19", "anthropic", "Anthropic", "Claude 3.7 Sonnet 2025-02-19"],
    ["gemini/gemini-2.5-flash", "google", "Google", "Gemini 2.5 Flash"],
    ["minimax-m2.5", "minimax", "MiniMax", "MiniMax M2.5"],
    ["agnes/agnes-image-2.5-flash", "agnes", "Agnes", "Agnes Image 2.5 Flash"],
  ])("recognizes %s and makes its id readable", (id, brandId, brandLabel, name) => {
    const result = modelPresentation({ id, name: id }, fallback);

    expect(result).toMatchObject({ brandId, brandLabel, name });
    expect(result.icon).toBeTruthy();
  });

  it("formats Qwen ids and OpenAI o-series ids", () => {
    expect(modelPresentation({ id: "qwen3.7-plus", name: "qwen3.7-plus" }, fallback).name)
      .toBe("Qwen 3.7 Plus");
    expect(modelPresentation({ id: "o4-mini", name: "o4-mini" }, fallback).name)
      .toBe("o4 Mini");
  });

  it("preserves a backend display name", () => {
    expect(modelPresentation({ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro Preview" }, fallback).name)
      .toBe("DeepSeek V4 Pro Preview");
  });

  it("keeps unknown brands and names on their provider", () => {
    expect(modelPresentation({ id: "mystery-1", name: "mystery-1" }, fallback))
      .toEqual({ brandId: fallback.id, brandLabel: fallback.label, name: "mystery-1" });
  });
});
