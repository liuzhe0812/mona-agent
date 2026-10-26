import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  browser: vi.fn(),
  opener: vi.fn(),
  message: vi.fn(),
}));

vi.mock("@/lib/browser-ipc", () => ({ openBrowserUrl: calls.browser }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: calls.opener }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: calls.message }));

import { openEmailLink } from "./emailLinks";

beforeEach(() => {
  calls.browser.mockReset().mockResolvedValue(undefined);
  calls.opener.mockReset().mockResolvedValue(undefined);
  calls.message.mockReset().mockResolvedValue(undefined);
});

describe("openEmailLink", () => {
  it.each([
    ["http://example.com/message", "http://example.com/message"],
    ["https://example.com/message?id=42", "https://example.com/message?id=42"],
  ])("opens web links in Mona's browser: %s", async (url, expected) => {
    await openEmailLink(url);

    expect(calls.browser).toHaveBeenCalledWith(expected);
    expect(calls.opener).not.toHaveBeenCalled();
    expect(calls.message).not.toHaveBeenCalled();
  });

  it.each(["mailto:help@example.com?subject=Question", "tel:+15551234567"])(
    "opens system links with the opener plugin: %s",
    async (url) => {
      await openEmailLink(url);

      expect(calls.opener).toHaveBeenCalledWith(url);
      expect(calls.browser).not.toHaveBeenCalled();
      expect(calls.message).not.toHaveBeenCalled();
    },
  );

  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd"])(
    "rejects unsafe protocols without opening them: %s",
    async (url) => {
      await openEmailLink(url);

      expect(calls.browser).not.toHaveBeenCalled();
      expect(calls.opener).not.toHaveBeenCalled();
      expect(calls.message).toHaveBeenCalledWith("链接未能打开，请重试", {
        title: "打开链接失败",
        kind: "error",
      });
    },
  );

  it("shows a generic dialog when opening fails without exposing the URL or error", async () => {
    calls.browser.mockRejectedValueOnce(new Error("secret-token-in-error"));
    const url = "https://example.com/?access_token=secret-token";

    await openEmailLink(url);

    expect(calls.message).toHaveBeenCalledTimes(1);
    expect(calls.message).toHaveBeenCalledWith("链接未能打开，请重试", {
      title: "打开链接失败",
      kind: "error",
    });
    expect(JSON.stringify(calls.message.mock.calls)).not.toContain("secret-token");
    expect(JSON.stringify(calls.message.mock.calls)).not.toContain("secret-token-in-error");
  });
});
