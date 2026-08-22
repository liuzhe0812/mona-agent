import { beforeEach, describe, expect, it, vi } from "vitest";

import { generateNote } from "./api";

describe("generateNote", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("uses the tool-free note generation endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({ content: "# 笔记" }),
    } as Response);

    await expect(generateNote("token", "网页正文", "http://gateway")).resolves.toBe("# 笔记");
    expect(fetch).toHaveBeenCalledWith(
      "http://gateway/api/notes/generate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prompt: "网页正文" }),
      }),
    );
  });

  it("surfaces the server error instead of only the HTTP status", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => "application/json" },
      json: async () => ({ error: "LLM provider 不可用" }),
    } as Response);

    await expect(generateNote("token", "网页正文", "http://gateway"))
      .rejects.toThrow("LLM provider 不可用");
  });
});
