import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  computeFlowchartDocumentHash,
  computeFlowchartSemanticHash,
  createBlankFlowchartDocument,
  extractSemanticGraph,
  validateFlowchartDocument,
  type FlowchartDocument,
  type FlowchartNode,
} from "./flowchart-document";
import {
  applyFlowchartPatch,
  routeFlowchartEdges,
  type FlowchartPatch,
} from "./flowchart-patch";
import { inspectFlowchartQuality } from "./flowchart-quality";
import { flowchartNodeAbsolutePosition } from "./flowchart-operations";

function nodeGeometry(doc: FlowchartDocument): Array<{
  id: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
}> {
  return doc.nodes.map((node) => ({
    id: node.id,
    position: { ...node.position },
    ...(node.size ? { size: { ...node.size } } : {}),
  }));
}

function absoluteBox(doc: FlowchartDocument, node: FlowchartNode) {
  const position = flowchartNodeAbsolutePosition(doc.nodes, node.id) ?? node.position;
  const size = node.size ?? { width: 140, height: 48 };
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

function segmentIntersectsBox(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: { x: number; y: number; width: number; height: number },
): boolean {
  const left = box.x;
  const right = box.x + box.width;
  const top = box.y;
  const bottom = box.y + box.height;
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const checks: Array<[number, number]> = [
    [-dx, a.x - left],
    [dx, right - a.x],
    [-dy, a.y - top],
    [dy, bottom - a.y],
  ];
  for (const [p, q] of checks) {
    if (p === 0 && q < 0) return false;
    if (p === 0) continue;
    const ratio = q / p;
    if (p < 0) t0 = Math.max(t0, ratio);
    else t1 = Math.min(t1, ratio);
    if (t0 > t1) return false;
  }
  return true;
}

function anchorForNode(node: FlowchartNode, handle: string | undefined) {
  const box = {
    x: node.position.x,
    y: node.position.y,
    width: node.size?.width ?? 140,
    height: node.size?.height ?? 48,
  };
  const side = handle?.split("-")[0];
  if (side === "top") return { x: box.x + box.width / 2, y: box.y };
  if (side === "bottom") return { x: box.x + box.width / 2, y: box.y + box.height };
  if (side === "left") return { x: box.x, y: box.y + box.height / 2 };
  return { x: box.x + box.width, y: box.y + box.height / 2 };
}

describe("官方 Demo 级画布回归约束", () => {
  it("官方 Transformer L0 fixture 可编辑、结构有效且静态质量检查通过", () => {
    const file = resolve(process.cwd(), "../tests/fixtures/canvas/transformer-official-demo-l0.json");
    const doc = JSON.parse(readFileSync(file, "utf8")) as FlowchartDocument;
    expect(validateFlowchartDocument(doc)).toEqual({ ok: true });
    expect(doc.canvas).toMatchObject({ mode: "page", width: 768, height: 690 });
    expect(doc.nodes.filter((node) => node.kind === "group").map((node) => node.label).sort()).toEqual(["DECODER", "ENCODER"]);
    expect(doc.nodes.filter((node) => node.parentId === "encoder")).toHaveLength(4);
    expect(doc.nodes.filter((node) => node.parentId === "decoder")).toHaveLength(6);
    expect(doc.edges.find((edge) => edge.id === "e-encoder-output")?.style).toMatchObject({
      stroke: "#FF5C62",
      strokeDasharray: "dashed",
      labelColor: "#FF5C62",
    });
    expect(inspectFlowchartQuality(doc)).toEqual([]);
  });

  it("改一个节点文字颜色时保持全部边数据和所有节点几何不变", () => {
    const source = createBlankFlowchartDocument();
    source.direction = "TB";
    source.nodes = [
      { id: "step-a", kind: "process", label: "开始", position: { x: 120, y: 40 }, size: { width: 160, height: 64 } },
      { id: "step-b", kind: "process", label: "处理", position: { x: 120, y: 200 }, size: { width: 160, height: 64 } },
      { id: "step-c", kind: "process", label: "结束", position: { x: 120, y: 360 }, size: { width: 160, height: 64 } },
    ];
    source.edges = [
      { id: "edge-a-b", source: "step-a", target: "step-b" },
      { id: "edge-b-c", source: "step-b", target: "step-c" },
    ];
    const edgeSnapshot = source.edges.map((edge) => JSON.stringify(edge));
    const geometrySnapshot = nodeGeometry(source);
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{
        name: "updateNode",
        id: "step-b",
        expectedLabel: "处理",
        patch: { style: { color: "#DC2626" } },
      }],
    };

    const result = applyFlowchartPatch(source, patch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges.map((edge) => JSON.stringify(edge))).toEqual(edgeSnapshot);
    expect(nodeGeometry(result.document)).toEqual(geometrySnapshot);
    expect(result.document.nodes.find((node) => node.id === "step-b")?.style?.color).toBe("#DC2626");
  });

  it("自动布局会在有界页面内压缩层间距并保持可读节点尺寸", () => {
    const source = createBlankFlowchartDocument();
    source.canvas = {
      mode: "page",
      width: 1000,
      height: 750,
      orientation: "landscape",
      background: "#FFFFFF",
      grid: { visible: true, snap: true, size: 16 },
    };
    const nodes = Array.from({ length: 9 }, (_, index) => ({
      id: `step-${index}`,
      kind: index === 0 ? "start" as const : index === 8 ? "end" as const : index === 3 || index === 5 ? "decision" as const : "process" as const,
      label: `步骤 ${index}`,
      size: { width: 160, height: index === 3 || index === 5 ? 88 : 64 },
    }));
    const edges = Array.from({ length: 8 }, (_, index) => ({
      id: `edge-${index}`,
      source: `step-${index}`,
      target: `step-${index + 1}`,
    }));
    const result = applyFlowchartPatch(source, {
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{ name: "replaceGraph", graph: { direction: "TB", layout: "auto", nodes, edges } }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.canvas.width).toBeLessThanOrEqual(1600);
    expect(result.document.canvas.height).toBeLessThanOrEqual(1200);
    expect(result.document.nodes.every((node) => (node.size?.width ?? 0) >= 160)).toBe(true);
    expect(inspectFlowchartQuality(result.document).filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("带 AI 视觉分区的图 reflow 后成员仍在分区内且避开标题区", () => {
    const source = createBlankFlowchartDocument();
    source.direction = "TB";
    source.nodes = [
      {
        id: "encoder-region",
        kind: "group",
        label: "ENCODER",
        position: { x: 380, y: 150 },
        size: { width: 500, height: 134 },
        container: { type: "group" },
      },
      { id: "encoder-a", kind: "process", label: "Multi-Head Attention", parentId: "encoder-region", position: { x: 20, y: 50 }, size: { width: 160, height: 64 } },
      { id: "encoder-b", kind: "process", label: "Add & Norm", parentId: "encoder-region", position: { x: 320, y: 50 }, size: { width: 160, height: 64 } },
      { id: "outside", kind: "process", label: "Outside", position: { x: 40, y: 420 }, size: { width: 160, height: 64 } },
    ];
    source.edges = [{ id: "encoder-flow", source: "encoder-a", target: "encoder-b" }];
    const patch: FlowchartPatch = {
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{ name: "reflow", direction: "TB" }],
    };

    const result = applyFlowchartPatch(source, patch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const group = result.document.nodes.find((node) => node.id === "encoder-region");
    expect(result.document.nodes.filter((node) => node.parentId === group?.id).map((node) => node.id).sort()).toEqual([
      "encoder-a",
      "encoder-b",
    ]);
    if (!group?.size) return;

    const groupBox = absoluteBox(result.document, group);
    for (const memberId of ["encoder-a", "encoder-b"]) {
      const member = result.document.nodes.find((node) => node.id === memberId);
      expect(member).toBeDefined();
      if (!member) continue;
      const memberBox = absoluteBox(result.document, member);
      expect(memberBox.x).toBeGreaterThanOrEqual(groupBox.x + 16);
      expect(memberBox.y).toBeGreaterThanOrEqual(groupBox.y + 30 + 16);
      expect(memberBox.x + memberBox.width).toBeLessThanOrEqual(groupBox.x + groupBox.width - 16);
      expect(memberBox.y + memberBox.height).toBeLessThanOrEqual(groupBox.y + groupBox.height - 16);
    }
    expect(inspectFlowchartQuality(result.document).filter((issue) => issue.code.startsWith("group-"))).toEqual([]);
  });

  it("反馈路线的首段不得穿过非端点障碍节点", () => {
    const doc = createBlankFlowchartDocument();
    doc.direction = "TB";
    doc.nodes = [
      { id: "target", kind: "process", label: "Target", position: { x: 0, y: 0 }, size: { width: 160, height: 64 } },
      { id: "source", kind: "process", label: "Source", position: { x: 0, y: 240 }, size: { width: 160, height: 64 } },
      { id: "blocker", kind: "process", label: "Blocker", position: { x: 240, y: 240 }, size: { width: 160, height: 64 } },
    ];
    doc.edges = [{ id: "feedback", source: "source", target: "target" }];

    routeFlowchartEdges(doc);

    const edge = doc.edges[0];
    expect(edge.controlPoints).toHaveLength(2);
    if (!edge.controlPoints) return;
    const sourceNode = doc.nodes.find((node) => node.id === edge.source);
    const blocker = doc.nodes.find((node) => node.id === "blocker");
    expect(sourceNode).toBeDefined();
    expect(blocker).toBeDefined();
    if (!sourceNode || !blocker) return;
    const sourceAnchor = anchorForNode(sourceNode, edge.sourceHandle);
    expect(segmentIntersectsBox(sourceAnchor, edge.controlPoints[0], absoluteBox(doc, blocker))).toBe(false);
    expect(inspectFlowchartQuality(doc).some((issue) => issue.code === "edge-through-node")).toBe(false);
  });

  it("同心结构和自由图形可用通用视觉字段组合，而不污染流程语义", () => {
    const source = createBlankFlowchartDocument();
    source.canvas = {
      mode: "page",
      width: 768,
      height: 690,
      orientation: "portrait",
      background: "#FFFFFF",
      grid: { visible: false, snap: false, size: 16 },
    };
    const result = applyFlowchartPatch(source, {
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{
        name: "replaceGraph",
        graph: {
          direction: "TB",
          layout: "manual",
          nodes: [
            {
              id: "outer-ring",
              kind: "ellipse",
              label: "",
              position: { x: 54, y: 72 },
              size: { width: 660, height: 540 },
              zIndex: -2,
              opacity: 0.32,
              decorative: true,
              style: { fill: "#E8F3E7", borderColor: "#9CCB97", borderWidth: 1 },
            },
            {
              id: "inner-ring",
              kind: "ellipse",
              label: "",
              position: { x: 214, y: 186 },
              size: { width: 340, height: 310 },
              zIndex: -1,
              opacity: 0.5,
              decorative: true,
              style: { fill: "#DCEBFF", borderColor: "#6B96D4", borderStyle: "dashed" },
            },
            {
              id: "core",
              kind: "rounded-rectangle",
              label: "核心能力",
              position: { x: 294, y: 290 },
              size: { width: 180, height: 72 },
              style: { fill: "#1EA7E1", color: "#FFFFFF", bold: true },
            },
            {
              id: "accent",
              kind: "triangle",
              label: "",
              position: { x: 650, y: 30 },
              size: { width: 54, height: 54 },
              rotation: 30,
              zIndex: 2,
              decorative: true,
              style: { fill: "#FFE8C7", borderColor: "#D99500", borderWidth: 3 },
            },
          ],
          edges: [],
        },
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(extractSemanticGraph(result.document).nodes.map((node) => node.id)).toEqual(["core"]);
    expect(result.document.nodes.find((node) => node.id === "outer-ring")).toMatchObject({
      position: { x: 54, y: 72 },
      size: { width: 660, height: 540 },
      zIndex: -2,
      opacity: 0.32,
      decorative: true,
    });
    expect(result.document.nodes.find((node) => node.id === "accent")?.rotation).toBe(30);
    expect(inspectFlowchartQuality(result.document)).toEqual([]);
  });

  it("局部加入视觉图元时保留显式坐标且不改变语义哈希", () => {
    const source = createBlankFlowchartDocument();
    const semanticHash = computeFlowchartSemanticHash(source);
    const result = applyFlowchartPatch(source, {
      baseHash: semanticHash,
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{
        name: "addNode",
        node: {
          id: "cat-whisker",
          kind: "rectangle",
          label: "",
          position: { x: 412, y: 84 },
          size: { width: 62, height: 3 },
          rotation: 12,
          decorative: true,
        },
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes.find((node) => node.id === "cat-whisker")).toMatchObject({
      position: { x: 412, y: 84 },
      size: { width: 62, height: 3 },
    });
    expect(computeFlowchartSemanticHash(result.document)).toBe(semanticHash);
    expect(computeFlowchartDocumentHash(result.document)).not.toBe(computeFlowchartDocumentHash(source));
  });

  it("纯视觉图元不能被流程边连接", () => {
    const source = createBlankFlowchartDocument();
    const result = applyFlowchartPatch(source, {
      baseHash: computeFlowchartSemanticHash(source),
      baseDocumentHash: computeFlowchartDocumentHash(source),
      ops: [{
        name: "replaceGraph",
        graph: {
          direction: "LR",
          layout: "manual",
          nodes: [
            { id: "actor", kind: "process", label: "用户", position: { x: 30, y: 80 } },
            { id: "boundary", kind: "rectangle", label: "", position: { x: 250, y: 30 }, decorative: true },
          ],
          edges: [{ id: "invalid-edge", source: "actor", target: "boundary" }],
        },
      }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("纯视觉节点");
  });
});
