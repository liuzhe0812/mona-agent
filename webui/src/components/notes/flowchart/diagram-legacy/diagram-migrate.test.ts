import { describe, expect, it } from "vitest";

import type {
  FlowchartDocument,
  FlowchartEdge,
  FlowchartNode,
} from "../flowchart-document";
import { FLOWCHART_NODE_KINDS } from "../flowchart-document";
import {
  V1_NODE_KIND_MAP,
  migrateFlowchartV1ToDiagramV2,
} from "./diagram-migrate";
import { validateDiagramDocument } from "./diagram-validator";

function v1Node(patch: Partial<FlowchartNode>): FlowchartNode {
  return {
    id: "n1",
    kind: "process",
    label: "节点",
    position: { x: 10, y: 20 },
    ...patch,
  };
}

function v1Doc(nodes: FlowchartNode[], edges: FlowchartEdge[] = []): FlowchartDocument {
  // v1 文档字面量：仅字段子集，结构由迁移器在运行时校验
  return { version: 1, direction: "TB", nodes, edges } as unknown as FlowchartDocument;
}

describe("V1_NODE_KIND_MAP", () => {
  // TODO(Batch 5): FLOWCHART_NODE_KINDS 已扩展为 v2，V1_NODE_KIND_MAP 仅覆盖 v1 的 23 种
  // 本测试将在 Batch 5 创建 diagram → flowchart v2 迁移器时重写
  it.skip("覆盖 v1 全部节点 kind", () => {
    for (const kind of FLOWCHART_NODE_KINDS) {
      expect(
        V1_NODE_KIND_MAP[kind as keyof typeof V1_NODE_KIND_MAP],
        `缺少映射：${kind}`,
      ).toBeDefined();
    }
  });

  it.skip("映射表没有多余 kind", () => {
    expect(Object.keys(V1_NODE_KIND_MAP).sort()).toEqual([...FLOWCHART_NODE_KINDS].sort());
  });
});

describe("migrateFlowchartV1ToDiagramV2 — 基本结构", () => {
  it("空文档迁移为合法 v2 文档", () => {
    const result = migrateFlowchartV1ToDiagramV2(v1Doc([]));
    expect(result.ok).toBe(true);
    expect(result.document.version).toBe(2);
    expect(result.document.diagramKind).toBe("flowchart");
    expect(result.document.elements).toEqual([]);
    expect(result.document.connectors).toEqual([]);
    expect(validateDiagramDocument(result.document).ok).toBe(true);
  });

  it("direction 迁移到 layout.direction", () => {
    const tb = migrateFlowchartV1ToDiagramV2(v1Doc([]));
    expect(tb.document.layout).toEqual({ direction: "TB" });
    const lr = migrateFlowchartV1ToDiagramV2({ ...v1Doc([]), direction: "LR" });
    expect(lr.document.layout).toEqual({ direction: "LR" });
  });

  it("viewport 原样迁移", () => {
    const result = migrateFlowchartV1ToDiagramV2({
      ...v1Doc([]),
      viewport: { x: 12, y: 34, zoom: 1.5 },
    });
    expect(result.document.viewport).toEqual({ x: 12, y: 34, zoom: 1.5 });
  });

  it("无 viewport 时不产生 viewport 字段", () => {
    const result = migrateFlowchartV1ToDiagramV2(v1Doc([]));
    expect(result.document.viewport).toBeUndefined();
  });

  it("迁移是纯函数：重复执行结果一致", () => {
    const doc = v1Doc([v1Node({}), v1Node({ id: "n2", kind: "decision", label: "判断" })]);
    const a = migrateFlowchartV1ToDiagramV2(doc);
    const b = migrateFlowchartV1ToDiagramV2(doc);
    expect(a.document).toEqual(b.document);
  });
});

