import { describe, expect, it } from "vitest";

import {
  createBlankDiagramDocument,
  createShapeElement,
  paragraphBlock,
  type DiagramConnector,
  type DiagramDocument,
} from "./diagram-document";
import {
  DIAGRAM_LIMITS,
  cloneDiagramDocument,
  normalizeDiagramDocument,
  validateDiagramDocument,
} from "./diagram-validator";

function validDoc(): DiagramDocument {
  const doc = createBlankDiagramDocument("freeform");
  doc.elements = [createShapeElement("a", "rectangle", "甲", { x: 0, y: 0 })];
  return doc;
}

function asRaw(doc: DiagramDocument): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

function errorCodes(result: ReturnType<typeof validateDiagramDocument>): string[] {
  return result.ok ? [] : result.errors.map((e) => e.code);
}

describe("validateDiagramDocument — 合法文档", () => {
  it("空白 freeform 文档通过", () => {
    expect(validateDiagramDocument(createBlankDiagramDocument("freeform")).ok).toBe(true);
  });

  it("空白 flowchart 文档（开始/结束节点）通过", () => {
    expect(validateDiagramDocument(createBlankDiagramDocument("flowchart")).ok).toBe(true);
  });

  it("含合法连接器的文档通过", () => {
    const doc = validDoc();
    doc.elements.push(createShapeElement("b", "diamond", "乙", { x: 200, y: 0 }));
    const conn: DiagramConnector = {
      id: "c1",
      source: { elementId: "a" },
      target: { elementId: "b" },
      route: "orthogonal",
      markerStart: "none",
      markerEnd: "arrow-closed",
      stroke: { color: "#333", width: 1.5, style: "solid" },
      zIndex: 0,
    };
    doc.connectors = [conn];
    expect(validateDiagramDocument(doc).ok).toBe(true);
  });
});

describe("validateDiagramDocument — 顶层结构", () => {
  it("非对象输入被拒绝", () => {
    expect(errorCodes(validateDiagramDocument(null))).toContain("not-object");
    expect(errorCodes(validateDiagramDocument("x"))).toContain("not-object");
    expect(errorCodes(validateDiagramDocument([1, 2]))).toContain("not-object");
  });

  it("版本不是 2 被拒绝", () => {
    const raw = asRaw(validDoc());
    raw.version = 1;
    expect(errorCodes(validateDiagramDocument(raw))).toContain("version-unsupported");
    raw.version = 3;
    expect(errorCodes(validateDiagramDocument(raw))).toContain("version-unsupported");
  });

  it("capabilityVersion 非整数或超过客户端支持被拒绝", () => {
    const raw = asRaw(validDoc());
    raw.capabilityVersion = 0;
    expect(errorCodes(validateDiagramDocument(raw))).toContain("capability-version-invalid");
    raw.capabilityVersion = 1.5;
    expect(errorCodes(validateDiagramDocument(raw))).toContain("capability-version-invalid");
    raw.capabilityVersion = 999;
    expect(errorCodes(validateDiagramDocument(raw))).toContain("capability-version-too-new");
  });

  it("diagramKind 非法被拒绝", () => {
    const raw = asRaw(validDoc());
    raw.diagramKind = "nope";
    expect(errorCodes(validateDiagramDocument(raw))).toContain("kind-invalid");
  });

  it("canvas 非对象/字段非法被拒绝", () => {
    const raw = asRaw(validDoc());
    raw.canvas = "bad";
    expect(errorCodes(validateDiagramDocument(raw))).toContain("canvas-invalid");
    const raw2 = asRaw(validDoc());
    (raw2.canvas as Record<string, unknown>).mode = "weird";
    expect(errorCodes(validateDiagramDocument(raw2))).toContain("canvas-mode-invalid");
    const raw3 = asRaw(validDoc());
    ((raw3.canvas as Record<string, unknown>).grid as Record<string, unknown>).size = -1;
    expect(errorCodes(validateDiagramDocument(raw3))).toContain("canvas-grid-invalid");
  });

  it("layout.direction 只允许 TB/LR", () => {
    const raw = asRaw(validDoc());
    raw.layout = { direction: "RL" };
    expect(errorCodes(validateDiagramDocument(raw))).toContain("layout-invalid");
  });

  it("viewport 字段必须是有限数值", () => {
    const raw = asRaw(validDoc());
    raw.viewport = { x: Number.NaN, y: 0, zoom: 1 };
    expect(errorCodes(validateDiagramDocument(raw))).toContain("viewport-invalid");
  });
});

