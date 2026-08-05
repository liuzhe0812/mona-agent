/**
 * ELK 自动布局测试：覆盖坐标有效性、方向、分组包含、freehand 排除和 onlyIds 过滤。
 */

import { describe, expect, it } from "vitest";

import {
  createBlankDiagramDocument,
  createShapeElement,
  generateDiagramId,
  paragraphBlock,
  type DiagramConnector,
  type DiagramDocument,
  type DiagramGroupElement,
} from "../diagram-document";
import { computeDiagramLayout, isLayoutParticipating } from "./diagram-layout";

function conn(id: string, source: string, target: string): DiagramConnector {
  return {
    id,
    source: { elementId: source },
    target: { elementId: target },
    route: "orthogonal",
    markerStart: "none",
    markerEnd: "arrow-closed",
    stroke: { color: "#18181b", width: 1.5, style: "solid" },
    zIndex: 0,
  };
}

function docWithChain(): DiagramDocument {
  const doc = createBlankDiagramDocument("flowchart");
  doc.elements = [
    createShapeElement("a", "pill", "开始", { x: 0, y: 0 }),
    createShapeElement("b", "rectangle", "处理", { x: 0, y: 0 }),
    createShapeElement("c", "diamond", "判断", { x: 0, y: 0 }),
  ];
  doc.connectors = [conn("e1", "a", "b"), conn("e2", "b", "c")];
  return doc;
}

describe("computeDiagramLayout — 基础", () => {
  it("空文档返回空数组", async () => {
    const doc = createBlankDiagramDocument("freeform");
    expect(await computeDiagramLayout(doc)).toEqual([]);
  });

  it("链式节点产生有限且不重叠的坐标（TB）", async () => {
    const entries = await computeDiagramLayout(docWithChain());
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(Number.isFinite(e.position.x)).toBe(true);
      expect(Number.isFinite(e.position.y)).toBe(true);
    }
    const byId = new Map(entries.map((e) => [e.id, e.position]));
    // TB 方向：a 在 b 上，b 在 c 上
    expect(byId.get("a")!.y).toBeLessThan(byId.get("b")!.y);
    expect(byId.get("b")!.y).toBeLessThan(byId.get("c")!.y);
  });

  it("LR 方向沿 x 递增", async () => {
    const entries = await computeDiagramLayout(docWithChain(), { direction: "LR" });
    const byId = new Map(entries.map((e) => [e.id, e.position]));
    expect(byId.get("a")!.x).toBeLessThan(byId.get("b")!.x);
    expect(byId.get("b")!.x).toBeLessThan(byId.get("c")!.x);
  });

  it("doc.layout.direction 作为默认方向", async () => {
    const doc = docWithChain();
    doc.layout = { direction: "LR" };
    const entries = await computeDiagramLayout(doc);
    const byId = new Map(entries.map((e) => [e.id, e.position]));
    expect(byId.get("a")!.x).toBeLessThan(byId.get("b")!.x);
  });

  it("结果可直接作为 applyLayout 载荷通过校验", async () => {
    const { applyDiagramCommand, createDiagramState } = await import("../diagram-reducer");
    const doc = docWithChain();
    const entries = await computeDiagramLayout(doc);
    const state = createDiagramState(doc);
    const result = applyDiagramCommand(state, { type: "applyLayout", positions: entries });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.layoutApplied).toBe(true);
    }
  });
});

describe("computeDiagramLayout — 元素过滤", () => {
  it("freehand 不参与布局", async () => {
    const doc = docWithChain();
    doc.elements.push({
      id: "fh",
      type: "freehand",
      position: { x: 500, y: 500 },
      size: { width: 100, height: 80 },
      rotation: 0,
      zIndex: 0,
      points: [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 10, y: 10, pressure: 0.5 },
      ],
      path: "M0 0L10 10",
      drawingTool: "pen",
      color: "#18181b",
      strokeWidth: 4,
    });
    const entries = await computeDiagramLayout(doc);
    expect(entries.find((e) => e.id === "fh")).toBeUndefined();
  });

  it("hidden 元素不参与布局", async () => {
    const doc = docWithChain();
    doc.elements[2] = { ...doc.elements[2], hidden: true };
    const entries = await computeDiagramLayout(doc);
    expect(entries.find((e) => e.id === "c")).toBeUndefined();
  });

  it("onlyIds 只返回指定元素坐标", async () => {
    const entries = await computeDiagramLayout(docWithChain(), { onlyIds: ["a", "c"] });
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(["a", "c"]);
  });
});

describe("computeDiagramLayout — 分组", () => {
  it("group 子元素返回绝对坐标，group 获得尺寸", async () => {
    const doc = createBlankDiagramDocument("architecture");
    const group: DiagramGroupElement = {
      id: "g",
      type: "group",
      position: { x: 0, y: 0 },
      size: { width: 300, height: 200 },
      rotation: 0,
      zIndex: 0,
      title: "分组",
    };
    doc.elements = [
      group,
      { ...createShapeElement("x", "rectangle", "X", { x: 10, y: 10 }), parentId: "g" },
      { ...createShapeElement("y", "rectangle", "Y", { x: 10, y: 100 }), parentId: "g" },
      createShapeElement("z", "rectangle", "Z", { x: 500, y: 0 }),
    ];
    doc.connectors = [conn("e1", "x", "y"), conn("e2", "y", "z")];
    const entries = await computeDiagramLayout(doc);
    const byId = new Map(entries.map((e) => [e.id, e]));
    // group 有尺寸（容纳子节点）
    expect(byId.get("g")?.size?.width).toBeGreaterThan(0);
    // 子元素坐标为绝对坐标（落在 group 范围内）
    const g = byId.get("g")!;
    const x = byId.get("x")!;
    expect(x.position.x).toBeGreaterThanOrEqual(g.position.x);
    expect(x.position.y).toBeGreaterThanOrEqual(g.position.y);
  });
});

describe("isLayoutParticipating", () => {
  it("shape 参与，freehand/lifeline/activation 不参与", () => {
    const shape = createShapeElement(generateDiagramId("s"), "rectangle", "s", { x: 0, y: 0 });
    expect(isLayoutParticipating(shape)).toBe(true);
    expect(isLayoutParticipating({ ...shape, hidden: true })).toBe(false);
    expect(
      isLayoutParticipating({
        ...shape,
        type: "lifeline",
        participant: { name: "A" },
      } as never),
    ).toBe(false);
  });
});

// 保持 paragraphBlock 引用（避免 tree-shake 误报未使用）
void paragraphBlock;
