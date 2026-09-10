import { describe, expect, it } from "vitest";
import { cloneFlowchartDocument, computeFlowchartDocumentHash, computeFlowchartSemanticHash, createBlankFlowchartDocument } from "./flowchart-document";
import { applyFlowchartPatch, parseFlowchartPatch, routeFlowchartEdges } from "./flowchart-patch";
import { inspectFlowchartQuality } from "./flowchart-quality";

function sharedSideDocument() {
  const doc = createBlankFlowchartDocument();
  doc.nodes = ["a", "b", "c", "d"].map((id, index) => ({
    id, kind: "process" as const, label: id,
    position: { x: 240, y: index * 160 }, size: { width: 160, height: 64 },
  }));
  doc.edges = [
    { id: "one", source: "a", target: "c" },
    { id: "two", source: "b", target: "d" },
    { id: "reverse", source: "c", target: "a" },
  ].map((edge) => ({ ...edge, sourceHandle: "left-source", targetHandle: "left-target" }));
  return doc;
}

describe("flowchart connection routing", () => {
  it("separates shared corridors and reverse edges without moving nodes or changing requested sides", () => {
    const doc = sharedSideDocument();
    const nodes = structuredClone(doc.nodes);
    routeFlowchartEdges(doc);
    expect(doc.nodes).toEqual(nodes);
    expect(doc.edges.every((edge) => edge.sourceHandle === "left-source" && edge.targetHandle === "left-target")).toBe(true);
    expect(inspectFlowchartQuality(doc).filter((issue) => ["edge-overlap", "duplicate-route", "edge-through-node"].includes(issue.code))).toEqual([]);
    const once = structuredClone(doc.edges);
    routeFlowchartEdges(doc);
    expect(doc.edges).toEqual(once);
  });

  it("reserves explicit waypoints and routes a local edit around existing edges", () => {
    const doc = sharedSideDocument();
    doc.edges[0] = {
      ...doc.edges[0], sourcePort: 0.3, targetPort: 0.3,
      controlPoints: [{ x: 200, y: 19.2 }, { x: 200, y: 339.2 }],
    };
    const explicit = structuredClone(doc.edges[0]);
    const untouched = structuredClone(doc.edges[2]);
    routeFlowchartEdges(doc, new Set(["two"]));
    expect(doc.edges[0]).toEqual(explicit);
    expect(doc.edges[2]).toEqual(untouched);
    expect(inspectFlowchartQuality(doc).filter((issue) => issue.code === "edge-overlap" && issue.edgeIds?.includes("two"))).toEqual([]);
  });

  it("accepts fractional ports as versioned geometry and rejects invalid fractions", () => {
    const doc = sharedSideDocument();
    const patch = {
      baseHash: computeFlowchartSemanticHash(doc), baseDocumentHash: computeFlowchartDocumentHash(doc),
      ops: [{ name: "updateEdge", id: "one", expected: { source: "a", target: "c" }, patch: { sourcePort: 0.3, targetPort: 0.7 } }],
    };
    const parsed = parseFlowchartPatch(`\`\`\`mona-flowchart-patch\n${JSON.stringify(patch)}\n\`\`\``);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    const result = applyFlowchartPatch(doc, parsed.patch);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.document.edges[0]).toMatchObject({ sourcePort: 0.3, targetPort: 0.7 });
    expect(computeFlowchartSemanticHash(result.document)).toBe(computeFlowchartSemanticHash(doc));
    expect(computeFlowchartDocumentHash(result.document)).not.toBe(computeFlowchartDocumentHash(doc));
    for (const port of [0, 1, -0.2, 1.2]) {
      patch.ops[0].patch.sourcePort = port;
      expect(parseFlowchartPatch(`\`\`\`mona-flowchart-patch\n${JSON.stringify(patch)}\n\`\`\``).ok).toBe(false);
    }
  });

  it("leaves all routes unchanged for a color-only patch", () => {
    const doc = sharedSideDocument();
    routeFlowchartEdges(doc);
    const expected = cloneFlowchartDocument(doc);
    const result = applyFlowchartPatch(doc, {
      baseHash: computeFlowchartSemanticHash(doc), baseDocumentHash: computeFlowchartDocumentHash(doc),
      ops: [{ name: "updateEdge", id: "one", expected: { source: "a", target: "c" }, patch: { style: { stroke: "#6F98C9" } } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expected.edges[0].style = { ...expected.edges[0].style, stroke: "#6F98C9" };
    expect(result.document).toEqual(expected);
  });
});
