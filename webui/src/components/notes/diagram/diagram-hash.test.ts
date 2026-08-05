import { describe, expect, it } from "vitest";

import {
  createBlankDiagramDocument,
  createShapeElement,
  type DiagramDocument,
} from "./diagram-document";
import {
  computeDiagramDocumentHash,
  computeDiagramSemanticHash,
} from "./diagram-hash";

function docWithTwoShapes(): DiagramDocument {
  const doc = createBlankDiagramDocument("freeform");
  doc.elements = [
    createShapeElement("a", "rectangle", "甲", { x: 0, y: 0 }),
    createShapeElement("b", "diamond", "乙", { x: 200, y: 0 }),
  ];
  doc.connectors = [
    {
      id: "c1",
      source: { elementId: "a" },
      target: { elementId: "b" },
      route: "orthogonal",
      markerStart: "none",
      markerEnd: "arrow-closed",
      stroke: { color: "#333", width: 1.5, style: "solid" },
      zIndex: 0,
    },
  ];
  return doc;
}

describe("computeDiagramSemanticHash", () => {
  it("相同文档哈希一致且带 s 前缀", () => {
    const doc = docWithTwoShapes();
    const h1 = computeDiagramSemanticHash(doc);
    const h2 = computeDiagramSemanticHash(doc);
    expect(h1).toBe(h2);
    expect(h1.startsWith("s")).toBe(true);
  });

  it("移动节点位置不影响语义哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramSemanticHash(doc);
    doc.elements[0].position = { x: 999, y: 999 };
    expect(computeDiagramSemanticHash(doc)).toBe(before);
  });

  it("修改尺寸/旋转/图层/样式不影响语义哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramSemanticHash(doc);
    doc.elements[0].size = { width: 333, height: 111 };
    doc.elements[0].rotation = 45;
    doc.elements[0].zIndex = 99;
    if (doc.elements[0].type === "shape") {
      doc.elements[0].fill = { type: "solid", color: "#ff0000" };
    }
    expect(computeDiagramSemanticHash(doc)).toBe(before);
  });

  it("修改文本内容会改变语义哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramSemanticHash(doc);
    if (doc.elements[0].type === "shape") {
      doc.elements[0].textBlocks = [{ id: "t", kind: "paragraph", text: "新文本" }];
    }
    expect(computeDiagramSemanticHash(doc)).not.toBe(before);
  });

  it("修改连接关系会改变语义哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramSemanticHash(doc);
    doc.connectors[0].target = { point: { x: 1, y: 1 } };
    expect(computeDiagramSemanticHash(doc)).not.toBe(before);
  });

  it("修改连线样式/路由不影响语义哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramSemanticHash(doc);
    doc.connectors[0].route = "bezier";
    doc.connectors[0].stroke = { color: "#f00", width: 5, style: "dashed" };
    doc.connectors[0].markerEnd = "none";
    expect(computeDiagramSemanticHash(doc)).toBe(before);
  });

  it("元素数组顺序不影响语义哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramSemanticHash(doc);
    doc.elements.reverse();
    doc.connectors.reverse();
    expect(computeDiagramSemanticHash(doc)).toBe(before);
  });

  it("修改 semantic 字段会改变语义哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramSemanticHash(doc);
    doc.elements[0].semantic = { role: "start" };
    expect(computeDiagramSemanticHash(doc)).not.toBe(before);
  });
});

describe("computeDiagramDocumentHash", () => {
  it("相同文档哈希一致且带 d 前缀", () => {
    const doc = docWithTwoShapes();
    const h1 = computeDiagramDocumentHash(doc);
    const h2 = computeDiagramDocumentHash(doc);
    expect(h1).toBe(h2);
    expect(h1.startsWith("d")).toBe(true);
  });

  it("移动节点位置会改变完整文档哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramDocumentHash(doc);
    doc.elements[0].position = { x: 999, y: 999 };
    expect(computeDiagramDocumentHash(doc)).not.toBe(before);
  });

  it("修改样式会改变完整文档哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramDocumentHash(doc);
    if (doc.elements[0].type === "shape") {
      doc.elements[0].fill = { type: "solid", color: "#00ff00" };
    }
    expect(computeDiagramDocumentHash(doc)).not.toBe(before);
  });

  it("viewport 是查看状态，不参与完整文档哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramDocumentHash(doc);
    doc.viewport = { x: 123, y: 456, zoom: 2 };
    expect(computeDiagramDocumentHash(doc)).toBe(before);
  });

  it("元素数组顺序不影响完整文档哈希", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramDocumentHash(doc);
    doc.elements.reverse();
    expect(computeDiagramDocumentHash(doc)).toBe(before);
  });

  it("assets 顺序不影响完整文档哈希", () => {
    const doc = docWithTwoShapes();
    doc.assets = [
      { id: "b-asset", path: "assets/b.png", mime: "image/png" },
      { id: "a-asset", path: "assets/a.png", mime: "image/png" },
    ];
    const before = computeDiagramDocumentHash(doc);
    doc.assets.reverse();
    expect(computeDiagramDocumentHash(doc)).toBe(before);
  });

  it("未声明字段不影响完整文档哈希（规范化时剥离）", () => {
    const doc = docWithTwoShapes();
    const before = computeDiagramDocumentHash(doc);
    (doc.elements[0] as unknown as Record<string, unknown>).junk = "x";
    expect(computeDiagramDocumentHash(doc)).toBe(before);
  });
});

describe("语义哈希 vs 完整文档哈希分工", () => {
  it("纯视觉变化：语义哈希不变，完整文档哈希变", () => {
    const doc = docWithTwoShapes();
    const s1 = computeDiagramSemanticHash(doc);
    const d1 = computeDiagramDocumentHash(doc);
    doc.elements[1].position = { x: 500, y: 500 };
    expect(computeDiagramSemanticHash(doc)).toBe(s1);
    expect(computeDiagramDocumentHash(doc)).not.toBe(d1);
  });

  it("语义变化：两者都变", () => {
    const doc = docWithTwoShapes();
    const s1 = computeDiagramSemanticHash(doc);
    const d1 = computeDiagramDocumentHash(doc);
    if (doc.elements[0].type === "shape") {
      doc.elements[0].textBlocks = [{ id: "t", kind: "paragraph", text: "改了" }];
    }
    expect(computeDiagramSemanticHash(doc)).not.toBe(s1);
    expect(computeDiagramDocumentHash(doc)).not.toBe(d1);
  });
});