describe("validateDiagramDocument — 元素约束", () => {
  it("元素 id 重复被拒绝", () => {
    const doc = validDoc();
    doc.elements.push(createShapeElement("a", "diamond", "乙", { x: 10, y: 10 }));
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-id-duplicate");
  });

  it("size 必须为正有限数", () => {
    const doc = validDoc();
    (doc.elements[0] as { size: unknown }).size = { width: 0, height: 60 };
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-size-invalid");
  });

  it("position 必须是有限数", () => {
    const doc = validDoc();
    (doc.elements[0] as { position: unknown }).position = { x: Infinity, y: 0 };
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-position-invalid");
  });

  it("zIndex 必须是整数", () => {
    const doc = validDoc();
    (doc.elements[0] as { zIndex: unknown }).zIndex = 1.5;
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-zindex-invalid");
  });

  it("opacity 必须在 0..1", () => {
    const doc = validDoc();
    (doc.elements[0] as { opacity: unknown }).opacity = 1.5;
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-opacity-invalid");
  });

  it("semantic 含未声明字段被拒绝", () => {
    const doc = validDoc();
    (doc.elements[0] as { semantic: unknown }).semantic = { role: "start", hacker: "x" };
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-semantic-invalid");
  });

  it("shapeKind 非法被拒绝", () => {
    const doc = validDoc();
    (doc.elements[0] as { shapeKind: unknown }).shapeKind = "octagon-x";
    expect(errorCodes(validateDiagramDocument(doc))).toContain("shape-kind-invalid");
  });

  it("渐变 stops 超过上限被拒绝", () => {
    const doc = validDoc();
    (doc.elements[0] as { fill: unknown }).fill = {
      type: "linear-gradient",
      angle: 0,
      stops: Array.from({ length: DIAGRAM_LIMITS.maxGradientStops + 1 }, (_, i) => ({
        offset: i / DIAGRAM_LIMITS.maxGradientStops,
        color: "#fff",
      })),
    };
    expect(errorCodes(validateDiagramDocument(doc))).toContain("shape-fill-invalid");
  });

  it("渐变 stop offset 超出 0..1 被拒绝", () => {
    const doc = validDoc();
    (doc.elements[0] as { fill: unknown }).fill = {
      type: "linear-gradient",
      angle: 45,
      stops: [
        { offset: 0, color: "#fff" },
        { offset: 1.2, color: "#000" },
      ],
    };
    expect(errorCodes(validateDiagramDocument(doc))).toContain("shape-fill-invalid");
  });

  it("textStyle 只接受声明字段且值域正确", () => {
    const doc = validDoc();
    (doc.elements[0] as { textStyle: unknown }).textStyle = { fontWeight: 900 };
    expect(errorCodes(validateDiagramDocument(doc))).toContain("shape-textstyle-invalid");
    const doc2 = validDoc();
    (doc2.elements[0] as { textStyle: unknown }).textStyle = { fontWeight: 700, align: "center" };
    expect(validateDiagramDocument(doc2).ok).toBe(true);
  });
});

describe("validateDiagramDocument — 父子结构", () => {
  function withGroup(): DiagramDocument {
    const doc = createBlankDiagramDocument("freeform");
    doc.elements = [
      {
        id: "g",
        type: "group",
        position: { x: 0, y: 0 },
        size: { width: 300, height: 200 },
        rotation: 0,
        zIndex: 0,
      },
      { ...createShapeElement("child", "rectangle", "子", { x: 10, y: 10 }), parentId: "g" },
    ];
    return doc;
  }

  it("合法 group 嵌套通过", () => {
    expect(validateDiagramDocument(withGroup()).ok).toBe(true);
  });

  it("parentId 指向不存在元素被拒绝", () => {
    const doc = validDoc();
    (doc.elements[0] as { parentId: unknown }).parentId = "ghost";
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-parent-missing");
  });

  it("parentId 必须指向 group/container", () => {
    const doc = validDoc();
    doc.elements.push({
      ...createShapeElement("child", "diamond", "子", { x: 10, y: 10 }),
      parentId: "a",
    });
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-parent-not-group");
  });

  it("父元素必须排在子元素之前", () => {
    const doc = withGroup();
    doc.elements.reverse();
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-parent-order");
  });

  it("父子循环被拒绝", () => {
    const doc = withGroup();
    (doc.elements[0] as { parentId: unknown }).parentId = "child";
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-parent-cycle");
  });

  it("嵌套深度超过上限被拒绝", () => {
    const doc = createBlankDiagramDocument("freeform");
    const depth = DIAGRAM_LIMITS.maxNestingDepth + 2;
    for (let i = 0; i < depth; i++) {
      doc.elements.push({
        id: `g${i}`,
        type: "group",
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        rotation: 0,
        zIndex: 0,
        ...(i > 0 ? { parentId: `g${i - 1}` } : {}),
      });
    }
    expect(errorCodes(validateDiagramDocument(doc))).toContain("element-nesting-too-deep");
  });
});

