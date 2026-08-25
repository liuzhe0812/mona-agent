import { describe, expect, it } from "vitest";

import { buttonVariants } from "@/components/ui/button";

describe("buttonVariants", () => {
  it("uses the neutral action treatment for the default button", () => {
    const classes = buttonVariants({ variant: "default" });

    expect(classes).toContain("bg-action");
    expect(classes).toContain("text-action-foreground");
    expect(classes).not.toContain("shadow-surface");
    expect(classes).not.toContain("text-white");
  });

  it("keeps outline and ghost backgrounds semantic and neutral", () => {
    for (const variant of ["outline", "ghost"] as const) {
      const classes = buttonVariants({ variant });

      expect(classes).toContain("hover:bg-accent");
      expect(classes).not.toMatch(/bg-(blue|info|primary|theme)/);
    }
  });
});
