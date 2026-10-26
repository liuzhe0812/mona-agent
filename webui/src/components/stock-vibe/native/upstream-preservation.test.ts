import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import manifest from "./upstream-source-manifest.json";
const root = path.dirname(fileURLToPath(import.meta.url));
it("retains the selected original calculation and formatting functions with recorded source fingerprints", () => {
  for (const item of manifest.unchanged_functions) {
    const file = path.join(root, item.destination), source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const node = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === item.name);
    expect(node, `${item.destination}:${item.name}`).toBeDefined();
    expect(createHash("sha256").update(node!.getText(source).replace(/\r\n/g, "\n")).digest("hex"), `${item.destination}:${item.name}`).toBe(item.sha256);
  }
  expect(readFileSync(path.join(root, "UPSTREAM_LICENSE"), "utf8")).toContain("Copyright (c) 2026 Vibe-Trading Contributors");
  const adapter = readFileSync(path.join(root, "lib/api.ts"), "utf8");
  expect(adapter).not.toMatch(/\/live\/|\/brokers\/|localhost|127\.0\.0\.1|EventSource/);
});
