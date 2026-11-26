import { describe, expect, it } from "vitest";

import { LiveTokenSampler } from "./live-token-speed";

describe("LiveTokenSampler", () => {
  it("waits for two seconds and five estimated tokens, excluding the first burst", () => {
    const sampler = new LiveTokenSampler();
    sampler.push("这是一段很长的首个输出", 0);
    sampler.push("abcdefghijklmnop", 1_000);
    expect(sampler.rate(1_000)).toBeUndefined();
    sampler.push("efgh", 2_000);
    expect(sampler.rate(2_000)).toBe(2.5);
  });

  it("uses Unicode code points and is stable across ASCII chunk boundaries", () => {
    const sampler = new LiveTokenSampler();
    sampler.push("初始", 0);
    sampler.push("a", 1_000);
    sampler.push("bcd", 1_000);
    sampler.push("汉字😀 !", 2_000);
    expect(sampler.rate(2_000)).toBe(2.5);
  });

  it("keeps a five-second window and expires while output is paused", () => {
    const sampler = new LiveTokenSampler();
    sampler.push("起", 0);
    sampler.push("一二三四五六", 2_000);
    sampler.push("一二三四五六", 4_000);
    sampler.push("一二三四五六", 6_000);
    expect(sampler.rate(6_000)).toBe(3);
    expect(sampler.rate(11_001)).toBeUndefined();
  });

  it("starts a new sample window after a long gap or explicit reset", () => {
    const sampler = new LiveTokenSampler();
    sampler.push("开始", 0);
    sampler.push("一二三四五", 2_000);
    expect(sampler.rate(2_000)).toBe(2.5);
    sampler.push("重新开始", 8_000);
    expect(sampler.rate(8_000)).toBeUndefined();
    sampler.push("一二三四五", 10_000);
    expect(sampler.rate(10_000)).toBe(2.5);
    sampler.reset();
    expect(sampler.rate(10_000)).toBeUndefined();
  });

  it("coalesces closely spaced chunks without retaining a first-bucket burst", () => {
    const sampler = new LiveTokenSampler();
    sampler.push("第一段", 0);
    sampler.push("第一段补充", 50);
    sampler.push("一二三四五", 2_050);
    expect(sampler.rate(2_050)).toBe(2.5);
  });
});