describe("validateDiagramDocument — 资产", () => {
  function imageDoc(path: string): DiagramDocument {
    const doc = createBlankDiagramDocument("freeform");
    doc.elements = [
      {
        id: "img",
        type: "image",
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        rotation: 0,
        zIndex: 0,
        assetId: "asset-1",
        fit: "contain",
      },
    ];
    doc.assets = [{ id: "asset-1", path, mime: "image/png" }];
    return doc;
  }

  it("合法相对路径资产通过", () => {
    expect(validateDiagramDocument(imageDoc("assets/pic.png")).ok).toBe(true);
  });

  it("绝对路径被拒绝", () => {
    expect(errorCodes(validateDiagramDocument(imageDoc("C:/pics/a.png")))).toContain(
      "asset-path-invalid",
    );
    expect(errorCodes(validateDiagramDocument(imageDoc("/etc/a.png")))).toContain(
      "asset-path-invalid",
    );
    expect(errorCodes(validateDiagramDocument(imageDoc("\\\\server\\a.png")))).toContain(
      "asset-path-invalid",
    );
  });

  it("路径穿越 .. 被拒绝", () => {
    expect(errorCodes(validateDiagramDocument(imageDoc("../secret.png")))).toContain(
      "asset-path-invalid",
    );
    expect(errorCodes(validateDiagramDocument(imageDoc("assets/../../x.png")))).toContain(
      "asset-path-invalid",
    );
  });

  it("mime 必须是 image/*", () => {
    const doc = imageDoc("assets/a.png");
    doc.assets![0].mime = "application/pdf";
    expect(errorCodes(validateDiagramDocument(doc))).toContain("asset-mime-invalid");
  });

  it("image 元素引用不存在资产被拒绝", () => {
    const doc = imageDoc("assets/a.png");
    doc.assets = [];
    expect(errorCodes(validateDiagramDocument(doc))).toContain("image-asset-missing");
    const doc2 = imageDoc("assets/a.png");
    delete doc2.assets;
    expect(errorCodes(validateDiagramDocument(doc2))).toContain("image-asset-missing");
  });
});

describe("validateDiagramDocument — 连接器", () => {
  function docWithConnector(patch: Partial<DiagramConnector>): DiagramDocument {
    const doc = validDoc();
    doc.elements.push(createShapeElement("b", "diamond", "乙", { x: 200, y: 0 }));
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
        ...patch,
      },
    ];
    return doc;
  }

  it("端点指向不存在元素被拒绝", () => {
    expect(errorCodes(validateDiagramDocument(docWithConnector({ target: { elementId: "ghost" } })))).toContain(
      "connector-endpoint-missing",
    );
  });

  it("自环被拒绝", () => {
    expect(errorCodes(validateDiagramDocument(docWithConnector({ target: { elementId: "a" } })))).toContain(
      "connector-self-loop",
    );
  });

  it("端点必须至少含 elementId 或 point", () => {
    expect(errorCodes(validateDiagramDocument(docWithConnector({ source: {} })))).toContain(
      "connector-source-invalid",
    );
  });

  it("自由端点（point）合法", () => {
    const doc = docWithConnector({ target: { point: { x: 500, y: 500 } } });
    expect(validateDiagramDocument(doc).ok).toBe(true);
  });

  it("route/marker 枚举非法被拒绝", () => {
    expect(
      errorCodes(validateDiagramDocument(docWithConnector({ route: "curvy" as never }))),
    ).toContain("connector-route-invalid");
    expect(
      errorCodes(validateDiagramDocument(docWithConnector({ markerEnd: "skull" as never }))),
    ).toContain("connector-marker-invalid");
  });

  it("连接器 id 重复被拒绝", () => {
    const doc = docWithConnector({});
    doc.connectors.push({ ...doc.connectors[0] });
    expect(errorCodes(validateDiagramDocument(doc))).toContain("connector-id-duplicate");
  });

  it("waypoints 超过上限被拒绝", () => {
    const doc = docWithConnector({
      waypoints: Array.from({ length: DIAGRAM_LIMITS.maxWaypoints + 1 }, () => ({ x: 0, y: 0 })),
    });
    expect(errorCodes(validateDiagramDocument(doc))).toContain("connector-waypoints-invalid");
  });
});

