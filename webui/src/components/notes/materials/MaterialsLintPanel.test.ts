import { describe, expect, it } from "vitest";

import { classifyMaterialsLintIssues } from "./MaterialsLintPanel";
import type { MaterialsLintIssue } from "@/lib/materials-api";

function issue(
  rule: string,
  details: Record<string, unknown>,
): MaterialsLintIssue {
  return {
    rule,
    severity: "warning",
    path: `text/${rule}.md`,
    message: rule,
    label: rule,
    details,
  };
}

describe("materials health classification", () => {
  it("only treats extraction errors with a non-empty source as automatic", () => {
    const auto = issue("text-extract-error", { status: "error", source: "docs/a.pdf" });
    const unsupported = issue("text-extract-error", { status: "unsupported", source: "docs/b.xyz" });
    const missingSource = issue("text-extract-error", { status: "error" });
    const semantic = issue("stale-page", { sources: ["docs/a.pdf"] });

    const result = classifyMaterialsLintIssues([auto, unsupported, missingSource, semantic]);

    expect(result.autoFixable).toEqual([auto]);
    expect(result.needsReview).toEqual([unsupported, missingSource, semantic]);
  });
});
