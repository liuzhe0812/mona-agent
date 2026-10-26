import { expect, it } from "vitest";
import { hiddenPathText } from "./StockVibeTeam";

it("hides local paths while preserving arithmetic, dates and source links", () => {
  const text = "(1312.97-1258.00)/1258.00; 1/5; 2026/10/15; https://example.com/source";
  expect(hiddenPathText(text)).toBe(text);
  expect(hiddenPathText("EVIDENCE_PATH=C:\\Users\\fixture\\evidence.md")).toBe("EVIDENCE_PATH=（本机路径已隐藏）");
  expect(hiddenPathText("read /tmp/private/evidence.md")).toBe("read （本机路径已隐藏）");
});
