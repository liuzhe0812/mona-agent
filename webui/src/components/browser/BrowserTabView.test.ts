import { describe, expect, it } from "vitest";

import { sameWebviewBounds } from "./BrowserTabView";

describe("sameWebviewBounds", () => {
  it("deduplicates identical visible bounds", () => {
    const bounds = { left: 10, top: 20, width: 800, height: 600, visible: true };

    expect(sameWebviewBounds(bounds, { ...bounds })).toBe(true);
    expect(sameWebviewBounds(bounds, { ...bounds, visible: false })).toBe(false);
  });
});
