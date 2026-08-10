/**
 * diagram-to-flowchart 迁移器测试。
 *
 * 覆盖：shape/text/image/freehand/group/container/brace 映射、
 * connector -> edge 映射、样式/画布/viewport 映射、
 * 不支持元素整体失败、渐变降级、嵌套 group 拍平、
 * 迁移结果通过 flowchart v2 校验、幂等性。
 */

import { describe, expect, it } from "vitest";

import type {
  DiagramConnector,
  DiagramDocument,
  DiagramShapeElement,
  ShapeKind,
} from "./diagram-legacy/diagram-document";
import {
  createBlankDiagramDocument,
  paragraphBlock,
} from "./diagram-legacy/diagram-document";
import { SHAPE_KINDS } from "./diagram-legacy/diagram-document";
import { convertDiagramToFlowchart } from "./diagram-to-flowchart";
import { validateFlowchartDocument } from "./flowchart-document";

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

function makeDoc(overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return { ...createBlankDiagramDocument("freeform"), ...overrides };
}

function makeShape(overrides: Partial<DiagramShapeElement> = {}): DiagramShapeElement {
  return {
    id: "shape-1",
    type: "shape",
    shapeKind: "rectangle",
    position: { x: 10, y: 20 },
    size: { width: 160, height: 60 },
    rotation: 0,
    zIndex: 0,
    fill: { type: "none" },
    textBlocks: [paragraphBlock("tb-1", "节点")],
    ...overrides,
  };
}