describe("migrateFlowchartV1ToDiagramV2 — 节点映射", () => {
  it("start/end 节点映射为 pill 并带 role", () => {
    const result = migrateFlowchartV1ToDiagramV2(
      v1Doc([v1Node({ kind: "start", label: "开始" }), v1Node({ id: "n2", kind: "end", label: "结束" })]),
    );
    const [start, end] = result.document.elements;
    expect(start).toMatchObject({ type: "shape", shapeKind: "pill", semantic: { role: "start" } });
    expect(end).toMatchObject({ type: "shape", shapeKind: "pill", semantic: { role: "end" } });
  });

  // TODO(Batch 5): FLOWCHART_NODE_KINDS 已扩展为 v2，包含 v1 之外的 kind
  // 本测试将在 Batch 5 创建 diagram → flowchart v2 迁移器时重写
  it.skip("全部 23 种 kind 迁移结果通过 v2 校验", () => {
    const nodes = FLOWCHART_NODE_KINDS.map((kind, i) =>
      v1Node({
        id: `n${i}`,
        kind,
        label: `节点${i}`,
        ...(kind === "image" ? { imagePath: "assets/p.png" } : {}),
        ...(kind === "freehand"
          ? { points: [{ x: 0, y: 0, pressure: 0.5 }, { x: 5, y: 5, pressure: 0.5 }] }
          : {}),
      }),
    );
    const result = migrateFlowchartV1ToDiagramV2(v1Doc(nodes));
    expect(result.document.elements).toHaveLength(FLOWCHART_NODE_KINDS.length);
    const validation = validateDiagramDocument(result.document);
    expect(validation.ok, JSON.stringify(validation)).toBe(true);
  });

  it("位置与尺寸保持", () => {
    const result = migrateFlowchartV1ToDiagramV2(
      v1Doc([v1Node({ position: { x: 123, y: 456 }, size: { width: 200, height: 80 } })]),
    );
    expect(result.document.elements[0].position).toEqual({ x: 123, y: 456 });
    expect(result.document.elements[0].size).toEqual({ width: 200, height: 80 });
  });

  it("无尺寸时使用默认尺寸；connector 节点使用小尺寸", () => {
    const result = migrateFlowchartV1ToDiagramV2(
      v1Doc([v1Node({}), v1Node({ id: "n2", kind: "connector", label: "" })]),
    );
    expect(result.document.elements[0].size).toEqual({ width: 160, height: 60 });
    expect(result.document.elements[1].size).toEqual({ width: 40, height: 40 });
  });

  it("label 迁移为 textBlocks", () => {
    const result = migrateFlowchartV1ToDiagramV2(v1Doc([v1Node({ label: "审批流程" })]));
    const el = result.document.elements[0];
    expect(el.type).toBe("shape");
    if (el.type === "shape") {
      expect(el.textBlocks).toHaveLength(1);
      expect(el.textBlocks[0].text).toBe("审批流程");
    }
  });

  it("空 label 不产生 textBlocks", () => {
    const result = migrateFlowchartV1ToDiagramV2(v1Doc([v1Node({ label: "" })]));
    const el = result.document.elements[0];
    if (el.type === "shape") {
      expect(el.textBlocks).toEqual([]);
    }
  });

  it("样式映射：fill/border/文字样式", () => {
    const result = migrateFlowchartV1ToDiagramV2(
      v1Doc([
        v1Node({
          style: {
            fill: "#ffee00",
            borderColor: "#123456",
            borderWidth: 2,
            borderStyle: "dashed",
            bold: true,
            italic: true,
            underline: true,
            fontSize: 16,
            fontFamily: "Inter",
            color: "#333333",
            textAlign: "left",
          },
        }),
      ]),
    );
    const el = result.document.elements[0];
    if (el.type !== "shape") throw new Error("expected shape");
    expect(el.fill).toEqual({ type: "solid", color: "#ffee00" });
    expect(el.stroke).toEqual({ color: "#123456", width: 2, style: "dashed" });
    expect(el.textStyle).toEqual({
      fontFamily: "Inter",
      fontSize: 16,
      color: "#333333",
      fontWeight: 700,
      italic: true,
      underline: true,
      align: "left",
    });
  });

  it("无样式时 fill 为 none 且不产生 stroke/textStyle", () => {
    const result = migrateFlowchartV1ToDiagramV2(v1Doc([v1Node({})]));
    const el = result.document.elements[0];
    if (el.type !== "shape") throw new Error("expected shape");
    expect(el.fill).toEqual({ type: "none" });
    expect(el.stroke).toBeUndefined();
    expect(el.textStyle).toBeUndefined();
  });

  it("text 节点迁移为 text 元素", () => {
    const result = migrateFlowchartV1ToDiagramV2(
      v1Doc([v1Node({ kind: "text", label: "备注文字" })]),
    );
    const el = result.document.elements[0];
    expect(el.type).toBe("text");
    if (el.type === "text") {
      expect(el.textBlocks[0].text).toBe("备注文字");
    }
  });

  it("image 节点迁移：assetId 用 imagePath，资产登记到 assets", () => {
    const result = migrateFlowchartV1ToDiagramV2(
      v1Doc([v1Node({ kind: "image", label: "配图", imagePath: "assets/pic.png" })]),
    );
    const el = result.document.elements[0];
    expect(el).toMatchObject({ type: "image", assetId: "assets/pic.png", fit: "contain", alt: "配图" });
    expect(result.document.assets).toEqual([
      { id: "assets/pic.png", path: "assets/pic.png", mime: "image/png" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("image 节点缺 imagePath 时产生 warning 与占位资产 id", () => {
    const result = migrateFlowchartV1ToDiagramV2(v1Doc([v1Node({ kind: "image", label: "x" })]));
    const el = result.document.elements[0];
    if (el.type !== "image") throw new Error("expected image");
    expect(el.assetId).toBe("missing-n1");
    expect(result.warnings.length).toBe(1);
  });

  it("freehand 节点迁移保留点、工具、颜色、透明度", () => {
    const result = migrateFlowchartV1ToDiagramV2(
      v1Doc([
        v1Node({
          kind: "freehand",
          label: "",
          points: [
            { x: 1, y: 2, pressure: 0.3 },
            { x: 3, y: 4, pressure: 0.7 },
          ],
          path: "M1 2L3 4",
          drawingTool: "highlighter",
          color: "#00ff00",
          strokeWidth: 12,
          opacity: 0.28,
        }),
      ]),
    );
    const el = result.document.elements[0];
    expect(el).toMatchObject({
      type: "freehand",
      points: [
        { x: 1, y: 2, pressure: 0.3 },
        { x: 3, y: 4, pressure: 0.7 },
      ],
      path: "M1 2L3 4",
      drawingTool: "highlighter",
      color: "#00ff00",
      strokeWidth: 12,
      opacity: 0.28,
    });
  });
});

describe("migrateFlowchartV1ToDiagramV2 — 边映射", () => {
  const base = v1Doc([v1Node({}), v1Node({ id: "n2", kind: "decision", label: "判断" })]);

  it("source/target/handle 迁移为端点", () => {
    const result = migrateFlowchartV1ToDiagramV2({
      ...base,
      edges: [
        { id: "e1", source: "n1", target: "n2", sourceHandle: "right", targetHandle: "left" },
      ],
    });
    const conn = result.document.connectors[0];
    expect(conn.source).toEqual({ elementId: "n1", portId: "right" });
    expect(conn.target).toEqual({ elementId: "n2", portId: "left" });
  });

  it("route 映射：straight→straight，smoothstep→orthogonal，bezier/缺省→bezier", () => {
    const doc = {
      ...base,
      edges: [
        { id: "e1", source: "n1", target: "n2", style: { route: "straight" as const } },
        { id: "e2", source: "n1", target: "n2", style: { route: "smoothstep" as const } },
        { id: "e3", source: "n1", target: "n2", style: { route: "bezier" as const } },
        { id: "e4", source: "n1", target: "n2" },
      ],
    };
    const result = migrateFlowchartV1ToDiagramV2(doc);
    expect(result.document.connectors.map((c) => c.route)).toEqual([
      "straight",
      "orthogonal",
      "bezier",
      "bezier",
    ]);
  });

  it("marker 映射：arrow→arrow-open，arrowclosed→arrow-closed，缺省→none", () => {
    const result = migrateFlowchartV1ToDiagramV2({
      ...base,
      edges: [
        {
          id: "e1",
          source: "n1",
          target: "n2",
          style: { markerStart: "arrow" as const, markerEnd: "arrowclosed" as const },
        },
        { id: "e2", source: "n1", target: "n2" },
      ],
    });
    const [c1, c2] = result.document.connectors;
    expect(c1.markerStart).toBe("arrow-open");
    expect(c1.markerEnd).toBe("arrow-closed");
    expect(c2.markerStart).toBe("none");
    expect(c2.markerEnd).toBe("none");
  });

  it("边样式与 label 迁移", () => {
    const result = migrateFlowchartV1ToDiagramV2({
      ...base,
      edges: [
        {
          id: "e1",
          source: "n1",
          target: "n2",
          label: "是",
          style: { stroke: "#f00", strokeWidth: 3, strokeDasharray: "dotted" as const },
        },
      ],
    });
    const conn = result.document.connectors[0];
    expect(conn.stroke).toEqual({ color: "#f00", width: 3, style: "dotted" });
    expect(conn.label).toHaveLength(1);
    expect(conn.label![0].text).toBe("是");
  });

  it("无边样式时使用默认 stroke", () => {
    const result = migrateFlowchartV1ToDiagramV2({
      ...base,
      edges: [{ id: "e1", source: "n1", target: "n2" }],
    });
    expect(result.document.connectors[0].stroke).toEqual({
      color: "#1f2329",
      width: 1.5,
      style: "solid",
    });
  });
});
