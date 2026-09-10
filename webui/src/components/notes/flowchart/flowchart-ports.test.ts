import { describe, expect, it } from "vitest";
import { cloneFlowchartDocument, computeFlowchartDocumentHash, computeFlowchartSemanticHash, createBlankFlowchartDocument, parseFlowchartMarkdown, serializeFlowchartMarkdown } from "./flowchart-document";
import {
  decodeFlowchartHandleId,
  encodeFlowchartHandleId,
  flowchartPortPoint,
} from "./flowchart-ports";

describe("flowchart fractional ports", () => {
  it("round-trips an internal handle ID without changing the document handle", () => {
    const encoded = encodeFlowchartHandleId("left-source", 0.3);
    expect(encoded).toBe("left-source:0.3");
    expect(decodeFlowchartHandleId(encoded)).toEqual({ handle: "left-source", port: 0.3 });
  });

  it("places a port along the selected side and centers omitted ports", () => {
    expect(flowchartPortPoint({ x: 10, y: 20, width: 200, height: 100 }, "top-target", 0.25, "target"))
      .toEqual({ x: 60, y: 20 });
    expect(flowchartPortPoint({ x: 10, y: 20, width: 200, height: 100 }, undefined, undefined, "source"))
      .toEqual({ x: 110, y: 120 });
  });

  it("preserves fractional ports through saving and cloning without changing semantic identity", () => {
    const doc = createBlankFlowchartDocument();
    doc.edges = [{ id: "edge", source: "n-start", target: "n-end", sourceHandle: "bottom-source", targetHandle: "top-target" }];
    const semantic = computeFlowchartSemanticHash(doc);
    const version = computeFlowchartDocumentHash(doc);
    doc.edges[0].sourcePort = 0.3;
    doc.edges[0].targetPort = 0.7;
    const loaded = parseFlowchartMarkdown(serializeFlowchartMarkdown("图", doc));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.message);
    expect(cloneFlowchartDocument(loaded.document).edges[0]).toMatchObject({ sourcePort: 0.3, targetPort: 0.7 });
    expect(computeFlowchartSemanticHash(loaded.document)).toBe(semantic);
    expect(computeFlowchartDocumentHash(loaded.document)).not.toBe(version);
  });
});