function makeConnector(overrides: Partial<DiagramConnector> = {}): DiagramConnector {
  return {
    id: "conn-1",
    source: { elementId: "shape-1" },
    target: { elementId: "shape-2" },
    route: "orthogonal",
    markerStart: "none",
    markerEnd: "arrow-closed",
    stroke: { color: "#333333", width: 1, style: "solid" },
    zIndex: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 基础映射
// ---------------------------------------------------------------------------

describe("convertDiagramToFlowchart：基础映射", () => {
  it("空文档迁移为空 flowchart v2", () => {
    const result = convertDiagramToFlowchart(makeDoc());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.version).toBe(2);
    expect(result.document.nodes).toEqual([]);
    expect(result.document.edges).toEqual([]);
    expect(result.document.theme.paletteId).toBe("default");
    expect(result.warnings).toEqual([]);
  });

  it("shape 迁移保留 id/position/size/label", () => {
    const doc = makeDoc({ elements: [makeShape()] });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.document.nodes[0];
    expect(node.id).toBe("shape-1");
    expect(node.kind).toBe("rectangle");
    expect(node.label).toBe("节点");
    expect(node.position).toEqual({ x: 10, y: 20 });
    expect(node.size).toEqual({ width: 160, height: 60 });
  });

  it("公共字段 rotation/zIndex/locked/opacity 迁移", () => {
    const doc = makeDoc({
      elements: [makeShape({ rotation: 90, zIndex: 3, locked: true, opacity: 0.5 })],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.document.nodes[0];
    expect(node.rotation).toBe(90);
    expect(node.zIndex).toBe(3);
    expect(node.locked).toBe(true);
    expect(node.opacity).toBe(0.5);
  });

  it("rotation 为 0、zIndex 为 0 时省略字段", () => {
    const doc = makeDoc({ elements: [makeShape()] });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.document.nodes[0];
    expect(node.rotation).toBeUndefined();
    expect(node.zIndex).toBeUndefined();
  });

  it("多文本块合并为换行 label", () => {
    const doc = makeDoc({
      elements: [
        makeShape({
          textBlocks: [paragraphBlock("tb-1", "第一行"), paragraphBlock("tb-2", "第二行")],
        }),
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0].label).toBe("第一行\n第二行");
  });
});

// ---------------------------------------------------------------------------
// shapeKind 覆盖
// ---------------------------------------------------------------------------

describe("convertDiagramToFlowchart：shapeKind 映射", () => {
  const EXPECTED: Record<ShapeKind, string | null> = {
    rectangle: "rectangle",
    "rounded-rectangle": "rounded-rectangle",
    ellipse: "ellipse",
    circle: "circle",
    pill: "terminator",
    diamond: "diamond-basic",
    hexagon: "hexagon-basic",
    parallelogram: "input-output",
    cylinder: "database",
    document: "document",
    "multi-document": "multi-document",
    cloud: "cloud",
    actor: null,
    callout: "callout",
    chevron: null,
    pentagon: "pentagon-basic",
    trapezoid: "manual-operation",
    process: "predefined-process",
    subprocess: "subprocess",
    database: "database",
    junction: "connector",
    "predefined-process": "predefined-process",
    "manual-input": "manual-input",
    delay: "delay",
    display: "display",
    "off-page-connector": "off-page-connector",
    "internal-storage": "internal-storage",
    "stored-data": "stored-data",
  };

  it("映射表覆盖全部 ShapeKind", () => {
    for (const kind of SHAPE_KINDS) {
      expect(EXPECTED[kind], `缺少映射定义：${kind}`).toBeDefined();
    }
  });

  it.each(SHAPE_KINDS.filter((k) => EXPECTED[k] !== null))("可映射形状 %s", (kind) => {
    const doc = makeDoc({ elements: [makeShape({ shapeKind: kind })] });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0].kind).toBe(EXPECTED[kind]);
  });

  it.each(["actor", "chevron"] as const)("不支持形状 %s 整体失败", (kind) => {
    const doc = makeDoc({ elements: [makeShape({ shapeKind: kind })] });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons[0]).toContain(kind);
  });

  it("pill + semantic role start/end 升级为语义 kind", () => {
    const doc = makeDoc({
      elements: [
        makeShape({ id: "s1", shapeKind: "pill", semantic: { role: "start" } }),
        makeShape({ id: "s2", shapeKind: "pill", semantic: { role: "end" } }),
        makeShape({ id: "s3", shapeKind: "pill" }),
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0].kind).toBe("start");
    expect(result.document.nodes[1].kind).toBe("end");
    expect(result.document.nodes[2].kind).toBe("terminator");
  });
});

// ---------------------------------------------------------------------------
// 样式映射
// ---------------------------------------------------------------------------

describe("convertDiagramToFlowchart：样式映射", () => {
  it("solid fill/stroke 迁移为节点样式", () => {
    const doc = makeDoc({
      elements: [
        makeShape({
          fill: { type: "solid", color: "#FF0000" },
          stroke: { color: "#00FF00", width: 2, style: "dashed" },
        }),
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const style = result.document.nodes[0].style;
    expect(style?.fill).toBe("#FF0000");
    expect(style?.borderColor).toBe("#00FF00");
    expect(style?.borderWidth).toBe(2);
    expect(style?.borderStyle).toBe("dashed");
  });

  it("textStyle 迁移为字体样式", () => {
    const doc = makeDoc({
      elements: [
        makeShape({
          textStyle: {
            fontFamily: "宋体",
            fontSize: 18,
            fontWeight: 700,
            italic: true,
            underline: true,
            color: "#111111",
            align: "left",
            verticalAlign: "top",
            lineHeight: 1.8,
          },
        }),
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const style = result.document.nodes[0].style;
    expect(style?.fontFamily).toBe("宋体");
    expect(style?.fontSize).toBe(18);
    expect(style?.bold).toBe(true);
    expect(style?.italic).toBe(true);
    expect(style?.underline).toBe(true);
    expect(style?.color).toBe("#111111");
    expect(style?.textAlign).toBe("left");
    expect(style?.verticalAlign).toBe("top");
    expect(style?.lineHeight).toBe(1.8);
  });

  it("fontWeight < 600 不映射为 bold", () => {
    const doc = makeDoc({
      elements: [makeShape({ textStyle: { fontWeight: 400 } })],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0].style?.bold).toBeUndefined();
  });

  it("渐变填充降级为第一个色标并记录 warning", () => {
    const doc = makeDoc({
      elements: [
        makeShape({
          fill: {
            type: "linear-gradient",
            angle: 90,
            stops: [
              { offset: 0, color: "#FF0000" },
              { offset: 1, color: "#0000FF" },
            ],
          },
        }),
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0].style?.fill).toBe("#FF0000");
    expect(result.warnings.some((w) => w.includes("渐变"))).toBe(true);
  });

  it("cornerRadius 迁移；shadow 忽略并 warning", () => {
    const doc = makeDoc({
      elements: [
        makeShape({
          cornerRadius: 8,
          shadow: { color: "#000", offsetX: 2, offsetY: 2, blur: 4 },
        }),
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes[0].style?.cornerRadius).toBe(8);
    expect(result.warnings.some((w) => w.includes("阴影"))).toBe(true);
  });

  it("hidden 元素保留并记录 warning", () => {
    const doc = makeDoc({ elements: [makeShape({ hidden: true })] });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.nodes).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("隐藏"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 元素类型映射
// ---------------------------------------------------------------------------

describe("convertDiagramToFlowchart：元素类型", () => {
  it("text 元素迁移为 text kind", () => {
    const doc = makeDoc({
      elements: [
        {
          id: "text-1",
          type: "text",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 30 },
          rotation: 0,
          zIndex: 0,
          textBlocks: [paragraphBlock("tb-1", "说明文字")],
          textStyle: { fontSize: 16 },
        },
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.document.nodes[0];
    expect(node.kind).toBe("text");
    expect(node.label).toBe("说明文字");
    expect(node.style?.fontSize).toBe(16);
  });

  it("image 元素通过 assets 解析路径", () => {
    const doc = makeDoc({
      elements: [
        {
          id: "img-1",
          type: "image",
          position: { x: 5, y: 5 },
          size: { width: 200, height: 100 },
          rotation: 0,
          zIndex: 0,
          assetId: "asset-1",
          fit: "contain",
          alt: "截图",
        },
      ],
      assets: [{ id: "asset-1", path: "assets/pic.png", mime: "image/png" }],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.document.nodes[0];
    expect(node.kind).toBe("image");
    expect(node.imagePath).toBe("assets/pic.png");
    expect(node.label).toBe("截图");
  });

  it("image 元素 assetId 缺失时失败", () => {
    const doc = makeDoc({
      elements: [
        {
          id: "img-1",
          type: "image",
          position: { x: 0, y: 0 },
          size: { width: 100, height: 100 },
          rotation: 0,
          zIndex: 0,
          assetId: "missing",
          fit: "contain",
        },
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons[0]).toContain("missing");
  });

  it("freehand 元素保留笔触数据", () => {
    const doc = makeDoc({
      elements: [
        {
          id: "fh-1",
          type: "freehand",
          position: { x: 0, y: 0 },
          size: { width: 50, height: 50 },
          rotation: 0,
          zIndex: 0,
          points: [
            { x: 0, y: 0, pressure: 0.5 },
            { x: 10, y: 10, pressure: 0.8 },
          ],
          path: "M0 0L10 10",
          drawingTool: "highlighter",
          color: "#FF0000",
          strokeWidth: 8,
        },
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.document.nodes[0];
    expect(node.kind).toBe("freehand");
    expect(node.points).toHaveLength(2);
    expect(node.path).toBe("M0 0L10 10");
    expect(node.drawingTool).toBe("highlighter");
    expect(node.color).toBe("#FF0000");
    expect(node.strokeWidth).toBe(8);
    // 荧光笔缺省不透明度 0.28
    expect(node.opacity).toBe(0.28);
  });

  it("group 迁移为 group 容器，子元素 parentId 保留", () => {
    const doc = makeDoc({
      elements: [
        {
          id: "group-1",
          type: "group",
          position: { x: 100, y: 100 },
          size: { width: 300, height: 200 },
          rotation: 0,
          zIndex: 0,
          title: "分组",
          background: { type: "solid", color: "#F5F5F5" },
        },
        makeShape({ id: "shape-in", parentId: "group-1", position: { x: 10, y: 10 } }),
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const group = result.document.nodes.find((n) => n.id === "group-1")!;
    expect(group.kind).toBe("group");
    expect(group.label).toBe("分组");
    expect(group.container).toEqual({ type: "group" });
    expect(group.style?.fill).toBe("#F5F5F5");
    const child = result.document.nodes.find((n) => n.id === "shape-in")!;
    expect(child.parentId).toBe("group-1");
    expect(child.position).toEqual({ x: 10, y: 10 });
  });

  it("container 迁移为 group 并 warning 语义角色", () => {
    const doc = makeDoc({
      elements: [
        {
          id: "c-1",
          type: "container",
          containerRole: "swimlane",
          title: "泳道",
          padding: 16,
          position: { x: 0, y: 0 },
          size: { width: 400, height: 200 },
          rotation: 0,
          zIndex: 0,
        },
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.document.nodes[0];
    expect(node.kind).toBe("group");
    expect(node.label).toBe("泳道");
    expect(result.warnings.some((w) => w.includes("泳道"))).toBe(true);
  });

  it("brace 元素迁移为 brace kind", () => {
    const doc = makeDoc({
      elements: [
        {
          id: "brace-1",
          type: "brace",
          braceKind: "curly",
          orientation: "right",
          position: { x: 0, y: 0 },
          size: { width: 40, height: 120 },
          rotation: 0,
          zIndex: 0,
          stroke: { color: "#333333", width: 2, style: "solid" },
        },
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.document.nodes[0];
    expect(node.kind).toBe("brace");
    expect(node.style?.borderColor).toBe("#333333");
  });

  it.each(["icon", "table", "lifeline", "activation"] as const)(
    "%s 元素整体失败",
    (type) => {
      const base = {
        id: `${type}-1`,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        rotation: 0,
        zIndex: 0,
      };
      let el: DiagramDocument["elements"][number];
      switch (type) {
        case "icon":
          el = { ...base, type, iconRef: { library: "lucide", name: "star" }, fit: "contain" };
          break;
        case "table":
          el = { ...base, type, sections: [], columnWidths: [] };
          break;
        case "lifeline":
          el = { ...base, type, title: "参与者" };
          break;
        case "activation":
          el = { ...base, type, lifelineId: "ll-1" };
          break;
      }
      const doc = makeDoc({ elements: [el] });
      const result = convertDiagramToFlowchart(doc);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reasons.length).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 嵌套 group 拍平
// ---------------------------------------------------------------------------

describe("convertDiagramToFlowchart：嵌套 group 拍平", () => {
  it("嵌套 group 拍平到根级，position 转绝对坐标", () => {
    const doc = makeDoc({
      elements: [
        {
          id: "outer",
          type: "group",
          position: { x: 100, y: 100 },
          size: { width: 400, height: 300 },
          rotation: 0,
          zIndex: 0,
        },
        {
          id: "inner",
          type: "group",
          position: { x: 20, y: 30 },
          size: { width: 200, height: 150 },
          rotation: 0,
          zIndex: 0,
          parentId: "outer",
        },
        makeShape({ id: "leaf", parentId: "inner", position: { x: 5, y: 5 } }),
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inner = result.document.nodes.find((n) => n.id === "inner")!;
    expect(inner.parentId).toBeUndefined();
    expect(inner.position).toEqual({ x: 120, y: 130 });
    // 子元素相对 inner 的坐标不变
    const leaf = result.document.nodes.find((n) => n.id === "leaf")!;
    expect(leaf.parentId).toBe("inner");
    expect(leaf.position).toEqual({ x: 5, y: 5 });
    expect(result.warnings.some((w) => w.includes("拍平"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 连接器映射
// ---------------------------------------------------------------------------

describe("convertDiagramToFlowchart：连接器映射", () => {
  function twoShapes(): DiagramShapeElement[] {
    return [makeShape({ id: "shape-1" }), makeShape({ id: "shape-2", position: { x: 300, y: 0 } })];
  }

  it("connector 迁移为 edge，route/marker/stroke 映射", () => {
    const doc = makeDoc({
      elements: twoShapes(),
      connectors: [
        makeConnector({
          label: [paragraphBlock("tb-l", "是")],
          stroke: { color: "#666666", width: 2, style: "dashed" },
        }),
      ],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const edge = result.document.edges[0];
    expect(edge.id).toBe("conn-1");
    expect(edge.source).toBe("shape-1");
    expect(edge.target).toBe("shape-2");
    expect(edge.label).toBe("是");
    expect(edge.style?.route).toBe("smoothstep");
    expect(edge.style?.markerEnd).toBeUndefined(); // arrowclosed 是默认值，省略
    expect(edge.style?.stroke).toBe("#666666");
    expect(edge.style?.strokeWidth).toBe(2);
    expect(edge.style?.strokeDasharray).toBe("dashed");
  });

  it("arrow-open 映射为 arrow", () => {
    const doc = makeDoc({
      elements: twoShapes(),
      connectors: [makeConnector({ markerEnd: "arrow-open" })],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.edges[0].style?.markerEnd).toBe("arrow");
  });

  it("自由端点连接器失败", () => {
    const doc = makeDoc({
      elements: twoShapes(),
      connectors: [makeConnector({ target: { point: { x: 500, y: 500 } } })],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons[0]).toContain("自由端点");
  });

  it.each(["triangle", "circle", "diamond-open", "bar", "er-one-many"] as const)(
    "不支持的端点样式 %s 整体失败",
    (marker) => {
      const doc = makeDoc({
        elements: twoShapes(),
        connectors: [makeConnector({ markerEnd: marker })],
      });
      const result = convertDiagramToFlowchart(doc);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reasons[0]).toContain(marker);
    },
  );

  it("连接器引用失败元素时整体失败", () => {
    const doc = makeDoc({
      elements: [makeShape({ id: "shape-1" })],
      connectors: [makeConnector({ target: { elementId: "ghost" } })],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(false);
  });

  it("waypoints 忽略并 warning", () => {
    const doc = makeDoc({
      elements: twoShapes(),
      connectors: [makeConnector({ waypoints: [{ x: 150, y: 80 }] })],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes("控制点"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 画布 / viewport / direction
// ---------------------------------------------------------------------------

describe("convertDiagramToFlowchart：画布与视图", () => {
  it("canvas/grid/viewport/layout 映射", () => {
    const doc = makeDoc({
      canvas: {
        mode: "page",
        width: 800,
        height: 600,
        orientation: "landscape",
        background: { type: "solid", color: "#FAFAFA" },
        padding: 0,
        grid: { visible: false, snap: false, size: 8 },
      },
      layout: { direction: "LR" },
      viewport: { x: 120, y: -40, zoom: 1.5 },
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.document;
    expect(d.canvas.mode).toBe("page");
    expect(d.canvas.width).toBe(800);
    expect(d.canvas.height).toBe(600);
    expect(d.canvas.orientation).toBe("landscape");
    expect(d.canvas.background).toBe("#FAFAFA");
    expect(d.canvas.grid).toEqual({ visible: false, snap: false, size: 8 });
    expect(d.direction).toBe("LR");
    expect(d.viewport).toEqual({ x: 120, y: -40, zoom: 1.5 });
  });

  it("无 layout 时 direction 默认 TB", () => {
    const result = convertDiagramToFlowchart(makeDoc());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.direction).toBe("TB");
  });
});

// ---------------------------------------------------------------------------
// 结果校验与幂等
// ---------------------------------------------------------------------------

describe("convertDiagramToFlowchart：结果保证", () => {
  it("迁移结果通过 flowchart v2 校验", () => {
    const doc = makeDoc({
      elements: [
        {
          id: "group-1",
          type: "group",
          position: { x: 0, y: 0 },
          size: { width: 400, height: 300 },
          rotation: 0,
          zIndex: 0,
        },
        makeShape({ id: "shape-1", parentId: "group-1" }),
        makeShape({ id: "shape-2", position: { x: 500, y: 0 } }),
      ],
      connectors: [makeConnector()],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateFlowchartDocument(result.document).ok).toBe(true);
  });

  it("幂等：相同输入产生相同输出", () => {
    const doc = makeDoc({
      elements: [makeShape()],
      connectors: [],
    });
    const r1 = convertDiagramToFlowchart(doc);
    const r2 = convertDiagramToFlowchart(doc);
    expect(r1).toEqual(r2);
  });

  it("失败时不产出部分结果", () => {
    const doc = makeDoc({
      elements: [makeShape(), makeShape({ id: "bad", shapeKind: "actor" })],
    });
    const result = convertDiagramToFlowchart(doc);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect("document" in result).toBe(false);
  });
});