describe("validateDiagramDocument — 数量限制", () => {
  it("elements 超过上限被拒绝", () => {
    const doc = createBlankDiagramDocument("freeform");
    doc.elements = Array.from({ length: DIAGRAM_LIMITS.maxElements + 1 }, (_, i) =>
      createShapeElement(`e${i}`, "rectangle", "", { x: 0, y: 0 }),
    );
    expect(errorCodes(validateDiagramDocument(doc))).toContain("elements-too-many");
  });

  it("connectors 超过上限被拒绝", () => {
    const doc = createBlankDiagramDocument("freeform");
    doc.connectors = Array.from({ length: DIAGRAM_LIMITS.maxConnectors + 1 }, (_, i) => ({
      id: `c${i}`,
      source: { point: { x: 0, y: 0 } },
      target: { point: { x: 1, y: 1 } },
      route: "straight" as const,
      markerStart: "none" as const,
      markerEnd: "none" as const,
      stroke: { color: "#333", width: 1, style: "solid" as const },
      zIndex: 0,
    }));
    expect(errorCodes(validateDiagramDocument(doc))).toContain("connectors-too-many");
  });

  it("文本超过上限被拒绝", () => {
    const doc = validDoc();
    (doc.elements[0] as { textBlocks: unknown }).textBlocks = [
      paragraphBlock("t1", "x".repeat(DIAGRAM_LIMITS.maxTextLength + 1)),
    ];
    expect(errorCodes(validateDiagramDocument(doc))).toContain("shape-textblocks-invalid");
  });

  it("freehand points 超过上限被拒绝", () => {
    const doc = createBlankDiagramDocument("freeform");
    doc.elements = [
      {
        id: "f",
        type: "freehand",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
        rotation: 0,
        zIndex: 0,
        points: Array.from({ length: DIAGRAM_LIMITS.maxFreehandPoints + 1 }, () => ({
          x: 0,
          y: 0,
          pressure: 0.5,
        })),
        drawingTool: "pen",
        color: "#000",
        strokeWidth: 4,
      },
    ];
    expect(errorCodes(validateDiagramDocument(doc))).toContain("freehand-points-invalid");
  });
});

describe("normalizeDiagramDocument", () => {
  it("去除未声明字段", () => {
    const raw = asRaw(validDoc());
    (raw.elements as Array<Record<string, unknown>>)[0].evilField = "hack";
    raw.anotherEvil = 123;
    const validation = validateDiagramDocument(raw);
    expect(validation.ok).toBe(true);
    const normalized = normalizeDiagramDocument(raw);
    expect("evilField" in normalized.elements[0]).toBe(false);
    expect("anotherEvil" in normalized).toBe(false);
  });

  it("规范化是幂等的", () => {
    const doc = validDoc();
    const once = normalizeDiagramDocument(asRaw(doc));
    const twice = normalizeDiagramDocument(asRaw(once));
    expect(twice).toEqual(once);
  });

  it("cloneDiagramDocument 深拷贝且相等", () => {
    const doc = validDoc();
    doc.connectors = [
      {
        id: "c1",
        source: { elementId: "a" },
        target: { point: { x: 9, y: 9 } },
        route: "bezier",
        markerStart: "none",
        markerEnd: "arrow-open",
        stroke: { color: "#333", width: 1.5, style: "dashed" },
        zIndex: 2,
      },
    ];
    const cloned = cloneDiagramDocument(doc);
    expect(cloned).toEqual(doc);
    expect(cloned).not.toBe(doc);
    expect(cloned.elements[0]).not.toBe(doc.elements[0]);
  });
});
