import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computeFlowchartDocumentHash,
  computeFlowchartSemanticHash,
  createBlankFlowchartDocument,
  validateFlowchartDocument,
} from "./flowchart-document";
import { applyFlowchartPatch, parseFlowchartPatch } from "./flowchart-patch";

describe("mona-canvas 完整样例", () => {
  for (const file of [
    "transformer-official-demo.patch.json",
    "layered-architecture.patch.json",
    "refund-swimlane.patch.json",
  ]) {
    it(`${file} 可由真实 patch 解析器应用`, () => {
      const path = resolve(
        process.cwd(),
        file.startsWith("transformer-")
          ? `../mona/skills/mona-canvas/assets/${file}`
          : `../mona/skills/mona-canvas/references/examples/${file}`,
      );
      const source = createBlankFlowchartDocument();
      const payload = JSON.parse(readFileSync(path, "utf8"));
      payload.baseHash = computeFlowchartSemanticHash(source);
      payload.baseDocumentHash = computeFlowchartDocumentHash(source);
      const parsed = parseFlowchartPatch(
        `\`\`\`mona-flowchart-patch\n${JSON.stringify(payload)}\n\`\`\``,
      );
      expect(parsed.ok, parsed.ok ? "" : parsed.message).toBe(true);
      if (!parsed.ok) return;

      const applied = applyFlowchartPatch(source, parsed.patch);
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(validateFlowchartDocument(applied.document)).toEqual({ ok: true });
      expect(applied.summary.qualityIssues?.filter((issue) => issue.severity === "error") ?? []).toEqual([]);
    });
  }
});
