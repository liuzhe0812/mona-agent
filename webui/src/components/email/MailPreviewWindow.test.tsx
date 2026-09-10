import { describe, expect, it } from "vitest";

import { formatPreviewDate } from "./MailPreviewWindow";

describe("formatPreviewDate", () => {
  it("shows only a numeric local date without the email timezone", () => {
    expect(formatPreviewDate("Sat, 12 Sep 2026 12:00:00 +0000")).toBe("2026-9-12");
  });

  it("returns an empty value for a missing or invalid date", () => {
    expect(formatPreviewDate("")).toBe("");
    expect(formatPreviewDate("not a date")).toBe("");
  });
});
