import { describe, expect, it } from "vitest";

import { buttonVariants } from "@/components/ui/button";

describe("buttonVariants", () => {
  it("uses the neutral action treatment for the default button", () => {
    const classes = buttonVariants({ variant: "default" });

    expect(classes).toContain("bg-action");
    expect(classes).toContain("text-action-foreground");
    expect(classes).not.toContain("shadow-surface");
    expect(classes).not.toContain("text-white");
    expect(classes).toContain("text-caption");
  });

  it("keeps outline and ghost backgrounds semantic and neutral", () => {
    for (const variant of ["outline", "ghost"] as const) {
      const classes = buttonVariants({ variant });

      expect(classes).toContain("hover:bg-accent");
      expect(classes).not.toMatch(/bg-(blue|info|primary|theme)/);
    }
  });

  it("provides a low-emphasis interaction treatment for repeated actions", () => {
    const classes = buttonVariants({ variant: "interaction" });

    expect(classes).toContain("mona-interaction-button");
    expect(classes).toContain("border");
    expect(classes).not.toContain("bg-action");
  });

  it("provides a visible soft-danger button for repeated destructive actions", () => {
    const classes = buttonVariants({ variant: "dangerSoft" });

    expect(classes).toContain("border-destructive/25");
    expect(classes).toContain("bg-destructive/[0.06]");
    expect(classes).toContain("text-destructive");
    expect(classes).not.toContain("bg-destructive text-destructive-foreground");
  });
});
